import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { getProject, getSegments } from './store'
import { alignAudio, assetPath, audioPeaks, ffmpeg, projectDir } from './media'
import type { PreviewTrack, PreviewTracks } from '../../shared/preview'
import type { Project, Segment } from '../../shared/types'

const pending = new Map<string, Promise<void>>()
const peakCache = new Map<string, number[]>()

function isAvailable(path: string | null | undefined) {
  return !!path && existsSync(assetPath(path))
}

async function fileFingerprint(path: string | null | undefined) {
  if (!path || !isAvailable(path)) return null
  const info = await stat(assetPath(path))
  return `${path}:${info.mtimeMs}:${info.size}`
}

async function revisionFor(project: Project, lines: Segment[]) {
  const source = project.audioPath || (project.kind === 'text' ? null : project.sourcePath)
  const fingerprints = await Promise.all([fileFingerprint(source), fileFingerprint(project.backgroundPath)])
  return createHash('sha256')
    .update(
      JSON.stringify({
        duration: project.duration,
        kind: project.kind,
        fingerprints,
        segments: lines.map((line) => ({
          id: line.id,
          start: line.start,
          end: line.end,
          enabled: line.enabled,
          generatedPath: line.generatedPath,
          generatedHash: line.generatedHash
        }))
      })
    )
    .digest('hex')
    .slice(0, 20)
}

