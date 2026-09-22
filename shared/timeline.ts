/** Shared by editing, preview and rendering; overlapping speech needs an explicit multi-track editor. */
export function assertTimeline(lines: { start: number; end: number }[], duration?: number) {
  const sorted = [...lines].sort((a, b) => a.start - b.start)
  for (let i = 0; i < sorted.length; i++) {
    const line = sorted[i]!
    if (
      !Number.isFinite(line.start) ||
      !Number.isFinite(line.end) ||
      line.start < 0 ||
      line.end <= line.start
    )
      throw new Error(`第 ${i + 1} 句时间范围无效，请调整起止时间`)
    if (duration !== undefined && line.end > duration)
      throw new Error(`第 ${i + 1} 句超出素材时长，请调整起止时间`)
    if (i && line.start < sorted[i - 1]!.end)
      throw new Error(`第 ${i}、${i + 1} 句时间重叠，请调整起止时间后重试`)
  }
}
