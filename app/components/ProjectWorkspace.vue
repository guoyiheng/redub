<script setup lang="ts">
import type { Stage } from '../../shared/types'
const { detail, channels, settingsProject, act } = useStudio()
const current = ref<string>(),
  panel = ref<'script' | 'preview'>('script'),
  mode = ref<'original' | 'dubbed'>('original'),
  busy = ref(false),
  time = ref(0)
const player = ref<HTMLMediaElement>(),
  showOptions = ref(false),
  showTimeline = ref(false),
  showEditor = ref(false),
  showGeneration = ref(false),
  dirty = ref(false)
const options = ref({ name: '', sourceLanguage: 'auto', targetLanguage: '中文', channelId: '' })
const project = computed(() => detail.value!.project),
  lines = computed(() => detail.value?.segments || []),
  selected = computed(() => lines.value.find((s) => s.id === current.value))
const locked = computed(
  () => detail.value?.jobs.some((j) => ['queued', 'running'].includes(j.status)) || false
)
const completed = computed(() => lines.value.filter((s) => s.generatedPath).length),
  translated = computed(() => lines.value.filter((s) => s.translation || s.text).length)
const totalDuration = computed(() => Math.max(project.value.duration, ...lines.value.map((s) => s.end), 1))
const previewSource = computed(() =>
  mediaUrl(mode.value === 'original' ? project.value.sourcePath : project.value.outputPath)
)
const jobFor = (stage: Stage) => detail.value?.jobs.find((j) => j.stage === stage)
const nextStage = computed<Stage | undefined>(() => {
  if (project.value.outputPath) return undefined
  if (!lines.value.length && project.value.kind !== 'text') return undefined
  if (lines.value.length && translated.value < lines.value.length) return 'translate'
  if (lines.value.length && completed.value < lines.value.length) return 'synthesize'
  if (jobFor('mix')?.status !== 'completed') return 'mix'
  if (jobFor('preview')?.status !== 'completed') return 'preview'
  return undefined
})
const mainActionLabel = computed(() => {
  if (project.value.outputPath) return '导出成片'
  if (!lines.value.length && project.value.kind !== 'text') return '开始处理素材'
  if (nextStage.value === 'translate') return '翻译台词'
  if (nextStage.value === 'synthesize') return '生成配音'
  if (nextStage.value === 'mix') return '合并音轨'
  if (nextStage.value === 'preview') return '生成预览'
  return '开始处理'
})
watch(
  () => project.value.id,
  () => {
    current.value = lines.value[0]?.id
    panel.value = 'script'
    mode.value = 'original'
    showOptions.value = false
    showTimeline.value = false
    showEditor.value = false
    showGeneration.value = false
    dirty.value = false
  },
  { immediate: true }
)
watch(
  settingsProject,
  (id) => {
    if (id !== project.value.id) return
    openOptions()
    settingsProject.value = null
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
  const line = lines.value.find((s) => s.id === id)
  if (line && player.value) {
    player.value.currentTime = line.start
    time.value = line.start
  }
}
function openGeneration() {
  showEditor.value = false
  showGeneration.value = true
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
  if (!project.value.outputPath) await run(nextStage.value)
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
  showOptions.value = true
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
    const line = await $fetch<{ id: string }>(`/api/projects/${project.value.id}/segments`, {
      method: 'POST',
      body: { start, end, text: '', translation: '', speaker: '角色 1', enabled: true }
    })
    current.value = line.id
    showEditor.value = true
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
        <UButton v-if="project.outputPath" :href="mediaUrl(project.outputPath, true)" icon="i-carbon-download"
          >导出成片</UButton
        ><UButton
          v-else
          :loading="busy"
          :disabled="locked || (panel === 'script' && !lines.length && project.kind !== 'text')"
          :title="
            locked
              ? '任务执行中，完成后可操作'
              : panel === 'script' && !lines.length && project.kind !== 'text'
                ? '请先处理素材'
                : undefined
          "
          icon="i-carbon-play-filled-alt"
          @click="runMain"
          >{{ mainActionLabel }}</UButton
        >
      </div>
    </header>
    <div class="workspace-layout">
      <nav class="workspace-menu" aria-label="项目内容">
        <button :class="{ active: panel === 'script' }" @click="panel = 'script'">
          <UIcon name="i-carbon-script" /><span
            ><strong>台词 / 配音</strong><small>生成和替换声音片段</small></span
          >
        </button>
        <button :class="{ active: panel === 'preview' }" @click="panel = 'preview'">
          <UIcon name="i-carbon-play-outline" /><span
            ><strong>预览成片</strong><small>查看画面与全部音轨</small></span
          >
        </button>
        <div class="workspace-menu-bottom">
          <UButton
            v-if="locked || project.paused"
            color="neutral"
            variant="ghost"
            block
            :icon="project.paused ? 'i-carbon-play' : 'i-carbon-pause'"
            @click="pause"
            >{{ project.paused ? '继续处理' : '暂停处理' }}</UButton
          >
        </div>
      </nav>
      <div class="workspace-content">
        <section v-if="panel === 'script'" class="script-panel">
          <header class="content-heading">
            <div>
              <h2>台词 / 配音</h2>
              <p class="help">逐句编辑台词，生成或替换声音片段。</p>
            </div>
            <div class="row-actions">
              <span class="content-count">{{ completed }} / {{ lines.length }} 已生成</span
              ><UButton
                icon="i-carbon-add"
                color="neutral"
                variant="outline"
                :disabled="locked"
                :title="locked ? '任务执行中，完成后可添加片段' : undefined"
                @click="addLine"
                >添加片段</UButton
              >
            </div>
          </header>
          <div v-if="!lines.length" class="empty-state script-empty">
            <UIcon name="i-carbon-script" class="empty-icon" />
            <p>
              {{ project.kind === 'text' ? '添加台词片段后开始配音。' : '先处理素材，系统会自动识别台词。' }}
            </p>
            <UButton
              :disabled="locked"
              :title="locked ? '任务执行中，完成后可操作' : undefined"
              @click="runMain"
              >{{ project.kind === 'text' ? '开始翻译' : '处理素材' }}</UButton
            >
          </div>
          <div v-else class="segment-list segment-list-large">
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
              ><UBadge v-if="line.generatedPath" color="success" variant="soft">已生成</UBadge
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
        </section>
        <section v-else class="preview-panel">
          <header class="content-heading">
            <div>
              <h2>预览成片</h2>
              <p class="help">原始素材、背景音、配音和合并结果集中在这里试听。</p>
            </div>
            <div class="segmented" role="group" aria-label="预览音轨">
              <button
                :class="{ active: mode === 'original' }"
                :aria-pressed="mode === 'original'"
                :disabled="project.kind === 'text'"
                :title="project.kind === 'text' ? '文本项目没有原始音轨' : undefined"
                @click="switchMode('original')"
              >
                原始素材</button
              ><button
                :class="{ active: mode === 'dubbed' }"
                :aria-pressed="mode === 'dubbed'"
                :disabled="!project.outputPath"
                :title="!project.outputPath ? '完成合并后才能预览成片' : undefined"
                @click="switchMode('dubbed')"
              >
                配音成片
              </button>
            </div>
          </header>
          <div class="preview-stage preview-stage-large" :class="{ 'audio-stage': project.kind !== 'video' }">
            <video
              v-if="project.kind === 'video' && previewSource"
              ref="player"
              :src="previewSource"
              controls
              preload="metadata"
              @timeupdate="time = ($event.target as HTMLMediaElement).currentTime"
            /><template v-else
              ><UIcon
                :name="project.kind === 'text' ? 'i-carbon-quotes' : 'i-carbon-waveform'"
                class="preview-icon"
              /><audio
                v-if="previewSource && (project.kind !== 'text' || mode === 'dubbed')"
                ref="player"
                :src="previewSource"
                controls
                preload="metadata"
                @timeupdate="time = ($event.target as HTMLMediaElement).currentTime"
              />
              <p v-else>暂无可播放成片</p></template
            >
          </div>
          <div class="preview-audio-list">
            <div v-if="project.sourcePath" class="audio-track-card">
              <div><strong>原始音轨</strong><small>原始素材中的声音</small></div>
              <audio :src="mediaUrl(project.sourcePath)" controls preload="none" />
            </div>
            <div v-if="project.backgroundPath" class="audio-track-card">
              <div><strong>背景音</strong><small>保留的环境声与音乐</small></div>
              <audio :src="mediaUrl(project.backgroundPath)" controls preload="none" />
            </div>
            <div v-if="project.mixedPath" class="audio-track-card">
              <div><strong>合并音轨</strong><small>替换配音后的最终声音</small></div>
              <audio :src="mediaUrl(project.mixedPath)" controls preload="none" />
            </div>
          </div>
          <div class="preview-actions">
            <UButton
              v-if="project.mixedPath"
              :href="mediaUrl(`${project.id}/subtitles.srt`, true)"
              color="neutral"
              variant="outline"
              icon="i-carbon-closed-caption"
              >下载字幕 SRT</UButton
            ><span class="help">{{ formatTime(time) }} / {{ formatTime(totalDuration) }}</span>
          </div>
          <details
            class="preview-details"
            :open="showTimeline"
            @toggle="showTimeline = ($event.target as HTMLDetailsElement).open"
          >
            <summary>显示时间轴</summary>
            <div class="timeline timeline-inline">
              <div class="timeline-ruler">
                <span v-for="n in 6" :key="n">{{ formatTime((totalDuration * (n - 1)) / 5) }}</span>
              </div>
              <div class="timeline-track">
                <span class="track-label">原始音轨</span>
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
          </details>
        </section>
      </div>
    </div>
    <USlideover
      v-model:open="showEditor"
      title="编辑台词 / 配音"
      side="right"
      :ui="{ content: 'sm:max-w-lg' }"
      ><template #body
        ><SegmentEditor
          v-if="selected"
          :key="selected.id"
          :segment="selected"
          :locked="locked"
          @dirty="dirty = $event"
          @generate="openGeneration" /></template
    ></USlideover>
    <UDrawer
      v-model:open="showGeneration"
      direction="bottom"
      :handle="false"
      title="生成配音"
      :inset="true"
      :handle-only="true"
      :ui="{ content: 'generation-drawer ring-0', overlay: 'bg-black/15' }"
    >
      <template #content>
        <div class="generation-drawer-inner">
          <VoiceGenerationPanel
            v-if="selected"
            :segment="selected"
            :locked="locked"
            @close="showGeneration = false"
            @generated="showGeneration = false"
          />
        </div>
      </template>
    </UDrawer>
    <USlideover v-model:open="showOptions" title="项目设置" side="right" :ui="{ content: 'sm:max-w-md' }"
      ><template #body
        ><form class="project-options-form" @submit.prevent="saveOptions">
          <p class="help">修改后会清除已有配音结果。</p>
          <UFormField label="项目名称"
            ><UInput class="w-full" v-model="options.name" :disabled="locked" /></UFormField
          ><UFormField label="原始语言"
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
              ]" /></UFormField
          ><UFormField label="目标语言"
            ><USelect
              v-model="options.targetLanguage"
              class="w-full"
              :disabled="locked"
              :items="[
                { label: '中文', value: '中文' },
                { label: '英语', value: '英语' },
                { label: '日语', value: '日语' },
                { label: '韩语', value: '韩语' },
                { label: '西班牙语', value: '西班牙语' },
                { label: '法语', value: '法语' },
                { label: '德语', value: '德语' }
              ]" /></UFormField
          ><UFormField label="配音渠道"
            ><USelect
              v-model="options.channelId"
              class="w-full"
              :disabled="locked"
              :items="
                channels
                  .filter((c) => c.type === 'volcengine' && c.enabled)
                  .map((c) => ({ label: c.name, value: c.id }))
              " /></UFormField
          ><UButton type="submit" :disabled="locked">保存设置</UButton>
        </form></template
      ></USlideover
    >
  </section>
</template>
