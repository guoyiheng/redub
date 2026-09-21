import { z } from 'zod'

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
export const referenceVoicePrompt = '沿用原句的音色、语速和情绪，保持自然的节奏与停顿。'
export const naturalVoicePrompt = '自然、清晰地朗读，保持流畅的节奏与停顿。'
export const defaultVoicePrompt = (useReference: boolean) =>
  useReference ? referenceVoicePrompt : naturalVoicePrompt
export const defaultVoiceSettings = (useReference = true) =>
  voiceSettingsSchema.parse({
    aiPrompt: defaultVoicePrompt(useReference),
    aiSpeaker: '',
    aiUseReference: useReference
  })
