<script setup lang="ts">
import { segmentTaskReason } from '../../shared/job-policy'
import {
  voiceSettingsSchema,
  naturalVoicePrompt,
  referenceVoicePrompt,
  dubbedText,
  withVoiceLanguage
} from '../../shared/voice'
import type { Segment, ReferenceVoice } from '../../shared/types'
const props = defineProps<{ segment: Segment }>()
const emit = defineEmits<{ close: []; generated: [] }>()
const { act, channels, detail, toast, errorMessage } = useStudio()
const canReference = computed(
  () => !!detail.value?.project.vocalsPath && detail.value?.project.kind !== 'text'
)
const customReference = ref(props.segment.customReferencePath || null)
const uploadedName = ref('自定义参考')
const { voices, load: loadVoices } = useReferenceVoices()
const libraryOpen = ref(false)
const referenceName = computed(() =>
  customReference.value
    ? voices.value.find((v) => v.path === customReference.value)?.name || uploadedName.value
    : '本句原声'
)
onMounted(() => {
  void loadVoices().catch(() => {})
})
function useVoice(voice: ReferenceVoice) {
  customReference.value = voice.path
  draft.value.aiUseReference = true
  referenceOpen.value = false
}
const referenceChoices = computed(() => [
  ...(canReference.value ? [{ label: '本句原声', icon: 'i-carbon-waveform', onSelect: useOriginal }] : []),
  ...voices.value.map((voice) => ({
    label: voice.name,
    icon: 'i-carbon-music',
    onSelect: () => useVoice(voice)
  })),
  {
    label: '添加 / 管理音色',
    icon: 'i-carbon-add',
    onSelect: () => {
      libraryOpen.value = true
    }
  },
  { label: '临时上传音频', icon: 'i-carbon-upload', onSelect: () => picker.value?.click() }
])
const draft = ref(
  voiceSettingsSchema.parse({
    ...props.segment,
    aiUseReference: props.segment.aiUseReference && (canReference.value || !!customReference.value)
  })
)
const activeChannel = computed(() => channels.value.find((c) => c.type === 'volcengine' && c.enabled))
const originalText = (props.segment.translation || props.segment.text || '').trim()
const hasReference = draft.value.aiUseReference && (canReference.value || !!customReference.value)
const direction = props.segment.aiPrompt?.trim()
  ? props.segment.aiPrompt.trim()
  : hasReference
    ? referenceVoicePrompt
    : naturalVoicePrompt
const aiContent = ref(
  withVoiceLanguage(
    props.segment.generationPrompt || `${direction}\n朗读：「${originalText}」`,
    props.segment.translationLanguage || detail.value?.project.targetLanguage || '中文'
  )
)
const ttsContent = ref(dubbedText(props.segment) || originalText)
const content = computed({
  get: () => (draft.value.synthesisMode === 'ai' ? aiContent.value : ttsContent.value),
  set: (value: string) => {
    if (draft.value.synthesisMode === 'ai') aiContent.value = value
    else ttsContent.value = value
  }
})
const saving = ref(false)
const uploading = ref(false)
const picker = ref<HTMLInputElement>()
const referenceOpen = ref(false)
const audioRef = ref<HTMLAudioElement>()
const isPlaying = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const audioError = ref(false)

const referenceSrc = computed(() =>
  customReference.value
    ? mediaUrl(customReference.value)
    : canReference.value
      ? props.segment.referencePath
        ? mediaUrl(props.segment.referencePath)
        : `/api/segments/${props.segment.id}/original?t=${props.segment.start}-${props.segment.end}`
      : ''
)

function togglePlay() {
  if (!audioRef.value) return
  if (isPlaying.value) {
    audioRef.value.pause()
  } else {
    document.querySelectorAll('audio, video').forEach((el) => {
      if (el !== audioRef.value) (el as HTMLMediaElement).pause()
    })
    audioRef.value.play().catch(() => {
      isPlaying.value = false
    })
  }
}

function onTimeUpdate() {
  if (audioRef.value) {
    currentTime.value = audioRef.value.currentTime
  }
}

function onLoadedMetadata() {
  if (audioRef.value) {
    duration.value = audioRef.value.duration || 0
    audioError.value = false
  }
}

function onAudioEnded() {
  isPlaying.value = false
  currentTime.value = 0
  if (audioRef.value) {
    audioRef.value.currentTime = 0
  }
}

function onAudioPause() {
  isPlaying.value = false
}

function onAudioPlay() {
  isPlaying.value = true
}

function onAudioError() {
  audioError.value = true
  isPlaying.value = false
}

watch(referenceSrc, () => {
  if (audioRef.value) {
    audioRef.value.pause()
  }
  isPlaying.value = false
  currentTime.value = 0
  duration.value = 0
  audioError.value = false
})

onBeforeUnmount(() => {
  if (audioRef.value) {
    audioRef.value.pause()
  }
})

