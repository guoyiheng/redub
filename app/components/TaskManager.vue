<script setup lang="ts">
import { onClickOutside, useIntersectionObserver } from '@vueuse/core'
import { isActiveTask } from '../../shared/task-groups'
import { stageLabels, type Job } from '../../shared/types'
import { formatVoiceName } from '../../shared/voice'

const { jobs, projects, act, errorMessage } = useStudio()
const route = useRoute()
const router = useRouter()
const navigation = useTaskNavigation()

const open = ref(false)
const isPinned = ref(false)
const isDragging = ref(false)
const topOffset = ref(520)

const containerRef = ref<HTMLElement | null>(null)
const handleRef = ref<HTMLElement | null>(null)
const sentinelRef = ref<HTMLElement | null>(null)

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

const selectedJob = computed(() => allJobs.value.find((job) => job.id === selectedId.value))
const siblings = computed(() =>
  selectedJob.value?.batchId ? allJobs.value.filter((job) => job.batchId === selectedJob.value?.batchId) : []
)

const running = computed(() => jobs.value.filter((j) => j.status === 'running'))
const queued = computed(() => jobs.value.filter((j) => j.status === 'queued'))
const activeCount = computed(() => running.value.length + queued.value.length)

const labels: Record<string, string> = {
  queued: '排队中',
  running: '处理中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消'
}

const projectName = (id?: string | null) =>
  id ? projects.value.find((p) => p.id === id)?.name || '项目' : ''

function parseJobInput(job: Job) {
  if (!job.input) return undefined
  if (typeof job.input === 'string') {
    try {
      return JSON.parse(job.input) as Record<string, any>
    } catch {
      return undefined
    }
  }
  return job.input as Record<string, any>
}

function title(job: Job) {
  if (job.stage === 'preview-voice') {
    const input = parseJobInput(job)
    const raw =
      input?.speakerLabel ||
      input?.speaker ||
      input?.voiceLabel ||
      input?.voice ||
      job.message?.replace(/^(?:正在合成音色试听|音色试听合成完成|音色试听合成失败):\s*/, '')
    const label = (raw ? formatVoiceName(raw) : '') || raw
    return label ? `音色试听 · ${label}` : '音色试听'
  }
  const stage =
    job.stage === 'translate' ? '翻译' : job.stage === 'synthesize' ? '配音' : stageLabels[job.stage]
  return job.segmentId
    ? `${stage} · ${job.segmentIndex ? `第 ${job.segmentIndex} 句` : '已删除的台词'}`
    : stage
}

function showDetail(id: string) {
  open.value = false
  isPinned.value = false
  return router.replace({ query: { ...route.query, task: id || undefined } })
}

