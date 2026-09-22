import type { Job, JobStatus, Stage } from './types'

const prepareStages = new Set<Stage>(['extract', 'separate', 'segment', 'transcribe'])
const renderStages = new Set<Stage>(['mix', 'preview'])

export type TaskGroupKind = 'prepare' | 'translate' | 'synthesize' | 'render' | 'export' | 'preview-tracks'

export interface TaskGroup {
  id: string
  kind: TaskGroupKind
  projectId: string
  title: string
  status: JobStatus
  progress: number
  message: string
  error: string | null
  currentStage: Stage | null
  jobs: Job[]
}

function kindOf(stage: Stage): TaskGroupKind {
  if (prepareStages.has(stage)) return 'prepare'
  if (stage === 'translate') return 'translate'
  if (stage === 'synthesize') return 'synthesize'
  if (stage === 'export' || stage === 'preview-tracks') return stage
  if (renderStages.has(stage)) return 'render'
  throw new Error(`未知任务阶段：${stage}`)
}

function titleOf(kind: TaskGroupKind, size: number) {
  if (kind === 'prepare') return '素材预处理'
  if (kind === 'translate') return '台词翻译'
  if (kind === 'render') return '成片合成'
  if (kind === 'export') return '导出成片'
  if (kind === 'preview-tracks') return '准备预览音轨'
  return size > 1 ? '批量配音' : '单句配音'
}

export function isActiveTask(status: JobStatus) {
  return status === 'queued' || status === 'running'
}

function byLatestUpdate(a: Job, b: Job) {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)
}

function statusOf(jobs: Job[]): JobStatus {
  if (jobs.some((job) => job.status === 'running')) return 'running'
  if (jobs.some((job) => job.status === 'queued')) return 'queued'
  if (jobs.some((job) => job.status === 'failed')) return 'failed'
  if (jobs.some((job) => job.status === 'cancelled')) return 'cancelled'
  if (jobs.every((job) => job.status === 'skipped')) return 'skipped'
  return 'completed'
}

function progressOf(jobs: Job[]) {
  const total = jobs.reduce((sum, job) => {
    if (job.status === 'completed' || job.status === 'skipped') return sum + 100
    return sum + Math.min(100, Math.max(0, job.progress))
  }, 0)
  return Math.round(total / Math.max(1, jobs.length))
}

function currentJobOf(jobs: Job[]) {
  return (
    jobs.filter((job) => job.status === 'running').sort(byLatestUpdate)[0] ||
    jobs.filter((job) => job.status === 'failed').sort(byLatestUpdate)[0] ||
    jobs.filter((job) => job.status === 'queued').sort(byLatestUpdate)[0] ||
    [...jobs].sort(byLatestUpdate)[0] ||
    null
  )
}

/**
 * 同一批次的并行任务合并展示，旧版本按依赖链分组，手动单句彼此独立。
 */
export function groupJobs(allJobs: Job[], recentLimit = 8): TaskGroup[] {
  const jobs = [...allJobs].sort(byLatestUpdate)
  const byId = new Map(jobs.map((job) => [job.id, job]))
  const parent = new Map(jobs.map((job) => [job.id, job.id]))

  const find = (id: string): string => {
    const current = parent.get(id)
    if (!current || current === id) return id
    const root = find(current)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootB, rootA)
  }

  const batches = new Map<string, string>()
  for (const job of jobs) {
    if (job.batchId) {
      const key = `${job.projectId}:${kindOf(job.stage)}:${job.batchId}`
      const first = batches.get(key)
      if (first) union(job.id, first)
      else batches.set(key, job.id)
    }
    if (!job.dependsOn) continue
    const dependency = byId.get(job.dependsOn)
    if (!dependency || dependency.projectId !== job.projectId) continue
    if (kindOf(dependency.stage) !== kindOf(job.stage)) continue
    union(job.id, dependency.id)
  }

  const components = new Map<string, Job[]>()
  for (const job of jobs) {
    const root = find(job.id)
    const component = components.get(root) || []
    component.push(job)
    components.set(root, component)
  }

  const groups = [...components.values()].map((component): TaskGroup => {
    const jobs = [...component].sort(byLatestUpdate)
    const kind = kindOf(jobs[0]!.stage)
    const current = currentJobOf(jobs)
    const failures = jobs.filter((job) => job.status === 'failed')
    return {
      id: `${kind}:${jobs[0]!.projectId}:${
        jobs[0]!.batchId ||
        jobs
          .map((job) => job.id)
          .sort()
          .join(':')
      }`,
      kind,
      projectId: jobs[0]!.projectId,
      title: titleOf(kind, jobs.length),
      status: statusOf(jobs),
      progress: progressOf(jobs),
      message: current?.message || '等待执行',
      error:
        failures
          .map((job) => job.error || job.message)
          .filter(Boolean)
          .slice(0, 2)
          .join('；') || null,
      currentStage: current?.stage || null,
      jobs
    }
  })

  const active = groups
    .filter((group) => isActiveTask(group.status))
    .sort((a, b) => {
      const rank = { running: 0, queued: 1 } as const
      const statusDiff =
        (rank[a.status as keyof typeof rank] ?? 2) - (rank[b.status as keyof typeof rank] ?? 2)
      return statusDiff || byLatestUpdate(a.jobs[0]!, b.jobs[0]!)
    })
  const recent = groups
    .filter((group) => !isActiveTask(group.status))
    .sort((a, b) => byLatestUpdate(a.jobs[0]!, b.jobs[0]!))
    .slice(0, recentLimit)

  return [...active, ...recent]
}
