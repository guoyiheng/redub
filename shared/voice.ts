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

export const defaultDubbingRequirement = (language = '中文', useReference = true) => {
  const lang = normalizeLanguage(language.trim() || '中文')
  const langStr = lang === '中文' ? '用中文配音' : `用${lang}配音`
  return useReference
    ? `${langStr}，以原声为表演基准复刻音色、语气、情绪起伏、重音、呼吸和停顿，真实呈现人物关系与剧情语境。`
    : `${langStr}，保持生动自然的影视对白口语，根据剧情控制情绪、重音、语速、音调和停顿。`
}

export type VoiceContextLine = Pick<Segment, 'id' | 'speaker' | 'text' | 'translation' | 'start' | 'end'>

/**
 * 将用户填写的语音指令包装成稳定的影视配音提示词。
 * 用户指令保持原样并作为最高优先级，包装内容只负责约束模型的执行边界。
 */
export function buildVoiceSynthesisPrompt(options: {
  instruction: string
  text: string
  duration: number
  inferredTone?: string
  hasAudioReference?: boolean
  hasVoiceReference?: boolean
  context?: VoiceContextLine[]
}) {
  const reference = options.hasVoiceReference
    ? options.hasAudioReference
      ? '参考音频只用于复刻音色、说话方式、情绪力度和节奏；不要朗读参考音频的文字，也不要继承参考音频的语言。'
      : '指定音色只用于确定音色和说话方式；请根据当前台词和用户指令重新表演。'
    : '没有参考音色时，请依据用户指令和当前台词语境自然完成表演。'
  const context = options.context?.filter((line) => (line.translation || line.text).trim()).slice(-3) || []
  const contextBlock = context.length
    ? [
        '【语境参考（只供理解，不朗读）】',
        ...context.map(
          (line) => `${line.speaker?.trim() || '角色'}：${(line.translation || line.text).trim()}`
        )
      ]
    : []
  const instruction = options.instruction.trim() || '自然、清晰、符合剧情地完成当前台词。'
  const currentLineBlock = instruction.includes(options.text.trim())
    ? []
    : ['【当前台词（只朗读这一段）】', `「${options.text.trim()}」`]
  return [
    '你是专业影视配音演员和语言导演。',
    '【配音任务】只生成当前台词的语音，不要朗读提示词、标签、说明、引号或元数据，不要添加台词之外的内容。',
    `【目标时长】约 ${options.duration.toFixed(2)} 秒；优先保证自然表达，在可接受范围内贴合时长，不要为了赶时长而含混，也不要无故拖长。`,
    `【参考音频】${reference}`,
    ...contextBlock,
    '【表演执行规则】',
    '1. 先理解人物、关系、场景和情绪，再执行语音指令；情绪要通过语调、音量、语速、音高、重音、呼吸和停顿自然呈现。',
    '2. 用户指定的情绪（如悲伤、生气、害羞、暧昧、吵架、哭腔）、方言/口音、语气、语速和音调优先级最高；同一句有情绪变化时，要表现自然的层次、转折与收放。',
    '3. 严格遵守当前台词的标点、换行、省略号，以及用户写出的停顿、拖音、重复、犹豫和哭腔；停顿要像真实说话，不要平均切分或机械加停顿。',
    '4. “上文”“引用上文”或类似内容仅供理解语境、人物关系和情绪承接，不朗读其中内容；只朗读用户明确指定的当前台词。',
    '5. 不翻译、不改写、不补充、不删减当前台词；方言只改变发音和口吻，不改变台词含义。',
    ...(options.inferredTone
      ? [`【自动语境参考】${options.inferredTone}；仅在用户没有明确指定相反表演方式时采用。`]
      : []),
    '【用户语音指令】',
    instruction,
    ...currentLineBlock
  ].join('\n')
}

export interface StructuredVoicePrompt {
  requirement: string
  tone: string
  text: string
}

export function composeStructuredVoicePrompt(options: {
  language?: string
  direction?: string | null
  requirement?: string
  useReference?: boolean
  tone?: string | null
  text: string
}) {
  const language = options.language || '中文'
  const requirement =
    options.requirement?.trim() ||
    options.direction?.trim() ||
    defaultDubbingRequirement(language, options.useReference ?? true)
  const tone = options.tone?.trim() || '自然生动，富有情感'
  const text = options.text.trim()
  return `【配音要求】：${requirement}\n【角色语气】：${tone}\n【配音台词】：「${text}」`
}

