<script setup lang="ts">
import { batchPlan, type BatchInput } from '../../shared/batch'
import { defaultVoiceSettings, speakerName, voiceSettingsSchema } from '../../shared/voice'
const props = defineProps<{ initialAction?: BatchInput['action'] | 'speaker' }>()
const emit = defineEmits<{ close: []; submitted: [] }>()
const { detail, channels, settings, act } = useStudio()
const project = computed(() => detail.value!.project)
const lines = computed(() => detail.value!.segments)
const speakers = computed(() => {
  const set = new Set(lines.value.map((s) => speakerName(s.speaker)))
  return Array.from(set)
})
const targetSpeaker = ref(speakers.value[0] || '角色 1')
const action = ref<BatchInput['action'] | 'speaker'>(
  props.initialAction ||
    (lines.value.length ? 'synthesize' : project.value.kind === 'text' ? 'synthesize' : 'prepare')
)
const scope = ref<'missing' | 'all'>('missing')
const finish = ref(false)
const saving = ref(false)
const voice = ref(defaultVoiceSettings(!!project.value.vocalsPath))
const useSegmentVoices = ref(true)
const input = computed<BatchInput>(() => ({
  action: action.value === 'speaker' ? 'synthesize' : action.value,
  scope: scope.value,
  finish: finish.value,
  useSegmentVoices: useSegmentVoices.value,
  voice: voice.value
}))
const speakerLines = computed(() => lines.value.filter((s) => speakerName(s.speaker) === targetSpeaker.value))
watch(
  [action, targetSpeaker],
  () => {
    if (action.value === 'speaker' && speakerLines.value[0])
      voice.value = voiceSettingsSchema.parse(speakerLines.value[0])
  },
  { immediate: true }
)
const targets = computed(() =>
  lines.value.filter((s) => s.enabled && (scope.value === 'all' || !s.generatedPath))
)
const needsAi = computed(() =>
  useSegmentVoices.value
    ? targets.value.some((line) => line.synthesisMode === 'ai')
    : voice.value.synthesisMode === 'ai'
)
const reason = computed(() => {
  if (detail.value!.jobs.some((j) => ['queued', 'running'].includes(j.status)))
    return '请等待当前项目任务完成'
  if (action.value === 'speaker') {
    if (!speakerLines.value.length) return '当前项目没有可配置的台词角色'
    return ''
  }
  try {
    batchPlan(project.value, lines.value, input.value)
  } catch (e) {
    return (e as Error).message
  }
  const channelId =
    action.value === 'translate' ? settings.value.translationChannelId : project.value.channelId
  if (
    (action.value === 'translate' || (action.value === 'synthesize' && needsAi.value)) &&
    !channels.value.some((c) => c.id === channelId && c.enabled && c.configured)
  )
    return '请先在左下角设置中配置对应渠道和密钥'
  return ''
})
const steps = computed(() => {
  if (action.value === 'speaker')
    return [
      `将所选发音参数批量应用到角色「${targetSpeaker.value}」的所有台词（共 ${speakerLines.value.length} 句）`,
      '参数变化的台词会清除旧配音，保存相同参数会保留已有配音',
      '不直接调用付费接口生成音频，可在校对后按需生成'
    ]
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
    return [
      '将已有配音对齐到各句时间范围，混入背景音',
      '未配音和未启用替换的片段保留原声',
      '生成可预览和导出的成片、字幕'
    ]
  return [
    `${useSegmentVoices.value ? '沿用各句已保存的参数，生成' : '将共用参数应用到'} ${targets.value.length} 句${scope.value === 'all' ? '需替换台词，重新生成并覆盖已有配音' : '尚未生成配音的台词'}，清除旧成片`,
    useSegmentVoices.value
      ? '优先使用各句已保存的配音要求；未设置时使用译文或原文'
      : '按译文生成声音；没有译文时使用原文',
    ...(finish.value
      ? ['配音完成后保留背景音、合并音轨并生成成片']
      : ['生成完成后在工作区逐句试听，不自动合成成片'])
  ]
})
async function submit() {
  if (reason.value || saving.value) return
  saving.value = true
  if (action.value === 'speaker') {
    const ok = await act(
      () =>
        $fetch(`/api/projects/${project.value.id}/speaker-voice`, {
          method: 'POST',
          body: { speaker: targetSpeaker.value, voice: voice.value }
        }),
      `已更新角色「${targetSpeaker.value}」的配音设置`
    )
    saving.value = false
    if (ok) emit('submitted')
    return
  }
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
    <UFormField v-if="!props.initialAction" label="处理内容">
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
          { label: '按角色设置音色', value: 'speaker', disabled: !lines.length },
          { label: '翻译台词', value: 'translate' },
          { label: '生成配音', value: 'synthesize' },
          { label: '合成成片', value: 'render' }
        ]"
      />
    </UFormField>
    <template v-if="action === 'speaker'">
      <UFormField label="目标角色" description="选择要统一配置发音人与音色的角色">
        <USelect
          v-model="targetSpeaker"
          class="w-full"
          :disabled="saving"
          :items="
            speakers.map((s) => ({
              label: `${s}（${lines.filter((l) => speakerName(l.speaker) === s).length} 句）`,
              value: s
            }))
          "
        />
      </UFormField>
      <section>
        <h3>该角色配音参数</h3>
        <VoiceParameters v-model="voice" :disabled="saving" :can-reference="!!project.vocalsPath" />
      </section>
    </template>
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
      <UFormField label="音色设置">
        <USelect
          v-model="useSegmentVoices"
          class="w-full"
          :disabled="saving"
          :items="[
            { label: '沿用各句 / 角色的配音设置', value: true },
            { label: '统一使用共用参数', value: false }
          ]"
        />
      </UFormField>
      <section v-if="!useSegmentVoices">
        <h3>共用配音参数</h3>
        <VoiceParameters v-model="voice" :disabled="saving" :can-reference="!!project.vocalsPath" />
      </section>
      <UCheckbox v-model="finish" :disabled="saving" label="配音完成后自动合成成片" />
    </template>
    <p class="batch-cost help">
      {{
        action === 'speaker'
          ? '仅保存配音设置，生成配音时才会请求语音服务。'
          : action === 'prepare' || action === 'render'
            ? '在本机处理，不调用付费 AI 接口。'
            : action === 'translate'
              ? '开始后会调用翻译接口，消耗已配置渠道的额度。'
              : needsAi
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
        action === 'translate'
          ? `开始翻译 ${lines.filter((s) => s.enabled).length} 句`
          : action === 'synthesize'
            ? `开始生成 ${targets.length} 句`
            : action === 'speaker'
              ? `应用到「${targetSpeaker}」(${speakerLines.length} 句)`
              : '开始处理'
      }}</StudioAction>
    </div>
  </form>
</template>
