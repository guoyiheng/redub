<script setup lang="ts">
import type { BatchInput } from '../../shared/batch'
import type { ExportResult } from '../../shared/export'
import type { PreviewTracks } from '../../shared/preview'
import { languageOptions, normalizeLanguage } from '../../shared/languages'

type PreviewTrackKey = 'optimized' | 'original' | 'background' | 'dubbed'
type ExportFormat = 'mkv' | 'mp4' | 'wav'
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
const { detail, channels, settingsProject, workspacePanels, act, toast, errorMessage, refresh } = useStudio()
const taskWait = new AbortController()
onBeforeUnmount(() => taskWait.abort())
const batchAction = ref<BatchInput['action']>('synthesize')
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
const exportTracks = reactive<Record<PreviewTrackKey, boolean>>({
  optimized: true,
  original: false,
  background: false,
  dubbed: false
})
const exportOriginalMode = ref<'preserve-gaps' | 'full'>('preserve-gaps')
const exportFormat = ref<ExportFormat>('mkv')
let pendingSeek: number | undefined
let previewRequest = 0
const showOptions = ref(false),
  showEditor = ref(false),
  showGeneration = ref(false),
  showBatch = ref(false),
  dirty = ref(false),
  savingOptions = ref(false)
const options = ref({ name: '', sourceLanguage: 'auto', targetLanguage: '中文', channelId: '' })
const project = computed(() => detail.value!.project)
const panel = computed(() => workspacePanels.value[project.value.id] || 'script')
const lines = computed(() => detail.value?.segments || [])
const selected = computed(() => lines.value.find((s) => s.id === current.value))
const locked = computed(
  () => detail.value?.jobs.some((j) => ['queued', 'running'].includes(j.status)) || false
)
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
  if (!tracks) return { optimized: null, original: null, background: null, dubbed: null }
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
const waveforms = computed<Record<PreviewTrackKey, number[]>>(() => {
  const tracks = previewTracks.value?.tracks
  return {
    optimized: downsample(tracks?.optimized.peaks || []),
    original: downsample(tracks?.original.peaks || []),
    background: downsample(tracks?.background.peaks || []),
    dubbed: downsample(tracks?.dubbed.peaks || [])
  }
})
const exportFormatItems = computed(() =>
  project.value.kind === 'video'
    ? [
        { label: 'MKV · FLAC 无损音频（推荐）', value: 'mkv' },
        { label: 'MP4 · AAC 320k（兼容播放器）', value: 'mp4' }
      ]
    : [{ label: 'WAV · PCM 16 位无损', value: 'wav' }]
)
const exportOriginalModeItems = [
  { label: '保留未替换原声（推荐）', value: 'preserve-gaps' },
  { label: '完整原声（可能与新配音重叠）', value: 'full' }
]
const selectedExportCount = computed(() => trackKeys.filter((key) => exportTracks[key]).length)
const exportSummary = computed(() => {
  const names = trackKeys.filter((key) => exportTracks[key]).map((key) => trackLabels[key])
  const format = { mkv: 'MKV / FLAC 无损', mp4: 'MP4 / AAC 320k', wav: 'WAV / PCM 无损' }[exportFormat.value]
  return names.length ? `${names.join(' + ')} → ${format}` : '尚未选择音轨'
})
const exportWarning = computed(() => {
  if (exportTracks.optimized && selectedExportCount.value > 1)
    return '优化合成已经包含完整成片音轨，不能与其他音轨重复合并。'
  if (exportTracks.original && exportTracks.background && exportTracks.dubbed)
    return '原声与背景音同时合并会叠加未替换区间的环境声；正式导出推荐“优化合成”。'
  if (exportTracks.original && exportTracks.dubbed && exportOriginalMode.value === 'full')
    return '完整原声会在替换区间保留旧人声，可能和新配音重叠。'
  return ''
})
const exportReason = computed(() => {
  if (exporting.value) return '正在导出，请稍候'
  if (locked.value) return '请等待当前项目任务完成'
  if (!previewTracks.value) return '预览音轨尚未准备好'
  if (!selectedExportCount.value) return '至少选择一条音轨'
  if (exportTracks.dubbed && previewTracks.value.missingDubs > 0)
    return `还有 ${previewTracks.value.missingDubs} 句配音未生成，暂时不能导出配音音轨`
  for (const key of trackKeys)
    if (exportTracks[key] && !previewTracks.value.tracks[key].path)
      return `所选音轨「${trackLabels[key]}」尚未准备好`
  return ''
})
const addReason = computed(() =>
  locked.value
    ? '请等待当前项目任务完成'
    : project.value.kind !== 'text' && (lines.value.at(-1)?.end || 0) >= project.value.duration
      ? '素材末尾没有空余时间，可编辑现有台词的时间范围'
      : ''
)
const lineJob = (id: string) =>
  detail.value?.jobs.find((j) => j.segmentId === id && ['queued', 'running'].includes(j.status))
