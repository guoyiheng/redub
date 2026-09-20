import { readFile, readdir, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, sign } from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version || '') || !process.env.REDUB_WEB_PRIVATE_KEY_FILE)
  throw new Error('用法：REDUB_WEB_PRIVATE_KEY_FILE=/path/key.pem npm run web:bundle -- 0.1.1')
const port = await new Promise((resolvePort) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolvePort(p))
  })
})
const temp = await mkdtemp(join(tmpdir(), 'redub-bundle-'))
const server = spawn(process.execPath, ['.output/server/index.mjs'], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    NITRO_HOST: '127.0.0.1',
    PORT: String(port),
    NITRO_PORT: String(port),
    REDUB_DATA_DIR: temp,
    REDUB_WEB_DIR: ''
  },
  stdio: 'ignore'
})
try {
  let html
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (response.ok) {
        html = await response.text()
        break
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!html) throw new Error('无法生成生产版首页，请先运行 npm run build')
  const files = []
  function add(path, bytes) {
    files.push({
      path,
      data: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  }
  add('index.html', Buffer.from(html))
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix + entry.name
      if (entry.isDirectory()) await walk(join(dir, entry.name), path + '/')
      else if (entry.isFile()) add(path, await readFile(join(dir, entry.name)))
    }
  }
  await walk(resolve('.output/public'))
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  const payload = Buffer.from(JSON.stringify({ version, minDesktopVersion: pkg.version, files }))
  const signature = sign(null, payload, await readFile(process.env.REDUB_WEB_PRIVATE_KEY_FILE)).toString(
    'base64'
  )
  await mkdir('release', { recursive: true })
  await writeFile(
    `release/web-${version}.json`,
    JSON.stringify({ payload: payload.toString('base64'), signature })
  )
  console.log(`网页更新包已生成：release/web-${version}.json`)
} finally {
  server.kill()
  await new Promise((r) => server.once('exit', r))
  await rm(temp, { recursive: true, force: true })
}
