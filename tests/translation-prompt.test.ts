import { describe, it, expect, vi } from 'vitest'
import {
  defaultTranslationDirection,
  composeTranslationPrompt,
  parseTranslationPrompt
} from '../shared/translation'
import { translateLines } from '../server/services/providers'
import type { Channel, Segment } from '../shared/types'

describe('翻译提示词与原文解析', () => {
  it('标准格式：提示词 + 原文：「...」 正确解析', () => {
    const text = 'How could this happen?'
    const direction = defaultTranslationDirection('中文')
    const composed = composeTranslationPrompt(direction, text)

    const parsed = parseTranslationPrompt(composed, text)
    expect(parsed.text).toBe(text)
    expect(parsed.prompt).toBe(direction)
  })

  it('用户自定义风格与修改原文引号内容时均能正确提取', () => {
    const input = '翻译为日语，角色语气极度慌张恐惧。\n原文：「Wait for me please!」'
    const parsed = parseTranslationPrompt(input, 'Wait for me')

    expect(parsed.text).toBe('Wait for me please!')
    expect(parsed.prompt).toBe('翻译为日语，角色语气极度慌张恐惧。')
  })

  it('支持中文全角与半角引号，以及台词/内容前缀', () => {
    const input1 = '保持搞笑方言口语\n台词："别走啊兄弟"'
    const p1 = parseTranslationPrompt(input1)
    expect(p1.text).toBe('别走啊兄弟')
    expect(p1.prompt).toBe('保持搞笑方言口语')

    const input2 = '优雅英式英语\n内容: “Come on in”'
    const p2 = parseTranslationPrompt(input2)
    expect(p2.text).toBe('Come on in')
    expect(p2.prompt).toBe('优雅英式英语')
  })

  it('用户删除前缀直接输入纯文本时，回退到纯文本', () => {
    const raw = 'Just a simple sentence'
    const parsed = parseTranslationPrompt(raw)
    expect(parsed.text).toBe('Just a simple sentence')
    expect(parsed.prompt).toBe('')
  })

  it('translateLines 正确将 customPrompt 嵌入系统提示词中', async () => {
    const mockFetch = vi.fn(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body)
      const systemMessage = body.messages.find((m: any) => m.role === 'system')?.content
      expect(systemMessage).toContain('【用户指定的特殊翻译要求与提示词】')
      expect(systemMessage).toContain('角色语气急促，使用东北方言')

      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: [{ id: 'seg-1', text: '干啥呢' }]
                })
              }
            }
          ]
        })
      }
    })
    vi.stubGlobal('fetch', mockFetch)

    const channel: Channel = {
      id: 'test-ch',
      name: 'OpenAI Test',
      type: 'openai',
      enabled: true,
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      keyEnv: 'TEST_KEY'
    }

    const segments: Segment[] = [
      {
        id: 'seg-1',
        projectId: 'p-1',
        start: 0,
        end: 2,
        text: 'What are you doing?'
      }
    ]

    process.env.TEST_KEY = 'sk-mock'
    const result = await translateLines(segments, '中文', channel, 'en', '角色语气急促，使用东北方言')
    expect(result.get('seg-1')).toBe('干啥呢')
    vi.unstubAllGlobals()
  })
})
