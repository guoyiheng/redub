<script setup lang="ts">
import { voiceSettingsSchema } from '../../shared/voice'
import type { Segment } from '../../shared/types'
const props = defineProps<{ segment: Segment; locked: boolean }>()
const emit = defineEmits<{ close: []; generated: [] }>()
const { act, channels, detail } = useStudio()
const draft = ref(
  voiceSettingsSchema.parse({
    ...props.segment,
    aiUseReference: props.segment.aiUseReference && !!props.segment.referencePath
  })
)
const saving = ref(false)
const unavailableReason = computed(() => {
  if (saving.value) return '正在提交配音任务'
  if (props.locked) return '任务执行中，完成后可生成'
  if (!props.segment.enabled) return '请先开启替换此片段'
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
      await $fetch(`/api/segments/${props.segment.id}`, {
        method: 'PATCH',
        body: { ...props.segment, ...draft.value }
      })
      await $fetch(`/api/projects/${props.segment.projectId}/run`, {
        method: 'POST',
        body: { stage: 'synthesize', segmentId: props.segment.id }
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
      :disabled="locked || saving"
      :reference-path="segment.referencePath"
      :can-reference="!!segment.referencePath"
    />
    <div class="generation-actions">
      <StudioAction
        color="neutral"
        variant="ghost"
        :reason="saving ? '正在提交配音任务' : ''"
        @click="emit('close')"
        >取消</StudioAction
      >
      <StudioAction type="submit" icon="i-carbon-arrow-up" :reason="unavailableReason" :loading="saving"
        >生成配音</StudioAction
      >
    </div>
  </form>
</template>
