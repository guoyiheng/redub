export const defaultTranslationDirection = (target: string) =>
  `翻译为${target}，保持生动自然的影视对话口语，严格匹配口型与音节节奏。`

export const composeTranslationPrompt = (direction: string, text: string) =>
  `${direction.trim()}\n原文：「${text.trim()}」`

export interface ParsedTranslationPrompt {
  text: string
  prompt: string
}

export function parseTranslationPrompt(input: string, fallbackText: string = ''): ParsedTranslationPrompt {
  const trimmed = input.trim()
  if (!trimmed) {
    return { text: fallbackText.trim(), prompt: '' }
  }

  // 1. Look for bracketed text: 原文/台词/内容: 「...」 or "..." or “...”
  const bracketMatch = trimmed.match(/(?:原文|台词|内容)\s*[:：]\s*[「"“]([\s\S]*?)[」"”]/)
  if (bracketMatch) {
    const text = bracketMatch[1]!.trim()
    const prompt = (
      trimmed.slice(0, bracketMatch.index) + trimmed.slice(bracketMatch.index! + bracketMatch[0].length)
    ).trim()
    return { text: text || fallbackText.trim(), prompt }
  }

  // 2. Look for unbracketed: 原文/台词/内容: ...
  const prefixMatch = trimmed.match(/(?:原文|台词|内容)\s*[:：]\s*([\s\S]+)$/)
  if (prefixMatch) {
    const text = prefixMatch[1]!.trim()
    const prompt = trimmed.slice(0, prefixMatch.index).trim()
    return { text: text || fallbackText.trim(), prompt }
  }

  // 3. If fallbackText is non-empty and contained in input
  const fallback = fallbackText.trim()
  if (fallback && trimmed.includes(fallback)) {
    const prompt = trimmed.replace(fallback, '').trim()
    return { text: fallback, prompt }
  }

  // 4. Fallback: entire input is treated as text to translate if no specific structure found
  return { text: trimmed, prompt: '' }
}
