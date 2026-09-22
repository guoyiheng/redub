import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core'
import type { MediaKind, Stage, JobStatus, TranslationVersion, AudioVersion } from '../../shared/types'

export const projects = sqliteTable('projects', {
  id: text().primaryKey(),
  name: text().notNull(),
  kind: text().$type<MediaKind>().notNull(),
  sourcePath: text(),
  duration: real().notNull().default(0),
  sourceLanguage: text().notNull().default('auto'),
  targetLanguage: text().notNull().default('中文'),
  channelId: text().notNull().default('volcengine-default'),
  paused: integer({ mode: 'boolean' }).notNull().default(false),
  pinned: integer({ mode: 'boolean' }).notNull().default(false),
  audioPath: text(),
  vocalsPath: text(),
  backgroundPath: text(),
  mixedPath: text(),
  outputPath: text(),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull()
})
export const segments = sqliteTable(
  'segments',
  {
    id: text().primaryKey(),
    projectId: text()
      .notNull()
      .references(() => projects.id),
    start: real().notNull(),
    end: real().notNull(),
    text: text().notNull().default(''),
    translation: text().notNull().default(''),
    translationLanguage: text(),
    speaker: text().notNull().default('角色 1'),
    enabled: integer({ mode: 'boolean' }).notNull().default(true),
    referencePath: text(),
    customReferencePath: text(),
    generationPrompt: text(),
    synthesisMode: text().$type<'ai' | 'tts'>().notNull().default('ai'),
    aiSpeaker: text(),
    aiUseReference: integer({ mode: 'boolean' }).notNull().default(true),
    aiPrompt: text(),
    aiFormat: text().notNull().default('mp3'),
    aiSampleRate: integer().notNull().default(48000),
    aiPitchRate: integer().notNull().default(0),
    aiSpeechRate: integer().notNull().default(0),
    aiLoudnessRate: integer().notNull().default(0),
    ttsVoice: text().notNull().default('zh-CN-XiaoxiaoNeural'),
    ttsRate: integer().notNull().default(0),
    ttsPitch: integer().notNull().default(0),
    ttsVolume: integer().notNull().default(0),
    generatedPath: text(),
    generatedHash: text(),
    generatedDuration: real(),
    subtitle: text(),
    translationHistory: text({ mode: 'json' }).$type<TranslationVersion[]>(),
    audioHistory: text({ mode: 'json' }).$type<AudioVersion[]>()
  },
  (t) => [index('segments_project').on(t.projectId)]
)
export const jobs = sqliteTable(
  'jobs',
  {
    id: text().primaryKey(),
    projectId: text()
      .notNull()
      .references(() => projects.id),
    stage: text().$type<Stage>().notNull(),
    segmentId: text(),
    batchId: text(),
    status: text().$type<JobStatus>().notNull().default('queued'),
    progress: integer().notNull().default(0),
    message: text().notNull().default('等待执行'),
    error: text(),
    dependsOn: text(),
    attempts: integer().notNull().default(0),
    input: text({ mode: 'json' }).$type<unknown>(),
    result: text({ mode: 'json' }).$type<unknown>(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull()
  },
  (t) => [index('jobs_status').on(t.status), index('jobs_project').on(t.projectId)]
)
export const jobRequests = sqliteTable(
  'job_requests',
  {
    id: text().primaryKey(),
    jobId: text()
      .notNull()
      .references(() => jobs.id),
    attempt: integer().notNull(),
    label: text().notNull(),
    method: text().notNull(),
    url: text().notNull(),
    requestHeaders: text({ mode: 'json' }).$type<Record<string, string>>().notNull(),
    requestBody: text(),
    responseStatus: integer(),
    responseStatusText: text(),
    responseHeaders: text({ mode: 'json' }).$type<Record<string, string>>(),
    responseBody: text(),
    responseEncoding: text().$type<'utf8' | 'base64'>().notNull().default('utf8'),
    curl: text().notNull(),
    startedAt: integer().notNull(),
    finishedAt: integer(),
    durationMs: integer(),
    error: text()
  },
  (t) => [index('job_requests_job').on(t.jobId, t.startedAt)]
)
export const channels = sqliteTable('channels', {
  id: text().primaryKey(),
  name: text().notNull(),
  type: text().$type<'volcengine' | 'openai'>().notNull(),
  endpoint: text().notNull(),
  model: text().notNull(),
  keyEnv: text().notNull(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  pitch: integer().notNull().default(0),
  speed: integer().notNull().default(0),
  loudness: integer().notNull().default(0),
  apiKey: text()
})
export const settings = sqliteTable('settings', { key: text().primaryKey(), value: text().notNull() })
export const referenceVoices = sqliteTable('reference_voices', {
  id: text().primaryKey(),
  name: text().notNull(),
  path: text().notNull().unique(),
  duration: real().notNull(),
  createdAt: integer().notNull()
})
