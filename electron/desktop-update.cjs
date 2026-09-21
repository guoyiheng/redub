/** Keep checking, downloading and installing as separate user actions. */
function createDesktopUpdater({ autoUpdater, currentVersion, packaged, updateUrl, onState }) {
  let state = {
    currentVersion,
    state: 'idle',
    availableVersion: null,
    progress: null,
    message: '',
    packaged,
    configured: !!updateUrl
  }
  let pending
  let ready = false
  const publish = (patch) => {
    state = { ...state, ...patch }
    onState?.(state)
    return state
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('update-available', (info) =>
    publish({ state: 'available', availableVersion: info.version, progress: null, message: '' })
  )
  autoUpdater.on('update-not-available', () =>
    publish({ state: 'current', availableVersion: null, progress: null, message: '当前已是最新版本。' })
  )
  autoUpdater.on('download-progress', ({ percent }) => {
    if (state.state !== 'downloading') return
    publish({ progress: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0 })
  })
  autoUpdater.on('update-downloaded', (info) => {
    ready = true
    publish({ state: 'downloaded', availableVersion: info.version, progress: 100, message: '' })
  })
  autoUpdater.on('error', () => {
    ready = false
    publish({
      state: state.state === 'downloading' ? 'available' : 'error',
      progress: null,
      message: '更新失败，请检查网络后重试。'
    })
  })
  if (updateUrl) {
    if (!updateUrl.startsWith('https://')) throw new Error('更新地址必须使用 HTTPS')
    autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl })
  }

  async function perform(action) {
    if (action === 'check') {
      ready = false
      publish({ state: 'checking', availableVersion: null, progress: null, message: '正在检查更新…' })
      try {
        await autoUpdater.checkForUpdates()
        // The updater decides availability using semantic versions and release policy.
        // Comparing version strings here would incorrectly offer older releases.
        if (state.state === 'checking') throw new Error('未返回更新信息')
        return state
      } catch {
        return publish({ state: 'error', message: '检查更新失败，请检查网络后重试。' })
      }
    }
    publish({ state: 'downloading', progress: 0, message: '' })
    try {
      await autoUpdater.downloadUpdate()
      if (!ready) throw new Error('下载未完成验证')
      return state
    } catch {
      return publish({
        state: 'available',
        progress: null,
        message: '下载更新失败，请重试。'
      })
    }
  }

  return {
    async update(action) {
      if (!['status', 'check', 'download', 'install'].includes(action)) throw new Error('未知更新操作')
      if (action === 'status') return state
      if (!packaged || !updateUrl)
        return publish({
          state: 'unsupported',
          message: !packaged
            ? '开发模式不执行桌面更新，请使用安装版验证。'
            : '当前安装包未配置桌面更新源，请联系发布者。'
        })
      if (pending || state.state === 'installing') return state
      if (action === 'install') {
        if (!ready || state.state !== 'downloaded') return state
        publish({ state: 'installing', message: '正在重启并安装…' })
        try {
          autoUpdater.quitAndInstall()
        } catch {
          return publish({ state: 'downloaded', message: '无法重启安装，请重试。' })
        }
        return state
      }
      if (ready) return state
      if (action === 'download' && (state.state !== 'available' || !state.availableVersion)) return state
      pending = perform(action)
      try {
        return await pending
      } finally {
        pending = undefined
      }
    }
  }
}

module.exports = { createDesktopUpdater }
