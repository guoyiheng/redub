import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createClient } from '@libsql/client'
import { pathToFileURL } from 'node:url'
import { ffmpeg } from '../server/services/media'
import { defaultVoiceSettings } from '../shared/voice'
import type { ProjectDetail, Job, JobDetail, JobRequest } from '../shared/types'
let server: ChildProcess,
  base: string,
  id: string,
  failTranslation = true
let voice: Buffer
let holdSynthesis: Promise<void> | undefined
let holdTranslation: Promise<void> | undefined
const synthesisRequests: {
  text_prompt: string
  references?: { speaker?: string; audio_data?: string }[]
  audio_config: { speech_rate: number }
}[] = []
let translationRequests = 0
const mock = createServer(async (req, res) => {
  const parts: Buffer[] = []
  for await (const part of req) parts.push(part)
  const body = JSON.parse(Buffer.concat(parts).toString())
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/v1/chat/completions') {
    translationRequests++
    await holdTranslation
    if (failTranslation) {
      res.writeHead(503)
      res.end(JSON.stringify({ message: 'temporary fixture failure' }))
      return
    }
    const lines = JSON.parse(body.messages[1].content)
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                translations: lines.map((s: { id: string }) => ({ id: s.id, text: '每个故事都值得被听见。' }))
              })
            }
          }
        ]
      })
    )
  } else {
    if ('speaker' in body) {
      res.writeHead(400)
      res.end(JSON.stringify({ message: 'speaker 必须放在 references 中' }))
      return
    }
    synthesisRequests.push(body)
    await holdSynthesis
    res.end(
      JSON.stringify({ audio: voice.toString('base64'), duration: 0.8, subtitle: { text: '配音测试' } })
    )
  }
})
async function freePort() {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const address = s.address() as { port: number }
  await new Promise<void>((r) => s.close(() => r()))
  return address.port
}
async function start() {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [resolve('.output/server/index.mjs')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(port),
      REDUB_SESSION_TOKEN: '',
      // Local processing should fail quickly in fixtures instead of downloading models.
      REDUB_PYTHON: process.execPath,
      REDUB_WEB_DIR: join(process.env.REDUB_DATA_DIR!, 'web')
    },
    stdio: 'pipe'
  })
  let error = ''
  server.stderr?.on('data', (d) => {
    error += d
  })
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(error)
    try {
      if ((await fetch(base + '/api/settings')).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not start: ' + error)
}
async function stop() {
  if (server && server.exitCode === null) {
    server.kill()
    await once(server, 'exit')
  }
}
async function api(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(base + '/api/' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${data.statusMessage}`)
  return data
}
async function until(check: (detail: ProjectDetail) => boolean, projectId = id) {
  for (let i = 0; i < 150; i++) {
    const detail = await api(`projects/${projectId}`)
    if (check(detail)) return detail
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('queue did not reach expected state')
}
beforeAll(async () => {
  const voicePath = join(process.env.REDUB_DATA_DIR!, 'voice.mp3')
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=550:duration=0.8', '-c:a', 'libmp3lame', voicePath])
  voice = await readFile(voicePath)
  mock.listen(0, '127.0.0.1')
  await once(mock, 'listening')
  const port = (mock.address() as { port: number }).port
  await start()
  const channels = await api('channels')
  for (const channel of channels)
    await api(`channels/${channel.id}`, 'PATCH', {
      ...channel,
      endpoint: `http://127.0.0.1:${port}${channel.type === 'openai' ? '/v1' : '/tts'}`
    })
})
afterAll(async () => {
  await stop()
  mock.closeAllConnections()
  await new Promise<void>((r) => mock.close(() => r()))
})
describe.sequential('production HTTP workflow', () => {
  it('imports text without tasks and requires a manual action for paid processing', async () => {
    id = (
      await api('projects', 'POST', { name: 'HTTP integration', text: 'Every story deserves to be heard.' })
    ).id
    expect((await api(`projects/${id}`)).jobs).toEqual([])
    await expect(api(`projects/${id}/run`, 'POST', {})).rejects.toThrow('请手动选择翻译或生成配音')
    expect((await api(`projects/${id}`)).jobs).toEqual([])
    expect(translationRequests).toBe(0)
    expect(synthesisRequests).toHaveLength(0)
  })
  it('starts only local stages for imported audio', async () => {
    const upload = new FormData()
    upload.set('name', 'Local preparation')
    upload.set('file', new Blob([new Uint8Array(voice)], { type: 'audio/mp3' }), 'source.mp3')
    const response = await fetch(`${base}/api/projects`, { method: 'POST', body: upload })
    expect(response.status).toBe(200)
    const audioId = (await response.json()).id
    expect((await api(`projects/${audioId}`)).jobs).toEqual([])
    const tasks: Job[] = await api(`projects/${audioId}/run`, 'POST', {})
    expect(tasks.map((item) => item.stage)).toEqual(['separate', 'segment', 'transcribe'])
    await until((detail) => detail.jobs.some((item) => item.status === 'failed'), audioId)
    expect(translationRequests).toBe(0)
    expect(synthesisRequests).toHaveLength(0)
  })
  it('starts explicit translation once under duplicate concurrent requests', async () => {
    const responses = await Promise.all([
      fetch(`${base}/api/projects/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'translate' })
      }),
      fetch(`${base}/api/projects/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: 'translate' })
      })
    ])
    expect(responses.map((r) => r.status).sort()).toEqual([202, 409])
    const detail = await until((d) => d.jobs.some((j) => j.status === 'failed'))
    expect(detail.project.paused).toBe(true)
    expect(detail.jobs).toHaveLength(1)
    expect(detail.jobs.filter((j) => j.status === 'queued')).toHaveLength(0)
  })
  it('retries translation, then manually generates and exports the audio', async () => {
    const failed = (await api(`projects/${id}`)).jobs.find((j: Job) => j.status === 'failed')
    failTranslation = false
    await api(`jobs/${failed.id}/retry`, 'POST')
    let detail = await until((d) => d.jobs.every((j) => j.status === 'completed'))
    expect(detail.project.outputPath).toBeNull()
    expect(detail.segments[0]!.generatedPath).toBeNull()
    await api(`segments/${detail.segments[0]!.id}/generate`, 'POST', {
      ...defaultVoiceSettings(),
      aiUseReference: false
    })
    detail = await until((d) => d.jobs.every((j) => j.status === 'completed'))
    expect(detail.project.outputPath).toBeNull()
    expect(detail.segments[0]!.generatedPath).toBeTruthy()
    await api(`projects/${id}/batch`, 'POST', { action: 'render' })
    detail = await until((d) => d.jobs.every((j) => j.status === 'completed'))
    expect(detail.project.outputPath).toMatch(/\.mp3$/)
    expect(detail.segments[0]!.translation).toBe('每个故事都值得被听见。')
    expect(detail.jobs.find((j) => j.id === failed.id)!.attempts).toBe(2)
    const media = await fetch(`${base}/api/media?path=${encodeURIComponent(detail.project.outputPath!)}`, {
      headers: { Range: 'bytes=0-15' }
    })
    expect(media.status).toBe(206)
    expect((await media.arrayBuffer()).byteLength).toBe(16)
  })
  it('rejects cross-site access and invalid settings or file paths', async () => {
    expect(
      (await fetch(base + '/api/projects', { headers: { Origin: 'https://evil.example' } })).status
    ).toBe(403)
    expect((await fetch(base + '/api/media?path=../redub.sqlite')).status).toBe(400)
    await expect(
      api('settings', 'PATCH', { ...(await api('settings')), translationConcurrency: 0 })
    ).rejects.toThrow('400')
  })
  it('recovers an interrupted task on restart and can retry it', async () => {
    const detail = await api(`projects/${id}`),
      job = detail.jobs.find((j: Job) => j.stage === 'preview')
    await stop()
    const db = createClient({ url: pathToFileURL(join(process.env.REDUB_DATA_DIR!, 'redub.sqlite')).href })
    await db.execute({ sql: "UPDATE jobs SET status='running' WHERE id=?", args: [job.id] })
    db.close()
    await start()
    const restored = await api(`projects/${id}`)
    expect(restored.jobs.find((j: Job) => j.id === job.id).status).toBe('failed')
    expect(restored.project.paused).toBe(true)
    await api(`jobs/${job.id}/retry`, 'POST')
    await until((d) => d.jobs.every((j) => j.status === 'completed'))
  })
  it('batches only missing voices with shared parameters and stops for review', async () => {
    const before: ProjectDetail = await api(`projects/${id}`)
    const original = before.segments[0]!
    const added = await api(`projects/${id}/segments`, 'POST', {
      start: original.end,
      end: original.end + 2,
      text: 'Another sentence.',
      translation: '',
      speaker: '角色 1',
      enabled: true
    })
    const voice = { ...defaultVoiceSettings(), aiUseReference: false, aiPrompt: '自然地说', aiSpeechRate: 10 }
    await expect(
      api(`projects/${id}/batch`, 'POST', { action: 'synthesize', voice: { ...voice, aiSpeechRate: 101 } })
    ).rejects.toThrow('400')
    await expect(
      api(`projects/${id}/batch`, 'POST', { action: 'synthesize', voice, finish: true })
    ).rejects.toThrow('手动')
    let release!: () => void
    holdSynthesis = new Promise((resolve) => {
      release = resolve
    })
    let created: Job[]
    try {
      created = await api(`projects/${id}/batch`, 'POST', {
        action: 'synthesize',
        scope: 'missing',
        voice
      })
    } finally {
      holdSynthesis = undefined
      release()
    }
    expect(created.map((j) => j.stage)).toEqual(['synthesize'])
    expect(created[0]!.segmentId).toBe(added.id)
    const result = await until((d) =>
      created.every((j) => d.jobs.find((k) => k.id === j.id)?.status === 'completed')
    )
    expect(result.segments[0]!.generatedPath).toBe(original.generatedPath)
    expect(result.segments[1]!.aiPrompt).toBe('自然地说')
    expect(result.segments[1]!.aiSpeechRate).toBe(10)
    expect(result.segments[1]!.generatedPath).toBeTruthy()
    expect(result.project.mixedPath).toBeNull()
    expect(result.project.outputPath).toBeNull()
  })
  it('queues a separate sentence alongside a voice-only batch without finishing the movie', async () => {
    const batchProject = await api('projects', 'POST', {
      name: 'Voice-only batch isolation',
      text: 'First batch sentence.\nSecond batch sentence.\nKeep this sentence outside the batch.'
    })
    const before: ProjectDetail = await api(`projects/${batchProject.id}`)
    const untouched = before.segments[2]!
    await api(`segments/${untouched.id}`, 'PATCH', { ...untouched, enabled: false })
    const voiceSettings = { ...defaultVoiceSettings(), aiUseReference: false, aiPrompt: '自然地说' }
    let release!: () => void
    holdSynthesis = new Promise((resolve) => {
      release = resolve
    })
    let created: Job[]
    let individual: { segmentId: string; jobs: Job[] }
    try {
      created = await api(`projects/${batchProject.id}/batch`, 'POST', {
        action: 'synthesize',
        scope: 'all',
        finish: false,
        voice: voiceSettings
      })
      expect(created.map((job) => job.stage)).toEqual(['synthesize', 'synthesize'])
      expect(created[1]!.dependsOn).toBeNull()
      expect(created[1]!.batchId).toBe(created[0]!.batchId)
      await until(
        (detail) => detail.jobs.some((job) => job.id === created[0]!.id && job.status === 'running'),
        batchProject.id
      )
      individual = await api(`segments/${untouched.id}/generate`, 'POST', voiceSettings)
      expect(individual.jobs[0]).toMatchObject({
        stage: 'synthesize',
        segmentId: untouched.id,
        dependsOn: null
      })
      const active: ProjectDetail = await until(
        (detail) => detail.jobs.some((job) => job.id === individual.jobs[0]!.id && job.status === 'running'),
        batchProject.id
      )
      expect(active.jobs).toHaveLength(3)
      expect(active.segments[2]!.enabled).toBe(true)
    } finally {
      holdSynthesis = undefined
      release()
    }
    const completed = await until(
      (detail) => detail.jobs.every((job) => job.status === 'completed'),
      batchProject.id
    )
    expect(completed.project.outputPath).toBeNull()
    expect(completed.segments[2]!.generatedPath).toBeTruthy()
  })
  it('persists separate limits and concurrently runs ten translations and five voices', async () => {
    const defaults = await api('settings')
    expect(defaults).toMatchObject({ translationConcurrency: 10, synthesisConcurrency: 5 })
    expect(defaults).not.toHaveProperty('concurrency')
    await api('settings', 'PATCH', { ...defaults, translationConcurrency: 4, synthesisConcurrency: 2 })
    await stop()
    await start()
    expect(await api('settings')).toMatchObject({ translationConcurrency: 4, synthesisConcurrency: 2 })
    await api('settings', 'PATCH', defaults)
    const translation = await api('projects', 'POST', {
      name: 'Parallel translation',
      text: Array.from({ length: 12 }, (_, i) => `Sentence ${i}.`).join('\n')
    })
    const synthesis = await api('projects', 'POST', {
      name: 'Parallel voice',
      text: Array.from({ length: 7 }, (_, i) => `Voice ${i}.`).join('\n')
    })
    let releaseTranslation!: () => void
    let releaseSynthesis!: () => void
    holdTranslation = new Promise((resolve) => {
      releaseTranslation = resolve
    })
    holdSynthesis = new Promise((resolve) => {
      releaseSynthesis = resolve
    })
    const translatedBefore = translationRequests
    const generatedBefore = synthesisRequests.length
    try {
      const translations: Job[] = await api(`projects/${translation.id}/batch`, 'POST', {
        action: 'translate'
      })
      const voices: Job[] = await api(`projects/${synthesis.id}/batch`, 'POST', {
        action: 'synthesize',
        voice: { ...defaultVoiceSettings(), aiUseReference: false }
      })
      expect(translations).toHaveLength(12)
      expect(voices).toHaveLength(7)
      expect([...translations, ...voices].every((job) => !job.dependsOn && !!job.batchId)).toBe(true)
      const translating = await until(
        (detail) =>
          detail.jobs.filter((job) => job.status === 'running').length === 10 &&
          translationRequests === translatedBefore + 10,
        translation.id
      )
      const generating = await until(
        (detail) =>
          detail.jobs.filter((job) => job.status === 'running').length === 5 &&
          synthesisRequests.length === generatedBefore + 5,
        synthesis.id
      )
      expect(translating.jobs.filter((job) => job.status === 'queued')).toHaveLength(2)
      expect(generating.jobs.filter((job) => job.status === 'queued')).toHaveLength(2)
      expect(new Set(translations.map((job) => job.batchId)).size).toBe(1)
      expect(new Set(voices.map((job) => job.batchId)).size).toBe(1)
      await api('settings', 'PATCH', { ...defaults, translationConcurrency: 1, synthesisConcurrency: 1 })
      expect(
        (await api(`projects/${translation.id}`)).jobs.filter((job: Job) => job.status === 'running')
      ).toHaveLength(10)
      expect(
        (await api(`projects/${synthesis.id}`)).jobs.filter((job: Job) => job.status === 'running')
      ).toHaveLength(5)
    } finally {
      holdTranslation = undefined
      holdSynthesis = undefined
      releaseTranslation()
      releaseSynthesis()
    }
    const translated = await until(
      (detail) => detail.jobs.every((job) => job.status === 'completed'),
      translation.id
    )
    const generated = await until(
      (detail) => detail.jobs.every((job) => job.status === 'completed'),
      synthesis.id
    )
    expect(translated.jobs).toHaveLength(12)
    expect(generated.jobs).toHaveLength(7)
    expect(translated.segments.every((line) => line.translation && !line.generatedPath)).toBe(true)
    expect(generated.segments.every((line) => line.generatedPath)).toBe(true)
    expect(generated.project.outputPath).toBeNull()
    expect(translationRequests).toBe(translatedBefore + 12)
    expect(synthesisRequests.length).toBe(generatedBefore + 7)
    await api('settings', 'PATCH', defaults)
  })
  it('queues single-line translations with the same limit and persists their request history', async () => {
    const project = await api('projects', 'POST', {
      name: 'Single translations',
      text: 'First.\nSecond.\nUntouched.'
    })
    const before: ProjectDetail = await api(`projects/${project.id}`)
    const defaults = await api('settings')
    await api('settings', 'PATCH', { ...defaults, translationConcurrency: 1 })
    let release!: () => void
    holdTranslation = new Promise((resolve) => {
      release = resolve
    })
    try {
      const first = await api(`segments/${before.segments[0]!.id}/translate`, 'POST')
      const second = await api(`segments/${before.segments[1]!.id}/translate`, 'POST')
      expect(first.jobs).toHaveLength(1)
      expect(second.jobs).toHaveLength(1)
      const active = await until((detail) => detail.jobs.some((job) => job.status === 'running'), project.id)
      expect(active.jobs.filter((job) => job.status === 'running')).toHaveLength(1)
      expect(active.jobs.filter((job) => job.status === 'queued')).toHaveLength(1)
      await expect(api(`segments/${before.segments[0]!.id}/translate`, 'POST')).rejects.toThrow('409')
    } finally {
      holdTranslation = undefined
      release()
    }
    const done = await until((detail) => detail.jobs.every((job) => job.status === 'completed'), project.id)
    expect(done.segments[0]!.translation).toBeTruthy()
    expect(done.segments[1]!.translation).toBeTruthy()
    expect(done.segments[2]).toEqual(before.segments[2])
    for (const job of done.jobs) expect((await api(`jobs/${job.id}`)).requests).toHaveLength(1)
    await api('settings', 'PATCH', defaults)
  })
  it('keeps accepting mixed single tasks and batches while the same project has a running voice', async () => {
    const project = await api('projects', 'POST', {
      name: 'Mixed live queue',
      text: 'First.\nSecond.\nThird.\nFourth.'
    })
    const before: ProjectDetail = await api(`projects/${project.id}`)
    const voiceInput = { ...defaultVoiceSettings(false), ttsRate: 11 }
    let release!: () => void
    holdSynthesis = new Promise((resolve) => {
      release = resolve
    })
    try {
      await api(`segments/${before.segments[0]!.id}/generate`, 'POST', voiceInput)
      await until(
        (d) => d.jobs.some((job) => job.stage === 'synthesize' && job.status === 'running'),
        project.id
      )
      const translated = await api(`segments/${before.segments[1]!.id}/translate`, 'POST', {
        targetLanguage: '日语',
        text: 'Temporary text.',
        prompt: '保持简洁'
      })
      const done = await until(
        (d) => d.jobs.find((job) => job.id === translated.jobs[0].id)?.status === 'completed',
        project.id
      )
      expect(done.segments[1]).toMatchObject({ text: 'Second.', translationLanguage: '日语' })
      expect(done.project.targetLanguage).toBe(before.project.targetLanguage)
      const detail: JobDetail = await api(`jobs/${translated.jobs[0].id}`)
      const request: JobRequest = await api(
        `jobs/${translated.jobs[0].id}/requests/${detail.requests[0]!.id}`
      )
      expect(request.requestBody).toContain('日语')
      expect(request.requestBody).toContain('保持简洁')
      expect(request.requestBody).toContain('Temporary text.')
      const other = await api(`segments/${before.segments[2]!.id}/generate`, 'POST', voiceInput)
      expect(other.jobs).toHaveLength(1)
      const batch: Job[] = await api(`projects/${project.id}/batch`, 'POST', {
        action: 'synthesize',
        scope: 'all',
        voice: voiceInput
      })
      expect(batch.map((job) => job.segmentId).sort()).toEqual(
        [before.segments[1]!.id, before.segments[3]!.id].sort()
      )
      await expect(api(`segments/${before.segments[0]!.id}/generate`, 'POST', voiceInput)).rejects.toThrow(
        '409'
      )
    } finally {
      holdSynthesis = undefined
      release()
    }
    const completed = await until((d) => d.jobs.every((job) => job.status === 'completed'), project.id)
    expect(completed.jobs).toHaveLength(5)
    expect(completed.segments.every((line) => line.generatedPath)).toBe(true)
  })
  it('requires translation to finish and be reviewed before voice generation can be submitted', async () => {
    const project = await api('projects', 'POST', {
      name: 'Manual review',
      text: 'Review the translation first.'
    })
    const before: ProjectDetail = await api(`projects/${project.id}`)
    const count = synthesisRequests.length
    let release!: () => void
    holdTranslation = new Promise((resolve) => {
      release = resolve
    })
    try {
      await api(`projects/${project.id}/batch`, 'POST', { action: 'translate' })
      await until((detail) => detail.jobs.some((job) => job.status === 'running'), project.id)
      await expect(
        api(`segments/${before.segments[0]!.id}/generate`, 'POST', {
          ...defaultVoiceSettings(),
          aiUseReference: false
        })
      ).rejects.toThrow('核对')
      await expect(
        api(`projects/${project.id}/batch`, 'POST', {
          action: 'synthesize',
          voice: { ...defaultVoiceSettings(), aiUseReference: false }
        })
      ).rejects.toThrow('409')
    } finally {
      holdTranslation = undefined
      release()
    }
    const done = await until((detail) => detail.jobs.every((job) => job.status === 'completed'), project.id)
    expect(done.jobs.map((job) => job.stage)).toEqual(['translate'])
    expect(done.segments[0]!.generatedPath).toBeNull()
    expect(synthesisRequests.length).toBe(count)
  })
  it.each(['retry', 'skip'] as const)(
    'cancels legacy followups on restart and keeps them cancelled after %s and resume',
    async (action) => {
      const project = await api('projects', 'POST', { name: `Legacy ${action}`, text: 'Review each step.' })
      await stop()
      const db = createClient({ url: pathToFileURL(join(process.env.REDUB_DATA_DIR!, 'redub.sqlite')).href })
      const stages = ['transcribe', 'translate', 'synthesize', 'mix', 'preview', 'export'] as const
      await db.execute({ sql: 'UPDATE projects SET paused=1 WHERE id=?', args: [project.id] })
      for (const [index, stage] of stages.entries())
        await db.execute({
          sql: 'INSERT INTO jobs (id,projectId,stage,status,dependsOn,error,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)',
          args: [
            `${project.id}-${stage}`,
            project.id,
            stage,
            index === 0 ? 'completed' : index === 1 ? 'failed' : 'queued',
            index ? `${project.id}-${stages[index - 1]}` : null,
            index === 1 ? 'Old translation failure' : null,
            Date.now(),
            Date.now()
          ]
        })
      db.close()
      const count = synthesisRequests.length
      const translations = translationRequests
      await start()
      const restored: ProjectDetail = await api(`projects/${project.id}`)
      expect(restored.jobs.filter((job) => job.status === 'cancelled')).toHaveLength(4)
      expect(restored.jobs.find((job) => job.stage === 'translate')).toMatchObject({
        status: 'failed',
        error: 'Old translation failure'
      })
      await api(`projects/${project.id}/pause`, 'POST', { paused: false })
      await api(`jobs/${project.id}-translate/${action}`, 'POST')
      await until(
        (detail) =>
          detail.jobs.find((job) => job.stage === 'translate')?.status ===
          (action === 'retry' ? 'completed' : 'skipped'),
        project.id
      )
      await expect(api(`jobs/${project.id}-synthesize/retry`, 'POST')).rejects.toThrow('已取消')
      await expect(api(`jobs/${project.id}-synthesize/skip`, 'POST')).rejects.toThrow('已取消')
      await stop()
      await start()
      const done: ProjectDetail = await api(`projects/${project.id}`)
      expect(done.jobs).toHaveLength(6)
      expect(done.jobs.filter((job) => job.status === 'cancelled')).toHaveLength(4)
      expect(done.jobs.some((job) => ['queued', 'running'].includes(job.status))).toBe(false)
      expect(done.segments[0]!.generatedPath).toBeNull()
      expect(done.segments[0]!.enabled).toBe(true)
      expect(done.project.mixedPath).toBeNull()
      expect(done.project.outputPath).toBeNull()
      expect(synthesisRequests.length).toBe(count)
      expect(translationRequests).toBe(translations + (action === 'retry' ? 1 : 0))
      // 已核对后新建的手动操作仍可执行，不能复活取消的旧链。
      await api(`segments/${done.segments[0]!.id}/generate`, 'POST', {
        ...defaultVoiceSettings(),
        aiUseReference: false
      })
      const reviewed = await until(
        (detail) => detail.jobs.some((job) => job.stage === 'synthesize' && job.status === 'completed'),
        project.id
      )
      expect(reviewed.jobs.filter((job) => job.status === 'cancelled')).toHaveLength(4)
      expect(reviewed.project.outputPath).toBeNull()
      expect(synthesisRequests.length).toBe(count + 1)
    }
  )
  it('generates individual sentences independently and saves only the requested parameters atomically', async () => {
    const before: ProjectDetail = await api(`projects/${id}`)
    const [first, second] = before.segments
    await api(`segments/${second!.id}`, 'PATCH', { ...second, enabled: false })
    const voiceSettings = {
      ...defaultVoiceSettings(),
      aiUseReference: false,
      aiPrompt: '第二句温柔自然',
      aiSpeaker: 'fixture-speaker',
      aiSpeechRate: 17
    }
    let release!: () => void
    holdSynthesis = new Promise((resolve) => {
      release = resolve
    })
    const requestOffset = synthesisRequests.length
    try {
      const created = await api(`segments/${second!.id}/generate`, 'POST', {
        ...voiceSettings,
        text: 'must not overwrite the original line',
        projectId: 'another-project'
      })
      expect(created.segmentId).toBe(second!.id)
      expect(created.jobs).toHaveLength(1)
      expect(created.jobs[0]).toMatchObject({ stage: 'synthesize', segmentId: second!.id })
      const inProgress = await until((d) =>
        d.jobs.some((j) => j.id === created.jobs[0].id && j.status === 'running')
      )
      expect(inProgress.project.outputPath).toBeNull()
      expect(inProgress.segments[0]).toEqual(first)
      expect(inProgress.segments[1]).toMatchObject({
        ...voiceSettings,
        text: second!.text,
        projectId: id,
        enabled: true,
        generatedPath: null,
        generatedHash: null,
        generatedDuration: null,
        subtitle: null
      })
      const requests = await Promise.allSettled([
        api(`segments/${first!.id}/generate`, 'POST', { ...voiceSettings, aiPrompt: '第一句坚定自然' }),
        api(`segments/${first!.id}/generate`, 'POST', { ...voiceSettings, aiPrompt: '第一句坚定自然' })
      ])
      const successful = requests.filter((request) => request.status === 'fulfilled')
      const rejected = requests.filter((request) => request.status === 'rejected')
      expect(successful).toHaveLength(1)
      expect(successful[0]!.value.jobs).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.reason.message).toContain('409')
      await expect(api(`segments/${second!.id}/generate`, 'POST', voiceSettings)).rejects.toThrow('409')
      await expect(api(`projects/${id}/run`, 'POST', { stage: 'translate' })).rejects.toThrow('409')
      await expect(api(`segments/${first!.id}`, 'PATCH', first)).rejects.toThrow('409')
      const queued: ProjectDetail = await until(
        (d) => d.jobs.filter((j) => j.status === 'running').length === 2
      )
      expect(queued.jobs.filter((j) => j.status === 'queued')).toHaveLength(0)
    } finally {
      holdSynthesis = undefined
      release()
    }
    const done = await until((d) => d.jobs.every((j) => j.status === 'completed'))
    expect(done.segments.every((s) => s.generatedPath)).toBe(true)
    expect(done.segments[0]!.aiPrompt).toBe('第一句坚定自然')
    expect(done.segments[1]!.aiPrompt).toBe('第二句温柔自然')
    expect(synthesisRequests.slice(requestOffset)).toHaveLength(2)
    expect(synthesisRequests[requestOffset]).toMatchObject({
      text_prompt: expect.stringContaining('第二句温柔自然'),
      references: [{ speaker: 'fixture-speaker' }],
      audio_config: { speech_rate: 17 }
    })
  })
  it('rejects invalid generation inputs without changing the sentence or queuing tasks', async () => {
    const before: ProjectDetail = await api(`projects/${id}`)
    const first = before.segments[0]!
    await expect(
      api(`segments/${first.id}/generate`, 'POST', {
        ...defaultVoiceSettings(),
        aiUseReference: true
      })
    ).rejects.toThrow('没有可用原声')
    await expect(
      api(`segments/${first.id}/generate`, 'POST', {
        ...defaultVoiceSettings(),
        aiUseReference: false,
        aiSpeechRate: 101
      })
    ).rejects.toThrow('400')
    await expect(api('segments/missing-segment/generate', 'POST', defaultVoiceSettings())).rejects.toThrow(
      '404'
    )
    const after: ProjectDetail = await api(`projects/${id}`)
    expect(after.segments).toEqual(before.segments)
    expect(after.jobs).toEqual(before.jobs)
    const emptyProject = await api('projects', 'POST', {
      name: 'Empty line validation',
      text: 'Temporary text'
    })
    const empty: ProjectDetail = await api(`projects/${emptyProject.id}`)
    await api(`segments/${empty.segments[0]!.id}`, 'PATCH', {
      ...empty.segments[0],
      text: '',
      enabled: false
    })
    await expect(
      api(`segments/${empty.segments[0]!.id}/generate`, 'POST', {
        ...defaultVoiceSettings(),
        aiUseReference: false
      })
    ).rejects.toThrow('请先填写这句台词')
    const unchanged: ProjectDetail = await api(`projects/${emptyProject.id}`)
    expect(unchanged.jobs).toEqual([])
    expect(unchanged.segments[0]!.enabled).toBe(false)
  })
  it('keeps results when normalizing an existing target language label', async () => {
    const before: ProjectDetail = await api(`projects/${id}`)
    await api(`projects/${id}`, 'PATCH', { ...before.project, targetLanguage: 'English' })
    const original = (await api(`projects/${id}`)).segments[0]
    await api(`segments/${original.id}`, 'PATCH', { ...original, translation: 'Kept translation' })
    await api(`projects/${id}`, 'PATCH', { ...before.project, targetLanguage: '英语' })
    expect((await api(`projects/${id}`)).segments[0].translation).toBe('Kept translation')
  })
  it('keeps synchronous translation and synthesis running after the submitting page disconnects', async () => {
    const project = await api('projects', 'POST', { name: '刷新恢复', text: 'Keep this task running.' })
    const line = (await api(`projects/${project.id}`)).segments[0]
    for (const stage of ['translate', 'synthesize'] as const) {
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      if (stage === 'translate') holdTranslation = pending
      else holdSynthesis = pending
      const controller = new AbortController()
      let jobId = ''
      const count = stage === 'translate' ? translationRequests : synthesisRequests.length
      try {
        const response = await fetch(
          `${base}/api/${stage === 'translate' ? `projects/${project.id}/batch` : `segments/${line.id}/generate`}`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              stage === 'translate'
                ? { action: 'translate' }
                : { ...defaultVoiceSettings(), aiUseReference: false }
            )
          }
        )
        expect(response.status).toBe(202)
        const submitted = await response.json()
        jobId = (Array.isArray(submitted) ? submitted[0] : submitted.jobs[0]).id
        expect(jobId).toMatch(/^[a-f0-9-]{36}$/)
        controller.abort()
        let restored!: JobDetail
        for (let i = 0; i < 100; i++) {
          restored = await api(`jobs/${jobId}`)
          if (restored.requests.length) break
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        expect(restored.job.status).toBe('running')
        expect(restored.requests).toHaveLength(1)
        expect(restored.requests[0]!.finishedAt).toBeNull()
        expect((await api('jobs')).some((job: Job) => job.id === jobId)).toBe(true)
      } finally {
        holdTranslation = undefined
        holdSynthesis = undefined
        release()
      }
      await until((d) => d.jobs.find((job) => job.id === jobId)?.status === 'completed', project.id)
      const completed: JobDetail = await api(`jobs/${jobId}`)
      const request: JobRequest = await api(`jobs/${jobId}/requests/${completed.requests[0]!.id}`)
      expect(request.responseStatus).toBe(200)
      expect(request.requestBody).toContain(stage === 'translate' ? line.text : '只朗读以下台词')
      expect(request.responseBody).toContain(
        stage === 'translate' ? 'translations' : voice.toString('base64')
      )
      expect(request.curl).toContain(
        stage === 'translate' ? '${TRANSLATION_API_KEY}' : '${VOLCENGINE_API_KEY}'
      )
      expect(stage === 'translate' ? translationRequests : synthesisRequests.length).toBe(count + 1)
      expect((await api('jobs?history=1')).some((job: Job) => job.id === jobId)).toBe(true)
    }
    const preview = await api(`projects/${project.id}/preview-tracks`, 'POST')
    await until((d) => d.jobs.find((job) => job.id === preview.jobId)?.status === 'completed', project.id)
    expect((await api(`jobs/${preview.jobId}`)).result.tracks.dubbed.path).toBeTruthy()
    expect((await api(`projects/${project.id}/preview-tracks`, 'POST')).jobId).toBe(preview.jobId)
    const exported = await api(`projects/${project.id}/export`, 'POST', {
      optimized: true,
      original: false,
      background: false,
      dubbed: false,
      target: 'audio'
    })
    await until((d) => d.jobs.find((job) => job.id === exported.jobId)?.status === 'completed', project.id)
    await stop()
    await start()
    const result: JobDetail = await api(`jobs/${exported.jobId}`)
    expect(result.job.status).toBe('completed')
    const file = result.result as { path: string; filename: string }
    expect(file.filename).toMatch(/\.wav$/)
    const download = await fetch(`${base}/api/media?path=${encodeURIComponent(file.path)}&download=1`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toContain(encodeURIComponent(file.filename))
    const all: Job[] = await api(`jobs?history=1`)
    const translation = all.find((job) => job.projectId === project.id && job.stage === 'translate')!
    expect((await api(`jobs/${translation.id}`)).requests).toHaveLength(1)
  })
  it('retains separate failed and successful request attempts for the same task ID', async () => {
    const history: Job[] = await api('jobs?history=1')
    const retried = history.find((job) => job.stage === 'translate' && job.attempts === 2)!
    expect(retried).toBeTruthy()
    const detail: JobDetail = await api(`jobs/${retried.id}`)
    expect(detail.requests.map((request) => [request.attempt, request.responseStatus])).toEqual([
      [1, 503],
      [2, 200]
    ])
    await expect(api('jobs/does-not-exist')).rejects.toThrow('404')
    const first = detail.requests[0]!
    await expect(api(`jobs/another-job/requests/${first.id}`)).rejects.toThrow('404')
  })
  it('rejects overlapping edits and out-of-bounds additions without changing saved sentences', async () => {
    const project = await api('projects', 'POST', { name: '时间轴校验', text: 'First line.\nSecond line.' })
    const before: ProjectDetail = await api(`projects/${project.id}`)
    const first = before.segments[0]!,
      second = before.segments[1]!
    await expect(
      api(`projects/${project.id}/segments`, 'POST', { ...first, start: first.start + 0.1 })
    ).rejects.toThrow('重叠')
    await expect(api(`segments/${second.id}`, 'PATCH', { ...second, start: first.start })).rejects.toThrow(
      '重叠'
    )
    expect((await api(`projects/${project.id}`)).segments).toEqual(before.segments)
    await api(`segments/${second.id}`, 'PATCH', { ...second, start: first.end })
    const upload = new FormData()
    upload.set('name', '媒体边界校验')
    upload.set('file', new Blob([new Uint8Array(voice)], { type: 'audio/mp3' }), 'source.mp3')
    const response = await fetch(`${base}/api/projects`, { method: 'POST', body: upload })
    expect(response.status).toBe(200)
    const audioId = (await response.json()).id
    const media: ProjectDetail = await api(`projects/${audioId}`)
    await expect(
      api(`projects/${audioId}/segments`, 'POST', {
        start: 0,
        end: media.project.duration + 0.1,
        text: 'Out of range',
        translation: '',
        speaker: '角色 1',
        enabled: true
      })
    ).rejects.toThrow('超出')
    expect((await api(`projects/${audioId}`)).segments).toEqual([])
  })
  it('saves normalized role voices locally and preserves them through batch synthesis', async () => {
    const project = await api('projects', 'POST', {
      name: '角色音色',
      text: 'First role.\nSecond role.\nOriginal only.'
    })
    const before: ProjectDetail = await api(`projects/${project.id}`)
    const [first, second, third] = before.segments
    await api(`segments/${first!.id}`, 'PATCH', { ...first, speaker: ' 主角 ' })
    await api(`segments/${second!.id}`, 'PATCH', { ...second, speaker: '配角' })
    await api(`segments/${third!.id}`, 'PATCH', { ...third, speaker: '', enabled: false })
    const male = { ...defaultVoiceSettings(false), aiSpeaker: 'male-fixture', aiSpeechRate: 5 }
    const female = { ...defaultVoiceSettings(false), aiSpeaker: 'female-fixture', aiSpeechRate: -5 }
    const offset = synthesisRequests.length
    for (const [speaker, voiceSettings] of [
      ['主角', male],
      ['配角', female],
      ['角色 1', female]
    ] as const) {
      expect(
        await api(`projects/${project.id}/speaker-voice`, 'POST', { speaker, voice: voiceSettings })
      ).toEqual({ ok: true, updated: 1 })
    }
    const configured: ProjectDetail = await api(`projects/${project.id}`)
    expect(configured.jobs).toEqual([])
    expect(synthesisRequests).toHaveLength(offset)
    await expect(
      api(`projects/${project.id}/speaker-voice`, 'POST', { speaker: '不存在', voice: male })
    ).rejects.toThrow('没有可配置')
    expect((await api(`projects/${project.id}`)).segments).toEqual(configured.segments)
    let release!: () => void
    holdSynthesis = new Promise((resolve) => {
      release = resolve
    })
    let queued: Job[] = []
    try {
      queued = await api(`projects/${project.id}/batch`, 'POST', {
        action: 'synthesize',
        scope: 'all',
        useSegmentVoices: true
      })
      await expect(
        api(`projects/${project.id}/speaker-voice`, 'POST', { speaker: '主角', voice: female })
      ).rejects.toThrow('409')
    } finally {
      holdSynthesis = undefined
      release()
    }
    const done = await until(
      (detail) =>
        queued.every((job) => detail.jobs.find((item) => item.id === job.id)?.status === 'completed'),
      project.id
    )
    expect(
      synthesisRequests
        .slice(offset)
        .map((request) => [request.references?.[0]?.speaker, request.audio_config.speech_rate])
    ).toEqual([
      ['male-fixture', 5],
      ['female-fixture', -5]
    ])
    expect(done.segments[0]!.generatedPath).toBeTruthy()
    expect(done.segments[1]!.generatedPath).toBeTruthy()
    expect(done.segments[2]!.generatedPath).toBeNull()
    expect(
      await api(`projects/${project.id}/speaker-voice`, 'POST', { speaker: '主角', voice: male })
    ).toEqual({ ok: true, updated: 0 })
    const unchanged: ProjectDetail = await api(`projects/${project.id}`)
    expect(unchanged.segments).toEqual(done.segments)
    expect(unchanged.project).toEqual(done.project)
    await api(`projects/${project.id}/speaker-voice`, 'POST', {
      speaker: '主角',
      voice: { ...male, aiSpeechRate: 10 }
    })
    const changed: ProjectDetail = await api(`projects/${project.id}`)
    expect(changed.segments[0]).toMatchObject({
      generatedPath: null,
      generatedHash: null,
      generatedDuration: null,
      subtitle: null
    })
    expect(changed.segments[1]).toEqual(done.segments[1])
  })
  it('generates from one complete prompt with replaceable and removable audio references', async () => {
    const project = await api('projects', 'POST', { name: '配音输入框验证', text: '不可改动的原文' })
    const original: ProjectDetail = await api(`projects/${project.id}`)
    const line = original.segments[0]!
    const uploadReference = async (name: string) => {
      const form = new FormData()
      form.set('file', new Blob([new Uint8Array(voice)], { type: 'audio/mpeg' }), name)
      const response = await fetch(`${base}/api/segments/${line.id}/reference`, {
        method: 'POST',
        body: form
      })
      expect(response.status).toBe(200)
      return response.json() as Promise<{ path: string; name: string }>
    }
    const first = await uploadReference('参考一.mp3')
    const second = await uploadReference('参考二.mp3')
    expect(first.path).not.toBe(second.path)
    expect(second.name).toBe('参考二.mp3')
    expect((await api(`projects/${project.id}`)).segments[0]).toEqual(line)
    const generationPrompt = '用轻松的语气说：「配音测试」'
    const before = synthesisRequests.length
    await api(`segments/${line.id}/generate`, 'POST', {
      ...defaultVoiceSettings(),
      generationPrompt,
      customReferencePath: second.path
    })
    const done = await until((d) => d.jobs.every((j) => j.status === 'completed'), project.id)
    expect(done.segments[0]).toMatchObject({
      text: line.text,
      translation: line.translation,
      generationPrompt,
      customReferencePath: second.path
    })
    expect(synthesisRequests[before]!.text_prompt).toContain(generationPrompt)
    expect(synthesisRequests[before]!.text_prompt).not.toContain(line.text)
    expect(synthesisRequests[before]!.references?.[0]?.audio_data).toBe(
      (await readFile(join(process.env.REDUB_DATA_DIR!, second.path))).toString('base64')
    )
    await api(`segments/${line.id}/generate`, 'POST', {
      ...defaultVoiceSettings(false),
      generationPrompt,
      customReferencePath: null
    })
    const removed = await until((d) => d.jobs.every((j) => j.status === 'completed'), project.id)
    expect(removed.segments[0]!.customReferencePath).toBeNull()
    expect(synthesisRequests[before + 1]!.references).toBeUndefined()
    expect(synthesisRequests[before + 1]!.text_prompt).not.toContain('@音频1')
    const exported = await api(`projects/${project.id}/export`, 'POST', {
      optimized: true,
      original: false,
      background: false,
      dubbed: false,
      target: 'audio'
    })
    await until((d) => d.jobs.find((j) => j.id === exported.jobId)?.status === 'completed', project.id)
    const exportDetail: JobDetail = await api(`jobs/${exported.jobId}`)
    const result = exportDetail.result as { subtitlePath: string }
    const subtitle = await readFile(join(process.env.REDUB_DATA_DIR!, result.subtitlePath), 'utf8')
    expect(subtitle).toContain('配音测试')
    expect(subtitle).not.toContain('轻松')
    expect(subtitle).not.toContain(line.text)
    await api(`projects/${project.id}`, 'PATCH', {
      name: original.project.name,
      sourceLanguage: 'auto',
      targetLanguage: 'English',
      channelId: original.project.channelId
    })
    expect((await api(`projects/${project.id}`)).segments[0]!.generationPrompt).toBeNull()
  })
  it('rejects invalid references and prompts without changing a segment or adding jobs', async () => {
    const project = await api('projects', 'POST', { name: '无效参考验证', text: '原文' })
    const original: ProjectDetail = await api(`projects/${project.id}`)
    const line = original.segments[0]!
    const dir = join(process.env.REDUB_DATA_DIR!, project.id)
    const initialFiles = await readdir(dir)
    const longPath = join(process.env.REDUB_DATA_DIR!, 'long-reference.wav')
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=550:duration=31', longPath])
    for (const file of [Buffer.from('not an audio file'), await readFile(longPath)]) {
      const form = new FormData()
      form.set('file', new Blob([new Uint8Array(file)]), 'reference.wav')
      expect(
        (await fetch(`${base}/api/segments/${line.id}/reference`, { method: 'POST', body: form })).status
      ).toBe(400)
    }
    expect(await readdir(dir)).toEqual(initialFiles)
    for (const fields of [
      { generationPrompt: '   ' },
      { customReferencePath: `another-project/reference-upload-123.wav` },
      { customReferencePath: `${project.id}/reference-upload-123.wav` },
      { customReferencePath: `${project.id}/../secret.wav` }
    ]) {
      await expect(
        api(`segments/${line.id}/generate`, 'POST', { ...defaultVoiceSettings(false), ...fields })
      ).rejects.toThrow('400')
    }
    expect(await api(`projects/${project.id}`)).toEqual(original)
  })
  it('previews completed clips while another dubbing task is still running', async () => {
    const project = await api('projects', 'POST', { name: '边生成边预览', text: '第一句\n第二句' })
    const initial: ProjectDetail = await api(`projects/${project.id}`)
    const [first, second] = initial.segments
    await api(`segments/${first!.id}/generate`, 'POST', defaultVoiceSettings(false))
    await until((d) => d.jobs.every((job) => job.status === 'completed'), project.id)
    let release!: () => void
    holdSynthesis = new Promise<void>((resolve) => {
      release = resolve
    })
    let revision = ''
    try {
      await api(`segments/${second!.id}/generate`, 'POST', defaultVoiceSettings(false))
      await until((d) => d.jobs.some((job) => job.status === 'running'), project.id)
      const response = await fetch(`${base}/api/projects/${project.id}/preview-tracks`, {
        signal: AbortSignal.timeout(8000)
      })
      expect(response.status).toBe(200)
      const preview = await response.json()
      revision = preview.revision
      expect(preview.missingDubs).toBe(1)
      expect(preview.replacementRanges).toEqual([{ start: first!.start, end: first!.end }])
      expect(preview.tracks.optimized.path).toBeTruthy()
      expect(
        (await fetch(`${base}/api/media?path=${encodeURIComponent(preview.tracks.optimized.path)}`)).status
      ).toBe(200)
      const during: ProjectDetail = await api(`projects/${project.id}`)
      expect(during.jobs).toHaveLength(2)
      expect(during.jobs.some((job) => job.status === 'running')).toBe(true)
    } finally {
      holdSynthesis = undefined
      release()
    }
    await until((d) => d.jobs.every((job) => job.status === 'completed'), project.id)
    const ready = await api(`projects/${project.id}/preview-tracks`)
    expect(ready.missingDubs).toBe(0)
    expect(ready.replacementRanges).toHaveLength(2)
    expect(ready.revision).not.toBe(revision)
  })
  it('serves signed web updates immediately without restarting the local API', async () => {
    const { installWebUpdate } = createRequire(import.meta.url)('../electron/web-update.cjs')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const html = Buffer.from('<h1>Verified web update</h1>')
    const payload = Buffer.from(
      JSON.stringify({
        version: '0.1.1',
        minDesktopVersion: '0.1.0',
        files: [
          {
            path: 'index.html',
            data: html.toString('base64'),
            sha256: createHash('sha256').update(html).digest('hex')
          }
        ]
      })
    )
    await installWebUpdate({
      url: 'https://example.test/web.json',
      root: join(process.env.REDUB_DATA_DIR!, 'web'),
      desktopVersion: '0.1.0',
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      fetcher: async () =>
        new Response(
          JSON.stringify({
            payload: payload.toString('base64'),
            signature: sign(null, payload, privateKey).toString('base64')
          })
        )
    })
    expect(await (await fetch(base + '/')).text()).toContain('Verified web update')
    expect((await api('projects')).some((p: { id: string }) => p.id === id)).toBe(true)
  })
  it('supports restoring past translation or dubbing versions via /api/segments/:id/restore-version', async () => {
    const project = await api('projects', 'POST', {
      name: 'Version restore test',
      text: 'Original dialogue'
    })
    const detail: ProjectDetail = await api(`projects/${project.id}`)
    const seg = detail.segments[0]!

    await api(`segments/${seg.id}`, 'PATCH', {
      start: seg.start,
      end: seg.end,
      speaker: seg.speaker,
      text: seg.text,
      translation: 'Version 1 Translation',
      enabled: true
    })
    await api(`segments/${seg.id}`, 'PATCH', {
      start: seg.start,
      end: seg.end,
      speaker: seg.speaker,
      text: seg.text,
      translation: 'Version 2 Translation',
      enabled: true
    })

    const afterUpdate: ProjectDetail = await api(`projects/${project.id}`)
    const updatedSeg = afterUpdate.segments[0]!
    expect(updatedSeg.translation).toBe('Version 2 Translation')
    expect(updatedSeg.translationHistory?.length).toBeGreaterThanOrEqual(2)

    const v1 = updatedSeg.translationHistory!.find((v) => v.text === 'Version 1 Translation')!
    expect(v1).toBeTruthy()

    const res = await api(`segments/${seg.id}/restore-version`, 'POST', {
      type: 'translation',
      versionId: v1.id
    })
    expect(res.ok).toBe(true)
    expect(res.segment.translation).toBe('Version 1 Translation')

    const verified: ProjectDetail = await api(`projects/${project.id}`)
    expect(verified.segments[0]!.translation).toBe('Version 1 Translation')
  })
})
