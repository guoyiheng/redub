import { z } from 'zod'
import { voiceSettingsSchema } from './voice'
import type { Project, Segment, Stage } from './types'
export const batchSchema = z
  .object({
    action: z.enum(['prepare', 'translate', 'synthesize', 'render']),
    scope: z.enum(['missing', 'all']).default('missing'),
    finish: z.boolean().default(false),
    voice: voiceSettingsSchema.optional()
  })
  .refine((v) => v.action !== 'synthesize' || !!v.voice, '请配置配音参数')
export type BatchInput = z.infer<typeof batchSchema>
export function batchPlan(
  project: Project,
  lines: Segment[],
  input: BatchInput
): { stage: Stage; segmentId?: string }[] {
  if (input.action === 'prepare') {
    if (project.kind === 'text') throw new Error('文本项目无需识别素材')
    if (lines.length) throw new Error('项目已有台词，不会重新分段覆盖编辑内容')
    const stages: Stage[] = [
      ...(project.kind === 'video' && !project.audioPath ? ['extract' as const] : []),
      ...(!project.vocalsPath || !project.backgroundPath ? ['separate' as const] : []),
      'segment',
      'transcribe'
    ]
    return stages.map((stage) => ({ stage }))
  }
  const enabled = lines.filter((s) => s.enabled)
  if (input.action === 'translate') {
    if (!enabled.length || enabled.some((s) => !s.text.trim()))
      throw new Error('请先识别或填写需要替换的台词')
    return [{ stage: 'translate' }]
  }
  if (input.action === 'render') {
    if (!lines.length) throw new Error('请先添加台词')
    if (enabled.some((s) => !s.generatedPath))
      throw new Error('请先生成所有需要替换的配音，或关闭对应替换开关')
    if (project.kind !== 'text' && (!project.audioPath || (enabled.length && !project.backgroundPath)))
      throw new Error('请先分离人声与背景音')
    return [{ stage: 'mix' }, { stage: 'preview' }]
  }
  const targets = enabled.filter((s) => input.scope === 'all' || !s.generatedPath)
  if (!targets.length) throw new Error('此范围内没有需要生成的台词')
  if (targets.some((s) => !(s.translation || s.text).trim())) throw new Error('请先填写要生成的台词')
  if (
    input.voice?.synthesisMode === 'ai' &&
    input.voice.aiUseReference &&
    (project.kind === 'text' || !project.vocalsPath)
  )
    throw new Error('没有可用原声，请选择指定音色')
  if (input.finish && project.kind !== 'text' && (!project.audioPath || !project.backgroundPath))
    throw new Error('请先分离人声与背景音，再合成成片')
  return [
    ...targets.map((s) => ({ stage: 'synthesize' as const, segmentId: s.id })),
    ...(input.finish ? [{ stage: 'mix' as const }, { stage: 'preview' as const }] : [])
  ]
}
