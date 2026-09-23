import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { db, initDb } from '../server/db'
import { projects } from '../server/db/schema'

describe('项目置顶与属性功能', () => {
  beforeAll(async () => {
    await initDb()
  })

  it('支持置顶状态，置顶项目排在未置顶项目前面', async () => {
    const now = Date.now()
    const id1 = randomUUID()
    const id2 = randomUUID()
    const id3 = randomUUID()

    // Create 3 projects
    await db.insert(projects).values([
      {
        id: id1,
        name: '项目1 (新但不置顶)',
        kind: 'text',
        duration: 0,
        createdAt: now + 2000,
        updatedAt: now + 2000,
        pinned: false
      },
      {
        id: id2,
        name: '项目2 (较旧但置顶)',
        kind: 'text',
        duration: 0,
        createdAt: now + 1000,
        updatedAt: now + 1000,
        pinned: true
      },
      {
        id: id3,
        name: '项目3 (普通)',
        kind: 'text',
        duration: 0,
        createdAt: now,
        updatedAt: now,
        pinned: false
      }
    ])

    const rows = await db.select().from(projects).orderBy(desc(projects.pinned), desc(projects.updatedAt))

    const project2Idx = rows.findIndex((p) => p.id === id2)
    const project1Idx = rows.findIndex((p) => p.id === id1)
    const project3Idx = rows.findIndex((p) => p.id === id3)

    // project2 is pinned, so it should appear before project1 despite project1 having newer updatedAt
    expect(project2Idx).toBeLessThan(project1Idx)
    expect(project1Idx).toBeLessThan(project3Idx)
  })

  it('更新置顶状态后列表排序即时改变', async () => {
    const now = Date.now()
    const idA = randomUUID()
    const idB = randomUUID()

    await db.insert(projects).values([
      {
        id: idA,
        name: '项目A',
        kind: 'text',
        duration: 0,
        createdAt: now,
        updatedAt: now,
        pinned: false
      },
      {
        id: idB,
        name: '项目B',
        kind: 'text',
        duration: 0,
        createdAt: now + 100,
        updatedAt: now + 100,
        pinned: false
      }
    ])

    // Currently B is newer than A, neither pinned
    let rows = await db.select().from(projects).orderBy(desc(projects.pinned), desc(projects.updatedAt))
    expect(rows.findIndex((p) => p.id === idB)).toBeLessThan(rows.findIndex((p) => p.id === idA))

    // Pin project A
    await db.update(projects).set({ pinned: true }).where(eq(projects.id, idA))

    rows = await db.select().from(projects).orderBy(desc(projects.pinned), desc(projects.updatedAt))
    expect(rows.findIndex((p) => p.id === idA)).toBeLessThan(rows.findIndex((p) => p.id === idB))
  })

  it('AI 配音原声参考提示词严格强调复刻音色、语气与情感起伏', async () => {
    const { referenceVoicePrompt } = await import('../shared/voice')
    expect(referenceVoicePrompt).toContain('严格克隆原配音的音色与说话语气')
    expect(referenceVoicePrompt).toContain('复刻人物的情感色彩、语调起伏')
    expect(referenceVoicePrompt).toContain('完全一致')
  })

  it('语音指令和引用上文使用文档标记，只有当前台词位于标记外', async () => {
    const { buildVoiceSynthesisPrompt } = await import('../shared/voice')
    const prompt = buildVoiceSynthesisPrompt({
      prompt: '[#用颤抖沙哑、带着崩溃与绝望的哭腔说]我逆转时空九十九次救你。',
      language: '中文',
      text: '我逆转时空九十九次救你。',
      duration: 2.4,
      hasAudioReference: true,
      hasVoiceReference: true,
      context: [
        {
          id: 'previous',
          speaker: '对方',
          text: '你还好吗？',
          translation: '你还好吗？',
          start: 0,
          end: 1
        }
      ]
    })
    expect(prompt).toMatch(/^\[#.*用颤抖沙哑、带着崩溃与绝望的哭腔说/)
    expect(prompt).toContain('[#你还好吗？]')
    expect(prompt.replace(/\[#[^\]]*\]/g, '')).toBe('我逆转时空九十九次救你。')
    expect(prompt).toContain('不朗读参考音频的文字')
    expect(prompt).not.toMatch(/【配音任务】|【表演执行规则】|【用户语音指令】/)
  })
})
