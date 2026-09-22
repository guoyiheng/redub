import { z } from 'zod'

const exportOptionsSchema = z.object({
  target: z.enum(['audio', 'video']),
  optimized: z.boolean().default(false),
  original: z.boolean().default(false),
  background: z.boolean().default(false),
  dubbed: z.boolean().default(false),
  originalMode: z.enum(['preserve-gaps', 'full']).default('preserve-gaps')
})
// Persisted jobs from earlier versions can still be retried with the new export behavior.
export const exportSchema = z.preprocess((value) => {
  if (value && typeof value === 'object' && !('target' in value) && 'format' in value) {
    if (['mkv', 'mp4', 'wav'].includes(String(value.format)))
      return { ...value, target: value.format === 'wav' ? 'audio' : 'video' }
  }
  return value
}, exportOptionsSchema)
export type ExportOptions = z.infer<typeof exportSchema>
export interface ExportResult {
  path: string
  filename: string
  subtitlePath?: string
  subtitleFilename?: string
}

export const exportTrackKeys = ['optimized', 'original', 'background', 'dubbed'] as const
export type ExportTrackKey = (typeof exportTrackKeys)[number]

export function selectedTrackKeys(options: ExportOptions): ExportTrackKey[] {
  return exportTrackKeys.filter((key) => options[key])
}
