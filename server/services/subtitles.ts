import type { ExportOptions } from '../../shared/export'
import type { MediaKind, Segment } from '../../shared/types'
import { subtitleText } from './text'
import { dubbedText } from '../../shared/voice'

/** Match subtitles to the speech actually included in the selected audio tracks. */
export function exportSubtitles(lines: Segment[], kind: MediaKind, options: ExportOptions) {
  const spans = lines.flatMap((line) => {
    const replaced = line.enabled && !!line.generatedPath
    const hasDub = replaced && (options.optimized || options.dubbed)
    const hasOriginal =
      kind !== 'text' &&
      ((options.optimized && !replaced) ||
        (options.original && (options.originalMode === 'full' || !replaced)))
    if (!hasDub && !hasOriginal) return []
    const text = (hasDub ? dubbedText(line) : line.text).trim()
    return text ? [{ start: line.start, end: line.end, text }] : []
  })
  return subtitleText(spans)
}