function locate(job: Job) {
  open.value = false
  isPinned.value = false
  if (job.stage === 'preview-voice') {
    const input = parseJobInput(job)
    const speaker = typeof input?.speaker === 'string' ? input.speaker.trim() : ''
    const voice = typeof input?.voice === 'string' ? input.voice.trim() : ''
    const raw =
      input?.speakerLabel ||
      speaker ||
      input?.voiceLabel ||
      voice ||
      job.message?.replace(/^(?:正在合成音色试听|音色试听合成完成|音色试听合成失败):\s*/, '') ||
      ''
    const voiceType: 'ark' | 'tts' = voice ? 'tts' : 'ark'
    const voiceKey = speaker || voice || raw
    const voiceLabel = (raw ? formatVoiceName(raw) : '') || raw
    navigation.value = {
      type: 'voice',
      voiceKey,
      voiceType,
      voiceLabel,
      nonce: (navigation.value?.nonce || 0) + 1
    }
    return
  }
  if (!job.projectId) return
  navigation.value = {
    type: 'project',
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

// 悬停与展开交互
let leaveTimer: ReturnType<typeof setTimeout> | null = null

function onMouseEnter() {
  if (isDragging.value) return
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = null
  }
  open.value = true
}

function onMouseLeave() {
  if (isPinned.value || detailOpen.value) return
  if (leaveTimer) clearTimeout(leaveTimer)
  leaveTimer = setTimeout(() => {
    if (!isPinned.value && !detailOpen.value) {
      open.value = false
    }
  }, 220)
}

function togglePin() {
  isPinned.value = !isPinned.value
  if (isPinned.value) {
    open.value = true
  }
}

function closePanel() {
  isPinned.value = false
  open.value = false
}

// 拖动逻辑
let dragStartY = 0
let dragStartTop = 0
let hasMoved = false

function onPointerDown(e: PointerEvent) {
  if ((e.target as HTMLElement)?.closest('button, [role="button"]')) return
  dragStartY = e.clientY
  dragStartTop = topOffset.value
  hasMoved = false
  const target = e.currentTarget as HTMLElement
  target.setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (dragStartY === 0) return
  const deltaY = e.clientY - dragStartY
  if (!hasMoved && Math.abs(deltaY) > 3) {
    hasMoved = true
    isDragging.value = true
    open.value = false
  }
  if (isDragging.value && typeof window !== 'undefined') {
    topOffset.value = Math.max(60, Math.min(window.innerHeight - 70, dragStartTop + deltaY))
  }
}

function onPointerUp(e: PointerEvent) {
  if (dragStartY === 0) return
  try {
    const target = e.currentTarget as HTMLElement
    target.releasePointerCapture?.(e.pointerId)
  } catch {}
  if (isDragging.value) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('redub:task-manager-top', String(topOffset.value))
    }
    setTimeout(() => {
      isDragging.value = false
    }, 60)
  }
  dragStartY = 0
}

function onHandleClick(e: MouseEvent) {
  if (hasMoved) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  togglePin()
}

function onWindowResize() {
  if (typeof window === 'undefined') return
  topOffset.value = Math.max(60, Math.min(window.innerHeight - 70, topOffset.value))
}

const panelStyle = computed(() => {
  if (typeof window === 'undefined') {
    return { top: `${topOffset.value}px`, right: '10px' }
  }
  const panelHeight = Math.min(540, window.innerHeight - 80)
  let top = topOffset.value - panelHeight + 36
  if (top < 50) top = 50
  if (top + panelHeight > window.innerHeight - 16) {
    top = window.innerHeight - panelHeight - 16
  }
  return {
    top: `${top}px`,
    right: '10px',
    maxHeight: `${panelHeight}px`
  }
})

onClickOutside(
  containerRef,
  (event) => {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (
      target.closest(
        '[data-slot="content"], [role="listbox"], [role="menu"], [data-reka-popper-content-wrapper], [data-radix-popper-content-wrapper]'
      )
    )
      return
    closePanel()
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
  if (event.key === 'Escape') closePanel()
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('redub:task-manager-top')
    if (saved && !Number.isNaN(Number(saved))) {
      topOffset.value = Math.max(60, Math.min(window.innerHeight - 70, Number(saved)))
    } else {
      topOffset.value = Math.max(60, window.innerHeight - 90)
    }
    window.addEventListener('resize', onWindowResize)
    window.addEventListener('keydown', onKeydown)
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', onWindowResize)
    window.removeEventListener('keydown', onKeydown)
  }
  if (leaveTimer) clearTimeout(leaveTimer)
})
</script>

