import { randomUUID } from 'node:crypto'
import { eq, and, asc, inArray } from 'drizzle-orm'
import { db, initDb } from '../db'
import { jobs, projects, segments } from '../db/schema'
import { batchPlan, type BatchInput } from '../../shared/batch'
import { getSegments, getChannel, getSettings, getProject, assertIdle } from './store'
import { executeJob } from './pipeline'
import { safeError } from './providers'
import type { Job, MediaKind, Stage } from '../../shared/types'

export function workflowStages(kind: MediaKind): Stage[] {
  if (kind === 'text') return ['translate', 'synthesize', 'mix', 'preview']
  return [
    ...(kind === 'video' ? ['extract' as const] : []),
    'separate',
    'segment',
    'transcribe',
    'translate',
    'synthesize',
    'mix',
    'preview'
  ]
}
export function eligibleJobs(all: Job[], paused: Set<string>, busy: Set<string>, capacity: number) {
  const byId = new Map(all.map((j) => [j.id, j]))
  const picked: Job[] = []
  const used = new Set(busy)
  for (const job of all) {
    if (picked.length >= capacity) break
    if (job.status !== 'queued' || paused.has(job.projectId) || used.has(job.projectId)) continue
    const parent = job.dependsOn && byId.get(job.dependsOn)
    if (job.dependsOn && (!parent || !['completed', 'skipped'].includes(parent.status))) continue
    picked.push(job)
    used.add(job.projectId)
  }
  return picked
}
const running = new Map<string, string>()
let ticking = false,
  timer: ReturnType<typeof setInterval> | undefined
let enqueueChain = Promise.resolve()
export function enqueue(projectId: string, stages?: Stage[], segmentId?: string, batch?: BatchInput) {
  const task = enqueueChain.then(async () => {
    const p = await getProject(projectId)
    await assertIdle(projectId)
    const plan = batch
      ? batchPlan(p, await getSegments(projectId), batch)
      : (stages || workflowStages(p.kind)).map((stage) => ({ stage, segmentId }))
    if (batch?.action === 'synthesize' && batch.voice?.synthesisMode === 'ai') await getChannel(p.channelId)
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
      if (batch?.action === 'synthesize' && batch.voice) {
        const ids = plan.flatMap((item) => (item.segmentId ? [item.segmentId] : []))
        await tx
          .update(segments)
          .set({
            ...batch.voice,
            generatedPath: null,
            generatedHash: null,
            generatedDuration: null,
            subtitle: null
          })
          .where(and(eq(segments.projectId, projectId), inArray(segments.id, ids)))
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
  enqueueChain = task.then(
    () => {},
    () => {}
  )
  return task
}
async function execute(job: Job) {
  try {
    const claimed = await db
      .update(jobs)
      .set({
        status: 'running',
        error: null,
        progress: 0,
        message: '正在执行',
        attempts: job.attempts + 1,
        updatedAt: Date.now()
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
      .returning({ id: jobs.id })
    if (!claimed.length) return
    await executeJob(job, async (progress, message) => {
      await db
        .update(jobs)
        .set({ progress: Math.min(99, Math.max(0, progress)), message, updatedAt: Date.now() })
        .where(eq(jobs.id, job.id))
    })
    await db
      .update(jobs)
      .set({ status: 'completed', progress: 100, message: '已完成', updatedAt: Date.now() })
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
    const all = await db.select().from(jobs).orderBy(asc(jobs.createdAt))
    const paused = new Set(
      (await db.select().from(projects).where(eq(projects.paused, true))).map((p) => p.id)
    )
    for (const job of eligibleJobs(
      all,
      paused,
      new Set(running.values()),
      settings.concurrency - running.size
    )) {
      running.set(job.id, job.projectId)
      void execute(job)
    }
  } finally {
    ticking = false
  }
}
export async function startQueue() {
  await initDb()
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
