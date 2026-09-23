import { jobContext, checkJobCancelled } from './job-context'
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
  checkJobCancelled()
  const signal = jobContext.getStore()?.signal
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: process.env })
    children.add(child)
    const abort = () => {
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
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
      signal?.removeEventListener('abort', abort)
      clearTimeout(timer)
      reject(new Error(`无法启动 ${command.split(/[\\/]/).pop()}：${e.message}`))
    })
    child.on('close', (code) => {
      children.delete(child)
      signal?.removeEventListener('abort', abort)
      clearTimeout(timer)
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
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
export async function audioPeaks(path: string, buckets = 600) {
  const info = await probe(path)
  const sampleRate = 4000
  const totalSamples = Math.max(1, Math.ceil(info.duration * sampleRate))
  const peaks = Array.from({ length: buckets }, () => 0)
  checkJobCancelled()
  const signal = jobContext.getStore()?.signal
  return new Promise<number[]>((resolvePromise, reject) => {
    const child = spawn(
      binary('ffmpeg'),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        path,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-f',
        's16le',
        '-'
      ],
      { windowsHide: true, env: process.env }
    )
    children.add(child)
    const abort = () => {
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let remainder = Buffer.alloc(0)
    let sampleIndex = 0
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 120000)
    child.stdout.on('data', (data: Buffer) => {
      const buffer = remainder.length ? Buffer.concat([remainder, data]) : data
      const usable = buffer.length - (buffer.length % 2)
      for (let offset = 0; offset < usable; offset += 2) {
        const bucket = Math.min(buckets - 1, Math.floor((sampleIndex / totalSamples) * buckets))
        const amplitude = Math.min(1, Math.pow(Math.abs(buffer.readInt16LE(offset)) / 32768, 0.65))
        if (amplitude > peaks[bucket]!) peaks[bucket] = amplitude
        sampleIndex++
      }
      remainder = Buffer.from(buffer.subarray(usable))
    })
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-4000)
    })
    child.on('error', (error) => {
      children.delete(child)
      signal?.removeEventListener('abort', abort)
      clearTimeout(timer)
      reject(new Error(`无法读取波形：${error.message}`))
    })
    child.on('close', (code) => {
      children.delete(child)
      signal?.removeEventListener('abort', abort)
      clearTimeout(timer)
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      if (code === 0) resolvePromise(peaks)
      else
        reject(
          new Error(timedOut ? '读取波形超时' : `读取波形失败：${stderr.slice(-1200) || `退出码 ${code}`}`)
        )
    })
  })
}

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
  return {
    duration,
    video: result.streams.some((s: { codec_type: string }) => s.codec_type === 'video'),
    audioStreams: result.streams.filter((s: { codec_type: string }) => s.codec_type === 'audio')
      .length as number
  }
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
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('配音目标时长必须大于零')
  const info = await probe(source)
  // Keep short speech at its natural rate. Reject speech that cannot fit at up to 1.2x.
  const ratio = Math.max(1, info.duration / duration)
  if (ratio > 1.2 + 1e-6)
    throw new Error(
      `配音时长 ${info.duration.toFixed(2)} 秒超过片段 ${duration.toFixed(2)} 秒可容纳的范围，请缩短台词并重新生成，或扩大时间范围`
    )
  const filter = ratio !== 1 ? `${tempoFilters(ratio)},` : ''
  await ffmpeg([
    '-i',
    source,
    '-af',
    `${filter}apad,atrim=0:${duration},afade=t=in:d=0.008,afade=t=out:st=${Math.max(0, duration - 0.008)}:d=0.008`,
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
      const output = await runProcess(command, args, 15000)
      return { ready: true, output: output.trim().split(/\r?\n/)[0] || '' }
    } catch {
      return { ready: false, output: '' }
    }
  }
  const [ffmpegCheck, ffprobeCheck, pythonCheck, demucsCheck, whisperCheck, openccCheck] = await Promise.all([
    check(binary('ffmpeg'), ['-version']),
    check(binary('ffprobe'), ['-version']),
    check(python(), ['-c', 'import platform; print(platform.python_version())']),
    check(python(), ['-c', 'import demucs']),
    check(python(), ['-c', 'import faster_whisper']),
    check(python(), ['-c', 'import opencc'])
  ])
  const modelStatus = {
    demucs: demucsCheck.ready,
    fasterWhisper: whisperCheck.ready,
    opencc: openccCheck.ready
  }
  return {
    ffmpeg: ffmpegCheck.ready,
    ffprobe: ffprobeCheck.ready,
    models: Object.values(modelStatus).every(Boolean),
    versions: {
      ffmpeg: ffmpegCheck.output,
      ffprobe: ffprobeCheck.output,
      python: pythonCheck.output ? `Python ${pythonCheck.output}` : ''
    },
    modelStatus,
    paths: {
      ffmpeg: binary('ffmpeg'),
      ffprobe: binary('ffprobe'),
      python: python()
    }
  }
}
