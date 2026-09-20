import { eq, and, inArray, asc } from 'drizzle-orm'
import { createError } from 'h3'
import { db, initDb } from '../db'
import { projects, segments, jobs, settings, channels } from '../db/schema'
import type { Settings } from '../../shared/types'

export async function getProject(id: string) {
  await initDb()
  const [project] = await db.select().from(projects).where(eq(projects.id, id))
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  return project
}
export async function getSegments(projectId: string) {
  return db.select().from(segments).where(eq(segments.projectId, projectId)).orderBy(asc(segments.start))
}
export async function assertIdle(projectId: string) {
  const active = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), inArray(jobs.status, ['running', 'queued'])))
  if (active.length)
    throw createError({
      statusCode: 409,
      statusMessage: '项目仍有排队或执行中的任务，请先等待完成或跳过排队任务'
    })
}
export async function getSettings(): Promise<Settings> {
  await initDb()
  const rows = await db.select().from(settings)
  const values = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  return {
    concurrency: 2,
    pauseOnFailure: true,
    whisperModel: 'small',
    translationChannelId: 'translation-default',
    ...values
  }
}
export async function getChannel(id: string) {
  const [channel] = await db.select().from(channels).where(eq(channels.id, id))
  if (!channel?.enabled) throw new Error('所选渠道不存在或已停用，请先配置渠道')
  if (!process.env[channel.keyEnv])
    throw new Error(`缺少 ${channel.keyEnv}，请在本机 .env 中填写 Key 并重启应用`)
  return channel
}
export async function invalidateOutput(projectId: string) {
  await db
    .update(projects)
    .set({ mixedPath: null, outputPath: null, updatedAt: Date.now() })
    .where(eq(projects.id, projectId))
}
