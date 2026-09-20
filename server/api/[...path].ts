import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { db, initDb } from '../db'
import { projects, segments, jobs, channels, settings } from '../db/schema'
import { getProject, getSegments, getSettings, assertIdle, invalidateOutput } from '../services/store'
import { importProject } from '../services/importer'
import { enqueue, tick } from '../services/queue'
import { mediaHealth, assetPath, cutAudio } from '../services/media'
import { safeError } from '../services/providers'
import { stageLabels } from '../../shared/types'

const channelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['volcengine', 'openai']),
  endpoint: z
    .url()
    .refine((v) => ['http:', 'https:'].includes(new URL(v).protocol), '渠道地址需为 HTTP 或 HTTPS'),
  model: z.string().trim().min(1).max(100),
  keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*_API_KEY$/, '密钥环境变量名需以 _API_KEY 结尾'),
  enabled: z.boolean(),
  pitch: z.number().int().min(-12).max(12),
  speed: z.number().int().min(-50).max(100),
  loudness: z.number().int().min(-50).max(100)
})
const segmentSchema = z
  .object({
    start: z.number().finite().min(0),
    end: z.number().finite().positive(),
    text: z.string().max(2800),
    translation: z.string().max(2800),
    speaker: z.string().max(80),
    enabled: z.boolean()
  })
  .refine((s) => s.end > s.start && s.end - s.start <= 120, '片段时长需大于 0 且不超过 120 秒')
