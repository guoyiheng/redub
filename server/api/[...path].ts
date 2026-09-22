import { normalizeLanguage } from '../../shared/languages'
import { speakerName, voiceSettingsSchema, generationSchema } from '../../shared/voice'
import { uploadReference } from '../services/reference-upload'
import { batchSchema } from '../../shared/batch'
import { assertTimeline } from '../../shared/timeline'
import { originalClip } from '../services/original-clip'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { eq, and, desc, inArray, notInArray } from 'drizzle-orm'
import { db, initDb } from '../db'
import { projects, segments, jobs, channels, settings } from '../db/schema'
import {
  getProject,
  getSegments,
  getSettings,
  getChannel,
  assertIdle,
  invalidateOutput
} from '../services/store'
import { importProject } from '../services/importer'
import { enqueue, enqueueOutput, generateSegment, serializeEnqueue, tick } from '../services/queue'
import { mediaHealth, assetPath, cutAudio } from '../services/media'
import { safeError, translateLines } from '../services/providers'
import { stageLabels } from '../../shared/types'
import { getJobDetail, getJobRequest, jobColumns } from '../services/job-requests'
import { getPreviewTracks } from '../services/preview-tracks'

const channelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['volcengine', 'openai']),
  endpoint: z
    .url()
    .refine((v) => ['http:', 'https:'].includes(new URL(v).protocol), '渠道地址需为 HTTP 或 HTTPS'),
  model: z.string().trim().min(1).max(100),
  keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*_API_KEY$/, '密钥环境变量名需以 _API_KEY 结尾'),
  enabled: z.boolean(),
  pitch: z.number().int().min(-12).max(12).optional().default(0),
  speed: z.number().int().min(-50).max(100).optional().default(0),
  loudness: z.number().int().min(-50).max(100).optional().default(0),
  apiKey: z.string().max(10000).optional()
})
const segmentSchema = z
  .object({
    start: z.number().finite().min(0),
    end: z.number().finite().positive(),
    text: z.string().max(2800),
    translation: z.string().max(2800),
    speaker: z.string().max(80),
    enabled: z.boolean(),
    ...voiceSettingsSchema.shape
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
      if (id === 'fetch-models' && method === 'POST') {
        const body = z
          .object({
            id: z.string().optional(),
            type: z.enum(['volcengine', 'openai']),
            endpoint: z.string().trim().min(1, '请输入接口地址'),
            apiKey: z.string().optional(),
            keyEnv: z.string().optional()
          })
          .parse(await readBody(event))

        let key = body.apiKey?.trim() || ''
        if (!key && body.id) {
          const [found] = await db.select().from(channels).where(eq(channels.id, body.id))
          if (found?.apiKey) key = found.apiKey
        }
        if (!key && body.keyEnv && process.env[body.keyEnv]) {
          key = process.env[body.keyEnv]!
        }

        if (body.type === 'openai') {
          let base = body.endpoint.trim().replace(/\/$/, '')
          if (base.endsWith('/chat/completions')) {
            base = base.replace(/\/chat\/completions$/, '')
          }
          const modelsUrl = `${base}/models`
          try {
            const res = await fetch(modelsUrl, {
              headers: {
                ...(key ? { Authorization: `Bearer ${key}` } : {})
              },
              signal: AbortSignal.timeout(15000)
            })
            if (!res.ok) {
              const errText = await res.text().catch(() => '')
              throw new Error(`服务返回状态码 ${res.status}: ${errText.slice(0, 150)}`)
            }
            const data = (await res.json()) as any
            let list: string[] = []
            if (Array.isArray(data?.data)) {
              list = data.data.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
            } else if (Array.isArray(data?.models)) {
              list = data.models
                .map((m: any) => (typeof m === 'string' ? m : m?.id || m?.name))
                .filter(Boolean)
            }
            if (!list.length) {
              list = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'deepseek-chat', 'qwen-plus']
            }
            list = Array.from(new Set(list)).sort((a, b) => a.localeCompare(b))
            return { models: list }
          } catch (e: any) {
            throw createError({
              statusCode: 400,
              statusMessage: `拉取模型失败: ${e.message || '网络请求超时或地址错误'}`
            })
          }
        }

        if (body.type === 'volcengine') {
          return {
            models: ['seed-audio-1.0', 'seed-audio-2.0', 'seed-tts-1.0', 'seed-tts-2.0']
          }
        }

        return { models: [] }
      }
      if (method === 'GET')
        return (await db.select().from(channels)).map(({ apiKey: _apiKey, ...c }) => ({
          ...c,
          configured: !!_apiKey || !!process.env[c.keyEnv]
        }))
      if (method === 'POST' || (method === 'PATCH' && id)) {
        return await serializeEnqueue(async () => {
          const input = channelSchema.parse(await readBody(event))
          const { apiKey, ...data } = input
          const active = await db
            .select()
            .from(jobs)
            .where(inArray(jobs.status, ['running', 'queued']))
          if (active.length)
            throw createError({ statusCode: 409, statusMessage: '请等待任务完成后再修改渠道' })
          const channelId = id || randomUUID()
          const existing = id ? (await db.select().from(channels).where(eq(channels.id, id)))[0] : undefined
          const values = {
            ...data,
            ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : existing ? {} : { apiKey: null })
          }
          await db
            .insert(channels)
            .values({ id: channelId, ...values })
            .onConflictDoUpdate({ target: channels.id, set: values })
          const affected = await db.select().from(projects).where(eq(projects.channelId, channelId))
          for (const p of affected) {
            await db
              .update(segments)
              .set({ generatedPath: null, generatedHash: null })
              .where(eq(segments.projectId, p.id))
            await invalidateOutput(p.id)
          }
          return { id: channelId }
        })
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
            jobs: await db
              .select(jobColumns)
              .from(jobs)
              .where(eq(jobs.projectId, id))
              .orderBy(desc(jobs.createdAt))
          }
        if (!action && method === 'PATCH') {
          return await serializeEnqueue(async () => {
            await assertIdle(id)
            const currentProject = await getProject(id)
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
            if (
              normalizeLanguage(currentProject.targetLanguage) !== normalizeLanguage(data.targetLanguage) ||
              currentProject.channelId !== data.channelId
            ) {
              await db
                .update(segments)
                .set({
                  generatedPath: null,
                  generatedHash: null,
                  ...(normalizeLanguage(currentProject.targetLanguage) !==
                  normalizeLanguage(data.targetLanguage)
                    ? { translation: '', generationPrompt: null }
                    : {})
                })
                .where(eq(segments.projectId, id))
              await invalidateOutput(id)
            }
            return { ok: true }
          })
        }
        if (action === 'batch' && method === 'POST') {
          const input = batchSchema.parse(await readBody(event))
          setResponseStatus(event, 202)
          return await enqueue(id, undefined, undefined, input)
        }
        if (action === 'export' && method === 'POST') {
          const result = await enqueueOutput(id, 'export', await readBody(event))
          setResponseStatus(event, 202)
          return result
        }
        if (action === 'preview-tracks' && method === 'GET') {
          setHeader(event, 'Cache-Control', 'no-store')
          return await getPreviewTracks(id)
        }
        if (action === 'preview-tracks' && method === 'POST') {
          const result = await enqueueOutput(id, 'preview-tracks')
          setResponseStatus(event, 202)
          return result
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
          if (body.stage === 'export' || body.stage === 'preview-tracks')
            throw new Error('请使用对应的预览或导出入口')
          setResponseStatus(event, 202)
          if (body.segmentId) {
            const [s] = await db
              .select()
              .from(segments)
              .where(and(eq(segments.id, body.segmentId), eq(segments.projectId, id)))
            if (!s || body.stage !== 'synthesize') throw new Error('请选择本项目的配音片段')
            return (await generateSegment(s.id, voiceSettingsSchema.parse(s))).jobs
          }
          return await enqueue(id, body.stage ? [body.stage] : undefined, body.segmentId)
        }
        if (action === 'pause' && method === 'POST') {
          const { paused } = z.object({ paused: z.boolean() }).parse(await readBody(event))
          await db.update(projects).set({ paused }).where(eq(projects.id, id))
          void tick()
          return { ok: true }
        }
        if (action === 'speaker-voice' && method === 'POST') {
          return await serializeEnqueue(async () => {
            await assertIdle(id)
            const body = z
              .object({
                speaker: z.string().trim().min(1).max(80),
                voice: voiceSettingsSchema
              })
              .parse(await readBody(event))
            const targets = (await getSegments(id)).filter(
              (line) => speakerName(line.speaker) === body.speaker
            )
            if (!targets.length) throw new Error('该角色没有可配置的台词')
            const voice = {
              ...body.voice,
              aiSpeaker: body.voice.aiSpeaker ?? null,
              aiPrompt: body.voice.aiPrompt ?? null
            }
            const changed = targets.filter((line) =>
              Object.entries(voice).some(
                ([key, value]) => (line[key as keyof typeof voice] ?? '') !== (value ?? '')
              )
            )
            if (changed.length)
              await db.transaction(async (tx) => {
                await tx
                  .update(segments)
                  .set({
                    ...voice,
                    generatedPath: null,
                    generatedHash: null,
                    generatedDuration: null,
                    subtitle: null
                  })
                  .where(
                    inArray(
                      segments.id,
                      changed.map((line) => line.id)
                    )
                  )
                await tx
                  .update(projects)
                  .set({ mixedPath: null, outputPath: null, updatedAt: Date.now() })
                  .where(eq(projects.id, id))
              })
            return { ok: true, updated: changed.length }
          })
        }
        if (action === 'segments' && method === 'POST') {
          return await serializeEnqueue(async () => {
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
          })
        }
      }
    }
    if (resource === 'segments' && id && action === 'original' && method === 'GET') {
      const path = await originalClip(id)
      return sendRedirect(event, `/api/media?path=${encodeURIComponent(path)}`)
    }
    if (resource === 'segments' && id && action === 'generate' && method === 'POST') {
      setResponseStatus(event, 202)
      return await generateSegment(id, generationSchema.parse(await readBody(event)))
    }
    if (resource === 'segments' && id && action === 'reference' && method === 'POST') {
      const [line] = await db.select().from(segments).where(eq(segments.id, id))
      if (!line) throw createError({ statusCode: 404, statusMessage: '片段不存在' })
      return await uploadReference(event, line.projectId)
    }
    if (resource === 'segments' && id && action === 'translate' && method === 'POST') {
      return await serializeEnqueue(async () => {
        const [old] = await db.select().from(segments).where(eq(segments.id, id))
        if (!old) throw createError({ statusCode: 404, statusMessage: '片段不存在' })
        await assertIdle(old.projectId)
        if (!old.text?.trim()) throw createError({ statusCode: 400, statusMessage: '台词原文为空，无法翻译' })
        const p = await getProject(old.projectId)
        const s = await getSettings()
        if (!s.translationChannelId) {
          throw createError({ statusCode: 400, statusMessage: '未配置默认翻译渠道，请前往设置配置' })
        }
        const channel = await getChannel(s.translationChannelId)
        const resultMap = await translateLines([old], p.targetLanguage, channel)
        const translation = resultMap.get(old.id) || ''
        await db
          .update(segments)
          .set({
            translation,
            generationPrompt: null,
            generatedPath: null,
            generatedHash: null,
            subtitle: null,
            generatedDuration: null
          })
          .where(eq(segments.id, id))
        await invalidateOutput(p.id)
        return { ok: true, translation }
      })
    }
    if (resource === 'segments' && id && method === 'PATCH') {
      return await serializeEnqueue(async () => {
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
            ...(old.text !== data.text || old.translation !== data.translation
              ? { generationPrompt: null }
              : {}),
            ...(changed
              ? { generatedPath: null, generatedHash: null, subtitle: null, generatedDuration: null }
              : {})
          })
          .where(eq(segments.id, id))
        await invalidateOutput(p.id)
        return { ok: true }
      })
    }
    if (resource === 'jobs') {
      if (id && method === 'GET') {
        setHeader(event, 'Cache-Control', 'no-store')
        if (!action) return await getJobDetail(id)
        if (action === 'requests' && parts[3]) return await getJobRequest(id, parts[3])
        throw createError({ statusCode: 404, statusMessage: '接口不存在' })
      }
      if (method === 'GET') {
        const query = getQuery(event)
        const active = ['queued', 'running', 'failed'] as const
        if (query.history === '1') {
          const offset = z.coerce
            .number()
            .int()
            .min(0)
            .parse(query.offset || 0)
          return await db
            .select(jobColumns)
            .from(jobs)
            .where(notInArray(jobs.status, [...active]))
            .orderBy(desc(jobs.createdAt), desc(jobs.id))
            .limit(100)
            .offset(offset)
        }
        // A large batch must never hide an older active job from refresh recovery.
        const pending = await db
          .select(jobColumns)
          .from(jobs)
          .where(inArray(jobs.status, [...active]))
        const recent = await db
          .select(jobColumns)
          .from(jobs)
          .where(notInArray(jobs.status, [...active]))
          .orderBy(desc(jobs.createdAt), desc(jobs.id))
          .limit(100)
        return [...pending, ...recent]
      }
      if (id && method === 'POST') {
        return await serializeEnqueue(async () => {
          const [job] = await db.select().from(jobs).where(eq(jobs.id, id))
          if (!job) throw createError({ statusCode: 404, statusMessage: '任务不存在' })
          if (job.status === 'running')
            throw createError({ statusCode: 409, statusMessage: '执行中的任务不能重复启动或跳过' })
          if (!['retry', 'skip'].includes(action || '')) throw createError({ statusCode: 404 })
          await db.transaction(async (tx) => {
            if (action === 'retry') {
              const projectJobs = await tx.select().from(jobs).where(eq(jobs.projectId, job.projectId))
              const descendants = new Set([job.id])
              let size = 0
              while (size !== descendants.size) {
                size = descendants.size
                for (const item of projectJobs)
                  if (item.dependsOn && descendants.has(item.dependsOn)) descendants.add(item.id)
              }
              const conflicts = projectJobs.filter(
                (item) =>
                  ['queued', 'running'].includes(item.status) &&
                  !descendants.has(item.id) &&
                  !(
                    job.stage === 'synthesize' &&
                    job.segmentId &&
                    item.stage === 'synthesize' &&
                    item.segmentId &&
                    item.segmentId !== job.segmentId
                  )
              )
              if (conflicts.length)
                throw createError({ statusCode: 409, statusMessage: '项目有冲突的处理任务，请完成后再重试' })
            }
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
        })
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
  const all = await getSegments(projectId)
  assertTimeline([...all.filter((line) => line.id !== except), data], text ? undefined : duration)
}
