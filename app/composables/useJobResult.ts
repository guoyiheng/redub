import type { JobDetail } from '../../shared/types'

/** Reconnect to a persisted task; aborting this wait never cancels server execution. */
export async function waitForJobResult<T>(id: string, signal?: AbortSignal): Promise<T> {
  for (;;) {
    signal?.throwIfAborted()
    const detail = await $fetch<JobDetail>(`/api/jobs/${id}`, { signal })
    if (detail.job.status === 'completed') return detail.result as T
    if (detail.job.status === 'failed')
      throw new Error(detail.job.error || '任务执行失败，可在任务详情中重试')
    if (detail.job.status === 'skipped') throw new Error('任务已跳过')
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        reject(signal?.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }, 1000)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}
