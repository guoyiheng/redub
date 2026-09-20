<script setup lang="ts">
import { stageLabels, type Stage } from '../../shared/types'
const { detail, channels, act, refresh } = useStudio()
const current = ref<string>(),
  mode = ref<'original' | 'dubbed'>('original'),
  activeStep = ref(0),
  busy = ref(false),
  time = ref(0)
const player = ref<HTMLMediaElement>(),
  showOptions = ref(false),
  dirty = ref(false)
const options = ref({ name: '', sourceLanguage: 'auto', targetLanguage: '中文', channelId: '' })
const project = computed(() => detail.value!.project)
const lines = computed(() => detail.value?.segments || [])
const selected = computed(() => lines.value.find((s) => s.id === current.value))
const locked = computed(
  () => detail.value?.jobs.some((j) => ['queued', 'running'].includes(j.status)) || false
)
const completed = computed(() => lines.value.filter((s) => s.generatedPath).length)
const totalDuration = computed(() => Math.max(project.value.duration, ...lines.value.map((s) => s.end), 1))
const previewSource = computed(() =>
  mediaUrl(mode.value === 'original' ? project.value.sourcePath : project.value.outputPath)
)
const steps = computed(() => [
  {
    name: '音轨提取',
    icon: 'i-carbon-music',
    stages: ['extract'] as Stage[],
    skipped: project.value.kind !== 'video'
  },
  {
    name: '人声分段',
    icon: 'i-carbon-waveform',
    stages: ['separate', 'segment'] as Stage[],
    skipped: project.value.kind === 'text'
  },
  {
    name: '台词与翻译',
    icon: 'i-carbon-language',
    stages: (project.value.kind === 'text' ? ['translate'] : ['transcribe', 'translate']) as Stage[],
    skipped: false
  },
  { name: 'AI 配音', icon: 'i-carbon-microphone', stages: ['synthesize'] as Stage[], skipped: false },
  { name: '音轨合并', icon: 'i-carbon-volume-up', stages: ['mix'] as Stage[], skipped: false },
  { name: '对比与预览', icon: 'i-carbon-play', stages: ['preview'] as Stage[], skipped: false }
])
const jobFor = (stage: Stage) => detail.value?.jobs.find((j) => j.stage === stage)
const stepState = (stages: Stage[]) => {
  const statuses = stages.map((s) => jobFor(s)?.status)
  if (statuses.includes('running')) return 'running'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.every((s) => s === 'completed' || s === 'skipped')) return 'completed'
  return 'pending'
}
watch(
  () => project.value.id,
  () => {
    current.value = lines.value[0]?.id
    mode.value = 'original'
    activeStep.value = project.value.kind === 'text' ? 2 : project.value.kind === 'audio' ? 1 : 0
    showOptions.value = false
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
    <header class="workspace-header">
      <div>
        <p class="eyebrow">
          DUBBING WORKSPACE <span>/</span>
          {{ project.kind === 'video' ? '视频项目' : project.kind === 'audio' ? '音频项目' : '文本项目' }}
        </p>
        <h1>{{ project.name }}</h1>
        <p class="help">
          {{ formatTime(totalDuration) }} <span>·</span> {{ lines.length }} 个片段 <span>·</span>
          {{ project.targetLanguage }} <span>·</span> 本地保存
        </p>
      </div>
      <div class="row-actions">
        <UButton icon="i-carbon-settings-adjust" color="neutral" variant="outline" @click="openOptions"
          >项目设置</UButton
        ><UButton
          v-if="project.outputPath"
          :href="mediaUrl(project.outputPath, true)"
          icon="i-carbon-download"
          >导出成片</UButton
        ><UButton
          v-else
          :loading="busy"
          :disabled="locked || (lines.length > 0 && project.kind !== 'text')"
          icon="i-carbon-play-filled-alt"
          @click="run()"
          >启动完整流程</UButton
        >
      </div>
    </header>
    <form v-if="showOptions" class="project-options" @submit.prevent="saveOptions">
      <UFormField label="项目名称"><UInput v-model="options.name" :disabled="locked" /></UFormField
      ><UFormField label="原始语言"
        ><USelect
          v-model="options.sourceLanguage"
          :disabled="locked"
          :items="[
            { label: '自动检测', value: 'auto' },
            { label: '中文', value: 'zh' },
            { label: '英语', value: 'en' },
            { label: '日语', value: 'ja' },
            { label: '韩语', value: 'ko' }
          ]" /></UFormField
      ><UFormField label="目标语言"><UInput v-model="options.targetLanguage" :disabled="locked" /></UFormField
      ><UFormField label="配音渠道"
        ><USelect
          v-model="options.channelId"
          :disabled="locked"
          :items="
            channels
              .filter((c) => c.type === 'volcengine' && c.enabled)
              .map((c) => ({ label: c.name, value: c.id }))
          " /></UFormField
      ><UButton type="submit" :disabled="locked">保存设置</UButton>
      <p class="help">修改语言或配音渠道会使已有配音失效，需要重新生成。</p>
    </form>
    <nav class="workflow" aria-label="配音步骤">
      <button
        v-for="(step, index) in steps"
        :key="step.name"
        :class="{
          selected: activeStep === index,
          skipped: step.skipped,
          [stepState(step.stages)]: !step.skipped
        }"
        :disabled="step.skipped"
        @click="activeStep = index"
      >
        <span class="step-number"
          ><UIcon
            v-if="!step.skipped && stepState(step.stages) === 'completed'"
            name="i-carbon-checkmark"
          /><template v-else>{{ String(index + 1).padStart(2, '0') }}</template></span
        ><span
          >{{ step.name
          }}<small>{{
            step.skipped
              ? '无需此步骤'
              : stepState(step.stages) === 'running'
                ? '处理中'
                : stepState(step.stages) === 'failed'
                  ? '需要处理'
                  : stepState(step.stages) === 'completed'
                    ? '已完成'
                    : '准备就绪'
          }}</small></span
        >
      </button>
    </nav>
    <div class="step-toolbar">
      <div>
        <UIcon :name="steps[activeStep]?.icon || 'i-carbon-music'" class="size-5" /><strong>{{
          steps[activeStep]?.name
        }}</strong
        ><span class="help">每一步独立执行，可随时校对与重试</span>
      </div>
      <div class="row-actions">
        <UButton
          v-if="locked || project.paused"
          color="neutral"
          variant="ghost"
          :icon="project.paused ? 'i-carbon-play' : 'i-carbon-pause'"
          @click="pause"
          >{{ project.paused ? '继续队列' : '完成当前任务后暂停' }}</UButton
        ><UButton
          v-for="stage in steps[activeStep]?.stages"
          :key="stage"
          color="neutral"
          variant="outline"
          size="sm"
          :disabled="locked || (stage === 'segment' && !!lines.length)"
          :loading="busy"
          @click="run(stage)"
          >{{ stageLabels[stage] }}</UButton
        >
      </div>
    </div>
    <div class="editing-grid">
      <div class="preview-column">
        <div class="panel-heading">
          <h2>画面与声音</h2>
          <div class="segmented compact">
            <button
              :class="{ active: mode === 'original' }"
              :disabled="project.kind === 'text'"
              @click="switchMode('original')"
            >
              原始素材</button
            ><button
              :class="{ active: mode === 'dubbed' }"
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
            <h3>{{ project.kind === 'text' ? '每一句，都有新的可能。' : '专注于声音本身。' }}</h3>
            <audio
              v-if="previewSource && (project.kind !== 'text' || mode === 'dubbed')"
              ref="player"
              :src="previewSource"
              controls
              preload="metadata"
              @timeupdate="time = ($event.target as HTMLMediaElement).currentTime"
            />
            <p v-else>完成配音与合并后，在这里试听。</p></template
          >
        </div>
        <p class="preview-note">
          <UIcon name="i-carbon-headphones" /> 建议使用耳机，比较原声、语气和背景的连续性。
        </p>
        <div v-if="project.mixedPath || project.backgroundPath" class="stem-list">
          <div v-if="project.backgroundPath">
            <label>分离后的背景音</label
            ><audio :src="mediaUrl(project.backgroundPath)" controls preload="none" />
          </div>
          <div v-if="project.mixedPath">
            <label>合并后的完整音轨</label
            ><audio :src="mediaUrl(project.mixedPath)" controls preload="none" />
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
        <div class="project-note">
          <UIcon name="i-carbon-information" />
          <p>仅替换已启用的片段。其余原声保留，配音会自动对齐原片段时长。</p>
        </div>
      </div>
      <div class="script-column">
        <div class="panel-heading">
          <h2>
            台词工作区 <small>{{ completed }} / {{ lines.length }} 已配音</small>
          </h2>
          <UButton
            icon="i-carbon-add"
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="locked"
            @click="addLine"
            >添加片段</UButton
          >
        </div>
        <div v-if="!lines.length" class="script-empty">
          <UIcon name="i-carbon-text-align-left" class="size-8" />
          <h3>先听见，再看见</h3>
          <p>运行人声分离与分段，台词片段将在这里出现。<br />也可以手动添加片段。</p>
          <UButton :disabled="locked" color="neutral" variant="outline" @click="activeStep = 1"
            >前往人声分段</UButton
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
          <SegmentEditor
            v-if="selected"
            :key="selected.id"
            :segment="selected"
            :locked="locked"
            @dirty="dirty = $event"
        /></template>
      </div>
    </div>
    <section class="timeline">
      <div class="panel-heading">
        <h2>声音时间轴</h2>
        <span class="help">{{ formatTime(time) }} / {{ formatTime(totalDuration) }}</span>
      </div>
      <div class="timeline-ruler">
        <span v-for="n in 6" :key="n">{{ formatTime((totalDuration * (n - 1)) / 5) }}</span>
      </div>
      <div class="timeline-track">
        <span class="track-label">原始音轨</span>
        <div class="original-track">
          <span>{{ project.kind === 'text' ? '文本时间轴' : '原始素材 · 保留未替换部分' }}</span>
        </div>
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
    </section>
  </section>
</template>
