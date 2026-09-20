export const stageLabels = {
  extract: '音轨提取',
  separate: '人声与背景分离',
  segment: '人声分段',
  transcribe: '台词识别',
  translate: '台词翻译',
  synthesize: 'AI 配音',
  mix: '音轨合并',
  preview: '视频预览'
} as const
export type Stage = keyof typeof stageLabels
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped'
export type MediaKind = 'video' | 'audio' | 'text'
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
  createdAt: number
  updatedAt: number
  audioPath: string | null
  vocalsPath: string | null
  backgroundPath: string | null
  mixedPath: string | null
  outputPath: string | null
}
export interface Segment {
  id: string
  projectId: string
  start: number
  end: number
  text: string
  translation: string
  speaker: string
  enabled: boolean
  referencePath: string | null
  generatedPath: string | null
  generatedHash: string | null
  generatedDuration: number | null
  subtitle: string | null
}
export interface Job {
  id: string
  projectId: string
  stage: Stage
  segmentId: string | null
  status: JobStatus
  progress: number
  message: string
  error: string | null
  dependsOn: string | null
  attempts: number
  createdAt: number
  updatedAt: number
}
export interface Channel {
  id: string
  name: string
  type: 'volcengine' | 'openai'
  endpoint: string
  model: string
  keyEnv: string
  enabled: boolean
  pitch: number
  speed: number
  loudness: number
  apiKey?: string | null
  configured?: boolean
}
export interface Settings {
  concurrency: number
  pauseOnFailure: boolean
  whisperModel: string
  translationChannelId: string
}
export interface ProjectDetail {
  project: Project
  segments: Segment[]
  jobs: Job[]
}
