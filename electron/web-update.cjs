const { verify, createHash } = require('node:crypto')
const { mkdir, readFile, writeFile, rename, rm } = require('node:fs/promises')
const { dirname, join } = require('node:path')
function compareVersions(a, b) {
  const av = a.split('.').map(Number),
    bv = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((av[i] || 0) !== (bv[i] || 0)) return (av[i] || 0) - (bv[i] || 0)
  return 0
}
function verifyBundle(envelope, publicKey, desktopVersion) {
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string')
    throw new Error('更新包格式不正确')
  const bytes = Buffer.from(envelope.payload, 'base64')
  const key = publicKey.includes('BEGIN PUBLIC KEY') ? publicKey : Buffer.from(publicKey, 'base64').toString()
  if (!verify(null, bytes, key, Buffer.from(envelope.signature, 'base64')))
    throw new Error('更新签名无效，已保留当前界面')
  const bundle = JSON.parse(bytes)
  if (!/^\d+\.\d+\.\d+$/.test(bundle.version) || !/^\d+\.\d+\.\d+$/.test(bundle.minDesktopVersion))
    throw new Error('更新版本格式无效')
  if (compareVersions(desktopVersion, bundle.minDesktopVersion) < 0)
    throw new Error('此界面需要先更新桌面应用')
  if (
    !Array.isArray(bundle.files) ||
    !bundle.files.some((f) => f.path === 'index.html') ||
    bundle.files.length > 5000
  )
    throw new Error('更新包缺少首页或文件数超限')
  const seen = new Set()
  let total = 0
  for (const file of bundle.files) {
    if (
      typeof file.path !== 'string' ||
      !/^[a-zA-Z0-9_./-]+$/.test(file.path) ||
      file.path.startsWith('/') ||
      file.path.split('/').some((p) => !p || p === '.' || p === '..') ||
      seen.has(file.path)
    )
      throw new Error('更新包包含无效路径')
    if (typeof file.data !== 'string') throw new Error('更新文件数据无效')
    seen.add(file.path)
    const content = Buffer.from(file.data, 'base64')
    total += content.length
    if (total > 60 * 1024 ** 2 || createHash('sha256').update(content).digest('hex') !== file.sha256)
      throw new Error('更新包校验失败或体积超限')
  }
  return bundle
}
let installing
async function installWebUpdate(options) {
  if (installing) return installing
  installing = install(options).finally(() => {
    installing = undefined
  })
  return installing
}
async function install({ url, publicKey, root, desktopVersion, fetcher = fetch }) {
  if (!url || !publicKey) return { updated: false, message: '尚未配置网页更新地址与签名公钥。' }
  if (!url.startsWith('https://')) throw new Error('网页更新源必须使用 HTTPS')
  const response = await fetcher(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`下载网页更新失败 (${response.status})`)
  if (Number(response.headers.get('content-length')) > 120 * 1024 ** 2) throw new Error('更新包过大')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 120 * 1024 ** 2) throw new Error('更新包过大')
    chunks.push(chunk)
  }
  const bundle = verifyBundle(JSON.parse(Buffer.concat(chunks).toString()), publicKey, desktopVersion)
  const current = JSON.parse(await readFile(join(root, 'current.json'), 'utf8').catch(() => '{}'))
  if (current.version && compareVersions(bundle.version, current.version) <= 0)
    return { updated: false, message: '网页界面已是最新版本。' }
  const name = `web-${bundle.version}-${Date.now()}`,
    dir = join(root, name)
  await mkdir(dir, { recursive: true })
  try {
    for (const file of bundle.files) {
      const target = join(dir, file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(file.data, 'base64'))
    }
    const manifest = { version: bundle.version, directory: name, previous: current.directory || null }
    await writeFile(join(root, 'current.tmp'), JSON.stringify(manifest))
    await rename(join(root, 'current.tmp'), join(root, 'current.json'))
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return { updated: true, message: `网页界面已更新至 ${bundle.version}。` }
}
module.exports = { installWebUpdate, verifyBundle, compareVersions }
