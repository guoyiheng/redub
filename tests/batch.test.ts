import { beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, initDb } from '../server/db'
import { projects, segments, jobs } from '../server/db/schema'
import { enqueue } from '../server/services/queue'
import { getProject, getSegments } from '../server/services/store'
import { batchPlan, batchSchema } from '../shared/batch'
import { defaultVoiceSettings } from '../shared/voice'
import { originalClip } from '../server/services/original-clip'
import { assetPath, ffmpeg, probe, projectDir } from '../server/services/media'
vi.mock('../server/services/store', async (original) => {
  const actual = await original<typeof import('../server/services/store')>()
  return { ...actual, getSettings: async () => ({ ...(await actual.getSettings()), concurrency: 0 }) }
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
  it('仅补齐未生成台词，保留已有配音和关闭替换的参数，串联成片任务', async () => {
    const id = await fixture()
    const result = await enqueue(id, undefined, undefined, {
      action: 'synthesize',
      scope: 'missing',
      finish: true,
      voice
    })
    expect(result.map((j) => j.stage)).toEqual(['synthesize', 'mix', 'preview'])
    expect(result[0]!.segmentId).toBe(`${id}-missing`)
    expect(result[1]!.dependsOn).toBe(result[0]!.id)
    expect(result[2]!.dependsOn).toBe(result[1]!.id)
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
    expect((await getSegments(id))[0]!.generatedPath).toBeNull()
    expect((await getSegments(id))[2]!.synthesisMode).toBe('ai')
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
