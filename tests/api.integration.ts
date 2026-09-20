import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createClient } from '@libsql/client'
import { pathToFileURL } from 'node:url'
import { ffmpeg } from '../server/services/media'
import type { ProjectDetail, Job } from '../shared/types'
let server: ChildProcess,
  base: string,
  id: string,
  failTranslation = true
let voice: Buffer
const mock = createServer(async (req, res) => {
  const parts: Buffer[] = []
  for await (const part of req) parts.push(part)
  const body = JSON.parse(Buffer.concat(parts).toString())
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/v1/chat/completions') {
    if (failTranslation) {
      res.writeHead(503)
      res.end(JSON.stringify({ message: 'temporary fixture failure' }))
      return
    }
    const lines = JSON.parse(body.messages[1].content)
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                translations: lines.map((s: { id: string }) => ({ id: s.id, text: '每个故事都值得被听见。' }))
              })
            }
          }
        ]
      })
    )
  } else
    res.end(
      JSON.stringify({ audio: voice.toString('base64'), duration: 0.8, subtitle: { text: '配音测试' } })
    )
})
async function freePort() {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const address = s.address() as { port: number }
  await new Promise<void>((r) => s.close(() => r()))
  return address.port
}
async function start() {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [resolve('.output/server/index.mjs')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(port),
      REDUB_SESSION_TOKEN: '',
      REDUB_WEB_DIR: join(process.env.REDUB_DATA_DIR!, 'web')
    },
    stdio: 'pipe'
  })
  let error = ''
  server.stderr?.on('data', (d) => {
    error += d
  })
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(error)
    try {
      if ((await fetch(base + '/api/settings')).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not start: ' + error)
}
async function stop() {
  if (server && server.exitCode === null) {
    server.kill()
    await once(server, 'exit')
  }
}
async function api(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(base + '/api/' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${data.statusMessage}`)
  return data
}
async function until(check: (detail: ProjectDetail) => boolean) {
  for (let i = 0; i < 150; i++) {
    const detail = await api(`projects/${id}`)
    if (check(detail)) return detail
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('queue did not reach expected state')
}
beforeAll(async () => {
  const voicePath = join(process.env.REDUB_DATA_DIR!, 'voice.mp3')
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=550:duration=0.8', '-c:a', 'libmp3lame', voicePath])
  voice = await readFile(voicePath)
  mock.listen(0, '127.0.0.1')
  await once(mock, 'listening')
  const port = (mock.address() as { port: number }).port
  await start()
  const channels = await api('channels')
  for (const channel of channels)
    await api(`channels/${channel.id}`, 'PATCH', {
      ...channel,
      endpoint: `http://127.0.0.1:${port}${channel.type === 'openai' ? '/v1' : '/tts'}`
    })
})
afterAll(async () => {
  await stop()
  mock.closeAllConnections()
  await new Promise<void>((r) => mock.close(() => r()))
})
describe.sequential('production HTTP workflow', () => {
  it('imports text and starts once under duplicate concurrent requests', async () => {
    id = (
      await api('projects', 'POST', { name: 'HTTP integration', text: 'Every story deserves to be heard.' })
    ).id
    const responses = await Promise.all([
      fetch(`${base}/api/projects/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }),
      fetch(`${base}/api/projects/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    const detail = await until((d) => d.jobs.some((j) => j.status === 'failed'))
    expect(detail.project.paused).toBe(true)
    expect(detail.jobs).toHaveLength(4)
    expect(detail.jobs.filter((j) => j.status === 'queued')).toHaveLength(3)
    await expect(api(`segments/${detail.segments[0]!.id}`, 'PATCH', detail.segments[0])).rejects.toThrow(
      '409'
    )
  })
  it('retries failed translation and exports the complete audio workflow', async () => {
    const failed = (await api(`projects/${id}`)).jobs.find((j: Job) => j.status === 'failed')
    failTranslation = false
    await api(`jobs/${failed.id}/retry`, 'POST')
    const detail = await until((d) => d.jobs.every((j) => j.status === 'completed'))
    expect(detail.project.outputPath).toMatch(/\.mp3$/)
    expect(detail.segments[0]!.translation).toBe('每个故事都值得被听见。')
    expect(detail.jobs.find((j) => j.id === failed.id)!.attempts).toBe(2)
    const media = await fetch(`${base}/api/media?path=${encodeURIComponent(detail.project.outputPath!)}`, {
      headers: { Range: 'bytes=0-15' }
    })
    expect(media.status).toBe(206)
    expect((await media.arrayBuffer()).byteLength).toBe(16)
  })
  it('rejects cross-site access and invalid settings or file paths', async () => {
    expect(
      (await fetch(base + '/api/projects', { headers: { Origin: 'https://evil.example' } })).status
    ).toBe(403)
    expect((await fetch(base + '/api/media?path=../redub.sqlite')).status).toBe(400)
    await expect(api('settings', 'PATCH', { ...(await api('settings')), concurrency: 0 })).rejects.toThrow(
      '400'
    )
  })
  it('recovers an interrupted task on restart and can retry it', async () => {
    const detail = await api(`projects/${id}`),
      job = detail.jobs.find((j: Job) => j.stage === 'preview')
    await stop()
    const db = createClient({ url: pathToFileURL(join(process.env.REDUB_DATA_DIR!, 'redub.sqlite')).href })
    await db.execute({ sql: "UPDATE jobs SET status='running' WHERE id=?", args: [job.id] })
    db.close()
    await start()
    const restored = await api(`projects/${id}`)
    expect(restored.jobs.find((j: Job) => j.id === job.id).status).toBe('failed')
    expect(restored.project.paused).toBe(true)
    await api(`jobs/${job.id}/retry`, 'POST')
    await until((d) => d.jobs.every((j) => j.status === 'completed'))
  })
  it('serves signed web updates immediately without restarting the local API', async () => {
    const { installWebUpdate } = createRequire(import.meta.url)('../electron/web-update.cjs')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const html = Buffer.from('<h1>Verified web update</h1>')
    const payload = Buffer.from(
      JSON.stringify({
        version: '0.1.1',
        minDesktopVersion: '0.1.0',
        files: [
          {
            path: 'index.html',
            data: html.toString('base64'),
            sha256: createHash('sha256').update(html).digest('hex')
          }
        ]
      })
    )
    await installWebUpdate({
      url: 'https://example.test/web.json',
      root: join(process.env.REDUB_DATA_DIR!, 'web'),
      desktopVersion: '0.1.0',
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      fetcher: async () =>
        new Response(
          JSON.stringify({
            payload: payload.toString('base64'),
            signature: sign(null, payload, privateKey).toString('base64')
          })
        )
    })
    expect(await (await fetch(base + '/')).text()).toContain('Verified web update')
    expect((await api('projects')).some((p: { id: string }) => p.id === id)).toBe(true)
  })
})
