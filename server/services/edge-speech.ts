import { randomUUID, randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { jobRequests } from '../db/schema'
import { jobContext, requestCurl } from './job-requests'

const endpoint = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
// Public Edge read-aloud client token, matching the previously used edge-tts client.
const clientToken = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const xml = (text: string) =>
  text.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!
  )
const uuid = () => randomUUID().replaceAll('-', '')

/** The Edge protocol uses WebSocket frames, which are retained along with the handshake. */
export async function edgeSpeech(
  text: string,
  options: { voice: string; rate: string; pitch: string; volume: string },
  urlOverride?: string
) {
  const url = urlOverride || `${endpoint}?TrustedClientToken=${clientToken}&ConnectionId=${uuid()}`
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.5060.66 Safari/537.36 Edg/103.0.1264.44',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
  }
  const config = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
        }
      }
    }
  })
  const messages = [
    `X-Timestamp:${Date()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${config}`,
    `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${Date()}Z\r\nPath:ssml\r\n\r\n` +
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${xml(options.voice)}'><prosody pitch='${xml(options.pitch)}' rate='${xml(options.rate)}' volume='${xml(options.volume)}'>${xml(text)}</prosody></voice></speak>`
  ]
  const context = jobContext.getStore(),
    id = randomUUID(),
    startedAt = Date.now()
  if (context)
    await db.insert(jobRequests).values({
      id,
      jobId: context.id,
      attempt: context.attempt,
      label: '微软 TTS（WebSocket）',
      method: 'WEBSOCKET',
      url,
      requestHeaders: headers,
      requestBody: JSON.stringify({ messages }),
      startedAt,
      curl:
        '# 仅复现 WebSocket 握手；语音会话还需发送请求体中的 WebSocket 消息帧。\n' +
        requestCurl(
          'GET',
          url.replace(/^ws/, 'http'),
          {
            ...headers,
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': randomBytes(16).toString('base64')
          },
          null
        ).replace('curl ', 'curl --http1.1 ')
    })
  const frames: { encoding: 'utf8' | 'base64'; data: string }[] = []
  let responseStatus: number | null = null,
    responseStatusText: string | null = null
  let responseHeaders: Record<string, string> | null = null
  let failure: string | null = null
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const socket = new WebSocket(url, { headers, handshakeTimeout: 30000 })
      const audio: Buffer[] = []
      let completed = false
      const timeout = setTimeout(() => finish(new Error('微软 TTS 请求超时')), 180000)
      function finish(error?: Error) {
        if (completed) return
        completed = true
        clearTimeout(timeout)
        if (error) {
          socket.terminate()
          reject(error)
        } else {
          socket.close()
          resolve(Buffer.concat(audio))
        }
      }
      socket.on('upgrade', (response) => {
        responseStatus = response.statusCode || 101
        responseStatusText = response.statusMessage || 'Switching Protocols'
        responseHeaders = Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [
            key,
            key === 'set-cookie' ? '[已隐藏]' : String(value || '')
          ])
        )
      })
      socket.on('open', () => {
        for (const message of messages)
          socket.send(message, (error) => {
            if (error) finish(error)
          })
      })
      socket.on('message', (data, binary) => {
        const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
        frames.push({
          encoding: binary ? 'base64' : 'utf8',
          data: buffer.toString(binary ? 'base64' : 'utf8')
        })
        if (!binary) {
          if (buffer.toString('utf8').includes('Path:turn.end'))
            finish(audio.length ? undefined : new Error('微软 TTS 未返回音频'))
          return
        }
        // Binary frames start with a two-byte header length, followed by headers and audio.
        if (buffer.length < 2) return finish(new Error('微软 TTS 返回无效音频帧'))
        const headerLength = buffer.readUInt16BE(0)
        if (headerLength + 2 > buffer.length) return finish(new Error('微软 TTS 音频帧不完整'))
        if (
          buffer
            .subarray(2, headerLength + 2)
            .toString()
            .includes('Path:audio')
        )
          audio.push(buffer.subarray(headerLength + 2))
      })
      socket.on('error', (error) => finish(error))
      socket.on('close', () => finish(new Error('微软 TTS 连接提前关闭')))
      socket.on('unexpected-response', (_request, response) => {
        responseStatus = response.statusCode || null
        responseStatusText = response.statusMessage || null
        responseHeaders = Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [
            key,
            key === 'set-cookie' ? '[已隐藏]' : String(value || '')
          ])
        )
        response.on('data', (chunk) => frames.push({ encoding: 'utf8', data: chunk.toString() }))
        response.on('end', () => finish(new Error(`微软 TTS 握手失败：${responseStatus}`)))
        response.on('error', (error) => finish(error))
      })
    })
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    if (context)
      await db
        .update(jobRequests)
        .set({
          responseStatus,
          responseStatusText,
          responseHeaders,
          responseBody: JSON.stringify({ frames }),
          error: failure,
          finishedAt: Date.now(),
          durationMs: Date.now() - startedAt
        })
        .where(eq(jobRequests.id, id))
  }
}
