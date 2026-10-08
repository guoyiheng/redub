<script setup lang="ts">
import { aiVoices } from '../../shared/ai-voices'
import type { VoiceSettings } from '../../shared/voice'
import { useStudio } from '../composables/useStudio'

const props = defineProps<{ disabled?: boolean }>()
const draft = defineModel<VoiceSettings>({ required: true })
const { settings, toast, errorMessage, selected, refresh } = useStudio()

const open = ref(false)
const search = ref('')
const displayCount = ref(20)

const selectedLabel = computed(() => {
  if (draft.value.aiUseReference) return '在线音色'
  const speaker = draft.value.aiSpeaker?.trim()
  return aiVoices.find((voice) => voice.value === speaker)?.label || speaker || '自动音色'
})

const selectedGender = ref<'all' | 'female' | 'male'>('all')

const filteredVoices = computed(() => {
  const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const pinned = new Set(settings.value?.pinnedVoices || [])
  const gender = selectedGender.value
  const matched = aiVoices.filter((voice) => {
    if (gender !== 'all' && voice.gender !== gender) {
      return false
    }
    const genderKeyword = voice.gender === 'female' ? '女声 女' : '男声 男'
    const text = [voice.label, voice.value, voice.language, voice.category, genderKeyword]
      .join(' ')
      .toLocaleLowerCase()
    return terms.every((term) => text.includes(term))
  })
  return matched.sort((a, b) => {
    const aPinned = pinned.has(a.value) ? 1 : 0
    const bPinned = pinned.has(b.value) ? 1 : 0
    if (aPinned !== bPinned) return bPinned - aPinned
    return 0
  })
})

const visibleVoices = computed(() => {
  return filteredVoices.value.slice(0, displayCount.value)
})

function selectVoice(speaker: string) {
  if (props.disabled) return
  draft.value.aiSpeaker = speaker
  draft.value.aiUseReference = false
  open.value = false
}

// 懒加载滚动处理
function onScroll(e: Event) {
  const el = e.target as HTMLElement
  if (!el) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
    if (displayCount.value < filteredVoices.value.length) {
      displayCount.value = Math.min(displayCount.value + 20, filteredVoices.value.length)
    }
  }
}

function loadMore() {
  displayCount.value = Math.min(displayCount.value + 20, filteredVoices.value.length)
}

// 模块级试听资源缓存与在途请求追踪，切换和重开下拉框时均保留
const auditionBlobCache = new Map<string, Blob>()
const inFlightFetches = new Map<string, Promise<Blob>>()

// 试听状态管理
const auditionSpeaker = ref('')
const isAuditionLoading = ref(false)
const isAuditionPlaying = ref(false)
let auditionAudio: HTMLAudioElement | null = null
let auditionUrl = ''

function stopAudition() {
  if (auditionAudio) {
    auditionAudio.pause()
    auditionAudio = null
  }
  if (auditionUrl) URL.revokeObjectURL(auditionUrl)
  auditionUrl = ''
  auditionSpeaker.value = ''
  isAuditionPlaying.value = false
  isAuditionLoading.value = false
}

async function playAuditionBlob(blob: Blob) {
  if (auditionAudio) {
    auditionAudio.pause()
    auditionAudio = null
  }
  if (auditionUrl) URL.revokeObjectURL(auditionUrl)
  auditionUrl = URL.createObjectURL(blob)
  const audio = new Audio(auditionUrl)
  auditionAudio = audio
  audio.onended = () => {
    stopAudition()
  }
  audio.onerror = () => {
    stopAudition()
    toast.add({ title: '试听播放失败', color: 'error' })
  }
  await audio.play()
  isAuditionPlaying.value = true
  isAuditionLoading.value = false
}