const busy = computed(() => saving.value || uploading.value)
const submitLabel = computed(() => (props.segment.enabled ? '生成本句配音' : '生成并启用替换'))
const unavailableReason = computed(() => {
  if (busy.value) return uploading.value ? '正在准备参考音频' : '正在提交配音任务'
  const reason = segmentTaskReason(detail.value?.jobs || [], props.segment.id)
  if (reason) return reason
  if (!content.value.trim()) return '请输入配音内容'
  if (draft.value.synthesisMode === 'ai' && !activeChannel.value?.configured)
    return '请在设置中启用并配置 AI 配音渠道'
  return ''
})
function removeReference() {
  if (audioRef.value) {
    audioRef.value.pause()
  }
  isPlaying.value = false
  currentTime.value = 0
  draft.value.aiUseReference = false
  customReference.value = null
  referenceOpen.value = false
}
function useOriginal() {
  customReference.value = null
  draft.value.aiUseReference = true
  referenceOpen.value = false
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploading.value = true
  try {
    if (file.size > 10 * 1024 ** 2) throw new Error('参考音频不能超过 10 MB')
    const body = new FormData()
    body.set('file', file)
    const result = await $fetch<{ path: string; name: string }>(
      `/api/segments/${props.segment.id}/reference`,
      { method: 'POST', body }
    )
    customReference.value = result.path
    uploadedName.value = result.name
    draft.value.aiUseReference = true
    referenceOpen.value = false
  } catch (error) {
    toast.add({ title: '未能替换参考音频', description: errorMessage(error), color: 'error' })
  } finally {
    uploading.value = false
    input.value = ''
  }
}
async function generate() {
  if (unavailableReason.value) return
  saving.value = true
  try {
    const ok = await act(
      () =>
        $fetch(`/api/segments/${props.segment.id}/generate`, {
          method: 'POST',
          body: {
            ...draft.value,
            customReferencePath: customReference.value,
            ...(draft.value.synthesisMode === 'ai'
              ? { generationPrompt: aiContent.value.trim() }
              : { translation: ttsContent.value.trim() })
          }
        }),
      '配音已加入队列'
    )
    if (ok) emit('generated')
  } finally {
    saving.value = false
  }
}
</script>
<template>
  <ReferenceVoiceLibrary v-model:open="libraryOpen" selectable @select="useVoice" />
  <form class="generation-panel" @submit.prevent="generate">
    <VoiceParameters v-model="draft" :disabled="busy" :can-reference="canReference || !!customReference">
      <UTextarea
        v-model="content"
        class="voice-composer-input w-full"
        variant="none"
        :aria-label="draft.synthesisMode === 'ai' ? '配音内容与提示词' : '朗读文字'"
        :placeholder="
          draft.synthesisMode === 'ai' ? '用轻松的语气说：「你好，欢迎回来。」' : '输入要朗读的文字…'
        "
        :rows="4"
        autoresize
        :maxrows="10"
        :maxlength="2800"
        :disabled="busy"
        @keydown.meta.enter.prevent="generate"
        @keydown.ctrl.enter.prevent="generate"
      />
      <template #reference>
        <div
          v-if="draft.synthesisMode === 'ai' && draft.aiUseReference && referenceSrc"
          class="reference-chip"
        >
          <audio
            ref="audioRef"
            :src="referenceSrc"
            preload="metadata"
            class="hidden"
            @timeupdate="onTimeUpdate"
            @loadedmetadata="onLoadedMetadata"
            @ended="onAudioEnded"
            @pause="onAudioPause"
            @play="onAudioPlay"
            @error="onAudioError"
          />
          <UButton
            type="button"
            color="neutral"
            variant="outline"
            size="sm"
            :icon="isPlaying ? 'i-carbon-pause-filled' : 'i-carbon-play-filled-alt'"
            :aria-label="isPlaying ? '暂停参考音频' : '播放参考音频'"
            @click.stop="togglePlay"
          />
          <div class="voice-reference-meta">
            <span class="voice-reference-title" :title="referenceName">{{ referenceName }}</span>
          </div>
          <UDropdownMenu :items="referenceChoices" :content="{ side: 'top', align: 'start' }">
            <UButton
              type="button"
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-carbon-chevron-down"
              :disabled="busy"
              aria-label="替换参考音色"
              title="替换参考音色"
            />
          </UDropdownMenu>
          <UButton
            type="button"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-carbon-close"
            :disabled="busy"
            aria-label="移除参考音频"
            title="移除参考音频"
            @click.stop="removeReference"
          />
        </div>
      </template>
      <template #reference-control>
        <span class="voice-segment-time"
          >{{ formatTime(segment.start) }} – {{ formatTime(segment.end) }}</span
        >
        <UDropdownMenu
          v-if="draft.synthesisMode === 'ai' && !draft.aiUseReference"
          :items="referenceChoices"
          :content="{ side: 'top', align: 'start' }"
        >
          <UButton
            type="button"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-carbon-add"
            :disabled="busy"
            :loading="uploading"
            >参考音色</UButton
          >
        </UDropdownMenu>
      </template>
      <template #actions>
        <StudioAction
          type="submit"
          color="neutral"
          variant="solid"
          icon="i-carbon-arrow-up"
          square
          :aria-label="submitLabel"
          :reason="unavailableReason"
          :loading="saving"
        />
      </template>
    </VoiceParameters>
    <input
      ref="picker"
      class="sr-only"
      type="file"
      accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac"
      aria-label="选择参考音频"
      tabindex="-1"
      :disabled="busy"
      @change="upload"
    />
  </form>
</template>

<style scoped>
.reference-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  max-width: calc(100% - 24px);
  margin: 0 12px 10px;
  padding: 5px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-bg);
}
.reference-chip .voice-reference-meta {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 150px;
}
.reference-chip .voice-reference-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  padding: 0 4px;
}
</style>
