import { beforeAll, expect, it } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { db, initDb } from '../server/db'
import { channels } from '../server/db/schema'
import { saveChannel } from '../server/services/channels'
import { getActiveChannel, getSettings } from '../server/services/store'

beforeAll(initDb)

it('每个功能只启用一个渠道，切换后全局生效且保留旧渠道配置', async () => {
  const translation = await getActiveChannel('openai')
  const voice = await getActiveChannel('volcengine')
  const selected = await saveChannel(undefined, { ...voice, name: '新的配音渠道', apiKey: 'new-key' })
  expect((await getActiveChannel('volcengine')).id).toBe(selected.id)
  expect((await getActiveChannel('openai')).id).toBe(translation.id)
  const [previous] = await db.select().from(channels).where(eq(channels.id, voice.id))
  expect(previous).toMatchObject({ enabled: false, endpoint: voice.endpoint, model: voice.model })
  await saveChannel(voice.id, { ...voice, enabled: true, apiKey: '' })
  expect((await getActiveChannel('volcengine')).id).toBe(voice.id)
  const nextTranslation = await saveChannel(undefined, { ...translation, apiKey: 'translation-new-key' })
  expect((await getSettings()).translationChannelId).toBe(nextTranslation.id)
  const current = await getActiveChannel('openai')
  await saveChannel(current.id, { ...current, apiKey: '' })
  expect((await getActiveChannel('openai')).apiKey).toBe('translation-new-key')
  await saveChannel(current.id, { ...current, enabled: false })
  await expect(getActiveChannel('openai')).rejects.toThrow('启用翻译渠道')
  expect((await getSettings()).translationChannelId).toBe('')
  await saveChannel(translation.id, { ...translation, apiKey: '' })
})

it('非法渠道不会停用当前渠道，数据库也拒绝同功能同时启用', async () => {
  const original = await getActiveChannel('volcengine')
  await expect(saveChannel(undefined, { ...original, endpoint: 'file:///tmp/api' })).rejects.toThrow()
  expect((await getActiveChannel('volcengine')).id).toBe(original.id)
  await expect(db.insert(channels).values({ ...original, id: 'invalid-second-enabled' })).rejects.toThrow()
  expect(
    await db
      .select()
      .from(channels)
      .where(and(eq(channels.type, 'volcengine'), eq(channels.enabled, true)))
  ).toHaveLength(1)
})
