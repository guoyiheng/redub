import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, initDb } from '../server/db'
import { projects, segments } from '../server/db/schema'
import { projectDir, ffmpeg, probe, assetPath } from '../server/services/media'
import { getProject, getSegments, getChannel } from '../server/services/store'
import { executeJob } from '../server/services/pipeline'
import { synthesizeSpeech, synthesisHash, translateLines } from '../server/services/providers'
import type { Job, Stage } from '../shared/types'
import { getPreviewTracks } from '../server/services/preview-tracks'
import { exportProject } from '../server/services/export'
import { edgeSpeech } from '../server/services/edge-speech'
import { dubbedText, voiceLanguageInstruction } from '../shared/voice'
vi.mock('../server/services/edge-speech', () => ({ edgeSpeech: vi.fn() }))

const promptText = (prompt: string) => prompt.match(/\*合成文本：\*\s*([\s\S]*)$/)?.[1]?.trim() ?? ''

let id: string, dir: string, voice: Buffer
const progress = async () => {}
const run = (stage: Stage) =>
  executeJob({ id: randomUUID(), projectId: id, stage, segmentId: null } as Job, progress)
beforeAll(async () => {
  await initDb()
  id = randomUUID()
  dir = await projectDir(id)
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x30302e:s=320x180:r=24:d=4',
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
    'sine=frequency=880:duration=0.7:sample_rate=48000',
    '-c:a',
    'libmp3lame',
    join(dir, 'fixture.mp3')
  ])
  voice = await readFile(join(dir, 'fixture.mp3'))
  await db.insert(projects).values({
    id,
    name: '真实音视频验证',
    kind: 'video',
    sourcePath: `${id}/source.mp4`,
    duration: 4,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
})
afterEach(() => vi.unstubAllGlobals())
describe.sequential('媒体处理与服务协议', () => {
  it('提取真实视频音轨并保留全长', async () => {
    await run('extract')
    const p = await getProject(id)
    expect((await probe(assetPath(p.audioPath!))).duration).toBeCloseTo(4, 1)
  })
  it('参考原音色发送火山规定的请求，落盘音频及字幕', async () => {
    await copyFile(join(dir, 'original.wav'), join(dir, 'reference.wav'))
    await db
      .update(projects)
      .set({ vocalsPath: `${id}/original.wav` })
      .where(eq(projects.id, id))
    await db.insert(segments).values([
      {
        id: 'line-1',
        projectId: id,
        start: 1,
        end: 2,
        text: 'Hello',
        translation: '你好',
        referencePath: `${id}/reference.wav`
      },
      { id: 'line-2', projectId: id, start: 2.5, end: 3, text: 'Keep this', enabled: false }
    ])
    const fetcher = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body)
      expect(options.headers['X-Api-Key']).toBe('test-key-not-a-real-secret')
      expect(body.model).toBe('seed-audio-1.0')
      expect(body.text_prompt).toContain('@音频1')
      expect(body.text_prompt).toContain('配音语言：中文')
      expect(body.text_prompt).toMatch(/^\*指令：\* \[#/)
      expect(body.text_prompt).toContain('*引用下文：* [#Keep this]')
      expect(promptText(body.text_prompt)).toBe('你好')
      expect(body.references[0].audio_data).toBeTruthy()
      expect(body.audio_config.sample_rate).toBe(48000)
      return new Response(
        JSON.stringify({
          audio: voice.toString('base64'),
          duration: 0.7,
          subtitle: { text: '你好', sentences: [] }
        })
      )
    })
    vi.stubGlobal('fetch', fetcher)
    await run('synthesize')
    const lines = await getSegments(id)
    expect(lines[0]!.generatedPath).toBeTruthy()
    expect(lines[1]!.generatedPath).toBeNull()
    await run('synthesize')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('指定音色通过 references 传入，不引用未上传的参考音频', async () => {
    const line = (await getSegments(id))[0]!
    const fetcher = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body)
      expect(body.references).toEqual([{ speaker: 'fixture-voice' }])
      expect(body).not.toHaveProperty('speaker')
      expect(body.text_prompt).not.toContain('@音频1')
      expect(body.text_prompt).toContain(line.translation)
      expect(body.text_prompt).toContain('配音语言：日语')
      expect(body.text_prompt).not.toContain('配音语言：英语')
      expect(body.text_prompt.match(/配音语言：/g)).toHaveLength(1)
      return new Response(JSON.stringify({ audio: voice.toString('base64') }))
    })
    vi.stubGlobal('fetch', fetcher)
    const result = await synthesizeSpeech(
      {
        ...line,
        aiUseReference: false,
        aiSpeaker: ' fixture-voice ',
        aiPrompt: voiceLanguageInstruction('英语')
      },
      await getChannel('volcengine-default'),
      join(dir, 'specified-voice.mp3'),
      '日语'
    )
    expect(result.duration).toBeGreaterThan(0)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each([
    '用轻松的语气说：「欢迎回来。」',
    '[#用轻松的语气说]欢迎回来。',
    '【配音要求】：用轻松的语气说\n【角色语气】：温柔期待\n【配音台词】：「欢迎回来。」'
  ])('合并输入以文档格式发送，替换和移除参考作用于实际请求：%s', async (generationPrompt) => {
    const line = {
      ...(await getSegments(id))[0]!,
      aiPrompt: '不应附加的旧提示词',
      generationPrompt,
      customReferencePath: `${id}/fixture.mp3`
    }
    const fetcher = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body)
      expect(body.text_prompt).toContain('用轻松的语气说')
      expect(promptText(body.text_prompt)).toBe('欢迎回来。')
      expect(body.text_prompt).toContain('配音语言：中文')
      expect(body.text_prompt).not.toContain(line.translation)
      expect(body.text_prompt).not.toContain(line.aiPrompt)
      expect(body.audio_config.enable_subtitle).toBe(true)
      return new Response(
        JSON.stringify({ audio: voice.toString('base64'), subtitle: { text: '欢迎回来。' } })
      )
    })
    vi.stubGlobal('fetch', fetcher)
    const channel = await getChannel('volcengine-default')
    const result = await synthesizeSpeech(line, channel, join(dir, 'custom-reference.mp3'))
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).references).toEqual([
      { audio_data: voice.toString('base64') }
    ])
    expect(dubbedText({ ...line, subtitle: result.subtitle })).toBe('欢迎回来。')
    expect(dubbedText({ ...line, subtitle: null })).toBe('')
    await synthesizeSpeech(
      { ...line, aiUseReference: false, customReferencePath: null },
      channel,
      join(dir, 'no-reference.mp3')
    )
    const request = JSON.parse(fetcher.mock.calls[1]![1].body)
    expect(request.references).toBeUndefined()
    expect(request.text_prompt).not.toContain('@音频1')
  })
  it('语言变化使 AI 配音缓存失效', async () => {
    const line = (await getSegments(id))[0]!
    const channel = await getChannel('volcengine-default')
    expect(synthesisHash(line, channel, '中文')).not.toBe(synthesisHash(line, channel, '日语'))
  })
  it('微软 TTS 只朗读输入文字，不发送 AI 提示词或参考音频', async () => {
    const line = {
      ...(await getSegments(id))[0]!,
      synthesisMode: 'tts' as const,
      translation: '这次只读新台词。',
      generationPrompt: '用轻松的语气说：「旧内容。」'
    }
    vi.mocked(edgeSpeech).mockResolvedValue(voice)
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await synthesizeSpeech(line, await getChannel('volcengine-default'), join(dir, 'tts-input.mp3'))
    expect(edgeSpeech).toHaveBeenLastCalledWith(
      line.translation,
      expect.objectContaining({ voice: line.ttsVoice })
    )
    expect(fetcher).not.toHaveBeenCalled()
    expect(dubbedText(line)).toBe(line.translation)
  })
  it('合并仅替换启用片段，未替换原始 PCM 保持一致', async () => {
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=110:duration=4:sample_rate=48000',
      '-ac',
      '2',
      join(dir, 'background.wav')
    ])
    await db
      .update(projects)
      .set({ backgroundPath: `${id}/background.wav` })
      .where(eq(projects.id, id))
    await run('mix')
    const p = await getProject(id)
    expect((await probe(assetPath(p.mixedPath!))).duration).toBeCloseTo(4, 2)
    for (const [name, path] of [
      ['original', p.audioPath!],
      ['mixed', p.mixedPath!]
    ])
      await ffmpeg(['-i', assetPath(path), '-f', 's16le', '-acodec', 'pcm_s16le', join(dir, `${name}.pcm`)])
    const before = await readFile(join(dir, 'original.pcm')),
      after = await readFile(join(dir, 'mixed.pcm'))
    const bytesPerSecond = 48000 * 2 * 2
    expect(after.subarray(0, bytesPerSecond).equals(before.subarray(0, bytesPerSecond))).toBe(true)
    expect(
      after
        .subarray(2 * bytesPerSecond, 4 * bytesPerSecond)
        .equals(before.subarray(2 * bytesPerSecond, 4 * bytesPerSecond))
    ).toBe(true)
    expect(
      after
        .subarray(bytesPerSecond, 2 * bytesPerSecond)
        .equals(before.subarray(bytesPerSecond, 2 * bytesPerSecond))
    ).toBe(false)
    // Both the known background tone and generated tone must survive inside replacement.
    const amplitude = (hz: number) => {
      let re = 0,
        im = 0
      for (let n = 0; n < 48000; n++) {
        const sample = after.readInt16LE(bytesPerSecond + n * 4) / 32768
        re += sample * Math.cos((2 * Math.PI * hz * n) / 48000)
        im += sample * Math.sin((2 * Math.PI * hz * n) / 48000)
      }
      return Math.hypot(re, im) / 48000
    }
    expect(amplitude(110)).toBeGreaterThan(0.02)
    expect(amplitude(880)).toBeGreaterThan(0.02)
  })
  it('导出含视频与新音轨的 MP4，以及时间轴字幕', async () => {
    await run('preview')
    const p = await getProject(id)
    const info = await probe(assetPath(p.outputPath!))
    expect(info.video).toBe(true)
    expect(info.duration).toBeCloseTo(4, 1)
    expect(await readFile(join(dir, 'subtitles.srt'), 'utf8')).toContain('你好')
    expect(await readFile(join(dir, 'subtitles.srt'), 'utf8')).toContain('Keep this')
  })
  it('翻译缺少台词时拒绝部分结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: '{"translations":[]}' } }] }))
      )
    )
    await expect(
      translateLines(await getSegments(id), '中文', await getChannel('translation-default'))
    ).rejects.toThrow('不完整')
  })
  it('上游错误不能被当成有效配音', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 400, message: 'invalid reference' })))
    )
    await expect(
      synthesizeSpeech(
        (await getSegments(id))[0]!,
        await getChannel('volcengine-default'),
        join(dir, 'invalid.mp3')
      )
    ).rejects.toThrow('invalid reference')
  })
  it('部分配音保留未生成和关闭替换的原声，预览与成片混音一致', async () => {
    const lines = await getSegments(id)
    await db.update(segments).set({ generatedPath: lines[0]!.generatedPath }).where(eq(segments.id, 'line-2'))
    await db.insert(segments).values({
      id: `${id}-missing`,
      projectId: id,
      start: 3,
      end: 3.5,
      text: '未配音原文',
      translation: '不应使用的译文',
      enabled: true
    })
    await run('mix')
    const project = await getProject(id)
    const tracks = await getPreviewTracks(id)
    expect(tracks.missingDubs).toBe(1)
    expect(tracks.replacementRanges).toEqual([{ start: 1, end: 2 }])
    for (const [name, path] of [
      ['partial', project.mixedPath!],
      ['optimized', tracks.tracks.optimized.path!]
    ])
      await ffmpeg(['-i', assetPath(path), '-f', 's16le', '-acodec', 'pcm_s16le', join(dir, `${name}.pcm`)])
    const original = await readFile(join(dir, 'original.pcm'))
    const partial = await readFile(join(dir, 'partial.pcm'))
    const optimized = await readFile(join(dir, 'optimized.pcm'))
    const bytesPerSecond = 48000 * 2 * 2
    expect(partial.equals(optimized)).toBe(true)
    expect(
      partial
        .subarray(2 * bytesPerSecond, 4 * bytesPerSecond)
        .equals(original.subarray(2 * bytesPerSecond, 4 * bytesPerSecond))
    ).toBe(true)
    const subtitles = await readFile(join(dir, 'subtitles.srt'), 'utf8')
    expect(subtitles).toContain('未配音原文')
    expect(subtitles).not.toContain('不应使用的译文')
    const output = await exportProject(id, {
      optimized: true,
      original: false,
      background: false,
      dubbed: false,
      target: 'video'
    })
    expect((await probe(assetPath(output.path))).duration).toBeCloseTo(4, 2)
  })
})
