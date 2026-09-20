<script setup lang="ts">
import { stageLabels } from '../../shared/types'
const { jobs, projects, settings, act } = useStudio()
const open = ref(false)
const pending = computed(() => jobs.value.filter((j) => ['running', 'queued', 'failed'].includes(j.status)))
const running = computed(() => jobs.value.filter((j) => j.status === 'running'))
const visible = computed(() => [
  ...pending.value,
  ...jobs.value.filter((j) => !['running', 'queued', 'failed'].includes(j.status)).slice(0, 8)
])
const labels = { queued: '排队中', running: '处理中', completed: '已完成', failed: '失败', skipped: '已跳过' }
const projectName = (id: string) => projects.value.find((p) => p.id === id)?.name || '项目'
async function jobAction(id: string, action: 'retry' | 'skip') {
  await act(() => $fetch(`/api/jobs/${id}/${action}`, { method: 'POST' }))
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
      <span class="task-indicator" :class="{ live: running.length }" /><strong>任务管理器</strong
      ><span>{{
        running.length
          ? `${running.length} 个处理中`
          : pending.length
            ? `${pending.length} 个待处理`
            : '队列空闲'
      }}</span
      ><UIcon :name="open ? 'i-carbon-chevron-down' : 'i-carbon-chevron-up'" />
    </button>
    <div v-if="open" class="task-body">
      <div class="queue-settings">
        <label for="queue-concurrency">最大同时任务数</label
        ><select
          id="queue-concurrency"
          :value="settings.concurrency"
          @change="concurrency(Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="n in 8" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
      <p class="help">同一项目按顺序处理，多个项目可并行。</p>
      <div v-if="!visible.length" class="task-empty">开始一个处理步骤后，进度会显示在这里。</div>
      <div v-for="job in visible" :key="job.id" class="task-item">
        <div class="task-title">
          <strong>{{ stageLabels[job.stage] }}</strong
          ><span :class="`status-${job.status}`">{{ labels[job.status] }}</span>
        </div>
        <p class="help">
          {{ projectName(job.projectId)
          }}{{ projects.find((p) => p.id === job.projectId)?.paused ? ' · 已暂停' : '' }}
        </p>
        <UProgress v-if="job.status === 'running'" :model-value="job.progress || undefined" size="xs" />
        <p class="job-message" :class="{ 'error-text': job.status === 'failed' }">
          {{ job.error || job.message }}
        </p>
        <div v-if="['failed', 'queued'].includes(job.status)" class="row-actions">
          <UButton
            v-if="job.status === 'failed'"
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-carbon-renew"
            @click="jobAction(job.id, 'retry')"
            >重试</UButton
          ><UButton size="xs" color="neutral" variant="ghost" @click="jobAction(job.id, 'skip')">{{
            job.stage === 'synthesize' ? '跳过并保留未配音原声' : '跳过此任务'
          }}</UButton>
        </div>
      </div>
    </div>
  </aside>
</template>
