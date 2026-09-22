<script setup lang="ts">
import { segmentTaskReason } from '../../shared/job-policy'
import { languageOptions } from '../../shared/languages'
import {
  defaultTranslationDirection,
  composeTranslationPrompt,
  parseTranslationPrompt
} from '../../shared/translation'
import type { Segment } from '../../shared/types'

const props = defineProps<{ segment: Segment; segmentIndex?: number }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const { channels, detail, toast, errorMessage, refresh } = useStudio()

const project = computed(() => detail.value?.project)
const sourceLanguage = ref(project.value?.sourceLanguage || 'auto')
const targetLanguage = ref(props.segment.translationLanguage || project.value?.targetLanguage || '中文')

const activeChannel = computed(() => channels.value.find((c) => c.type === 'openai' && c.enabled))

const initialDirection = defaultTranslationDirection(targetLanguage.value)
const content = ref(composeTranslationPrompt(initialDirection, props.segment.text || ''))

// 当在下拉框切换目标语言时，若提示词开头保持默认模式，则自动同步语言名称
watch(targetLanguage, (newLang, oldLang) => {
  if (!oldLang || newLang === oldLang) return
  const regex = /^翻译为([^，,\n]+)[，,]/
  if (regex.test(content.value)) {
    content.value = content.value.replace(regex, `翻译为${newLang}，`)
  }
})

const translating = ref(false)
const busy = computed(() => translating.value)

const unavailableReason = computed(() => {
  if (busy.value) return '正在提交翻译任务…'
  const reason = segmentTaskReason(detail.value?.jobs || [], props.segment.id)
  if (reason) return reason
  const parsed = parseTranslationPrompt(content.value, props.segment.text)
  if (!parsed.text.trim()) return '请输入要翻译的原台词'
  if (!activeChannel.value?.configured) return '请在设置中启用并配置翻译渠道'
  return ''
})

const sourceLangItems = [
  { label: '自动检测', value: 'auto' },
  { label: '中文', value: 'zh' },
  { label: '英语', value: 'en' },
  { label: '日语', value: 'ja' },
  { label: '韩语', value: 'ko' },
  { label: '西班牙语', value: 'es' },
  { label: '法语', value: 'fr' },
  { label: '德语', value: 'de' },
  { label: '俄语', value: 'ru' }
]

async function translate() {
  if (unavailableReason.value) return
  translating.value = true
  try {
    const { text, prompt } = parseTranslationPrompt(content.value, props.segment.text)

    await $fetch(`/api/segments/${props.segment.id}/translate`, {
      method: 'POST',
      body: {
        sourceLanguage: sourceLanguage.value,
        targetLanguage: targetLanguage.value,
        text,
        prompt
      }
    })
    await refresh()
    toast.add({ id: 'translate-success', title: '翻译已加入队列', color: 'success' })
    emit('saved')
  } catch (err) {
    toast.add({
      id: 'translate-error',
      title: '翻译失败',
      description: errorMessage(err),
      color: 'error'
    })
  } finally {
    translating.value = false
  }
}
</script>
<template>
  <form class="generation-panel" @submit.prevent="translate">
    <div class="voice-composer" :class="{ 'is-disabled': busy }">
      <UTextarea
        v-model="content"
        class="voice-composer-input w-full"
        variant="none"
        aria-label="翻译提示词与原文"
        placeholder="翻译为中文，保持影视对话口语…&#10;原文：「台词内容」"
        :rows="4"
        autoresize
        :maxrows="10"
        :maxlength="2800"
        :disabled="busy"
        @keydown.meta.enter.prevent="translate"
        @keydown.ctrl.enter.prevent="translate"
      />
      <div class="voice-composer-footer">
        <div class="voice-composer-tools">
          <span v-if="segmentIndex" class="voice-segment-time">第 {{ segmentIndex }} 句</span>
          <span class="voice-segment-time"
            >{{ formatTime(segment.start) }} – {{ formatTime(segment.end) }}</span
          >
          <USelect
            v-model="sourceLanguage"
            class="voice-lang-select"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-carbon-language"
            :items="sourceLangItems"
            aria-label="原始语言"
            :disabled="busy"
          />
          <UIcon name="i-carbon-arrow-right" class="text-xs text-muted" />
          <USelect
            v-model="targetLanguage"
            class="voice-lang-select"
            color="neutral"
            variant="outline"
            size="sm"
            :items="languageOptions(targetLanguage)"
            aria-label="目标语言"
            :disabled="busy"
          />
        </div>
        <StudioAction
          type="submit"
          color="neutral"
          variant="solid"
          icon="i-carbon-arrow-up"
          square
          aria-label="生成本句译文"
          :reason="unavailableReason"
          :loading="translating"
        />
      </div>
    </div>
  </form>
</template>