export default defineEventHandler(async (event) => {
  await initDb()
  const parts = (getRouterParam(event, 'path') || '').split('/'),
    method = event.method
  const [resource, id, action] = parts
  try {
    if (resource === 'health' && method === 'GET') return await mediaHealth()
    if (resource === 'settings') {
      if (method === 'GET') return await getSettings()
      if (method === 'PATCH') {
        const data = z
          .object({
            concurrency: z.number().int().min(1).max(8),
            pauseOnFailure: z.boolean(),
            whisperModel: z.enum(['tiny', 'base', 'small', 'medium', 'large-v3']),
            translationChannelId: z.string().default('translation-default')
          })
          .parse(await readBody(event))
        const [translationChannel] = await db
          .select()
          .from(channels)
          .where(
            and(
              eq(channels.id, data.translationChannelId),
              eq(channels.type, 'openai'),
              eq(channels.enabled, true)
            )
          )
        if (!translationChannel) throw new Error('请选择已启用的翻译渠道')
        for (const [key, value] of Object.entries(data))
          await db
            .insert(settings)
            .values({ key, value: JSON.stringify(value) })
            .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value) } })
        void tick()
        return data
      }
    }
    if (resource === 'channels') {
      if (method === 'GET')
        return (await db.select().from(channels)).map((c) => ({ ...c, configured: !!process.env[c.keyEnv] }))
      if (method === 'POST' || (method === 'PATCH' && id)) {
        const data = channelSchema.parse(await readBody(event))
        const active = await db
          .select()
          .from(jobs)
          .where(inArray(jobs.status, ['running', 'queued']))
        if (active.length) throw createError({ statusCode: 409, statusMessage: '请等待任务完成后再修改渠道' })
        const channelId = id || randomUUID()
        await db
          .insert(channels)
          .values({ id: channelId, ...data })
          .onConflictDoUpdate({ target: channels.id, set: data })
        const affected = await db.select().from(projects).where(eq(projects.channelId, channelId))
        for (const p of affected) {
          await db
            .update(segments)
            .set({ generatedPath: null, generatedHash: null })
            .where(eq(segments.projectId, p.id))
          await invalidateOutput(p.id)
        }
        return { id: channelId }
      }
    }
    if (resource === 'projects') {
      if (!id && method === 'GET') return await db.select().from(projects).orderBy(desc(projects.updatedAt))
      if (!id && method === 'POST') return await importProject(event)
      if (id) {
        const project = await getProject(id)
        if (!action && method === 'GET')
          return {
            project,
            segments: await getSegments(id),
            jobs: await db.select().from(jobs).where(eq(jobs.projectId, id)).orderBy(desc(jobs.createdAt))
          }
        if (!action && method === 'PATCH') {
          await assertIdle(id)
          const data = z
            .object({
              name: z.string().trim().min(1).max(120),
              sourceLanguage: z.enum(['auto', 'zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru']),
              targetLanguage: z.string().trim().min(1).max(40),
              channelId: z.string()
            })
            .parse(await readBody(event))
          const [channel] = await db
            .select()
            .from(channels)
            .where(and(eq(channels.id, data.channelId), eq(channels.type, 'volcengine')))
          if (!channel) throw new Error('请选择有效的配音渠道')
          await db
            .update(projects)
            .set({ ...data, updatedAt: Date.now() })
            .where(eq(projects.id, id))
          if (project.targetLanguage !== data.targetLanguage || project.channelId !== data.channelId) {
            await db
              .update(segments)
              .set({
                generatedPath: null,
                generatedHash: null,
                ...(project.targetLanguage !== data.targetLanguage ? { translation: '' } : {})
              })
              .where(eq(segments.projectId, id))
            await invalidateOutput(id)
          }
          return { ok: true }
        }
        if (action === 'run' && method === 'POST') {
          const body = z
            .object({
              stage: z
                .enum(
                  Object.keys(stageLabels) as [keyof typeof stageLabels, ...Array<keyof typeof stageLabels>]
                )
                .optional(),
              segmentId: z.string().optional()
            })
            .parse(await readBody(event))
          if (body.segmentId) {
            const [s] = await db
              .select()
              .from(segments)
              .where(and(eq(segments.id, body.segmentId), eq(segments.projectId, id)))
            if (!s || body.stage !== 'synthesize') throw new Error('请选择本项目的配音片段')
          }
          return await enqueue(id, body.stage ? [body.stage] : undefined, body.segmentId)
        }
        if (action === 'pause' && method === 'POST') {
          const { paused } = z.object({ paused: z.boolean() }).parse(await readBody(event))
          await db.update(projects).set({ paused }).where(eq(projects.id, id))
          void tick()
          return { ok: true }
        }
        if (action === 'segments' && method === 'POST') {
          await assertIdle(id)
          const data = segmentSchema.parse(await readBody(event))
          await validateTimeline(id, data, project.duration, project.kind === 'text')
          const segmentId = randomUUID()
          let referencePath: string | null = null
          if (project.vocalsPath) {
            referencePath = `${id}/reference-${segmentId}.wav`
            await cutAudio(
              assetPath(project.vocalsPath),
              assetPath(referencePath),
              data.start,
              data.end - data.start
            )
          }
          await db.insert(segments).values({ id: segmentId, projectId: id, ...data, referencePath })
          await invalidateOutput(id)
          return { id: segmentId }
        }
      }
    }
    if (resource === 'segments' && id && method === 'PATCH') {
      const [old] = await db.select().from(segments).where(eq(segments.id, id))
      if (!old) throw createError({ statusCode: 404, statusMessage: '片段不存在' })
      await assertIdle(old.projectId)
      const p = await getProject(old.projectId),
        data = segmentSchema.parse(await readBody(event))
      await validateTimeline(p.id, data, p.duration, p.kind === 'text', id)
      const changed =
        old.start !== data.start ||
        old.end !== data.end ||
        old.text !== data.text ||
        old.translation !== data.translation
      let referencePath = old.referencePath
      if (p.vocalsPath && (old.start !== data.start || old.end !== data.end)) {
        referencePath = `${p.id}/reference-${id}-${randomUUID()}.wav`
        await cutAudio(assetPath(p.vocalsPath), assetPath(referencePath), data.start, data.end - data.start)
      }
      await db
        .update(segments)
        .set({
          ...data,
          referencePath,
          ...(changed
            ? { generatedPath: null, generatedHash: null, subtitle: null, generatedDuration: null }
            : {})
        })
        .where(eq(segments.id, id))
      await invalidateOutput(p.id)
      return { ok: true }
    }
    if (resource === 'jobs') {
      if (method === 'GET') return await db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(500)
      if (id && method === 'POST') {
        const [job] = await db.select().from(jobs).where(eq(jobs.id, id))
        if (!job) throw createError({ statusCode: 404, statusMessage: '任务不存在' })
        if (job.status === 'running')
          throw createError({ statusCode: 409, statusMessage: '执行中的任务不能重复启动或跳过' })
        if (!['retry', 'skip'].includes(action || '')) throw createError({ statusCode: 404 })
        await db.transaction(async (tx) => {
          const allowed = action === 'retry' ? (['failed'] as const) : (['queued', 'failed'] as const)
          const changed = await tx
            .update(jobs)
            .set({
              status: action === 'retry' ? 'queued' : 'skipped',
              error: null,
              progress: 0,
              message: action === 'retry' ? '等待重试' : '已跳过，后续任务可继续',
              updatedAt: Date.now()
            })
            .where(and(eq(jobs.id, id), inArray(jobs.status, [...allowed])))
            .returning({ id: jobs.id })
          if (!changed.length)
            throw createError({ statusCode: 409, statusMessage: '任务状态已改变，请刷新后重试' })
          if (action === 'skip' && job.stage === 'synthesize') {
            const lines = await tx.select().from(segments).where(eq(segments.projectId, job.projectId))
            for (const line of lines.filter(
              (s) => (!job.segmentId || s.id === job.segmentId) && !s.generatedPath
            ))
              await tx.update(segments).set({ enabled: false }).where(eq(segments.id, line.id))
            await tx
              .update(projects)
              .set({ mixedPath: null, outputPath: null })
              .where(eq(projects.id, job.projectId))
          }
          await tx.update(projects).set({ paused: false }).where(eq(projects.id, job.projectId))
        })
        void tick()
        return { ok: true }
      }
    }
    throw createError({ statusCode: 404, statusMessage: '接口不存在' })
  } catch (error) {
    if (error instanceof z.ZodError)
      throw createError({ statusCode: 400, statusMessage: error.issues.map((i) => i.message).join('；') })
    const statusCode = (error as { statusCode?: number }).statusCode || 400
    throw createError({ statusCode, statusMessage: safeError(error) })
  }
})

async function validateTimeline(
  projectId: string,
  data: { start: number; end: number },
  duration: number,
  text: boolean,
  except?: string
) {
  if (!text && data.end > duration + 0.01) throw new Error('片段不能超出素材时长')
  const all = await getSegments(projectId)
  if (all.some((s) => s.id !== except && data.start < s.end && data.end > s.start))
    throw new Error('片段不能重叠，请调整起止时间')
}
