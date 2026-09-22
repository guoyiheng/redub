import { randomUUID } from 'node:crypto'
import { eq, and, ne } from 'drizzle-orm'
import { z } from 'zod'
import { db, initDb } from '../db'
import { channels } from '../db/schema'

const channelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(['volcengine', 'openai']),
  endpoint: z
    .url()
    .refine((v) => ['http:', 'https:'].includes(new URL(v).protocol), '渠道地址需为 HTTP 或 HTTPS'),
  model: z.string().trim().min(1).max(100),
  keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*_API_KEY$/, '密钥环境变量名需以 _API_KEY 结尾'),
  enabled: z.boolean(),
  pitch: z.number().int().min(-12).max(12).default(0),
  speed: z.number().int().min(-50).max(100).default(0),
  loudness: z.number().int().min(-50).max(100).default(0),
  apiKey: z.string().max(10000).optional()
})

export async function saveChannel(id: string | undefined, input: unknown) {
  await initDb()
  const { apiKey, ...data } = channelSchema.parse(input)
  const channelId = id || randomUUID()
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(channels).where(eq(channels.id, channelId))
    if (data.enabled)
      await tx
        .update(channels)
        .set({ enabled: false })
        .where(and(eq(channels.type, data.type), ne(channels.id, channelId)))
    const values = {
      ...data,
      ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : existing ? {} : { apiKey: null })
    }
    await tx
      .insert(channels)
      .values({ id: channelId, ...values })
      .onConflictDoUpdate({ target: channels.id, set: values })
  })
  return { id: channelId }
}
