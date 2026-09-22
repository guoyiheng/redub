import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join, extname } from 'node:path'
import { getProject, getSegments } from './store'
import { exportSubtitles } from './subtitles'
import { assetPath, ffmpeg, projectDir, probe } from './media'
import { getPreviewTracks } from './preview-tracks'
import {
  exportSchema,
  selectedTrackKeys,
  type ExportOptions,
  type ExportResult,
  type ExportTrackKey
} from '../../shared/export'
import type { PreviewTracks, PreviewTrack } from '../../shared/preview'

const activeExports = new Map<string, Promise<ExportResult>>()

function safeStem(value: string) {
  return (
    value
      .trim()
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 80) || 'redub-export'
  )
}

export function exportSourcePath(path: string | null | undefined) {
  if (
    !path ||
    !/^[a-f0-9-]{36}\/[a-zA-Z0-9_.-]+\.(wav|mp3|m4a|flac|ogg|aac|mp4|mov|mkv|webm|avi)$/i.test(path)
  )
    throw new Error('导出文件路径无效')
  const file = assetPath(path)
  if (!existsSync(file)) throw new Error('导出所需的音轨尚未生成')
  return file
}

function selectTrack(tracks: PreviewTracks, key: ExportTrackKey, options: ExportOptions): PreviewTrack {
  const track = tracks.tracks[key]
  if (!track?.path) throw new Error(`所选音轨「${track?.label || key}」尚未准备好`)
  if (key === 'original' && options.originalMode === 'preserve-gaps') {
    if (!track.alternatePath) throw new Error('原声静音版本尚未准备好，请先生成所有已启用片段的配音')
    exportSourcePath(track.alternatePath)
    return { ...track, path: track.alternatePath }
  }
  exportSourcePath(track.path)
  return track
}

export function exportKey(options: ExportOptions, revision: string) {
  return createHash('sha256')
    .update(`multitrack-v1:${revision}:${JSON.stringify(options)}`)
    .digest('hex')
    .slice(0, 16)
}

/** Export audio, or append it to the unchanged streams in the source container. */
export async function exportProject(projectId: string, input: unknown): Promise<ExportResult> {
  const options = exportSchema.parse(input)
  const requestKey = `${projectId}:${JSON.stringify(options)}`
  const previous = activeExports.get(requestKey)
  if (previous) return previous
  const promise = exportProjectInternal(projectId, options).finally(() => {
    activeExports.delete(requestKey)
  })
  activeExports.set(requestKey, promise)
  return promise
}

async function exportProjectInternal(projectId: string, options: ExportOptions): Promise<ExportResult> {
  const project = await getProject(projectId)
  const tracks = await getPreviewTracks(projectId)
  const selected = selectedTrackKeys(options)
  if (!selected.length) throw new Error('至少选择一条音轨')
  if (selected.includes('optimized') && selected.length > 1)
    throw new Error('“优化合成”已经包含完整成片音轨，不能与其他音轨重复合并')
  if (options.target === 'video' && project.kind !== 'video') throw new Error('当前项目没有可导出的视频')
  const source = options.target === 'video' ? exportSourcePath(project.sourcePath) : null
  const extension = source ? extname(source).slice(1).toLowerCase() : 'wav'
  if (source && !['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(extension))
    throw new Error('当前视频格式无法追加音轨')

  const chosen = selected.map((key) => ({ key, track: selectTrack(tracks, key, options) }))
  const revision = tracks.revision || 'current'
  const subtitle = exportSubtitles(await getSegments(projectId), project.kind, options)
  // Subtitle edits must create a new matching media/SRT pair, even if audio is unchanged.
  const sourceInfo = source ? await stat(source) : null
  const key = exportKey(
    options,
    `${revision}:${subtitle}:${source}:${sourceInfo?.size}:${sourceInfo?.mtimeMs}`
  )
  const filename = `${safeStem(project.name)}-${key}.${extension}`
  const relative = `${project.id}/${filename}`
  const output = assetPath(relative)
  const srtFilename = `${safeStem(project.name)}-${key}.srt`
  const srtRelative = `${project.id}/${srtFilename}`
  const srtOutput = assetPath(srtRelative)
  const ensureSubtitle = async () => {
    if (!subtitle) return {}
    const temporarySubtitle = `${srtOutput}.partial`
    try {
      await writeFile(temporarySubtitle, subtitle, 'utf-8')
      await rename(temporarySubtitle, srtOutput)
    } finally {
      await rm(temporarySubtitle, { force: true })
    }
    return { subtitlePath: srtRelative, subtitleFilename: srtFilename }
  }

  if (existsSync(output)) {
    const sub = await ensureSubtitle()
    return { path: relative, filename, ...sub }
  }
  const dir = await projectDir(project.id)
  const temporary = join(dir, `.${safeStem(project.name)}-${key}.${process.pid}.partial.${extension}`)
  const args: string[] = []
  if (source) args.push('-i', source)
  for (const item of chosen) args.push('-i', exportSourcePath(item.track.path))
  const labels = chosen.map((_, index) => `[${index + (source ? 1 : 0)}:a:0]`)
  const filter = `${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.98:latency=1,aresample=48000[mix]`
  args.push('-filter_complex', filter)
  // Chapter data tracks are rebuilt from map_chapters; copying them as data can break MOV muxing.
  if (source) args.push('-map', '0', '-map', '-0:d')
  args.push('-map', '[mix]')
  if (source) {
    const audioIndex = (await probe(source)).audioStreams
    const codec =
      extension === 'mkv'
        ? 'flac'
        : extension === 'webm'
          ? 'libopus'
          : extension === 'avi'
            ? 'libmp3lame'
            : 'aac'
    args.push('-c', 'copy', `-c:a:${audioIndex}`, codec)
    if (codec !== 'flac') args.push(`-b:a:${audioIndex}`, codec === 'libopus' ? '192k' : '320k')
    args.push(
      '-map_metadata',
      '0',
      '-map_chapters',
      '0',
      `-metadata:s:a:${audioIndex}`,
      `title=ReDub · ${chosen.map(({ track }) => track.label).join(' + ')}`,
      `-metadata:s:a:${audioIndex}`,
      'handler_name=ReDub',
      `-disposition:a:${audioIndex}`,
      '0'
    )
    if (extension === 'mp4' || extension === 'mov') args.push('-movflags', '+faststart')
  } else {
    args.push('-c:a', 'pcm_s16le')
  }
  args.push(temporary)
  try {
    await ffmpeg(args)
    // Rename only after ffmpeg closes, so an interrupted export never looks complete.
    await rename(temporary, output)
    const sub = await ensureSubtitle()
    return { path: relative, filename, ...sub }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export function exportFilename(path: string) {
  return basename(path)
}
