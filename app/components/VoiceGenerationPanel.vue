<script setup lang="ts">
import { voiceSettingsSchema, defaultVoicePrompt } from '../../shared/voice'
import type { Segment } from '../../shared/types'
const props = defineProps<{ segment: Segment; blockedReason?: string }>()
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
const unavailableReason = computed(() => {
  if (saving.value) return '正在提交配音任务'
  if (props.blockedReason) return props.blockedReason
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
    <VoiceParameters
      v-model="draft"
      :disabled="saving"
      :reference-path="segment.referencePath"
      :can-reference="canReference"
    />
    <div v-if="unavailableReason && !saving" class="generation-feedback" role="status">
      <span>{{ unavailableReason }}</span>
      <UButton
        v-if="
          draft.synthesisMode === 'ai' &&
          !blockedReason &&
          channels.every((c) => c.id !== detail?.project.channelId || !c.enabled || !c.configured)
        "
        size="xs"
        color="neutral"
        variant="soft"
        @click="draft.synthesisMode = 'tts'"
        >改用免费 TTS</UButton
      >
    </div>
    <div class="generation-actions">
      <span class="help generation-cost">{{
        draft.synthesisMode === 'ai' ? '仅生成本句 · 使用 AI 接口额度' : '仅生成本句 · 微软免费 TTS'
      }}</span>
      <StudioAction
        color="neutral"
        variant="ghost"
        :reason="saving ? '正在提交配音任务' : ''"
        @click="emit('close')"
        >取消</StudioAction
      >
      <StudioAction type="submit" icon="i-carbon-arrow-up" :reason="unavailableReason" :loading="saving">{{
        segment.enabled ? '生成本句配音' : '生成并启用替换'
      }}</StudioAction>
    </div>
  </form>
</template>
