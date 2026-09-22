import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createError } from 'h3'
import { eq, and, asc, desc, inArray } from 'drizzle-orm'
import { db, initDb } from '../db'
import { jobs, projects, segments } from '../db/schema'
import { batchPlan, type BatchInput } from '../../shared/batch'
import { getSegments, getChannel, getSettings, getProject, assertIdle } from './store'
import { executeJob } from './pipeline'
import { safeError } from './providers'
import { assetPath } from './media'
import type { VoiceSettings } from '../../shared/voice'
import type { Job, MediaKind, Stage } from '../../shared/types'
import { jobContext, interruptJobRequests, jobColumns } from './job-requests'
import { exportSchema } from '../../shared/export'
import { previewRevision } from './preview-tracks'
import type { PreviewTracks } from '../../shared/preview'

export function workflowStages(kind: MediaKind): Stage[] {
  if (kind === 'text') return []
  return [...(kind === 'video' ? ['extract' as const] : []), 'separate', 'segment', 'transcribe']
}
export function eligibleJobs(all: Job[], paused: Set<string>, runningJobIds: Set<string>, capacity: number) {
  const byId = new Map(all.map((j) => [j.id, j]))
  const picked: Job[] = []
  const used = new Set(runningJobIds)
  for (const job of all) {
    if (picked.length >= capacity) break
    if (job.status !== 'queued' || paused.has(job.projectId) || used.has(job.id)) continue
    const parent = job.dependsOn && byId.get(job.dependsOn)
    if (job.dependsOn && (!parent || !['completed', 'skipped'].includes(parent.status))) continue
    picked.push(job)
    used.add(job.id)
  }
  return picked
}
const running = new Set<string>()
let ticking = false,
  timer: ReturnType<typeof setInterval> | undefined
