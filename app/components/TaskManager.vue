<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'
import { groupJobs, isActiveTask, type TaskGroup } from '../../shared/task-groups'
import { stageLabels, type Job } from '../../shared/types'

const { jobs, projects, act } = useStudio()
const open = ref(false)
const panelRef = ref<HTMLElement | null>(null)
const activeTab = ref('active')
const route = useRoute()
const router = useRouter()
const selectedId = computed(() => (typeof route.query.task === 'string' ? route.query.task : ''))
const detailOpen = computed({
  get: () => !!selectedId.value,
  set: (value: boolean) => {
    if (!value) void showDetail('')
  }
})
const history = ref<Job[]>([])
const showHistory = ref(false)
const historyLoading = ref(false)
const historyError = ref('')
const historyMore = ref(true)
const historyOffset = ref(0)
const { errorMessage } = useStudio()
const allJobs = computed(() => [
  ...new Map([...history.value, ...jobs.value].map((job) => [job.id, job])).values()
])
const allGroups = computed(() => groupJobs(allJobs.value, Number.MAX_SAFE_INTEGER))
const activeGroups = computed(() => allGroups.value.filter((group) => isActiveTask(group.status)))
const completedGroups = computed(() => allGroups.value.filter((group) => !isActiveTask(group.status)))
const tabs = computed(() => [
  { label: '进行中', value: 'active', badge: activeGroups.value.length || undefined },
  { label: '已完成', value: 'completed' }
])
const siblings = computed(
  () => allGroups.value.find((group) => group.jobs.some((job) => job.id === selectedId.value))?.jobs || []
)
function showDetail(id: string) {
  return router.replace({ query: { ...route.query, task: id || undefined } })
}
async function loadHistory() {
  if (historyLoading.value) return
  showHistory.value = true
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
const pending = computed(() => jobs.value.filter((j) => ['running', 'queued'].includes(j.status)))
const running = computed(() => jobs.value.filter((j) => j.status === 'running'))
const queued = computed(() => jobs.value.filter((j) => j.status === 'queued'))
const visible = computed(() => (activeTab.value === 'active' ? activeGroups.value : completedGroups.value))
const labels = {
  queued: '排队中',
  running: '处理中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消'
}
const projectName = (id: string) => projects.value.find((p) => p.id === id)?.name || '项目'
const projectPaused = (id: string) => projects.value.find((p) => p.id === id)?.paused || false
const failedJobs = (group: TaskGroup) => group.jobs.filter((job) => job.status === 'failed')
const queuedJobs = (group: TaskGroup) => group.jobs.filter((job) => job.status === 'queued')
const finishedCount = (group: TaskGroup) => group.jobs.filter((job) => job.status === 'completed').length
const skippedCount = (group: TaskGroup) => group.jobs.filter((job) => job.status === 'skipped').length

function taskSummary() {
  const queuedCount = queued.value.length
  if (running.value.length)
    return `${running.value.length} 个处理中${queuedCount ? ` · ${queuedCount} 个等待` : ''}`
  if (queuedCount) return `${queuedCount} 个待处理`
  return '空闲'
}

function showProgress(group: TaskGroup) {
  if (group.status === 'cancelled') return false
  return group.jobs.length > 1 || ['running', 'failed'].includes(group.status)
}

function groupMessage(group: TaskGroup) {
  if (group.status === 'cancelled') return '自动后续任务已取消，请核对结果后手动发起'
  const failures = failedJobs(group)
  if (failures.length) {
    const prefix = failures.length > 1 ? `${failures.length} 项失败：` : ''
    return `${prefix}${group.error || '执行失败，可重试或跳过'}`
  }

  if (group.kind === 'prepare') {
    const current = group.currentStage ? stageLabels[group.currentStage] : '素材预处理'
    const done = finishedCount(group)
    const skipped = skippedCount(group)
    const status =
      group.status === 'running'
        ? `当前：${current}`
        : group.status === 'queued'
          ? '等待前置处理'
          : group.status === 'completed'
            ? '前置处理完成'
            : '前置处理结束'
    return `${status} · 已完成 ${done} / ${group.jobs.length} 个阶段${skipped ? ` · 跳过 ${skipped}` : ''}`
  }

  if (['translate', 'synthesize'].includes(group.kind) && group.jobs.length > 1) {
    const skipped = skippedCount(group)
    const progress = group.status === 'running' && group.message ? ` · ${group.message}` : ''
    return `已完成 ${finishedCount(group)} / ${group.jobs.length} 句${
      skipped ? ` · 跳过 ${skipped}` : ''
    }${progress}`
  }

  if (group.kind === 'render' && group.currentStage) {
    return group.status === 'running'
      ? `当前：${stageLabels[group.currentStage]}`
      : group.message || '等待合成'
  }

  return group.message || labels[group.status]
}

async function groupAction(group: TaskGroup, action: 'retry' | 'skip', failedOnly = false) {
  const targets = group.jobs.filter((job: Job) => {
    if (action === 'retry' || failedOnly) return job.status === 'failed'
    return ['queued', 'failed'].includes(job.status)
  })
  if (!targets.length) return
  await act(async () => {
    for (const job of targets)
      await $fetch(`/api/jobs/${job.id}/${action}`, {
        method: 'POST'
      })
  })
}
onClickOutside(panelRef, () => {
  if (open.value) {
    open.value = false
  }
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    open.value = false
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
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
      <span class="task-indicator" :class="{ live: running.length }" />
      <span class="task-btn-label">任务</span>
      <span class="task-btn-summary">{{ taskSummary() }}</span>
      <UIcon :name="open ? 'i-carbon-chevron-right' : 'i-carbon-chevron-up'" class="task-btn-chevron" />
    </button>

    <aside v-if="open" class="task-popover-panel" aria-label="任务列表浮层">
      <UTabs
        v-model="activeTab"
        :items="tabs"
        color="neutral"
        variant="link"
        class="task-tabs"
        :ui="{ list: 'task-tabs-header', trigger: 'flex-1 py-2.5 text-xs font-medium', content: 'task-body' }"
      >
        <template #content>
          <div v-if="!visible.length" class="task-empty">
            {{ activeTab === 'active' ? '暂无进行中的任务' : '暂无已完成的任务' }}
          </div>
          <div v-for="group in visible" :key="group.id" class="task-item task-group">
            <div class="task-title">
              <div class="task-title-main">
                <strong>{{ group.title }}</strong>
                <span v-if="group.jobs.length > 1" class="task-count">{{ group.jobs.length }} 项</span>
              </div>
              <span :class="`status-${group.status}`">{{ labels[group.status] }}</span>
            </div>
            <div class="task-project-row">
              <p class="help task-project">
                {{ projectName(group.projectId) }}<span v-if="projectPaused(group.projectId)"> · 已暂停</span>
              </p>
              <div class="task-item-actions">
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-carbon-document"
                  title="查看详情"
                  aria-label="查看详情"
                  @click="showDetail(group.jobs[0]!.id)"
                />
                <UButton
                  v-if="failedJobs(group).length"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  icon="i-carbon-renew"
                  :title="failedJobs(group).length > 1 ? '重试失败项' : '重试'"
                  :aria-label="failedJobs(group).length > 1 ? '重试失败项' : '重试'"
                  @click="groupAction(group, 'retry')"
                />
                <UButton
                  v-if="failedJobs(group).length && group.jobs.length === 1"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-carbon-skip-forward"
                  :title="group.kind === 'synthesize' ? '保留原声并跳过' : '跳过'"
                  :aria-label="group.kind === 'synthesize' ? '保留原声并跳过' : '跳过'"
                  @click="groupAction(group, 'skip')"
                />
                <UButton
                  v-else-if="failedJobs(group).length"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-carbon-skip-forward"
                  title="跳过失败项"
                  aria-label="跳过失败项"
                  @click="groupAction(group, 'skip', true)"
                />
                <UButton
                  v-else-if="queuedJobs(group).length && group.jobs.length === 1"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-carbon-skip-forward"
                  :title="group.kind === 'synthesize' ? '保留原声并跳过' : '跳过'"
                  :aria-label="group.kind === 'synthesize' ? '保留原声并跳过' : '跳过'"
                  @click="groupAction(group, 'skip')"
                />
              </div>
            </div>
            <div v-if="showProgress(group)" class="task-progress">
              <UProgress :model-value="group.progress" size="sm" /><span>{{ group.progress }}%</span>
            </div>
            <p
              v-if="groupMessage(group) && groupMessage(group) !== labels[group.status]"
              class="job-message"
              :class="{ 'error-text': group.status === 'failed' }"
              :title="groupMessage(group)"
            >
              {{ groupMessage(group) }}
            </p>
          </div>
          <p v-if="activeTab === 'completed' && historyError" class="error-text" role="alert">
            {{ historyError }}
          </p>
          <UButton
            v-if="activeTab === 'completed' && (!showHistory || historyMore || historyError)"
            class="mt-4"
            block
            size="sm"
            color="neutral"
            variant="ghost"
            :loading="historyLoading"
            @click="loadHistory"
            >{{ showHistory ? '加载更多历史任务' : '查看全部历史任务' }}</UButton
          >
        </template>
      </UTabs>
    </aside>
  </div>
  <USlideover
    v-model:open="detailOpen"
    title="任务详情"
    description="查看执行状态、任务结果与完整网络请求"
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
