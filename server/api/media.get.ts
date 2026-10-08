import { createReadStream } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { extname, relative, isAbsolute, resolve, basename } from 'node:path'
import { assetPath } from '../services/media'
import { dataDir } from '../db'
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const rawPath = String(query.path || '')
  let path = rawPath
  try {
    path = decodeURIComponent(rawPath)
  } catch {}
  if (
    !/^[a-f0-9-]{36}\/[\p{L}\p{N}_.\s\-()[\]+,~]+\.(mp4|mov|mkv|webm|avi|mp3|wav|m4a|flac|ogg|aac|srt)$/iu.test(
      path
    )
  )
    throw createError({ statusCode: 400, statusMessage: '无效的媒体文件' })
  let file: string | null = null
  try {
    file = await realpath(assetPath(path)).catch(() => null)
  } catch {
    file = null
  }
  const realDataDir = await realpath(dataDir).catch(() => resolve(dataDir))
  const rel = file ? relative(realDataDir, file) : null
  if (!file || !rel || rel.startsWith('..') || isAbsolute(rel))
    throw createError({ statusCode: 404, statusMessage: '媒体文件不存在' })
  const info = await stat(file)
  const types: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.srt': 'application/x-subrip'
  }
  const ext = extname(file).toLowerCase()
  setHeaders(event, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff'
  })
  if (query.download)
    setHeader(
      event,
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(basename(file))}`
    )
  if (info.size === 0) {
    setHeader(event, 'Content-Length', 0)
    setResponseStatus(event, 200)
    return ''
  }
  const range = getRequestHeader(event, 'range')
  let start = 0,
    end = info.size - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) {
      setResponseStatus(event, 416)
      setHeader(event, 'Content-Range', `bytes */${info.size}`)
      return ''
    }
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]))
    else {
      start = Number(match[1])
      if (match[2]) end = Math.min(end, Number(match[2]))
    }
    if (start > end || start >= info.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      setResponseStatus(event, 416)
      setHeader(event, 'Content-Range', `bytes */${info.size}`)
      return ''
    }
    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${start}-${end}/${info.size}`)
  }
  setHeader(event, 'Content-Length', end - start + 1)
  if (event.method === 'HEAD') {
    setResponseStatus(event, range ? 206 : 200)
    return ''
  }
  return sendStream(event, createReadStream(file, { start, end }))
})
