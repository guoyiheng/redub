import { describe, expect, it } from 'vitest'
import { aiVoices, getVoiceGender } from '../shared/ai-voices'

describe('火山方舟 AI 音色目录与性别分类', () => {
  it('所有音色均具备明确的性别属性 (female 或 male)', () => {
    expect(aiVoices.length).toBeGreaterThan(0)
    for (const voice of aiVoices) {
      expect(voice.gender).toBeDefined()
      expect(['female', 'male']).toContain(voice.gender)
    }
  })

  it('音色性别与 ID 中的标记完全一致', () => {
    for (const voice of aiVoices) {
      if (voice.value.includes('_female_')) {
        expect(voice.gender).toBe('female')
      } else if (voice.value.includes('_male_')) {
        expect(voice.gender).toBe('male')
      }
    }
  })

  it('女声与男声音色总数符合已知分布且无未知音色', () => {
    const females = aiVoices.filter((v) => v.gender === 'female')
    const males = aiVoices.filter((v) => v.gender === 'male')

    expect(females.length).toBe(188)
    expect(males.length).toBe(257)
    expect(females.length + males.length).toBe(aiVoices.length)
  })

  it('getVoiceGender 辅助函数正确识别输入音色 ID', () => {
    expect(getVoiceGender('zh_female_vv_uranus_bigtts')).toBe('female')
    expect(getVoiceGender('zh_male_m191_uranus_bigtts')).toBe('male')
    expect(getVoiceGender('en_female_dacey_uranus_bigtts')).toBe('female')
    expect(getVoiceGender('en_male_tim_uranus_bigtts')).toBe('male')
    expect(getVoiceGender('unknown_voice_id')).toBeUndefined()
  })
})
