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
import type { GenerationInput } from '../../shared/voice'
import type { Job, MediaKind, Stage, Settings } from '../../shared/types'
import { jobContext, interruptJobRequests, jobColumns } from './job-requests'
import { exportSchema } from '../../shared/export'
import { previewRevision } from './preview-tracks'
import type { PreviewTracks } from '../../shared/preview'
import { automaticFollowups, canChainStages } from '../../shared/job-policy'

export function workflowStages(kind: MediaKind): Stage[] {
  if (kind === 'text') return []
  return [...(kind === 'video' ? ['extract' as const] : []), 'separate', 'segment', 'transcribe']
}
type ConcurrencySettings = Pick<Settings, 'translationConcurrency' | 'synthesisConcurrency'>
function poolOf(stage: Stage) {
  return stage === 'translate' || stage === 'synthesize' ? stage : 'local'
}
export function eligibleJobs(
  all: Job[],
  paused: Set<string>,
  runningJobIds: Set<string>,
  settings: ConcurrencySettings
) {
  const byId = new Map(all.map((j) => [j.id, j]))
  const blocked = automaticFollowups(all)
  const picked: Job[] = []
  const used = new Set(runningJobIds)
  // 本机密集处理仍限制为两个，独立于翻译与配音的网络任务。
  const capacity = {
    translate: settings.translationConcurrency,
    synthesize: settings.synthesisConcurrency,
    local: 2
  }
  for (const job of all)
    if (runningJobIds.has(job.id) || job.status === 'running') capacity[poolOf(job.stage)]--
  for (const job of all) {
    if (job.status !== 'queued' || paused.has(job.projectId) || used.has(job.id) || blocked.has(job.id))
      continue
    const pool = poolOf(job.stage)
    if (capacity[pool] <= 0) continue
    const parent = job.dependsOn && byId.get(job.dependsOn)
    if (job.dependsOn && (!parent || !['completed', 'skipped'].includes(parent.status))) continue
    picked.push(job)
    capacity[pool]--
    used.add(job.id)
  }
  return picked
}
export async function cancelAutomaticFollowups(all?: Job[]) {
  await initDb()
  const snapshot = all ?? (await db.select(jobColumns).from(jobs))
  const blocked = automaticFollowups(snapshot)
  const ids = snapshot.filter((job) => job.status === 'queued' && blocked.has(job.id)).map((job) => job.id)
  if (ids.length)
    await db
      .update(jobs)
      .set({
        status: 'cancelled',
        message: '自动后续任务已取消，请核对结果后手动发起',
        updatedAt: Date.now()
      })
      .where(and(inArray(jobs.id, ids), eq(jobs.status, 'queued')))
  return ids
}
const running = new Set<string>()
let ticking = false,
  timer: ReturnType<typeof setInterval> | undefined
