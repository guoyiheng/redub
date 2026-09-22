import { z } from 'zod'
import type { Segment } from './types'
import { normalizeLanguage } from './languages'

export const voiceSettingsSchema = z.object({
  synthesisMode: z.enum(['ai', 'tts']).default('ai'),
  aiSpeaker: z.string().max(160).nullable().optional(),
  aiUseReference: z.boolean().default(true),
  aiPrompt: z.string().max(3000).nullable().optional(),
  aiFormat: z.enum(['mp3', 'wav']).default('mp3'),
  aiSampleRate: z
    .union([
      z.literal(8000),
      z.literal(16000),
      z.literal(24000),
      z.literal(32000),
      z.literal(40000),
      z.literal(44100),
      z.literal(48000)
    ])
    .default(48000),
  aiPitchRate: z.number().int().min(-12).max(12).default(0),
  aiSpeechRate: z.number().int().min(-50).max(100).default(0),
  aiLoudnessRate: z.number().int().min(-50).max(100).default(0),
  ttsVoice: z.string().min(1).max(160).default('zh-CN-XiaoxiaoNeural'),
  ttsRate: z.number().int().min(-50).max(100).default(0),
  ttsPitch: z.number().int().min(-50).max(50).default(0),
  ttsVolume: z.number().int().min(-50).max(100).default(0)
})
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>
export const generationSchema = voiceSettingsSchema.extend({
  generationPrompt: z.string().trim().min(1, '请输入配音内容').max(2800).optional(),
  translation: z.string().trim().min(1, '请输入朗读文字').max(2800).optional(),
  customReferencePath: z.string().max(240).nullable().optional()
})
export type GenerationInput = z.infer<typeof generationSchema>
export function dubbedText(
  line: Pick<Segment, 'text' | 'translation' | 'generationPrompt' | 'synthesisMode' | 'subtitle'>
) {
  if (line.synthesisMode !== 'ai' || !line.generationPrompt) return line.translation || line.text
  try {
    const subtitle = JSON.parse(line.subtitle || 'null')
    if (typeof subtitle?.text === 'string' && subtitle.text.trim()) return subtitle.text.trim()
    return Array.isArray(subtitle?.sentences)
      ? subtitle.sentences
          .map((sentence: { text?: unknown }) =>
            typeof sentence?.text === 'string' ? sentence.text.trim() : ''
          )
          .filter(Boolean)
          .join(' ')
      : ''
  } catch {
    return ''
  }
}
export const speakerName = (value: string | null | undefined) => value?.trim() || '角色 1'
export const legacyReferenceVoicePrompt = '沿用原句的音色、语速和情绪，保持自然的节奏与停顿。'
export const referenceVoicePrompt =
  '严格克隆原配音的音色与说话语气，深度复刻人物的情感色彩、语调起伏与口吻风格，使生成效果与原配音听起来完全一致，保持自然的呼吸与节奏停顿。'
export const naturalVoicePrompt = '自然、清晰地朗读，保持流畅的节奏与停顿。'
export const defaultVoicePrompt = (useReference: boolean) =>
  useReference ? referenceVoicePrompt : naturalVoicePrompt
export const defaultVoiceSettings = (useReference = true) =>
  voiceSettingsSchema.parse({
    aiPrompt: defaultVoicePrompt(useReference),
    aiSpeaker: '',
    aiUseReference: useReference
  })

export const voiceLanguageInstruction = (language: string) =>
  `配音语言：${normalizeLanguage(language.trim() || '中文')}。请使用该语言朗读台词，参考音频仅用于音色、语气和情绪，不沿用参考音频的语言。`
