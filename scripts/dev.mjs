import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import electronPath from 'electron'

const root = resolve(import.meta.dirname, '..')
const host = '127.0.0.1'
// Reserve an available port so another local service cannot be mistaken for this app.
const socket = createServer()
await new Promise((resolveListen, reject) => {
  socket.once('error', reject)
  socket.listen(Number(process.env.NUXT_PORT || 0), host, resolveListen)
})
const port = socket.address().port
await new Promise((resolveClose) => socket.close(resolveClose))
const url = `http://${host}:${port}`
const children = []
let stopping = false

function launch(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' })
  const exited = new Promise((resolveExit) => {
    child.once('error', (error) => {
      console.error(error.message)
      resolveExit(1)
    })
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)))
  })
  children.push({ child, exited })
  void exited.then((code) => stop(code))
  return child
}

async function stop(code = 0) {
  if (stopping) return
  stopping = true
  const live = children.filter(({ child }) => child.exitCode === null && child.signalCode === null)
  for (const { child } of live) child.kill('SIGTERM')
  const timeout = setTimeout(() => {
    for (const { child } of live) child.kill('SIGKILL')
    process.exit(code)
  }, 5000)
  await Promise.all(children.map(({ exited }) => exited))
  clearTimeout(timeout)
  process.exit(code)
}

process.once('SIGINT', () => void stop(130))
process.once('SIGTERM', () => void stop(143))
launch(
  process.execPath,
  [
    resolve(root, 'node_modules/nuxt/bin/nuxt.mjs'),
    'dev',
    '--no-fork',
    '--host',
    host,
    '--port',
    String(port)
  ],
  {
    ...process.env,
    HOST: host,
    NUXT_HOST: host,
    NUXT_PORT: String(port)
  }
)

try {
  let ready = false
  for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
    try {
      const response = await fetch(`${url}/api/settings`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      // Wait for the local API before opening Electron.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  if (!stopping) {
    if (!ready) throw new Error('开发服务启动超时')
    launch(electronPath, ['.'], { ...process.env, REDUB_DEV_URL: url })
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  await stop(1)
}
