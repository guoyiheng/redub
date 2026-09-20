<script setup lang="ts">
import { stageLabels, type Stage } from '../../shared/types'
const { detail, channels, act } = useStudio()
const current = ref<string>(),
  mode = ref<'original' | 'dubbed'>('original'),
  busy = ref(false),
  time = ref(0)
const player = ref<HTMLMediaElement>(),
  showOptions = ref(false),
  showTimeline = ref(false),
  showEditor = ref(false),
  dirty = ref(false)
const options = ref({ name: '', sourceLanguage: 'auto', targetLanguage: '中文', channelId: '' })
const project = computed(() => detail.value!.project)
const lines = computed(() => detail.value?.segments || [])
const selected = computed(() => lines.value.find((s) => s.id === current.value))
const locked = computed(
  () => detail.value?.jobs.some((j) => ['queued', 'running'].includes(j.status)) || false
)
const completed = computed(() => lines.value.filter((s) => s.generatedPath).length)
const translated = computed(() => lines.value.filter((s) => s.translation || s.text).length)
const totalDuration = computed(() => Math.max(project.value.duration, ...lines.value.map((s) => s.end), 1))
const previewSource = computed(() =>
  mediaUrl(mode.value === 'original' ? project.value.sourcePath : project.value.outputPath)
)
const pipelineSteps = computed(() => [
  {
    name: '准备素材',
    icon: 'i-carbon-music',
    stages: (project.value.kind === 'video'
      ? ['extract', 'separate', 'segment', 'transcribe']
      : project.value.kind === 'audio'
        ? ['separate', 'segment', 'transcribe']
        : []) as Stage[],
    skipped: project.value.kind === 'text'
  },
  {
    name: '整理台词',
    icon: 'i-carbon-language',
    stages: ['translate'] as Stage[],
    skipped: false
  },
  {
    name: '生成配音',
    icon: 'i-carbon-microphone',
    stages: ['synthesize', 'mix', 'preview'] as Stage[],
    skipped: false
  },
  { name: '导出成片', icon: 'i-carbon-download', stages: [] as Stage[], skipped: false }
])
const jobFor = (stage: Stage) => detail.value?.jobs.find((j) => j.stage === stage)
const stepState = (stages: Stage[]) => {
  const statuses = stages.map((s) => jobFor(s)?.status)
  if (statuses.includes('running')) return 'running'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.every((s) => s === 'completed' || s === 'skipped')) return 'completed'
  return 'pending'
}
const activeStep = computed(() => {
  if (project.value.outputPath) return 3
  if (jobFor('mix')?.status === 'completed' || jobFor('preview')?.status === 'completed') return 3
  if (completed.value) return 2
  if (lines.value.length) return 1
  return project.value.kind === 'text' ? 1 : 0
})
const currentStep = computed(() => pipelineSteps.value[activeStep.value])
const nextStage = computed<Stage | undefined>(() => {
  if (project.value.outputPath) return undefined
  if (!lines.value.length && project.value.kind !== 'text') return undefined
  if (project.value.kind === 'text' && !lines.value.length) return 'translate'
  if (lines.value.length && translated.value < lines.value.length) return 'translate'
  if (lines.value.length && completed.value < lines.value.length) return 'synthesize'
  if (jobFor('mix')?.status !== 'completed') return 'mix'
  if (jobFor('preview')?.status !== 'completed') return 'preview'
  return undefined
})
const currentStepState = computed(() => {
  const stages = currentStep.value?.stages || []
  return stages.length ? stepState(stages) : project.value.outputPath ? 'completed' : 'pending'
})
const mainActionLabel = computed(() => {
  if (project.value.outputPath) return '下载成片'
  if (!lines.value.length && project.value.kind !== 'text') return '开始处理素材'
  if (nextStage.value === 'translate') return '翻译台词'
  if (nextStage.value === 'synthesize') return '生成配音'
  if (nextStage.value === 'mix') return '合并音轨'
  if (nextStage.value === 'preview') return '生成预览'
  return '重新开始流程'
})
watch(
  () => project.value.id,
  () => {
    current.value = lines.value[0]?.id
    mode.value = 'original'
    showOptions.value = false
    showTimeline.value = false
    showEditor.value = false
    dirty.value = false
  },
  { immediate: true }
)
watch(lines, (value) => {
  if (!current.value || !value.some((s) => s.id === current.value)) current.value = value[0]?.id
})
function selectLine(id: string) {
  if (dirty.value && !window.confirm('片段有未保存的修改，放弃修改并切换？')) return
  dirty.value = false
  current.value = id
  showEditor.value = true
  const s = lines.value.find((s) => s.id === id)
  if (s && player.value) {
    player.value.currentTime = s.start
    time.value = s.start
  }
}
async function run(stage?: Stage) {
  if (dirty.value) {
    useToast().add({ title: '请先保存片段修改', color: 'warning' })
    return
  }
  busy.value = true
  await act(
    () => $fetch(`/api/projects/${project.value.id}/run`, { method: 'POST', body: stage ? { stage } : {} }),
    '任务已加入队列'
  )
  busy.value = false
}
async function runMain() {
  if (project.value.outputPath) return
  if (!nextStage.value) return run()
  return run(nextStage.value)
}
async function pause() {
  await act(() =>
    $fetch(`/api/projects/${project.value.id}/pause`, {
      method: 'POST',
      body: { paused: !project.value.paused }
    })
  )
}
function openOptions() {
  options.value = {
    name: project.value.name,
    sourceLanguage: project.value.sourceLanguage,
    targetLanguage: project.value.targetLanguage,
    channelId: project.value.channelId
  }
  showOptions.value = !showOptions.value
}
async function saveOptions() {
  if (
    await act(
      () => $fetch(`/api/projects/${project.value.id}`, { method: 'PATCH', body: options.value }),
      '项目设置已保存'
    )
  )
    showOptions.value = false
}
async function addLine() {
  const start = lines.value.at(-1)?.end || 0,
    end = project.value.kind === 'text' ? start + 4 : Math.min(start + 4, project.value.duration)
  if (end <= start) {
    useToast().add({ title: '素材已没有可添加的时间范围', color: 'warning' })
    return
  }
  await act(async () => {
    const s = await $fetch<{ id: string }>(`/api/projects/${project.value.id}/segments`, {
      method: 'POST',
      body: { start, end, text: '', translation: '', speaker: '角色 1', enabled: true }
    })
    current.value = s.id
  }, '片段已添加')
}
function switchMode(value: 'original' | 'dubbed') {
  const position = player.value?.currentTime || 0
  player.value?.pause()
  mode.value = value
  nextTick(() => {
    if (player.value)
      player.value.onloadedmetadata = () => {
        if (player.value) player.value.currentTime = Math.min(position, player.value.duration || 0)
      }
  })
}
</script>
<template>
  <section v-if="detail" class="workspace">
    <header class="workspace-header page-header">
      <div>
        <h1>{{ project.name }}</h1>
        <p class="help">
          {{ project.kind === 'video' ? '视频' : project.kind === 'audio' ? '音频' : '文本' }} ·
          {{ formatTime(totalDuration) }} · {{ project.targetLanguage }}
        </p>
      </div>
      <div class="row-actions">
        <UButton icon="i-carbon-settings-adjust" color="neutral" variant="ghost" @click="openOptions"
          >设置</UButton
        ><UButton
          v-if="project.outputPath"
          :href="mediaUrl(project.outputPath, true)"
          icon="i-carbon-download"
          >导出成片</UButton
        ><UButton
          v-else
          :loading="busy"
          :disabled="locked || (activeStep === 0 && lines.length > 0 && project.kind !== 'text')"
          icon="i-carbon-play-filled-alt"
          @click="runMain"
          >{{ mainActionLabel }}</UButton
        >
      </div>
    </header>
    <section class="workflow-bar" aria-label="配音主流程">
      <div
        v-for="(step, index) in pipelineSteps"
        :key="step.name"
        class="workflow-step"
        :class="{
          active: activeStep === index,
          completed: index < activeStep || (index === activeStep && currentStepState === 'completed')
        }"
      >
        <span class="workflow-index"
          ><UIcon
            v-if="index < activeStep || (index === activeStep && currentStepState === 'completed')"
            name="i-carbon-checkmark"
          /><template v-else>{{ index + 1 }}</template></span
        >
        <span>{{ step.name }}</span
        ><small v-if="activeStep === index">{{
          currentStepState === 'running' ? '处理中' : currentStepState === 'failed' ? '失败' : '当前'
        }}</small>
      </div>
    </section>
    <div class="step-toolbar">
      <div class="row-actions">
        <UButton
          v-if="locked || project.paused"
          color="neutral"
          variant="ghost"
          :icon="project.paused ? 'i-carbon-play' : 'i-carbon-pause'"
          @click="pause"
          >{{ project.paused ? '继续队列' : '暂停队列' }}</UButton
        ><UButton
          v-if="nextStage"
          color="neutral"
          variant="outline"
          :disabled="locked"
          :loading="busy"
          @click="runMain"
          >重新执行当前阶段</UButton
        >
      </div>
    </div>
    <div class="editing-grid workspace-focus">
      <div class="preview-column">
        <div class="panel-heading">
          <h2>预览</h2>
          <div class="segmented" role="group" aria-label="预览音轨">
            <button
              :class="{ active: mode === 'original' }"
              :aria-pressed="mode === 'original'"
              :disabled="project.kind === 'text'"
              @click="switchMode('original')"
            >
              原始素材</button
            ><button
              :class="{ active: mode === 'dubbed' }"
              :aria-pressed="mode === 'dubbed'"
              :disabled="!project.outputPath"
              @click="switchMode('dubbed')"
            >
              配音成片
            </button>
          </div>
        </div>
        <div class="preview-stage" :class="{ 'audio-stage': project.kind !== 'video' }">
          <video
            v-if="project.kind === 'video' && previewSource"
            ref="player"
            :src="previewSource"
            controls
            preload="metadata"
            @timeupdate="time = ($event.target as HTMLMediaElement).currentTime"
          />
          <template v-else
            ><UIcon
              :name="project.kind === 'text' ? 'i-carbon-quotes' : 'i-carbon-waveform'"
              class="preview-icon"
            />
            <audio
              v-if="previewSource && (project.kind !== 'text' || mode === 'dubbed')"
              ref="player"
              :src="previewSource"
              controls
              preload="metadata"
              @timeupdate="time = ($event.target as HTMLMediaElement).currentTime"
            />
            <p v-else>暂无配音</p></template
          >
        </div>
        <div v-if="project.mixedPath || project.backgroundPath" class="stem-list">
          <div v-if="project.backgroundPath">
            <label>背景音</label><audio :src="mediaUrl(project.backgroundPath)" controls preload="none" />
          </div>
          <div v-if="project.mixedPath">
            <label>合并音轨</label><audio :src="mediaUrl(project.mixedPath)" controls preload="none" />
          </div>
          <UButton
            v-if="project.mixedPath"
            :href="mediaUrl(`${project.id}/subtitles.srt`, true)"
            color="neutral"
            variant="link"
            icon="i-carbon-closed-caption"
            >下载字幕 SRT</UButton
          >
        </div>
      </div>
      <div class="script-column">
        <div class="panel-heading">
          <h2>
            台词 <small>{{ completed }} / {{ lines.length }} 已配音</small>
          </h2>
          <UButton icon="i-carbon-add" color="neutral" variant="ghost" :disabled="locked" @click="addLine"
            >添加片段</UButton
          >
        </div>
        <div v-if="!lines.length" class="empty-state">
          <p>暂无片段</p>
          <UButton :disabled="locked" color="neutral" variant="outline" @click="runMain"
            >开始处理素材</UButton
          >
        </div>
        <template v-else
          ><div class="segment-list">
            <button
              v-for="(line, i) in lines"
              :key="line.id"
              class="segment-row"
              :class="{ active: current === line.id, disabled: !line.enabled }"
              @click="selectLine(line.id)"
            >
              <span class="line-index">{{ String(i + 1).padStart(2, '0') }}</span
              ><span class="line-copy"
                ><small
                  >{{ formatTime(line.start) }} — {{ formatTime(line.end) }}
                  <span>{{ line.speaker }}</span></small
                ><strong>{{ line.translation || line.text || '等待识别台词…' }}</strong
                ><span v-if="line.translation" class="source-text">{{ line.text }}</span></span
              ><UIcon
                :name="
                  !line.enabled
                    ? 'i-carbon-volume-mute'
                    : line.generatedPath
                      ? 'i-carbon-checkmark-outline'
                      : 'i-carbon-chevron-right'
                "
              />
            </button>
          </div>
          /></template
        >
      </div>
    </div>
    <section class="timeline-collapsible">
      <button class="timeline-toggle" :aria-expanded="showTimeline" @click="showTimeline = !showTimeline">
        <span>更多信息</span
        ><small>{{ lines.length }} 个片段 · {{ formatTime(time) }} / {{ formatTime(totalDuration) }}</small
        ><UIcon :name="showTimeline ? 'i-carbon-chevron-up' : 'i-carbon-chevron-down'" />
      </button>
      <div v-if="showTimeline" class="timeline">
        <div class="panel-heading">
          <h2>时间轴</h2>
          <span class="help">{{ formatTime(time) }} / {{ formatTime(totalDuration) }}</span>
        </div>
        <div class="timeline-ruler">
          <span v-for="n in 6" :key="n">{{ formatTime((totalDuration * (n - 1)) / 5) }}</span>
        </div>
        <div class="timeline-track">
          <span class="track-label">{{ project.kind === 'text' ? '文本' : '原始音轨' }}</span>
          <div class="original-track" />
        </div>
        <div class="timeline-track">
          <span class="track-label">配音片段</span>
          <div class="dub-track">
            <button
              v-for="(line, i) in lines"
              :key="line.id"
              :title="`片段 ${i + 1}：${line.translation || line.text}`"
              :aria-label="`选择片段 ${i + 1}`"
              :style="{
                left: `${(line.start / totalDuration) * 100}%`,
                width: `${((line.end - line.start) / totalDuration) * 100}%`
              }"
              :class="{ ready: line.generatedPath, muted: !line.enabled, active: line.id === current }"
              @click="selectLine(line.id)"
            >
              {{ i + 1 }}</button
            ><span v-if="!lines.length" class="help">等待分段</span>
          </div>
        </div>
      </div>
    </section>
    <USlideover v-model:open="showEditor" title="编辑台词" side="right" :ui="{ content: 'sm:max-w-lg' }">
      <template #body
        ><SegmentEditor
          v-if="selected"
          :key="selected.id"
          :segment="selected"
          :locked="locked"
          @dirty="dirty = $event"
      /></template>
    </USlideover>
    <USlideover v-model:open="showOptions" title="项目设置" side="right" :ui="{ content: 'sm:max-w-md' }">
      <template #body>
        <form class="project-options-form" @submit.prevent="saveOptions">
          <p class="help">修改后会清除已有配音结果。</p>
          <UFormField label="项目名称"
            ><UInput class="w-full" v-model="options.name" :disabled="locked"
          /></UFormField>
          <UFormField label="原始语言"
            ><USelect
              v-model="options.sourceLanguage"
              class="w-full"
              :disabled="locked"
              :items="[
                { label: '自动检测', value: 'auto' },
                { label: '中文', value: 'zh' },
                { label: '英语', value: 'en' },
                { label: '日语', value: 'ja' },
                { label: '韩语', value: 'ko' }
              ]"
          /></UFormField>
          <UFormField label="目标语言"
            ><UInput class="w-full" v-model="options.targetLanguage" :disabled="locked"
          /></UFormField>
          <UFormField label="配音渠道"
            ><USelect
              v-model="options.channelId"
              class="w-full"
              :disabled="locked"
              :items="
                channels
                  .filter((c) => c.type === 'volcengine' && c.enabled)
                  .map((c) => ({ label: c.name, value: c.id }))
              "
          /></UFormField>
          <UButton type="submit" :disabled="locked">保存设置</UButton>
        </form>
      </template>
    </USlideover>
  </section>
</template>
