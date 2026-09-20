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
  createWindow()
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('update-downloaded', () => {
    updateReady = true
  })
  autoUpdater.on('error', () => {})
  if (process.env.REDUB_UPDATE_URL) {
    if (!process.env.REDUB_UPDATE_URL.startsWith('https://')) throw new Error('更新地址必须使用 HTTPS')
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.REDUB_UPDATE_URL })
    if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {})
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
  if (action === 'config') {
    await shell.openPath(join(app.getPath('userData'), '.env'))
    return '已打开本地配置。修改后请重启应用。'
  }
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
  if (!process.env.REDUB_UPDATE_URL) return '尚未配置桌面更新源。请在本地配置中填写 REDUB_UPDATE_URL。'
  if (!app.isPackaged) return '开发模式不安装更新，请使用安装版验证。'
  if (action === 'check') {
    const result = await autoUpdater.checkForUpdates()
    return result?.updateInfo.version === app.getVersion()
      ? '当前已是最新版本。'
      : `发现版本 ${result?.updateInfo.version || ''}，可下载更新。`
  }
  if (action === 'download') {
    if (!desktopDownload)
      desktopDownload = autoUpdater.downloadUpdate().finally(() => {
        desktopDownload = undefined
      })
    await desktopDownload
    return '更新已下载，点击「重启并安装」完成升级。'
  }
  if (action === 'install') {
    if (!updateReady) return '请先检查并下载更新。'
    quitting = true
    autoUpdater.quitAndInstall()
    return '正在安装更新…'
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
