import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, initDb } from '../server/db'
import { projects, segments } from '../server/db/schema'
import { assetPath, ffmpeg, probe, projectDir, alignAudio, localModel } from '../server/services/media'
import { exportProject } from '../server/services/export'
import { translateLines } from '../server/services/providers'
import { getProject, getSegments } from '../server/services/store'
import { getPreviewTracks } from '../server/services/preview-tracks'
import { executeJob } from '../server/services/pipeline'
import { assertTimeline } from '../shared/timeline'
import type { Job } from '../shared/types'

vi.mock('../server/services/media', async (original) => ({
  ...(await original<typeof import('../server/services/media')>()),
  localModel: vi.fn()
}))
afterEach(() => vi.unstubAllGlobals())

let id: string
let dir: string

beforeAll(async () => {
  await initDb()
  id = randomUUID()
  dir = await projectDir(id)
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x112233:s=320x180:r=24:d=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=4:sample_rate=48000',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    join(dir, 'source.mp4')
  ])
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:duration=4:sample_rate=48000',
    join(dir, 'original.wav')
  ])
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=110:duration=4:sample_rate=48000',
    join(dir, 'background.wav')
  ])
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=1.2:sample_rate=48000',
    join(dir, 'voice1.wav')
  ])
  await db.insert(projects).values({
    id,
    name: '电影交差特化测试',
    kind: 'video',
    sourcePath: `${id}/source.mp4`,
    audioPath: `${id}/original.wav`,
    backgroundPath: `${id}/background.wav`,
    duration: 4,
    sourceLanguage: 'ja',
    targetLanguage: '中文',
    channelId: 'volcengine-default',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  await db.insert(segments).values([
    {
      id: `${id}-seg-1`,
      projectId: id,
      start: 0.5,
      end: 2.5,
      speaker: '男主角',
      text: 'すみません、遅れました。',
      translation: '抱歉迟到了。',
      enabled: true,
      generatedPath: `${id}/voice1.wav`
    },
    {
      id: `${id}-seg-2`,
      projectId: id,
      start: 2.6,
      end: 3.8,
      speaker: '女主角',
      text: '大丈夫です。',
      translation: '没关系的。',
      enabled: true,
      generatedPath: `${id}/voice1.wav`
    }
  ])
})

