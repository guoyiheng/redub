/** A waveform-ready audio lane used by the timeline preview. */
export interface PreviewTrack {
  /** Relative path served by /api/media, or null when the source is unavailable. */
  path: string | null
  /** Normalized peak values in chronological order (0..1). */
  peaks: number[]
  label: string
  reason?: string
  /** Original vocals with generated replacement ranges muted. */
  alternatePath?: string
  alternatePeaks?: number[]
}

export interface PreviewRange {
  start: number
  end: number
}

export interface PreviewTracks {
  /** Stable cache fingerprint. Changes when source paths or segment edits change. */
  revision: string
  duration: number
  tracks: {
    /** Final mix: background + generated dubs in replaced ranges, original audio elsewhere. */
    optimized: PreviewTrack
    original: PreviewTrack
    background: PreviewTrack
    dubbed: PreviewTrack
  }
  replacementRanges: PreviewRange[]
  /** Enabled segments without a generated audio file. */
  missingDubs: number
}
