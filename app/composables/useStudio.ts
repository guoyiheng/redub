import type { Project, Job, Channel, Settings, ProjectDetail } from '../../shared/types'
export const mediaUrl = (path: string | null | undefined, download = false) =>
  path ? `/api/media?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}` : ''
export const formatTime = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(1).padStart(4, '0')}`
export function useStudio() {
  const projects = useState<Project[]>('projects', () => [])
  const jobs = useState<Job[]>('jobs', () => [])
  const channels = useState<Channel[]>('channels', () => [])
  const settings = useState<Settings>('settings', () => ({
    concurrency: 2,
    pauseOnFailure: true,
    whisperModel: 'small'
  }))
  const selected = useState<string | null>('selected', () => null)
  const detail = useState<ProjectDetail | null>('detail', () => null)
  const toast = useToast()
  const errorMessage = (error: unknown) => {
    const e = error as { data?: { statusMessage?: string }; message?: string }
    return e.data?.statusMessage || e.message || '操作失败，请重试'
  }
  async function refresh() {
    const id = selected.value
    const [p, j, c, s, d] = await Promise.all([
      $fetch<Project[]>('/api/projects'),
      $fetch<Job[]>('/api/jobs'),
      $fetch<Channel[]>('/api/channels'),
      $fetch<Settings>('/api/settings'),
      id ? $fetch<ProjectDetail>(`/api/projects/${id}`) : Promise.resolve(null)
    ])
    projects.value = p
    jobs.value = j
    channels.value = c
    settings.value = s
    if (id === selected.value) detail.value = d
  }
  async function select(id: string) {
    selected.value = id
    detail.value = null
    await navigateTo({ path: '/', query: { project: id } })
    await refresh()
  }
  async function act(fn: () => Promise<unknown>, message?: string) {
    try {
      await fn()
      await refresh()
      if (message) toast.add({ title: message, color: 'success' })
      return true
    } catch (error) {
      toast.add({ title: '未能完成操作', description: errorMessage(error), color: 'error', duration: 9000 })
      return false
    }
  }
  return { projects, jobs, channels, settings, selected, detail, refresh, select, act, errorMessage }
}
