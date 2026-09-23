<script setup lang="ts">
import { segmentTaskReason } from '../../shared/job-policy'
import type { BatchInput } from '../../shared/batch'
import type { ExportResult } from '../../shared/export'
import type { PreviewTracks } from '../../shared/preview'
import type { Segment } from '../../shared/types'
import { languageOptions, normalizeLanguage } from '../../shared/languages'
import { speakerName, dubbedText } from '../../shared/voice'

type PreviewTrackKey = 'optimized' | 'original' | 'background' | 'dubbed'
const trackKeys: PreviewTrackKey[] = ['optimized', 'original', 'background', 'dubbed']
const sourceTrackKeys: PreviewTrackKey[] = ['original', 'background', 'dubbed']
const trackLabels: Record<PreviewTrackKey, string> = {
  optimized: '优化合成',
  original: '原始音轨',
  background: '背景音',
  dubbed: '配音'
}
const trackDescriptions: Record<PreviewTrackKey, string> = {
  optimized: '替换区间为背景音 + 新配音，未配音片段保留原声',
  original: '原素材中的人声与环境声',
  background: '分离后保留的环境声与音乐',
  dubbed: '按时间轴对齐后的新配音'
}
const { detail, channels, settings, settingsProject, workspacePanels, act, toast, errorMessage, refresh } =
  useStudio()
const taskWait = new AbortController()
const timelineScrollRef = ref<HTMLElement>()
const timelineContainerWidth = ref(800)
const isDragging = ref(false)
let timelineResizeObserver: ResizeObserver | undefined
let isPointerDown = false
let hasDragged = false
let startClientX = 0
let startScrollLeft = 0

function updateTimelineWidth() {
  if (timelineScrollRef.value) {
    timelineContainerWidth.value = timelineScrollRef.value.clientWidth
  }
}

onMounted(() => {
  updateTimelineWidth()
  if (typeof ResizeObserver !== 'undefined') {
    timelineResizeObserver = new ResizeObserver(() => {
      updateTimelineWidth()
    })
    if (timelineScrollRef.value) {
      timelineResizeObserver.observe(timelineScrollRef.value)
    }
  }
  window.addEventListener('resize', updateTimelineWidth)
})

onBeforeUnmount(() => {
  taskWait.abort()
  timelineResizeObserver?.disconnect()
  window.removeEventListener('resize', updateTimelineWidth)
  window.removeEventListener('mousemove', onTimelineMouseMove)
  window.removeEventListener('mouseup', onTimelineMouseUp)
})
const batchAction = ref<BatchInput['action'] | 'speaker'>('synthesize')
const current = ref<string>()
const time = ref(0)
const playing = ref(false)
const clockPlayer = ref<HTMLMediaElement>()
const optimizedAudio = ref<HTMLAudioElement>()
const originalAudio = ref<HTMLAudioElement>()
const backgroundAudio = ref<HTMLAudioElement>()
const dubbedAudio = ref<HTMLAudioElement>()
const previewTracks = ref<PreviewTracks>()
const previewLoading = ref(false)
const previewError = ref('')
const exporting = ref(false)
const trackEnabled = reactive<Record<PreviewTrackKey, boolean>>({
  optimized: true,
  original: false,
  background: false,
  dubbed: false
})
const exportTrack = ref<PreviewTrackKey>('optimized')
const exportTarget = ref<'audio' | 'video'>('audio')
const nsfwEnabled = ref(true)
const nsfwTransparency = ref(0)
const nsfwSettingsOpen = ref(false)

function getProjectNsfwStorageKey(id: string) {
  return `redub:nsfw:${id}`
}

function loadProjectNsfw(id: string) {
  if (!import.meta.client) return
  const raw = localStorage.getItem(getProjectNsfwStorageKey(id))
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed.enabled === 'boolean') nsfwEnabled.value = parsed.enabled
      if (typeof parsed.transparency === 'number') nsfwTransparency.value = parsed.transparency
      return
    } catch {}
  }
  nsfwEnabled.value = settings.value?.nsfwDefaultEnabled ?? true
  nsfwTransparency.value = settings.value?.nsfwDefaultTransparency ?? 0
}

function saveProjectNsfw() {
  if (!import.meta.client || !detail.value?.project?.id) return
  localStorage.setItem(
    getProjectNsfwStorageKey(detail.value.project.id),
    JSON.stringify({ enabled: nsfwEnabled.value, transparency: nsfwTransparency.value })
  )
}

watch(
  () => detail.value?.project?.id,
  (id) => {
    if (id) loadProjectNsfw(id)
  },
  { immediate: true }
)

watch([nsfwEnabled, nsfwTransparency], () => {
  saveProjectNsfw()
})

let pendingSeek: number | undefined
let resumeOnLoad = false
let previewRequest = 0
let previewPending = false
let previewSelectionTouched = false
const showOptions = ref(false),
  showEditor = ref(false),
  showGeneration = ref(false),
  showBatch = ref(false),
  showExportModal = ref(false),
  dirty = ref(false),
  savingOptions = ref(false)
const options = ref({ name: '', sourceLanguage: 'auto', targetLanguage: '中文', channelId: '' })
const project = computed(() => detail.value!.project)
const panel = computed(() => workspacePanels.value[project.value.id] || 'script')
const lines = computed(() => detail.value?.segments || [])
const selected = computed(() => lines.value.find((s) => s.id === current.value))
const currentPage = ref(1)
const pageSize = ref(50)
const speakerFilter = ref<string | number>(0)
const lastExportResult = ref<ExportResult>()

