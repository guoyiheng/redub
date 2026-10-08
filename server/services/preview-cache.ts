import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '../db'
import type { Channel } from '../../shared/types'

const cacheDir = join(dataDir, 'tts-previews')
let cacheDirReady: Promise<void> | null = null

async function ensureCacheDir() {
  if (!cacheDirReady) {
    cacheDirReady = mkdir(cacheDir, { recursive: true }).then(() => undefined)
  }
  await cacheDirReady
}

export function computeVolcenginePreviewKey(
  channel: Pick<Channel, 'endpoint' | 'model'>,
  speaker: string,
  prompt: string
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: 'volcengine',
        endpoint: channel.endpoint,
        model: channel.model,
        speaker,
        prompt
      })
    )
    .digest('hex')
}

export function computeEdgePreviewKey(
  voice: string,
  text: string,
  options: { rate?: string | null; pitch?: string | null; volume?: string | null }
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: 'edge',
        voice,
        text,
        rate: options.rate ?? '0%',
        pitch: options.pitch ?? '0Hz',
        volume: options.volume ?? '0%'
      })
    )
    .digest('hex')
}

export async function getPreviewCache(key: string): Promise<Buffer | null> {
  const filePath = join(cacheDir, `${key}.mp3`)
  if (!existsSync(filePath)) return null
  try {
    return await readFile(filePath)
  } catch {
    return null
  }
}

export async function savePreviewCache(key: string, data: Buffer): Promise<void> {
  await ensureCacheDir()
  const filePath = join(cacheDir, `${key}.mp3`)
  await writeFile(filePath, data)
}
