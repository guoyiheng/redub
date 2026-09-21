<script setup lang="ts">
import { groupJobs, type TaskGroup } from '../../shared/task-groups'
import { stageLabels, type Job } from '../../shared/types'

const { jobs, projects, settings, act } = useStudio()
const open = ref(false)
const pending = computed(() => jobs.value.filter((j) => ['running', 'queued', 'failed'].includes(j.status)))
const running = computed(() => jobs.value.filter((j) => j.status === 'running'))
const visible = computed(() => groupJobs(jobs.value, 8))
const labels = {
  queued: '排队中',
  running: '处理中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过'
}
const projectName = (id: string) => projects.value.find((p) => p.id === id)?.name || '项目'
const projectPaused = (id: string) => projects.value.find((p) => p.id === id)?.paused || false
const failedJobs = (group: TaskGroup) => group.jobs.filter((job) => job.status === 'failed')
const queuedJobs = (group: TaskGroup) => group.jobs.filter((job) => job.status === 'queued')
const finishedCount = (group: TaskGroup) => group.jobs.filter((job) => job.status === 'completed').length
const skippedCount = (group: TaskGroup) => group.jobs.filter((job) => job.status === 'skipped').length

function taskSummary() {
  const queued = jobs.value.filter((job) => job.status === 'queued').length
  if (running.value.length) return `${running.value.length} 个处理中${queued ? ` · ${queued} 个等待` : ''}`
  if (pending.value.length) return `${pending.value.length} 个待处理`
  return '空闲'
}

function showProgress(group: TaskGroup) {
  return group.jobs.length > 1 || ['running', 'failed'].includes(group.status)
}

function groupMessage(group: TaskGroup) {
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

  if (group.kind === 'synthesize' && group.jobs.length > 1) {
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

async function concurrency(value: number) {
  await act(() =>
    $fetch('/api/settings', { method: 'PATCH', body: { ...settings.value, concurrency: value } })
  )
}
</script>
<template>
  <aside class="task-manager" :class="{ expanded: open }" aria-label="任务管理器">
    <button class="task-toggle" :aria-expanded="open" @click="open = !open">
      <span class="task-indicator" :class="{ live: running.length }" /><strong>任务</strong
      ><span>{{ taskSummary() }}</span
      ><UIcon :name="open ? 'i-carbon-chevron-down' : 'i-carbon-chevron-up'" />
    </button>
    <div v-if="open" class="task-body">
      <UFormField
        label="全局并发任务数"
        description="同时运行的任务总数；预处理、翻译、配音与合成共用此额度。"
        class="queue-settings"
        ><USelect
          :model-value="settings.concurrency"
          :items="[1, 2, 3, 4, 5, 6, 7, 8]"
          aria-label="全局并发任务数"
          @update:model-value="concurrency(Number($event))"
      /></UFormField>
      <div v-if="!visible.length" class="task-empty">暂无任务</div>
      <div v-for="group in visible" :key="group.id" class="task-item task-group">
        <div class="task-title">
          <div class="task-title-main">
            <strong>{{ group.title }}</strong>
            <span v-if="group.jobs.length > 1" class="task-count">{{ group.jobs.length }} 项</span>
          </div>
          <span :class="`status-${group.status}`">{{ labels[group.status] }}</span>
        </div>
        <p class="help task-project">
          {{ projectName(group.projectId) }}<span v-if="projectPaused(group.projectId)"> · 已暂停</span>
        </p>
        <div v-if="showProgress(group)" class="task-progress">
          <UProgress :model-value="group.progress" size="sm" /><span>{{ group.progress }}%</span>
        </div>
        <p
          class="job-message"
          :class="{ 'error-text': group.status === 'failed' }"
          :title="groupMessage(group)"
        >
          {{ groupMessage(group) }}
        </p>
        <div
          v-if="failedJobs(group).length || (group.jobs.length === 1 && queuedJobs(group).length)"
          class="row-actions"
        >
          <UButton
            v-if="failedJobs(group).length"
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-carbon-renew"
            @click="groupAction(group, 'retry')"
            >{{ failedJobs(group).length > 1 ? '重试失败项' : '重试' }}</UButton
          ><UButton
            v-if="failedJobs(group).length && group.jobs.length === 1"
            size="sm"
            color="neutral"
            variant="ghost"
            @click="groupAction(group, 'skip')"
            >{{ group.kind === 'synthesize' ? '保留原声并跳过' : '跳过' }}</UButton
          ><UButton
            v-else-if="failedJobs(group).length"
            size="sm"
            color="neutral"
            variant="ghost"
            @click="groupAction(group, 'skip', true)"
            >跳过失败项</UButton
          ><UButton
            v-else-if="queuedJobs(group).length && group.jobs.length === 1"
            size="sm"
            color="neutral"
            variant="ghost"
            @click="groupAction(group, 'skip')"
            >{{ group.kind === 'synthesize' ? '保留原声并跳过' : '跳过' }}</UButton
          >
        </div>
      </div>
    </div>
  </aside>
</template>
