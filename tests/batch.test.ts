import { beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, initDb } from '../server/db'
import { projects, segments, jobs, channels } from '../server/db/schema'
import { enqueue, generateSegment, cancelAutomaticFollowups } from '../server/services/queue'
import { getProject, getSegments } from '../server/services/store'
import { batchPlan, batchSchema } from '../shared/batch'
import { defaultVoiceSettings } from '../shared/voice'
import { originalClip } from '../server/services/original-clip'
import { assetPath, ffmpeg, probe, projectDir } from '../server/services/media'
vi.mock('../server/services/store', async (original) => {
  const actual = await original<typeof import('../server/services/store')>()
  return {
    ...actual,
    getSettings: async () => ({
      ...(await actual.getSettings()),
      translationConcurrency: 0,
      synthesisConcurrency: 0
    })
  }
})
beforeAll(initDb)
async function fixture() {
  const id = randomUUID()
  await db.insert(projects).values({
    id,
    name: '批量范围测试',
    kind: 'text',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    outputPath: 'old.mp3'
  })
  await db.insert(segments).values([
    {
      id: `${id}-ready`,
      projectId: id,
      start: 0,
      end: 1,
      text: '已有配音',
      generatedPath: 'ready.mp3',
      aiPrompt: '已有参数'
    },
    { id: `${id}-missing`, projectId: id, start: 1, end: 2, text: '需要配音' },
    { id: `${id}-disabled`, projectId: id, start: 2, end: 3, text: '保留原声', enabled: false }
  ])
  return id
}
const voice = { ...defaultVoiceSettings(), synthesisMode: 'tts' as const, aiUseReference: false, ttsRate: 20 }
describe('批量处理范围与事务', () => {
  it('拒绝旧客户端的自动合成选项以及跨手动步骤的任务链', async () => {
    const id = await fixture()
    const before = await getSegments(id)
    expect(batchSchema.safeParse({ action: 'synthesize', voice, finish: true }).success).toBe(false)
    await expect(enqueue(id, ['translate', 'synthesize', 'mix', 'preview'])).rejects.toThrow('手动')
    expect(await db.select().from(jobs).where(eq(jobs.projectId, id))).toEqual([])
    expect(await getSegments(id)).toEqual(before)
  })
  it('当前步骤完成前不能提前排入配音，也不会覆盖已保存内容', async () => {
    const id = await fixture()
    const before = await getSegments(id)
    await enqueue(id, ['translate'])
    await expect(generateSegment(`${id}-ready`, voice)).rejects.toThrow('核对')
    expect(await getSegments(id)).toEqual(before)
    expect((await getProject(id)).outputPath).toBe('old.mp3')
    expect((await db.select().from(jobs).where(eq(jobs.projectId, id))).map((job) => job.stage)).toEqual([
      'translate'
    ])
  })
  it('取消旧自动链的全部待执行后代，保留历史、片段与手动任务，且可重复执行', async () => {
    const id = await fixture()
    await db.update(projects).set({ paused: true }).where(eq(projects.id, id))
    const before = await getSegments(id)
    const stages = ['transcribe', 'translate', 'synthesize', 'mix', 'preview', 'export'] as const
    await db.insert(jobs).values(
      stages.map((stage, index) => ({
        id: `${id}-${stage}`,
        projectId: id,
        stage,
        status:
          index === 0 ? ('completed' as const) : index === 1 ? ('failed' as const) : ('queued' as const),
        error: index === 1 ? '翻译失败记录' : null,
        dependsOn: index ? `${id}-${stages[index - 1]}` : null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }))
    )
    await db.insert(jobs).values([
      { id: `${id}-manual-mix`, projectId: id, stage: 'mix', createdAt: 1, updatedAt: 1 },
      {
        id: `${id}-manual-preview`,
        projectId: id,
        stage: 'preview',
        dependsOn: `${id}-manual-mix`,
        createdAt: 1,
        updatedAt: 1
      }
    ])
    expect(await cancelAutomaticFollowups()).toEqual(stages.slice(2).map((stage) => `${id}-${stage}`))
    expect(await cancelAutomaticFollowups()).toEqual([])
    const result = await db.select().from(jobs).where(eq(jobs.projectId, id))
    expect(result).toHaveLength(8)
    expect(result.find((job) => job.stage === 'translate')).toMatchObject({
      status: 'failed',
      error: '翻译失败记录'
    })
    expect(result.find((job) => job.stage === 'transcribe')!.status).toBe('completed')
    expect(result.filter((job) => job.status === 'cancelled')).toHaveLength(4)
    expect(result.filter((job) => job.status === 'queued').map((job) => job.id)).toEqual([
      `${id}-manual-mix`,
      `${id}-manual-preview`
    ])
    expect(await getSegments(id)).toEqual(before)
    expect((await getProject(id)).outputPath).toBe('old.mp3')
  })
  it('仅补齐未生成台词，保留已有配音和关闭替换的参数，完成后停下来核对', async () => {
    const id = await fixture()
    const result = await enqueue(id, undefined, undefined, {
      action: 'synthesize',
      scope: 'missing',
      voice
    })
    expect(result.map((j) => j.stage)).toEqual(['synthesize'])
    expect(result[0]!.segmentId).toBe(`${id}-missing`)
    expect(result[0]!.dependsOn).toBeNull()
    const lines = await getSegments(id)
    expect(lines[0]!.generatedPath).toBe('ready.mp3')
    expect(lines[0]!.aiPrompt).toBe('已有参数')
    expect(lines[1]!.ttsRate).toBe(20)
    expect(lines[2]!.ttsRate).toBe(0)
    expect((await getProject(id)).outputPath).toBeNull()
    await expect(
      enqueue(id, undefined, undefined, { action: 'synthesize', scope: 'all', finish: false, voice })
    ).rejects.toThrow('任务')
    expect((await getSegments(id))[0]!.generatedPath).toBe('ready.mp3')
  })
  it('全部重生成仅作用于开启替换的台词', async () => {
    const id = await fixture()
    const result = await enqueue(id, undefined, undefined, {
      action: 'synthesize',
      scope: 'all',
      finish: false,
      voice
    })
    expect(result.map((j) => j.segmentId)).toEqual([`${id}-ready`, `${id}-missing`])
    expect(result.every((job) => job.dependsOn === null)).toBe(true)
    expect(result[0]!.batchId).toBeTruthy()
    expect(result[1]!.batchId).toBe(result[0]!.batchId)
    expect((await getSegments(id))[0]!.generatedPath).toBeNull()
    expect((await getSegments(id))[2]!.synthesisMode).toBe('ai')
  })
  it('沿用各句参数批量生成，保留角色音色并清除重生成范围内的旧音频', async () => {
    const id = await fixture()
    await db
      .update(segments)
      .set({ ...voice, ttsVoice: 'zh-CN-YunxiNeural', ttsRate: 7 })
      .where(eq(segments.id, `${id}-ready`))
    await db
      .update(segments)
      .set({ ...voice, ttsVoice: 'zh-CN-XiaoxiaoNeural', ttsRate: -10 })
      .where(eq(segments.id, `${id}-missing`))
    const input = batchSchema.parse({
      action: 'synthesize',
      scope: 'all',
      useSegmentVoices: true,
      voice: { ...voice, ttsRate: 80 }
    })
    const queued = await enqueue(id, undefined, undefined, input)
    expect(queued.map((job) => job.segmentId)).toEqual([`${id}-ready`, `${id}-missing`])
    const lines = await getSegments(id)
    expect(lines[0]).toMatchObject({ ttsVoice: 'zh-CN-YunxiNeural', ttsRate: 7, generatedPath: null })
    expect(lines[1]).toMatchObject({ ttsVoice: 'zh-CN-XiaoxiaoNeural', ttsRate: -10, generatedPath: null })
    expect(lines[2]!.synthesisMode).toBe('ai')
    expect((await getProject(id)).outputPath).toBeNull()
  })
  it('沿用各句参数时检查实际原声参考和 AI 渠道，验证失败不创建任务', async () => {
    const id = await fixture()
    const input = batchSchema.parse({ action: 'synthesize', useSegmentVoices: true, voice })
    await expect(enqueue(id, undefined, undefined, input)).rejects.toThrow('没有可用原声')
    await db.update(segments).set({ aiUseReference: false }).where(eq(segments.projectId, id))
    await db.update(projects).set({ channelId: 'missing-channel' }).where(eq(projects.id, id))
    await db.update(channels).set({ enabled: false }).where(eq(channels.id, 'volcengine-default'))
    try {
      await expect(enqueue(id, undefined, undefined, input)).rejects.toThrow('渠道')
    } finally {
      await db.update(channels).set({ enabled: true }).where(eq(channels.id, 'volcengine-default'))
    }
    expect(await db.select().from(jobs).where(eq(jobs.projectId, id))).toHaveLength(0)
    expect((await getSegments(id))[0]!.generatedPath).toBe('ready.mp3')
  })
  it('参数、文本或渠道不可用时不修改片段、不创建任务', async () => {
    expect(batchSchema.safeParse({ action: 'synthesize', voice: { ...voice, ttsRate: 101 } }).success).toBe(
      false
    )
    const id = await fixture()
    await db
      .update(segments)
      .set({ text: '' })
      .where(eq(segments.id, `${id}-missing`))
    await expect(
      enqueue(id, undefined, undefined, { action: 'synthesize', scope: 'all', finish: false, voice })
    ).rejects.toThrow('填写')
    expect((await getSegments(id))[0]!.generatedPath).toBe('ready.mp3')
    expect(await db.select().from(jobs).where(eq(jobs.projectId, id))).toHaveLength(0)
  })
  it('沿用每句配置时保留完整要求，共用参数时重新使用台词', async () => {
    const id = await fixture()
    await db
      .update(segments)
      .set({ text: '', generationPrompt: '轻声说：「你好。」', aiUseReference: false })
      .where(eq(segments.id, `${id}-missing`))
    await enqueue(id, undefined, undefined, {
      action: 'synthesize',
      scope: 'missing',
      finish: false,
      useSegmentVoices: true
    })
    expect((await getSegments(id))[1]!.generationPrompt).toBe('轻声说：「你好。」')
    const otherId = await fixture()
    await db
      .update(segments)
      .set({ generationPrompt: '旧要求' })
      .where(eq(segments.id, `${otherId}-missing`))
    await enqueue(otherId, undefined, undefined, {
      action: 'synthesize',
      scope: 'missing',
      finish: false,
      voice
    })
    expect((await getSegments(otherId))[1]!.generationPrompt).toBeNull()
  })
  it('已有台词不会重新分段；文本项目缺少配音不会直接合成', async () => {
    const id = await fixture()
    const project = await getProject(id),
      lines = await getSegments(id)
    expect(() =>
      batchPlan({ ...project, kind: 'audio' }, lines, { action: 'prepare', scope: 'all', finish: false })
    ).toThrow('覆盖')
    expect(() => batchPlan(project, lines, { action: 'render', scope: 'all', finish: false })).toThrow('所有')
  })
  it('媒体项目允许部分配音成片，未生成片段保留原声', async () => {
    const id = await fixture()
    const project = {
      ...(await getProject(id)),
      kind: 'audio' as const,
      audioPath: 'original.wav',
      backgroundPath: 'background.wav'
    }
    expect(
      batchPlan(project, await getSegments(id), { action: 'render', scope: 'all', finish: false })
    ).toEqual([{ stage: 'mix' }, { stage: 'preview' }])
  })
})
describe('原始音频试听', () => {
  it('截取整句时间范围，时间修改后生成新缓存', async () => {
    const id = await fixture()
    await projectDir(id)
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', assetPath(`${id}/source.wav`)])
    await db
      .update(projects)
      .set({ kind: 'audio', sourcePath: `${id}/source.wav`, duration: 4 })
      .where(eq(projects.id, id))
    const paths = await Promise.all([originalClip(`${id}-missing`), originalClip(`${id}-missing`)])
    expect(paths[0]).toBe(paths[1])
    expect((await probe(assetPath(paths[0]!))).duration).toBeCloseTo(1, 1)
    await db
      .update(segments)
      .set({ end: 2.5 })
      .where(eq(segments.id, `${id}-missing`))
    const next = await originalClip(`${id}-missing`)
    expect(next).not.toBe(paths[0])
    expect((await probe(assetPath(next))).duration).toBeCloseTo(1.5, 1)
  })
})