async function publish(output: string, task: () => Promise<void>) {
  if (existsSync(assetPath(output))) return
  let running = pending.get(output)
  if (!running) {
    const temporary = assetPath(`${output}.partial.wav`)
    running = (async () => {
      await rm(temporary, { force: true })
      try {
        await task()
        await rename(temporary, assetPath(output))
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
    })().finally(() => pending.delete(output))
    pending.set(output, running)
  }
  await running
}

function ranges(lines: Segment[]) {
  return lines
    .filter((line) => line.enabled && line.generatedPath && line.end > line.start)
    .map((line) => ({ start: line.start, end: line.end }))
}

function muteExpression(values: { start: number; end: number }[]) {
  return values.map(({ start, end }) => `between(t,${start.toFixed(6)},${end.toFixed(6)})`).join('+')
}

async function buildOriginalGaps(
  source: string,
  output: string,
  duration: number,
  replacements: { start: number; end: number }[]
) {
  await ffmpeg([
    '-i',
    assetPath(source),
    '-af',
    `volume=volume=0:enable='${muteExpression(replacements)}'`,
    '-t',
    String(duration),
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    assetPath(`${output}.partial.wav`)
  ])
}

async function buildDubbed(projectDirPath: string, output: string, duration: number, lines: Segment[]) {
  const generated = lines.filter((line) => line.enabled && line.generatedPath)
  if (!generated.length) return false
  const work = join(projectDirPath, `.preview-build-${basename(output).replace(/\.wav$/, '')}`)
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  const chunks: string[] = []
  let cursor = 0

  const silence = async (length: number) => {
    if (length <= 0.00001) return
    const path = join(work, `silence-${chunks.length}.wav`)
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-t',
      String(length),
      '-c:a',
      'pcm_s16le',
      path
    ])
    chunks.push(path)
  }

  try {
    for (const line of generated) {
      const start = Math.max(cursor, Math.max(0, line.start))
      const end = Math.min(duration, line.end)
      if (end <= start) continue
      await silence(start - cursor)
      const aligned = join(work, `aligned-${chunks.length}.wav`)
      await alignAudio(assetPath(line.generatedPath!), aligned, end - start)
      chunks.push(aligned)
      cursor = end
    }
    await silence(duration - cursor)
    if (!chunks.length) return false
    const list = join(work, 'concat.txt')
    await writeFile(list, chunks.map((path) => `file '${basename(path)}'`).join('\n'))
    await ffmpeg([
      '-f',
      'concat',
      '-safe',
      '1',
      '-i',
      list,
      '-t',
      String(duration),
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      assetPath(`${output}.partial.wav`)
    ])
    return true
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

async function peaksFor(path: string | null, revision: string, key: string) {
  if (!path) return []
  const cacheKey = `${revision}:${key}:${path}`
  const cached = peakCache.get(cacheKey)
  if (cached) return cached
  const peaks = await audioPeaks(assetPath(path), 600)
  peakCache.set(cacheKey, peaks)
  return peaks
}

export async function getPreviewTracks(projectId: string): Promise<PreviewTracks> {
  const project = await getProject(projectId)
  const lines = await getSegments(projectId)
  const duration = Math.max(0, project.duration, ...lines.map((line) => line.end))
  if (duration <= 0) throw new Error('项目还没有可预览的时间轴')
  const revision = await revisionFor(project, lines)
  const dir = await projectDir(project.id)
  const replacements = ranges(lines)
  const missingDubs = lines.filter((line) => line.enabled && !line.generatedPath).length

  const originalSource = project.kind === 'text' ? null : project.audioPath || project.sourcePath || null
  const originalAvailable = isAvailable(originalSource)
  const backgroundAvailable = isAvailable(project.backgroundPath)
  const dubbedAvailable = lines.some((line) => line.enabled && line.generatedPath)
  const originalGaps = `${project.id}/preview-${revision}-original-gaps.wav`
  const dubbed = `${project.id}/preview-${revision}-dubbed.wav`
  const peaksFile = join(dir, `preview-${revision}-peaks.json`)

  const tasks: Promise<unknown>[] = []
  if (originalAvailable && replacements.length) {
    tasks.push(
      publish(originalGaps, () => buildOriginalGaps(originalSource!, originalGaps, duration, replacements))
    )
  }
  if (dubbedAvailable) {
    tasks.push(publish(dubbed, async () => void (await buildDubbed(dir, dubbed, duration, lines))))
  }
  await Promise.all(tasks)

  const [originalPeaks, alternatePeaks, backgroundPeaks, dubbedPeaks] = await Promise.all([
    peaksFor(originalAvailable ? originalSource : null, revision, 'original'),
    peaksFor(
      originalAvailable ? (replacements.length ? originalGaps : originalSource!) : null,
      revision,
      'original-gaps'
    ),
    peaksFor(backgroundAvailable ? project.backgroundPath : null, revision, 'background'),
    peaksFor(dubbedAvailable ? dubbed : null, revision, 'dubbed')
  ])
  const peaksCache = {
    original: originalPeaks,
    'original-gaps': alternatePeaks,
    background: backgroundPeaks,
    dubbed: dubbedPeaks
  }
  await writeFile(peaksFile, JSON.stringify(peaksCache))

  const original: PreviewTrack = {
    path: originalAvailable ? originalSource : null,
    peaks: originalPeaks,
    alternatePath: originalAvailable ? (replacements.length ? originalGaps : originalSource!) : undefined,
    alternatePeaks: originalAvailable ? alternatePeaks : undefined,
    label: '原始音轨',
    reason: originalAvailable ? undefined : '文本项目没有原始音轨，或原声文件尚未生成'
  }
  const background: PreviewTrack = {
    path: backgroundAvailable ? project.backgroundPath : null,
    peaks: backgroundPeaks,
    label: '背景音',
    reason: backgroundAvailable ? undefined : '尚未分离背景音；完成人声与背景分离后可单独试听'
  }
  const dubbedTrack: PreviewTrack = {
    path: dubbedAvailable ? dubbed : null,
    peaks: dubbedPeaks,
    label: '配音',
    reason: dubbedAvailable
      ? missingDubs
        ? `还有 ${missingDubs} 句未生成，未配音区间保持静音`
        : undefined
      : '尚未生成配音；完成配音后可单独试听'
  }
  return {
    revision,
    duration,
    tracks: { original, background, dubbed: dubbedTrack },
    replacementRanges: replacements,
    missingDubs
  }
}
