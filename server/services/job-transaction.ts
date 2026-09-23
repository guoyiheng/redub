import { db } from '../db'
import { checkJobCancelled } from './job-context'

/** Roll back publication if cancellation arrives while a write is awaiting SQLite. */
export function jobTransaction<T>(
  write: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>
) {
  checkJobCancelled()
  return db.transaction(async (tx) => {
    checkJobCancelled()
    const result = await write(tx)
    checkJobCancelled()
    return result
  })
}
