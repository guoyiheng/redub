import { describe, expect, it } from 'vitest'
import {
  buildVoiceSynthesisPrompt,
  composeVoicePrompt,
  normalizeVoicePrompt,
  selectVoiceContextLines,
  withVoiceLanguage,
  type VoiceContextLine
} from '../shared/voice'

const promptText = (prompt: string) => prompt.match(/\*合成文本：\*\s*([\s\S]*)$/)?.[1]?.trim() ?? ''

const promptInstruction = (prompt: string) => prompt.match(/\*指令：\*\s*\[#([\s\S]*?)\]/)?.[1]?.trim() ?? ''

const line = (id: string, text: string, start: number, end: number, translation = ''): VoiceContextLine => ({
  id,
  speaker: '角色 1',
  text,
  translation,
  start,
  end
})

describe('语音指令提示词格式', () => {
  it.each([
    ['你得跟我互怼！就是跟我用吵架的语气对话', '那你另请高明啊，你找我干嘛！'],
    ['用asmr的语气来试试撩撩我', '当然可以啦，每次听到你的声音，我都觉得心里暖暖的。'],
    ['用试探性的犹豫、带点害羞又藏着温柔期待的语气说', '哎，能…… 能一起撑伞不？']
  ])('旧裸指令会整理为带标签的四段格式：%s', (instruction, text) => {
    const prompt = normalizeVoicePrompt(`[#${instruction}]${text}`, '中文')
    expect(prompt).toMatch(/^\*指令：\* \[#/)
    expect(promptInstruction(prompt)).toContain(instruction)
    expect(prompt).toContain(`*合成文本：* ${text}`)
    expect(promptText(prompt)).toBe(text)
  })

  it('翻译后的情绪和语气写入指令，不生成旧标题', () => {
    const prompt = composeVoicePrompt({
      language: '日语',
      useReference: false,
      tone: '温柔安慰，语调轻柔缓和',
      text: '大丈夫だよ。'
    })
    expect(prompt).toMatch(/^\*指令：\* \[#/)
    expect(prompt).toContain('台词情绪与语气：温柔安慰，语调轻柔缓和。')
    expect(prompt).toContain('*合成文本：* 大丈夫だよ。')
    expect(prompt).not.toContain('【')
    expect(promptText(prompt)).toBe('大丈夫だよ。')
  })

  it('批量配音要求写入指令段，不产生嵌套标签', () => {
    const prompt = composeVoicePrompt({
      language: '中文',
      direction: '[#轻声、缓慢地说]',
      text: '别怕。'
    })
    expect(promptInstruction(prompt)).toContain('轻声、缓慢地说')
    expect(prompt.match(/\*指令：\*/g)).toHaveLength(1)
    expect(prompt.match(/\*合成文本：\*/g)).toHaveLength(1)
    expect(promptText(prompt)).toBe('别怕。')
  })

  it('旧三段式提示词无损迁移并替换旧语言', () => {
    const input = [
      '配音语言：英语。用英语配音；只使用该语言发音和表达，不翻译或切换语言。',
      '【配音要求】：放慢语速，音调略低。',
      '【角色语气】：低沉沙哑，带着沧桑与绝望',
      '【配音台词】：「高兄，你看这烛火，要灭了……\n我想再提剑走一趟大漠。」'
    ].join('\n')
    const prompt = normalizeVoicePrompt(input, '中文')
    expect(prompt).toContain('放慢语速，音调略低。')
    expect(prompt).toContain('台词情绪与语气：低沉沙哑，带着沧桑与绝望。')
    expect(prompt).not.toMatch(/【配音|【角色|英语/)
    expect(promptText(prompt)).toBe('高兄，你看这烛火，要灭了……\n我想再提剑走一趟大漠。')
  })

  it('旧单字段输入提取真正台词，台词中的引号和换行保持不变', () => {
    const prompt = normalizeVoicePrompt('用轻声说：「你说“再见”了吗？\n还没有。」', '中文', '旧台词')
    expect(promptText(prompt)).toBe('你说“再见”了吗？\n还没有。')
    expect(prompt).not.toContain('旧台词')
  })

  it('新格式和纯台词均以用户输入为准，不重新拼入旧译文', () => {
    const inputs = [
      '*指令：* [#轻声说]\n*合成文本：* “走吧”，他说。',
      '[#轻声说]“走吧”，他说。',
      '“走吧”，他说。'
    ]
    for (const input of inputs) {
      const prompt = buildVoiceSynthesisPrompt({
        prompt: input,
        instruction: '过时的配音要求',
        language: '中文',
        text: '过时的译文',
        duration: 3
      })
      expect(prompt).toContain('*合成文本：*')
      expect(promptText(prompt)).toBe('“走吧”，他说。')
      expect(prompt).not.toContain('过时')
    }
  })

  it('重复打开和切换语言不重复包装、不吞掉台词', () => {
    const initial = normalizeVoicePrompt('[#轻声说]你好。', '中文')
    expect(normalizeVoicePrompt(initial, '中文')).toBe(initial)
    const updated = withVoiceLanguage(initial, '日语')
    expect(updated.match(/配音语言：/g)).toHaveLength(1)
    expect(updated).not.toContain('中文')
    expect(promptText(updated)).toBe('你好。')
  })

  it('替换语言只修改指令，不改动台词中的同名说明', () => {
    const text = '他说：配音语言：中文。用中文配音，不翻译或切换语言。'
    const prompt = normalizeVoicePrompt(`[#轻声说]${text}`, '日语')
    expect(promptText(prompt)).toBe(text)
    expect(promptInstruction(prompt)).toContain('配音语言：日语')
  })

  it('用户填写的引用上文优先保留，缺失的引用下文再自动补齐', () => {
    const prompt = buildVoiceSynthesisPrompt({
      prompt: '*指令：* [#用温柔期待的语气说]\n*引用上文：* [#是… 是你吗？]\n*合成文本：* 你头发长了…',
      language: '中文',
      text: '旧台词',
      duration: 3,
      context: {
        previous: [line('prev', '不应追加', 0, 1)],
        next: [line('next', '十年了，你还好吗？', 3, 4)]
      }
    })
    expect(prompt).toContain('*引用上文：* [#是… 是你吗？]')
    expect(prompt).not.toContain('不应追加')
    expect(prompt).toContain('*引用下文：* [#十年了，你还好吗？]')
    expect(promptText(prompt)).toBe('你头发长了…')
  })

  it('自动选择有上下文关系的相邻台词，并同时给出上文和下文', () => {
    const lines = [
      line('a', '甲', 0, 1, '前文一'),
      line('b', '乙', 1.2, 2, '前文二'),
      line('current', '当前', 2.2, 3, '当前译文'),
      line('d', '丁', 3.2, 4, '后文一'),
      line('e', '戊', 4.2, 5, '后文二')
    ]
    const selection = selectVoiceContextLines(lines[2]!, lines)
    expect(selection.previous?.map((item) => item.id)).toEqual(['a', 'b'])
    expect(selection.next?.map((item) => item.id)).toEqual(['d', 'e'])

    const prompt = composeVoicePrompt({
      language: '中文',
      direction: '用颤抖沙哑、带着崩溃与绝望的哭腔说',
      text: '当前台词。',
      context: selection
    })
    expect(prompt).toContain('*引用上文：* [#前文一\n前文二]')
    expect(prompt).toContain('*引用下文：* [#后文一\n后文二]')
    expect(promptText(prompt)).toBe('当前台词。')
  })

  it('间隔过大的台词不再作为引用上下文', () => {
    const lines = [
      line('old', '很久以前', 0, 1, '很久以前'),
      line('current', '当前', 20, 21, '当前'),
      line('later', '很久以后', 40, 41, '很久以后')
    ]
    const selection = selectVoiceContextLines(lines[1]!, lines)
    expect(selection.previous).toEqual([])
    expect(selection.next).toEqual([])
  })

  it('只有指令而没有台词时不向服务发起无效合成', () => {
    for (const prompt of ['[#轻声说]', '*指令：* [#轻声说]\n*合成文本：*']) {
      expect(() =>
        buildVoiceSynthesisPrompt({
          prompt,
          language: '中文',
          text: '不能偷偷补回的旧台词',
          duration: 2
        })
      ).toThrow('请输入配音台词')
    }
  })

  it('未闭合的指令不会被误当成要朗读的台词', () => {
    expect(() =>
      buildVoiceSynthesisPrompt({ prompt: '[#轻声说你好。', language: '中文', text: '', duration: 2 })
    ).toThrow('语音指令格式不完整')
  })
})
