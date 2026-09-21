<script setup lang="ts">
import { voiceSettingsSchema, defaultVoicePrompt } from '../../shared/voice'
import type { Segment } from '../../shared/types'
const props = defineProps<{ segment: Segment }>()
const emit = defineEmits<{ close: []; generated: [] }>()
const { act, channels, detail } = useStudio()
const canReference = computed(
  () => !!detail.value?.project.vocalsPath && detail.value?.project.kind !== 'text'
)
const draft = ref(
  voiceSettingsSchema.parse({
    ...props.segment,
    aiUseReference: props.segment.aiUseReference && canReference.value,
    aiPrompt:
      props.segment.aiPrompt?.trim() || defaultVoicePrompt(props.segment.aiUseReference && canReference.value)
  })
)
const saving = ref(false)
const lineText = computed(() => (props.segment.translation || props.segment.text || '').trim())
const submitLabel = computed(() => (props.segment.enabled ? '生成本句配音' : '生成并启用替换'))
const unavailableReason = computed(() => {
  if (saving.value) return '正在提交配音任务'
  if (!(props.segment.translation || props.segment.text).trim()) return '请先填写台词'
  if (
    draft.value.synthesisMode === 'ai' &&
    !channels.value.some((c) => c.id === detail.value?.project.channelId && c.enabled && c.configured)
  )
    return '请在设置中配置 AI 配音渠道和密钥，或切换到微软 TTS'
  return ''
})

async function generate() {
  if (unavailableReason.value) return
  saving.value = true
  try {
    const ok = await act(async () => {
      await $fetch(`/api/segments/${props.segment.id}/generate`, {
        method: 'POST',
        body: draft.value
      })
    }, '配音已加入队列')
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
        <span>生成配音</span>
        <p :title="lineText">{{ lineText || '当前台词为空' }}</p>
      </div>
      <UButton
        type="button"
        icon="i-carbon-close"
        color="neutral"
        variant="ghost"
        square
        :disabled="saving"
        aria-label="关闭配音弹窗"
        @click="emit('close')"
      />
    </header>
    <VoiceParameters
      v-model="draft"
      :disabled="saving"
      :reference-path="segment.referencePath"
      :can-reference="canReference"
    >
      <template #actions>
        <div class="generation-toolbar-actions">
          <UTooltip :text="unavailableReason || submitLabel">
            <UButton
              class="generation-submit"
              type="submit"
              color="neutral"
              icon="i-carbon-arrow-up"
              square
              :aria-label="submitLabel"
              :disabled="!!unavailableReason"
              :loading="saving"
            />
          </UTooltip>
        </div>
      </template>
    </VoiceParameters>
    <div v-if="unavailableReason && !saving" class="generation-feedback" role="status">
      <span>{{ unavailableReason }}</span>
      <UButton
        v-if="
          draft.synthesisMode === 'ai' &&
          channels.every((c) => c.id !== detail?.project.channelId || !c.enabled || !c.configured)
        "
        size="xs"
        type="button"
        color="neutral"
        variant="soft"
        @click="draft.synthesisMode = 'tts'"
        >改用免费 TTS</UButton
      >
    </div>
  </form>
</template>
