<script setup lang="ts">
import type { ReferenceVoice } from '../../shared/types'
const open = defineModel<boolean>('open', { default: false })
withDefaults(defineProps<{ selectable?: boolean }>(), { selectable: false })
const emit = defineEmits<{ select: [voice: ReferenceVoice] }>()
const { voices, load, add, rename } = useReferenceVoices()
const { errorMessage } = useStudio()
const file = ref<File | null>(null)
const name = ref('')
const error = ref('')
const loading = ref(false)
const saving = ref(false)
const editing = ref('')
const editName = ref('')
watch(file, (value) => {
  name.value = value?.name.replace(/\.[^.]+$/, '').slice(0, 80) || ''
})
watch(open, async (value) => {
  if (!value) return
  error.value = ''
  loading.value = true
  try {
    await load()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
})
async function addVoice() {
  if (!file.value || saving.value) return
  error.value = ''
  saving.value = true
  try {
    if (file.value.size > 10 * 1024 ** 2) throw new Error('参考音频不能超过 10 MB')
    await add(file.value, name.value)
    file.value = null
    name.value = ''
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    saving.value = false
  }
}
async function saveName() {
  saving.value = true
  error.value = ''
  try {
    await rename(editing.value, editName.value)
    editing.value = ''
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    saving.value = false
  }
}
function startRename(voice: ReferenceVoice) {
  editing.value = voice.id
  editName.value = voice.name
}
function selectVoice(voice: ReferenceVoice) {
  emit('select', voice)
  open.value = false
}
</script>
<template>
  <UModal
    v-model:open="open"
    title="参考音色"
    description="添加本地音频，在配音时复用音色。"
    :ui="{ content: 'sm:max-w-xl', body: 'space-y-5' }"
  >
    <template #body>
      <section class="space-y-3" aria-label="音色增加器">
        <UFileUpload
          v-model="file"
          accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac"
          label="拖入音频，或点击选择"
          description="30 秒以内 · 最大 10 MB"
          icon="i-carbon-music"
          file-icon="i-carbon-music"
          :disabled="saving"
          :file-image="false"
          class="w-full min-h-28"
        />
        <div class="flex items-center gap-2">
          <UInput
            v-model="name"
            aria-label="音色名称"
            placeholder="音色名称（默认使用文件名）"
            :maxlength="80"
            :disabled="saving"
            class="flex-1"
          />
          <UButton
            type="button"
            color="neutral"
            variant="outline"
            icon="i-carbon-add"
            :disabled="!file"
            :loading="saving"
            @click="addVoice"
            >添加音色</UButton
          >
        </div>
      </section>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <section class="space-y-3" aria-label="已保存的参考音色">
        <div class="flex items-center justify-between text-sm">
          <strong>音色列表</strong><span class="text-muted">{{ voices.length }} 个</span>
        </div>
        <p v-if="loading" class="text-sm text-muted">正在加载…</p>
        <p v-else-if="!voices.length" class="py-4 text-center text-sm text-muted">
          添加音频后，即可在这里选择参考音色
        </p>
        <div v-for="voice in voices" :key="voice.id" class="space-y-2 rounded-lg border border-default p-3">
          <div class="flex items-center gap-2">
            <template v-if="editing === voice.id">
              <UInput
                v-model="editName"
                aria-label="修改音色名称"
                :maxlength="80"
                class="min-w-0 flex-1"
                @keydown.enter.prevent="saveName"
              />
              <UButton
                color="neutral"
                variant="outline"
                size="sm"
                :loading="saving"
                :disabled="!editName.trim()"
                @click="saveName"
                >保存</UButton
              >
              <UButton
                color="neutral"
                variant="outline"
                size="sm"
                icon="i-carbon-close"
                aria-label="取消改名"
                :disabled="saving"
                @click="editing = ''"
              />
            </template>
            <template v-else>
              <span class="min-w-0 flex-1 truncate text-sm font-medium" :title="voice.name">{{
                voice.name
              }}</span>
              <UButton
                color="neutral"
                variant="outline"
                size="xs"
                square
                icon="i-carbon-edit"
                aria-label="重命名音色"
                @click="startRename(voice)"
              />
              <UButton
                v-if="selectable"
                color="neutral"
                variant="outline"
                size="xs"
                @click="selectVoice(voice)"
                >使用</UButton
              >
            </template>
          </div>
          <AudioPlayer :src="mediaUrl(voice.path)" :label="`试听${voice.name}`" />
        </div>
      </section>
    </template>
  </UModal>
</template>
