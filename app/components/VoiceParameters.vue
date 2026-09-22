<script setup lang="ts">
import {
  defaultVoicePrompt,
  referenceVoicePrompt,
  naturalVoicePrompt,
  type VoiceSettings
} from '../../shared/voice'
defineProps<{ disabled?: boolean; canReference: boolean }>()
const draft = defineModel<VoiceSettings>({ required: true })
watch(
  () => draft.value.aiUseReference,
  (value) => {
    if (
      !draft.value.aiPrompt?.trim() ||
      [referenceVoicePrompt, naturalVoicePrompt].includes(draft.value.aiPrompt)
    )
      draft.value.aiPrompt = defaultVoicePrompt(value)
  }
)
const ttsVoices = [
  { label: '晓晓 · 中文女声', value: 'zh-CN-XiaoxiaoNeural' },
  { label: '云希 · 中文男声', value: 'zh-CN-YunxiNeural' },
  { label: '晓伊 · 中文女声', value: 'zh-CN-XiaoyiNeural' },
  { label: '云健 · 中文男声', value: 'zh-CN-YunjianNeural' },
  { label: 'Jenny · 英语女声', value: 'en-US-JennyNeural' },
  { label: 'Guy · 英语男声', value: 'en-US-GuyNeural' },
  { label: 'Nanami · 日语女声', value: 'ja-JP-NanamiNeural' },
  { label: 'SunHi · 韩语女声', value: 'ko-KR-SunHiNeural' },
  { label: 'Elvira · 西班牙语', value: 'es-ES-ElviraNeural' },
  { label: 'Denise · 法语', value: 'fr-FR-DeniseNeural' },
  { label: 'Katja · 德语', value: 'de-DE-KatjaNeural' },
  { label: 'Elsa · 意大利语', value: 'it-IT-ElsaNeural' },
  { label: 'Svetlana · 俄语', value: 'ru-RU-SvetlanaNeural' }
]

const isAuditionLoading = ref(false)
const isAuditionPlaying = ref(false)
let auditionAudio: HTMLAudioElement | null = null

function stopAudition() {
  if (auditionAudio) {
    auditionAudio.pause()
    auditionAudio = null
  }
  isAuditionPlaying.value = false
  isAuditionLoading.value = false
}

async function toggleAudition() {
  if (isAuditionPlaying.value || isAuditionLoading.value) {
    stopAudition()
    return
  }
  stopAudition()
  isAuditionLoading.value = true
  try {
    const res = await fetch('/api/tts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice: draft.value.ttsVoice,
        rate: `${draft.value.ttsRate >= 0 ? '+' : ''}${draft.value.ttsRate}%`,
        pitch: `${draft.value.ttsPitch >= 0 ? '+' : ''}${draft.value.ttsPitch}Hz`,
        volume: `${draft.value.ttsVolume >= 0 ? '+' : ''}${draft.value.ttsVolume}%`
      })
    })
    if (!res.ok) throw new Error('试听生成失败')
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    auditionAudio = audio
    audio.onended = () => {
      stopAudition()
      URL.revokeObjectURL(url)
    }
    audio.onerror = () => {
      stopAudition()
      URL.revokeObjectURL(url)
    }
    await audio.play()
    isAuditionPlaying.value = true
  } catch {
    stopAudition()
  } finally {
    isAuditionLoading.value = false
  }
}

