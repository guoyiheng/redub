<script setup lang="ts">
import { aiVoices } from '../../shared/ai-voices'
import type { VoiceSettings } from '../../shared/voice'

const props = defineProps<{ disabled?: boolean }>()
const draft = defineModel<VoiceSettings>({ required: true })
const open = ref(false)
const search = ref('')
const selectedLabel = computed(() => {
  if (draft.value.aiUseReference) return '在线音色'
  const speaker = draft.value.aiSpeaker?.trim()
  return aiVoices.find((voice) => voice.value === speaker)?.label || speaker || '自动音色'
})
const filteredVoices = computed(() => {
  const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return aiVoices.filter((voice) => {
    const text = [voice.label, voice.value, voice.language, voice.category].join(' ').toLocaleLowerCase()
    return terms.every((term) => text.includes(term))
  })
})
function selectVoice(speaker: string) {
  if (props.disabled) return
  draft.value.aiSpeaker = speaker
  draft.value.aiUseReference = false
  open.value = false
}
watch(open, () => {
  search.value = ''
})
watch(
  () => props.disabled,
  (value) => {
    if (value) open.value = false
  }
)
</script>

<template>
  <UPopover v-model:open="open" :content="{ side: 'top', align: 'start' }">
    <UButton
      type="button"
      aria-label="AI 音色"
      :title="selectedLabel"
      icon="i-carbon-microphone"
      trailing-icon="i-carbon-chevron-down"
      color="neutral"
      variant="outline"
      size="sm"
      class="max-w-44"
      :disabled="disabled"
    >
      <span class="truncate">{{ selectedLabel }}</span>
    </UButton>
    <template #content>
      <div class="w-80 max-w-[calc(100vw-2rem)] p-2" aria-label="AI 音色列表">
        <UInput
          v-model="search"
          autofocus
          icon="i-carbon-search"
          aria-label="搜索 AI 音色"
          placeholder="搜索名称、语言或音色 ID"
          class="mb-2 w-full"
          :disabled="disabled"
        />
        <div class="max-h-72 overflow-y-auto overscroll-contain" aria-label="可选音色">
          <UButton
            v-if="!search.trim()"
            type="button"
            color="neutral"
            :variant="!draft.aiUseReference && !draft.aiSpeaker?.trim() ? 'soft' : 'ghost'"
            :aria-pressed="!draft.aiUseReference && !draft.aiSpeaker?.trim()"
            :disabled="disabled"
            class="mb-1 w-full justify-start"
            @click="selectVoice('')"
            >自动音色</UButton
          >
          <UButton
            v-for="voice in filteredVoices"
            :key="voice.value"
            type="button"
            color="neutral"
            :variant="!draft.aiUseReference && draft.aiSpeaker?.trim() === voice.value ? 'soft' : 'ghost'"
            :aria-pressed="!draft.aiUseReference && draft.aiSpeaker?.trim() === voice.value"
            :disabled="disabled"
            :title="voice.value"
            class="my-0.5 w-full justify-start text-left"
            @click="selectVoice(voice.value)"
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate">{{ voice.label }}</span>
              <span class="text-muted block truncate text-xs font-normal" :title="voice.language">
                {{ voice.language }} · {{ voice.category }}
              </span>
              <span v-if="voice.note" class="text-muted block whitespace-normal text-xs font-normal">
                {{ voice.note }}
              </span>
            </span>
            <UIcon
              v-if="!draft.aiUseReference && draft.aiSpeaker?.trim() === voice.value"
              name="i-carbon-checkmark"
              class="size-4 shrink-0"
            />
          </UButton>
          <p v-if="!filteredVoices.length" role="status" class="text-muted px-3 py-6 text-center text-sm">
            没有找到匹配的音色
          </p>
        </div>
      </div>
    </template>
  </UPopover>
</template>
