import { describe, expect, it } from 'vitest'
import { groupJobs } from '../shared/task-groups'
import type { Job, JobStatus, Stage } from '../shared/types'

function job(id: string, stage: Stage, status: JobStatus = 'queued', options: Partial<Job> = {}): Job {
  return {
    id,
    projectId: 'p1',
    stage,
    segmentId: stage === 'synthesize' ? id : null,
    status,
    progress: 0,
    message: `${stage} ${status}`,
    error: null,
    dependsOn: null,
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
    ...options
  }
}

describe('任务面板聚合', () => {
  it('取消的旧自动链显示已取消，不计为排队或完成', () => {
    const groups = groupJobs([
      job('mix', 'mix', 'cancelled'),
      job('preview', 'preview', 'cancelled', { dependsOn: 'mix' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.status).toBe('cancelled')
    expect(groups[0]!.progress).toBe(0)
    expect(groupJobs(groups[0]!.jobs, 0)).toEqual([])
  })
  it('将前置处理链路合并为一条，并显示当前阶段和平均进度', () => {
    const jobs = [
      job('extract', 'extract', 'completed', { progress: 100, createdAt: 4 }),
      job('separate', 'separate', 'running', { dependsOn: 'extract', progress: 40, createdAt: 3 }),
      job('segment', 'segment', 'queued', { dependsOn: 'separate', createdAt: 2 }),
      job('transcribe', 'transcribe', 'queued', { dependsOn: 'segment', createdAt: 1 })
    ]

    const groups = groupJobs(jobs)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      title: '素材预处理',
      status: 'running',
      progress: 35,
      currentStage: 'separate'
    })
    expect(groups[0]!.jobs).toHaveLength(4)
  })

  it('只合并同一批量配音依赖链，独立单句保持分开', () => {
    const jobs = [
      job('batch-1', 'synthesize', 'completed', { progress: 100, segmentId: 's1' }),
      job('batch-2', 'synthesize', 'running', {
        dependsOn: 'batch-1',
        segmentId: 's2',
        progress: 50
      }),
      job('batch-3', 'synthesize', 'queued', { dependsOn: 'batch-2', segmentId: 's3' }),
      job('single', 'synthesize', 'queued', { segmentId: 's4' })
    ]

    const groups = groupJobs(jobs)
    expect(groups.map((group) => group.title)).toEqual(['批量配音', '单句配音'])
    expect(groups[0]!.jobs.map((item) => item.id)).toEqual(['batch-1', 'batch-2', 'batch-3'])
    expect(groups[0]!.progress).toBe(50)
  })

  it('合并音轨混合与成片输出，并优先保留运行中的任务组', () => {
    const jobs = [
      job('mix', 'mix', 'running', { progress: 70, createdAt: 1 }),
      job('preview', 'preview', 'queued', { dependsOn: 'mix', createdAt: 2 }),
      job('old', 'translate', 'completed', { progress: 100, createdAt: 3, updatedAt: 30 })
    ]

    const groups = groupJobs(jobs, 1)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ title: '成片合成', status: 'running', progress: 35 })
    expect(groups[1]!.title).toBe('台词翻译')
  })
})
