import { describe, it, expect } from 'vitest'
import {
  computeVolcenginePreviewKey,
  computeEdgePreviewKey,
  getPreviewCache,
  savePreviewCache
} from '../server/services/preview-cache'

describe('试听资源缓存服务 (preview-cache)', () => {
  it('火山方舟缓存 Key 生成稳定且敏感响应不同参数', () => {
    const channel = {
      endpoint: 'https://openspeech.bytedance.com/api/v3/tts/create',
      model: 'seed-audio-1.0'
    }
    const key1 = computeVolcenginePreviewKey(channel, 'speaker-a', '你好，这是声音试听。')
    const key2 = computeVolcenginePreviewKey(channel, 'speaker-a', '你好，这是声音试听。')
    const keyDiffSpeaker = computeVolcenginePreviewKey(channel, 'speaker-b', '你好，这是声音试听。')
    const keyDiffPrompt = computeVolcenginePreviewKey(channel, 'speaker-a', '不同的试听文案')
    const keyDiffModel = computeVolcenginePreviewKey(
      { ...channel, model: 'seed-audio-2.0' },
      'speaker-a',
      '你好，这是声音试听。'
    )

    expect(key1).toBe(key2)
    expect(key1).not.toBe(keyDiffSpeaker)
    expect(key1).not.toBe(keyDiffPrompt)
    expect(key1).not.toBe(keyDiffModel)
  })

  it('微软 Edge TTS 缓存 Key 生成稳定且敏感响应音调语速', () => {
    const options = { rate: '0%', pitch: '0Hz', volume: '0%' }
    const key1 = computeEdgePreviewKey('zh-CN-XiaoxiaoNeural', '你好', options)
    const key2 = computeEdgePreviewKey('zh-CN-XiaoxiaoNeural', '你好', options)
    const keyDiffRate = computeEdgePreviewKey('zh-CN-XiaoxiaoNeural', '你好', { ...options, rate: '+10%' })

    expect(key1).toBe(key2)
    expect(key1).not.toBe(keyDiffRate)
  })

  it('缓存写入与读取工作正常，未命中返回 null', async () => {
    const testKey = 'test-preview-key-' + Date.now()
    expect(await getPreviewCache(testKey)).toBeNull()

    const mockAudio = Buffer.from('mock-audio-data-mp3')
    await savePreviewCache(testKey, mockAudio)

    const cached = await getPreviewCache(testKey)
    expect(cached).not.toBeNull()
    expect(cached?.toString()).toBe('mock-audio-data-mp3')
  })

  it('音色试听 stageLabels 与任务策略正确集成', async () => {
    const { stageLabels } = await import('../shared/types')
    const { segmentTaskReason } = await import('../shared/job-policy')
    expect(stageLabels['preview-voice']).toBe('音色试听')

    const mockJobs = [
      {
        id: 'job-1',
        projectId: null,
        stage: 'preview-voice' as const,
        status: 'running' as const,
        progress: 20,
        message: '正在合成音色试听',
        attempts: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ]
    // preview-voice 正在运行不应阻塞片段翻译与配音常规操作
    expect(segmentTaskReason(mockJobs, 'seg-1')).toBe('')
  })

  it('preview-voice 任务不关联项目也可正常落库和查询详情', async () => {
    const { db, initDb } = await import('../server/db')
    const { jobs } = await import('../server/db/schema')
    const { getJobDetail } = await import('../server/services/job-requests')
    const { randomUUID } = await import('node:crypto')
    await initDb()

    const jobId = randomUUID()
    await db.insert(jobs).values({
      id: jobId,
      projectId: null,
      stage: 'preview-voice',
      status: 'completed',
      progress: 100,
      message: '音色试听合成完成: 灿灿',
      input: { speaker: 'zh_female_cancan_mars_bigtts', speakerLabel: '灿灿' },
      createdAt: Date.now(),
      updatedAt: Date.now()
    })

    const detail = await getJobDetail(jobId)
    expect(detail.job.projectId).toBeNull()
    expect(detail.projectName).toBe('')
    expect((detail.input as any).speaker).toBe('zh_female_cancan_mars_bigtts')
  })
})
