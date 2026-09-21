import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getProject } from './store'
import { assetPath, ffmpeg, projectDir } from './media'
import { getPreviewTracks } from './preview-tracks'
import { exportSchema, selectedTrackKeys, type ExportOptions, type ExportResult } from '../../shared/export'
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
  if (!path || !/^[a-f0-9-]{36}\/[a-zA-Z0-9_.-]+\.(wav|mp3|m4a|flac|ogg|aac|mp4|mov|mkv|webm)$/i.test(path))
    throw new Error('导出文件路径无效')
  const file = assetPath(path)
  if (!existsSync(file)) throw new Error('导出所需的音轨尚未生成')
  return file
}

function selectTrack(
  tracks: PreviewTracks,
  key: 'original' | 'background' | 'dubbed',
  options: ExportOptions
): PreviewTrack {
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
    .update(`${revision}:${JSON.stringify(options)}`)
    .digest('hex')
    .slice(0, 16)
}

/** Mix selected preview tracks while stream-copying the original video stream. */
export async function exportProject(projectId: string, input: unknown): Promise<ExportResult> {
  const options = exportSchema.parse(input)
  const previous = activeExports.get(projectId)
  if (previous) return previous
  const promise = exportProjectInternal(projectId, options).finally(() => {
    activeExports.delete(projectId)
  })
  activeExports.set(projectId, promise)
  return promise
}

async function exportProjectInternal(projectId: string, options: ExportOptions): Promise<ExportResult> {
  const project = await getProject(projectId)
  const tracks = await getPreviewTracks(projectId)
  const selected = selectedTrackKeys(options)
  if (!selected.length) throw new Error('至少选择一条音轨')
  if (options.dubbed && tracks.missingDubs > 0)
    throw new Error(`还有 ${tracks.missingDubs} 句配音未生成，暂时不能导出配音音轨`)
  if (project.kind === 'video' && !['mkv', 'mp4'].includes(options.format))
    throw new Error('视频成片请选择 MKV 或 MP4 格式')
  if (project.kind !== 'video' && options.format !== 'wav') throw new Error('音频项目请选择 WAV 格式')

  const chosen = selected.map((key) => ({ key, track: selectTrack(tracks, key, options) }))
  const revision = tracks.revision || 'current'
  const key = exportKey(options, revision)
  const extension = options.format
  const filename = `${safeStem(project.name)}-${key}.${extension}`
  const relative = `${project.id}/${filename}`
  const output = assetPath(relative)
  if (existsSync(output)) return { path: relative, filename }
  const dir = await projectDir(project.id)
  const temporary = join(dir, `.${safeStem(project.name)}-${key}.${process.pid}.partial.${extension}`)
  const source = project.kind === 'video' ? exportSourcePath(project.sourcePath) : null
  const args: string[] = []
  if (source) args.push('-i', source)
  for (const item of chosen) args.push('-i', exportSourcePath(item.track.path))
  const labels = chosen.map((_, index) => `[${index + (source ? 1 : 0)}:a:0]`)
  const filter = `${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.98:latency=1,aresample=48000[mix]`
  args.push('-filter_complex', filter)
  if (source) args.push('-map', '0:v:0')
  args.push('-map', '[mix]')
  if (source) {
    args.push('-c:v', 'copy', '-t', String(project.duration))
    if (options.format === 'mkv') args.push('-c:a', 'flac')
    else args.push('-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart')
  } else {
    args.push('-c:a', 'pcm_s16le')
  }
  args.push(temporary)
  try {
    await ffmpeg(args)
    // Rename only after ffmpeg closes, so an interrupted export never looks complete.
    const { rename } = await import('node:fs/promises')
    await rename(temporary, output)
  } catch (error) {
    const { rm } = await import('node:fs/promises')
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return { path: relative, filename }
}

export function exportFilename(path: string) {
  return basename(path)
}
