<script setup lang="ts">
import type { Segment } from '../../shared/types'
const props = defineProps<{ segment: Segment; locked: boolean }>()
const emit = defineEmits<{ dirty: [value: boolean]; generate: [] }>()
const { act } = useStudio()
const draft = ref({
    ...props.segment,
    aiPrompt: props.segment.aiPrompt || '',
    aiSpeaker: props.segment.aiSpeaker || ''
  }),
  dirty = ref(false),
  saving = ref(false)
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
async function openGeneration() {
  if (dirty.value) {
    await save()
    if (dirty.value) return
  }
  emit('generate')
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
    <div v-if="segment.generatedPath" class="generated-audio">
      <p class="help">已生成配音</p>
      <audio :src="mediaUrl(segment.generatedPath)" controls preload="none" />
    </div>
    <div class="editor-actions">
      <UButton
        color="neutral"
        variant="outline"
        :disabled="!dirty || locked || saving"
        :title="locked ? '任务执行中，完成后可保存' : !dirty ? '当前没有未保存的修改' : undefined"
        :loading="saving"
        icon="i-carbon-save"
        @click="save"
        >保存台词</UButton
      ><UButton
        :disabled="locked || !draft.enabled || saving"
        :title="locked ? '任务执行中，完成后可生成' : !draft.enabled ? '请先开启替换此片段' : undefined"
        icon="i-carbon-microphone"
        @click="openGeneration"
        >打开生成设置</UButton
      >
    </div>
  </div>
</template>
