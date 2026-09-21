const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let error = ''
    const timeout = setTimeout(() => child.kill(), 20 * 60 * 1000)
    child.stdout.resume()
    child.stderr.on('data', (data) => {
      error = (error + data).slice(-2000)
    })
    child.on('error', (e) => {
      clearTimeout(timeout)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      code === 0 ? resolve() : reject(new Error(error || 'Python 安装失败'))
    })
  })
}
function modelPython(userDir) {
  return join(userDir, 'models', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
}
let installing
function installModels(userDir, resources) {
  return (installing ||= install(userDir, resources).finally(() => {
    installing = undefined
  }))
}
async function install(userDir, resources) {
  const target = modelPython(userDir)
  if (!existsSync(target)) {
    const candidates = [
      process.env.REDUB_PYTHON,
      ...(process.platform === 'win32'
        ? ['python']
        : ['/opt/homebrew/bin/python3.11', '/usr/local/bin/python3.11', 'python3.11'])
    ].filter(Boolean)
    let selected
    for (const candidate of candidates) {
      try {
        await execute(candidate, [
          '-c',
          'import sys; assert sys.version_info[:2] == (3,11), "需要 Python 3.11"'
        ])
        selected = candidate
        break
      } catch {}
    }
    if (!selected) throw new Error('请先安装 Python 3.11，或在本地配置中用 REDUB_PYTHON 指定它的路径。')
    await execute(selected, ['-m', 'venv', join(userDir, 'models')])
  }
  await execute(target, ['-m', 'pip', 'install', '--upgrade', 'pip'])
  await execute(target, ['-m', 'pip', 'install', '-r', join(resources, 'scripts', 'requirements.txt')])
  await execute(target, ['-c', 'import demucs, faster_whisper, soundfile, opencc'])
  return '本地模型环境已安装。请重启应用后开始处理，首次运行会下载模型。'
}
module.exports = { installModels, modelPython }
