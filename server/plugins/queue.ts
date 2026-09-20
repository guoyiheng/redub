import { startQueue, stopQueue } from '../services/queue'
import { stopMediaProcesses } from '../services/media'
export default defineNitroPlugin(async (nitro) => {
  await startQueue()
  nitro.hooks.hook('close', () => {
    stopQueue()
    stopMediaProcesses()
  })
})
