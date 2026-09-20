import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, initDb } from '../server/db'
import { projects, segments } from '../server/db/schema'
import { assetPath, cutAudio, ffmpeg, projectDir, runProcess } from '../server/services/media'
import { executeJob } from '../server/services/pipeline'
import { getProject, getSegments } from '../server/services/store'
import type { Job, Stage } from '../shared/types'

vi.mock('../server/services/media', async (original) => ({
  ...(await original<typeof import('../server/services/media')>()),
  runProcess: vi.fn()
}))
let id: string, dir: string, voice: Buffer
const run = (stage: Stage) => executeJob({ id: randomUUID(), projectId: id, stage } as Job, async () => {})
beforeAll(async () => {
  await initDb()
  id = randomUUID()
  dir = await projectDir(id)
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
    'sine=frequency=660:duration=1',
    '-c:a',
    'libmp3lame',
    join(dir, 'voice.mp3')
  ])
  voice = await readFile(join(dir, 'voice.mp3'))
  await db.insert(projects).values({
    id,
    name: '手动片段参考验证',
    kind: 'audio',
    duration: 4,
    sourcePath: `${id}/original.wav`,
    audioPath: `${id}/original.wav`,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  await db
    .insert(segments)
    .values({ id: `${id}-line`, projectId: id, start: 1, end: 2, text: 'Hello', translation: '你好' })
  vi.mocked(runProcess).mockImplementation(async () => {
    const stems = join(dir, 'stems/htdemucs/original')
    await mkdir(stems, { recursive: true })
    await copyFile(join(dir, 'original.wav'), join(stems, 'vocals.wav'))
    await copyFile(join(dir, 'original.wav'), join(stems, 'no_vocals.wav'))
    return ''
  })
})
afterEach(() => vi.unstubAllGlobals())

describe.sequential('原声音色参考生命周期', () => {
  it('未分离的音视频不会悄悄退回纯文本配音', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(run('synthesize')).rejects.toThrow('请先完成人声分离')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('为手动片段截取准确的原声参考，成功后复用，参考文件丢失后重建', async () => {
    await run('separate')
    const p = await getProject(id)
    const expected = join(dir, 'expected.wav')
    await cutAudio(assetPath(p.vocalsPath!), expected, 1, 1)
    const reference = await readFile(expected)
    const fetcher = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body)
      expect(body.text_prompt).toContain('@音频1')
      expect(Buffer.from(body.references[0].audio_data, 'base64')).toEqual(reference)
      return new Response(JSON.stringify({ audio: voice.toString('base64') }))
    })
    vi.stubGlobal('fetch', fetcher)
    await run('synthesize')
    const [line] = await getSegments(id)
    expect(line!.referencePath).toBeTruthy()
    expect(line!.generatedPath).toBeTruthy()
    await run('synthesize')
    expect(fetcher).toHaveBeenCalledTimes(1)
    await rm(assetPath(line!.referencePath!))
    await run('synthesize')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((await getSegments(id))[0]!.referencePath).not.toBe(line!.referencePath)
  })
  it('重新分离会清除旧音色参考、配音和成片，保留台词编辑', async () => {
    const before = await getProject(id)
    await db.update(projects).set({ mixedPath: 'old.wav', outputPath: 'old.mp3' }).where(eq(projects.id, id))
    await run('separate')
    const after = await getProject(id)
    expect(after.vocalsPath).not.toBe(before.vocalsPath)
    expect(after.backgroundPath).not.toBe(before.backgroundPath)
    expect(after.mixedPath).toBeNull()
    expect(after.outputPath).toBeNull()
    expect((await getSegments(id))[0]).toMatchObject({
      text: 'Hello',
      translation: '你好',
      start: 1,
      end: 2,
      referencePath: null,
      generatedPath: null,
      generatedHash: null,
      generatedDuration: null,
      subtitle: null
    })
  })
  it('重新分离失败保留已发布的人声和背景', async () => {
    const before = await getProject(id)
    vi.mocked(runProcess).mockRejectedValueOnce(new Error('separation failed'))
    await expect(run('separate')).rejects.toThrow('separation failed')
    const after = await getProject(id)
    expect(after.vocalsPath).toBe(before.vocalsPath)
    expect(after.backgroundPath).toBe(before.backgroundPath)
  })
})
