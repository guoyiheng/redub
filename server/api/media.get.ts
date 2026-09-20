import { createReadStream } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { extname, sep, basename } from 'node:path'
import { assetPath } from '../services/media'
import { dataDir } from '../db'
export default defineEventHandler(async event => {
  const query = getQuery(event), path = String(query.path || '')
  if (!/^[a-f0-9-]{36}\/[a-zA-Z0-9_.-]+\.(mp4|mov|mkv|webm|avi|mp3|wav|m4a|flac|ogg|aac|srt)$/i.test(path)) throw createError({ statusCode: 400, statusMessage: '无效的媒体文件' })
  const file = await realpath(assetPath(path)).catch(() => null)
  if (!file || !file.startsWith(await realpath(dataDir) + sep)) throw createError({ statusCode: 404, statusMessage: '媒体文件不存在' })
  const info = await stat(file)
  const types: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.srt': 'application/x-subrip' }
  setHeaders(event, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' })
  if (query.download) setHeader(event, 'Content-Disposition', `attachment; filename="${basename(file)}"`)
  const range = getRequestHeader(event, 'range')
  let start = 0, end = info.size - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) { setResponseStatus(event, 416); setHeader(event, 'Content-Range', `bytes */${info.size}`); return '' }
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]))
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])) }
    if (start > end || start >= info.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { setResponseStatus(event, 416); setHeader(event, 'Content-Range', `bytes */${info.size}`); return '' }
    setResponseStatus(event, 206)
    setHeader(event, 'Content-Range', `bytes ${start}-${end}/${info.size}`)
  }
  setHeader(event, 'Content-Length', end - start + 1)
  return sendStream(event, createReadStream(file, { start, end }))
})
