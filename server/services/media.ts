import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { dataDir } from '../db'

const require = createRequire(import.meta.url)
function binary(name: 'ffmpeg' | 'ffprobe') {
  const env = process.env[`REDUB_${name.toUpperCase()}`]
  if (env) return env
  try {
    const bundled = name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path
    if (bundled && existsSync(bundled)) return bundled
  } catch {
    /* Fall back to the system installation in development. */
  }
  return name
}
export function python() {
  if (process.env.REDUB_PYTHON) return process.env.REDUB_PYTHON
  const local = resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  return existsSync(local) ? local : 'python3.11'
}
export function assetPath(relative: string) {
  const absolute = resolve(dataDir, relative)
  if (!absolute.startsWith(dataDir + sep)) throw new Error('无效的文件路径')
  return absolute
}
export async function projectDir(id: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('无效的项目编号')
  const dir = assetPath(id)
  await mkdir(dir, { recursive: true })
  return dir
}
const children = new Set<ChildProcess>()
export function stopMediaProcesses() {
  for (const child of children) child.kill('SIGKILL')
}
export function runProcess(command: string, args: string[], timeoutMs = 60 * 60 * 1000) {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: process.env })
    children.add(child)
    let stdout = '',
      stderr = '',
      timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      stdout = (stdout + d).slice(-16 * 1024 * 1024)
    })
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-8000)
    })
    child.on('error', (e) => {
      children.delete(child)
      clearTimeout(timer)
      reject(new Error(`无法启动 ${command.split(/[\\/]/).pop()}：${e.message}`))
    })
    child.on('close', (code) => {
      children.delete(child)
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout)
      else
        reject(
          new Error(
            timedOut
              ? '处理超时，可调整素材长度后重试'
              : `处理失败：${stderr.slice(-2000) || `退出码 ${code}`}`
          )
        )
    })
  })
}
export const ffmpeg = (args: string[]) =>
  runProcess(binary('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args])
export async function probe(path: string) {
  const result = JSON.parse(
    await runProcess(
      binary('ffprobe'),
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
      30000
    )
  )
  const duration = Number(result.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取素材时长，请检查文件是否损坏')
  if (!result.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'))
    throw new Error('素材中没有可用音轨')
  return { duration, video: result.streams.some((s: { codec_type: string }) => s.codec_type === 'video') }
}
export async function extractAudio(source: string, target: string) {
  await ffmpeg(['-i', source, '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', target])
}
export async function cutAudio(source: string, target: string, start: number, duration: number) {
  await ffmpeg([
    '-ss',
    String(start),
    '-i',
    source,
    '-t',
    String(duration),
    '-ar',
    '24000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    target
  ])
}
export function tempoFilters(ratio: number) {
  const values: number[] = []
  while (ratio > 2) {
    values.push(2)
    ratio /= 2
  }
  while (ratio < 0.5) {
    values.push(0.5)
    ratio /= 0.5
  }
  values.push(ratio)
  return values.map((v) => `atempo=${v.toFixed(8)}`).join(',')
}
export async function alignAudio(source: string, target: string, duration: number) {
  const info = await probe(source)
  await ffmpeg([
    '-i',
    source,
    '-af',
    `${tempoFilters(info.duration / duration)},apad,atrim=0:${duration},afade=t=in:d=0.008,afade=t=out:st=${Math.max(0, duration - 0.008)}:d=0.008`,
    '-ar',
    '48000',
    '-ac',
    '2',
    target
  ])
}
export async function localModel(action: 'segment' | 'transcribe', input: object, output: string) {
  const inputFile = `${output}.input.json`
  await writeFile(inputFile, JSON.stringify(input))
  const script = join(process.env.REDUB_SCRIPTS_DIR || resolve('scripts'), 'audio.py')
  await runProcess(python(), [script, action, inputFile, output])
  return JSON.parse(await readFile(output, 'utf-8'))
}
export async function mediaHealth() {
  const check = async (command: string, args: string[]) => {
    try {
      await runProcess(command, args, 15000)
      return true
    } catch {
      return false
    }
  }
  const [ffmpegReady, ffprobeReady, modelsReady] = await Promise.all([
    check(binary('ffmpeg'), ['-version']),
    check(binary('ffprobe'), ['-version']),
    check(python(), ['-c', 'import demucs, faster_whisper'])
  ])
  return { ffmpeg: ffmpegReady, ffprobe: ffprobeReady, models: modelsReady }
}
