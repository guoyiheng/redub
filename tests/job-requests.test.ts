import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { db, initDb } from '../server/db'
import { jobs, projects } from '../server/db/schema'
import {
  getJobDetail,
  getJobRequest,
  interruptJobRequests,
  jobContext,
  jobFetch,
  requestCurl
} from '../server/services/job-requests'
import { edgeSpeech, edgeSpeechToken } from '../server/services/edge-speech'

beforeAll(initDb)
afterEach(() => vi.unstubAllGlobals())
async function task() {
  const id = randomUUID(),
    projectId = randomUUID()
  await db
    .insert(projects)
    .values({ id: projectId, name: '请求记录', kind: 'text', createdAt: Date.now(), updatedAt: Date.now() })
  await db
    .insert(jobs)
    .values({ id, projectId, stage: 'translate', createdAt: Date.now(), updatedAt: Date.now() })
  return id
}
async function request(id: string, index = 0) {
  const detail = await getJobDetail(id)
  return getJobRequest(id, detail.requests[index]!.id)
}

describe('任务网络记录', () => {
  it('请求先落库，并发上下文不串线；保留完整大请求体及响应', async () => {
    const ids = [await task(), await task()]
    const body = JSON.stringify({
      references: [{ audio_data: 'a'.repeat(180000) }],
      text: "中文\n引号' $(不会执行)"
    })
    const secret = 'saved-channel-secret'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const id = jobContext.getStore()!.id
        const pending = await request(id)
        expect(pending.finishedAt).toBeNull()
        expect(pending.requestBody).toBe(body)
        expect(init.headers.Authorization).toBe(`Bearer ${secret}`)
        return new Response(JSON.stringify({ message: '完整响应', audio: 'b'.repeat(180000), key: secret }), {
          headers: { 'x-request-id': id, 'set-cookie': 'private-session' }
        })
      })
    )
    await Promise.all(
      ids.map((id, i) =>
        jobContext.run({ id, attempt: i + 1 }, () =>
          jobFetch(
            'https://fixture.test/translate',
            {
              method: 'POST',
              body,
              headers: { Authorization: `Bearer ${secret}` }
            },
            {
              label: '翻译',
              secrets: [secret],
              credential: { header: 'Authorization', env: 'TEST_API_KEY', prefix: 'Bearer ' }
            }
          )
        )
      )
    )
    for (const [i, id] of ids.entries()) {
      const row = await request(id)
      expect(row.attempt).toBe(i + 1)
      expect(row.responseHeaders?.['x-request-id']).toBe(id)
      expect(row.responseHeaders?.['set-cookie']).toBe('[已隐藏]')
      expect(row.responseStatus).toBe(200)
      expect(row.responseBody).toContain('b'.repeat(180000))
      expect(row.curl).toContain('${TEST_API_KEY}')
      expect(JSON.stringify(row)).not.toContain(secret)
      expect((await getJobDetail(id)).requests[0]).not.toHaveProperty('requestBody')
    }
    await expect(getJobRequest(ids[1]!, (await request(ids[0]!)).id)).rejects.toThrow('请求记录不存在')
  })

  it('同一任务重试追加记录，保留非 JSON 错误与网络失败原因', async () => {
    const id = await task()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>upstream failed</html>', { status: 502 }))
    )
    await jobContext.run({ id, attempt: 1 }, () => jobFetch('https://fixture.test', {}, { label: '第一次' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('连接超时 saved-secret')
      })
    )
    await expect(
      jobContext.run({ id, attempt: 2 }, () =>
        jobFetch('https://fixture.test', {}, { label: '第二次', secrets: ['saved-secret'] })
      )
    ).rejects.toThrow('连接超时 [已隐藏]')
    const rows = (await getJobDetail(id)).requests
    expect(rows.map((row) => row.attempt)).toEqual([1, 2])
    expect((await request(id)).responseBody).toBe('<html>upstream failed</html>')
    expect((await request(id, 1)).responseStatus).toBeNull()
    expect((await request(id, 1)).finishedAt).not.toBeNull()
  })

  it('二进制下载保持完整并标记编码', async () => {
    const id = await task(),
      bytes = Buffer.from([0, 1, 255, 64])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes))
    )
    const response = await jobContext.run({ id, attempt: 1 }, () =>
      jobFetch('https://fixture.test/audio', {}, { label: '下载音频', binary: true })
    )
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    const row = await request(id)
    expect(row.responseEncoding).toBe('base64')
    expect(Buffer.from(row.responseBody!, 'base64')).toEqual(bytes)
  })

  it('进程中断时保留未完成请求并标记中断', async () => {
    const id = await task()
    let release!: (response: Response) => void
    const waiting = new Promise<Response>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        started()
        return waiting
      })
    )
    const running = jobContext.run({ id, attempt: 1 }, () =>
      jobFetch('https://fixture.test', {}, { label: '等待响应' })
    )
    await ready
    await interruptJobRequests()
    expect((await request(id)).error).toContain('请求已中断')
    release(new Response('done'))
    await running
  })

  it('curl 能按原样发送引号、换行及长请求体，认证使用变量', async () => {
    const body = JSON.stringify({ text: "中文\n' `echo nope` $(echo nope)", audio: 'a'.repeat(180000) })
    let actual = '',
      authorization = ''
    const server = createServer(async (req, res) => {
      const parts = []
      for await (const part of req) parts.push(part)
      actual = Buffer.concat(parts).toString()
      authorization = req.headers.authorization || ''
      res.end('ok')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const port = (server.address() as { port: number }).port
      const curl = requestCurl('POST', `http://127.0.0.1:${port}`, { authorization: '[已隐藏]' }, body, {
        header: 'Authorization',
        env: 'TEST_API_KEY',
        prefix: 'Bearer '
      })
      const shell = spawn('/bin/sh', [], {
        env: { ...process.env, TEST_API_KEY: 'test-curl-key' },
        stdio: 'pipe'
      })
      shell.stdout.resume()
      shell.stderr.resume()
      shell.stdin.end(curl)
      expect((await once(shell, 'exit'))[0]).toBe(0)
      expect(actual).toBe(body)
      expect(authorization).toBe('Bearer test-curl-key')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('记录微软 TTS 握手和完整消息帧，并正确提取音频', async () => {
    const id = await task()
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const audio = Buffer.from([1, 2, 3, 255])
    let ssml = ''
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        if (!data.toString().includes('Path:ssml')) return
        ssml = data.toString()
        const header = Buffer.from('Content-Type:audio/mpeg\r\nPath:audio\r\n')
        const length = Buffer.alloc(2)
        length.writeUInt16BE(header.length)
        socket.send(Buffer.concat([length, header, audio]))
        socket.send('Path:turn.end\r\n\r\n{}')
      })
    )
    try {
      const result = await jobContext.run({ id, attempt: 1 }, () =>
        edgeSpeech(
          'A < B & C',
          { voice: 'test', rate: '+0%', pitch: '+0Hz', volume: '+0%' },
          `ws://127.0.0.1:${port}`
        )
      )
      expect(result).toEqual(audio)
      expect(ssml).toContain('A &lt; B &amp; C')
      const row = await request(id)
      expect(row.method).toBe('WEBSOCKET')
      expect(row.responseStatus).toBe(101)
      expect(new URL(row.url).searchParams.get('Sec-MS-GEC')).toMatch(/^[A-F0-9]{64}$/)
      expect(new URL(row.url).searchParams.get('Sec-MS-GEC-Version')).toBe('1-143.0.3650.75')
      expect(row.requestHeaders.Cookie).toBe('[已隐藏]')
      expect(JSON.parse(row.requestBody!).messages[1]).toBe(ssml)
      expect(JSON.parse(row.responseBody!).frames).toHaveLength(2)
      expect(row.curl).toContain('仅复现 WebSocket 握手')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('403 时按服务端时间校正签名后重试一次，失败和成功响应都保留', async () => {
    const id = await task()
    const serverTime = new Date(Date.now() + 3600000).toUTCString()
    const urls: string[] = []
    const server = createServer()
    const ws = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      urls.push(req.url!)
      if (urls.length === 1) {
        socket.end(
          `HTTP/1.1 403 Forbidden\r\nDate: ${serverTime}\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndenied`
        )
        return
      }
      ws.handleUpgrade(req, socket, head, (client) => {
        client.on('message', (data) => {
          if (!data.toString().includes('Path:ssml')) return
          const header = Buffer.from('Path:audio\r\n')
          const length = Buffer.alloc(2)
          length.writeUInt16BE(header.length)
          client.send(Buffer.concat([length, header, Buffer.from([1, 2, 3])]))
          client.send('Path:turn.end\r\n\r\n{}')
        })
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const port = (server.address() as { port: number }).port
      const audio = await jobContext.run({ id, attempt: 1 }, () =>
        edgeSpeech(
          '测试',
          {
            voice: 'zh-CN-XiaoxiaoNeural',
            rate: '+0%',
            pitch: '+0Hz',
            volume: '+0%'
          },
          `ws://127.0.0.1:${port}`
        )
      )
      expect(audio).toEqual(Buffer.from([1, 2, 3]))
      expect(urls).toHaveLength(2)
      expect(new URL(urls[1]!, 'http://localhost').searchParams.get('Sec-MS-GEC')).toBe(
        edgeSpeechToken(Date.parse(serverTime))
      )
      const first = await request(id, 0)
      const second = await request(id, 1)
      expect(first).toMatchObject({ responseStatus: 403, error: '微软 TTS 握手失败：403' })
      expect(first.responseBody).toContain('denied')
      expect(second).toMatchObject({ responseStatus: 101, error: null })
    } finally {
      ws.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('持续 403 只重试一次，不产生无限请求', async () => {
    const id = await task()
    let attempts = 0
    const server = createServer()
    server.on('upgrade', (_req, socket) => {
      attempts++
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nDate: ${new Date().toUTCString()}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const port = (server.address() as { port: number }).port
      await expect(
        jobContext.run({ id, attempt: 1 }, () =>
          edgeSpeech(
            '测试',
            {
              voice: 'zh-CN-XiaoxiaoNeural',
              rate: '+0%',
              pitch: '+0Hz',
              volume: '+0%'
            },
            `ws://127.0.0.1:${port}`
          )
        )
      ).rejects.toThrow('403')
      expect(attempts).toBe(2)
      expect((await getJobDetail(id)).requests.map((row) => row.responseStatus)).toEqual([403, 403])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
