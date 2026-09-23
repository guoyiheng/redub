<script setup lang="ts">
import { onClickOutside, useIntersectionObserver } from '@vueuse/core'
import { isActiveTask } from '../../shared/task-groups'
import { stageLabels, type Job } from '../../shared/types'
const { jobs, projects, act, errorMessage } = useStudio()
const open = ref(false)
const panelRef = ref<HTMLElement | null>(null)
const sentinelRef = ref<HTMLElement | null>(null)
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
const activeCount = computed(() => running.value.length + queued.value.length)
function taskSummary() {
  return activeCount.value > 0 ? `${activeCount.value}` : '空闲'
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
  if (historyLoading.value || !historyMore.value) return
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

useIntersectionObserver(
  sentinelRef,
  ([entry]) => {
    if (entry?.isIntersecting && historyMore.value && !historyLoading.value) {
      void loadHistory()
    }
  },
  { threshold: 0.1 }
)

function onListScroll(event: Event) {
  const el = event.target as HTMLElement
  if (!el || historyLoading.value || !historyMore.value) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
    void loadHistory()
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
  (event) => {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (
      target.closest(
        '[data-slot="content"], [role="listbox"], [role="menu"], [data-reka-popper-content-wrapper], [data-radix-popper-content-wrapper]'
      )
    )
      return
    open.value = false
  },
  {
    ignore: [
      '[data-slot="content"]',
      '[role="listbox"]',
      '[role="menu"]',
      '[data-reka-popper-content-wrapper]',
      '[data-radix-popper-content-wrapper]'
    ]
  }
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
      <header class="task-popover-header">
        <div class="task-header-left">
          <strong>任务</strong>
          <span v-if="running.length" class="task-header-badge live"> {{ running.length }} 个处理中 </span>
          <span v-else-if="allJobs.length" class="task-header-badge"> {{ allJobs.length }} 个 </span>
        </div>
        <div class="task-header-right">
          <USelect
            v-model="statusFilter"
            :items="filters"
            size="xs"
            class="task-status-filter"
            aria-label="按任务状态筛选"
          />
          <button
            type="button"
            class="task-popover-close"
            aria-label="关闭任务面板"
            title="关闭"
            @click="open = false"
          >
            <UIcon name="i-carbon-close" />
          </button>
        </div>
      </header>
      <div class="task-list-body" @scroll.passive="onListScroll">
        <div v-if="!visible.length" class="task-empty">
          <UIcon name="i-carbon-task" class="task-empty-icon" />
          <p>暂无{{ statusFilter === 'all' ? '' : '符合筛选的' }}任务</p>
        </div>
        <article
          v-for="job in visible"
          :key="job.id"
          class="task-card"
          :class="{ 'is-active': isActiveTask(job.status), 'is-failed': job.status === 'failed' }"
          :aria-label="`${projectName(job.projectId)} · ${title(job)}`"
          tabindex="0"
          @click="locate(job)"
          @keydown.enter.self.prevent="locate(job)"
          @keydown.space.self.prevent="locate(job)"
        >
          <div class="task-card-header">
            <div class="task-title-group">
              <span class="task-title-text" :title="title(job)">{{ title(job) }}</span>
              <span class="task-project-pill" :title="projectName(job.projectId)">
                {{ projectName(job.projectId) }}
              </span>
            </div>
            <span class="task-status-badge" :class="`status-${job.status}`">
              {{ labels[job.status] }}
            </span>
          </div>

          <div v-if="isActiveTask(job.status)" class="task-card-progress">
            <UProgress
              :model-value="job.progress"
              size="xs"
              :aria-label="`${title(job)}进度`"
              class="flex-1"
            />
            <span class="task-progress-num">{{ job.progress }}%</span>
          </div>

          <p v-if="job.status === 'failed' && job.error" class="task-card-error" :title="job.error">
            {{ job.error }}
          </p>

          <div class="task-card-footer">
            <time
              :datetime="new Date(job.createdAt).toISOString()"
              :title="new Date(job.createdAt).toLocaleString('zh-CN')"
              class="task-time"
            >
              {{
                new Date(job.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
              }}
            </time>
            <div class="task-card-actions" @click.stop @keydown.stop>
              <UButton
                v-if="['failed', 'completed'].includes(job.status)"
                color="neutral"
                variant="ghost"
                size="xs"
                class="task-action-btn"
                square
                icon="i-carbon-renew"
                aria-label="重试"
                title="重试"
                :loading="busyIds.has(job.id)"
                @click="action(job, 'retry')"
              />
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                class="task-action-btn"
                square
                icon="i-carbon-document"
                aria-label="查看详情"
                title="查看详情"
                @click="showDetail(job.id)"
              />
              <UButton
                v-if="isActiveTask(job.status)"
                color="neutral"
                variant="ghost"
                size="xs"
                class="task-action-btn"
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

        <div v-if="historyLoading" class="task-scroll-loading">
          <UIcon name="i-carbon-circle-dash" class="animate-spin text-sm" />
          <span>加载历史任务中…</span>
        </div>
        <div v-else-if="historyError" class="task-scroll-error">
          <span class="error-text" role="alert">{{ historyError }}</span>
          <UButton size="xs" color="neutral" variant="ghost" @click="loadHistory">重试</UButton>
        </div>
        <div ref="sentinelRef" class="task-sentinel" />
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
.task-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 44px;
  padding: 8px 12px 8px 14px;
  border-bottom: 1px solid var(--ui-border);
  background: color-mix(in srgb, var(--ui-bg-muted) 35%, var(--ui-bg-elevated));
}
.task-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ui-text);
  min-width: 0;
}
.task-header-left strong {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.task-header-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  background: var(--ui-bg-muted);
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.task-header-badge.live {
  background: color-mix(in srgb, #c96442 12%, transparent);
  color: #c96442;
  font-weight: 600;
}
.task-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.task-status-filter {
  width: 98px;
  flex-shrink: 0;
}
.task-popover-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--ui-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  font-size: 15px;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}
.task-popover-close:hover {
  background: color-mix(in srgb, var(--ui-text-muted) 15%, transparent);
  color: var(--ui-text);
}

.task-list-body {
  flex: 1;
  overflow-y: auto;
  max-height: min(60vh, 560px);
  min-height: 100px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.task-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  color: var(--ui-text-muted);
  font-size: 12px;
  gap: 8px;
}
.task-empty-icon {
  font-size: 26px;
  opacity: 0.4;
}
.task-empty p {
  margin: 0;
}

.task-card {
  padding: 9px 11px;
  border-radius: 8px;
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}
.task-card:hover {
  background: color-mix(in srgb, var(--ui-bg-elevated) 70%, var(--ui-bg));
  border-color: color-mix(in srgb, var(--ui-border) 80%, var(--ui-text-muted));
}
.task-card:focus-visible {
  outline: 2px solid var(--ui-primary, #c96442);
  outline-offset: -1px;
}
.task-card.is-active {
  border-color: color-mix(in srgb, #c96442 45%, var(--ui-border));
}

.task-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.task-title-group {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.task-title-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-project-pill {
  font-size: 11px;
  color: var(--ui-text-muted);
  background: var(--ui-bg-muted);
  padding: 1px 6px;
  border-radius: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 110px;
  flex-shrink: 0;
}
.task-status-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  flex-shrink: 0;
}
.task-status-badge.status-queued {
  background: color-mix(in srgb, var(--ui-text-muted) 12%, transparent);
  color: var(--ui-text-muted);
}
.task-status-badge.status-running {
  background: color-mix(in srgb, #c96442 12%, transparent);
  color: #c96442;
  font-weight: 600;
}
.task-status-badge.status-completed {
  background: color-mix(in srgb, #2e7d32 12%, transparent);
  color: #2e7d32;
}
.task-status-badge.status-failed {
  background: color-mix(in srgb, #b53333 12%, transparent);
  color: #b53333;
}
.task-status-badge.status-skipped,
.task-status-badge.status-cancelled {
  background: color-mix(in srgb, var(--ui-text-muted) 10%, transparent);
  color: var(--ui-text-muted);
}

.task-card-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.task-progress-num {
  font-size: 10px;
  color: var(--ui-text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 28px;
  text-align: right;
  flex-shrink: 0;
}

.task-card-error {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: #b53333;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  background: color-mix(in srgb, #b53333 8%, transparent);
  padding: 4px 8px;
  border-radius: 4px;
}

.task-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
}
.task-time {
  font-size: 11px;
  color: var(--ui-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.task-card-actions {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  margin-left: auto;
}
:deep(.task-action-btn) {
  width: 22px !important;
  min-width: 22px !important;
  height: 22px !important;
  min-height: 22px !important;
  padding: 0 !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  border-radius: 4px !important;
}
.task-scroll-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 0 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.task-scroll-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 0;
  font-size: 12px;
}
.task-sentinel {
  height: 4px;
  pointer-events: none;
  visibility: hidden;
}
</style>
