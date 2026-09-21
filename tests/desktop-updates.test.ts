import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDesktopUpdater } = require('../electron/desktop-update.cjs')

function fixture(options: { packaged?: boolean; updateUrl?: string } = {}) {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => {
      updater.emit('update-available', { version: '0.2.0' })
      return { updateInfo: { version: '0.2.0' } }
    }),
    downloadUpdate: vi.fn(async () => {
      updater.emit('update-downloaded', { version: '0.2.0' })
      return ['update.zip']
    }),
    quitAndInstall: vi.fn()
  })
  const onState = vi.fn()
  const controller = createDesktopUpdater({
    autoUpdater: updater,
    currentVersion: '0.1.0',
    packaged: true,
    updateUrl: 'https://example.test/updates',
    onState,
    ...options
  })
  return { controller, updater, onState }
}

describe('桌面应用分阶段更新', () => {
  it('检查、下载和重启安装需要分别触发', async () => {
    const { controller, updater } = fixture()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(await controller.update('status')).toMatchObject({ currentVersion: '0.1.0', state: 'idle' })
    await controller.update('download')
    await controller.update('install')
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect((await controller.update('check')).state).toBe('available')
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect((await controller.update('download')).state).toBe('downloaded')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    // Checking again must preserve the downloaded package and installation action.
    expect((await controller.update('check')).state).toBe('downloaded')
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect((await controller.update('install')).state).toBe('installing')
    await controller.update('install')
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('遵循更新器的版本判断，不把旧版本当成更新', async () => {
    const { controller, updater } = fixture()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-not-available', { version: '0.0.9' })
      return { updateInfo: { version: '0.0.9' } }
    })
    expect(await controller.update('check')).toMatchObject({ state: 'current', availableVersion: null })
    await controller.update('download')
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('立即展示下载状态，重复操作不会破坏下载或重复发起请求', async () => {
    const { controller, updater } = fixture()
    await controller.update('check')
    let finish!: (files: string[]) => void
    updater.downloadUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const downloading = controller.update('download')
    expect((await controller.update('status')).state).toBe('downloading')
    updater.emit('download-progress', { percent: 42.3 })
    expect((await controller.update('status')).progress).toBe(42)
    await controller.update('download')
    await controller.update('check')
    await controller.update('install')
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    updater.emit('update-downloaded', { version: '0.2.0' })
    finish(['update.zip'])
    expect((await downloading).state).toBe('downloaded')
  })

  it('下载失败可直接重试，没有完成事件时不能安装', async () => {
    const { controller, updater } = fixture()
    await controller.update('check')
    updater.downloadUpdate.mockRejectedValueOnce(new Error('offline'))
    expect(await controller.update('download')).toMatchObject({
      state: 'available',
      availableVersion: '0.2.0'
    })
    updater.downloadUpdate.mockResolvedValueOnce([])
    expect((await controller.update('download')).state).toBe('available')
    await controller.update('install')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect((await controller.update('download')).state).toBe('downloaded')
  })

  it('检查失败后支持重试；同时检查只发送一次请求', async () => {
    const { controller, updater } = fixture()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    const first = controller.update('check')
    await controller.update('check')
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect((await first).state).toBe('error')
    expect((await controller.update('check')).state).toBe('available')
  })

  it('开发版或未配置更新源时不会发起下载', async () => {
    for (const options of [{ packaged: false }, { updateUrl: '' }]) {
      const { controller, updater } = fixture(options)
      expect((await controller.update('status')).currentVersion).toBe('0.1.0')
      expect((await controller.update('check')).state).toBe('unsupported')
      expect((await controller.update('download')).state).toBe('unsupported')
      expect(updater.checkForUpdates).not.toHaveBeenCalled()
      expect(updater.downloadUpdate).not.toHaveBeenCalled()
    }
  })
})
