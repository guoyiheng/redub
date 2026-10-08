import { createHash } from 'node:crypto'
import { stat, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { segments } from '../db/schema'
import { getProject } from './store'
import { assetPath, cutAudio } from './media'
const pending = new Map<string, Promise<void>>()
export async function originalClip(id: string) {
  const [line] = await db.select().from(segments).where(eq(segments.id, id))
  if (!line) throw new Error('台词不存在')
  const project = await getProject(line.projectId)
  if (project.kind === 'text') throw new Error('文本项目没有原声')
  let source = project.audioPath && existsSync(assetPath(project.audioPath)) ? project.audioPath : null
  if (!source) {
    source = project.sourcePath && existsSync(assetPath(project.sourcePath)) ? project.sourcePath : null
  }
  if (!source) throw new Error('原声音频素材文件不存在')
  const info = await stat(assetPath(source))
  const duration = Math.max(0.05, line.end - line.start)
  const hash = createHash('sha256')
    .update(JSON.stringify([source, info.mtimeMs, info.size, line.start, duration]))
    .digest('hex')
    .slice(0, 20)
  const output = `${project.id}/original-${id}-${hash}.wav`
  if (!existsSync(assetPath(output))) {
    let task = pending.get(output)
    if (!task) {
      const temporary = assetPath(`${output}.partial.wav`)
      task = cutAudio(assetPath(source), temporary, line.start, duration)
        .then(() => rename(temporary, assetPath(output)))
        .finally(async () => {
          await rm(temporary, { force: true })
          pending.delete(output)
        })
      pending.set(output, task)
    }
    await task
  }
  return output
}
