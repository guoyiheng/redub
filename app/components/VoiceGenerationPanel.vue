<script setup lang="ts">
import { voiceSettingsSchema, naturalVoicePrompt, referenceVoicePrompt, dubbedText } from '../../shared/voice'
import type { Segment } from '../../shared/types'
const props = defineProps<{ segment: Segment }>()
const emit = defineEmits<{ close: []; generated: [] }>()
const { act, channels, detail, toast, errorMessage } = useStudio()
const canReference = computed(
  () => !!detail.value?.project.vocalsPath && detail.value?.project.kind !== 'text'
)
const customReference = ref(props.segment.customReferencePath || null)
const referenceName = ref(customReference.value ? '自定义参考' : '原声参考')
const draft = ref(
  voiceSettingsSchema.parse({
    ...props.segment,
    aiUseReference: props.segment.aiUseReference && (canReference.value || !!customReference.value)
  })
)
const originalText = (props.segment.translation || props.segment.text || '').trim()
const direction =
  !props.segment.aiPrompt?.trim() || props.segment.aiPrompt === referenceVoicePrompt
    ? naturalVoicePrompt
    : props.segment.aiPrompt.trim()
const aiContent = ref(props.segment.generationPrompt || `${direction}\n朗读：「${originalText}」`)
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
  if (!content.value.trim()) return '请输入配音内容'
  if (
    draft.value.synthesisMode === 'ai' &&
    !channels.value.some((c) => c.id === detail.value?.project.channelId && c.enabled && c.configured)
  )
    return 'AI 渠道尚未配置'
  return ''
})
function removeReference() {
  draft.value.aiUseReference = false
  customReference.value = null
  referenceName.value = '原声参考'
  referenceOpen.value = false
}
function useOriginal() {
  customReference.value = null
  referenceName.value = '原声参考'
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
    referenceName.value = result.name
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
  <form class="generation-panel" @submit.prevent="generate">
    <header class="generation-composer-header">
      <div class="generation-composer-title">
        <span>生成配音</span><time>{{ formatTime(segment.start) }} – {{ formatTime(segment.end) }}</time>
      </div>
      <UButton
        type="button"
        icon="i-carbon-close"
        color="neutral"
        variant="ghost"
        size="sm"
        square
        :disabled="busy"
        aria-label="关闭配音弹窗"
        @click="emit('close')"
      />
    </header>
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
        <div v-if="draft.synthesisMode === 'ai' && draft.aiUseReference" class="voice-attachment">
          <UIcon name="i-carbon-waveform" />
          <span :title="referenceName">{{ referenceName }}</span>
          <UPopover :content="{ side: 'top', align: 'start' }">
            <UButton
              type="button"
              color="neutral"
              variant="ghost"
              icon="i-carbon-play"
              square
              size="xs"
              aria-label="试听参考音频"
            />
            <template #content
              ><div class="voice-reference-preview"><ClipAudio :src="referenceSrc" label="参考音频" /></div
            ></template>
          </UPopover>
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            size="xs"
            :disabled="busy"
            @click="picker?.click()"
            >替换</UButton
          >
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-carbon-close"
            square
            :disabled="busy"
            aria-label="移除参考音频"
            @click="removeReference"
          />
        </div>
      </template>
      <template #reference-control>
        <UPopover
          v-if="draft.synthesisMode === 'ai'"
          v-model:open="referenceOpen"
          :content="{ side: 'top', align: 'start' }"
        >
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-carbon-add"
            square
            :disabled="busy"
            :loading="uploading"
            aria-label="添加参考音频"
          />
          <template #content>
            <div class="voice-reference-menu">
              <UButton
                v-if="canReference"
                type="button"
                color="neutral"
                variant="ghost"
                icon="i-carbon-waveform"
                @click="useOriginal"
                >使用本句原声</UButton
              >
              <UButton
                type="button"
                color="neutral"
                variant="ghost"
                icon="i-carbon-upload"
                @click="picker?.click()"
                >上传参考音频</UButton
              >
              <p>30 秒以内，最大 10 MB</p>
            </div>
          </template>
        </UPopover>
      </template>
      <template #actions>
        <StudioAction
          class="voice-submit-wrap"
          type="submit"
          color="neutral"
          icon="i-carbon-arrow-up"
          square
          :aria-label="submitLabel"
          :reason="unavailableReason"
          :loading="saving"
          :ui="{ base: 'voice-submit' }"
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
