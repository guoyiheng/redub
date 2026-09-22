<script setup lang="ts">
import type { JobRequest, JobRequestSummary } from '../../shared/types'
const props = defineProps<{ request: JobRequestSummary; defaultOpen?: boolean }>()
const { toast, errorMessage } = useStudio()
const expanded = ref(!!props.defaultOpen)
const detail = shallowRef<JobRequest>()
const loading = ref(false)
const error = ref('')
let version = 0
async function load() {
  const current = ++version
  loading.value = true
  error.value = ''
  try {
    const result = await $fetch<JobRequest>(`/api/jobs/${props.request.jobId}/requests/${props.request.id}`)
    if (current === version) detail.value = result
  } catch (e) {
    if (current === version) error.value = errorMessage(e)
  } finally {
    if (current === version) loading.value = false
  }
}
watch(
  [expanded, () => props.request.finishedAt],
  ([open]) => {
    if (open) void load()
  },
  { immediate: true }
)
async function copyCurl() {
  if (!detail.value) return
  try {
    await navigator.clipboard.writeText(detail.value.curl)
    toast.add({ title: '已复制 curl', color: 'success' })
  } catch {
    toast.add({ title: '复制失败，请选中 curl 手动复制', color: 'error' })
  }
}
function download() {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(detail.value, null, 2)], { type: 'application/json' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `request-${props.request.id}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>
<template>
  <details
    class="request-entry"
    :open="expanded"
    @toggle="expanded = ($event.target as HTMLDetailsElement).open"
  >
    <summary>
      <span
        ><strong>{{ request.label }}</strong> · 第 {{ request.attempt }} 次执行</span
      >
      <span :class="{ 'error-text': request.error }"
        >{{ request.responseStatus ?? (request.finishedAt ? '未收到响应' : '等待响应')
        }}<template v-if="request.durationMs !== null">
          · {{ (request.durationMs / 1000).toFixed(2) }} 秒</template
        ></span
      >
      <code>{{ request.method }} {{ request.url }}</code>
    </summary>
    <div v-if="expanded" class="request-content">
      <p v-if="loading" class="help" role="status">正在读取请求记录…</p>
      <UAlert v-if="error" color="error" :description="error" title="读取失败" />
      <UButton v-if="error" color="neutral" variant="outline" @click="load">重试</UButton>
      <template v-if="detail">
        <div class="row-actions">
          <UButton size="sm" color="neutral" variant="outline" icon="i-carbon-copy" @click="copyCurl"
            >复制 curl</UButton
          >
          <UButton size="sm" color="neutral" variant="ghost" icon="i-carbon-download" @click="download"
            >下载完整记录</UButton
          >
        </div>
        <p class="help">
          {{ new Date(detail.startedAt).toLocaleString('zh-CN') }} · 请求 ID：{{ detail.id }}
        </p>
        <p v-if="detail.error" class="error-text">{{ detail.error }}</p>
        <TaskLogBlock title="请求体" :value="detail.requestBody ?? '无请求体'" />
        <TaskLogBlock
          :title="`响应体${detail.responseEncoding === 'base64' ? '（二进制 Base64）' : ''}`"
          :value="detail.responseBody ?? '尚未收到响应体'"
        />
        <details>
          <summary>请求头、响应头与 curl</summary>
          <div class="request-content">
            <TaskLogBlock title="curl 请求" :value="detail.curl" />
            <TaskLogBlock title="请求头" :value="JSON.stringify(detail.requestHeaders, null, 2)" />
            <TaskLogBlock
              title="响应头"
              :value="
                detail.responseHeaders ? JSON.stringify(detail.responseHeaders, null, 2) : '尚未收到响应头'
              "
            />
          </div>
        </details>
      </template>
    </div>
  </details>
</template>
<style scoped>
.request-entry {
  border-block-start: 1px solid var(--ui-border);
}
summary {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  padding: 16px 0;
  font-size: 12px;
}
summary code {
  width: 100%;
  overflow-wrap: anywhere;
  color: var(--ui-text-muted);
}
.request-content {
  display: grid;
  gap: 14px;
  padding-bottom: 20px;
  min-width: 0;
}
</style>