const speakerOptions = computed(() => {
  const counts = new Map<string, number>()
  for (const line of lines.value) {
    const name = speakerName(line.speaker)
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return [
    { label: `全部角色 (${lines.value.length})`, value: 0 },
    ...Array.from(counts).map(([name, count]) => ({
      label: `${name} (${count})`,
      value: name
    }))
  ]
})

const pageSizeOptions = [
  { label: '每页 10 句', value: 10 },
  { label: '每页 30 句', value: 30 },
  { label: '每页 50 句', value: 50 },
  { label: '每页 100 句', value: 100 },
  { label: '全部显示', value: 0 }
]

const filteredLines = computed(() => {
  if (speakerFilter.value === 0) return lines.value
  return lines.value.filter((l) => speakerName(l.speaker) === speakerFilter.value)
})

const totalPages = computed(() => {
  if (!pageSize.value) return 1
  return Math.max(1, Math.ceil(filteredLines.value.length / pageSize.value))
})

const pagedLines = computed(() => {
  if (!pageSize.value) return filteredLines.value
  const start = (currentPage.value - 1) * pageSize.value
  return filteredLines.value.slice(start, start + pageSize.value)
})

const globalIndexes = computed(() => new Map(lines.value.map((line, index) => [line.id, index + 1])))
const getGlobalIndex = (lineId: string) => globalIndexes.value.get(lineId) || 0

watch([speakerFilter, pageSize], () => {
  currentPage.value = 1
})
watch(speakerOptions, (items) => {
  if (!items.some((item) => item.value === speakerFilter.value)) speakerFilter.value = 0
})

watch([filteredLines, pageSize], () => {
  if (currentPage.value > totalPages.value) currentPage.value = totalPages.value
  if (currentPage.value < 1) currentPage.value = 1
})
const taskNavigation = useTaskNavigation()
watch(
  [taskNavigation, () => detail.value?.project.id],
  async ([target, projectId]) => {
    if (!target || target.projectId !== projectId || !target.segmentId) return
    const index = lines.value.findIndex((line) => line.id === target.segmentId)
    if (index < 0) {
      toast.add({ title: '这句台词已被删除', color: 'warning' })
      return
    }
    speakerFilter.value = 0
    await nextTick()
    currentPage.value = pageSize.value ? Math.floor(index / pageSize.value) + 1 : 1
    current.value = target.segmentId
    await nextTick()
    const row = document.getElementById(`segment-${target.segmentId}`)
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row?.focus({ preventScroll: true })
  },
  { immediate: true, flush: 'post' }
)

watch(panel, (newPanel) => {
  if (newPanel === 'preview') {
    nextTick(() => {
      updateTimelineWidth()
      if (timelineScrollRef.value && timelineResizeObserver) {
        timelineResizeObserver.observe(timelineScrollRef.value)
      }
    })
  }
})
watch(previewTracks, () => {
  nextTick(() => updateTimelineWidth())
})
const locked = computed(
  () => detail.value?.jobs.some((j) => ['queued', 'running'].includes(j.status)) || false
)
const lineTaskReason = (id: string) => segmentTaskReason(detail.value?.jobs || [], id)
const completed = computed(() => lines.value.filter((s) => s.enabled && s.generatedPath).length)
const enabledCount = computed(() => lines.value.filter((s) => s.enabled).length)
const totalDuration = computed(() => Math.max(project.value.duration, ...lines.value.map((s) => s.end), 1))
const previewDuration = computed(() => previewTracks.value?.duration || totalDuration.value)
const progress = computed(() =>
  Math.min(100, Math.max(0, (time.value / Math.max(previewDuration.value, 0.001)) * 100))
)
const previewSignature = computed(() =>
  JSON.stringify({
    id: project.value.id,
    sourcePath: project.value.sourcePath,
    audioPath: project.value.audioPath,
    backgroundPath: project.value.backgroundPath,
    duration: project.value.duration,
    segments: lines.value.map((line) => ({
      id: line.id,
      start: line.start,
      end: line.end,
      enabled: line.enabled,
      generatedPath: line.generatedPath
    }))
  })
)
const exportSignature = computed(() =>
  JSON.stringify({
    preview: previewSignature.value,
    name: project.value.name,
    text: lines.value.map((line) => [line.text, line.translation, line.generationPrompt, line.subtitle]),
    track: exportTrack.value,
    target: exportTarget.value
  })
)
watch(exportSignature, () => {
  lastExportResult.value = undefined
})
const clockSource = computed(() => {
  if (project.value.kind === 'video' || project.value.kind === 'audio')
    return project.value.sourcePath || project.value.audioPath
  return (
    previewTracks.value?.tracks.optimized.path ||
    previewTracks.value?.tracks.background.path ||
    previewTracks.value?.tracks.dubbed.path ||
    previewTracks.value?.tracks.original.path ||
    null
  )
})
const playbackPaths = computed<Record<PreviewTrackKey, string | null>>(() => {
  const tracks = previewTracks.value?.tracks
  if (!tracks) {
    const original =
      project.value.kind === 'text' ? null : project.value.audioPath || project.value.sourcePath
    return { optimized: original, original, background: project.value.backgroundPath, dubbed: null }
  }
  return {
    optimized: tracks.optimized.path,
    original: tracks.original.path,
    background: tracks.background.path,
    dubbed: tracks.dubbed.path
  }
})
const audioElements = computed<Record<PreviewTrackKey, HTMLAudioElement | undefined>>(() => ({
  optimized: optimizedAudio.value,
  original: originalAudio.value,
  background: backgroundAudio.value,
  dubbed: dubbedAudio.value
}))
function downsample(values: number[], count = 96) {
  if (!values.length) return Array.from({ length: count }, () => 0.06)
  const result = Array.from({ length: count }, () => 0)
  for (let index = 0; index < count; index++) {
    const start = Math.floor((index * values.length) / count)
    const end = Math.max(start + 1, Math.floor(((index + 1) * values.length) / count))
    let peak = 0
    for (let cursor = start; cursor < end && cursor < values.length; cursor++)
      peak = Math.max(peak, values[cursor] || 0)
    result[index] = Math.max(0.04, peak)
  }
  return result
}
function formatRulerTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
const pps = computed(() => {
  const d = previewDuration.value
  if (d <= 30) return 25
  if (d <= 60) return 20
  if (d <= 180) return 16
  if (d <= 300) return 12
  if (d <= 600) return 8
  return 5
})
const timelineWidth = computed(() => {
  const containerW = timelineContainerWidth.value || 800
  const durationW = Math.round(previewDuration.value * pps.value)
  return Math.max(containerW, durationW)
})
interface RulerMark {
  time: number
  label: string
  percent: number
}
const rulerMarks = computed<RulerMark[]>(() => {
  const duration = previewDuration.value
  if (!duration || duration <= 0) return []
  const width = timelineWidth.value || 800
  const targetMarkCount = Math.max(3, Math.round(width / 120))
  const rawStep = duration / targetMarkCount

  const niceSteps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 300, 600, 1200, 1800, 3600]
  let step = niceSteps[niceSteps.length - 1]!
  for (const s of niceSteps) {
    if (s >= rawStep) {
      step = s
      break
    }
  }

  const marks: RulerMark[] = []
  for (let t = 0; t <= duration; t += step) {
    marks.push({
      time: t,
      label: formatRulerTime(t),
      percent: (t / duration) * 100
    })
  }
  const lastMark = marks[marks.length - 1]
  if (lastMark && duration - lastMark.time > step * 0.4) {
    marks.push({
      time: duration,
      label: formatRulerTime(duration),
      percent: 100
    })
  }
  return marks
})
const waveforms = computed<Record<PreviewTrackKey, number[]>>(() => {
  const tracks = previewTracks.value?.tracks
  const barCount = Math.max(96, Math.min(600, Math.round((timelineWidth.value || 800) / 4)))
  return {
    optimized: downsample(tracks?.optimized.peaks || [], barCount),
    original: downsample(tracks?.original.peaks || [], barCount),
    background: downsample(tracks?.background.peaks || [], barCount),
    dubbed: downsample(tracks?.dubbed.peaks || [], barCount)
  }
})
const exportTrackItems = computed(() =>
  trackKeys.map((key) => ({
    label: trackLabels[key],
    value: key,
    disabled: !trackAvailable(key)
  }))
)
const exportSummary = computed(() =>
  exportTarget.value === 'video'
    ? `保留原视频与原有音轨，新增「${trackLabels[exportTrack.value]}」音轨`
    : `导出「${trackLabels[exportTrack.value]}」音轨`
)
const exportReason = computed(() => {
  if (exporting.value) return '正在导出，请稍候'
  if (locked.value) return '请等待当前项目任务完成'
  if (!trackAvailable(exportTrack.value)) return '所选音轨尚未准备好'
  return ''
})
const trackDetailNotes = computed<Record<PreviewTrackKey, { title: string; desc: string }>>(() => ({
  optimized: {
    title: '优化合成音轨（交付首选）',
    desc:
      exportTarget.value === 'video'
        ? '保留原视频画质与轨道结构，在配音台词区间替换为全新的 AI 配音，并与分离后的纯净背景音乐和环境音精确混响融合；未生成配音的片段将自动保留原声，导出即可直接交付。'
        : '将全新的 AI 配音与提取的纯净背景音乐进行专业混响与声学对齐，合成一条高保真 WAV 音轨文件。'
  },
  original: {
    title: '原始完整音轨',
    desc: '包含原素材原本的人声和环境声，未经任何替换或二次混音处理。可用于新老配音效果的对照试听或母带存档。'
  },
  background: {
    title: '背景伴奏音轨',
    desc: '通过本机 AI 声音分离算法提取的独立背景音，彻底剔除了原演员人声，完整保留了背景配乐与环境音效。便于在专业非编软件中进行二次精修。'
  },
  dubbed: {
    title: '新配音独立干音',
    desc: '仅包含已翻译生成的新角色配音片段，严格按台词起止时间轴定位，静音区间不含任何伴奏。适合作为独立干音频道导入专业音频工程。'
  }
}))
const addReason = computed(() =>
  locked.value
    ? '请等待当前项目任务完成'
    : project.value.kind !== 'text' && (lines.value.at(-1)?.end || 0) >= project.value.duration
      ? '素材末尾没有空余时间，可编辑现有台词的时间范围'
      : ''
)
const lineJob = (id: string) =>
  detail.value?.jobs.find((j) => j.segmentId === id && ['queued', 'running'].includes(j.status))
