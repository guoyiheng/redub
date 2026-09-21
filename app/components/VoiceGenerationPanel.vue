<script setup lang="ts">
import type { Segment } from '../../shared/types'
const props = defineProps<{ segment: Segment; locked: boolean }>()
const emit = defineEmits<{ close: []; generated: [] }>()
const { act } = useStudio()
const draft = ref({
  ...props.segment,
  aiUseReference: props.segment.aiUseReference && !!props.segment.referencePath,
  aiPrompt: props.segment.aiPrompt || '',
  aiSpeaker: props.segment.aiSpeaker || ''
})
const saving = ref(false)
const unavailableReason = computed(() => {
  if (saving.value) return '正在提交配音任务'
  if (props.locked) return '任务执行中，完成后可生成'
  if (!props.segment.enabled) return '请先开启替换此片段'
  if (!(props.segment.translation || props.segment.text).trim()) return '请先填写台词'
  return ''
})
const ttsVoices = [
  { label: '晓晓（中文女声）', value: 'zh-CN-XiaoxiaoNeural' },
  { label: '云希（中文男声）', value: 'zh-CN-YunxiNeural' },
  { label: '晓伊（中文女声）', value: 'zh-CN-XiaoyiNeural' },
  { label: '云健（中文男声）', value: 'zh-CN-YunjianNeural' },
  { label: 'Jenny（英语女声）', value: 'en-US-JennyNeural' },
  { label: 'Guy（英语男声）', value: 'en-US-GuyNeural' }
]
async function generate() {
  if (unavailableReason.value) return
  saving.value = true
  try {
    const ok = await act(async () => {
      await $fetch(`/api/segments/${draft.value.id}`, { method: 'PATCH', body: draft.value })
      await $fetch(`/api/projects/${draft.value.projectId}/run`, {
        method: 'POST',
        body: { stage: 'synthesize', segmentId: draft.value.id }
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
    <div class="generation-intro">
      <USelect
        v-model="draft.synthesisMode"
        aria-label="配音方式"
        variant="ghost"
        :items="[
          { label: 'AI 配音 · Seed Audio', value: 'ai' },
          { label: '微软 TTS', value: 'tts' }
        ]"
        :disabled="locked || saving"
      />
      <UButton
        aria-label="关闭生成设置"
        icon="i-carbon-close"
        color="neutral"
        variant="ghost"
        :disabled="saving"
        @click="emit('close')"
      />
    </div>
    <template v-if="draft.synthesisMode === 'ai'">
      <UTextarea
        v-model="draft.aiPrompt"
        aria-label="配音提示词"
        class="generation-prompt w-full"
        variant="none"
        :rows="2"
        :maxlength="3000"
        :disabled="locked || saving"
        placeholder="描述语气、情绪和说话方式（可选）"
      />
      <div class="generation-voice-row">
        <USelect
          v-model="draft.aiUseReference"
          aria-label="音色来源"
          :items="[
            { label: '原声参考', value: true, disabled: !draft.referencePath },
            { label: '指定音色', value: false }
          ]"
          :disabled="locked || saving"
        />
        <audio
          v-if="draft.aiUseReference && draft.referencePath"
          :src="mediaUrl(draft.referencePath)"
          aria-label="参考音频"
          controls
          preload="none"
        />
        <span v-else-if="draft.aiUseReference" class="help">暂无参考音频，请选择指定音色</span>
        <UInput
          v-else
          v-model="draft.aiSpeaker"
          aria-label="音色 ID"
          class="grow"
          :disabled="locked || saving"
          placeholder="音色 ID（可选）"
        />
      </div>
      <details class="advanced-options">
        <summary>更多参数</summary>
        <div class="generation-parameters">
          <UFormField label="格式"
            ><USelect
              v-model="draft.aiFormat"
              class="w-full"
              :items="['mp3', 'wav']"
              :disabled="locked || saving" /></UFormField
          ><UFormField label="采样率"
            ><USelect
              v-model="draft.aiSampleRate"
              class="w-full"
              :items="[8000, 16000, 24000, 32000, 40000, 44100, 48000]"
              :disabled="locked || saving" /></UFormField
          ><UFormField label="音调（-12 ～ 12）"
            ><UInput
              v-model.number="draft.aiPitchRate"
              class="w-full"
              type="number"
              min="-12"
              max="12"
              :disabled="locked || saving" /></UFormField
          ><UFormField label="语速（-50 ～ 100）"
            ><UInput
              v-model.number="draft.aiSpeechRate"
              class="w-full"
              type="number"
              min="-50"
              max="100"
              :disabled="locked || saving" /></UFormField
          ><UFormField label="音量（-50 ～ 100）"
            ><UInput
              v-model.number="draft.aiLoudnessRate"
              class="w-full"
              type="number"
              min="-50"
              max="100"
              :disabled="locked || saving"
          /></UFormField>
        </div>
      </details>
    </template>
    <template v-else
      ><UFormField label="微软声音"
        ><USelect v-model="draft.ttsVoice" class="w-full" :items="ttsVoices" :disabled="locked || saving"
      /></UFormField>
      <div class="generation-parameters">
        <UFormField label="语速（-50 ～ 100）"
          ><UInput
            v-model.number="draft.ttsRate"
            class="w-full"
            type="number"
            min="-50"
            max="100"
            :disabled="locked || saving" /></UFormField
        ><UFormField label="音调（-50 ～ 50 Hz）"
          ><UInput
            v-model.number="draft.ttsPitch"
            class="w-full"
            type="number"
            min="-50"
            max="50"
            :disabled="locked || saving" /></UFormField
        ><UFormField label="音量（-50 ～ 100）"
          ><UInput
            v-model.number="draft.ttsVolume"
            class="w-full"
            type="number"
            min="-50"
            max="100"
            :disabled="locked || saving"
        /></UFormField>
      </div>
    </template>
    <div class="generation-actions">
      <UButton color="neutral" variant="ghost" :disabled="saving" @click="emit('close')">取消</UButton>
      <UTooltip :text="unavailableReason" :disabled="!unavailableReason">
        <span tabindex="0" :aria-label="unavailableReason || '生成配音'">
          <UButton type="submit" icon="i-carbon-arrow-up" :loading="saving" :disabled="!!unavailableReason"
            >生成配音</UButton
          >
        </span>
      </UTooltip>
    </div>
  </form>
</template>
