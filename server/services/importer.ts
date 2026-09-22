import formidable from 'formidable'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, readFile, rm } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { z } from 'zod'
import { type H3Event, getRequestHeader, readBody } from 'h3'
import { db, dataDir } from '../db'
import { projects, segments } from '../db/schema'
import { projectDir, probe } from './media'
import { parseScript } from './text'
import type { MediaKind } from '../../shared/types'

const inputSchema = z.object({
  name: z.string().trim().max(120).optional().default(''),
  text: z.string().max(200000).optional(),
  targetLanguage: z.string().trim().min(1).max(40).default('中文'),
  sourceLanguage: z.enum(['auto', 'zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru']).default('auto')
})
const extensions = [
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
  '.mp3',
  '.wav',
  '.m4a',
  '.flac',
  '.ogg',
  '.aac',
  '.txt',
  '.srt',
  '.vtt'
]
export async function importProject(event: H3Event) {
  const id = randomUUID(),
    dir = await projectDir(id)
  let temp: string | undefined
  try {
    let data: z.infer<typeof inputSchema>,
      kind: MediaKind = 'text',
      sourcePath: string | null = null,
      duration = 0,
      originalFilename: string | undefined
    if (getRequestHeader(event, 'content-type')?.startsWith('multipart/form-data')) {
      const staging = join(dataDir, 'uploads')
      await mkdir(staging, { recursive: true })
      const form = formidable({
        uploadDir: staging,
        maxFileSize: 10 * 1024 ** 3,
        maxFiles: 1,
        maxFieldsSize: 1024 * 1024
      })
      form.on('fileBegin', (_name, file) => {
        temp = file.filepath
      })
      const [fields, files] = await form.parse(event.node.req)
      const file = files.file?.[0]
      if (!file) throw new Error('请选择一个媒体或文本文件')
      originalFilename = file.originalFilename || undefined
      temp = file.filepath
      const extension = extname(file.originalFilename || '').toLowerCase()
      if (!extensions.includes(extension)) throw new Error('不支持此文件格式')
      data = inputSchema.parse(
        Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, values?.[0]]))
      )
      if (['.txt', '.srt', '.vtt'].includes(extension)) {
        if (file.size > 2 * 1024 ** 2) throw new Error('文本文件不能超过 2 MB')
        data.text = await readFile(temp, 'utf-8')
      } else {
        const info = await probe(temp)
        duration = info.duration
        kind = info.video ? 'video' : 'audio'
      }
      sourcePath = `${id}/source${extension}`
      await rename(temp, join(dir, `source${extension}`))
      temp = undefined
    } else data = inputSchema.parse(await readBody(event))
    const lines = kind === 'text' ? parseScript(data.text || '') : []
    if (lines.length > 2000) throw new Error('单个项目最多导入 2000 条台词')
    if (lines.length) duration = Math.max(...lines.map((s) => s.end))
    const projectName =
      data.name.trim() || (originalFilename ? originalFilename.replace(/\.[^.]+$/, '') : '') || '未命名项目'
    await db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id,
        name: projectName,
        kind,
        sourcePath,
        duration,
        sourceLanguage: data.sourceLanguage,
        targetLanguage: data.targetLanguage,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      for (const s of lines) await tx.insert(segments).values({ id: randomUUID(), projectId: id, ...s })
    })
    return { id }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  } finally {
    if (temp) await rm(temp, { force: true })
  }
}
