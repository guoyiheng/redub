import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
export default defineEventHandler(async (event) => {
  const root = process.env.REDUB_WEB_DIR
  if (!root || !['GET', 'HEAD'].includes(event.method) || event.path.startsWith('/api/')) return
  const path = getRequestURL(event).pathname
  if (path !== '/' && !path.startsWith('/_nuxt/')) return
  if (path.includes('..') || !/^\/[a-zA-Z0-9_./-]*$/.test(path)) return
  let manifest: { directory: string; previous?: string }
  try {
    manifest = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
  } catch {
    return
  }
  const directories = [manifest.directory, ...(path === '/' ? [] : [manifest.previous])].filter(
    (d) => d && /^web-[\d.]+-\d+$/.test(d)
  )
  for (const directory of directories) {
    const target = join(root, directory!, path === '/' ? 'index.html' : path.slice(1))
    const info = await stat(target).catch(() => null)
    if (!info?.isFile()) continue
    const extension = target.split('.').at(-1)!
    const mime: Record<string, string> = {
      html: 'text/html; charset=utf-8',
      js: 'text/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json',
      svg: 'image/svg+xml',
      woff2: 'font/woff2'
    }
    setHeaders(event, {
      'Content-Type': mime[extension] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    })
    if (event.method === 'HEAD') return ''
    return sendStream(event, createReadStream(target))
  }
})
