import { describe, it, expect } from 'vitest'
import { parseScript, subtitleText } from '../server/services/text'
import { eligibleJobs, workflowStages } from '../server/services/queue'
import { tempoFilters } from '../server/services/media'
import { safeError } from '../server/services/providers'
import type { Job, Stage } from '../shared/types'
function job(
  id: string,
  projectId: string,
  dependsOn: string | null = null,
  status: Job['status'] = 'queued'
): Job {
  return {
    id,
    projectId,
    dependsOn,
    status,
    stage: 'translate',
    segmentId: null,
    progress: 0,
    message: '',
    error: null,
    attempts: 0,
    createdAt: 0,
    updatedAt: 0
  }
}
describe('文本与字幕', () => {
  it('按行导入并分配连续的可编辑时间', () => {
    const lines = parseScript('Hello world.\n你好，世界。')
    expect(lines).toHaveLength(2)
    expect(lines[1]!.start).toBe(lines[0]!.end)
  })
  it('保留 SRT 的时间戳和多行台词', () => {
    const s = parseScript('1\n00:00:01,200 --> 00:00:03,450\nHello\nworld')
    expect(s).toEqual([{ start: 1.2, end: 3.45, text: 'Hello\nworld' }])
    expect(subtitleText(s)).toContain('00:00:01,200 --> 00:00:03,450')
  })
  it('支持 VTT 并拒绝重叠或无效时间', () => {
    expect(parseScript('WEBVTT\n\n00:01.000 --> 00:03.000\nHi')[0]!.start).toBe(1)
    expect(() => parseScript('1\n00:00:03,000 --> 00:00:01,000\nHi')).toThrow()
    expect(() => parseScript('')).toThrow()
    expect(() =>
      parseScript('1\n00:00:01,000 --> 00:00:04,000\nA\n\n2\n00:00:03,000 --> 00:00:05,000\nB')
    ).toThrow('重叠')
  })
})
describe('任务调度', () => {
  it.each<[Stage, Stage]>([
    ['transcribe', 'translate'],
    ['translate', 'synthesize'],
    ['synthesize', 'mix'],
    ['preview', 'export']
  ])('%s 完成或跳过后不会自动启动 %s', (parent, next) => {
    for (const status of ['completed', 'skipped'] as const) {
      const tasks = [
        { ...job('a', 'p1', null, status), stage: parent },
        { ...job('b', 'p1', 'a'), stage: next },
        { ...job('c', 'p1', 'b'), stage: next }
      ]
      expect(eligibleJobs(tasks, new Set(), new Set(), 4)).toEqual([])
      tasks[1]!.status = 'completed'
      expect(eligibleJobs(tasks, new Set(), new Set(), 4)).toEqual([])
    }
  })
  it.each<[Stage, Stage]>([
    ['extract', 'separate'],
    ['segment', 'transcribe'],
    ['synthesize', 'synthesize'],
    ['mix', 'preview']
  ])('同一手动操作内的 %s → %s 正常执行', (parent, next) => {
    const tasks = [
      { ...job('a', 'p1', null, 'completed'), stage: parent },
      { ...job('b', 'p1', 'a'), stage: next }
    ]
    expect(eligibleJobs(tasks, new Set(), new Set(), 4).map((job) => job.id)).toEqual(['b'])
  })
  it('取消的依赖和跨项目依赖不能解锁后续任务', () => {
    const tasks = [
      job('a', 'p1', null, 'cancelled'),
      job('b', 'p1', 'a'),
      job('c', 'p2', null, 'completed'),
      job('d', 'p1', 'c')
    ]
    expect(eligibleJobs(tasks, new Set(), new Set(), 4)).toEqual([])
  })
  it('默认流程仅包含本机处理，文本不自动启动付费任务', () => {
    expect(workflowStages('video')).toEqual(['extract', 'separate', 'segment', 'transcribe'])
    expect(workflowStages('audio')).toEqual(['separate', 'segment', 'transcribe'])
    expect(workflowStages('text')).toEqual([])
  })
  it('全局限制并发，不再串行化同项目任务', () => {
    expect(
      eligibleJobs(
        [job('a', 'p1'), job('b', 'p1'), job('c', 'p2'), job('d', 'p3')],
        new Set(),
        new Set(),
        2
      ).map((j) => j.id)
    ).toEqual(['a', 'b'])
  })
  it('暂停、运行中的项目和失败依赖不启动', () => {
    const tasks = [job('a', 'p1', null, 'failed'), job('b', 'p1', 'a'), job('c', 'p2'), job('d', 'p3')]
    expect(eligibleJobs(tasks, new Set(['p2']), new Set(['d']), 4)).toEqual([])
  })
  it('跳过和成功后解锁依赖，缺失依赖仍阻塞', () => {
    const tasks = [job('a', 'p1', null, 'skipped'), job('b', 'p1', 'a'), job('c', 'p2', 'missing')]
    expect(eligibleJobs(tasks, new Set(), new Set(), 4).map((j) => j.id)).toEqual(['b'])
  })
})
it('长短配音均使用不改变音高的合法倍速链', () => {
  for (const ratio of [0.08, 0.4, 1, 4, 20]) {
    const values = tempoFilters(ratio)
      .split(',')
      .map((s) => Number(s.split('=')[1]))
    expect(values.every((v) => v >= 0.5 && v <= 2)).toBe(true)
    expect(values.reduce((a, b) => a * b, 1)).toBeCloseTo(ratio, 5)
  }
})
it('错误详情中隐藏密钥', () => {
  expect(safeError(new Error(`rejected ${process.env.VOLCENGINE_API_KEY}`))).toBe('rejected [已隐藏]')
})
