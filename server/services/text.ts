export interface TextSpan {
  start: number
  end: number
  text: string
}
const seconds = (time: string) => {
  const p = time.replace(',', '.').split(':').map(Number)
  return p.reduce((sum, part) => sum * 60 + part, 0)
}
export function parseScript(input: string): TextSpan[] {
  const text = input
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .trim()
  if (!text) throw new Error('文本不能为空')
  const blocks = text.split(/\n\s*\n/)
  const timed = blocks.flatMap((block) => {
    const lines = block.split('\n')
    const n = lines.findIndex((line) => line.includes('-->'))
    if (n < 0) return []
    const match = lines[n]!.match(
      /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})/
    )
    if (!match) throw new Error('字幕时间格式无效')
    return [
      {
        start: seconds(match[1]!),
        end: seconds(match[2]!),
        text: lines
          .slice(n + 1)
          .join('\n')
          .replace(/<[^>]*>/g, '')
      }
    ]
  })
  if (text.includes('-->') && !timed.length) throw new Error('未识别到有效字幕')
  let cursor = 0
  const spans = timed.length
    ? timed
    : text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const start = cursor
          cursor += Math.min(120, Math.max(2, line.length / 4))
          return { start, end: cursor, text: line.trim() }
        })
  spans.sort((a, b) => a.start - b.start)
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!
    if (s.end <= s.start || s.end - s.start > 120 || s.text.length > 2800 || !s.text.trim())
      throw new Error('每条台词需包含文字，时长为 0–120 秒且不超过 2800 字')
    if (i && s.start < spans[i - 1]!.end) throw new Error('字幕时间重叠，请先调整为不重叠的片段')
  }
  return spans
}
export function subtitleText(spans: { start: number; end: number; text: string }[]) {
  const stamp = (t: number) => {
    const ms = Math.round(t * 1000)
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
  }
  return spans.map((s, i) => `${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text}`).join('\n\n')
}
