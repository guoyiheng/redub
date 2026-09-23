import { checkJobCancelled } from './job-context'
import { jobTransaction } from './job-transaction'
import { randomUUID } from 'node:crypto'
import { join, basename } from 'node:path'
import { copyFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { jobs, projects, segments } from '../db/schema'
import { getProject, getSegments, getActiveChannel, getSettings, invalidateOutput } from './store'
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
import type { Job, Segment, TranslationVersion, AudioVersion } from '../../shared/types'
import { exportProject } from './export'
import { getPreviewTracks } from './preview-tracks'
import { assertTimeline } from '../../shared/timeline'
import { dubbedText, composeVoicePrompt } from '../../shared/voice'
import { createVersionName } from '../../shared/version'
import { translationTaskSchema } from '../../shared/translation'

export async function executeJob(job: Job, progress: (value: number, message: string) => Promise<void>) {
  checkJobCancelled()
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
  const [savedJob] = await db.select({ input: jobs.input }).from(jobs).where(eq(jobs.id, job.id))
  const savedInput = savedJob?.input as { translation?: unknown } | undefined
  const translation = translationTaskSchema.parse(savedInput?.translation || {})
  await db
    .update(jobs)
    .set({ input: { project: p, segments: await getSegments(p.id), translation } })
    .where(eq(jobs.id, job.id))
  const dir = await projectDir(p.id)
  const rel = (name: string) => `${p.id}/${name}`
  const update = async (value: Partial<typeof p>) => {
    await jobTransaction(async (tx) => {
      await tx
        .update(projects)
        .set({ ...value, updatedAt: Date.now() })
        .where(eq(projects.id, p.id))
    })
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
    await jobTransaction(async (tx) => {
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
    await jobTransaction(async (tx) => {
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
        await jobTransaction(async (tx) => {
          await tx.update(segments).set({ referencePath: ref }).where(eq(segments.id, line.id))
        })
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
      !Array.isArray(result) ||
      result.length !== lines.length ||
      new Set(result.map((s) => s.id)).size !== lines.length ||
      result.some((s) => typeof s.text !== 'string' || !lines.some((line) => line.id === s.id))
    )
      throw new Error('识别结果片段不完整，请重试')
    await jobTransaction(async (tx) => {
      for (const row of result) {
        const text = row.text.trim()
        await tx
          .update(segments)
          .set({
            text,
            translation: '',
            generationPrompt: null,
            generatedPath: null,
            generatedHash: null,
            generatedDuration: null,
            subtitle: null,
            ...(text ? {} : { enabled: false })
          })
          .where(eq(segments.id, row.id))
      }
      await tx
        .update(projects)
        .set({ mixedPath: null, outputPath: null, updatedAt: Date.now() })
        .where(eq(projects.id, p.id))
    })
  }
  if (job.stage === 'translate') {
    const lines = (await getSegments(p.id)).filter((s) =>
      job.segmentId ? s.id === job.segmentId : s.enabled
    )
    if (!lines.length || lines.some((s) => !s.text.trim()))
      throw new Error('请先识别或填写所有启用片段的原文')
    const channel = await getActiveChannel('openai')
    if (channel.type !== 'openai') throw new Error('翻译渠道类型不正确')
    await progress(15, `正在翻译 ${lines.length} 句台词...`)
    const targetLanguage = translation.targetLanguage || p.targetLanguage
    const inputLines =
      translation.text && job.segmentId ? lines.map((line) => ({ ...line, text: translation.text! })) : lines
    const result = await translateLines(
      inputLines,
      targetLanguage,
      channel,
      translation.sourceLanguage || p.sourceLanguage,
      translation.prompt
    )
    await jobTransaction(async (tx) => {
      for (const s of lines) {
        const newText = result.get(s.id)!
        const tone = result.tones?.get(s.id)
        const history: TranslationVersion[] = [...(s.translationHistory || [])]
        if (s.translation && s.translation.trim() && history.length === 0) {
          history.push({
            id: randomUUID(),
            name: createVersionName([], new Date(Date.now() - 60000)),
            text: s.translation,
            language: s.translationLanguage,
            createdAt: Date.now() - 60000
          })
        }
        history.push({
          id: randomUUID(),
          name: createVersionName(history.map((v) => v.name)),
          text: newText,
          language: targetLanguage,
          createdAt: Date.now()
        })
        const generationPrompt = composeVoicePrompt({
          language: targetLanguage,
          direction: s.aiPrompt,
          useReference: s.aiUseReference,
          tone,
          text: newText
        })
        await tx
          .update(segments)
          .set({
            translation: newText,
            translationLanguage: targetLanguage,
            translationHistory: history,
            generationPrompt
          })
          .where(eq(segments.id, s.id))
        s.translation = newText
        s.translationLanguage = targetLanguage
        s.translationHistory = history
        s.generationPrompt = generationPrompt
      }
    })
    await progress(100, `已完成全部 ${lines.length} 句台词翻译`)
  }
  if (job.stage === 'synthesize') {
    const allLines = await getSegments(p.id)
    const lines = allLines.filter((s) => s.enabled && (!job.segmentId || s.id === job.segmentId))
    if (!lines.length) throw new Error('没有启用的配音片段')
    const needsAi = lines.some((s) => s.synthesisMode !== 'tts')
    const needsReference = lines.some(
      (s) => s.synthesisMode !== 'tts' && s.aiUseReference && !s.customReferencePath
    )
    const channel = needsAi ? await getActiveChannel('volcengine') : undefined
    if (needsReference && p.kind !== 'text' && (!p.vocalsPath || !existsSync(assetPath(p.vocalsPath))))
      throw new Error('请先完成人声分离，再使用原声参考配音')
    await invalidateOutput(p.id)
    for (let i = 0; i < lines.length; i++) {
      checkJobCancelled()
      const s = lines[i]!
      if (
        s.synthesisMode !== 'tts' &&
        s.aiUseReference &&
        !s.customReferencePath &&
        p.kind !== 'text' &&
        (!s.referencePath || !existsSync(assetPath(s.referencePath)))
      ) {
        const referencePath = rel(`reference-${s.id}-${randomUUID()}.wav`)
        await cutAudio(assetPath(p.vocalsPath!), assetPath(referencePath), s.start, s.end - s.start)
        const audioHist: AudioVersion[] = [...(s.audioHistory || [])]
        if (s.generatedPath && audioHist.length === 0) {
          audioHist.push({
            id: randomUUID(),
            name: createVersionName([], new Date(Date.now() - 60000)),
            audioPath: s.generatedPath,
            duration: s.generatedDuration,
            synthesisMode: s.synthesisMode,
            speaker: s.synthesisMode === 'ai' ? s.aiSpeaker : s.ttsVoice,
            generationPrompt: s.generationPrompt ?? null,
            subtitle: s.subtitle ?? null,
            createdAt: Date.now() - 60000
          })
        }
        await jobTransaction(async (tx) => {
          await tx
            .update(segments)
            .set({
              referencePath,
              generatedPath: null,
              generatedHash: null,
              generatedDuration: null,
              subtitle: null,
              audioHistory: audioHist.length ? audioHist : undefined
            })
            .where(eq(segments.id, s.id))
        })
        s.referencePath = referencePath
        s.generatedPath = null
        s.generatedHash = null
        s.audioHistory = audioHist
      }
      const hash = synthesisHash(s, channel, s.translationLanguage || p.targetLanguage)
      if (s.generatedPath && s.generatedHash === hash && existsSync(assetPath(s.generatedPath))) continue
      await progress(
        Math.round((i / lines.length) * 100),
        `正在配音 ${i + 1} / ${lines.length}，保留已成功片段`
      )
      const output = rel(
        `voice-${s.id}-${randomUUID()}.${s.synthesisMode === 'ai' ? (s.aiFormat === 'wav' ? 'wav' : 'mp3') : 'mp3'}`
      )
      const result = await synthesizeSpeech(
        s,
        channel!,
        assetPath(output),
        s.translationLanguage || p.targetLanguage,
        allLines.filter((line) => line.id !== s.id && line.end <= s.start).slice(-3)
      )
      const audioHistory: AudioVersion[] = [...(s.audioHistory || [])]
      if (s.generatedPath && audioHistory.length === 0) {
        audioHistory.push({
          id: randomUUID(),
          name: createVersionName([], new Date(Date.now() - 60000)),
          audioPath: s.generatedPath,
          duration: s.generatedDuration,
          synthesisMode: s.synthesisMode,
          speaker: s.synthesisMode === 'ai' ? s.aiSpeaker : s.ttsVoice,
          generationPrompt: s.generationPrompt ?? null,
          subtitle: s.subtitle ?? null,
          createdAt: Date.now() - 60000
        })
      }
      audioHistory.push({
        id: randomUUID(),
        name: createVersionName(audioHistory.map((v) => v.name)),
        audioPath: output,
        duration: result.duration,
        synthesisMode: s.synthesisMode,
        speaker: s.synthesisMode === 'ai' ? s.aiSpeaker : s.ttsVoice,
        generationPrompt: s.generationPrompt ?? null,
        subtitle: result.subtitle ?? null,
        createdAt: Date.now()
      })
      await jobTransaction(async (tx) => {
        await tx
          .update(segments)
          .set({
            generatedPath: output,
            generatedHash: hash,
            generatedDuration: result.duration,
            subtitle: result.subtitle,
            audioHistory
          })
          .where(eq(segments.id, s.id))
      })
      s.generatedPath = output
      s.generatedHash = hash
      s.generatedDuration = result.duration
      s.subtitle = result.subtitle
      s.audioHistory = audioHistory
    }
  }
  if (job.stage === 'mix') {
    await invalidateOutput(p.id)
    const lines = await getSegments(p.id)
    const duration = p.kind === 'text' ? Math.max(0, ...lines.map((s) => s.end)) : p.duration
    if (duration <= 0) throw new Error('没有可合并的音轨')
    assertTimeline(lines, duration)
    if (p.kind === 'text' && lines.some((s) => s.enabled && !s.generatedPath))
      throw new Error('文本项目没有原声，请先生成所有需要替换的配音')
    const enabled = lines.filter((s) => s.enabled && s.generatedPath)
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
      const { start, end } = line
      await chunk(cursor, start)
      await chunk(start, end, line)
      cursor = end
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
          .map((s) => ({ ...s, text: s.enabled && s.generatedPath ? dubbedText(s) : s.text }))
          .filter((s) => s.text.trim())
      )
    )
    await update({ mixedPath: mixed, duration })
  }
  if (job.stage === 'preview') {
    if (!p.mixedPath) throw new Error('请先合并音轨')
    if (p.kind === 'video') {
      await progress(10, '正在为原视频追加配音音轨')
      const output = await exportProject(p.id, { target: 'video', optimized: true })
      await update({ outputPath: output.path })
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
