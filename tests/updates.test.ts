import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const { verifyBundle, installWebUpdate } = require('../electron/web-update.cjs')
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
function envelope(version = '0.1.1', path = 'index.html') {
  const bytes = Buffer.from('<h1>ReDub updated</h1>')
  const payload = Buffer.from(
    JSON.stringify({
      version,
      minDesktopVersion: '0.1.0',
      files: [
        { path, data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }
      ]
    })
  )
  return {
    payload: payload.toString('base64'),
    signature: sign(null, payload, privateKey).toString('base64')
  }
}
describe('网页热更新', () => {
  it('验证签名、桌面兼容版本和包内路径', () => {
    expect(verifyBundle(envelope(), publicPem, '0.1.0').version).toBe('0.1.1')
    expect(() =>
      verifyBundle({ ...envelope(), signature: Buffer.alloc(64).toString('base64') }, publicPem, '0.1.0')
    ).toThrow('签名')
    expect(() => verifyBundle(envelope(), publicPem, '0.0.9')).toThrow('桌面')
    expect(() => verifyBundle(envelope('0.1.1', '../index.html'), publicPem, '0.1.0')).toThrow()
  })
  it('安装完整资源后原子切换，拒绝回退且失败保留现版本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redub-web-'))
    try {
      const options = {
        root,
        url: 'https://example.test/web.json',
        publicKey: publicPem,
        desktopVersion: '0.1.0',
        fetcher: async () => new Response(JSON.stringify(envelope()))
      }
      expect((await installWebUpdate(options)).updated).toBe(true)
      const first = await readFile(join(root, 'current.json'), 'utf8')
      const pointer = JSON.parse(first)
      expect(await readFile(join(root, pointer.directory, 'index.html'), 'utf8')).toContain('ReDub updated')
      expect((await installWebUpdate(options)).updated).toBe(false)
      await expect(
        installWebUpdate({ ...options, fetcher: async () => new Response('{}') })
      ).rejects.toThrow()
      expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(first)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