let enqueueChain = Promise.resolve()
export function serializeEnqueue<T>(action: () => Promise<T>): Promise<T> {
  const task = enqueueChain.then(action)
  enqueueChain = task.then(
    () => {},
    () => {}
  )
  return task
}
export function enqueue(projectId: string, stages?: Stage[], segmentId?: string, batch?: BatchInput) {
  return serializeEnqueue(async () => {
    const p = await getProject(projectId)
    await assertIdle(projectId)
    if (!stages && !batch && p.kind === 'text') throw new Error('文本已导入，请手动选择翻译或生成配音')
    const lines = await getSegments(projectId)
    const plan = batch
      ? batchPlan(p, lines, batch)
      : stages
        ? stages.map((stage) => ({ stage, segmentId }))
        : batchPlan(p, lines, { action: 'prepare', scope: 'missing', finish: false })
    const targetIds = plan.flatMap((item) => (item.segmentId ? [item.segmentId] : []))
    if (batch?.action === 'synthesize') {
      const voices = batch.useSegmentVoices
        ? lines.filter((line) => targetIds.includes(line.id))
        : [batch.voice!]
      if (voices.some((voice) => voice.synthesisMode === 'ai')) {
        const channel = await getChannel(p.channelId)
        if (channel.type !== 'volcengine') throw new Error('请在项目设置中选择 AI 配音渠道')
      }
    }
    if (batch?.action === 'translate') await getChannel((await getSettings()).translationChannelId)
    const order = plan.map((item) => item.stage)
    const rows: Job[] = []
    for (const item of plan)
      rows.push({
        id: randomUUID(),
        projectId,
        stage: item.stage,
        segmentId: item.segmentId || null,
        status: 'queued',
        progress: 0,
        message: '等待执行',
        error: null,
        dependsOn: rows.at(-1)?.id || null,
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    await db.transaction(async (tx) => {
      if (batch?.action === 'synthesize') {
        await tx
          .update(segments)
          .set({
            ...(batch.useSegmentVoices ? {} : batch.voice),
            generatedPath: null,
            generatedHash: null,
            generatedDuration: null,
            subtitle: null
          })
          .where(and(eq(segments.projectId, projectId), inArray(segments.id, targetIds)))
        await tx
          .update(projects)
          .set({ mixedPath: null, outputPath: null, updatedAt: Date.now() })
          .where(eq(projects.id, projectId))
      }
      for (const row of rows) await tx.insert(jobs).values(row)
      if (segmentId && order.includes('synthesize'))
        await tx
          .update(segments)
          .set({ generatedHash: null })
          .where(and(eq(segments.id, segmentId), eq(segments.projectId, projectId)))
      await tx.update(projects).set({ paused: false }).where(eq(projects.id, projectId))
    })
    void tick()
    return rows
  })
}

export function generateSegment(segmentId: string, voice: VoiceSettings) {
  return serializeEnqueue(async () => {
    await initDb()
    const [line] = await db.select().from(segments).where(eq(segments.id, segmentId))
    if (!line) throw createError({ statusCode: 404, statusMessage: '片段不存在' })
    const project = await getProject(line.projectId)
    if (!(line.translation || line.text).trim()) throw new Error('请先填写这句台词或译文，再生成配音')
    if (voice.synthesisMode === 'ai') {
      const channel = await getChannel(project.channelId)
      if (channel.type !== 'volcengine') throw new Error('请在项目设置中选择 AI 配音渠道')
      if (
        voice.aiUseReference &&
        (project.kind === 'text' || !project.vocalsPath || !existsSync(assetPath(project.vocalsPath)))
      )
        throw new Error('没有可用原声，请先分离人声，或关闭原声参考并选择音色')
    }
    let job: Job | undefined
    await db.transaction(async (tx) => {
      const active = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.projectId, project.id), inArray(jobs.status, ['running', 'queued'])))
        .orderBy(desc(jobs.createdAt))
      if (active.some((item) => item.stage === 'synthesize' && item.segmentId === segmentId))
        throw createError({ statusCode: 409, statusMessage: '这句配音已在排队或生成中，请等待完成' })
      const blocker = active.find((item) => item.stage !== 'synthesize')
      job = {
        id: randomUUID(),
        projectId: project.id,
        stage: 'synthesize',
        segmentId,
        status: 'queued',
        progress: 0,
        message: blocker ? '等待前置任务完成' : '等待生成这句配音',
        error: null,
        dependsOn: blocker?.id || null,
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      await tx
        .update(segments)
        .set({
          ...voice,
          enabled: true,
          generatedPath: null,
          generatedHash: null,
          generatedDuration: null,
          subtitle: null
        })
        .where(eq(segments.id, segmentId))
      await tx
        .update(projects)
        .set({ paused: false, mixedPath: null, outputPath: null, updatedAt: Date.now() })
        .where(eq(projects.id, project.id))
      await tx.insert(jobs).values(job)
    })
    void tick()
    return { segmentId, jobs: [job!] }
  })
}
export function enqueueOutput(projectId: string, stage: 'export' | 'preview-tracks', input?: unknown) {
  return serializeEnqueue(async () => {
    await getProject(projectId)
    const payload =
      stage === 'export' ? exportSchema.parse(input) : { revision: await previewRevision(projectId) }
    const active = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ['queued', 'running'])))
      .orderBy(desc(jobs.createdAt))
    const existing = active.find(
      (job) => job.stage === stage && JSON.stringify(job.input) === JSON.stringify(payload)
    )
    if (existing) return { jobId: existing.id }
    await assertIdle(projectId)
    if (stage === 'preview-tracks') {
      const completed = await db
        .select({ id: jobs.id, input: jobs.input, result: jobs.result })
        .from(jobs)
        .where(and(eq(jobs.projectId, projectId), eq(jobs.stage, stage), eq(jobs.status, 'completed')))
        .orderBy(desc(jobs.createdAt))
        .limit(1)
      const cached = completed[0]
      if (cached && JSON.stringify(cached.input) === JSON.stringify(payload)) {
        const result = cached.result as PreviewTracks | null
        if (
          result?.tracks &&
          Object.values(result.tracks).every(
            (track) =>
              (!track.path || existsSync(assetPath(track.path))) &&
              (!track.alternatePath || existsSync(assetPath(track.alternatePath)))
          )
        )
          return { jobId: cached.id }
      }
    }
    const id = randomUUID()
    await db.transaction(async (tx) => {
      await tx
        .insert(jobs)
        .values({ id, projectId, stage, input: payload, createdAt: Date.now(), updatedAt: Date.now() })
      await tx.update(projects).set({ paused: false }).where(eq(projects.id, projectId))
    })
    void tick()
    return { jobId: id }
  })
}
async function execute(job: Job) {
  try {
    const claimed = await db
      .update(jobs)
      .set({
        status: 'running',
        error: null,
        result: null,
        progress: 0,
        message: '正在执行',
        attempts: job.attempts + 1,
        updatedAt: Date.now()
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
      .returning({ id: jobs.id })
    if (!claimed.length) return
    const result = await jobContext.run({ id: job.id, attempt: job.attempts + 1 }, () =>
      executeJob(job, async (progress, message) => {
        await db
          .update(jobs)
          .set({ progress: Math.min(99, Math.max(0, progress)), message, updatedAt: Date.now() })
          .where(eq(jobs.id, job.id))
      })
    )
    await db
      .update(jobs)
      .set({
        status: 'completed',
        progress: 100,
        message: '已完成',
        result: result ?? null,
        updatedAt: Date.now()
      })
      .where(eq(jobs.id, job.id))
  } catch (error) {
    await db
      .update(jobs)
      .set({
        status: 'failed',
        error: safeError(error),
        message: '执行失败，可重试或跳过',
        updatedAt: Date.now()
      })
      .where(eq(jobs.id, job.id))
    if ((await getSettings()).pauseOnFailure)
      await db.update(projects).set({ paused: true }).where(eq(projects.id, job.projectId))
  } finally {
    running.delete(job.id)
    void tick()
  }
}
export async function tick() {
  if (ticking) return
  ticking = true
  try {
    const settings = await getSettings()
    if (running.size >= settings.concurrency) return
    const all = await db.select(jobColumns).from(jobs).orderBy(asc(jobs.createdAt))
    const paused = new Set(
      (await db.select().from(projects).where(eq(projects.paused, true))).map((p) => p.id)
    )
    for (const job of eligibleJobs(all, paused, running, settings.concurrency - running.size)) {
      running.add(job.id)
      void execute(job)
    }
  } finally {
    ticking = false
  }
}
export async function startQueue() {
  await initDb()
  await interruptJobRequests()
  const interrupted = await db.select().from(jobs).where(eq(jobs.status, 'running'))
  if (interrupted.length) {
    await db
      .update(jobs)
      .set({
        status: 'failed',
        error: '应用在处理过程中退出，请确认后重试；已生成片段会复用',
        message: '任务已中断',
        updatedAt: Date.now()
      })
      .where(eq(jobs.status, 'running'))
    await db
      .update(projects)
      .set({ paused: true })
      .where(
        inArray(
          projects.id,
          interrupted.map((j) => j.projectId)
        )
      )
  }
  timer = setInterval(() => {
    void tick().catch(console.error)
  }, 1500)
  timer.unref()
  void tick()
}
export function stopQueue() {
  if (timer) clearInterval(timer)
}