<template>
  <div
    ref="containerRef"
    class="floating-task-container"
    :class="{ open: open, dragging: isDragging }"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <!-- 收起状态：右侧贴边胶囊手柄，可上下拖动 -->
    <div
      ref="handleRef"
      class="floating-task-handle"
      :class="{ active: open || isPinned, live: running.length > 0 }"
      :style="{ top: `${topOffset}px` }"
      aria-label="任务面板（悬停展开，按住拖拽）"
      title="任务面板（悬停展开，点击固定，按住拖动位置）"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @click="onHandleClick"
    >
      <UIcon name="i-carbon-draggable" class="size-3.5 drag-grip shrink-0" />
      <span class="task-indicator shrink-0" :class="{ live: running.length > 0 }" />
      <span class="handle-title">任务</span>
      <UBadge v-if="activeCount > 0" color="primary" variant="solid" size="xs" class="handle-badge">
        {{ activeCount }}
      </UBadge>
      <span v-else-if="allJobs.length > 0" class="handle-count">
        {{ allJobs.length }}
      </span>
    </div>

    <!-- 展开状态：悬浮任务面板 -->
    <aside v-if="open" class="floating-task-panel" :style="panelStyle" aria-label="全部任务浮层">
      <header class="task-popover-header">
        <div class="task-header-left">
          <strong>全部任务</strong>
          <span v-if="running.length" class="task-header-badge live"> {{ running.length }} 个处理中 </span>
          <span v-else-if="allJobs.length" class="task-header-badge"> 共 {{ allJobs.length }} 个 </span>
        </div>
        <div class="task-header-right">
          <UButton
            color="neutral"
            :variant="isPinned ? 'soft' : 'ghost'"
            size="xs"
            class="header-icon-btn"
            :icon="isPinned ? 'i-carbon-pin-filled' : 'i-carbon-pin'"
            :aria-label="isPinned ? '已固定展示（点击取消固定）' : '固定面板'"
            :title="isPinned ? '已固定展示（点击取消固定）' : '固定面板'"
            @click="togglePin"
          />
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            class="header-icon-btn"
            icon="i-carbon-close"
            aria-label="收起任务面板"
            title="收起"
            @click="closePanel"
          />
        </div>
      </header>

      <div class="task-list-body" @scroll.passive="onListScroll">
        <div v-if="!allJobs.length" class="task-empty">
          <UIcon name="i-carbon-task" class="task-empty-icon" />
          <p>暂无任务记录</p>
        </div>
        <article
          v-for="job in allJobs"
          :key="job.id"
          class="task-card"
          :class="{ 'is-active': isActiveTask(job.status), 'is-failed': job.status === 'failed' }"
          :aria-label="job.projectId ? `${projectName(job.projectId)} · ${title(job)}` : title(job)"
          tabindex="0"
          @click="locate(job)"
          @keydown.enter.self.prevent="locate(job)"
          @keydown.space.self.prevent="locate(job)"
        >
          <div class="task-card-header">
            <div class="task-title-group">
              <span class="task-title-text" :title="title(job)">{{ title(job) }}</span>
              <span
                v-if="job.projectId && job.stage !== 'preview-voice'"
                class="task-project-pill"
                :title="projectName(job.projectId)"
              >
                {{ projectName(job.projectId) }}
              </span>
            </div>
            <span class="task-status-badge" :class="`status-${job.status}`">
              {{ labels[job.status] || job.status }}
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
                v-if="['failed', 'completed'].includes(job.status) && job.stage !== 'preview-voice'"
                color="neutral"
                variant="outline"
                size="xs"
                class="task-action-btn"
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
                class="task-action-btn"
                icon="i-carbon-document"
                aria-label="查看详情"
                title="查看详情"
                @click="showDetail(job.id)"
              />
              <UButton
                v-if="isActiveTask(job.status) && job.stage !== 'preview-voice'"
                color="neutral"
                variant="outline"
                size="xs"
                class="task-action-btn"
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
    <template #body>
      <TaskDetail
        v-if="selectedId"
        :key="selectedId"
        :job-id="selectedId"
        :siblings="siblings"
        @select="showDetail"
      />
    </template>
  </USlideover>
</template>

<style scoped>
.floating-task-container {
  position: static;
}

/* 右侧贴边手柄胶囊 */
.floating-task-handle {
  position: fixed;
  right: 0;
  z-index: 55;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px 0 8px;
  border-radius: 17px 0 0 17px;
  background: color-mix(in srgb, var(--ui-bg-elevated) 88%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--ui-border);
  border-right: none;
  box-shadow:
    -3px 4px 18px rgba(0, 0, 0, 0.14),
    -1px 2px 4px rgba(0, 0, 0, 0.08);
  cursor: grab;
  user-select: none;
  touch-action: none;
  transition:
    transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1),
    background 150ms ease,
    border-color 150ms ease,
    box-shadow 150ms ease;
}

