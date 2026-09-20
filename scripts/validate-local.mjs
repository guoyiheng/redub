// Real local model smoke test. Run against npm run dev after models:install.
import { readFile } from 'node:fs/promises'
const base = process.env.REDUB_TEST_URL || 'http://127.0.0.1:3000'
const file = process.argv[2]
if (!file) throw new Error('传入一个短音视频测试文件')
async function request(path, options) {
  const response = await fetch(base + path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.statusMessage || response.statusText)
  return data
}
const form = new FormData()
form.append('name', '本地管线验证 · ' + new Date().toISOString().slice(0, 10))
form.append('file', new Blob([await readFile(file)]), file.split('/').at(-1))
const project = await request('/api/projects', { method: 'POST', body: form })
await request(`/api/projects/${project.id}/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}'
})
let last = ''
for (let i = 0; i < 1800; i++) {
  const detail = await request(`/api/projects/${project.id}`)
  const state = detail.jobs.map((j) => `${j.stage}:${j.status}`).join(' | ')
  if (state !== last) {
    console.log(state)
    last = state
  }
  const failed = detail.jobs.find((j) => j.status === 'failed')
  if (failed) {
    if (failed.stage !== 'translate' || !failed.error.includes('TRANSLATION_API_KEY'))
      throw new Error(failed.error)
    if (!detail.segments.length || !detail.segments.every((s) => s.text.trim()))
      throw new Error('本地识别未生成台词')
    console.log(
      JSON.stringify(
        {
          projectId: project.id,
          segments: detail.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
          expectedBlock: failed.error
        },
        null,
        2
      )
    )
    // Resolve this test's pending queue; no original project media is removed.
    for (const job of [...detail.jobs].reverse().filter((j) => ['queued', 'failed'].includes(j.status)))
      await request(`/api/jobs/${job.id}/skip`, { method: 'POST' })
    process.exit(0)
  }
  if (detail.jobs.every((j) => ['completed', 'skipped'].includes(j.status))) {
    console.log(`验证完成 ${project.id}`)
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, 1000))
}
throw new Error('验证超时，请检查任务管理器')
