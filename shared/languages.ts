export const targetLanguages = [
  '中文',
  '英语',
  '日语',
  '韩语',
  '西班牙语',
  '法语',
  '德语',
  '意大利语',
  '俄语'
]
const aliases: Record<string, string> = {
  English: '英语',
  日本語: '日语',
  한국어: '韩语',
  Español: '西班牙语',
  Français: '法语',
  Deutsch: '德语',
  Italiano: '意大利语',
  Русский: '俄语'
}
export const normalizeLanguage = (value: string) => aliases[value] || value
export const languageOptions = (value: string) => [...new Set([...targetLanguages, normalizeLanguage(value)])]