.floating-task-handle:hover,
.floating-task-handle.active {
  background: var(--ui-bg-elevated);
  border-color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
  box-shadow:
    -4px 6px 24px rgba(0, 0, 0, 0.18),
    -1px 2px 6px rgba(0, 0, 0, 0.1);
}

.floating-task-handle:active,
.floating-task-container.dragging .floating-task-handle {
  cursor: grabbing;
  transform: scale(0.97);
}

.drag-grip {
  display: block;
  font-size: 14px;
  color: var(--ui-text-muted);
  opacity: 0.7;
  flex-shrink: 0;
  margin: auto 0;
}

.floating-task-handle:hover .drag-grip {
  opacity: 1;
}

.handle-title {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text);
  letter-spacing: 0.02em;
  line-height: 1;
}

.handle-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  padding: 0 5px;
  min-width: 18px;
  height: 18px;
  line-height: 1;
  border-radius: 9999px;
  margin: auto 0;
}

.handle-count {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-family: monospace;
  color: var(--ui-text-muted);
  line-height: 1;
}

/* 浮动任务面板 */
.floating-task-panel {
  position: fixed;
  z-index: 54;
  width: 380px;
  max-width: calc(100vw - 20px);
  border-radius: 12px;
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
  box-shadow:
    0 16px 48px rgba(0, 0, 0, 0.22),
    0 4px 12px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: task-panel-fade-in 160ms cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes task-panel-fade-in {
  from {
    opacity: 0;
    transform: translateX(12px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
}

.task-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 42px;
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
  font-size: 12px;
  font-weight: 500;
  background: var(--ui-bg-muted);
  color: var(--ui-text-muted);
  white-space: nowrap;
}

.task-header-badge.live {
  background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
  color: var(--ui-primary);
  font-weight: 600;
}

.task-header-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.task-list-body {
  flex: 1;
  overflow-y: auto;
  min-height: 120px;
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
  padding: 40px 16px;
  color: var(--ui-text-muted);
  font-size: 13px;
  gap: 8px;
}

.task-empty-icon {
  font-size: 28px;
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
  outline: 2px solid var(--ui-primary);
  outline-offset: -1px;
}

.task-card.is-active {
  border-color: color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border));
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
  font-size: 12px;
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
  font-size: 12px;
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
  background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
  color: var(--ui-primary);
  font-weight: 600;
}

.task-status-badge.status-completed {
  background: color-mix(in srgb, var(--ui-success) 12%, transparent);
  color: var(--ui-success);
}

.task-status-badge.status-failed {
  background: color-mix(in srgb, var(--ui-error) 12%, transparent);
  color: var(--ui-error);
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
  font-size: 12px;
  color: var(--ui-text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 28px;
  text-align: right;
  flex-shrink: 0;
}

.task-card-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-error);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  background: color-mix(in srgb, var(--ui-error) 8%, transparent);
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
  font-size: 12px;
  color: var(--ui-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.task-card-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-left: auto;
}

:deep(.task-action-btn),
:deep(.header-icon-btn) {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 28px !important;
  min-width: 28px !important;
  height: 28px !important;
  min-height: 28px !important;
  padding: 0 !important;
  border-radius: 6px;
  box-sizing: border-box;
}

:deep(.task-action-btn > *),
:deep(.header-icon-btn > *) {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  margin: auto !important;
}

:deep(.task-action-btn svg),
:deep(.task-action-btn [class*='i-']),
:deep(.task-action-btn .iconify),
:deep(.header-icon-btn svg),
:deep(.header-icon-btn [class*='i-']),
:deep(.header-icon-btn .iconify) {
  display: block !important;
  margin: auto !important;
  vertical-align: middle !important;
  flex-shrink: 0 !important;
}

@media (pointer: coarse) {
  :deep(.task-action-btn) {
    min-width: 40px !important;
    min-height: 40px !important;
    width: 40px !important;
    height: 40px !important;
  }
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

.task-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9c9c8e;
  flex-shrink: 0;
}

.task-indicator.live {
  background: var(--ui-primary);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.85);
  }
}
</style>
