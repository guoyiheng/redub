import { randomUUID } from 'node:crypto'
import { join, basename } from 'node:path'
import { copyFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { jobs, projects, segments } from '../db/schema'
import { getProject, getSegments, getChannel, getSettings, invalidateOutput } from './store'
import {
  assetPath,
  projectDir,
  extractAudio,
  cutAudio,
  ffmpeg,
  alignAudio,
  python,
  runProcess,
  localModel
} from './media'
import { synthesizeSpeech, synthesisHash, translateLines } from './providers'
import { subtitleText } from './text'
import type { Job, Segment } from '../../shared/types'
import { exportProject } from './export'
import { getPreviewTracks } from './preview-tracks'

export async function executeJob(job: Job, progress: (value: number, message: string) => Promise<void>) {
  const p = await getProject(job.projectId)
  if (job.stage === 'export') {
    const [row] = await db.select({ input: jobs.input }).from(jobs).where(eq(jobs.id, job.id))
    await progress(10, '正在导出成片，完成后可在任务详情下载')
    return exportProject(p.id, row?.input)
  }
  if (job.stage === 'preview-tracks') {
    await progress(10, '正在准备预览音轨与波形')
    return getPreviewTracks(p.id)
  }
  await db
    .update(jobs)
    .set({ input: { project: p, segments: await getSegments(p.id) } })
    .where(eq(jobs.id, job.id))
  const dir = await projectDir(p.id)
  const rel = (name: string) => `${p.id}/${name}`
  const update = async (value: Partial<typeof p>) => {
    await db
      .update(projects)
      .set({ ...value, updatedAt: Date.now() })
      .where(eq(projects.id, p.id))
  }
  if (job.stage === 'extract') {
    if (!p.sourcePath) throw new Error('请先导入音视频素材')
    await progress(10, '正在提取无损音轨')
    await extractAudio(assetPath(p.sourcePath), join(dir, 'original.wav'))
    await update({ audioPath: rel('original.wav') })
  }
  if (job.stage === 'separate') {
    const source = p.audioPath || p.sourcePath
    if (!source) throw new Error('没有可分离的音轨')
    await progress(5, '本机分离人声和背景，首次执行需下载模型')
    if (!p.audioPath) {
      await extractAudio(assetPath(source), join(dir, 'original.wav'))
      await update({ audioPath: rel('original.wav') })
    }
    await runProcess(python(), [
      '-m',
      'demucs.separate',
      '--two-stems',
      'vocals',
      '-n',
      'htdemucs',
      '-d',
      'cpu',
      '-o',
      join(dir, 'stems'),
      join(dir, 'original.wav')
    ])
    const revision = randomUUID()
    const vocalsPath = rel(`vocals-${revision}.wav`)
    const backgroundPath = rel(`background-${revision}.wav`)
    await copyFile(join(dir, 'stems/htdemucs/original/vocals.wav'), assetPath(vocalsPath))
    await copyFile(join(dir, 'stems/htdemucs/original/no_vocals.wav'), assetPath(backgroundPath))
    // Publish both stems together; previous results remain usable if separation fails.
    await db.transaction(async (tx) => {
      await tx
        .update(projects)
        .set({
          vocalsPath,
          backgroundPath,
          mixedPath: null,
          outputPath: null,
          updatedAt: Date.now()
        })
        .where(eq(projects.id, p.id))
      await tx
        .update(segments)
        .set({
          referencePath: null,
          generatedPath: null,
          generatedHash: null,
          generatedDuration: null,
          subtitle: null
        })
        .where(eq(segments.projectId, p.id))
    })
  }
  if (job.stage === 'segment') {
    if (!p.vocalsPath) throw new Error('请先完成人声分离')
    const existing = await getSegments(p.id)
    if (existing.length)
      throw new Error('项目已有片段；为保留编辑内容，不自动覆盖。可手动调整片段或重新导入项目')
    await progress(10, '检测人声起止时间')
    const spans: { start: number; end: number }[] = await localModel(
      'segment',
      { audio: assetPath(p.vocalsPath) },
      join(dir, 'vad.json')
    )
    if (!spans.length) throw new Error('未检测到人声，请检查素材或手动添加片段')
    const rows: (typeof segments.$inferInsert)[] = []
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]!,
        id = randomUUID()
      const end = Math.min(span.end, p.duration)
      if (end <= span.start) continue
      const ref = rel(`reference-${id}.wav`)
      await cutAudio(assetPath(p.vocalsPath), assetPath(ref), span.start, end - span.start)
      rows.push({ id, projectId: p.id, start: span.start, end, referencePath: ref })
      await progress(15 + Math.round((80 * (i + 1)) / spans.length), `切分人声 ${i + 1} / ${spans.length}`)
    }
    await db.transaction(async (tx) => {
      for (const row of rows) await tx.insert(segments).values(row)
    })
  }
  if (job.stage === 'transcribe') {
    const lines = await getSegments(p.id)
    if (!lines.length) throw new Error('请先分段或手动添加片段')
    await progress(10, '本机识别台词，首次执行需下载模型')
    const inputs = []
    for (const line of lines) {
      let ref = line.referencePath
      if (!ref) {
        const source = p.vocalsPath || p.audioPath || p.sourcePath
        if (!source) throw new Error('没有可识别的人声文件')
        ref = rel(`reference-${line.id}.wav`)
        await cutAudio(assetPath(source), assetPath(ref), line.start, line.end - line.start)
        await db.update(segments).set({ referencePath: ref }).where(eq(segments.id, line.id))
      }
      inputs.push({ id: line.id, audio: assetPath(ref) })
    }
    const settings = await getSettings()
    const result: { id: string; text: string }[] = await localModel(
      'transcribe',
      {
        segments: inputs,
        model: settings.whisperModel,
        language: p.sourceLanguage === 'auto' ? null : p.sourceLanguage
      },
      join(dir, 'transcript.json')
    )
    if (
      result.length !== lines.length ||
      new Set(result.map((s) => s.id)).size !== lines.length ||
      result.some((s) => typeof s.text !== 'string' || !s.text.trim())
    )
      throw new Error('部分片段没有识别到台词，请调整片段或手动填写')
    await invalidateOutput(p.id)
    for (const row of result) {
      if (!lines.some((s) => s.id === row.id)) throw new Error('识别返回未知片段')
      await db
        .update(segments)
        .set({ text: row.text, translation: '', generatedPath: null, generatedHash: null })
        .where(eq(segments.id, row.id))
    }
    await invalidateOutput(p.id)
  }
  if (job.stage === 'translate') {
    const lines = (await getSegments(p.id)).filter((s) => s.enabled)
    if (!lines.length || lines.some((s) => !s.text.trim()))
      throw new Error('请先识别或填写所有启用片段的原文')
    const channel = await getChannel((await getSettings()).translationChannelId)
    if (channel.type !== 'openai') throw new Error('翻译渠道类型不正确')
    await invalidateOutput(p.id)
    for (let i = 0; i < lines.length; i += 20) {
      const batch = lines.slice(i, i + 20)
      const result = await translateLines(batch, p.targetLanguage, channel)
      await db.transaction(async (tx) => {
        for (const s of batch)
          await tx
            .update(segments)
            .set({ translation: result.get(s.id)!, generatedPath: null, generatedHash: null })
            .where(eq(segments.id, s.id))
      })
      await progress(
        Math.round((100 * Math.min(i + 20, lines.length)) / lines.length),
        `已翻译 ${Math.min(i + 20, lines.length)} / ${lines.length}`
      )
    }
    await invalidateOutput(p.id)
  }
  if (job.stage === 'synthesize') {
    const lines = (await getSegments(p.id)).filter(
      (s) => s.enabled && (!job.segmentId || s.id === job.segmentId)
    )
    if (!lines.length) throw new Error('没有启用的配音片段')
    const needsAi = lines.some((s) => s.synthesisMode !== 'tts')
    const needsReference = lines.some((s) => s.synthesisMode !== 'tts' && s.aiUseReference)
    const channel = needsAi ? await getChannel(p.channelId) : undefined
    if (needsReference && p.kind !== 'text' && (!p.vocalsPath || !existsSync(assetPath(p.vocalsPath))))
      throw new Error('请先完成人声分离，再使用原声参考配音')
    await invalidateOutput(p.id)
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i]!
      if (
        s.synthesisMode !== 'tts' &&
        s.aiUseReference &&
        p.kind !== 'text' &&
        (!s.referencePath || !existsSync(assetPath(s.referencePath)))
      ) {
        const referencePath = rel(`reference-${s.id}-${randomUUID()}.wav`)
        await cutAudio(assetPath(p.vocalsPath!), assetPath(referencePath), s.start, s.end - s.start)
        await db
          .update(segments)
          .set({
            referencePath,
            generatedPath: null,
            generatedHash: null,
            generatedDuration: null,
            subtitle: null
          })
          .where(eq(segments.id, s.id))
        s.referencePath = referencePath
        s.generatedPath = null
        s.generatedHash = null
      }
      const hash = synthesisHash(s, channel)
      if (s.generatedPath && s.generatedHash === hash && existsSync(assetPath(s.generatedPath))) continue
      await progress(
        Math.round((i / lines.length) * 100),
        `正在配音 ${i + 1} / ${lines.length}，保留已成功片段`
      )
      const output = rel(
        `voice-${s.id}-${randomUUID()}.${s.synthesisMode === 'ai' ? (s.aiFormat === 'wav' ? 'wav' : 'mp3') : 'mp3'}`
      )
      const result = await synthesizeSpeech(s, channel!, assetPath(output))
      await db
        .update(segments)
        .set({
          generatedPath: output,
          generatedHash: hash,
          generatedDuration: result.duration,
          subtitle: result.subtitle
        })
        .where(eq(segments.id, s.id))
    }
  }
  if (job.stage === 'mix') {
    await invalidateOutput(p.id)
    const lines = await getSegments(p.id)
    const duration = p.kind === 'text' ? Math.max(0, ...lines.map((s) => s.end)) : p.duration
    if (duration <= 0) throw new Error('没有可合并的音轨')
    const enabled = lines.filter((s) => s.enabled)
    if (enabled.some((s) => !s.generatedPath))
      throw new Error('部分启用片段尚未生成配音，请完成配音或关闭这些片段的替换开关')
    if (p.kind !== 'text' && (!p.audioPath || (enabled.length && !p.backgroundPath)))
      throw new Error('缺少原始或背景音轨，请完成人声与背景分离')
    const chunks: string[] = []
    let cursor = 0
    const chunk = async (start: number, end: number, segment?: Segment) => {
      if (end - start < 0.00001) return
      const path = join(dir, `chunk-${job.id}-${chunks.length}.wav`)
      const length = end - start
      if (segment) {
        const aligned = join(dir, `aligned-${segment.id}.wav`)
        await alignAudio(assetPath(segment.generatedPath!), aligned, length)
        if (p.kind === 'text') await copyFile(aligned, path)
        else
          await ffmpeg([
            '-ss',
            String(start),
            '-t',
            String(length),
            '-i',
            assetPath(p.backgroundPath!),
            '-i',
            aligned,
            '-filter_complex',
            '[0:a][1:a]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.98:latency=1',
            '-t',
            String(length),
            '-ar',
            '48000',
            '-ac',
            '2',
            '-c:a',
            'pcm_s16le',
            path
          ])
      } else if (p.audioPath) {
        await ffmpeg([
          '-ss',
          String(start),
          '-i',
          assetPath(p.audioPath),
          '-t',
          String(length),
          '-ar',
          '48000',
          '-ac',
          '2',
          '-c:a',
          'pcm_s16le',
          path
        ])
      } else {
        await ffmpeg([
          '-f',
          'lavfi',
          '-i',
          'anullsrc=r=48000:cl=stereo',
          '-t',
          String(length),
          '-c:a',
          'pcm_s16le',
          path
        ])
      }
      chunks.push(path)
    }
    for (let i = 0; i < enabled.length; i++) {
      const line = enabled[i]!
      if (line.start < cursor || line.end > duration + 0.01)
        throw new Error('片段时间重叠或超出素材长度，请调整后重试')
      await chunk(cursor, line.start)
      await chunk(line.start, line.end, line)
      cursor = line.end
      await progress(
        Math.round(((i + 1) / enabled.length) * 90),
        `对齐并合并片段 ${i + 1} / ${enabled.length}`
      )
    }
    await chunk(cursor, duration)
    const listPath = join(dir, `concat-${job.id}.txt`)
    await writeFile(listPath, chunks.map((path) => `file '${basename(path)}'`).join('\n'))
    const mixed = rel(`mixed-${job.id}.wav`)
    await ffmpeg(['-f', 'concat', '-safe', '1', '-i', listPath, '-c:a', 'pcm_s16le', assetPath(mixed)])
    await writeFile(
      join(dir, 'subtitles.srt'),
      subtitleText(
        lines
          .filter((s) => p.kind !== 'text' || s.enabled)
          .map((s) => ({ ...s, text: s.enabled ? s.translation || s.text : s.text }))
      )
    )
    await update({ mixedPath: mixed, duration })
  }
  if (job.stage === 'preview') {
    if (!p.mixedPath) throw new Error('请先合并音轨')
    if (p.kind === 'video') {
      const output = rel(`dubbed-${job.id}.mp4`)
      await progress(10, '正在生成可预览的视频')
      await ffmpeg([
        '-i',
        assetPath(p.sourcePath!),
        '-i',
        assetPath(p.mixedPath),
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '256k',
        '-movflags',
        '+faststart',
        '-t',
        String(p.duration),
        assetPath(output)
      ])
      await update({ outputPath: output })
    } else {
      const output = rel(`dubbed-${job.id}.mp3`)
      await ffmpeg(['-i', assetPath(p.mixedPath), '-c:a', 'libmp3lame', '-b:a', '256k', assetPath(output)])
      await update({ outputPath: output })
    }
  }
  const resultProject = await getProject(p.id)
  return {
    audioPath: resultProject.audioPath,
    vocalsPath: resultProject.vocalsPath,
    backgroundPath: resultProject.backgroundPath,
    mixedPath: resultProject.mixedPath,
    outputPath: resultProject.outputPath,
    segments: (await getSegments(p.id))
      .filter((line) => !job.segmentId || line.id === job.segmentId)
      .map((line) => ({
        id: line.id,
        text: line.text,
        translation: line.translation,
        generatedPath: line.generatedPath,
        generatedDuration: line.generatedDuration
      }))
  }
}
