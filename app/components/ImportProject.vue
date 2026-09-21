<script setup lang="ts">
import { targetLanguages } from '../../shared/languages'
const emit = defineEmits<{ created: [id: string]; cancel: [] }>()
const { errorMessage } = useStudio()
const type = ref<'file' | 'text'>('file'),
  file = ref<File>(),
  text = ref(''),
  name = ref(''),
  language = ref('中文')
const dragging = ref(false),
  busy = ref(false),
  error = ref(''),
  upload = ref(0)
const input = ref<HTMLInputElement>()
function choose(f?: File) {
  if (!f) return
  file.value = f
  if (!name.value) name.value = f.name.replace(/\.[^.]+$/, '')
}
function drop(event: DragEvent) {
  dragging.value = false
  if (!busy.value) choose(event.dataTransfer?.files[0])
}
async function submit() {
  error.value = ''
  busy.value = true
  upload.value = 0
  try {
    if (!name.value.trim()) throw new Error('请填写项目名称')
    let result: { id: string }
    if (type.value === 'text')
      result = await $fetch('/api/projects', {
        method: 'POST',
        body: { name: name.value, text: text.value, targetLanguage: language.value }
      })
    else {
      if (!file.value) throw new Error('请先选择文件')
      const data = new FormData()
      data.append('file', file.value)
      data.append('name', name.value)
      data.append('targetLanguage', language.value)
      result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', '/api/projects')
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) upload.value = Math.round((e.loaded / e.total) * 100)
        }
        xhr.onload = () => {
          try {
            const response = JSON.parse(xhr.responseText)
            xhr.status < 300 ? resolve(response) : reject(new Error(response.statusMessage || '导入失败'))
          } catch {
            reject(new Error('导入失败，请检查文件'))
          }
        }
        xhr.onerror = () => reject(new Error('连接中断，请重新导入'))
        xhr.send(data)
      })
    }
    emit('created', result.id)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="import-panel">
    <header class="page-header">
      <h1>新建项目</h1>
      <UButton
        icon="i-carbon-close"
        aria-label="关闭导入"
        color="neutral"
        variant="ghost"
        :disabled="busy"
        @click="emit('cancel')"
      />
    </header>
    <div class="segmented" role="group" aria-label="导入方式">
      <button
        :class="{ active: type === 'file' }"
        :aria-pressed="type === 'file'"
        :disabled="busy"
        @click="type = 'file'"
      >
        上传文件</button
      ><button
        :class="{ active: type === 'text' }"
        :aria-pressed="type === 'text'"
        :disabled="busy"
        @click="type = 'text'"
      >
        粘贴台词
      </button>
    </div>
    <form @submit.prevent="submit">
      <div
        v-if="type === 'file'"
        class="drop-area"
        :class="{ dragging }"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="drop"
      >
        <UIcon name="i-carbon-document-video" class="size-9" />
        <strong>{{ file?.name || '将素材拖到这里' }}</strong>
        <p>
          {{
            file
              ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
              : 'MP4、MOV、MKV、MP3、WAV，或 TXT / SRT / VTT'
          }}
        </p>
        <UButton color="neutral" variant="outline" :disabled="busy" @click="input?.click()">{{
          file ? '更换文件' : '选择本地文件'
        }}</UButton>
        <input
          ref="input"
          hidden
          type="file"
          accept=".mp4,.mov,.mkv,.webm,.avi,.mp3,.wav,.m4a,.flac,.ogg,.aac,.txt,.srt,.vtt"
          @change="choose(($event.target as HTMLInputElement).files?.[0])"
        />
      </div>
      <UFormField v-else label="原始台词"
        ><UTextarea
          v-model="text"
          class="w-full"
          :rows="7"
          placeholder="每行一条台词，或粘贴 SRT / VTT"
          :disabled="busy"
      /></UFormField>
      <div class="form-grid">
        <UFormField label="项目名称" required
          ><UInput v-model="name" class="w-full" placeholder="输入项目名称" :disabled="busy" /></UFormField
        ><UFormField label="目标语言"
          ><USelect v-model="language" class="w-full" :items="targetLanguages" :disabled="busy"
        /></UFormField>
      </div>
      <UAlert v-if="error" color="error" variant="soft" :title="error" />
      <div v-if="busy && type === 'file'">
        <UProgress :model-value="upload" />
        <p class="help">{{ upload === 100 ? '文件已上传，正在读取素材…' : `正在导入 ${upload}%` }}</p>
      </div>
      <div class="form-footer">
        <p class="help">AI 服务会接收台词及参考人声。</p>
        <UButton type="submit" :loading="busy">创建项目</UButton>
      </div>
    </form>
  </section>
</template>
