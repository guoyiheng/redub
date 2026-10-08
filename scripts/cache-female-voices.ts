import { db, initDb } from '../server/db'
import { channels } from '../server/db/schema'
import {
  computeVolcenginePreviewKey,
  getPreviewCache,
  savePreviewCache
} from '../server/services/preview-cache'
import { aiVoices } from '../shared/ai-voices'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchVoicePreview(
  channel: { endpoint: string; model: string; keyEnv: string; apiKey?: string | null },
  speaker: string,
  prompt: string
): Promise<Buffer> {
  const apiKey = channel.apiKey || process.env[channel.keyEnv]
  if (!apiKey) {
    throw new Error(`请先为火山方舟配音配置 API Key（或配置 ${channel.keyEnv} 环境变量）`)
  }

  // 部分复杂/冷门角色音色首次生成耗时可达 30~35 秒，设置 50 秒超时以确保顺利完成
  const res = await fetch(channel.endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(50000),
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Request-Id': randomUUID()
    },
    body: JSON.stringify({
      model: channel.model,
      text_prompt: prompt,
      references: [{ speaker }],
      audio_config: { format: 'mp3', sample_rate: 24000 },
      watermark: {}
    })
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    const err = new Error(`HTTP ${res.status}: ${errText.slice(0, 150)}`)
    ;(err as any).status = res.status
    ;(err as any).isConcurrency = errText.includes('concurrency') || res.status === 429
    throw err
  }

  const result = (await res.json()) as any
  if (result.code && ![0, 20000000].includes(result.code)) {
    throw new Error(`火山方舟错误: ${result.message || result.code}`)
  }

  let buf: Buffer | null = null
  if (typeof result.audio === 'string' && result.audio.length) {
    buf = Buffer.from(result.audio, 'base64')
  } else if (typeof result.url === 'string' && result.url.startsWith('https://')) {
    const audioRes = await fetch(result.url)
    buf = Buffer.from(await audioRes.arrayBuffer())
  }

  if (!buf) {
    throw new Error('未返回有效音频内容')
  }

  return buf
}

export async function cacheFemaleChineseVoices(options: { concurrency?: number } = {}) {
  await initDb()
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.type, 'volcengine'), eq(channels.enabled, true)))

  if (!channel) {
    throw new Error('未找到已启用的火山方舟 (volcengine) 配音渠道')
  }

  const sampleText = '你好，这是火山方舟语音的声音试听效果。'
  const prompt = `用中文配音，保持自然生动的影视口语。\n【当前台词】\n「${sampleText}」`

  const targetVoices = aiVoices.filter((v) => v.gender === 'female' && v.language.includes('中文'))
  console.log(`目标音色总数: ${targetVoices.length} (火山方舟 · 女声 · 中文)`)

  const concurrency = options.concurrency || 1
  console.log(`拉取并发度: ${concurrency}`)

  let cachedCount = 0
  let fetchedCount = 0
  let failedCount = 0
  const failedVoices: { speaker: string; label: string; error: string }[] = []

  let index = 0

  async function worker() {
    while (true) {
      const currentIndex = index++
      if (currentIndex >= targetVoices.length) break

      const voice = targetVoices[currentIndex]!
      const progressPrefix = `[${currentIndex + 1}/${targetVoices.length}]`
      const cacheKey = computeVolcenginePreviewKey(channel, voice.value, prompt)

      // 1. 检查本地是否已经缓存
      const existing = await getPreviewCache(cacheKey)
      if (existing) {
        cachedCount++
        console.log(`${progressPrefix} [已存在] ${voice.label} (${voice.value})`)
        continue
      }

      // 2. 带指数避让重试
      let success = false
      const maxAttempts = 3
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          console.log(`${progressPrefix} [开始拉取] ${voice.label}...`)
          const startTime = Date.now()
          const buf = await fetchVoicePreview(channel, voice.value, prompt)
          const duration = ((Date.now() - startTime) / 1000).toFixed(1)
          await savePreviewCache(cacheKey, buf)
          fetchedCount++
          success = true
          console.log(`${progressPrefix} [成功入库] ${voice.label} (${buf.length} 字节, 耗时 ${duration}s)`)
          break
        } catch (err: any) {
          const isConcurrency = err.isConcurrency || err.message?.includes('concurrency')
          const waitMs = isConcurrency ? 3000 * attempt : 1500 * attempt
          console.warn(
            `${progressPrefix} [警告] ${voice.label} 第 ${attempt} 次失败: ${err.message}，等待 ${(waitMs / 1000).toFixed(1)}s 后重试`
          )
          if (attempt < maxAttempts) {
            await sleep(waitMs)
          } else {
            failedCount++
            failedVoices.push({ speaker: voice.value, label: voice.label, error: err.message })
          }
        }
      }

      await sleep(300)
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)

  console.log('\n========================================')
  console.log('火山方舟女声中文试听缓存完成！统计报告：')
  console.log(`- 目标音色: ${targetVoices.length}`)
  console.log(`- 本地命中: ${cachedCount}`)
  console.log(`- 新拉取并保存: ${fetchedCount}`)
  console.log(`- 失败数: ${failedCount}`)
  if (failedVoices.length > 0) {
    console.log('失败列表:', failedVoices)
  }
  console.log('========================================\n')

  return {
    total: targetVoices.length,
    cached: cachedCount,
    fetched: fetchedCount,
    failed: failedCount,
    failedVoices
  }
}

if (process.argv[1]?.endsWith('cache-female-voices.ts')) {
  cacheFemaleChineseVoices()
    .then((res) => {
      if (res.failed > 0) {
        console.warn(`拉取结束，其中 ${res.failed} 个失败。`)
      }
      process.exit(0)
    })
    .catch((err) => {
      console.error('运行异常:', err)
      process.exit(1)
    })
}
