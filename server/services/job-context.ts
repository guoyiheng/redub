import { AsyncLocalStorage } from 'node:async_hooks'

export const jobContext = new AsyncLocalStorage<{ id: string; attempt: number; signal?: AbortSignal }>()
export function checkJobCancelled() {
  jobContext.getStore()?.signal?.throwIfAborted()
}
