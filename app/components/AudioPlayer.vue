<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    src?: string
    label?: string
    empty?: string
    duration?: number
    compact?: boolean
  }>(),
  {
    src: '',
    label: '音频播放器',
    empty: '暂无音频',
    duration: 0,
    compact: false
  }
)

const emit = defineEmits<{
  (e: 'play'): void
  (e: 'pause'): void
  (e: 'ended'): void
}>()

const audioRef = ref<HTMLAudioElement | null>(null)
const trackRef = ref<HTMLElement | null>(null)

const isPlaying = ref(false)
const currentTime = ref(0)
const mediaDuration = ref(0)
const failed = ref(false)
const isDragging = ref(false)

const totalDuration = computed(() => {
  if (Number.isFinite(mediaDuration.value) && mediaDuration.value > 0) return mediaDuration.value
  if (Number.isFinite(props.duration) && props.duration > 0) return props.duration
  return 0
})

const progressPercent = computed(() => {
  if (!totalDuration.value) return 0
  return Math.min(100, Math.max(0, (currentTime.value / totalDuration.value) * 100))
})

// 生成默认 36 根高低起伏的声波柱状数据作为平滑底图
const defaultPeaks = [
  0.25, 0.4, 0.65, 0.35, 0.8, 0.5, 0.3, 0.6, 0.85, 0.45, 0.7, 0.9, 0.55, 0.35, 0.75, 0.6, 0.4, 0.85, 0.7, 0.3,
  0.55, 0.8, 0.95, 0.6, 0.45, 0.7, 0.5, 0.35, 0.65, 0.8, 0.4, 0.55, 0.3, 0.45, 0.35, 0.25
]

const peaksCache = new Map<string, number[]>()
const peaks = ref<number[]>([...defaultPeaks])

let sharedAudioCtx: AudioContext | null = null
function getAudioContext() {
  if (!sharedAudioCtx && typeof window !== 'undefined') {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (AudioCtx) {
      sharedAudioCtx = new AudioCtx()
    }
  }
  return sharedAudioCtx
}

async function extractPeaks(url: string) {
  if (!url) {
    peaks.value = [...defaultPeaks]
    return
  }
  if (peaksCache.has(url)) {
    peaks.value = peaksCache.get(url)!
    return
  }

  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const arrayBuffer = await res.arrayBuffer()
    const ctx = getAudioContext()
    if (!ctx) return
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
    const raw = audioBuffer.getChannelData(0)
    const buckets = 36
    const bucketSize = Math.floor(raw.length / buckets)
    const extracted: number[] = []

    for (let i = 0; i < buckets; i++) {
      let max = 0
      const start = i * bucketSize
      const end = Math.min(start + bucketSize, raw.length)
      const step = Math.max(1, Math.floor((end - start) / 40))
      for (let j = start; j < end; j += step) {
        const val = Math.abs(raw[j] || 0)
        if (val > max) max = val
      }
      extracted.push(max)
    }

    const peakMax = Math.max(...extracted, 0.01)
    const normalized = extracted.map((p) => Math.max(0.15, Math.min(1, p / peakMax)))
    peaksCache.set(url, normalized)
    peaks.value = normalized
  } catch {
    // 解码失败时保留优雅默认波形，不影响正常播放
    peaks.value = [...defaultPeaks]
  }
}

watch(
  () => props.src,
  (newSrc) => {
    failed.value = false
    currentTime.value = 0
    isPlaying.value = false
    if (newSrc) {
      void extractPeaks(newSrc)
    } else {
      peaks.value = [...defaultPeaks]
    }
  },
  { immediate: true }
)

function togglePlay() {
  if (!audioRef.value || !props.src) return
  if (isPlaying.value) {
    audioRef.value.pause()
  } else {
    // 互斥播放：暂停全局其他正在播放的音视频
    document.querySelectorAll('audio, video').forEach((el) => {
      if (el !== audioRef.value) (el as HTMLMediaElement).pause()
    })
    audioRef.value.play().catch(() => {
      isPlaying.value = false
    })
  }
}

function onPlay() {
  isPlaying.value = true
  emit('play')
}

function onPause() {
  isPlaying.value = false
  emit('pause')
}

function onEnded() {
  isPlaying.value = false
  currentTime.value = 0
  if (audioRef.value) audioRef.value.currentTime = 0
  emit('ended')
}

function onTimeUpdate() {
  if (!audioRef.value || isDragging.value) return
  currentTime.value = audioRef.value.currentTime
}

function onLoadedMetadata() {
  if (!audioRef.value) return
  failed.value = false
  if (Number.isFinite(audioRef.value.duration) && audioRef.value.duration > 0) {
    mediaDuration.value = audioRef.value.duration
  }
}

function onError() {
  failed.value = true
  isPlaying.value = false
}

function retry() {
  failed.value = false
  if (audioRef.value) {
    audioRef.value.load()
  }
}

function seekFromEvent(event: PointerEvent) {
  if (!trackRef.value || !totalDuration.value) return
  const rect = trackRef.value.getBoundingClientRect()
  if (rect.width <= 0) return
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
  const targetTime = ratio * totalDuration.value
  currentTime.value = targetTime
  if (audioRef.value) {
    audioRef.value.currentTime = targetTime
  }
}

function seekBy(seconds: number) {
  if (!audioRef.value || failed.value) return
  currentTime.value = Math.max(0, Math.min(totalDuration.value, currentTime.value + seconds))
  audioRef.value.currentTime = currentTime.value
}