async function toggleAudition(speaker: string, e?: Event) {
  e?.stopPropagation()
  if (auditionSpeaker.value === speaker && (isAuditionPlaying.value || isAuditionLoading.value)) {
    stopAudition()
    return
  }
  stopAudition()

  auditionSpeaker.value = speaker

  // 1. 优先命中内存缓存，直接秒播
  const cachedBlob = auditionBlobCache.get(speaker)
  if (cachedBlob) {
    try {
      await playAuditionBlob(cachedBlob)
    } catch (error) {
      stopAudition()
      toast.add({ title: '试听播放失败', description: errorMessage(error), color: 'error' })
    }
    return
  }

  // 2. 检查或发起后台合成任务
  isAuditionLoading.value = true
  const voiceItem = aiVoices.find((v) => v.value === speaker)
  const speakerLabel = voiceItem?.label || speaker

  let fetchPromise = inFlightFetches.get(speaker)
  if (!fetchPromise) {
    fetchPromise = $fetch<Blob>('/api/tts/preview', {
      method: 'POST',
      responseType: 'blob',
      body: {
        speaker,
        speakerLabel
      }
    })
      .then((blob) => {
        auditionBlobCache.set(speaker, blob)
        inFlightFetches.delete(speaker)
        void refresh()
        return blob
      })
      .catch((err) => {
        inFlightFetches.delete(speaker)
        void refresh()
        throw err
      })
    inFlightFetches.set(speaker, fetchPromise)
    void refresh()
  }

  try {
    const blob = await fetchPromise
    // 如果用户仍然在该音色上并且下拉菜单仍保持打开，则自动播放
    if (auditionSpeaker.value === speaker && open.value) {
      await playAuditionBlob(blob)
    }
  } catch (error) {
    if (auditionSpeaker.value === speaker) {
      stopAudition()
      toast.add({ title: '试听失败', description: errorMessage(error), color: 'error' })
    }
  } finally {
    if (auditionSpeaker.value === speaker) {
      isAuditionLoading.value = false
    }
  }
}

onBeforeUnmount(() => {
  // 菜单切换或离开页面时，仅暂停当前音频播放，不中止正在后台运行的合成任务
  if (auditionAudio) {
    auditionAudio.pause()
    auditionAudio = null
  }
  if (auditionUrl) {
    URL.revokeObjectURL(auditionUrl)
    auditionUrl = ''
  }
  isAuditionPlaying.value = false
})

watch(open, (isOpen) => {
  if (!isOpen) {
    // 下拉关闭时，仅暂停播放，后台合成任务继续跑完并落盘
    if (auditionAudio) {
      auditionAudio.pause()
      auditionAudio = null
    }
    if (auditionUrl) {
      URL.revokeObjectURL(auditionUrl)
      auditionUrl = ''
    }
    isAuditionPlaying.value = false
  }
  search.value = ''
  selectedGender.value = 'all'
  displayCount.value = 20
})

watch([search, selectedGender], () => {
  displayCount.value = 20
})

watch(
  () => props.disabled,
  (value) => {
    if (value) {
      stopAudition()
      open.value = false
    }
  }
)
</script>

