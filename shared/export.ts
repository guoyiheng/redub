import { z } from 'zod'

export const exportSchema = z.object({
  optimized: z.boolean().default(false),
  original: z.boolean(),
  background: z.boolean(),
  dubbed: z.boolean(),
  originalMode: z.enum(['preserve-gaps', 'full']).default('preserve-gaps'),
  format: z.enum(['mkv', 'mp4', 'wav'])
})
export type ExportOptions = z.infer<typeof exportSchema>
export interface ExportResult {
  path: string
  filename: string
}

export const exportTrackKeys = ['optimized', 'original', 'background', 'dubbed'] as const
export type ExportTrackKey = (typeof exportTrackKeys)[number]

export function selectedTrackKeys(options: ExportOptions): ExportTrackKey[] {
  return exportTrackKeys.filter((key) => options[key])
}
