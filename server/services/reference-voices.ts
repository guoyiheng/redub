import { eq, desc } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createError, type H3Event } from 'h3'
import { z } from 'zod'
import { db } from '../db'
import { referenceVoices } from '../db/schema'
import { uploadReference } from './reference-upload'
import { assetPath } from './media'

export const referenceVoiceName = z.string().trim().min(1, '请输入音色名称').max(80, '音色名称最多 80 字')
export const listReferenceVoices = () =>
  db.select().from(referenceVoices).orderBy(desc(referenceVoices.createdAt))

export async function addReferenceVoice(event: H3Event) {
  const id = randomUUID()
  const uploaded = await uploadReference(event, id, true)
  const voice = { id, ...uploaded, createdAt: Date.now() }
  try {
    await db.insert(referenceVoices).values(voice)
    return voice
  } catch (error) {
    await rm(assetPath(uploaded.path), { force: true })
    throw error
  }
}

export async function renameReferenceVoice(id: string, name: unknown) {
  const [voice] = await db
    .update(referenceVoices)
    .set({ name: referenceVoiceName.parse(name) })
    .where(eq(referenceVoices.id, id))
    .returning()
  if (!voice) throw createError({ statusCode: 404, statusMessage: '参考音色不存在' })
  return voice
}

export async function validateReferencePath(path: string, projectId: string) {
  if (!/^[a-f0-9-]{36}\/reference-upload-[a-f0-9-]+\.wav$/.test(path) || !existsSync(assetPath(path)))
    throw new Error('参考音频不可用，请重新上传')
  if (path.startsWith(`${projectId}/`)) return
  const [voice] = await db
    .select({ id: referenceVoices.id })
    .from(referenceVoices)
    .where(eq(referenceVoices.path, path))
  if (!voice) throw new Error('参考音色不存在，请重新选择')
}