function openBatch(action: BatchInput['action']) {
  batchAction.value = action
  showBatch.value = true
}
function audioFor(key: PreviewTrackKey) {
  return audioElements.value[key]
}
function trackAvailable(key: PreviewTrackKey) {
  return !!previewTracks.value?.tracks[key].path
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
async function playAudios() {
  const clock = clockPlayer.value
  if (!clock) return
  syncAudios(clock.currentTime)
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
function seekFromLane(event: MouseEvent) {
  const lane = event.currentTarget as HTMLElement
  const rect = lane.getBoundingClientRect()
  if (!rect.width) return
  seekTo(((event.clientX - rect.left) / rect.width) * previewDuration.value)
}
function setTrackEnabled(key: PreviewTrackKey, value: boolean | 'indeterminate') {
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
function setExportTrack(key: PreviewTrackKey, value: boolean | 'indeterminate') {
  const enabled = value === true
  if (enabled && key === 'optimized') {
    for (const sourceKey of sourceTrackKeys) exportTracks[sourceKey] = false
  } else if (enabled) {
    exportTracks.optimized = false
  }
  exportTracks[key] = enabled
}
function trackState(key: PreviewTrackKey) {
  const track = previewTracks.value?.tracks[key]
  if (!track?.path) return track?.reason || '尚未准备'
  if (!trackEnabled[key]) return '已关闭'
  if (key === 'optimized') return previewTracks.value?.missingDubs ? '未配音片段保留原声' : '最终成片效果'
  if (key === 'original') return '完整原声'
  if (key === 'dubbed' && previewTracks.value?.missingDubs)
    return `${previewTracks.value.missingDubs} 句未生成`
  return '参与试听'
}
function applyRecommendedExport() {
  const hasOptimized = !!previewTracks.value?.tracks.optimized.path
  exportTracks.optimized = hasOptimized
  exportTracks.original = false
  exportTracks.background = !hasOptimized && !!previewTracks.value?.tracks.background.path
  exportTracks.dubbed = !hasOptimized && !!previewTracks.value?.tracks.dubbed.path
  exportOriginalMode.value = 'preserve-gaps'
  exportFormat.value = project.value.kind === 'video' ? 'mkv' : 'wav'
}
function applyDubbedOnlyExport() {
  exportTracks.optimized = false
  exportTracks.original = false
  exportTracks.background = false
  exportTracks.dubbed = !!previewTracks.value?.tracks.dubbed.path
}
function applyOriginalGapsExport() {
  exportTracks.optimized = false
  exportTracks.original = !!previewTracks.value?.tracks.original.path
  exportTracks.background = false
  exportTracks.dubbed = !!previewTracks.value?.tracks.dubbed.path
  exportOriginalMode.value = 'preserve-gaps'
}
async function exportFilm() {
  if (exportReason.value || exporting.value) return
  exporting.value = true
  try {
    const task = await $fetch<{ jobId: string }>(`/api/projects/${project.value.id}/export`, {
      method: 'POST',
      body: {
        optimized: exportTracks.optimized,
        original: exportTracks.original,
        background: exportTracks.background,
        dubbed: exportTracks.dubbed,
        originalMode: exportOriginalMode.value,
        format: exportFormat.value
      }
    })
    await refresh()
    toast.add({
      id: 'project-export-queued',
      title: '导出任务已创建',
      description: '刷新页面后可在任务详情中下载成片',
      color: 'success'
    })
    const result = await waitForJobResult<ExportResult>(task.jobId, taskWait.signal)
    const link = document.createElement('a')
    link.href = mediaUrl(result.path, true)
    link.download = result.filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    toast.add({
      id: 'project-export-success',
      title: '成片已导出',
      description: result.filename,
      color: 'success'
    })
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
  if (
    detail.value?.jobs.some(
      (job) => ['queued', 'running'].includes(job.status) && job.stage !== 'preview-tracks'
    )
  ) {
    previewError.value = '正在处理项目，任务完成后会自动准备预览音轨。'
    return
  }
  const request = ++previewRequest
  previewLoading.value = true
  previewError.value = ''
  try {
    const task = await $fetch<{ jobId: string }>(`/api/projects/${project.value.id}/preview-tracks`, {
      method: 'POST'
    })
    void refresh().catch(() => {})
    const result = await waitForJobResult<PreviewTracks>(task.jobId, taskWait.signal)
    if (request !== previewRequest) return
    const changed = previewTracks.value?.revision !== result.revision
    previewTracks.value = result
    if (changed) {
      const hasOptimized = !!result.tracks.optimized.path
      const hasOriginal = !!result.tracks.original.path
      const hasBackground = !!result.tracks.background.path
      const hasDubbed = !!result.tracks.dubbed.path
      trackEnabled.optimized = hasOptimized
      trackEnabled.original = !hasOptimized && !hasBackground && !hasDubbed && hasOriginal
      trackEnabled.background = !hasOptimized && hasBackground
      trackEnabled.dubbed = !hasOptimized && hasDubbed
      exportTracks.optimized = hasOptimized
      exportTracks.original = false
      exportTracks.background = !hasOptimized && hasBackground
      exportTracks.dubbed = !hasOptimized && hasDubbed
      exportOriginalMode.value = 'preserve-gaps'
      exportFormat.value = project.value.kind === 'video' ? 'mkv' : 'wav'
    } else {
      for (const key of trackKeys) {
        if (!result.tracks[key].path) {
          trackEnabled[key] = false
          exportTracks[key] = false
        }
      }
    }
    await nextTick()
    syncAudios()
  } catch (error) {
    if (request === previewRequest) previewError.value = errorMessage(error)
  } finally {
    if (request === previewRequest) previewLoading.value = false
  }
}
watch(
  () => project.value.id,
  () => {
    current.value = undefined
    previewTracks.value = undefined
    pauseAll()
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
  [
    panel,
    previewSignature,
    () =>
      detail.value?.jobs.some(
        (job) => ['queued', 'running'].includes(job.status) && job.stage !== 'preview-tracks'
      )
  ],
  ([currentPanel]) => {
    if (currentPanel === 'preview') void loadPreviewTracks()
  },
  { immediate: true }
)
watch(clockSource, () => {
  pendingSeek = undefined
  time.value = 0
  playing.value = false
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
function selectLine(id: string) {
  if (dirty.value && !window.confirm('放弃未保存的台词修改？')) return
  dirty.value = false
  current.value = id
  showEditor.value = true
}
function setEditorOpen(open: boolean) {
  if (!open && dirty.value && !window.confirm('放弃未保存的台词修改？')) return
  showEditor.value = open
  if (!open) dirty.value = false
}
function generateLine(id: string) {
  current.value = id
  showGeneration.value = true
}
function openGeneration() {
  showEditor.value = false
  showGeneration.value = true
}
async function pause() {
  await act(() =>
    $fetch(`/api/projects/${project.value.id}/pause`, {
      method: 'POST',
      body: { paused: !project.value.paused }
    })
  )
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
</script>
<template>
  <section v-if="detail" class="workspace">
    <header class="workspace-header">
      <div class="workspace-title">
        <span class="workspace-project-name">{{ project.name }}</span>
        <span class="help">{{ normalizeLanguage(project.targetLanguage) }} · {{ lines.length }} 句台词</span>
      </div>
      <div class="row-actions">
        <span v-if="lines.length" class="help">{{ completed }} / {{ enabledCount }} 句已配音</span>
        <UButton
          v-if="locked || project.paused"
          color="neutral"
          variant="ghost"
          :icon="project.paused ? 'i-carbon-play' : 'i-carbon-pause'"
          @click="pause"
          >{{ project.paused ? '继续任务' : '暂停任务' }}</UButton
        >
        <StudioAction
          v-if="panel === 'script'"
          color="neutral"
          variant="ghost"
          icon="i-carbon-add"
          :reason="addReason"
          @click="addLine"
          >添加台词</StudioAction
        >
        <StudioAction
          v-if="panel === 'script' && lines.length"
          color="neutral"
          variant="ghost"
          icon="i-carbon-language"
          :reason="dirty ? '请先保存台词修改' : ''"
          @click="openBatch('translate')"
          >翻译台词</StudioAction
        >
        <StudioAction
          v-if="panel === 'preview'"
          color="neutral"
          variant="soft"
          icon="i-carbon-video"
          @click="openBatch('render')"
          >合成成片</StudioAction
        >
        <StudioAction
          v-if="panel === 'script'"
          icon="i-carbon-batch-job"
          :reason="dirty ? '请先保存台词修改' : ''"
          @click="openBatch(lines.length ? 'synthesize' : 'prepare')"
          >{{ lines.length ? '批量配音' : '处理素材' }}</StudioAction
        >
        <UButton
          v-if="project.outputPath"
          :href="mediaUrl(project.outputPath, true)"
          icon="i-carbon-download"
          color="neutral"
          variant="soft"
          >导出成片</UButton
        >
      </div>
    </header>
    <section v-if="panel === 'script'" class="script-panel">
      <div v-if="!lines.length" class="project-start">
        <UIcon name="i-carbon-script" class="empty-icon" />
        <h2>{{ project.kind === 'text' ? '先添加需要配音的台词' : '先识别素材中的台词' }}</h2>
        <p>
          {{
            project.kind === 'text'
              ? '填写台词后，可以逐句选择 AI 配音或微软 TTS。'
              : '在本机分离人声与背景音，再识别台词。中文识别结果使用简体中文。'
          }}
        </p>
        <StudioAction
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
        <details class="workspace-guide">
          <summary>
            <UIcon name="i-carbon-information" />处理指引<span>校对后逐句配音，翻译按需使用</span
            ><UIcon name="i-carbon-chevron-down" />
          </summary>
          <div class="guide-content">
            <p><strong>校对台词</strong>检查时间和原文，在右列填写希望说出的内容。</p>
            <p><strong>按需翻译</strong>需要其他语言时，点击“翻译台词”。会使用翻译接口额度。</p>
            <p><strong>生成配音</strong>每句可独立选择 AI 或免费 TTS；需要统一处理时使用“批量配音”。</p>
            <p><strong>试听并合成</strong>左右对照试听，满意后到“预览成片”手动合成。</p>
          </div>
        </details>
        <div class="comparison-heading"><span>原文与原声</span><span>配音台词与新声音</span></div>
        <div class="comparison-list">
          <article
            v-for="(line, i) in lines"
            :key="line.id"
            class="comparison-row"
            :class="{ selected: current === line.id, 'not-replaced': !line.enabled }"
          >
            <header class="comparison-meta">
              <div class="line-meta">
                <span class="line-number">{{ String(i + 1).padStart(2, '0') }}</span
                ><time>{{ formatTime(line.start) }} – {{ formatTime(line.end) }}</time
                ><span>{{ line.speaker }}</span>
              </div>
              <div class="line-meta">
                <span v-if="lineJob(line.id)" class="status-running">{{
                  lineJob(line.id)?.status === 'running' ? '正在生成' : '等待生成'
                }}</span
                ><span v-else-if="!line.enabled">保留原声</span
                ><span v-else-if="line.generatedPath" class="status-completed"
                  >已生成 · {{ line.synthesisMode === 'tts' ? '微软 TTS' : 'AI 配音' }}</span
                ><span v-else>待配音</span>
              </div>
            </header>
            <div class="comparison-source">
              <div class="dialogue-content">
                <p class="dialogue-original">{{ line.text || '尚未填写原文' }}</p>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-carbon-edit"
                  :aria-label="`编辑第 ${i + 1} 句原文与时间`"
                  @click="selectLine(line.id)"
                />
              </div>
              <ClipAudio
                :src="
                  project.kind !== 'text' && project.sourcePath
                    ? `/api/segments/${line.id}/original?t=${line.start}-${line.end}`
                    : undefined
                "
                :label="`第 ${i + 1} 句原声`"
                :empty="project.kind === 'text' ? '文本台词，无原声音频' : '尚无可试听的原声素材'"
              />
            </div>
            <div class="comparison-generated">
              <div class="dialogue-content">
                <div>
                  <p class="dialogue-translation">
                    {{ line.translation || line.text || '填写要生成的配音台词' }}
                  </p>
                  <small v-if="!line.translation && line.text" class="help">使用原文配音</small>
                </div>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-carbon-edit"
                  :aria-label="`编辑第 ${i + 1} 句配音台词`"
                  @click="selectLine(line.id)"
                />
              </div>
              <div class="generated-output">
                <ClipAudio
                  v-if="line.generatedPath"
                  :src="mediaUrl(line.generatedPath)"
                  :label="`第 ${i + 1} 句生成配音`"
                />
                <div v-else class="audio-placeholder">
                  <UIcon name="i-carbon-waveform" /><span>{{
                    lineJob(line.id) ? '完成后可在此试听' : '生成后在此试听'
                  }}</span>
                </div>
                <UButton
                  variant="soft"
                  size="sm"
                  icon="i-carbon-microphone"
                  :aria-label="`第 ${i + 1} 句${lineJob(line.id) ? '配音设置' : line.generatedPath ? '重新生成' : '生成配音'}`"
                  @click="generateLine(line.id)"
                  >{{ lineJob(line.id) ? '配音设置' : line.generatedPath ? '重新生成' : '生成配音' }}</UButton
                >
              </div>
            </div>
          </article>
        </div>
      </template>
    </section>

    <section v-else class="preview-panel">
      <header class="content-heading preview-heading">
        <div>
          <h2>预览成片</h2>
          <p class="help">
            上方画面始终无声；默认试听优化合成，也可开启三条源音轨对比。拖动主进度条或点击任意音轨可跳转核对。
          </p>
        </div>
        <div class="row-actions">
          <UBadge color="neutral" variant="soft">{{
            previewTracks ? `${previewTracks.replacementRanges.length} 个替换区间` : '等待音轨'
          }}</UBadge>
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-carbon-renew"
            :loading="previewLoading"
            @click="loadPreviewTracks"
            >刷新音轨</UButton
          >
        </div>
      </header>
      <div v-if="previewError" class="preview-alert" role="alert">
        <UIcon name="i-carbon-warning-alt" />
        <span>{{ previewError }}</span>
        <UButton color="neutral" variant="ghost" size="xs" @click="loadPreviewTracks">重试</UButton>
      </div>
      <div class="preview-editor">
        <section class="preview-monitor">
          <div class="preview-stage preview-stage-large" :class="{ 'audio-stage': project.kind !== 'video' }">
            <video
              v-if="project.kind === 'video'"
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
            <template v-else>
              <UIcon
                :name="project.kind === 'text' ? 'i-carbon-quotes' : 'i-carbon-waveform'"
                class="preview-icon"
              />
              <div class="audio-monitor-copy">
                <strong>{{ project.kind === 'text' ? '配音时间轴' : '音频项目' }}</strong>
                <span>此区域不播放原声；使用下方音轨开关试听最终混合效果。</span>
              </div>
            </template>
            <div v-if="previewLoading" class="preview-loading">
              <UIcon name="i-carbon-loading animate-spin" />
              <span>正在准备波形与试听缓存…</span>
            </div>
          </div>
          <audio
            v-if="project.kind !== 'video' && clockSource"
            ref="clockPlayer"
            class="mixer-hidden-audio"
            :src="mediaUrl(clockSource)"
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
              :disabled="!clockSource || previewLoading"
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
              :disabled="!clockSource || previewLoading"
              aria-label="播放进度"
              @input="seekTo(Number(($event.target as HTMLInputElement).value))"
            />
            <span class="preview-time">{{ formatTime(previewDuration) }}</span>
          </div>
          <div class="preview-status">
            <span><UIcon name="i-carbon-volume-mute" />视频画面始终静音，声音只来自已开启的音轨</span>
            <span v-if="previewTracks">
              {{ previewTracks.replacementRanges.length }} 个替换区间
              <template v-if="previewTracks.missingDubs">
                · {{ previewTracks.missingDubs }} 句待配音
              </template>
            </span>
          </div>
        </section>

        <section class="preview-mixer">
          <header class="mixer-heading">
            <div>
              <h3>音轨混音器</h3>
              <p class="help">
                优化合成与三条源音轨已对齐到同一时间轴；优化合成与源音轨互斥，避免重复叠加声音。
              </p>
            </div>
            <div class="mixer-legend"><span class="playhead-mark" />播放头</div>
          </header>
          <div class="mixer-ruler">
            <span class="mixer-ruler-spacer" />
            <div class="mixer-ruler-scale">
              <span v-for="n in 6" :key="n">{{ formatTime((previewDuration * (n - 1)) / 5) }}</span>
            </div>
          </div>
          <div
            v-for="key in trackKeys"
            :key="key"
            class="mixer-track"
            :class="[`track-${key}`, { disabled: !trackEnabled[key], unavailable: !trackAvailable(key) }]"
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
              <span class="mixer-track-state">{{ trackState(key) }}</span>
            </div>
            <div
              class="mixer-lane"
              role="slider"
              tabindex="0"
              :aria-label="`${trackLabels[key]}轨道进度`"
              :aria-valuemin="0"
              :aria-valuemax="previewDuration"
              :aria-valuenow="time"
              :aria-valuetext="`${formatTime(time)} / ${formatTime(previewDuration)}`"
              @click="seekFromLane"
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
              <span v-if="!trackAvailable(key)" class="mixer-empty">{{ trackState(key) }}</span>
            </div>
          </div>
          <p v-if="!previewTracks && !previewLoading && !previewError" class="help mixer-hint">
            音轨会在切换到本页时自动准备。
          </p>
        </section>

        <section class="export-panel">
          <header class="export-heading">
            <div>
              <h3>合并导出</h3>
              <p class="help">
                选择要写入成片的音轨。视频流会直接复制，不会重新编码画质；音频按所选格式合并。
              </p>
            </div>
            <UBadge color="success" variant="soft">{{
              project.kind === 'video' ? '画面流复制' : 'PCM 无损'
            }}</UBadge>
          </header>
          <div class="export-presets">
            <button type="button" class="export-preset recommended" @click="applyRecommendedExport">
              <strong>优化合成（推荐）</strong>
              <span>替换区间使用背景音 + 新配音，未配音片段保留原声，适合直接导出成片。</span>
            </button>
            <button type="button" class="export-preset" @click="applyDubbedOnlyExport">
              <strong>仅配音</strong>
              <span>只导出新配音，适合外部后期继续处理。</span>
            </button>
            <button type="button" class="export-preset" @click="applyOriginalGapsExport">
              <strong>未替换原声 + 配音</strong>
              <span>保留没有被新配音覆盖的原声区间，适合部分替换。</span>
            </button>
          </div>
          <div class="export-options">
            <div
              v-for="key in trackKeys"
              :key="`export-${key}`"
              class="export-option"
              :class="{ recommended: key === 'optimized', unavailable: !trackAvailable(key) }"
            >
              <UCheckbox
                :model-value="exportTracks[key]"
                :disabled="!trackAvailable(key)"
                @update:model-value="setExportTrack(key, $event)"
              />
              <div class="export-option-copy">
                <strong>{{ trackLabels[key] }}</strong>
                <span>{{ trackDescriptions[key] }}</span>
                <small v-if="!trackAvailable(key)">{{ trackState(key) }}</small>
              </div>
            </div>
          </div>
          <div class="export-settings">
            <UFormField
              v-if="exportTracks.original"
              label="原声处理方式"
              description="推荐保留未替换原声，避免旧人声与新配音重叠。"
            >
              <USelect v-model="exportOriginalMode" class="w-full" :items="exportOriginalModeItems" />
            </UFormField>
            <UFormField
              label="导出格式"
              description="MKV 使用 FLAC 无损音频；MP4 兼容性更好，音频为 AAC 320k。"
            >
              <USelect v-model="exportFormat" class="w-full" :items="exportFormatItems" />
            </UFormField>
          </div>
          <div class="export-summary">
            <div>
              <strong>{{ exportSummary }}</strong>
              <p v-if="exportWarning">{{ exportWarning }}</p>
              <p v-if="exportReason" class="export-reason">{{ exportReason }}</p>
            </div>
            <div class="export-actions">
              <UButton
                v-if="project.mixedPath"
                :href="mediaUrl(`${project.id}/subtitles.srt`, true)"
                color="neutral"
                variant="ghost"
                icon="i-carbon-closed-caption"
                >下载字幕 SRT</UButton
              >
              <StudioAction
                icon="i-carbon-download"
                :reason="exportReason"
                :loading="exporting"
                @click="exportFilm"
                >{{ project.kind === 'video' ? '导出视频成片' : '导出音频成片' }}</StudioAction
              >
            </div>
          </div>
        </section>
      </div>
      <audio
        ref="optimizedAudio"
        class="mixer-hidden-audio"
        :src="mediaUrl(playbackPaths.optimized)"
        preload="auto"
      />
      <audio
        ref="originalAudio"
        class="mixer-hidden-audio"
        :src="mediaUrl(playbackPaths.original)"
        preload="auto"
      />
      <audio
        ref="backgroundAudio"
        class="mixer-hidden-audio"
        :src="mediaUrl(playbackPaths.background)"
        preload="auto"
      />
      <audio
        ref="dubbedAudio"
        class="mixer-hidden-audio"
        :src="mediaUrl(playbackPaths.dubbed)"
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
      v-model:open="showGeneration"
      direction="bottom"
      :handle="false"
      title="生成配音"
      :inset="true"
      :handle-only="true"
      :ui="{ content: 'generation-drawer ring-0', overlay: 'bg-black/15' }"
    >
      <template #content>
        <div class="generation-drawer-inner">
          <VoiceGenerationPanel
            v-if="selected"
            :segment="selected"
            :key="selected.id"
            @close="showGeneration = false"
            @generated="showGeneration = false"
          />
        </div>
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
            修改目标语言会清除译文、配音和成片；修改 AI 渠道会清除配音和成片。仅修改名称不影响结果。
          </p>
          <UFormField label="项目名称"
            ><UInput class="w-full" v-model="options.name" :disabled="locked" /></UFormField
          ><UFormField label="原始语言"
            ><USelect
              v-model="options.sourceLanguage"
              class="w-full"
              :disabled="locked"
              :items="[
                { label: '自动检测', value: 'auto' },
                { label: '中文', value: 'zh' },
                { label: '英语', value: 'en' },
                { label: '日语', value: 'ja' },
                { label: '韩语', value: 'ko' },
                { label: '西班牙语', value: 'es' },
                { label: '法语', value: 'fr' },
                { label: '德语', value: 'de' },
                { label: '俄语', value: 'ru' }
              ]" /></UFormField
          ><UFormField label="目标语言"
            ><USelect
              v-model="options.targetLanguage"
              class="w-full"
              :disabled="locked"
              :items="languageOptions(options.targetLanguage)"
              aria-label="目标语言" /></UFormField
          ><UFormField label="AI 配音渠道" description="密钥在左下角设置中配置；微软 TTS 无需密钥。"
            ><USelect
              v-model="options.channelId"
              class="w-full"
              :disabled="locked"
              :items="
                channels
                  .filter((c) => c.type === 'volcengine' && c.enabled)
                  .map((c) => ({ label: c.name, value: c.id }))
              " /></UFormField
          ><StudioAction
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
  </section>
</template>
