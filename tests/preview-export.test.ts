import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { db, initDb } from '../server/db'
import { projects, segments } from '../server/db/schema'
import { assetPath, ffmpeg, probe, projectDir, runProcess } from '../server/services/media'
import { getPreviewTracks } from '../server/services/preview-tracks'
import { exportProject } from '../server/services/export'

let id: string
let dir: string
const require = createRequire(import.meta.url)
const inspect = async (path: string) =>
  JSON.parse(
    await runProcess(require('ffprobe-static').path, [
      '-v',
      'error',
      '-show_streams',
      '-show_chapters',
      '-of',
      'json',
      path
    ])
  )
async function streamHash(path: string, stream: string) {
  const output = join(dir, `${randomUUID()}.hash`)
  await ffmpeg(['-i', path, '-map', stream, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', output])
  return readFile(output, 'utf8')
}

beforeAll(async () => {
  await initDb()
  id = randomUUID()
  dir = await projectDir(id)
  await writeFile(join(dir, 'original.srt'), '1\n00:00:00,000 --> 00:00:02,000\nOriginal subtitle\n')
  await writeFile(
    join(dir, 'chapters.txt'),
    ';FFMETADATA1\ntitle=Original movie\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=4000\ntitle=Opening\n'
  )
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x30302e:s=320x180:r=24:d=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=4:sample_rate=48000',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:duration=4:sample_rate=48000',
    '-i',
    join(dir, 'original.srt'),
    '-f',
    'ffmetadata',
    '-i',
    join(dir, 'chapters.txt'),
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-map',
    '3:s',
    '-map_metadata',
    '4',
    '-map_chapters',
    '4',
    '-metadata:s:a:0',
    'language=eng',
    '-metadata:s:a:1',
    'language=jpn',
    '-disposition:a:0',
    'default',
    '-disposition:a:1',
    '0',
    '-c:s',
    'mov_text',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
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
    'sine=frequency=880:duration=1:sample_rate=48000',
    join(dir, 'voice.wav')
  ])
  await db.insert(projects).values({
    id,
    name: '预览导出验证',
    kind: 'video',
    sourcePath: `${id}/source.mp4`,
    audioPath: `${id}/original.wav`,
    backgroundPath: `${id}/background.wav`,
    duration: 4,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  await db.insert(segments).values({
    id: `${id}-line`,
    projectId: id,
    start: 1,
    end: 2,
    text: 'Hello',
    translation: '你好',
    generatedPath: `${id}/voice.wav`,
    generatedDuration: 1
  })
})

describe('预览音轨与无损导出', () => {
  it('生成优化合成与三条源音轨、波形和静音原声版本', async () => {
    const tracks = await getPreviewTracks(id)
    expect(tracks.duration).toBe(4)
    expect(tracks.missingDubs).toBe(0)
    expect(tracks.replacementRanges).toEqual([{ start: 1, end: 2 }])
    expect(tracks.tracks.original.path).toBe(`${id}/original.wav`)
    expect(tracks.tracks.background.path).toBe(`${id}/background.wav`)
    expect(tracks.tracks.dubbed.path).toBeTruthy()
    expect(tracks.tracks.optimized.path).toBeTruthy()
    expect(tracks.tracks.original.alternatePath).toBeTruthy()
    expect(tracks.tracks.optimized.peaks).toHaveLength(600)
    expect(tracks.tracks.original.peaks).toHaveLength(600)
    expect(tracks.tracks.background.peaks).toHaveLength(600)
    expect(tracks.tracks.dubbed.peaks).toHaveLength(600)
    expect(existsSync(assetPath(tracks.tracks.dubbed.path!))).toBe(true)
    expect(existsSync(assetPath(tracks.tracks.optimized.path!))).toBe(true)
    expect(existsSync(assetPath(tracks.tracks.original.alternatePath!))).toBe(true)
    expect((await probe(assetPath(tracks.tracks.dubbed.path!))).duration).toBeCloseTo(4, 2)
    expect((await probe(assetPath(tracks.tracks.optimized.path!))).duration).toBeCloseTo(4, 2)
    expect((await probe(assetPath(tracks.tracks.original.alternatePath!))).duration).toBeCloseTo(4, 2)
  })

  it('优化合成只在替换区间混入背景与配音，其余区间保留原始音轨', async () => {
    const tracks = await getPreviewTracks(id)
    const pcmPath = join(dir, 'optimized.pcm')
    await ffmpeg([
      '-i',
      assetPath(tracks.tracks.optimized.path!),
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      pcmPath
    ])
    const pcm = await readFile(pcmPath)
    const bytesPerSecond = 48000 * 2 * 2
    const amplitude = (start: number, duration: number, hz: number) => {
      let re = 0,
        im = 0
      const samples = Math.floor(duration * 48000)
      const offset = Math.floor(start * bytesPerSecond)
      for (let n = 0; n < samples; n++) {
        const sample = pcm.readInt16LE(offset + n * 4) / 32768
        re += sample * Math.cos((2 * Math.PI * hz * n) / 48000)
        im += sample * Math.sin((2 * Math.PI * hz * n) / 48000)
      }
      return Math.hypot(re, im) / samples
    }
    expect(amplitude(0.1, 0.5, 330)).toBeGreaterThan(0.02)
    expect(amplitude(0.1, 0.5, 110)).toBeLessThan(0.001)
    expect(amplitude(0.1, 0.5, 880)).toBeLessThan(0.001)
    expect(amplitude(1.1, 0.5, 110)).toBeGreaterThan(0.02)
    expect(amplitude(1.1, 0.5, 880)).toBeGreaterThan(0.02)
    expect(amplitude(1.1, 0.5, 330)).toBeLessThan(0.001)
  })

  it('保留 MP4 原视频和原音轨，新增混合音轨', async () => {
    const result = await exportProject(id, {
      original: false,
      background: true,
      dubbed: true,
      originalMode: 'preserve-gaps',
      target: 'video'
    })
    expect(result.filename.endsWith('.mp4')).toBe(true)
    expect(existsSync(assetPath(result.path))).toBe(true)
    const info = await probe(assetPath(result.path))
    expect(info.video).toBe(true)
    expect(info.duration).toBeCloseTo(4, 2)
  })

  it('按优化合成音轨直接导出成片', async () => {
    const result = await exportProject(id, {
      optimized: true,
      original: false,
      background: false,
      dubbed: false,
      originalMode: 'preserve-gaps',
      target: 'video'
    })
    expect(result.filename.endsWith('.mp4')).toBe(true)
    expect(existsSync(assetPath(result.path))).toBe(true)
    const info = await probe(assetPath(result.path))
    expect(info.video).toBe(true)
    expect(info.duration).toBeCloseTo(4, 2)
    const source = join(dir, 'source.mp4')
    const output = assetPath(result.path)
    const before = await inspect(source)
    const after = await inspect(output)
    const audioBefore = before.streams.filter((stream: any) => stream.codec_type === 'audio')
    const audioAfter = after.streams.filter((stream: any) => stream.codec_type === 'audio')
    expect(audioBefore).toHaveLength(2)
    expect(audioAfter).toHaveLength(3)
    for (const stream of ['0:v:0', '0:a:0', '0:a:1', '0:s:0'])
      expect(await streamHash(output, stream)).toBe(await streamHash(source, stream))
    for (let i = 0; i < 2; i++) {
      expect(audioAfter[i].codec_name).toBe(audioBefore[i].codec_name)
      expect(audioAfter[i].tags.language).toBe(audioBefore[i].tags.language)
      expect(audioAfter[i].disposition).toEqual(audioBefore[i].disposition)
    }
    expect(audioAfter[2].tags.handler_name).toBe('ReDub')
    expect(audioAfter[2].disposition.default).toBe(0)
    expect(
      after.chapters.map((chapter: any) => [chapter.start_time, chapter.end_time, chapter.tags.title])
    ).toEqual(
      before.chapters.map((chapter: any) => [chapter.start_time, chapter.end_time, chapter.tags.title])
    )
  })

  it('视频项目可单独导出音轨，部分配音也能导出', async () => {
    const missingId = `${id}-partial-export`
    await db.insert(segments).values({ id: missingId, projectId: id, start: 2, end: 3, text: '尚未配音' })
    try {
      const [audio, video] = await Promise.all([
        exportProject(id, { target: 'audio', dubbed: true }),
        exportProject(id, { target: 'video', optimized: true })
      ])
      expect(audio.filename).toMatch(/\.wav$/)
      expect((await probe(assetPath(audio.path))).video).toBe(false)
      expect((await probe(assetPath(audio.path))).duration).toBeCloseTo(4, 2)
      expect(video.filename).toMatch(/\.mp4$/)
      expect((await probe(assetPath(video.path))).audioStreams).toBe(3)
    } finally {
      await db.delete(segments).where(eq(segments.id, missingId))
    }
  })

  it.each(['mkv', 'mov', 'webm', 'avi'])('保留源 %s 容器且只编码新增音轨', async (extension) => {
    const path = `${id}/source.${extension}`
    await ffmpeg([
      '-i',
      join(dir, 'source.mp4'),
      '-map',
      '0:v:0',
      '-map',
      '0:a',
      ...(extension === 'webm' ? ['-c:v', 'libvpx-vp9', '-c:a', 'libopus'] : ['-c', 'copy']),
      assetPath(path)
    ])
    await db.update(projects).set({ sourcePath: path }).where(eq(projects.id, id))
    try {
      const result = await exportProject(id, { target: 'video', optimized: true })
      expect(result.filename.endsWith(`.${extension}`)).toBe(true)
      expect((await probe(assetPath(result.path))).audioStreams).toBe(3)
      for (const stream of ['0:v:0', '0:a:0', '0:a:1'])
        expect(await streamHash(assetPath(result.path), stream)).toBe(
          await streamHash(assetPath(path), stream)
        )
    } finally {
      await db
        .update(projects)
        .set({ sourcePath: `${id}/source.mp4` })
        .where(eq(projects.id, id))
    }
  })

  it('拒绝把优化合成与其他音轨重复合并', async () => {
    await expect(
      exportProject(id, {
        optimized: true,
        original: false,
        background: true,
        dubbed: false,
        originalMode: 'preserve-gaps',
        target: 'video'
      })
    ).rejects.toThrow('不能与其他音轨重复合并')
  })

  it('字幕跟随实际音轨，修改台词后生成新的同名视频与字幕', async () => {
    const options = { optimized: true, original: false, background: false, dubbed: false, target: 'video' }
    const missingId = `${id}-missing`
    await db.insert(segments).values({
      id: missingId,
      projectId: id,
      start: 2,
      end: 3,
      text: '原声台词',
      translation: '尚未配音的译文'
    })
    try {
      const first = await exportProject(id, options)
      const before = await readFile(assetPath(first.subtitlePath!), 'utf8')
      expect(first.subtitleFilename).toBe(first.filename.replace(/\.mp4$/, '.srt'))
      expect(before).toContain('你好')
      expect(before).toContain('原声台词')
      expect(before).not.toContain('尚未配音的译文')
      await db.update(segments).set({ text: '校对后的原声台词' }).where(eq(segments.id, missingId))
      const second = await exportProject(id, options)
      expect(second.subtitlePath).not.toBe(first.subtitlePath)
      expect(second.path).not.toBe(first.path)
      expect(await readFile(assetPath(second.subtitlePath!), 'utf8')).toContain('校对后的原声台词')
      expect(await readFile(assetPath(first.subtitlePath!), 'utf8')).toBe(before)
      await writeFile(assetPath(second.subtitlePath!), 'interrupted subtitle')
      await exportProject(id, options)
      expect(await readFile(assetPath(second.subtitlePath!), 'utf8')).toContain('校对后的原声台词')

      const original = await exportProject(id, {
        ...options,
        optimized: false,
        original: true,
        originalMode: 'full'
      })
      const originalSubtitle = await readFile(assetPath(original.subtitlePath!), 'utf8')
      expect(originalSubtitle).toContain('Hello')
      expect(originalSubtitle).not.toContain('你好')
      const background = await exportProject(id, { ...options, optimized: false, background: true })
      expect(background.subtitlePath).toBeUndefined()
    } finally {
      await db.delete(segments).where(eq(segments.id, missingId))
    }
  })
})
