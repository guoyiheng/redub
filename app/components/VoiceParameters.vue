<script setup lang="ts">
import {
  defaultVoicePrompt,
  referenceVoicePrompt,
  naturalVoicePrompt,
  type VoiceSettings
} from '../../shared/voice'
defineProps<{ disabled?: boolean; referencePath?: string | null; canReference: boolean }>()
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
  { label: '晓晓（中文女声）', value: 'zh-CN-XiaoxiaoNeural' },
  { label: '云希（中文男声）', value: 'zh-CN-YunxiNeural' },
  { label: '晓伊（中文女声）', value: 'zh-CN-XiaoyiNeural' },
  { label: '云健（中文男声）', value: 'zh-CN-YunjianNeural' },
  { label: 'Jenny（英语女声）', value: 'en-US-JennyNeural' },
  { label: 'Guy（英语男声）', value: 'en-US-GuyNeural' },
  { label: 'Nanami（日语女声）', value: 'ja-JP-NanamiNeural' },
  { label: 'SunHi（韩语女声）', value: 'ko-KR-SunHiNeural' },
  { label: 'Elvira（西班牙语女声）', value: 'es-ES-ElviraNeural' },
  { label: 'Denise（法语女声）', value: 'fr-FR-DeniseNeural' },
  { label: 'Katja（德语女声）', value: 'de-DE-KatjaNeural' },
  { label: 'Elsa（意大利语女声）', value: 'it-IT-ElsaNeural' },
  { label: 'Svetlana（俄语女声）', value: 'ru-RU-SvetlanaNeural' }
]
</script>
<template>
  <div class="voice-parameters">
    <div class="generation-intro">
      <USelect
        v-model="draft.synthesisMode"
        aria-label="配音方式"
        variant="ghost"
        :items="[
          { label: 'AI 配音 · Seed Audio', value: 'ai' },
          { label: '微软 TTS', value: 'tts' }
        ]"
        :disabled="disabled"
      />
    </div>
    <template v-if="draft.synthesisMode === 'ai'">
      <UFormField label="配音要求"
        ><UTextarea
          :model-value="draft.aiPrompt || ''"
          @update:model-value="draft.aiPrompt = $event"
          aria-label="配音提示词"
          class="generation-prompt w-full"
          variant="none"
          :rows="2"
          :maxlength="3000"
          :disabled="disabled"
          placeholder="描述希望保留或调整的音色、语气和节奏"
      /></UFormField>
      <div class="generation-voice-row">
        <USelect
          v-model="draft.aiUseReference"
          aria-label="音色来源"
          :items="[
            { label: '原声参考', value: true, disabled: !canReference },
            { label: '指定音色', value: false }
          ]"
          :disabled="disabled"
        />
        <audio
          v-if="draft.aiUseReference && referencePath"
          :src="mediaUrl(referencePath)"
          aria-label="参考音频"
          controls
          preload="none"
        />
        <span v-else-if="draft.aiUseReference" class="help">使用每句台词对应的原声参考</span>
        <UInput
          v-else
          :model-value="draft.aiSpeaker || ''"
          @update:model-value="draft.aiSpeaker = $event"
          aria-label="音色 ID"
          class="grow"
          :disabled="disabled"
          placeholder="音色 ID（可选）"
        />
      </div>
      <details class="advanced-options">
        <summary>更多参数</summary>
        <div class="generation-parameters">
          <UFormField label="音频格式"
            ><USelect
              v-model="draft.aiFormat"
              class="w-full"
              :items="['mp3', 'wav']"
              :disabled="disabled" /></UFormField
          ><UFormField label="采样率（Hz）"
            ><USelect
              v-model="draft.aiSampleRate"
              class="w-full"
              :items="[8000, 16000, 24000, 32000, 40000, 44100, 48000]"
              :disabled="disabled" /></UFormField
          ><UFormField label="音调（半音）" description="0 为原始音高，范围 −12～12"
            ><UInput
              v-model.number="draft.aiPitchRate"
              class="w-full"
              type="number"
              min="-12"
              max="12"
              :disabled="disabled" /></UFormField
          ><UFormField label="语速（%）" description="0 为默认，负值减慢"
            ><UInput
              v-model.number="draft.aiSpeechRate"
              class="w-full"
              type="number"
              min="-50"
              max="100"
              :disabled="disabled" /></UFormField
          ><UFormField label="音量（%）" description="0 为默认，负值减小"
            ><UInput
              v-model.number="draft.aiLoudnessRate"
              class="w-full"
              type="number"
              min="-50"
              max="100"
              :disabled="disabled"
          /></UFormField>
        </div>
      </details>
    </template>
    <template v-else
      ><UFormField label="微软声音"
        ><USelect v-model="draft.ttsVoice" class="w-full" :items="ttsVoices" :disabled="disabled"
      /></UFormField>
      <div class="generation-parameters">
        <UFormField label="语速（%）" description="0 为默认，负值减慢"
          ><UInput
            v-model.number="draft.ttsRate"
            class="w-full"
            type="number"
            min="-50"
            max="100"
            :disabled="disabled" /></UFormField
        ><UFormField label="音调（Hz）" description="0 为默认，范围 −50～50"
          ><UInput
            v-model.number="draft.ttsPitch"
            class="w-full"
            type="number"
            min="-50"
            max="50"
            :disabled="disabled" /></UFormField
        ><UFormField label="音量（%）" description="0 为默认，负值减小"
          ><UInput
            v-model.number="draft.ttsVolume"
            class="w-full"
            type="number"
            min="-50"
            max="100"
            :disabled="disabled"
        /></UFormField>
      </div>
    </template>
  </div>
</template>