export function parseStructuredVoicePrompt(input: string, fallbackText = ''): StructuredVoicePrompt {
  const trimmed = input.trim()
  if (!trimmed) {
    return { requirement: '', tone: '', text: fallbackText.trim() }
  }
  const reqMatch = trimmed.match(/【(?:配音要求|配音指导|要求)】[：:]\s*([^\n]+)/)
  const toneMatch = trimmed.match(/【(?:角色语气|语气情绪|语气)】[：:]\s*([^\n]+)/)
  const textMatch = trimmed.match(/【(?:配音台词|台词|内容)】[：:]\s*[「"“]?([\s\S]*?)[」"”]?$/)

  if (reqMatch || toneMatch || textMatch) {
    let text = textMatch ? textMatch[1]!.trim().replace(/^[「"“]|[\s」"”]+$/g, '') : ''
    if (!text && fallbackText) text = fallbackText.trim()
    return {
      requirement: reqMatch ? reqMatch[1]!.trim() : '',
      tone: toneMatch ? toneMatch[1]!.trim() : '',
      text: text || trimmed
    }
  }
  const quoteMatch = trimmed.match(/[「"“]([\s\S]*?)[」"”]/)
  if (quoteMatch) {
    const text = quoteMatch[1]!.trim()
    const toneOrReq = (
      trimmed.slice(0, quoteMatch.index) + trimmed.slice(quoteMatch.index! + quoteMatch[0].length)
    ).trim()
    return {
      requirement: '',
      tone: toneOrReq,
      text: text || fallbackText.trim()
    }
  }
  return {
    requirement: '',
    tone: '',
    text: trimmed
  }
}

export function inferToneFromContext(
  segment: Pick<Segment, 'text' | 'translation' | 'start' | 'end' | 'speaker'>,
  allSegments: Pick<Segment, 'id' | 'text' | 'translation' | 'start' | 'end' | 'speaker'>[] = []
): string {
  const content = (segment.translation || segment.text || '').trim()
  if (!content) return '自然流畅，语气平缓'

  const duration = segment.end - segment.start
  const currIdx = allSegments.findIndex(
    (s) => s === segment || ('id' in segment && (s as any).id === (segment as any).id)
  )
  const prevSegment = currIdx > 0 ? allSegments[currIdx - 1] : undefined
  const prevContent = (prevSegment?.translation || prevSegment?.text || '').trim()

  if (/[!！]/.test(content)) {
    if (/快|跑|危险|小心|救命|别去|闪开|住手/.test(content)) return '焦急慌乱，大声呼喊'
    if (/闭嘴|滚|混蛋|混账|可恶|疯了|去死/.test(content)) return '愤怒斥责，情绪爆发'
    if (/太棒了|太好了|哈哈|成功了|终于/.test(content)) return '兴奋欢快，热情洋溢'
    if (duration < 1.2) return '短促有力，情绪紧绷'
    return '情绪激昂，语气坚定'
  }

  if (/[?？]/.test(content)) {
    if (/怎么会|为什么|难道|凭什么|何必|怎么可能/.test(content)) return '难以置信，质疑质问'
    if (/谁|哪儿|哪里|什么时候|真假|真的吗/.test(content)) return '疑惑探寻，语调上扬'
    return '试探询问，语带好奇'
  }

  if (/(\.{3}|…{1,2}|~)/.test(content) || /对不起|抱歉|可惜|是我不好|没办法/.test(content)) {
    if (/对不起|抱歉|是我/.test(content)) return '自责内疚，轻声低语'
    if (/可是|但是|也许|不过/.test(content)) return '犹豫迟疑，欲言又止'
    return '轻声叹息，略带低落'
  }

  if (/别怕|没事的|别担心|放心吧|有我在|别哭/.test(content)) {
    return '温柔安慰，语调轻柔缓和'
  }

  if (prevContent && /[?？]/.test(prevContent) && prevSegment?.speaker !== segment.speaker) {
    return '从容作答，条理清晰'
  }

  if (duration < 1.0) return '短促利落，语速偏快'
  if (duration > 4.0) return '沉稳从容，语速平缓'

  return '自然生动，符合剧情语境'
}

export const voiceLanguageInstruction = (language: string) => {
  const lang = normalizeLanguage(language.trim() || '中文')
  const langDub = lang === '中文' ? '用中文配音' : `用${lang}配音`
  return `配音语言：${lang}。${langDub}；只使用该语言发音和表达，不翻译或切换语言。参考音频仅用于音色、语气、情绪和节奏，不沿用参考音频的语言。`
}

export function stripVoiceLanguageInstruction(prompt: string) {
  return prompt
    .replace(/配音语言：[^\r\n]*/g, '')
    .replace(/【配音要求】[：:]\s*(?=\n|$)/g, '')
    .trim()
}

export function withVoiceLanguage(prompt: string, language: string) {
  const content = stripVoiceLanguageInstruction(prompt)
  return `${voiceLanguageInstruction(language)}\n${content}`
}
