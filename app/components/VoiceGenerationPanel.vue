<script setup lang="ts">
import { segmentTaskReason } from '../../shared/job-policy'
import {
  voiceSettingsSchema,
  naturalVoicePrompt,
  referenceVoicePrompt,
  dubbedText,
  withVoiceLanguage,
  composeStructuredVoicePrompt,
  parseStructuredVoicePrompt,
  inferToneFromContext
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
const targetLanguage = props.segment.translationLanguage || detail.value?.project.targetLanguage || '中文'
const direction = props.segment.aiPrompt?.trim()
  ? props.segment.aiPrompt.trim()
  : hasReference
    ? referenceVoicePrompt
    : naturalVoicePrompt

const initialTone = inferToneFromContext(props.segment, detail.value?.segments || [])
const initialPrompt =
  props.segment.generationPrompt ||
  composeStructuredVoicePrompt({
    language: targetLanguage,
    direction,
    useReference: hasReference,
    tone: initialTone,
    text: originalText
  })

const aiContent = ref(withVoiceLanguage(initialPrompt, targetLanguage))
const ttsContent = ref(dubbedText(props.segment) || originalText)
const content = computed({
  get: () => (draft.value.synthesisMode === 'ai' ? aiContent.value : ttsContent.value),
  set: (value: string) => {
    if (draft.value.synthesisMode === 'ai') aiContent.value = value
    else ttsContent.value = value
  }
})

const parsedPrompt = computed(() => parseStructuredVoicePrompt(aiContent.value, originalText))

const tonePresets = ['轻松调侃', '焦急催促', '温柔安慰', '愤怒质问', '轻声叹息', '庄重严肃', '平静从容']

function applyTone(newTone: string) {
  const parsed = parseStructuredVoicePrompt(aiContent.value, originalText)
  aiContent.value = withVoiceLanguage(
    composeStructuredVoicePrompt({
      language: targetLanguage,
      requirement: parsed.requirement || direction,
      useReference: hasReference,
      tone: newTone,
      text: parsed.text || originalText
    }),
    targetLanguage
  )
}

function inferContextTone() {
  const tone = inferToneFromContext(props.segment, detail.value?.segments || [])
  applyTone(tone)
  toast.add({ title: `已根据台词上下文判断语气：「${tone}」`, color: 'info' })
}
const saving = ref(false)
const uploading = ref(false)
const picker = ref<HTMLInputElement>()
const referenceOpen = ref(false)
const referenceSrc = computed(() =>
  customReference.value
    ? mediaUrl(customReference.value)
    : canReference.value
      ? props.segment.referencePath
        ? mediaUrl(props.segment.referencePath)
        : `/api/segments/${props.segment.id}/original?t=${props.segment.start}-${props.segment.end}`
      : ''
)

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
    <header class="generation-panel-header">
      <h2>生成配音</h2>
      <UButton
        type="button"
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-carbon-close"
        aria-label="关闭配音窗口"
        @click="emit('close')"
      />
    </header>
    <VoiceParameters v-model="draft" :disabled="busy" :can-reference="canReference || !!customReference">
      <div v-if="draft.synthesisMode === 'ai'" class="voice-tone-bar">
        <div class="voice-tone-header">
          <span class="voice-tone-label">
            <UIcon name="i-carbon-microphone" class="mr-1" />
            角色语气：<strong :title="parsedPrompt.tone || '默认语气'">{{
              parsedPrompt.tone || '默认语气'
            }}</strong>
          </span>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-carbon-magic-wand"
            title="结合上下文对话流重新判断语气"
            @click="inferContextTone"
          >
            根据上下文判断
          </UButton>
        </div>
        <div class="voice-tone-tags">
          <UButton
            v-for="t in tonePresets"
            :key="t"
            type="button"
            size="xs"
            color="neutral"
            :variant="parsedPrompt.tone?.includes(t) ? 'soft' : 'outline'"
            :aria-pressed="!!parsedPrompt.tone?.includes(t)"
            :disabled="busy"
            @click="applyTone(t)"
          >
            {{ t }}
          </UButton>
        </div>
      </div>
      <UTextarea
        v-model="content"
        class="voice-composer-input w-full"
        variant="none"
        :aria-label="draft.synthesisMode === 'ai' ? '配音内容与提示词' : '配音台词'"
        :placeholder="
          draft.synthesisMode === 'ai'
            ? '【配音要求】：用中文配音…\n【角色语气】：轻松调侃…\n【配音台词】：「你好，欢迎回来。」'
            : '输入配音台词…'
        "
        :rows="5"
        :maxrows="10"
        autoresize
        :maxlength="2800"
        :disabled="busy"
        @keydown.meta.enter.prevent="generate"
        @keydown.ctrl.enter.prevent="generate"
      />
      <template #reference>
        <div
          v-if="draft.synthesisMode === 'ai' && draft.aiUseReference && referenceSrc"
          class="voice-reference-wrapper"
        >
          <AudioPlayer :src="referenceSrc" :label="referenceName" :duration="segment.end - segment.start">
            <template #leading>
              <div class="voice-reference-meta">
                <span class="voice-reference-title" :title="referenceName">{{ referenceName }}</span>
              </div>
            </template>
            <template #trailing>
              <UDropdownMenu :items="referenceChoices" :content="{ side: 'top', align: 'start' }">
                <UButton
                  type="button"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-carbon-chevron-down"
                  :disabled="busy"
                  aria-label="替换参考音色"
                  title="替换参考音色"
                />
              </UDropdownMenu>
              <UButton
                type="button"
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-carbon-close"
                :disabled="busy"
                aria-label="移除参考音频"
                title="移除参考音频"
                @click.stop="removeReference"
              />
            </template>
          </AudioPlayer>
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
.voice-reference-wrapper {
  margin: 0 12px 10px;
  max-width: calc(100% - 24px);
}
.voice-reference-wrapper .voice-reference-meta {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 140px;
}
.voice-reference-wrapper .voice-reference-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  padding: 0 4px;
}
</style>
