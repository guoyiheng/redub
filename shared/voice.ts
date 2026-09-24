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

export interface VoiceContextSelection {
  previous?: VoiceContextLine[]
  next?: VoiceContextLine[]
}

export interface VoicePromptParts {
  instruction: string
  previous: string
  next: string
  text: string
}

const promptLabels = {
  instruction: '指令',
  previous: '引用上文',
  next: '引用下文',
  text: '合成文本'
} as const

/** 文档约定：[#指令] 中的内容不合成，方括号外仅保留要朗读的台词。 */
function directive(content: string) {
  return `[#${content.replace(/\[/g, '（').replace(/\]/g, '）').trim()}]`
}

function unwrapDirective(content: string) {
  const value = content.trim()
  const match = value.match(/^\[#([\s\S]*)\]$/)
  return (match?.[1] || value).trim()
}

function extractDirectives(content: string) {
  const values = [...content.matchAll(/\[#([\s\S]*?)\]/g)].map((match) => match[1]!.trim())
  return values.length ? values.join('\n') : unwrapDirective(content)
}

export function formatVoicePrompt(parts: VoicePromptParts) {
  const sections: string[] = []
  if (parts.instruction.trim())
    sections.push(`*${promptLabels.instruction}：* ${directive(parts.instruction)}`)
  if (parts.previous.trim()) sections.push(`*${promptLabels.previous}：* ${directive(parts.previous)}`)
  if (parts.next.trim()) sections.push(`*${promptLabels.next}：* ${directive(parts.next)}`)
  sections.push(`*${promptLabels.text}：* ${parts.text.trim()}`)
  return sections.join('\n')
}

function parseLabeledPrompt(input: string): VoicePromptParts | null {
  const label = '(?:指令|引用上文|引用下文|合成文本)'
  const separator = String.raw`\s*(?:\*\s*)?(?:[：:]\s*)?(?:\*\s*)?`
  const pattern = new RegExp(
    `(?:^|\\n)\\s*\\*?\\s*(${label})${separator}([\\s\\S]*?)(?=\\n\\s*\\*?\\s*${label}${separator}|$)`,
    'g'
  )
  const parts: VoicePromptParts = { instruction: '', previous: '', next: '', text: '' }
  let found = false
  for (const match of input.matchAll(pattern)) {
    found = true
    const key = match[1]!
    const value = match[2]!.trim()
    if (key === '指令') parts.instruction = extractDirectives(value)
    else if (key === '引用上文') parts.previous = extractDirectives(value)
    else if (key === '引用下文') parts.next = extractDirectives(value)
    else parts.text = unwrapDirective(value).trim()
  }
  return found ? parts : null
}

function parseLegacySections(input: string): VoicePromptParts | null {
  const requirement = input.match(/【(?:配音要求|配音指导|要求)】[：:]\s*([\s\S]*?)(?=\n?【|$)/)
  const tone = input.match(/【(?:角色语气|语气情绪|语气)】[：:]\s*([\s\S]*?)(?=\n?【|$)/)
  const line = input.match(/【(?:配音台词|台词|内容)】[：:]\s*([\s\S]*)$/)
  if (!requirement && !tone && !line) return null
  return {
    instruction: [requirement?.[1], tone?.[1] ? `台词情绪与语气：${tone[1].trim()}。` : '']
      .filter(Boolean)
      .join('；'),
    previous: '',
    next: '',
    text: unwrapDirective(line?.[1]?.trim() || '')
      .replace(/^[「“"]|[\s」”"]+$/g, '')
      .trim()
  }
}

function parseBareDirectives(input: string): VoicePromptParts | null {
  const match = input.match(/^((?:\[#[^\]]*\]\s*)+)([\s\S]*)$/)
  if (!match) return null
  const directives = [...match[1]!.matchAll(/\[#([^\]]*)\]/g)].map((item) => item[1]!.trim())
  const text = match[2]!.trim()
  if (!directives.length) return null
  return {
    instruction: directives[0]!,
    previous: directives.slice(1).join('\n'),
    next: '',
    text
  }
}

function parseQuotedPrompt(input: string): VoicePromptParts | null {
  const match = input.match(/^([\s\S]*?(?:说|朗读|配音|念)[：:]\s*)([「“"])([\s\S]*)([」”"])$/)
  if (!match) return null
  return {
    instruction: match[1]!.replace(/[：:]\s*$/, '').trim(),
    previous: '',
    next: '',
    text: match[3]!.trim()
  }
}

function parseVoicePrompt(input: string, fallbackText = ''): VoicePromptParts {
  const content = input.trim()
  const parsed =
    (content ? parseLabeledPrompt(content) : null) ||
    (content ? parseLegacySections(content) : null) ||
    (content ? parseBareDirectives(content) : null) ||
    (content ? parseQuotedPrompt(content) : null)
  if (parsed) return parsed
  return {
    instruction: '',
    previous: '',
    next: '',
    text: content || fallbackText.trim()
  }
}

export const voiceLanguageInstruction = (language: string) => {
  const lang = normalizeLanguage(language.trim() || '中文')
  return `配音语言：${lang}。用${lang}配音，不翻译或切换语言。`
}

function removeLanguageInstruction(instruction: string) {
  return instruction
    .replace(/配音语言：[^。\r\n]+。用[^。\r\n]+配音，不翻译或切换语言。?/g, '')
    .replace(/^[；;，,\s]+|[；;，,\s]+$/g, '')
    .trim()
}

export function stripVoiceLanguageInstruction(prompt: string) {
  const parts = parseVoicePrompt(prompt)
  parts.instruction = removeLanguageInstruction(parts.instruction)
  return formatVoicePrompt(parts)
}

export function withVoiceLanguage(prompt: string, language: string) {
  const parts = parseVoicePrompt(prompt)
  const direction = removeLanguageInstruction(parts.instruction)
  parts.instruction = [voiceLanguageInstruction(language), direction].filter(Boolean).join('；')
  return formatVoicePrompt(parts)
}

function contextText(line: VoiceContextLine) {
  return (line.translation || line.text).trim()
}

export function selectVoiceContextLines(
  current: VoiceContextLine,
  lines: VoiceContextLine[],
  options: { maxPrevious?: number; maxNext?: number; maxGapSeconds?: number } = {}
): VoiceContextSelection {
  const maxPrevious = options.maxPrevious ?? 3
  const maxNext = options.maxNext ?? 2
  const maxGap = options.maxGapSeconds ?? 8
  const ordered = [...lines].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id))
  const index = ordered.findIndex(
    (line) =>
      line.id === current.id ||
      (line.start === current.start && line.end === current.end && line.speaker === current.speaker)
  )
  if (index < 0) return {}

  const previous: VoiceContextLine[] = []
  for (let i = index - 1; i >= 0 && previous.length < maxPrevious; i--) {
    const line = ordered[i]!
    const next = ordered[i + 1]!
    const gap = Math.max(0, next.start - line.end)
    if (gap > maxGap) break
    if (contextText(line)) previous.unshift(line)
  }

  const next: VoiceContextLine[] = []
  for (let i = index + 1; i < ordered.length && next.length < maxNext; i++) {
    const line = ordered[i]!
    const previousLine = ordered[i - 1]!
    const gap = Math.max(0, line.start - previousLine.end)
    if (gap > maxGap) break
    if (contextText(line)) next.push(line)
  }
  return { previous, next }
}

function contextFromInput(context?: VoiceContextSelection | VoiceContextLine[]) {
  if (!context) return {}
  if (Array.isArray(context)) return { previous: context, next: [] }
  return context
}

function contextBlock(lines: VoiceContextLine[] | undefined) {
  return (lines || []).map(contextText).filter(Boolean).join('\n')
}

export function composeVoicePrompt(options: {
  language?: string
  direction?: string | null
  useReference?: boolean
  tone?: string | null
  text: string
  context?: VoiceContextSelection | VoiceContextLine[]
}) {
  const language = options.language || '中文'
  const direction = removeLanguageInstruction(options.direction?.trim() || '')
    .replace(/\[#([\s\S]*?)\]/g, '$1')
    .trim()
  const tone = options.tone?.trim()
  const instruction = [
    voiceLanguageInstruction(language),
    direction || defaultVoicePrompt(options.useReference ?? true),
    tone
      ? `台词情绪与语气：${tone}。请按此情绪与语气说。`
      : '台词情绪与语气：自然生动，符合剧情与人物当下的情绪。'
  ]
    .filter(Boolean)
    .join('；')
  const context = contextFromInput(options.context)
  return formatVoicePrompt({
    instruction,
    previous: contextBlock(context.previous),
    next: contextBlock(context.next),
    text: options.text.trim()
  })
}

/** 将旧格式转为统一结构；已使用新格式时保留用户填写的指令、上文和下文。 */
export function normalizeVoicePrompt(
  input: string,
  language: string,
  fallbackText = '',
  context?: VoiceContextSelection | VoiceContextLine[]
) {
  const parts = parseVoicePrompt(input, fallbackText)
  const selected = contextFromInput(context)
  if (!parts.previous.trim()) parts.previous = contextBlock(selected.previous)
  if (!parts.next.trim()) parts.next = contextBlock(selected.next)
  const direction = removeLanguageInstruction(parts.instruction)
  parts.instruction = [voiceLanguageInstruction(language), direction || defaultVoicePrompt(false)]
    .filter(Boolean)
    .join('；')
  return formatVoicePrompt(parts)
}

function trimContext(text: string, limit: number, fromEnd = false) {
  if (text.length <= limit) return text
  const value = fromEnd ? text.slice(-Math.max(1, limit - 1)) : text.slice(0, Math.max(1, limit - 1))
  return fromEnd ? `…${value.trimStart()}` : `${value.trimEnd()}…`
}

export function buildVoiceSynthesisPrompt(options: {
  prompt?: string
  instruction?: string | null
  language: string
  text: string
  duration: number
  hasAudioReference?: boolean
  hasVoiceReference?: boolean
  context?: VoiceContextSelection | VoiceContextLine[]
}) {
  const hasInputPrompt = Boolean(options.prompt?.trim())
  const parts = hasInputPrompt
    ? parseVoicePrompt(options.prompt!, options.text)
    : parseVoicePrompt(
        composeVoicePrompt({
          language: options.language,
          direction: options.instruction,
          useReference: options.hasAudioReference ?? false,
          text: options.text
        })
      )
  if (!parts.text.trim()) throw new Error('请输入配音台词')
  if (/\[#(?![^\]]*\])/.test(parts.text)) throw new Error('语音指令格式不完整，请使用 [#指令]台词')

  const context = contextFromInput(options.context)
  if (!parts.previous.trim()) parts.previous = contextBlock(context.previous)
  if (!parts.next.trim()) parts.next = contextBlock(context.next)
  parts.previous = trimContext(parts.previous, 900, true)
  parts.next = trimContext(parts.next, 700)

  const reference = options.hasAudioReference
    ? '参考@音频1的音色、语气和节奏，不朗读参考音频的文字，不沿用参考音频的语言。'
    : options.hasVoiceReference
      ? '保持所选音色，根据指令和台词自然表演。'
      : ''
  const timing = `以自然表达为先，尽量在${options.duration.toFixed(2)}秒内说完。`
  const direction = removeLanguageInstruction(parts.instruction)
  parts.instruction = [
    voiceLanguageInstruction(options.language),
    direction || defaultVoicePrompt(options.hasAudioReference ?? false),
    reference,
    timing
  ]
    .filter(Boolean)
    .join('；')
  return formatVoicePrompt(parts)
}