describe('电影配音优化专项测试', () => {
  it('翻译使用实际片段时长，仅为中文提供字数参考，不按汉字预算裁剪其他语言', async () => {
    const requests: { messages: { content: string }[] }[] = []
    const fakeFetch = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body))
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: [
                    { id: `${id}-seg-1`, text: '不好意思我来晚了。' },
                    { id: `${id}-seg-2`, text: '没事的。' }
                  ]
                })
              }
            }
          ]
        })
      )
    })
    vi.stubGlobal('fetch', fakeFetch)

    const lines = await getSegments(id)
    const channel = {
      id: 'mock-trans',
      name: 'Mock',
      type: 'openai' as const,
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      keyEnv: 'TRANSLATION_API_KEY',
      enabled: true,
      pitch: 0,
      speed: 0,
      loudness: 0,
      apiKey: 'test-key',
      configured: true
    }
    const result = await translateLines(lines, '中文', channel)
    expect(result.get(`${id}-seg-1`)).toBe('不好意思我来晚了。')
    const userData = JSON.parse(requests[0]!.messages[1]!.content)
    expect(userData[0].durationSec).toBe(2)
    expect(userData[0].maxChars).toBe(6)
    await translateLines([{ ...lines[0]!, end: lines[0]!.start + 0.25 }, lines[1]!], '英语', channel)
    const english = JSON.parse(requests[1]!.messages[1]!.content)
    expect(english[0].durationSec).toBe(0.25)
    expect(english[0]).not.toHaveProperty('maxChars')
  })

  it('alignAudio 在配音较短时保持自然语速留白，不使用 atempo 强行拉长', async () => {
    const targetWav = join(dir, 'aligned-natural.wav')
    // 原音频 voice1.wav 时长为 1.2 秒，目标时长为 2.5 秒（较短）
    await alignAudio(join(dir, 'voice1.wav'), targetWav, 2.5)
    expect(existsSync(targetWav)).toBe(true)
    const info = await probe(targetWav)
    expect(info.duration).toBeCloseTo(2.5, 1)
    const pcmFile = join(dir, 'natural.pcm')
    await ffmpeg(['-i', targetWav, '-f', 's16le', '-ac', '1', pcmFile])
    const pcm = await readFile(pcmFile)
    const maxSample = (start: number, end: number) => {
      let max = 0
      for (let i = Math.floor(start * 48000); i < Math.floor(end * 48000); i++)
        max = Math.max(max, Math.abs(pcm.readInt16LE(i * 2)))
      return max
    }
    expect(maxSample(0.1, 1.1)).toBeGreaterThan(1000)
    expect(maxSample(1.3, 2.4)).toBe(0)
  })

  it('超过 1.2 倍限速的配音明确失败，不写出截断音频；限速内可正常对齐', async () => {
    const source = join(dir, 'voice1.wav')
    const rejected = join(dir, 'must-not-truncate.wav')
    await expect(alignAudio(source, rejected, 0.5)).rejects.toThrow('请缩短台词')
    expect(existsSync(rejected)).toBe(false)
    await expect(alignAudio(source, rejected, 0)).rejects.toThrow('必须大于零')
    const accepted = join(dir, 'aligned-fast.wav')
    await alignAudio(source, accepted, 1)
    expect((await probe(accepted)).duration).toBeCloseTo(1, 2)
    const tail = join(dir, 'aligned-tail.pcm')
    await ffmpeg(['-ss', '0.85', '-i', accepted, '-t', '0.1', '-f', 's16le', '-ac', '1', tail])
    const pcm = await readFile(tail)
    expect(pcm.length).toBeGreaterThan(8000)
    expect(pcm.some((value) => value !== 0)).toBe(true)
  })

  it('相邻片段允许接壤，重叠、越界和无效时间范围被拒绝', () => {
    expect(() =>
      assertTimeline(
        [
          { start: 1, end: 2 },
          { start: 0, end: 1 }
        ],
        2
      )
    ).not.toThrow()
    expect(() =>
      assertTimeline([
        { start: 0, end: 2 },
        { start: 1, end: 3 }
      ])
    ).toThrow('重叠')
    expect(() =>
      assertTimeline([
        { start: 0, end: 3 },
        { start: 1, end: 2 }
      ])
    ).toThrow('重叠')
    expect(() => assertTimeline([{ start: 0, end: 2.01 }], 2)).toThrow('超出')
    for (const line of [
      { start: -1, end: 2 },
      { start: 1, end: 1 },
      { start: 0, end: Infinity }
    ])
      expect(() => assertTimeline([line])).toThrow('无效')
  })

  it.each([
    { start: 2, end: 3, error: '重叠' },
    { start: 3.8, end: 5, error: '超出' }
  ])('预览、合成和导出对错误时间范围统一拒绝：$error', async ({ start, end, error }) => {
    const extraId = `${id}-invalid`
    await db.insert(segments).values({
      id: extraId,
      projectId: id,
      start,
      end,
      text: '不能忽略的台词',
      generatedPath: `${id}/voice1.wav`
    })
    try {
      await expect(getPreviewTracks(id)).rejects.toThrow(error)
      await expect(
        executeJob({ id: randomUUID(), projectId: id, stage: 'mix' } as Job, async () => {})
      ).rejects.toThrow(error)
      await expect(
        exportProject(id, {
          optimized: true,
          original: false,
          background: false,
          dubbed: false,
          target: 'video'
        })
      ).rejects.toThrow(error)
    } finally {
      await db.delete(segments).where(eq(segments.id, extraId))
    }
  })

  it('导出视频时同步生成配套同名外挂字幕 (.srt)，且成片不内嵌烧录字幕', async () => {
    const result = await exportProject(id, {
      optimized: false,
      original: false,
      background: true,
      dubbed: true,
      originalMode: 'preserve-gaps',
      target: 'video'
    })
    expect(result.filename.endsWith('.mp4')).toBe(true)
    expect(result.subtitleFilename?.endsWith('.srt')).toBe(true)
    expect(result.subtitlePath).toBeTruthy()

    // 检查 .srt 文件是否存在且内容包含翻译台词
    const srtFile = assetPath(result.subtitlePath!)
    expect(existsSync(srtFile)).toBe(true)
    const srtContent = await readFile(srtFile, 'utf-8')
    expect(srtContent).toContain('抱歉迟到了。')
    expect(srtContent).toContain('没关系的。')
  })

  it('识别返回空台词时保留原声，返回未知片段时不部分覆盖已有台词', async () => {
    const before = await getSegments(id)
    for (const line of before)
      await db
        .update(segments)
        .set({ referencePath: `${id}/voice1.wav` })
        .where(eq(segments.id, line.id))
    const saved = await getSegments(id)
    const project = await getProject(id)
    vi.mocked(localModel).mockResolvedValueOnce([
      { id: before[0]!.id, text: '有台词' },
      { id: 'unknown', text: '' }
    ])
    const run = () =>
      executeJob({ id: randomUUID(), projectId: id, stage: 'transcribe' } as Job, async () => {})
    await expect(run()).rejects.toThrow('不完整')
    expect(await getSegments(id)).toEqual(saved)
    expect(await getProject(id)).toEqual(project)
    vi.mocked(localModel).mockResolvedValueOnce([
      { id: before[0]!.id, text: ' 有台词 ' },
      { id: before[1]!.id, text: '  ' }
    ])
    await run()
    const after = await getSegments(id)
    expect(after[0]).toMatchObject({
      text: '有台词',
      enabled: true,
      generatedPath: null,
      generatedDuration: null,
      subtitle: null
    })
    expect(after[1]).toMatchObject({
      text: '',
      enabled: false,
      generatedPath: null,
      generatedDuration: null,
      subtitle: null
    })
  })

  it('单句翻译只翻译该句，并返回对应译文', async () => {
    const lines = await getSegments(id)
    const targetSeg = lines[0]!
    const fakeFetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: [{ id: targetSeg.id, text: '单句独立翻译译文。' }]
                })
              }
            }
          ]
        })
      )
    })
    vi.stubGlobal('fetch', fakeFetch)
    const channel = {
      id: 'mock-single-trans',
      name: 'Mock Single',
      type: 'openai' as const,
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      keyEnv: 'TRANSLATION_API_KEY',
      enabled: true,
      apiKey: 'test-key',
      configured: true
    }
    const result = await translateLines([targetSeg], '中文', channel)
    expect(result.get(targetSeg.id)).toBe('单句独立翻译译文。')
  })

  it('渠道配置省略声音参数，且支持拉取模型列表', async () => {
    const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'deepseek-chat' }]
          })
        )
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    })
    vi.stubGlobal('fetch', fakeFetch)

    const res = await fakeFetch('https://api.openai.com/v1/models')
    const data = await res.json()
    const modelIds = data.data.map((m: any) => m.id)
    expect(modelIds).toContain('gpt-4o')
    expect(modelIds).toContain('deepseek-chat')
  })
})