watch(
  () => draft.value.ttsVoice,
  () => {
    stopAudition()
  }
)
watch(
  () => draft.value.synthesisMode,
  () => {
    stopAudition()
  }
)
onBeforeUnmount(() => {
  stopAudition()
})
</script>
<template>
  <div class="voice-composer" :class="{ 'is-disabled': disabled }">
    <slot>
      <UTextarea
        v-if="draft.synthesisMode === 'ai'"
        :model-value="draft.aiPrompt || ''"
        @update:model-value="draft.aiPrompt = $event"
        aria-label="配音提示词"
        class="voice-composer-input w-full"
        variant="none"
        :rows="3"
        autoresize
        :maxrows="7"
        :maxlength="3000"
        :disabled="disabled"
        placeholder="描述语气、音色和节奏…"
      />
    </slot>
    <slot name="reference" />
    <div class="voice-composer-footer">
      <div class="voice-composer-tools">
        <slot name="reference-control">
          <USelect
            v-if="draft.synthesisMode === 'ai'"
            v-model="draft.aiUseReference"
            aria-label="音色来源"
            icon="i-carbon-waveform"
            class="voice-source-select"
            color="neutral"
            variant="ghost"
            size="sm"
            :items="[
              { label: '原声参考', value: true, disabled: !canReference },
              { label: '指定音色', value: false }
            ]"
            :disabled="disabled"
          />
        </slot>
        <USelect
          v-model="draft.synthesisMode"
          aria-label="配音方式"
          class="voice-mode-select"
          :icon="draft.synthesisMode === 'ai' ? 'i-carbon-machine-learning-model' : 'i-carbon-volume-up'"
          color="neutral"
          variant="ghost"
          size="sm"
          :items="[
            { label: 'AI 配音', value: 'ai' },
            { label: '微软 TTS', value: 'tts' }
          ]"
          :disabled="disabled"
        />
        <USelect
          v-if="draft.synthesisMode === 'tts'"
          v-model="draft.ttsVoice"
          aria-label="微软声音"
          class="voice-tts-select"
          color="neutral"
          variant="ghost"
          size="sm"
          :items="ttsVoices"
          :disabled="disabled"
        />
        <UButton
          v-if="draft.synthesisMode === 'tts'"
          type="button"
          color="neutral"
          variant="ghost"
          size="sm"
          class="voice-tts-audition-btn"
          :icon="isAuditionPlaying ? 'i-carbon-stop-filled' : 'i-carbon-play-filled'"
          :loading="isAuditionLoading"
          aria-label="试听当前音色"
          :disabled="disabled"
          @click="toggleAudition"
        >
          {{ isAuditionPlaying ? '停止' : '试听' }}
        </UButton>
        <UPopover
          :content="{ side: 'top', align: 'start', sideOffset: 12 }"
          :ui="{ content: 'voice-options-popover' }"
        >
          <UButton
            type="button"
            icon="i-carbon-settings-adjust"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="更多配音参数"
            :disabled="disabled"
            >参数</UButton
          >
          <template #content>
            <div class="voice-options">
              <h3>配音参数</h3>
              <template v-if="draft.synthesisMode === 'ai'">
                <UFormField v-if="!draft.aiUseReference" label="音色 ID">
                  <UInput
                    :model-value="draft.aiSpeaker || ''"
                    @update:model-value="draft.aiSpeaker = $event"
                    class="w-full"
                    placeholder="可选，留空由 AI 选择"
                    :disabled="disabled"
                  />
                </UFormField>
                <div class="voice-options-row voice-options-pair">
                  <UFormField label="格式"
                    ><USelect
                      v-model="draft.aiFormat"
                      class="w-full"
                      :items="['mp3', 'wav']"
                      :disabled="disabled"
                  /></UFormField>
                  <UFormField label="采样率"
                    ><USelect
                      v-model="draft.aiSampleRate"
                      class="w-full"
                      :items="[8000, 16000, 24000, 32000, 40000, 44100, 48000]"
                      :disabled="disabled"
                  /></UFormField>
                </div>
                <div class="voice-options-row">
                  <UFormField label="语速 (%)"
                    ><UInput
                      v-model.number="draft.aiSpeechRate"
                      class="w-full"
                      type="number"
                      min="-50"
                      max="100"
                      :disabled="disabled"
                  /></UFormField>
                  <UFormField label="音调"
                    ><UInput
                      v-model.number="draft.aiPitchRate"
                      class="w-full"
                      type="number"
                      min="-12"
                      max="12"
                      :disabled="disabled"
                  /></UFormField>
                  <UFormField label="音量 (%)"
                    ><UInput
                      v-model.number="draft.aiLoudnessRate"
                      class="w-full"
                      type="number"
                      min="-50"
                      max="100"
                      :disabled="disabled"
                  /></UFormField>
                </div>
              </template>
              <div v-else class="voice-options-row">
                <UFormField label="语速 (%)"
                  ><UInput
                    v-model.number="draft.ttsRate"
                    class="w-full"
                    type="number"
                    min="-50"
                    max="100"
                    :disabled="disabled"
                /></UFormField>
                <UFormField label="音调 (Hz)"
                  ><UInput
                    v-model.number="draft.ttsPitch"
                    class="w-full"
                    type="number"
                    min="-50"
                    max="50"
                    :disabled="disabled"
                /></UFormField>
                <UFormField label="音量 (%)"
                  ><UInput
                    v-model.number="draft.ttsVolume"
                    class="w-full"
                    type="number"
                    min="-50"
                    max="100"
                    :disabled="disabled"
                /></UFormField>
              </div>
            </div>
          </template>
        </UPopover>
      </div>
      <slot name="actions" />
    </div>
  </div>
</template>
