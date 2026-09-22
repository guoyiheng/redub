<script setup lang="ts">
const emit = defineEmits<{ created: [id: string]; cancel: [] }>()
const { errorMessage } = useStudio()
const file = ref<File>()
const name = ref('')
const dragging = ref(false)
const busy = ref(false)
const error = ref('')
const upload = ref(0)
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
    if (!file.value) throw new Error('请先选择文件')
    const projectName = name.value.trim() || file.value.name.replace(/\.[^.]+$/, '') || '未命名项目'
    const data = new FormData()
    data.append('file', file.value)
    data.append('name', projectName)
    data.append('targetLanguage', '中文')

    const result = await new Promise<{ id: string }>((resolve, reject) => {
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
    <form @submit.prevent="submit">
      <div
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
      <div class="form-grid single-field">
        <UFormField label="项目名称">
          <UInput v-model="name" class="w-full" placeholder="选填，默认使用文件名" :disabled="busy" />
        </UFormField>
      </div>
      <UAlert v-if="error" color="error" variant="soft" :title="error" />
      <div v-if="busy">
        <UProgress :model-value="upload" />
        <p class="help">{{ upload === 100 ? '文件已上传，正在读取素材…' : `正在导入 ${upload}%` }}</p>
      </div>
      <div class="form-footer">
        <p class="help">创建后先校对台词；翻译和配音由你手动发起，不会自动调用 AI 接口。</p>
        <UButton type="submit" :loading="busy">创建项目</UButton>
      </div>
    </form>
  </section>
</template>