function onPointerDown(event: PointerEvent) {
  if (!props.src || failed.value) return
  isDragging.value = true
  seekFromEvent(event)

  function onPointerMove(e: PointerEvent) {
    seekFromEvent(e)
  }

  function onPointerUp(e: PointerEvent) {
    isDragging.value = false
    seekFromEvent(e)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  }

  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}

function formatAudioTime(val: number) {
  if (!Number.isFinite(val) || val < 0) return '00:00'
  const m = Math.floor(val / 60)
  const s = Math.floor(val % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

onBeforeUnmount(() => {
  if (audioRef.value) {
    audioRef.value.pause()
  }
})
</script>

<template>
  <div
    class="audio-player"
    :class="{ 'is-compact': compact, 'has-error': failed, 'is-empty': !src }"
    :aria-label="label"
  >
    <audio
      v-if="src"
      ref="audioRef"
      :src="src"
      preload="metadata"
      class="hidden"
      @play="onPlay"
      @pause="onPause"
      @ended="onEnded"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onLoadedMetadata"
      @error="onError"
    />

    <template v-if="src && !failed">
      <slot name="leading" />

      <UButton
        type="button"
        color="neutral"
        variant="ghost"
        size="xs"
        class="audio-play-btn"
        :icon="isPlaying ? 'i-carbon-pause-filled' : 'i-carbon-play-filled-alt'"
        :aria-label="isPlaying ? '暂停' : '播放'"
        :title="isPlaying ? '暂停' : '播放'"
        @click.stop="togglePlay"
      />

      <div
        ref="trackRef"
        class="audio-waveform-track"
        role="slider"
        :aria-label="`${label} 进度`"
        :aria-valuenow="currentTime"
        :aria-valuemin="0"
        :aria-valuemax="totalDuration"
        tabindex="0"
        @pointerdown.stop="onPointerDown"
        @keydown.left.prevent.stop="seekBy(-1)"
        @keydown.right.prevent.stop="seekBy(1)"
        @keydown.space.prevent.stop="togglePlay"
      >
        <!-- 底层未播放波形 -->
        <div class="waveform-bars base-bars" aria-hidden="true">
          <span
            v-for="(peak, i) in peaks"
            :key="`b-${i}`"
            class="waveform-bar"
            :style="{ height: `${Math.round(peak * 100)}%` }"
          />
        </div>

        <!-- 顶层已播放波形 (通过进度 clipPath 变色覆盖) -->
        <div
          class="waveform-bars progress-bars"
          :style="{ clipPath: `inset(0 calc(100% - ${progressPercent}%) 0 0)` }"
          aria-hidden="true"
        >
          <span
            v-for="(peak, i) in peaks"
            :key="`p-${i}`"
            class="waveform-bar progress-fill"
            :style="{ height: `${Math.round(peak * 100)}%` }"
          />
        </div>
      </div>

      <span class="audio-time" :title="`当前进度 / 总时长`">
        {{ formatAudioTime(currentTime) }} / {{ formatAudioTime(totalDuration) }}
      </span>

      <div v-if="$slots.trailing" class="audio-trailing">
        <slot name="trailing" />
      </div>
    </template>

    <template v-else-if="failed">
      <span class="audio-error-text">音频读取失败</span>
      <UButton size="xs" color="neutral" variant="outline" @click.stop="retry">重新加载</UButton>
      <div v-if="$slots.trailing" class="audio-trailing">
        <slot name="trailing" />
      </div>
    </template>

    <template v-else>
      <span class="audio-empty-text">{{ empty }}</span>
      <div v-if="$slots.trailing" class="audio-trailing">
        <slot name="trailing" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.audio-player {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  box-sizing: border-box;
}

.audio-player.is-compact {
  height: 32px;
  padding: 2px 6px;
  gap: 6px;
}

.audio-play-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  color: var(--ui-text);
  border-radius: 6px;
}

.audio-play-btn:hover {
  background: color-mix(in srgb, var(--ui-text-muted) 15%, transparent);
}

.audio-waveform-track {
  position: relative;
  flex: 1;
  min-width: 60px;
  height: 24px;
  display: flex;
  align-items: center;
  cursor: pointer;
  user-select: none;
  touch-action: none;
}

.audio-waveform-track:focus-visible {
  outline: 2px solid var(--ui-primary, #c96442);
  outline-offset: 2px;
  border-radius: 4px;
}

.waveform-bars {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2px;
  height: 100%;
  width: 100%;
}

.waveform-bar {
  flex: 1;
  min-width: 2px;
  max-width: 5px;
  min-height: 15%;
  border-radius: 99px;
  background: color-mix(in srgb, var(--ui-text-muted) 35%, transparent);
  transition: height 120ms ease;
}

.progress-bars {
  pointer-events: none;
  transition: clip-path 50ms linear;
}

.waveform-bar.progress-fill {
  background: var(--ui-primary, #c96442);
}

.audio-time {
  flex-shrink: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-muted);
  white-space: nowrap;
  line-height: 1;
}

.audio-trailing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.audio-empty-text {
  font-size: 12px;
  color: var(--ui-text-muted);
  line-height: 1.5;
}

.audio-error-text {
  font-size: 12px;
  color: var(--ui-error, #dc2626);
  line-height: 1.5;
}
</style>