function openBatch(action: BatchInput['action'] | 'speaker') {
  batchAction.value = action
  showBatch.value = true
}
function audioFor(key: PreviewTrackKey) {
  return audioElements.value[key]
}
function trackAvailable(key: PreviewTrackKey) {
  return !!playbackPaths.value[key]
}
function hasSource(element: HTMLAudioElement | undefined) {
  return !!element?.getAttribute('src')
}
function syncAudios(target = clockPlayer.value?.currentTime || 0) {
  for (const key of trackKeys) {
    const element = audioFor(key)
    if (!hasSource(element) || element!.readyState === 0) continue
    if (Math.abs(element!.currentTime - target) > 0.12) element!.currentTime = target
  }
}
function onTrackLoaded(key: PreviewTrackKey) {
  syncAudios(time.value)
  if (playing.value && trackEnabled[key])
    void audioFor(key)
      ?.play()
      .catch(() => {})
}
async function playAudios() {
  const clock = clockPlayer.value
  if (!clock) return
  syncAudios(clock.currentTime)
  if (resumeOnLoad) {
    resumeOnLoad = false
    void clock.play().catch(() => {})
  }
  await Promise.all(
    trackKeys.map(async (key) => {
      if (!trackEnabled[key]) return
      const element = audioFor(key)
      if (!hasSource(element)) return
      try {
        await element!.play()
      } catch {
        /* The browser may require the next explicit user interaction. */
      }
    })
  )
}
function onClockLoaded() {
  const clock = clockPlayer.value
  if (!clock) return
  if (pendingSeek !== undefined) {
    clock.currentTime = Math.min(pendingSeek, previewDuration.value)
    pendingSeek = undefined
  }
  syncAudios(clock.currentTime)
}
function onClockPlay() {
  playing.value = true
  syncAudios()
  void playAudios()
}
function onClockPause() {
  playing.value = false
  for (const key of trackKeys) audioFor(key)?.pause()
}
function onClockEnded() {
  playing.value = false
  time.value = previewDuration.value
  for (const key of trackKeys) audioFor(key)?.pause()
}
function onClockTimeUpdate() {
  const clock = clockPlayer.value
  if (!clock) return
  time.value = clock.currentTime
  autoScrollTimeline()
  if (!playing.value) return
  syncAudios(clock.currentTime)
  for (const key of trackKeys) {
    if (!trackEnabled[key]) continue
    const element = audioFor(key)
    if (hasSource(element) && element!.paused) void element!.play().catch(() => {})
  }
}
function onClockSeeking() {
  const clock = clockPlayer.value
  if (!clock) return
  time.value = clock.currentTime
  syncAudios(clock.currentTime)
}
function seekTo(value: number) {
  const target = Math.max(0, Math.min(previewDuration.value, value))
  time.value = target
  const clock = clockPlayer.value
  if (!clock || clock.readyState === 0) {
    pendingSeek = target
    return
  }
  clock.currentTime = target
  syncAudios(target)
  scrollToPlayhead()
}
function togglePlayback() {
  const clock = clockPlayer.value
  if (!clock) return
  if (clock.paused)
    void clock.play().catch(() => {
      toast.add({
        id: 'playback-unavailable',
        title: '暂时无法播放',
        description: '请先等待音轨准备完成',
        color: 'warning'
      })
    })
  else clock.pause()
}
function pauseAll() {
  clockPlayer.value?.pause()
  for (const key of trackKeys) audioFor(key)?.pause()
  playing.value = false
}
function seekFromTimelineClick(e: MouseEvent) {
  if (!timelineScrollRef.value || !timelineWidth.value || !previewDuration.value) return
  const rect = timelineScrollRef.value.getBoundingClientRect()
  const clickX = e.clientX - rect.left + timelineScrollRef.value.scrollLeft
  const clampedX = Math.max(0, Math.min(timelineWidth.value, clickX))
  const targetTime = (clampedX / timelineWidth.value) * previewDuration.value
  seekTo(targetTime)
}
function seekFromLane(event: MouseEvent) {
  seekFromTimelineClick(event)
}
function onTimelineMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  const target = e.target as HTMLElement
  if (target.closest('button, input, a, .mixer-track-header')) return

  isPointerDown = true
  hasDragged = false
  startClientX = e.clientX
  if (timelineScrollRef.value) {
    startScrollLeft = timelineScrollRef.value.scrollLeft
  }
  window.addEventListener('mousemove', onTimelineMouseMove)
  window.addEventListener('mouseup', onTimelineMouseUp)
}
function onTimelineMouseMove(e: MouseEvent) {
  if (!isPointerDown) return
  const dx = e.clientX - startClientX
  if (!hasDragged && Math.abs(dx) > 4) {
    hasDragged = true
    isDragging.value = true
  }
  if (hasDragged && timelineScrollRef.value) {
    timelineScrollRef.value.scrollLeft = startScrollLeft - dx
  }
}
function onTimelineMouseUp(e: MouseEvent) {
  if (!isPointerDown) return
  window.removeEventListener('mousemove', onTimelineMouseMove)
  window.removeEventListener('mouseup', onTimelineMouseUp)
  isPointerDown = false
  const wasDragging = hasDragged
  setTimeout(() => {
    isDragging.value = false
  }, 0)

  if (!wasDragging) {
    seekFromTimelineClick(e)
  }
}
function onTimelineWheel(e: WheelEvent) {
  if (!timelineScrollRef.value) return
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
  if (e.deltaY !== 0) {
    timelineScrollRef.value.scrollLeft += e.deltaY
  }
}
function autoScrollTimeline() {
  if (!playing.value || isDragging.value || !timelineScrollRef.value) return
  const scrollEl = timelineScrollRef.value
  const playheadX = (time.value / Math.max(previewDuration.value, 0.001)) * timelineWidth.value
  const visibleLeft = scrollEl.scrollLeft
  const visibleRight = visibleLeft + scrollEl.clientWidth
  if (playheadX > visibleRight - 40) {
    scrollEl.scrollLeft = playheadX - 40
  } else if (playheadX < visibleLeft) {
    scrollEl.scrollLeft = Math.max(0, playheadX - 40)
  }
}
function scrollToPlayhead() {
  if (!timelineScrollRef.value || isDragging.value) return
  const scrollEl = timelineScrollRef.value
  const playheadX = (time.value / Math.max(previewDuration.value, 0.001)) * timelineWidth.value
  const visibleLeft = scrollEl.scrollLeft
  const visibleRight = visibleLeft + scrollEl.clientWidth
  if (playheadX < visibleLeft || playheadX > visibleRight) {
    scrollEl.scrollLeft = Math.max(0, playheadX - scrollEl.clientWidth / 2)
  }
}
function setTrackEnabled(key: PreviewTrackKey, value: boolean | 'indeterminate') {
  previewSelectionTouched = true
  const enabled = value === true
  if (enabled && key === 'optimized') {
    for (const sourceKey of sourceTrackKeys) {
      trackEnabled[sourceKey] = false
      audioFor(sourceKey)?.pause()
    }
  } else if (enabled && trackEnabled.optimized) {
    trackEnabled.optimized = false
    audioFor('optimized')?.pause()
  }
  trackEnabled[key] = enabled
  const element = audioFor(key)
  if (!enabled) element?.pause()
  else
    void nextTick(() => {
      syncAudios()
      if (playing.value) void playAudios()
    })
}
function trackState(key: PreviewTrackKey) {
  const track = previewTracks.value?.tracks[key]
  if (!trackAvailable(key)) return track?.reason || '尚未准备'
  if (!trackEnabled[key]) return '已关闭'
  if (key === 'optimized') return previewTracks.value?.missingDubs ? '未配音片段保留原声' : '最终成片效果'
  if (key === 'original') return '完整原声'
  if (key === 'dubbed' && previewTracks.value?.missingDubs)
    return `${previewTracks.value.missingDubs} 句未生成`
  return '参与试听'
}
async function exportFilm() {
  if (exportReason.value || exporting.value) return
  exporting.value = true
  const signature = exportSignature.value
  try {
    const task = await $fetch<{ jobId: string }>(`/api/projects/${project.value.id}/export`, {
      method: 'POST',
      body: {
        target: exportTarget.value,
        ...Object.fromEntries(trackKeys.map((key) => [key, key === exportTrack.value])),
        originalMode: 'full'
      }
    })
    await refresh()
    toast.add({
      id: 'project-export-queued',
      title: '导出任务已创建',
      description: '完成后会自动下载，也可在任务详情中找回',
      color: 'success'
    })
    const result = await waitForJobResult<ExportResult>(task.jobId, taskWait.signal)
    if (signature === exportSignature.value) lastExportResult.value = result
    const link = document.createElement('a')
    link.href = mediaUrl(result.path, true)
    link.download = result.filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    if (result.subtitlePath) {
      toast.add({
        id: 'project-export-success',
        title: '已导出，配套字幕可单独下载',
        description: `${result.filename} 与 ${result.subtitleFilename || '配套字幕'}`,
        color: 'success'
      })
    } else {
      toast.add({
        id: 'project-export-success',
        title: '导出完成',
        description: result.filename,
        color: 'success'
      })
    }
  } catch (error) {
    if (taskWait.signal.aborted) return
    toast.add({
      id: 'project-export-error',
      title: '导出失败',
      description: errorMessage(error),
      color: 'error',
      duration: 9000
    })
  } finally {
    exporting.value = false
  }
}
async function loadPreviewTracks() {
  if (previewLoading.value) {
    previewPending = true
    return
  }
  const request = ++previewRequest
  const projectId = project.value.id
  previewLoading.value = true
  previewPending = false
  previewError.value = ''
  try {
    const result = await $fetch<PreviewTracks>(`/api/projects/${projectId}/preview-tracks`, {
      signal: taskWait.signal
    })
    if (request !== previewRequest || projectId !== project.value.id) return
    const firstReady =
      !previewTracks.value || !Object.values(previewTracks.value.tracks).some((track) => track.path)
    previewTracks.value = result
    if (!previewSelectionTouched || firstReady) {
      const hasOptimized = !!result.tracks.optimized.path
      const hasOriginal = !!result.tracks.original.path
      const hasBackground = !!result.tracks.background.path
      const hasDubbed = !!result.tracks.dubbed.path
      trackEnabled.optimized = hasOptimized
      trackEnabled.original = !hasOptimized && !hasBackground && !hasDubbed && hasOriginal
      trackEnabled.background = !hasOptimized && hasBackground
      trackEnabled.dubbed = !hasOptimized && hasDubbed
    }
    for (const key of trackKeys) {
      if (!result.tracks[key].path) trackEnabled[key] = false
    }
    if (firstReady && !result.tracks[exportTrack.value].path)
      exportTrack.value = trackKeys.find((key) => result.tracks[key].path) || 'optimized'
    await nextTick()
    syncAudios()
  } catch (error) {
    if (request === previewRequest && !taskWait.signal.aborted) previewError.value = errorMessage(error)
  } finally {
    if (request === previewRequest) {
      previewLoading.value = false
      if (previewPending && panel.value === 'preview' && !taskWait.signal.aborted) void loadPreviewTracks()
    }
  }
}
watch(
  () => project.value.id,
  () => {
    current.value = undefined
    speakerFilter.value = 0
    currentPage.value = 1
    previewRequest++
    previewLoading.value = false
    previewPending = false
    previewSelectionTouched = false
    exportTarget.value = project.value.kind === 'video' ? 'video' : 'audio'
    exportTrack.value = 'optimized'
    previewTracks.value = undefined
    pauseAll()
    pendingSeek = undefined
    resumeOnLoad = false
    time.value = 0
  },
  { immediate: true }
)
watch(
  settingsProject,
  (id) => {
    if (id !== project.value.id) return
    options.value = {
      name: project.value.name,
      sourceLanguage: project.value.sourceLanguage,
      targetLanguage: normalizeLanguage(project.value.targetLanguage),
      channelId: project.value.channelId
    }
    showOptions.value = true
    settingsProject.value = null
  },
  { immediate: true }
)
watch(
  [panel, previewSignature],
  ([currentPanel]) => {
    if (currentPanel === 'preview') void loadPreviewTracks()
  },
  { immediate: true }
)
watch(clockSource, () => {
  pendingSeek = time.value
  resumeOnLoad = playing.value
})
watch(
  playbackPaths,
  async () => {
    await nextTick()
    syncAudios()
    if (playing.value) await playAudios()
  },
  { deep: true }
)
function setEditorOpen(open: boolean) {
  if (!open && dirty.value && !window.confirm('放弃未保存的台词修改？')) return
  showEditor.value = open
  if (!open) dirty.value = false
}
function generateLine(id: string) {
  current.value = id
  showGeneration.value = true
}
function editLine(id: string) {
  current.value = id
  showEditor.value = true
}
function openGeneration() {
  showEditor.value = false
  showGeneration.value = true
}
async function saveOptions() {
  if (savingOptions.value || locked.value) return
  savingOptions.value = true
  if (
    await act(
      () => $fetch(`/api/projects/${project.value.id}`, { method: 'PATCH', body: options.value }),
      '项目设置已保存'
    )
  )
    showOptions.value = false
  savingOptions.value = false
}
async function addLine() {
  if (addReason.value) return
  const start = lines.value.at(-1)?.end || 0
  const end = project.value.kind === 'text' ? start + 4 : Math.min(start + 4, project.value.duration)
  await act(async () => {
    const line = await $fetch<{ id: string }>(`/api/projects/${project.value.id}/segments`, {
      method: 'POST',
      body: { start, end, text: '', translation: '', speaker: '角色 1', enabled: true }
    })
    current.value = line.id
    showEditor.value = true
  }, '台词已添加')
}

