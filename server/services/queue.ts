import { randomUUID } from 'node:crypto'
import { eq, asc, inArray } from 'drizzle-orm'
import { db, initDb } from '../db'
import { jobs, projects } from '../db/schema'
import { getSettings, getProject, assertIdle } from './store'
import { executeJob } from './pipeline'
import { safeError } from './providers'
import type { Job, MediaKind, Stage } from '../../shared/types'

export function workflowStages(kind: MediaKind): Stage[] {
  if (kind === 'text') return ['translate', 'synthesize', 'mix', 'preview']
  return [...(kind === 'video' ? ['extract' as const] : []), 'separate', 'segment', 'transcribe', 'translate', 'synthesize', 'mix', 'preview']
}
export function eligibleJobs(all: Job[], paused: Set<string>, busy: Set<string>, capacity: number) {
  const byId = new Map(all.map(j => [j.id, j]))
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
let ticking = false, timer: ReturnType<typeof setInterval> | undefined
let enqueueChain = Promise.resolve()
export function enqueue(projectId: string, stages?: Stage[], segmentId?: string) {
  const task = enqueueChain.then(async () => {
    const p = await getProject(projectId)
    await assertIdle(projectId)
    const order = stages || workflowStages(p.kind)
    const rows: Job[] = []
    for (const stage of order) rows.push({ id: randomUUID(), projectId, stage, segmentId: segmentId || null, status: 'queued', progress: 0, message: '等待执行', error: null, dependsOn: rows.at(-1)?.id || null, attempts: 0, createdAt: Date.now(), updatedAt: Date.now() })
    await db.transaction(async tx => {
      for (const row of rows) await tx.insert(jobs).values(row)
      await tx.update(projects).set({ paused: false }).where(eq(projects.id, projectId))
    })
    void tick()
    return rows
  })
  enqueueChain = task.then(() => {}, () => {})
  return task
}
async function execute(job: Job) {
  try {
    await db.update(jobs).set({ status: 'running', error: null, progress: 0, message: '正在执行', attempts: job.attempts + 1, updatedAt: Date.now() }).where(eq(jobs.id, job.id))
    await executeJob(job, async (progress, message) => {
      await db.update(jobs).set({ progress: Math.min(99, Math.max(0, progress)), message, updatedAt: Date.now() }).where(eq(jobs.id, job.id))
    })
    await db.update(jobs).set({ status: 'completed', progress: 100, message: '已完成', updatedAt: Date.now() }).where(eq(jobs.id, job.id))
  } catch (error) {
    await db.update(jobs).set({ status: 'failed', error: safeError(error), message: '执行失败，可重试或跳过', updatedAt: Date.now() }).where(eq(jobs.id, job.id))
    if ((await getSettings()).pauseOnFailure) await db.update(projects).set({ paused: true }).where(eq(projects.id, job.projectId))
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
    const paused = new Set((await db.select().from(projects).where(eq(projects.paused, true))).map(p => p.id))
    for (const job of eligibleJobs(all, paused, new Set(running.values()), settings.concurrency - running.size)) {
      running.set(job.id, job.projectId)
      void execute(job)
    }
  } finally { ticking = false }
}
export async function startQueue() {
  await initDb()
  const interrupted = await db.select().from(jobs).where(eq(jobs.status, 'running'))
  if (interrupted.length) {
    await db.update(jobs).set({ status: 'failed', error: '应用在处理过程中退出，请确认后重试；已生成片段会复用', message: '任务已中断', updatedAt: Date.now() }).where(eq(jobs.status, 'running'))
    await db.update(projects).set({ paused: true }).where(inArray(projects.id, interrupted.map(j => j.projectId)))
  }
  timer = setInterval(() => { void tick().catch(console.error) }, 1500)
  timer.unref()
  void tick()
}
export function stopQueue() { if (timer) clearInterval(timer) }
