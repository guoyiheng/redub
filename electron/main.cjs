const { app, BrowserWindow, ipcMain, utilityProcess, session, dialog, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const { randomBytes } = require('node:crypto')
const { mkdirSync, existsSync, writeFileSync, appendFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const net = require('node:net')
const { installWebUpdate } = require('./web-update.cjs')
const { installModels, modelPython } = require('./models.cjs')
let mainWindow,
  server,
  localOrigin,
  quitting = false,
  updateReady = false,
  desktopUpdateState = {
    currentVersion: '',
    state: 'idle',
    availableVersion: null,
    progress: null,
    message: '',
    packaged: false,
    configured: false
  },
  desktopDownload
const devUrl = process.env.REDUB_DEV_URL
const root = app.isPackaged ? process.resourcesPath : resolve(__dirname, '..')
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox('ReDub 启动失败', error.message)
      app.quit()
    })
}
function freePort() {
  return new Promise((resolvePort, reject) => {
    const socket = net.createServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port
      socket.close(() => resolvePort(port))
    })
  })
}
function publishUpdateState(patch = {}) {
  desktopUpdateState = { ...desktopUpdateState, ...patch }
  mainWindow?.webContents.send('redub:update-status', desktopUpdateState)
  return desktopUpdateState
}
async function start() {
  const userDir = app.getPath('userData')
  mkdirSync(userDir, { recursive: true })
  const envFile = join(userDir, '.env')
  if (!existsSync(envFile))
    writeFileSync(
      envFile,
      '# 填写后重启 ReDub；请勿分享本文件。\nVOLCENGINE_API_KEY=\nTRANSLATION_API_KEY=\n# REDUB_PYTHON=/absolute/path/to/.venv/bin/python\n',
      { mode: 0o600 }
    )
  if (process.loadEnvFile) {
    if (!app.isPackaged && existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'))
    process.loadEnvFile(envFile)
  }
  if (!process.env.REDUB_PYTHON && existsSync(modelPython(userDir)))
    process.env.REDUB_PYTHON = modelPython(userDir)
  if (devUrl) {
    const parsed = new URL(devUrl)
    if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(parsed.hostname))
      throw new Error('开发地址必须为本机 HTTP 地址')
    localOrigin = parsed.origin
  } else {
    const port = await freePort(),
      token = randomBytes(32).toString('hex')
    localOrigin = `http://127.0.0.1:${port}`
    const binaryRoot = app.isPackaged ? join(root, 'bin') : null
    const env = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(port),
      REDUB_DATA_DIR: join(userDir, 'data'),
      REDUB_SESSION_TOKEN: token,
      REDUB_SCRIPTS_DIR: join(root, 'scripts'),
      REDUB_WEB_DIR: join(userDir, 'web-updates')
    }
    if (binaryRoot) {
      env.REDUB_FFMPEG = join(binaryRoot, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
      env.REDUB_FFPROBE = join(binaryRoot, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    }
    server = utilityProcess.fork(join(root, '.output/server/index.mjs'), [], {
      env,
      cwd: root,
      stdio: 'pipe',
      serviceName: 'ReDub Local Server'
    })
    server.stderr.on('data', (data) => {
      let message = String(data)
      for (const [key, value] of Object.entries(env))
        if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key) && value && value.length > 3)
          message = message.replaceAll(value, '[redacted]')
      appendFileSync(join(userDir, 'server.log'), message)
    })
    server.on('exit', (code) => {
      if (!quitting && code !== 0) {
        dialog.showErrorBox('本地服务已退出', '请重启应用，未完成任务可在任务管理器中重试。')
        app.quit()
      }
    })
    await session.defaultSession.cookies.set({
      url: localOrigin,
      name: 'redub-session',
      value: token,
      httpOnly: true,
      sameSite: 'strict'
    })
    let ready = false
    for (let n = 0; n < 120; n++) {
      try {
        const r = await fetch(`${localOrigin}/api/settings`, {
          headers: { Cookie: `redub-session=${token}` },
          signal: AbortSignal.timeout(500)
        })
        if (r.ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!ready) throw new Error('本地服务启动超时，请检查本地 server.log')
  }
  desktopUpdateState = {
    ...desktopUpdateState,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    configured: !!process.env.REDUB_UPDATE_URL
  }
  createWindow()
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () =>
    publishUpdateState({
      state: 'checking',
      availableVersion: null,
      progress: null,
      message: '正在检查更新…'
    })
  )
  autoUpdater.on('update-available', (info) =>
    publishUpdateState({
      state: 'available',
      availableVersion: info.version,
      progress: null,
      message: `发现新版本 ${info.version}，可以下载更新。`
    })
  )
  autoUpdater.on('update-not-available', () =>
    publishUpdateState({
      state: 'current',
      availableVersion: null,
      progress: null,
      message: '当前已是最新版本。'
    })
  )
  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent)
    publishUpdateState({
      state: 'downloading',
      progress: percent,
      message: `正在下载更新 ${percent}%`
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true
    publishUpdateState({
      state: 'downloaded',
      availableVersion: info.version,
      progress: 100,
      message: `版本 ${info.version} 已下载，可以重启安装。`
    })
  })
  autoUpdater.on('error', () =>
    publishUpdateState({
      state: 'error',
      progress: null,
      message: '更新失败，请检查网络后重试。'
    })
  )
  if (process.env.REDUB_UPDATE_URL) {
    if (!process.env.REDUB_UPDATE_URL.startsWith('https://')) throw new Error('更新地址必须使用 HTTPS')
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.REDUB_UPDATE_URL })
  }
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 780,
    minHeight: 620,
    backgroundColor: '#f5f4ed',
    title: 'ReDub · 配音工作室',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== localOrigin) event.preventDefault()
  })
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  mainWindow.loadURL(localOrigin)
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
}
ipcMain.handle('redub:update', async (event, action) => {
  if (!event.senderFrame || new URL(event.senderFrame.url).origin !== localOrigin) throw new Error('无效来源')
  if (action === 'models') return installModels(app.getPath('userData'), root)
  if (action === 'web') {
    const result = await installWebUpdate({
      url: process.env.REDUB_WEB_UPDATE_URL,
      publicKey: process.env.REDUB_WEB_PUBLIC_KEY,
      root: join(app.getPath('userData'), 'web-updates'),
      desktopVersion: app.getVersion()
    })
    if (result.updated) mainWindow?.reload()
    return result.message
  }
  if (action === 'status') return desktopUpdateState
  if (!process.env.REDUB_UPDATE_URL)
    return publishUpdateState({
      state: 'unsupported',
      message: '当前安装包未配置桌面更新源，请联系发布者。'
    })
  if (!app.isPackaged)
    return publishUpdateState({
      state: 'unsupported',
      message: '开发模式不执行桌面更新，请使用安装版验证。'
    })
  if (action === 'check') {
    try {
      const result = await autoUpdater.checkForUpdates()
      const version = result?.updateInfo?.version
      if (version && version !== app.getVersion())
        return publishUpdateState({
          state: 'available',
          availableVersion: version,
          progress: null,
          message: `发现新版本 ${version}，可以下载更新。`
        })
      return publishUpdateState({
        state: 'current',
        availableVersion: null,
        progress: null,
        message: '当前已是最新版本。'
      })
    } catch {
      return publishUpdateState({
        state: 'error',
        progress: null,
        message: '检查更新失败，请检查网络后重试。'
      })
    }
  }
  if (action === 'download') {
    if (desktopUpdateState.state === 'downloaded') return desktopUpdateState
    if (desktopUpdateState.state !== 'available' || !desktopUpdateState.availableVersion)
      return publishUpdateState({ state: 'error', message: '请先检查更新并确认有新版本。' })
    try {
      if (!desktopDownload)
        desktopDownload = autoUpdater.downloadUpdate().finally(() => {
          desktopDownload = undefined
        })
      await desktopDownload
      return desktopUpdateState.state === 'downloaded'
        ? desktopUpdateState
        : publishUpdateState({ state: 'downloaded', progress: 100, message: '更新已下载，可以重启安装。' })
    } catch {
      return publishUpdateState({
        state: 'error',
        progress: null,
        message: '下载更新失败，请检查网络后重试。'
      })
    }
  }
  if (action === 'install') {
    if (!updateReady || desktopUpdateState.state !== 'downloaded')
      return publishUpdateState({ state: 'error', message: '请先下载更新，再重启安装。' })
    quitting = true
    autoUpdater.quitAndInstall()
    return publishUpdateState({ message: '正在重启并安装…' })
  }
  throw new Error('未知更新操作')
})
app.on('activate', () => {
  if (!mainWindow && localOrigin) createWindow()
})
app.on('window-all-closed', () => {
  if (devUrl || process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => {
  quitting = true
  server?.kill()
})