<template>
  <UPopover v-model:open="open" :content="{ side: 'top', align: 'start' }">
    <UButton
      type="button"
      aria-label="AI 音色"
      :title="selectedLabel"
      icon="i-carbon-microphone"
      trailing-icon="i-carbon-chevron-down"
      color="neutral"
      variant="outline"
      size="sm"
      class="max-w-44"
      :disabled="disabled"
    >
      <span class="truncate">{{ selectedLabel }}</span>
    </UButton>
    <template #content>
      <div class="w-84 max-w-[calc(100vw-2rem)] p-2" aria-label="AI 音色列表">
        <UInput
          v-model="search"
          autofocus
          icon="i-carbon-search"
          aria-label="搜索 AI 音色"
          placeholder="搜索名称、语言或音色 ID"
          class="mb-2 w-full"
          :disabled="disabled"
        />
        <div class="flex items-center gap-1 mb-2">
          <UButton
            v-for="g in [
              { label: '全部', value: 'all' },
              { label: '女声', value: 'female' },
              { label: '男声', value: 'male' }
            ]"
            :key="g.value"
            size="xs"
            :variant="selectedGender === g.value ? 'solid' : 'ghost'"
            :color="selectedGender === g.value ? 'primary' : 'neutral'"
            class="text-xs py-0.5 px-2 h-6"
            @click="selectedGender = g.value as any"
          >
            {{ g.label }}
          </UButton>
        </div>
        <div
          class="max-h-72 overflow-y-auto overscroll-contain pr-1"
          aria-label="可选音色"
          @scroll="onScroll"
        >
          <div
            v-if="!search.trim() && selectedGender === 'all'"
            class="flex items-center justify-between px-2.5 py-1.5 rounded-md mb-1 cursor-pointer transition-colors border-l-2"
            :class="[
              !draft.aiUseReference && !draft.aiSpeaker?.trim()
                ? 'bg-primary/10 text-primary font-medium border-primary'
                : 'border-transparent hover:bg-elevated/70 text-default'
            ]"
            @click="selectVoice('')"
          >
            <div class="flex items-center gap-1.5">
              <span class="text-sm">自动音色</span>
              <UIcon
                v-if="!draft.aiUseReference && !draft.aiSpeaker?.trim()"
                name="i-carbon-checkmark"
                class="size-3.5 text-primary shrink-0"
              />
            </div>
          </div>
          <div
            v-for="voice in visibleVoices"
            :key="voice.value"
            class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md my-0.5 cursor-pointer transition-colors border-l-2"
            :class="[
              !draft.aiUseReference && draft.aiSpeaker?.trim() === voice.value
                ? 'bg-primary/10 text-primary font-medium border-primary'
                : 'border-transparent hover:bg-elevated/70 text-default'
            ]"
            :title="voice.value"
            @click="selectVoice(voice.value)"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate text-sm">{{ voice.label }}</span>
                <UBadge color="neutral" variant="subtle" size="xs" class="gap-0.5">
                  <UIcon
                    :name="voice.gender === 'female' ? 'i-carbon-gender-female' : 'i-carbon-gender-male'"
                    class="size-2.5"
                  />
                  {{ voice.gender === 'female' ? '女' : '男' }}
                </UBadge>
                <UIcon
                  v-if="!draft.aiUseReference && draft.aiSpeaker?.trim() === voice.value"
                  name="i-carbon-checkmark"
                  class="size-3.5 text-primary shrink-0"
                />
                <UIcon
                  v-if="settings?.pinnedVoices?.includes(voice.value)"
                  name="i-carbon-pin-filled"
                  class="size-3 text-primary shrink-0"
                  title="已置顶"
                />
              </div>
              <div class="text-muted truncate text-xs font-normal" :title="voice.language">
                {{ voice.language }} · {{ voice.category }}
              </div>
              <div v-if="voice.note" class="text-muted whitespace-normal text-xs font-normal">
                {{ voice.note }}
              </div>
            </div>
            <div class="shrink-0 flex items-center justify-center">
              <UButton
                type="button"
                color="neutral"
                variant="ghost"
                size="xs"
                class="size-7 p-0 flex items-center justify-center"
                :icon="
                  auditionSpeaker === voice.value && isAuditionPlaying
                    ? 'i-carbon-stop-filled'
                    : 'i-carbon-play-filled-alt'
                "
                :loading="auditionSpeaker === voice.value && isAuditionLoading"
                :title="auditionSpeaker === voice.value && isAuditionPlaying ? '停止试听' : '试听音色'"
                @click.stop="toggleAudition(voice.value, $event)"
              />
            </div>
          </div>
          <div v-if="displayCount < filteredVoices.length" class="p-1.5 text-center">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              class="w-full justify-center text-xs text-muted"
              @click="loadMore"
            >
              加载更多 (已显示 {{ displayCount }} / {{ filteredVoices.length }})
            </UButton>
          </div>
          <p v-if="!filteredVoices.length" role="status" class="text-muted px-3 py-6 text-center text-sm">
            没有找到匹配的音色
          </p>
        </div>
      </div>
    </template>
  </UPopover>
</template>
