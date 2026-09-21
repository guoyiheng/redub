<script setup lang="ts">
import { batchPlan, type BatchInput } from '../../shared/batch'
import { defaultVoiceSettings } from '../../shared/voice'
const props = defineProps<{ initialAction?: BatchInput['action'] }>()
const emit = defineEmits<{ close: []; submitted: [] }>()
const { detail, channels, settings, act } = useStudio()
const project = computed(() => detail.value!.project)
const lines = computed(() => detail.value!.segments)
const action = ref<BatchInput['action']>(
  props.initialAction ||
    (lines.value.length ? 'synthesize' : project.value.kind === 'text' ? 'synthesize' : 'prepare')
)
const scope = ref<'missing' | 'all'>('missing')
const finish = ref(false)
const saving = ref(false)
const voice = ref(defaultVoiceSettings(!!project.value.vocalsPath))
const input = computed<BatchInput>(() => ({
  action: action.value,
  scope: scope.value,
  finish: finish.value,
  voice: voice.value
}))
const targets = computed(() =>
  lines.value.filter((s) => s.enabled && (scope.value === 'all' || !s.generatedPath))
)
const reason = computed(() => {
  if (detail.value!.jobs.some((j) => ['queued', 'running'].includes(j.status)))
    return '请等待当前项目任务完成'
  try {
    batchPlan(project.value, lines.value, input.value)
  } catch (e) {
    return (e as Error).message
  }
  const channelId =
    action.value === 'translate' ? settings.value.translationChannelId : project.value.channelId
  if (
    (action.value === 'translate' || (action.value === 'synthesize' && voice.value.synthesisMode === 'ai')) &&
    !channels.value.some((c) => c.id === channelId && c.enabled && c.configured)
  )
    return '请先在左下角设置中配置对应渠道和密钥'
  return ''
})
const steps = computed(() => {
  if (action.value === 'prepare')
    return [
      '在本机提取音轨并分离人声与背景音',
      '切分人声、识别台词；中文输出为简体中文',
      '完成后停在台词校对，不自动翻译或生成配音'
    ]
  if (action.value === 'translate')
    return [
      `将 ${lines.value.filter((s) => s.enabled).length} 句需替换台词翻译为${project.value.targetLanguage}`,
      '覆盖这些台词的现有译文，并清除对应配音与成片'
    ]
  if (action.value === 'render')
    return ['将配音对齐到各句时间范围，保留背景音与未替换片段的原声', '生成可预览和导出的成片、字幕']
  return [
    `将共用参数应用到 ${targets.value.length} 句${scope.value === 'all' ? '需替换台词，重新生成并覆盖已有配音' : '尚未生成配音的台词'}，清除旧成片`,
    '按译文生成声音；没有译文时使用原文',
    ...(finish.value
      ? ['配音完成后保留背景音、合并音轨并生成成片']
      : ['生成完成后在工作区逐句试听，不自动合成成片'])
  ]
})
async function submit() {
  if (reason.value || saving.value) return
  saving.value = true
  const ok = await act(
    () => $fetch(`/api/projects/${project.value.id}/batch`, { method: 'POST', body: input.value }),
    '批量任务已加入队列'
  )
  saving.value = false
  if (ok) emit('submitted')
}
</script>
<template>
  <form class="batch-form" @submit.prevent="submit">
    <UFormField label="处理内容">
      <USelect
        v-model="action"
        class="w-full"
        :disabled="saving"
        :items="[
          {
            label: '识别素材中的台词',
            value: 'prepare',
            disabled: project.kind === 'text' || !!lines.length
          },
          { label: '翻译台词', value: 'translate' },
          { label: '生成配音', value: 'synthesize' },
          { label: '合成成片', value: 'render' }
        ]"
      />
    </UFormField>
    <template v-if="action === 'synthesize'">
      <UFormField label="应用范围"
        ><USelect
          v-model="scope"
          class="w-full"
          :disabled="saving"
          :items="[
            { label: '仅补齐未生成配音的台词', value: 'missing' },
            { label: '重新生成全部需替换台词', value: 'all' }
          ]"
      /></UFormField>
      <section>
        <h3>共用配音参数</h3>
        <VoiceParameters v-model="voice" :disabled="saving" :can-reference="!!project.vocalsPath" />
      </section>
      <UCheckbox v-model="finish" :disabled="saving" label="配音完成后自动合成成片" />
    </template>
    <p class="batch-cost help">
      {{
        action === 'prepare' || action === 'render'
          ? '在本机处理，不调用付费 AI 接口。'
          : action === 'translate'
            ? '开始后会调用翻译接口，消耗已配置渠道的额度。'
            : voice.synthesisMode === 'ai'
              ? '开始后会调用 AI 配音接口，消耗已配置渠道的额度。'
              : '微软 TTS 免费，需连接网络。'
      }}
    </p>
    <section class="batch-summary">
      <h3>本次会执行</h3>
      <ol>
        <li v-for="step in steps" :key="step">{{ step }}</li>
      </ol>
    </section>
    <p v-if="reason" class="help" role="status">{{ reason }}</p>
    <div class="editor-actions">
      <StudioAction
        color="neutral"
        variant="ghost"
        :reason="saving ? '正在提交批量任务' : ''"
        @click="emit('close')"
        >取消</StudioAction
      ><StudioAction type="submit" :reason="reason" :loading="saving">{{
        action === 'synthesize' ? `开始生成 ${targets.length} 句` : '开始处理'
      }}</StudioAction>
    </div>
  </form>
</template>