let enqueueChain = Promise.resolve()
export function serializeEnqueue<T>(action: () => Promise<T>): Promise<T> {
  const task = enqueueChain.then(async () => {
    await cancelAutomaticFollowups()
    return action()
  })
  enqueueChain = task.then(
    () => {},
    () => {}
  )
  return task
}
export function enqueue(projectId: string, stages?: Stage[], segmentId?: string, batch?: BatchInput) {
  return serializeEnqueue(async () => {
    const p = await getProject(projectId)
    if (segmentId && stages?.length === 1 && stages[0] === 'translate') {
      const active = await db
        .select(jobColumns)
        .from(jobs)
        .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ['queued', 'running'])))
      if (active.some((job) => job.stage !== 'translate' || !job.segmentId || job.segmentId === segmentId))
        throw createError({ statusCode: 409, statusMessage: '当前有冲突任务，请等待完成并核对后再翻译' })
    } else await assertIdle(projectId)
    if (!stages && !batch && p.kind === 'text') throw new Error('文本已导入，请手动选择翻译或生成配音')
    const lines = await getSegments(projectId)
    const plan = batch
      ? batchPlan(p, lines, batch)
      : stages
        ? stages.flatMap((stage) => {
            if (!segmentId && (stage === 'translate' || stage === 'synthesize'))
              return lines.filter((line) => line.enabled).map((line) => ({ stage, segmentId: line.id }))
            return [{ stage, segmentId }]
          })
        : batchPlan(p, lines, { action: 'prepare', scope: 'missing' })
    if (plan.some((item, index) => index > 0 && !canChainStages(plan[index - 1]!.stage, item.stage)))
      throw new Error('翻译、配音、合成和导出需分别手动发起，请先核对上一步结果')
    if (!plan.length) throw new Error('没有需要处理的台词')
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
    if (plan.some((item) => item.stage === 'translate')) {
      if (
        plan.some(
          (item) =>
            item.stage === 'translate' && !lines.find((line) => line.id === item.segmentId)?.text.trim()
        )
      )
        throw new Error('请先识别或填写需要翻译的原文')
      await getChannel((await getSettings()).translationChannelId)
    }
    const order = plan.map((item) => item.stage)
    const rows: Job[] = []
    const batchId = randomUUID()
    for (const item of plan)
      rows.push({
        id: randomUUID(),
        projectId,
        stage: item.stage,
        segmentId: item.segmentId || null,
        batchId,
        status: 'queued',
        progress: 0,
        message: '等待执行',
        error: null,
        dependsOn: item.stage === 'translate' || item.stage === 'synthesize' ? null : rows.at(-1)?.id || null,
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
            ...(batch.useSegmentVoices ? {} : { generationPrompt: null }),
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

export function generateSegment(segmentId: string, input: GenerationInput) {
  return serializeEnqueue(async () => {
    const { generationPrompt, translation, customReferencePath, ...voice } = input
    await initDb()
    const [line] = await db.select().from(segments).where(eq(segments.id, segmentId))
    if (!line) throw createError({ statusCode: 404, statusMessage: '片段不存在' })
    const project = await getProject(line.projectId)
    const prompt = generationPrompt ?? line.generationPrompt
    if (
      !(
        voice.synthesisMode === 'ai'
          ? prompt || translation || line.translation || line.text
          : translation || line.translation || line.text
      ).trim()
    )
      throw new Error('请先填写这句台词或译文，再生成配音')
    const reference = customReferencePath === undefined ? line.customReferencePath : customReferencePath
    if (
      reference &&
      (!reference.startsWith(`${project.id}/reference-upload-`) ||
        !/^[a-zA-Z0-9-]+\/reference-upload-[a-f0-9-]+\.wav$/.test(reference) ||
        !existsSync(assetPath(reference)))
    )
      throw new Error('参考音频不可用，请重新上传')
    if (voice.synthesisMode === 'ai') {
      const channel = await getChannel(project.channelId)
      if (channel.type !== 'volcengine') throw new Error('请在项目设置中选择 AI 配音渠道')
      if (
        voice.aiUseReference &&
        !reference &&
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
      if (active.some((item) => item.stage !== 'synthesize'))
        throw createError({ statusCode: 409, statusMessage: '请等待当前步骤完成，核对结果后再生成配音' })
      job = {
        id: randomUUID(),
        projectId: project.id,
        stage: 'synthesize',
        segmentId,
        status: 'queued',
        progress: 0,
        message: '等待生成这句配音',
        error: null,
        dependsOn: null,
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      await tx
        .update(segments)
        .set({
          ...voice,
          ...(generationPrompt !== undefined ? { generationPrompt } : {}),
          ...(translation !== undefined ? { translation } : {}),
          ...(customReferencePath !== undefined ? { customReferencePath } : {}),
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
    const all = await db.select(jobColumns).from(jobs).orderBy(asc(jobs.createdAt))
    await cancelAutomaticFollowups(all)
    const paused = new Set(
      (await db.select().from(projects).where(eq(projects.paused, true))).map((p) => p.id)
    )
    for (const job of eligibleJobs(all, paused, running, settings)) {
      running.add(job.id)
      void execute(job)
    }
  } finally {
    ticking = false
  }
}
export async function startQueue() {
  await initDb()
  await cancelAutomaticFollowups()
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