const showTranslation = ref(false)
const translationSegment = ref<Segment | null>(null)
const translationGlobalIndex = ref(1)

function openTranslation(line: Segment) {
  translationSegment.value = line
  translationGlobalIndex.value = getGlobalIndex(line.id)
  showTranslation.value = true
}

const historyModalOpen = ref(false)
const historySegment = ref<Segment | null>(null)
const historyGlobalIndex = ref(1)

const currentHistorySegment = computed(() => {
  if (!historySegment.value) return null
  return lines.value.find((l) => l.id === historySegment.value?.id) || historySegment.value
})

function openHistory(line: Segment) {
  historySegment.value = line
  historyGlobalIndex.value = getGlobalIndex(line.id)
  historyModalOpen.value = true
}

async function onSegmentRestored(updated: Segment) {
  if (historySegment.value?.id === updated.id) {
    historySegment.value = updated
  }
  await refresh()
}
</script>
<template>
  <section
    v-if="detail"
    class="workspace"
    :class="{ 'workspace-preview': panel === 'preview', 'workspace-script': panel === 'script' }"
  >
    <header class="workspace-header">
      <div v-if="panel === 'script' && lines.length" class="workspace-filters">
        <USelect
          v-model="speakerFilter"
          class="speaker-filter"
          :items="speakerOptions"
          aria-label="按角色筛选"
        />
        <USelect
          v-model="pageSize"
          class="page-size-select"
          :items="pageSizeOptions"
          aria-label="每页显示条数"
        />
        <div v-if="totalPages > 1" class="toolbar-pagination">
          <UButton
            size="md"
            color="neutral"
            variant="outline"
            icon="i-carbon-chevron-left"
            :disabled="currentPage <= 1"
            aria-label="上一页"
            @click="currentPage--"
          />
          <span class="page-indicator">{{ currentPage }} / {{ totalPages }}</span>
          <UButton
            size="md"
            color="neutral"
            variant="outline"
            icon="i-carbon-chevron-right"
            :disabled="currentPage >= totalPages"
            aria-label="下一页"
            @click="currentPage++"
          />
        </div>
      </div>
      <div class="row-actions">
        <template v-if="panel === 'script'">
          <span v-if="lines.length" class="help dubbing-progress"
            >{{ completed }} / {{ enabledCount }} 句已配音</span
          >
          <StudioAction
            v-if="lines.length"
            color="neutral"
            variant="outline"
            icon="i-carbon-language"
            :reason="dirty ? '请先保存台词修改' : ''"
            @click="openBatch('translate')"
            >批量翻译</StudioAction
          >
          <StudioAction
            color="neutral"
            variant="outline"
            :icon="lines.length ? 'i-carbon-microphone' : 'i-carbon-batch-job'"
            :reason="dirty ? '请先保存台词修改' : ''"
            @click="openBatch(lines.length ? 'synthesize' : 'prepare')"
            >{{ lines.length ? '批量配音' : '处理素材' }}</StudioAction
          >
        </template>
        <template v-else-if="panel === 'preview'">
          <UBadge color="neutral" variant="soft">{{
            previewTracks
              ? previewTracks.missingDubs
                ? `${previewTracks.replacementRanges.length} 个区间 · ${previewTracks.missingDubs} 待配音`
                : `${previewTracks.replacementRanges.length} 个替换区间`
              : '等待音轨'
          }}</UBadge>
          <UButton
            v-if="project.kind === 'video'"
            color="neutral"
            :variant="nsfwEnabled ? 'solid' : 'outline'"
            icon="i-carbon-view-off"
            :aria-pressed="nsfwEnabled"
            @click="nsfwEnabled = !nsfwEnabled"
            >NSFW</UButton
          >
          <UPopover
            v-if="project.kind === 'video'"
            v-model:open="nsfwSettingsOpen"
            :content="{ side: 'bottom', align: 'end' }"
          >
            <UButton
              color="neutral"
              variant="outline"
              icon="i-carbon-settings-adjust"
              aria-label="调整 NSFW 遮罩透光度"
              title="调整 NSFW 遮罩透光度"
            />
            <template #content>
              <div class="nsfw-settings">
                <div class="nsfw-settings-heading">
                  <strong>毛玻璃遮罩</strong>
                  <span>{{ nsfwTransparency }}% 透光</span>
                </div>
                <input
                  v-model.number="nsfwTransparency"
                  type="range"
                  min="0"
                  max="75"
                  step="1"
                  aria-label="NSFW 遮罩透光度"
                />
                <div class="nsfw-settings-scale"><span>遮挡</span><span>透光</span></div>
              </div>
            </template>
          </UPopover>
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-carbon-renew"
            :loading="previewLoading"
            @click="loadPreviewTracks"
            >刷新音轨</UButton
          >
          <UButton color="primary" variant="solid" icon="i-carbon-download" @click="showExportModal = true"
            >导出</UButton
          >
        </template>
      </div>
    </header>
    <section v-if="panel === 'script'" class="script-panel">
      <div v-if="!lines.length" class="project-start">
        <UIcon name="i-carbon-microphone" class="empty-icon" />
        <h2>{{ project.kind === 'text' ? '先添加需要配音的台词' : '先识别素材中的台词' }}</h2>
        <p>
          {{
            project.kind === 'text'
              ? '填写台词后，可以逐句选择 AI 配音或微软 TTS。'
              : '在本机分离人声与背景音，再识别台词。中文识别结果使用简体中文。'
          }}
        </p>
        <StudioAction
          color="neutral"
          variant="outline"
          :reason="locked ? '素材正在处理中，完成后即可校对台词' : ''"
          @click="project.kind === 'text' ? addLine() : openBatch('prepare')"
          >{{ project.kind === 'text' ? '添加台词' : '识别台词 · 本机处理' }}</StudioAction
        >
        <div class="start-manual-note">
          <UIcon name="i-carbon-information" />
          <p>识别完成后先校对，再按需翻译或配音。翻译和 AI 配音消耗接口额度，只有手动发起才会执行。</p>
        </div>
      </div>
      <template v-else>
        <div class="studio-table" aria-label="台词与配音对照">
          <div class="studio-table-header">
            <div class="th-meta">片段与时间戳</div>
            <div class="th-col">
              <span>原文与原声</span>
            </div>
            <div class="th-col">
              <span>翻译与配音</span>
            </div>
            <div class="th-actions">状态与操作</div>
          </div>
          <div class="studio-table-body">
            <article
              v-for="line in pagedLines"
              :key="line.id"
              :id="`segment-${line.id}`"
              tabindex="-1"
              class="studio-row"
              :aria-label="`第 ${getGlobalIndex(line.id)} 句`"
              :class="{ selected: current === line.id, 'not-replaced': !line.enabled }"
            >
              <div class="row-meta">
                <div class="segment-meta-header">
                  <span class="segment-idx">#{{ String(getGlobalIndex(line.id)).padStart(2, '0') }}</span>
                  <span class="segment-speaker">{{ speakerName(line.speaker) }}</span>
                </div>
                <time class="segment-time">{{ formatTime(line.start) }} – {{ formatTime(line.end) }}</time>
              </div>

              <div class="row-source-text">
                <span class="comparison-label">原文与原声</span>
                <p class="dialogue-original">{{ line.text || '尚未填写原文' }}</p>
              </div>

              <div class="row-source-audio">
                <AudioPlayer
                  :src="
                    project.kind !== 'text' && project.sourcePath
                      ? `/api/segments/${line.id}/original?t=${line.start}-${line.end}`
                      : undefined
                  "
                  :label="`第 ${getGlobalIndex(line.id)} 句原声`"
                  :empty="project.kind === 'text' ? '文本台词，无原声音频' : '尚无可试听的原声素材'"
                  :duration="line.end - line.start"
                />
              </div>

              <div class="row-dub-text">
                <span class="comparison-label">翻译与配音</span>
                <p
                  class="dialogue-translation"
                  :class="{ 'is-empty': !line.translation.trim() && !line.generatedPath }"
                >
                  {{
                    line.generatedPath
                      ? dubbedText(line) || '已生成配音'
                      : line.translation.trim() || '待翻译'
                  }}
                </p>
              </div>

              <div class="row-dub-audio">
                <AudioPlayer
                  v-if="line.generatedPath"
                  :src="mediaUrl(line.generatedPath)"
                  :label="`第 ${getGlobalIndex(line.id)} 句生成配音`"
                  :duration="line.end - line.start"
                />
                <div v-else class="audio-placeholder">
                  <UIcon name="i-carbon-waveform" />
                  <span>{{
                    lineJob(line.id)
                      ? lineJob(line.id)?.status === 'running'
                        ? '正在生成配音…'
                        : '等待生成配音'
                      : '待配音'
                  }}</span>
                </div>
              </div>

              <div class="row-actions-col">
                <div v-if="lineJob(line.id) || !line.enabled || line.generatedPath" class="status-wrapper">
                  <UBadge v-if="lineJob(line.id)" color="warning" variant="subtle" size="xs">
                    <UIcon name="i-carbon-renew" class="animate-spin" />
                    <span>{{ lineJob(line.id)?.status === 'running' ? '生成中' : '排队中' }}</span>
                  </UBadge>
                  <UBadge v-else-if="!line.enabled" color="neutral" variant="subtle" size="xs">
                    保留原声
                  </UBadge>
                  <UBadge v-else-if="line.generatedPath" color="primary" variant="subtle" size="xs">
                    <UIcon name="i-carbon-checkmark" />
                    <span>{{ line.synthesisMode === 'tts' ? '微软 TTS' : 'AI 配音' }}</span>
                  </UBadge>
                </div>

                <div class="action-buttons-group">
                  <UButton
                    variant="outline"
                    color="neutral"
                    size="md"
                    icon="i-carbon-microphone"
                    :disabled="!!lineTaskReason(line.id)"
                    :title="lineTaskReason(line.id) || undefined"
                    :aria-label="`第 ${getGlobalIndex(line.id)} 句配音`"
                    @click="generateLine(line.id)"
                    >配音</UButton
                  >
                  <UButton
                    variant="outline"
                    color="neutral"
                    size="md"
                    icon="i-carbon-language"
                    :disabled="!!lineTaskReason(line.id) || !line.text?.trim()"
                    :title="lineTaskReason(line.id) || undefined"
                    :aria-label="`第 ${getGlobalIndex(line.id)} 句翻译`"
                    @click="openTranslation(line)"
                    >翻译</UButton
                  >
                  <UButton
                    variant="outline"
                    color="neutral"
                    size="md"
                    icon="i-carbon-time"
                    :aria-label="`第 ${getGlobalIndex(line.id)} 句历史版本`"
                    title="历史版本"
                    @click="openHistory(line)"
                    >历史</UButton
                  >
                </div>
              </div>
            </article>
          </div>
        </div>
        <div v-if="totalPages > 1" class="script-bottom-pagination">
          <UButton
            size="md"
            color="neutral"
            variant="outline"
            icon="i-carbon-chevron-left"
            :disabled="currentPage <= 1"
            aria-label="上一页"
            @click="currentPage--"
            >上一页</UButton
          >
          <span class="page-indicator">第 {{ currentPage }} / {{ totalPages }} 页</span>
          <UButton
            size="md"
            color="neutral"
            variant="outline"
            trailing-icon="i-carbon-chevron-right"
            :disabled="currentPage >= totalPages"
            aria-label="下一页"
            @click="currentPage++"
            >下一页</UButton
          >
        </div>
      </template>
    </section>

    <section v-else class="preview-panel">
      <div v-if="previewError" class="preview-alert" role="alert">
        <UIcon name="i-carbon-warning-alt" />
        <span>{{ previewError }}</span>
        <UButton color="neutral" variant="ghost" size="xs" @click="loadPreviewTracks">重试</UButton>
      </div>
      <div class="preview-editor">
        <section class="preview-workbench" aria-label="视频与音轨预览">
          <section class="preview-monitor">
            <div
              class="preview-stage preview-stage-large"
              :class="{ 'audio-stage': project.kind !== 'video' }"
            >
              <template v-if="project.kind === 'video'">
                <video
                  ref="clockPlayer"
                  :src="mediaUrl(clockSource)"
                  muted
                  playsinline
                  preload="metadata"
                  @loadedmetadata="onClockLoaded"
                  @play="onClockPlay"
                  @pause="onClockPause"
                  @ended="onClockEnded"
                  @timeupdate="onClockTimeUpdate"
                  @seeking="onClockSeeking"
                />
                <div
                  v-if="nsfwEnabled"
                  class="nsfw-overlay"
                  :style="{ '--nsfw-alpha': `${1 - nsfwTransparency / 100}` }"
                  aria-label="NSFW 毛玻璃遮罩已开启"
                >
                  <span>NSFW</span>
                </div>
              </template>
              <template v-else>
                <UIcon
                  :name="project.kind === 'text' ? 'i-carbon-quotes' : 'i-carbon-waveform'"
                  class="preview-icon"
                />
                <div class="audio-monitor-copy">
                  <strong>{{ project.kind === 'text' ? '配音时间轴' : '音频项目' }}</strong>
                </div>
              </template>
            </div>
            <audio
              v-if="project.kind !== 'video' && clockSource"
              ref="clockPlayer"
              class="mixer-hidden-audio"
              :src="mediaUrl(clockSource)"
              muted
              preload="auto"
              @loadedmetadata="onClockLoaded"
              @play="onClockPlay"
              @pause="onClockPause"
              @ended="onClockEnded"
              @timeupdate="onClockTimeUpdate"
              @seeking="onClockSeeking"
            />
            <div class="preview-transport">
              <UButton
                color="neutral"
                variant="soft"
                square
                :icon="playing ? 'i-carbon-pause' : 'i-carbon-play'"
                :aria-label="playing ? '暂停' : '播放'"
                :disabled="!clockSource"
                @click="togglePlayback"
              />
              <span class="preview-time">{{ formatTime(time) }}</span>
              <input
                class="preview-scrubber"
                type="range"
                min="0"
                :max="previewDuration"
                step="0.01"
                :value="time"
                :disabled="!clockSource"
                aria-label="播放进度"
                @input="seekTo(Number(($event.target as HTMLInputElement).value))"
              />
              <span class="preview-time">{{ formatTime(previewDuration) }}</span>
            </div>
          </section>

          <section class="preview-mixer">
            <div class="mixer-layout">
              <div class="mixer-headers-col">
                <div class="mixer-ruler-header">
                  <span class="mixer-tracks-title">音轨</span>
                </div>
                <div
                  v-for="key in trackKeys"
                  :key="key"
                  class="mixer-track-header-row"
                  :class="[
                    `track-${key}`,
                    { disabled: !trackEnabled[key], unavailable: !trackAvailable(key) }
                  ]"
                >
                  <div class="mixer-track-header">
                    <UCheckbox
                      :model-value="trackEnabled[key]"
                      :disabled="!trackAvailable(key)"
                      :aria-label="`${trackEnabled[key] ? '关闭' : '开启'}${trackLabels[key]}试听`"
                      @update:model-value="setTrackEnabled(key, $event)"
                    />
                    <div class="mixer-track-copy">
                      <strong>{{ trackLabels[key] }}</strong>
                      <span>{{ trackDescriptions[key] }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div
                ref="timelineScrollRef"
                class="mixer-timeline"
                :class="{ 'is-dragging': isDragging }"
                @mousedown="onTimelineMouseDown"
                @wheel.passive="onTimelineWheel"
              >
                <div class="mixer-timeline-content" :style="{ width: `${timelineWidth}px` }">
                  <div class="mixer-ruler-track">
                    <div
                      v-for="mark in rulerMarks"
                      :key="mark.time"
                      class="ruler-mark"
                      :style="{ left: `${mark.percent}%` }"
                    >
                      <span class="ruler-mark-text">{{ mark.label }}</span>
                      <span class="ruler-mark-tick" />
                    </div>
                    <span
                      class="playhead-ruler-marker"
                      :style="{ left: `${progress}%` }"
                      aria-hidden="true"
                    />
                  </div>

                  <div
                    v-for="key in trackKeys"
                    :key="key"
                    class="mixer-lane-row"
                    :class="[
                      `track-${key}`,
                      { disabled: !trackEnabled[key], unavailable: !trackAvailable(key) }
                    ]"
                  >
                    <div
                      class="mixer-lane"
                      role="slider"
                      tabindex="0"
                      :aria-label="`${trackLabels[key]}轨道进度`"
                      :aria-valuemin="0"
                      :aria-valuemax="previewDuration"
                      :aria-valuenow="time"
                      :aria-valuetext="`${formatTime(time)} / ${formatTime(previewDuration)}`"
                      @keydown.left.prevent="seekTo(time - 1)"
                      @keydown.right.prevent="seekTo(time + 1)"
                      @keydown.space.prevent="togglePlayback"
                    >
                      <div class="mixer-waveform" aria-hidden="true">
                        <span
                          v-for="(peak, index) in waveforms[key]"
                          :key="index"
                          class="mixer-bar"
                          :style="{ height: `${Math.max(8, peak * 100)}%` }"
                        />
                      </div>
                      <span class="mixer-progress" :style="{ width: `${progress}%` }" aria-hidden="true" />
                      <span class="playhead" :style="{ left: `${progress}%` }" aria-hidden="true" />
                      <span v-if="!trackAvailable(key)" class="mixer-empty">未生成</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </section>
      </div>
      <audio
        ref="optimizedAudio"
        class="mixer-hidden-audio"
        :src="mediaUrl(playbackPaths.optimized)"
        @loadedmetadata="onTrackLoaded('optimized')"
        preload="auto"
      />
      <audio
        ref="originalAudio"
        class="mixer-hidden-audio"
        :src="mediaUrl(playbackPaths.original)"
        @loadedmetadata="onTrackLoaded('original')"
        preload="auto"
      />
      <audio
        ref="backgroundAudio"
        class="mixer-hidden-audio"
        :src="mediaUrl(playbackPaths.background)"
        @loadedmetadata="onTrackLoaded('background')"
        preload="auto"
      />
      <audio
        ref="dubbedAudio"
        class="mixer-hidden-audio"
        :src="mediaUrl(playbackPaths.dubbed)"
        @loadedmetadata="onTrackLoaded('dubbed')"
        preload="auto"
      />
    </section>
    <USlideover
      :open="showEditor"
      @update:open="setEditorOpen"
      title="编辑台词"
      side="right"
      :ui="{ content: 'sm:max-w-lg ring-0', header: 'border-0' }"
      ><template #body
        ><SegmentEditor
          v-if="selected"
          :key="selected.id"
          :segment="selected"
          :locked="locked"
          @dirty="dirty = $event"
          @generate="openGeneration" /></template
    ></USlideover>
    <UDrawer
      v-model:open="showTranslation"
      direction="bottom"
      :handle="false"
      :inset="true"
      :ui="{ content: 'generation-drawer ring-0', overlay: 'fixed inset-0 bg-black/30 backdrop-blur-[1px]' }"
    >
      <template #content>
        <TranslationPanel
          v-if="translationSegment"
          :segment="translationSegment"
          :segment-index="translationGlobalIndex"
          :key="translationSegment.id"
          @close="showTranslation = false"
          @saved="showTranslation = false"
        />
      </template>
    </UDrawer>
    <UDrawer
      v-model:open="showGeneration"
      direction="bottom"
      :handle="false"
      :inset="true"
      :ui="{ content: 'generation-drawer ring-0', overlay: 'fixed inset-0 bg-black/30 backdrop-blur-[1px]' }"
    >
      <template #content>
        <VoiceGenerationPanel
          v-if="selected"
          :segment="selected"
          :key="selected.id"
          @close="showGeneration = false"
          @generated="showGeneration = false"
        />
      </template>
    </UDrawer>
    <USlideover
      v-model:open="showOptions"
      title="项目设置"
      side="right"
      :ui="{ content: 'sm:max-w-md ring-0', header: 'border-0' }"
      ><template #body
        ><form class="project-options-form" @submit.prevent="saveOptions">
          <p class="help">
            在此修改项目名称。台词翻译语言可在翻译弹窗中切换；配音和翻译渠道统一在设置页面配置。
          </p>
          <UFormField label="项目名称">
            <UInput class="w-full" v-model="options.name" :disabled="locked" />
          </UFormField>
          <StudioAction
            type="submit"
            :reason="locked ? '请等待当前项目任务完成' : !options.name.trim() ? '请填写项目名称' : ''"
            :loading="savingOptions"
            >保存设置</StudioAction
          >
        </form></template
      ></USlideover
    >
    <UModal
      v-model:open="showBatch"
      title="批量处理"
      :ui="{ content: 'sm:max-w-2xl ring-0', header: 'border-0' }"
      ><template #body
        ><BatchProcessing
          v-if="showBatch"
          :initial-action="batchAction"
          @close="showBatch = false"
          @submitted="showBatch = false" /></template
    ></UModal>
    <UModal v-model:open="showExportModal" title="导出设置" :ui="{ content: 'sm:max-w-xl ring-0' }">
      <template #body>
        <div class="export-modal-body">
          <div v-if="project.kind === 'video'" class="export-modal-section">
            <label class="modal-section-label">导出格式</label>
            <div class="export-target-options">
              <button
                type="button"
                class="export-target-card"
                :class="{ selected: exportTarget === 'video' }"
                @click="exportTarget = 'video'"
              >
                <UIcon name="i-carbon-video" class="target-icon" />
                <div class="target-info">
                  <strong>视频成片 (MP4)</strong>
                  <small>原视频追加所选音轨，配套外挂字幕</small>
                </div>
                <UIcon v-if="exportTarget === 'video'" name="i-carbon-checkmark" class="check-icon" />
              </button>
              <button
                type="button"
                class="export-target-card"
                :class="{ selected: exportTarget === 'audio' }"
                @click="exportTarget = 'audio'"
              >
                <UIcon name="i-carbon-waveform" class="target-icon" />
                <div class="target-info">
                  <strong>仅音轨 (WAV)</strong>
                  <small>保存所选音轨为高质量独立音频</small>
                </div>
                <UIcon v-if="exportTarget === 'audio'" name="i-carbon-checkmark" class="check-icon" />
              </button>
            </div>
          </div>

          <div class="export-modal-section">
            <label class="modal-section-label">选择导出音轨</label>
            <div class="export-track-grid">
              <button
                v-for="key in trackKeys"
                :key="key"
                type="button"
                class="export-track-item"
                :class="{ selected: exportTrack === key, disabled: !trackAvailable(key) }"
                :disabled="!trackAvailable(key)"
                @click="exportTrack = key"
              >
                <div class="track-item-header">
                  <span class="track-item-title">{{ trackLabels[key] }}</span>
                  <UBadge v-if="key === 'optimized'" color="primary" variant="subtle" size="xs">推荐</UBadge>
                  <UBadge v-else-if="!trackAvailable(key)" color="neutral" variant="subtle" size="xs"
                    >未就绪</UBadge
                  >
                </div>
                <p class="track-item-desc">{{ trackDescriptions[key] }}</p>
              </button>
            </div>

            <div class="track-detail-card">
              <div class="track-detail-header">
                <UIcon name="i-carbon-information" class="detail-icon" />
                <strong>{{ trackDetailNotes[exportTrack].title }}</strong>
              </div>
              <p class="track-detail-text">
                {{ trackDetailNotes[exportTrack].desc }}
              </p>
            </div>
          </div>
        </div>
      </template>

      <template #footer>
        <div class="export-modal-footer">
          <UButton
            v-if="lastExportResult?.subtitlePath"
            :href="mediaUrl(lastExportResult.subtitlePath, true)"
            color="neutral"
            variant="ghost"
            icon="i-carbon-closed-caption"
            >配套字幕</UButton
          >
          <div class="export-modal-actions">
            <UButton color="neutral" variant="ghost" @click="showExportModal = false">取消</UButton>
            <StudioAction
              icon="i-carbon-download"
              :reason="exportReason"
              :loading="exporting"
              @click="exportFilm"
              >{{ exportTarget === 'video' ? '导出视频成片' : '导出音轨' }}</StudioAction
            >
          </div>
        </div>
      </template>
    </UModal>
    <VersionHistoryModal
      v-model:open="historyModalOpen"
      :segment="currentHistorySegment"
      :global-index="historyGlobalIndex"
      @restored="onSegmentRestored"
    />
  </section>
</template>

<style src="../assets/css/dubbing-workspace.css"></style>

<style scoped>
.nsfw-settings {
  width: 220px;
  padding: 12px;
}
.nsfw-settings-heading,
.nsfw-settings-scale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.nsfw-settings-heading {
  color: var(--ui-text);
  font-size: 12px;
}
.nsfw-settings-heading span,
.nsfw-settings-scale {
  color: var(--ui-text-muted);
  font-size: 11px;
}
.nsfw-settings input {
  width: 100%;
  margin: 12px 0 4px;
  accent-color: var(--ui-primary);
}
.nsfw-overlay {
  position: absolute;
  z-index: 1;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  background: rgb(18 18 18 / var(--nsfw-alpha, 0.7));
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}
.nsfw-overlay span {
  padding: 6px 10px;
  border: 1px solid rgb(255 255 255 / 0.32);
  border-radius: 6px;
  color: rgb(255 255 255 / 0.82);
  background: rgb(255 255 255 / 0.08);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
</style>
