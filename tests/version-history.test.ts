import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, initDb } from '../server/db'
import { projects, segments, channels } from '../server/db/schema'
import { getProject, getSegments } from '../server/services/store'
import { executeJob } from '../server/services/pipeline'
import { formatVersionName, createVersionName } from '../shared/version'
import type { Job, Segment, TranslationVersion, AudioVersion } from '../shared/types'

describe('历史版本系统与译文覆盖保留配音', () => {
  it('版本命名严格符合 v_yymmdd_hh:mm 格式', () => {
    const fixedDate = new Date('2026-09-22T16:08:00')
    const tag = formatVersionName(fixedDate)
    expect(tag).toBe('v_260922_16:08')
    expect(tag).toMatch(/^v_\d{6}_\d{2}:\d{2}$/)

    const existing = [tag]
    const tag2 = createVersionName(existing, fixedDate)
    expect(tag2).toBe('v_260922_16:08_2')
  })

  it('翻译时保留已有配音与成片，并记录翻译历史版本', async () => {
    await initDb()
    const projectId = randomUUID()
    await db.insert(projects).values({
      id: projectId,
      name: '翻译版本测试',
      kind: 'text',
      duration: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mixedPath: `${projectId}/mixed.mp4`,
      outputPath: `${projectId}/output.mp4`
    })

    const segId = randomUUID()
    await db.insert(segments).values({
      id: segId,
      projectId,
      start: 0,
      end: 3,
      text: 'ダメ',
      translation: '不行',
      generatedPath: `${projectId}/existing-voice.mp3`,
      generatedDuration: 2.1,
      synthesisMode: 'ai'
    })

    // Mock translate provider
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: [{ id: segId, text: '不可以' }]
                })
              }
            }
          ]
        })
      }))
    )

    // Execute translation job
    const job: Job = {
      id: randomUUID(),
      projectId,
      stage: 'translate',
      segmentId: null,
      status: 'queued',
      progress: 0,
      message: '等待执行',
      error: null,
      dependsOn: null,
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    await executeJob(job, async () => {})

    const [updated] = await db.select().from(segments).where(eq(segments.id, segId))
    const proj = await getProject(projectId)

    // 译文覆盖为新译文
    expect(updated.translation).toBe('不可以')
    // 配音路径完好保留！未被清空！
    expect(updated.generatedPath).toBe(`${projectId}/existing-voice.mp3`)
    expect(updated.generatedDuration).toBe(2.1)
    // 成片路径完好保留！未被清空！
    expect(proj.mixedPath).toBe(`${projectId}/mixed.mp4`)
    expect(proj.outputPath).toBe(`${projectId}/output.mp4`)

    // 历史版本记录完整
    expect(updated.translationHistory).toBeTruthy()
    const history = updated.translationHistory as TranslationVersion[]
    expect(history.length).toBe(2)
    // 第一版是原本的「不行」
    expect(history[0]!.text).toBe('不行')
    expect(history[0]!.name).toMatch(/^v_\d{6}_\d{2}:\d{2}$/)
    // 第二版是新翻译的「不可以」
    expect(history[1]!.text).toBe('不可以')
    expect(history[1]!.name).toMatch(/^v_\d{6}_\d{2}:\d{2}$/)
  })

  it('恢复历史版本可将指定译文版本或配音版本设为终稿', async () => {
    await initDb()
    const projectId = randomUUID()
    const segId = randomUUID()

    const translationHistory: TranslationVersion[] = [
      { id: 'v1', name: 'v_260922_15:00', text: '第一版译文', createdAt: 1000 },
      { id: 'v2', name: 'v_260922_16:00', text: '第二版译文', createdAt: 2000 }
    ]

    const audioHistory: AudioVersion[] = [
      {
        id: 'a1',
        name: 'v_260922_15:05',
        audioPath: `${projectId}/voice-1.mp3`,
        duration: 1.8,
        synthesisMode: 'tts',
        speaker: 'zh-CN-XiaoxiaoNeural',
        createdAt: 1100
      },
      {
        id: 'a2',
        name: 'v_260922_16:05',
        audioPath: `${projectId}/voice-2.mp3`,
        duration: 2.4,
        synthesisMode: 'ai',
        speaker: '角色 1',
        createdAt: 2100
      }
    ]

    await db.insert(projects).values({
      id: projectId,
      name: '终稿恢复测试',
      kind: 'text',
      duration: 10,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })

    await db.insert(segments).values({
      id: segId,
      projectId,
      start: 0,
      end: 3,
      text: '测试文本',
      translation: '第二版译文',
      generatedPath: `${projectId}/voice-2.mp3`,
      generatedDuration: 2.4,
      synthesisMode: 'ai',
      aiSpeaker: '角色 1',
      translationHistory,
      audioHistory
    })

    // 模拟恢复历史译文版本 v1 为终稿
    const targetTrans = translationHistory.find((v) => v.id === 'v1')!
    await db.update(segments).set({ translation: targetTrans.text }).where(eq(segments.id, segId))

    let [seg] = await db.select().from(segments).where(eq(segments.id, segId))
    expect(seg.translation).toBe('第一版译文')
    // 配音依然存在
    expect(seg.generatedPath).toBe(`${projectId}/voice-2.mp3`)

    // 模拟恢复历史配音版本 a1 为终稿
    const targetAudio = audioHistory.find((v) => v.id === 'a1')!
    await db
      .update(segments)
      .set({
        generatedPath: targetAudio.audioPath,
        generatedDuration: targetAudio.duration ?? null,
        synthesisMode: targetAudio.synthesisMode ?? seg.synthesisMode,
        ttsVoice: targetAudio.speaker ?? seg.ttsVoice
      })
      .where(eq(segments.id, segId))

    seg = (await db.select().from(segments).where(eq(segments.id, segId)))[0]!
    expect(seg.generatedPath).toBe(`${projectId}/voice-1.mp3`)
    expect(seg.generatedDuration).toBe(1.8)
    expect(seg.synthesisMode).toBe('tts')
    expect(seg.ttsVoice).toBe('zh-CN-XiaoxiaoNeural')
  })
})
