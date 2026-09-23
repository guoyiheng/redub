export const stageLabels = {
  extract: '音轨提取',
  separate: '人声与背景分离',
  segment: '人声分段',
  transcribe: '台词识别',
  translate: '台词翻译',
  synthesize: '生成配音',
  mix: '音轨合并',
  preview: '合成成片',
  export: '导出成片',
  'preview-tracks': '准备预览音轨'
} as const
export type Stage = keyof typeof stageLabels
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'
export type MediaKind = 'video' | 'audio' | 'text'
export interface ReferenceVoice {
  id: string
  name: string
  path: string
  duration: number
  createdAt: number
}
export interface Project {
  id: string
  name: string
  kind: MediaKind
  sourcePath: string | null
  duration: number
  sourceLanguage: string
  targetLanguage: string
  channelId: string
  paused: boolean
  pinned?: boolean
  createdAt: number
  updatedAt: number
  audioPath: string | null
  vocalsPath: string | null
  backgroundPath: string | null
  mixedPath: string | null
  outputPath: string | null
}
export interface TranslationVersion {
  id: string
  name: string
  text: string
  language?: string | null
  createdAt: number
}
export interface AudioVersion {
  id: string
  name: string
  audioPath: string
  duration?: number | null
  synthesisMode?: 'ai' | 'tts'
  speaker?: string | null
  generationPrompt?: string | null
  subtitle?: string | null
  createdAt: number
}
export interface Segment {
  id: string
  projectId: string
  start: number
  end: number
  text: string
  translation: string
  translationLanguage?: string | null
  speaker: string
  enabled: boolean
  referencePath: string | null
  customReferencePath?: string | null
  generationPrompt?: string | null
  synthesisMode: 'ai' | 'tts'
  aiSpeaker: string | null
  aiUseReference: boolean
  aiPrompt: string | null
  aiFormat: string
  aiSampleRate: number
  aiPitchRate: number
  aiSpeechRate: number
  aiLoudnessRate: number
  ttsVoice: string
  ttsRate: number
  ttsPitch: number
  ttsVolume: number
  generatedPath: string | null
  generatedHash: string | null
  generatedDuration: number | null
  subtitle: string | null
  translationHistory?: TranslationVersion[] | null
  audioHistory?: AudioVersion[] | null
}
export interface Job {
  id: string
  projectId: string
  stage: Stage
  segmentId: string | null
  segmentIndex?: number | null
  batchId?: string | null
  status: JobStatus
  progress: number
  message: string
  error: string | null
  dependsOn: string | null
  attempts: number
  createdAt: number
  updatedAt: number
}
export interface JobRequestSummary {
  id: string
  jobId: string
  attempt: number
  label: string
  method: string
  url: string
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  responseStatus: number | null
  error: string | null
}
export interface JobRequest extends JobRequestSummary {
  requestHeaders: Record<string, string>
  requestBody: string | null
  responseHeaders: Record<string, string> | null
  responseBody: string | null
  responseEncoding: 'utf8' | 'base64'
  responseStatusText: string | null
  curl: string
}
export interface JobDetail {
  job: Job
  projectName: string
  input: unknown
  result: unknown
  requests: JobRequestSummary[]
}
export interface Channel {
  id: string
  name: string
  type: 'volcengine' | 'openai'
  endpoint: string
  model: string
  keyEnv: string
  enabled: boolean
  pitch?: number
  speed?: number
  loudness?: number
  apiKey?: string | null
  configured?: boolean
}
export interface Settings {
  translationConcurrency: number
  synthesisConcurrency: number
  pauseOnFailure: boolean
  whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'
  translationChannelId: string
}
export interface ProjectDetail {
  project: Project
  segments: Segment[]
  jobs: Job[]
}
