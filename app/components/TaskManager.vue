<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'
import { isActiveTask } from '../../shared/task-groups'
import { stageLabels, type Job } from '../../shared/types'
const { jobs, projects, act, errorMessage } = useStudio()
const open = ref(false)
const panelRef = ref<HTMLElement | null>(null)
const statusFilter = ref('all')
const route = useRoute()
const router = useRouter()
const navigation = useTaskNavigation()
const selectedId = computed(() => (typeof route.query.task === 'string' ? route.query.task : ''))
const detailOpen = computed({
  get: () => !!selectedId.value,
  set: (value: boolean) => {
    if (!value) void showDetail('')
  }
})
const history = ref<Job[]>([])
const historyLoading = ref(false)
const historyError = ref('')
const historyMore = ref(true)
const historyOffset = ref(0)
const busyIds = ref(new Set<string>())
const allJobs = computed(() =>
  [...new Map([...history.value, ...jobs.value].map((job) => [job.id, job])).values()].sort(
    (a, b) =>
      Number(isActiveTask(b.status)) - Number(isActiveTask(a.status)) ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id)
  )
)
const visible = computed(() =>
  allJobs.value.filter(
    (job) =>
      statusFilter.value === 'all' ||
      (statusFilter.value === 'active' ? isActiveTask(job.status) : job.status === statusFilter.value)
  )
)
const selectedJob = computed(() => allJobs.value.find((job) => job.id === selectedId.value))
const siblings = computed(() =>
  selectedJob.value?.batchId ? allJobs.value.filter((job) => job.batchId === selectedJob.value?.batchId) : []
)
const running = computed(() => jobs.value.filter((j) => j.status === 'running'))
const queued = computed(() => jobs.value.filter((j) => j.status === 'queued'))
const labels = {
  queued: '排队中',
  running: '处理中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消'
}
const filters = [
  { label: '全部状态', value: 'all' },
  { label: '进行中', value: 'active' },
  ...Object.entries(labels).map(([value, label]) => ({ value, label }))
]
const projectName = (id: string) => projects.value.find((p) => p.id === id)?.name || '项目'
function title(job: Job) {
  const stage =
    job.stage === 'translate' ? '翻译' : job.stage === 'synthesize' ? '配音' : stageLabels[job.stage]
  return job.segmentId
    ? `${stage} · ${job.segmentIndex ? `第 ${job.segmentIndex} 句` : '已删除的台词'}`
    : stage
}
function taskSummary() {
  if (running.value.length)
    return `${running.value.length} 个处理中${queued.value.length ? ` · ${queued.value.length} 个等待` : ''}`
  return queued.value.length ? `${queued.value.length} 个待处理` : '空闲'
}
function showDetail(id: string) {
  open.value = false
  return router.replace({ query: { ...route.query, task: id || undefined } })
}
function locate(job: Job) {
  open.value = false
  navigation.value = {
    projectId: job.projectId,
    segmentId: job.segmentId,
    nonce: (navigation.value?.nonce || 0) + 1
  }
}
async function loadHistory() {
  if (historyLoading.value) return
  historyLoading.value = true
  historyError.value = ''
  try {
    const rows = await $fetch<Job[]>('/api/jobs', { query: { history: '1', offset: historyOffset.value } })
    history.value.push(...rows)
    historyOffset.value += rows.length
    historyMore.value = rows.length === 100
  } catch (error) {
    historyError.value = errorMessage(error)
  } finally {
    historyLoading.value = false
  }
}
async function action(job: Job, value: 'retry' | 'cancel') {
  if (busyIds.value.has(job.id)) return
  busyIds.value.add(job.id)
  try {
    const ok = await act(() => $fetch(`/api/jobs/${job.id}/${value}`, { method: 'POST' }))
    if (ok) {
      const current = jobs.value.find((item) => item.id === job.id)
      if (current) history.value = history.value.map((item) => (item.id === job.id ? current : item))
    }
  } finally {
    busyIds.value.delete(job.id)
  }
}
onClickOutside(
  panelRef,
  () => {
    open.value = false
  },
  { ignore: ['[data-slot="content"]'] }
)
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>
<template>
  <div ref="panelRef" class="sidebar-task-manager" :class="{ expanded: open }">
    <button
      type="button"
      class="sidebar-task-btn"
      :class="{ active: open }"
      :aria-expanded="open"
      aria-label="任务列表"
      @click="open = !open"
    >
      <span class="task-indicator" :class="{ live: running.length }" /><span class="task-btn-label">任务</span
      ><span class="task-btn-summary">{{ taskSummary() }}</span>
      <UIcon :name="open ? 'i-carbon-chevron-right' : 'i-carbon-chevron-up'" class="task-btn-chevron" />
    </button>
    <aside v-if="open" class="task-popover-panel" aria-label="任务列表浮层">
      <header class="task-filter-bar">
        <strong>任务</strong
        ><USelect
          v-model="statusFilter"
          :items="filters"
          size="sm"
          aria-label="按任务状态筛选"
          :portal="false"
        />
      </header>
      <div class="task-list-body">
        <p v-if="!visible.length" class="task-empty">
          暂无{{ statusFilter === 'all' ? '' : '符合筛选的' }}任务
        </p>
        <article
          v-for="job in visible"
          :key="job.id"
          class="task-entry"
          :aria-label="`${projectName(job.projectId)} · ${title(job)}`"
          tabindex="0"
          @click="locate(job)"
          @keydown.enter.self.prevent="locate(job)"
          @keydown.space.self.prevent="locate(job)"
        >
          <div class="task-entry-row">
            <strong class="task-entry-title" :title="projectName(job.projectId)">{{ title(job) }}</strong
            ><span :class="`status-${job.status}`">{{ labels[job.status] }}</span>
          </div>
          <div class="task-entry-row task-entry-meta">
            <div class="task-entry-progress">
              <template v-if="!['failed', 'cancelled', 'skipped'].includes(job.status)"
                ><UProgress :model-value="job.progress" size="sm" :aria-label="`${title(job)}进度`" /><span
                  >{{ job.progress }}%</span
                ></template
              >
            </div>
            <time
              :datetime="new Date(job.createdAt).toISOString()"
              :title="new Date(job.createdAt).toLocaleString('zh-CN')"
              >{{
                new Date(job.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
              }}</time
            >
          </div>
          <div class="task-entry-row task-entry-bottom">
            <p class="task-entry-error" :title="job.error || undefined">
              {{ job.status === 'failed' ? job.error || '执行失败' : '' }}
            </p>
            <div class="task-entry-actions" @click.stop @keydown.stop>
              <UButton
                v-if="['failed', 'completed'].includes(job.status)"
                color="neutral"
                variant="outline"
                size="xs"
                square
                icon="i-carbon-renew"
                aria-label="重试"
                title="重试"
                :loading="busyIds.has(job.id)"
                @click="action(job, 'retry')"
              />
              <UButton
                color="neutral"
                variant="outline"
                size="xs"
                square
                icon="i-carbon-document"
                aria-label="查看详情"
                title="查看详情"
                @click="showDetail(job.id)"
              />
              <UButton
                v-if="isActiveTask(job.status)"
                color="neutral"
                variant="outline"
                size="xs"
                square
                icon="i-carbon-close"
                aria-label="取消任务"
                title="取消任务"
                :loading="busyIds.has(job.id)"
                @click="action(job, 'cancel')"
              />
            </div>
          </div>
        </article>
        <p v-if="historyError" class="error-text" role="alert">{{ historyError }}</p>
        <UButton
          v-if="historyMore || historyError"
          class="mt-3"
          block
          size="sm"
          color="neutral"
          variant="ghost"
          :loading="historyLoading"
          @click="loadHistory"
          >加载更多历史任务</UButton
        >
      </div>
    </aside>
  </div>
  <USlideover
    v-model:open="detailOpen"
    title="任务详情"
    description="查看完整网络请求、响应内容与执行状态"
    :ui="{ content: 'sm:max-w-3xl ring-0', body: 'min-w-0' }"
  >
    <template #body
      ><TaskDetail
        v-if="selectedId"
        :key="selectedId"
        :job-id="selectedId"
        :siblings="siblings"
        @select="showDetail"
    /></template>
  </USlideover>
</template>
<style scoped>
.task-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 13px;
}
.task-list-body {
  overflow-y: auto;
  max-height: min(65vh, 620px);
  padding: 4px 12px 12px;
}
.task-entry {
  padding: 12px 4px;
  border-bottom: 1px solid var(--ui-border);
  cursor: pointer;
  border-radius: 4px;
}
.task-entry:hover,
.task-entry:focus-visible {
  background: var(--ui-bg-elevated);
  outline: 2px solid transparent;
}
.task-entry:focus-visible {
  outline-color: var(--ui-border-accented);
}
.task-entry-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  font-size: 12px;
}
.task-entry-title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
}
.task-entry-row > span,
time {
  flex-shrink: 0;
}
.task-entry-meta {
  margin-top: 8px;
  color: var(--ui-text-muted);
}
.task-entry-progress {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.task-entry-progress > :first-child {
  flex: 1;
}
.task-entry-progress span {
  font-size: 10px;
}
.task-entry-bottom {
  align-items: flex-start;
  margin-top: 8px;
}
.task-entry-error {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--ui-error);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.5;
}
.task-entry-actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}
</style>
