<script setup lang="ts">
import type { Segment } from '../../shared/types'
const props = defineProps<{ segment: Segment; locked: boolean }>()
const emit = defineEmits<{ dirty: [value: boolean] }>()
const { act } = useStudio()
const draft = ref({ ...props.segment }),
  dirty = ref(false),
  saving = ref(false)
watch(
  () => props.segment,
  (value) => {
    if (!dirty.value || draft.value.id !== value.id) {
      draft.value = { ...value }
      dirty.value = false
    }
  },
  { deep: true }
)
watch(dirty, (value) => emit('dirty', value))
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
      <h3>片段编辑</h3>
      <span v-if="dirty" class="help">未保存</span
      ><UCheckbox
        v-model="draft.enabled"
        label="替换此片段"
        :disabled="locked"
        @update:model-value="dirty = true"
      />
    </div>
    <div class="time-fields">
      <UFormField label="开始（秒）"
        ><UInput
          class="w-full"
          v-model.number="draft.start"
          type="number"
          :min="0"
          :step="0.01"
          :disabled="locked"
          @update:model-value="dirty = true" /></UFormField
      ><UFormField label="结束（秒）"
        ><UInput
          class="w-full"
          v-model.number="draft.end"
          type="number"
          :min="0"
          :step="0.01"
          :disabled="locked"
          @update:model-value="dirty = true" /></UFormField
      ><UFormField label="角色"
        ><UInput class="w-full" v-model="draft.speaker" :disabled="locked" @update:model-value="dirty = true"
      /></UFormField>
    </div>
    <UFormField label="原文"
      ><UTextarea
        v-model="draft.text"
        class="w-full"
        :rows="2"
        :disabled="locked"
        placeholder="输入原文"
        @update:model-value="dirty = true"
    /></UFormField>
    <UFormField label="译文 / 替换台词"
      ><UTextarea
        v-model="draft.translation"
        class="w-full"
        :rows="3"
        :disabled="locked"
        placeholder="填写希望说出的内容；留空时使用原文"
        @update:model-value="dirty = true"
    /></UFormField>
    <div v-if="segment.referencePath || segment.generatedPath" class="editor-audio">
      <div v-if="segment.referencePath">
        <p class="help">原声参考</p>
        <audio :src="mediaUrl(segment.referencePath)" controls preload="none" />
      </div>
      <div v-if="segment.generatedPath">
        <p class="help">生成配音 · {{ segment.generatedDuration?.toFixed(1) }} 秒</p>
        <audio :src="mediaUrl(segment.generatedPath)" controls preload="none" />
      </div>
    </div>
    <div class="editor-actions">
      <UButton
        color="neutral"
        variant="outline"
        :disabled="!dirty || locked"
        :loading="saving"
        icon="i-carbon-save"
        @click="save"
        >保存</UButton
      ><UButton :disabled="locked || !draft.enabled" icon="i-carbon-microphone" @click="synthesize">{{
        segment.generatedPath ? '重新配音' : '生成配音'
      }}</UButton>
    </div>
  </div>
</template>
