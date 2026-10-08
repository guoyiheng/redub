export interface ProjectTaskTarget {
  type?: 'project'
  projectId: string
  segmentId?: string | null
  nonce: number
}

export interface VoiceTaskTarget {
  type: 'voice'
  voiceKey: string
  voiceType: 'ark' | 'tts'
  voiceLabel?: string
  nonce: number
}

export type TaskNavigationTarget = ProjectTaskTarget | VoiceTaskTarget

export const useTaskNavigation = () => useState<TaskNavigationTarget | null>('task-navigation', () => null)
