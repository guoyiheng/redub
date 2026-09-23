import { beforeAll, expect, it } from 'vitest'
import { db, initDb } from '../server/db'
import { settings } from '../server/db/schema'
import { getSettings } from '../server/services/store'
import { defaultSettings, settingsSchema } from '../shared/settings'

beforeAll(initDb)
it('旧全局并发配置不覆盖新的默认值，两类额度分别保存', async () => {
  await db.insert(settings).values({ key: 'concurrency', value: '1' })
  expect(await getSettings()).toEqual(defaultSettings())
  await db.insert(settings).values([
    { key: 'translationConcurrency', value: '12' },
    { key: 'synthesisConcurrency', value: '3' }
  ])
  const result = await getSettings()
  expect(result).toMatchObject({ translationConcurrency: 12, synthesisConcurrency: 3 })
  expect(result).not.toHaveProperty('concurrency')
})
it.each([0, -1, 1.5, 33, '5'])('拒绝非法并发数 %s', (value) => {
  expect(settingsSchema.safeParse({ translationConcurrency: value }).success).toBe(false)
  expect(settingsSchema.safeParse({ synthesisConcurrency: value }).success).toBe(false)
})

it('NSFW 默认开启且遮罩默认为 0%，音色默认与置顶字段校验正确', () => {
  const defaults = defaultSettings()
  expect(defaults.nsfwDefaultEnabled).toBe(true)
  expect(defaults.nsfwDefaultTransparency).toBe(0)
  expect(defaults.defaultTtsVoice).toBe('zh-CN-XiaoxiaoNeural')
  expect(defaults.pinnedVoices).toEqual([])

  expect(settingsSchema.safeParse({ nsfwDefaultTransparency: -1 }).success).toBe(false)
  expect(settingsSchema.safeParse({ nsfwDefaultTransparency: 101 }).success).toBe(false)
  expect(settingsSchema.safeParse({ nsfwDefaultTransparency: 50 }).success).toBe(true)
  expect(settingsSchema.safeParse({ pinnedVoices: ['voice-1', 'voice-2'] }).success).toBe(true)
})
