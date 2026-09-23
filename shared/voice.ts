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

export const ttsVoices = [
  { label: '晓晓 · 中文女声', value: 'zh-CN-XiaoxiaoNeural', lang: '中文' },
  { label: '云希 · 中文男声', value: 'zh-CN-YunxiNeural', lang: '中文' },
  { label: '晓伊 · 中文女声', value: 'zh-CN-XiaoyiNeural', lang: '中文' },
  { label: '云健 · 中文男声', value: 'zh-CN-YunjianNeural', lang: '中文' },
  { label: 'Jenny · 英语女声', value: 'en-US-JennyNeural', lang: '英语' },
  { label: 'Guy · 英语男声', value: 'en-US-GuyNeural', lang: '英语' },
  { label: 'Nanami · 日语女声', value: 'ja-JP-NanamiNeural', lang: '日语' },
  { label: 'SunHi · 韩语女声', value: 'ko-KR-SunHiNeural', lang: '韩语' },
  { label: 'Elvira · 西班牙语', value: 'es-ES-ElviraNeural', lang: '西班牙语' },
  { label: 'Denise · 法语', value: 'fr-FR-DeniseNeural', lang: '法语' },
  { label: 'Katja · 德语', value: 'de-DE-KatjaNeural', lang: '德语' },
  { label: 'Elsa · 意大利语', value: 'it-IT-ElsaNeural', lang: '意大利语' },
  { label: 'Svetlana · 俄语', value: 'ru-RU-SvetlanaNeural', lang: '俄语' }
]
export const generationSchema = voiceSettingsSchema.extend({
  generationPrompt: z.string().trim().min(1, '请输入配音内容').max(2800).optional(),
  translation: z.string().trim().min(1, '请输入配音台词').max(2800).optional(),
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
  '严格克隆原配音的音色与说话语气，深度复刻人物的情感色彩、语调起伏与口吻风格，使生成效果与原配音听起来完全一致；同时准确还原重音、呼吸、停顿和说话节奏，避免机械朗读或过度夸张。'
export const naturalVoicePrompt =
  '自然、清晰、有画面感地配音，根据剧情语境控制情绪、重音、语速、音调、音量和停顿，保持流畅真实。'
export const defaultVoicePrompt = (useReference: boolean) =>
  useReference ? referenceVoicePrompt : naturalVoicePrompt
export const defaultVoiceSettings = (useReference = true) =>
  voiceSettingsSchema.parse({
    aiPrompt: defaultVoicePrompt(useReference),
    aiSpeaker: '',
    aiUseReference: useReference
  })

export type VoiceContextLine = Pick<Segment, 'id' | 'speaker' | 'text' | 'translation' | 'start' | 'end'>

/** 文档约定：[#指令] 中的内容不合成，方括号外仅保留要朗读的台词。 */
function directive(content: string) {
  return `[#${content.replace(/\[/g, '（').replace(/\]/g, '）').trim()}]`
}

export const voiceLanguageInstruction = (language: string) => {
  const lang = normalizeLanguage(language.trim() || '中文')
  return `配音语言：${lang}。用${lang}配音，不翻译或切换语言。`
}

export function stripVoiceLanguageInstruction(prompt: string) {
  // 兼容旧版放在方括号外的完整语言说明行。
  const content = prompt
    .trim()
    .replace(/^配音语言：[^\r\n]*(?:\r?\n|$)/, '')
    .trim()
  // 只更新第一个指令块中的语言，不修改台词或引用上文的内容。
  return content.replace(
    /^\[#([^\]]*)\]/,
    (_, instruction: string) =>
      `[#${instruction.replace(/配音语言：[^。\r\n]+。用[^。\r\n]+配音，不翻译或切换语言。/g, '')}]`
  )
}

export function withVoiceLanguage(prompt: string, language: string) {
  const content = stripVoiceLanguageInstruction(prompt)
  const instruction = voiceLanguageInstruction(language)
  if (content.startsWith('[#')) {
    return content.replace(/^\[#([^\]]*)\]/, (_, first: string) => directive(`${instruction}${first.trim()}`))
  }
  return `${directive(instruction)}${content}`
}

export function composeVoicePrompt(options: {
  language?: string
  direction?: string | null
  useReference?: boolean
  tone?: string | null
  text: string
}) {
  const language = options.language || '中文'
  const direction = stripVoiceLanguageInstruction(options.direction?.trim() || '').replace(
    /\[#([^\]]*)\]/g,
    '$1'
  )
  const instruction = [
    direction || defaultVoicePrompt(options.useReference ?? true),
    options.tone?.trim() ? `用${options.tone.trim()}的语气说。` : ''
  ]
    .filter(Boolean)
    .join('；')
  return withVoiceLanguage(`${directive(instruction)}${options.text.trim()}`, language)
}

/** 将已保存的旧格式转为文档格式；新格式保留原有指令、上文和台词。 */
export function normalizeVoicePrompt(input: string, language: string, fallbackText = '') {
  const content = stripVoiceLanguageInstruction(input)
  if (content.includes('[#')) return withVoiceLanguage(content, language)

  const requirement = content.match(/【(?:配音要求|配音指导|要求)】[：:]\s*([\s\S]*?)(?=\n?【|$)/)
  const tone = content.match(/【(?:角色语气|语气情绪|语气)】[：:]\s*([\s\S]*?)(?=\n?【|$)/)
  const line = content.match(/【(?:配音台词|台词|内容)】[：:]\s*([\s\S]*)$/)
  if (requirement || tone || line) {
    return composeVoicePrompt({
      language,
      direction: requirement?.[1]?.trim(),
      tone: tone?.[1]?.trim(),
      text: unwrapQuotation(line?.[1]?.trim() || fallbackText)
    })
  }

  // 兼容单字段旧输入，例如“用轻松的语气说：「你好。」”。
  const quoted = content.match(/^([\s\S]*?(?:说|朗读|配音|念)[：:]\s*)([「“"])([\s\S]*)([」”"])$/)
  if (quoted) {
    return withVoiceLanguage(`${directive(quoted[1]!.replace(/[：:]\s*$/, ''))}${quoted[3]}`, language)
  }
  return withVoiceLanguage(content || fallbackText, language)
}

function unwrapQuotation(text: string) {
  const pairs: Record<string, string> = { '「': '」', '“': '”', '"': '"' }
  return pairs[text[0]!] === text.at(-1) ? text.slice(1, -1) : text
}

export function buildVoiceSynthesisPrompt(options: {
  prompt?: string
  instruction?: string | null
  language: string
  text: string
  duration: number
  hasAudioReference?: boolean
  hasVoiceReference?: boolean
  context?: VoiceContextLine[]
}) {
  const prompt = options.prompt?.trim()
    ? normalizeVoicePrompt(options.prompt, options.language, options.text)
    : composeVoicePrompt({
        language: options.language,
        direction: options.instruction,
        useReference: options.hasAudioReference ?? false,
        text: options.text
      })
  const speech = prompt.replace(/\[#[^\]]*\]/g, '').trim()
  if (speech.includes('[#')) throw new Error('语音指令格式不完整，请使用 [#指令]台词')
  if (!speech) throw new Error('请输入配音台词')

  const reference = options.hasAudioReference
    ? '参考@音频1的音色、语气和节奏，不朗读参考音频的文字，不沿用参考音频的语言。'
    : options.hasVoiceReference
      ? '保持所选音色，根据指令和台词自然表演。'
      : ''
  const timing = `以自然表达为先，尽量在${options.duration.toFixed(2)}秒内说完。`
  // 已有多个前置指令块时，保留用户填写的引用上文，不再重复添加。
  const hasQuotedContext = /^\[#[^\]]*\]\s*\[#/.test(prompt)
  const context = hasQuotedContext
    ? ''
    : (options.context || [])
        .map((line) => (line.translation || line.text).trim())
        .filter(Boolean)
        .slice(-3)
        .join('\n')
  return prompt.replace(/^\[#([^\]]*)\]/, (_, instruction: string) =>
    [directive(`${instruction}；${reference}${timing}`), context ? directive(context) : ''].join('')
  )
}
