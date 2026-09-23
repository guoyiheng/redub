export const useTaskNavigation = () =>
  useState<{ projectId: string; segmentId: string | null; nonce: number } | null>(
    'task-navigation',
    () => null
  )
