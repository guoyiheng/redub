import type { Job, Stage } from './types'

const prepare = new Set<Stage>(['extract', 'separate', 'segment', 'transcribe'])

/** 逐句任务只锁定自己使用的片段；预览快照不阻塞新任务。 */
export function segmentTaskReason(jobs: Job[], segmentId: string) {
  const active = jobs.filter((job) => ['queued', 'running'].includes(job.status))
  if (active.some((job) => !['translate', 'synthesize', 'preview-tracks'].includes(job.stage)))
    return '项目素材正在处理中，请完成后核对台词'
  const current = active.find(
    (job) =>
      ['translate', 'synthesize'].includes(job.stage) && (!job.segmentId || job.segmentId === segmentId)
  )
  return current
    ? `这句${current.stage === 'translate' ? '翻译' : '配音'}任务已在排队或处理中，请完成并核对后再操作`
    : ''
}

/** 依赖只能串联同一次手动操作的内部步骤。 */
export function canChainStages(parent: Stage, next: Stage) {
  return (
    parent === next || (prepare.has(parent) && prepare.has(next)) || (parent === 'mix' && next === 'preview')
  )
}

/** 旧全流程链中的后续步骤及其后代都需取消，不能因跳过或重试而解锁。 */
export function automaticFollowups(all: Job[]) {
  const byId = new Map(all.map((job) => [job.id, job]))
  const children = new Map<string, string[]>()
  const blocked = new Set<string>()
  for (const job of all) {
    if (job.status === 'cancelled') blocked.add(job.id)
    if (!job.dependsOn) continue
    const parent = byId.get(job.dependsOn)
    if (!parent || parent.projectId !== job.projectId || !canChainStages(parent.stage, job.stage))
      blocked.add(job.id)
    const siblings = children.get(job.dependsOn) || []
    siblings.push(job.id)
    children.set(job.dependsOn, siblings)
  }
  const pending = [...blocked]
  for (let i = 0; i < pending.length; i++) {
    for (const id of children.get(pending[i]!) || []) {
      if (blocked.has(id)) continue
      blocked.add(id)
      pending.push(id)
    }
  }
  return blocked
}
