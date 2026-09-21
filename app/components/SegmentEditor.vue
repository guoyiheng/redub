<script setup lang="ts">
import type { Segment } from '../../shared/types'
const props = defineProps<{ segment: Segment; locked: boolean }>()
const emit = defineEmits<{ dirty: [value: boolean] }>()
const { act } = useStudio()
const draft = ref({
    ...props.segment,
    aiPrompt: props.segment.aiPrompt || '',
    aiSpeaker: props.segment.aiSpeaker || ''
  }),
  dirty = ref(false),
  saving = ref(false)
const ttsVoices = [
  { label: '晓晓（中文女声）', value: 'zh-CN-XiaoxiaoNeural' },
  { label: '云希（中文男声）', value: 'zh-CN-YunxiNeural' },
  { label: '晓伊（中文女声）', value: 'zh-CN-XiaoyiNeural' },
  { label: '云健（中文男声）', value: 'zh-CN-YunjianNeural' },
  { label: 'Jenny（英语女声）', value: 'en-US-JennyNeural' },
  { label: 'Guy（英语男声）', value: 'en-US-GuyNeural' }
]
watch(
  () => props.segment,
  (value) => {
    if (!dirty.value || draft.value.id !== value.id) {
      draft.value = { ...value, aiPrompt: value.aiPrompt || '', aiSpeaker: value.aiSpeaker || '' }
      dirty.value = false
    }
  },
  { deep: true }
)
watch(dirty, (value) => emit('dirty', value))
function changed() {
  dirty.value = true
}
async function save() {
  saving.value = true
  if (
    await act(
      () => $fetch(`/api/segments/${draft.value.id}`, { method: 'PATCH', body: draft.value }),
      '片段已保存'
    )
  )
    dirty.value = false
  saving.value = false
}
async function synthesize() {
  if (dirty.value) {
    await save()
    if (dirty.value) return
  }
  await act(
    () =>
      $fetch(`/api/projects/${draft.value.projectId}/run`, {
        method: 'POST',
        body: { stage: 'synthesize', segmentId: draft.value.id }
      }),
    '配音已加入队列'
  )
}
</script>
<template>
  <div class="segment-editor">
    <div class="editor-top">
      <div>
        <h3>片段编辑</h3>
        <span v-if="dirty" class="help">未保存</span>
      </div>
      <UCheckbox
        v-model="draft.enabled"
        label="替换此片段"
        :disabled="locked"
        @update:model-value="changed"
      />
    </div>
    <div class="time-fields">
      <UFormField label="开始（秒）"
        ><UInput
          class="w-full"
          v-model.number="draft.start"
          type="number"
          min="0"
          step="0.01"
          :disabled="locked"
          @update:model-value="changed" /></UFormField
      ><UFormField label="结束（秒）"
        ><UInput
          class="w-full"
          v-model.number="draft.end"
          type="number"
          min="0"
          step="0.01"
          :disabled="locked"
          @update:model-value="changed" /></UFormField
      ><UFormField label="角色"
        ><UInput class="w-full" v-model="draft.speaker" :disabled="locked" @update:model-value="changed"
      /></UFormField>
    </div>
    <UFormField label="原文"
      ><UTextarea
        v-model="draft.text"
        class="w-full"
        :rows="2"
        :disabled="locked"
        placeholder="输入原文"
        @update:model-value="changed"
    /></UFormField>
    <UFormField label="译文 / 替换台词"
      ><UTextarea
        v-model="draft.translation"
        class="w-full"
        :rows="3"
        :disabled="locked"
        placeholder="填写希望说出的内容；留空时使用原文"
        @update:model-value="changed"
    /></UFormField>
    <section class="voice-settings">
      <div class="voice-settings-heading">
        <div>
          <h4>配音方式</h4>
          <p class="help">每个片段可以单独选择生成方式。</p>
        </div>
        <USelect
          v-model="draft.synthesisMode"
          :items="[
            { label: 'AI 配音 · Seed Audio', value: 'ai' },
            { label: '微软免费 TTS', value: 'tts' }
          ]"
          :disabled="locked"
          @update:model-value="changed"
        />
      </div>
      <template v-if="draft.synthesisMode === 'ai'">
        <UFormField label="Seed Audio 提示词" description="可描述语气、情绪和时长；最多 3000 字。"
          ><UTextarea
            v-model="draft.aiPrompt"
            class="w-full"
            :rows="3"
            :disabled="locked"
            placeholder="例如：轻声、克制地说，结尾略带疑问。"
            @update:model-value="changed"
        /></UFormField>
        <div class="form-grid">
          <UFormField label="音色 ID" description="与参考音频互斥，二选一。"
            ><UInput
              v-model="draft.aiSpeaker"
              class="w-full"
              placeholder="例如：zh_male_shenyeboduo_moon_bigtts"
              :disabled="locked || draft.aiUseReference"
              @update:model-value="changed" /></UFormField
          ><UFormField label="参考音频"
            ><UCheckbox
              v-model="draft.aiUseReference"
              label="使用本句原声参考"
              :disabled="locked || !draft.referencePath"
              @update:model-value="changed"
          /></UFormField>
        </div>
        <div v-if="draft.referencePath" class="reference-audio">
          <p class="help">参考音频（≤ 30 秒，≤ 10 MB）</p>
          <audio :src="mediaUrl(draft.referencePath)" controls preload="none" />
        </div>
        <details class="advanced-options" open>
          <summary>Seed Audio 参数</summary>
          <div class="form-grid">
            <UFormField label="输出格式"
              ><USelect
                v-model="draft.aiFormat"
                class="w-full"
                :items="['mp3', 'wav']"
                :disabled="locked"
                @update:model-value="changed" /></UFormField
            ><UFormField label="采样率"
              ><USelect
                v-model="draft.aiSampleRate"
                class="w-full"
                :items="[8000, 16000, 24000, 32000, 40000, 44100, 48000]"
                :disabled="locked"
                @update:model-value="changed" /></UFormField
            ><UFormField label="音调（-12 ～ 12）"
              ><UInput
                v-model.number="draft.aiPitchRate"
                class="w-full"
                type="number"
                min="-12"
                max="12"
                :disabled="locked"
                @update:model-value="changed" /></UFormField
            ><UFormField label="语速（-50 ～ 100）"
              ><UInput
                v-model.number="draft.aiSpeechRate"
                class="w-full"
                type="number"
                min="-50"
                max="100"
                :disabled="locked"
                @update:model-value="changed" /></UFormField
            ><UFormField label="音量（-50 ～ 100）"
              ><UInput
                v-model.number="draft.aiLoudnessRate"
                class="w-full"
                type="number"
                min="-50"
                max="100"
                :disabled="locked"
                @update:model-value="changed"
            /></UFormField>
          </div>
        </details>
      </template>
      <template v-else>
        <UFormField label="微软声音"
          ><USelect
            v-model="draft.ttsVoice"
            class="w-full"
            :items="ttsVoices"
            :disabled="locked"
            @update:model-value="changed"
        /></UFormField>
        <details class="advanced-options" open>
          <summary>微软 TTS 参数</summary>
          <div class="form-grid">
            <UFormField label="语速（-50 ～ 100）"
              ><UInput
                v-model.number="draft.ttsRate"
                class="w-full"
                type="number"
                min="-50"
                max="100"
                :disabled="locked"
                @update:model-value="changed" /></UFormField
            ><UFormField label="音调（-50 ～ 50 Hz）"
              ><UInput
                v-model.number="draft.ttsPitch"
                class="w-full"
                type="number"
                min="-50"
                max="50"
                :disabled="locked"
                @update:model-value="changed" /></UFormField
            ><UFormField label="音量（-50 ～ 100）"
              ><UInput
                v-model.number="draft.ttsVolume"
                class="w-full"
                type="number"
                min="-50"
                max="100"
                :disabled="locked"
                @update:model-value="changed"
            /></UFormField>
          </div>
        </details>
        <p class="help">微软 Edge 在线语音无需 API Key，需要网络连接。</p>
      </template>
    </section>
    <div v-if="segment.generatedPath" class="generated-audio">
      <p class="help">生成配音 · {{ segment.generatedDuration?.toFixed(1) }} 秒</p>
      <audio :src="mediaUrl(segment.generatedPath)" controls preload="none" />
    </div>
    <div class="editor-actions">
      <UButton
        color="neutral"
        variant="outline"
        :disabled="!dirty || locked"
        :loading="saving"
        icon="i-carbon-save"
        @click="save"
        >保存参数</UButton
      ><UButton :disabled="locked || !draft.enabled" icon="i-carbon-microphone" @click="synthesize">{{
        segment.generatedPath ? '重新生成' : '生成配音'
      }}</UButton>
    </div>
  </div>
</template>
