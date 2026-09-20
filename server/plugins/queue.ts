import { startQueue, stopQueue } from '../services/queue'
export default defineNitroPlugin(async nitro => {
  await startQueue()
  nitro.hooks.hook('close', () => stopQueue())
})
