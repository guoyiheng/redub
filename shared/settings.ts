import { z } from 'zod'

export const settingsSchema = z.object({
  translationConcurrency: z.number().int().min(1).max(32).default(10),
  synthesisConcurrency: z.number().int().min(1).max(32).default(5),
  pauseOnFailure: z.boolean().default(true),
  whisperModel: z.enum(['tiny', 'base', 'small', 'medium', 'large-v3']).default('small'),
  translationChannelId: z.string().default('translation-default')
})
export const defaultSettings = () => settingsSchema.parse({})
