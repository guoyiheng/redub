import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { db, initDb } from '../server/db'
import { projects, segments } from '../server/db/schema'
import { assetPath, ffmpeg, probe, projectDir } from '../server/services/media'
import { getPreviewTracks } from '../server/services/preview-tracks'
import { exportProject } from '../server/services/export'

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
    expect(amplitude(1.1, 0.5, 110)).toBeGreaterThan(0.02)
    expect(amplitude(1.1, 0.5, 880)).toBeGreaterThan(0.02)
  })

  it('按勾选音轨合并并复制原视频流导出 MKV', async () => {
    const result = await exportProject(id, {
      original: false,
      background: true,
      dubbed: true,
      originalMode: 'preserve-gaps',
      format: 'mkv'
    })
    expect(result.filename.endsWith('.mkv')).toBe(true)
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
      format: 'mkv'
    })
    expect(result.filename.endsWith('.mkv')).toBe(true)
    expect(existsSync(assetPath(result.path))).toBe(true)
    const info = await probe(assetPath(result.path))
    expect(info.video).toBe(true)
    expect(info.duration).toBeCloseTo(4, 2)
  })

  it('拒绝把优化合成与其他音轨重复合并', async () => {
    await expect(
      exportProject(id, {
        optimized: true,
        original: false,
        background: true,
        dubbed: false,
        originalMode: 'preserve-gaps',
        format: 'mkv'
      })
    ).rejects.toThrow('不能与其他音轨重复合并')
  })
})
