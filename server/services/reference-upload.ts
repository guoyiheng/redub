import formidable from 'formidable'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { H3Event } from 'h3'
import { assetPath, cutAudio, probe, projectDir } from './media'

export async function uploadReference(event: H3Event, projectId: string, library = false) {
  const dir = await projectDir(projectId)
  const path = `${projectId}/reference-upload-${randomUUID()}.wav`
  const temp: string[] = []
  try {
    const form = formidable({
      uploadDir: dir,
      maxFiles: 1,
      maxFileSize: 10 * 1024 ** 2,
      maxFields: 1,
      maxFieldsSize: 1024
    })
    form.on('fileBegin', (_name, file) => {
      temp.push(file.filepath)
    })
    const [fields, files] = await form.parse(event.node.req).catch(() => {
      throw new Error('请上传一个不超过 10 MB 的音频文件')
    })
    const file = files.file?.[0]
    if (!file) throw new Error('请选择参考音频')
    const info = await probe(file.filepath).catch(() => {
      throw new Error('无法读取参考音频，请选择有效的音频文件')
    })
    if (info.video || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > 30)
      throw new Error('请选择 30 秒以内的有效音频文件')
    await cutAudio(file.filepath, assetPath(path), 0, info.duration)
    const name = (
      fields.name?.[0]?.trim() ||
      (library ? file.originalFilename?.replace(/\.[^.]+$/, '') : file.originalFilename)?.trim() ||
      '参考音色'
    ).slice(0, 80)
    return { path, name, duration: info.duration }
  } catch (error) {
    await rm(assetPath(path), { force: true })
    throw error
  } finally {
    await Promise.all(temp.map((file) => rm(file, { force: true })))
  }
}
