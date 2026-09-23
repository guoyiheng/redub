import { describe, expect, it } from 'vitest'
import {
  buildVoiceSynthesisPrompt,
  composeVoicePrompt,
  normalizeVoicePrompt,
  withVoiceLanguage
} from '../shared/voice'

const spokenText = (prompt: string) => prompt.replace(/\[#[^\]]*\]/g, '')

describe('文档中的语音指令格式', () => {
  it.each([
    ['你得跟我互怼！就是跟我用吵架的语气对话', '那你另请高明啊，你找我干嘛！'],
    ['用asmr的语气来试试撩撩我', '当然可以啦，每次听到你的声音，我都觉得心里暖暖的。'],
    ['用试探性的犹豫、带点害羞又藏着温柔期待的语气说', '哎，能…… 能一起撑伞不？']
  ])('保留文档指令和原始台词：%s', (instruction, text) => {
    const prompt = normalizeVoicePrompt(`[#${instruction}]${text}`, '中文')
    expect(prompt).toMatch(/^\[#配音语言：中文。/)
    expect(prompt).toContain(`${instruction}]${text}`)
    expect(spokenText(prompt)).toBe(text)
  })

  it('翻译后生成的语气直接写进提示词，不产生自定义标题', () => {
    const prompt = composeVoicePrompt({
      language: '日语',
      useReference: false,
      tone: '温柔安慰，语调轻柔缓和',
      text: '大丈夫だよ。'
    })
    expect(prompt).toMatch(/^\[#配音语言：日语。/)
    expect(prompt).toContain('用温柔安慰，语调轻柔缓和的语气说。')
    expect(prompt).not.toContain('【')
    expect(spokenText(prompt)).toBe('大丈夫だよ。')
  })

  it('批量配音的共用要求也接受文档格式，不生成嵌套标记', () => {
    const prompt = composeVoicePrompt({ language: '中文', direction: '[#轻声、缓慢地说]', text: '别怕。' })
    expect(prompt).toContain('轻声、缓慢地说]别怕。')
    expect(prompt.match(/\[#/g)).toHaveLength(1)
    expect(spokenText(prompt)).toBe('别怕。')
  })

  it('旧的三段式提示词无损迁移，并替换旧语言', () => {
    const input = [
      '配音语言：英语。用英语配音；只使用该语言发音和表达，不翻译或切换语言。',
      '【配音要求】：放慢语速，音调略低。',
      '【角色语气】：低沉沙哑，带着沧桑与绝望',
      '【配音台词】：「高兄，你看这烛火，要灭了……\n我想再提剑走一趟大漠。」'
    ].join('\n')
    const prompt = normalizeVoicePrompt(input, '中文')
    expect(prompt).toContain('放慢语速，音调略低。')
    expect(prompt).toContain('低沉沙哑，带着沧桑与绝望')
    expect(prompt).not.toMatch(/【配音|【角色|英语/)
    expect(spokenText(prompt)).toBe('高兄，你看这烛火，要灭了……\n我想再提剑走一趟大漠。')
  })

  it('旧单字段输入提取真正台词，台词中的引号和换行保持不变', () => {
    const prompt = normalizeVoicePrompt('用轻声说：「你说“再见”了吗？\n还没有。」', '中文', '旧台词')
    expect(spokenText(prompt)).toBe('你说“再见”了吗？\n还没有。')
    expect(prompt).not.toContain('旧台词')
  })

  it('新格式和纯台词均以用户输入为准，不重新拼入旧译文', () => {
    for (const input of ['[#轻声说]“走吧”，他说。', '“走吧”，他说。']) {
      const prompt = buildVoiceSynthesisPrompt({
        prompt: input,
        instruction: '过时的配音要求',
        language: '中文',
        text: '过时的译文',
        duration: 3
      })
      expect(spokenText(prompt)).toBe('“走吧”，他说。')
      expect(prompt).not.toContain('过时')
    }
  })

  it('重复打开和切换语言不重复包装、不吞掉台词', () => {
    const initial = normalizeVoicePrompt('[#轻声说]你好。', '中文')
    expect(normalizeVoicePrompt(initial, '中文')).toBe(initial)
    const updated = withVoiceLanguage(initial, '日语')
    expect(updated.match(/配音语言：/g)).toHaveLength(1)
    expect(updated).not.toContain('中文')
    expect(spokenText(updated)).toBe('你好。')
  })

  it('替换语言只修改指令，不改动台词中的同名说明', () => {
    const text = '他说：配音语言：中文。用中文配音，不翻译或切换语言。'
    const prompt = normalizeVoicePrompt(`[#轻声说]${text}`, '日语')
    expect(spokenText(prompt)).toBe(text)
  })

  it('保留用户按文档填写的引用上文，不将其作为配音台词或重复追加上下文', () => {
    const prompt = buildVoiceSynthesisPrompt({
      prompt: '[#用温柔期待的语气说][#是… 是你吗？]你头发长了…',
      language: '中文',
      text: '旧台词',
      duration: 3,
      context: [{ id: 'prev', speaker: '角色 1', text: '不应追加', translation: '', start: 0, end: 1 }]
    })
    expect(prompt).toContain('[#是… 是你吗？]')
    expect(prompt).not.toContain('不应追加')
    expect(spokenText(prompt)).toBe('你头发长了…')
  })

  it('只有指令而没有台词时不向服务发起无效合成', () => {
    expect(() =>
      buildVoiceSynthesisPrompt({
        prompt: '[#轻声说]',
        language: '中文',
        text: '不能偷偷补回的旧台词',
        duration: 2
      })
    ).toThrow('请输入配音台词')
  })

  it('未闭合的指令不会被误当成要朗读的台词', () => {
    expect(() =>
      buildVoiceSynthesisPrompt({ prompt: '[#轻声说你好。', language: '中文', text: '', duration: 2 })
    ).toThrow('语音指令格式不完整')
  })
})
