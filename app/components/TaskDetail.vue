<script setup lang="ts">
import { stageLabels, type Job, type JobDetail } from '../../shared/types'
const props = defineProps<{ jobId: string; siblings: Job[] }>()
const emit = defineEmits<{ select: [id: string] }>()
const { act, errorMessage, toast } = useStudio()
const detail = shallowRef<JobDetail>()
const error = ref('')
const busy = ref(false)
const labels = { queued: '排队中', running: '处理中', completed: '已完成', failed: '失败', skipped: '已跳过' }
const artifact = computed(() => {
  const result = detail.value?.result as { path?: string; filename?: string } | null
  return result?.path && result?.filename ? { path: result.path, filename: result.filename } : null
})
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
async function load() {
  clearTimeout(timer)
  try {
    const result = await $fetch<JobDetail>(`/api/jobs/${props.jobId}`)
    if (disposed) return
    detail.value = result
    error.value = ''
  } catch (e) {
    if (!disposed) error.value = errorMessage(e)
  } finally {
    if (!disposed && (error.value || ['queued', 'running'].includes(detail.value?.job.status || '')))
      timer = setTimeout(load, 2000)
  }
}
async function action(value: 'retry' | 'skip') {
  busy.value = true
  try {
    await act(() => $fetch(`/api/jobs/${props.jobId}/${value}`, { method: 'POST' }))
    await load()
  } finally {
    busy.value = false
  }
}
async function copyId() {
  try {
    await navigator.clipboard.writeText(props.jobId)
    toast.add({ title: '已复制任务 ID', color: 'success' })
  } catch {
    toast.add({ title: '复制失败，请手动复制任务 ID', color: 'error' })
  }
}
onMounted(load)
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
})
</script>
<template>
  <div class="task-detail">
    <UFormField v-if="siblings.length > 1" label="批次中的任务">
      <USelect
        class="w-full"
        :model-value="jobId"
        :items="
          siblings.map((job) => ({
            label: `${stageLabels[job.stage]} · ${job.id.slice(0, 8)} · ${labels[job.status]}`,
            value: job.id
          }))
        "
        @update:model-value="emit('select', String($event))"
      />
    </UFormField>
    <UAlert v-if="error" title="读取详情失败" :description="error" color="error" />
    <p v-if="!detail && !error" class="help" role="status">正在读取任务详情…</p>
    <template v-if="detail">
      <div class="detail-title">
        <h3>{{ stageLabels[detail.job.stage] }}</h3>
        <span :class="`status-${detail.job.status}`">{{ labels[detail.job.status] }}</span>
      </div>
      <dl>
        <dt>任务 ID</dt>
        <dd>
          <code>{{ detail.job.id }}</code
          ><UButton
            aria-label="复制任务 ID"
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-carbon-copy"
            @click="copyId"
          />
        </dd>
        <dt>项目</dt>
        <dd>{{ detail.projectName }}</dd>
        <dt>创建时间</dt>
        <dd>{{ new Date(detail.job.createdAt).toLocaleString('zh-CN') }}</dd>
        <dt>更新时间</dt>
        <dd>{{ new Date(detail.job.updatedAt).toLocaleString('zh-CN') }}</dd>
        <dt>执行次数</dt>
        <dd>{{ detail.job.attempts }}</dd>
        <template v-if="detail.job.segmentId"
          ><dt>片段 ID</dt>
          <dd>
            <code>{{ detail.job.segmentId }}</code>
          </dd></template
        >
        <template v-if="detail.job.dependsOn"
          ><dt>前置任务</dt>
          <dd>
            <UButton
              size="xs"
              color="neutral"
              variant="link"
              @click="emit('select', detail.job.dependsOn!)"
              >{{ detail.job.dependsOn }}</UButton
            >
          </dd></template
        >
      </dl>
      <UProgress :model-value="detail.job.progress" />
      <p class="help">{{ detail.job.message }} · {{ detail.job.progress }}%</p>
      <UAlert v-if="detail.job.error" color="error" title="任务执行失败" :description="detail.job.error" />
      <div class="row-actions">
        <UButton
          v-if="detail.job.status === 'failed'"
          :loading="busy"
          icon="i-carbon-renew"
          @click="action('retry')"
          >重试任务</UButton
        >
        <UButton
          v-if="['queued', 'failed'].includes(detail.job.status)"
          :disabled="busy"
          color="neutral"
          variant="outline"
          @click="action('skip')"
          >跳过任务</UButton
        >
        <UButton
          v-if="artifact"
          :href="mediaUrl(artifact.path, true)"
          :download="artifact.filename"
          icon="i-carbon-download"
          >下载成片</UButton
        >
      </div>
      <details v-if="detail.input">
        <summary>任务参数</summary>
        <TaskLogBlock title="参数" :value="JSON.stringify(detail.input, null, 2)" />
      </details>
      <details v-if="detail.result">
        <summary>任务结果</summary>
        <TaskLogBlock title="结果" :value="JSON.stringify(detail.result, null, 2)" />
      </details>
      <section>
        <h3>
          网络请求 <span class="help">{{ detail.requests.length }} 条</span>
        </h3>
        <p class="help request-note">请求按执行次数保留。密钥已隐藏，curl 中的密钥变量需在本机设置。</p>
        <p v-if="!detail.requests.length" class="help">
          {{
            ['queued', 'running'].includes(detail.job.status)
              ? '暂无请求记录；发起网络请求后会自动显示。'
              : '此任务没有网络请求记录。本地处理与此前完成的历史任务不会补录请求。'
          }}
        </p>
        <TaskRequest v-for="request in detail.requests" :key="request.id" :request="request" />
      </section>
    </template>
  </div>
</template>
<style scoped>
.task-detail {
  display: grid;
  gap: 18px;
  min-width: 0;
}
.detail-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
dl {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 10px 12px;
  font-size: 12px;
}
dt {
  color: var(--ui-text-muted);
}
dd {
  overflow-wrap: anywhere;
}
dd code {
  user-select: all;
}
.request-note {
  margin: 8px 0 16px;
}
summary {
  font-size: 13px;
  margin-bottom: 10px;
}
</style>
