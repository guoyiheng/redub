<script setup lang="ts">
import type { BatchInput } from '../../shared/batch'
import { languageOptions, normalizeLanguage } from '../../shared/languages'
const { detail, channels, settingsProject, workspacePanels, act } = useStudio()
const batchAction = ref<BatchInput['action']>('synthesize')
const current = ref<string>()
const mode = ref<'original' | 'dubbed'>('original')
const time = ref(0)
const player = ref<HTMLMediaElement>()
const showOptions = ref(false),
  showTimeline = ref(false),
  showEditor = ref(false),
  showGeneration = ref(false),
  showBatch = ref(false),
  dirty = ref(false),
  savingOptions = ref(false)
const options = ref({ name: '', sourceLanguage: 'auto', targetLanguage: '中文', channelId: '' })
const project = computed(() => detail.value!.project)
const panel = computed(() => workspacePanels.value[project.value.id] || 'script')
const lines = computed(() => detail.value?.segments || [])
const selected = computed(() => lines.value.find((s) => s.id === current.value))
const locked = computed(
  () => detail.value?.jobs.some((j) => ['queued', 'running'].includes(j.status)) || false
)
const completed = computed(() => lines.value.filter((s) => s.enabled && s.generatedPath).length)
const enabledCount = computed(() => lines.value.filter((s) => s.enabled).length)
const totalDuration = computed(() => Math.max(project.value.duration, ...lines.value.map((s) => s.end), 1))
const previewSource = computed(() =>
  mediaUrl(mode.value === 'original' ? project.value.sourcePath : project.value.outputPath)
)
const addReason = computed(() =>
  locked.value
    ? '请等待当前项目任务完成'
    : project.value.kind !== 'text' && (lines.value.at(-1)?.end || 0) >= project.value.duration
      ? '素材末尾没有空余时间，可编辑现有台词的时间范围'
      : ''
)
const generationBlock = computed(() => {
  const active = detail.value?.jobs.filter((j) => ['queued', 'running'].includes(j.status)) || []
  if (active.some((j) => j.stage !== 'synthesize' || !j.segmentId))
    return '项目正在处理素材、翻译或合成，请完成后再生成本句'
  if (active.some((j) => j.stage === 'synthesize' && j.dependsOn))
    return '批量配音正在排队，请等待批量任务完成后再生成本句'
  if (active.some((j) => j.segmentId === current.value)) return '本句已加入配音队列，请等待完成'
  return ''
})
const lineJob = (id: string) =>
  detail.value?.jobs.find((j) => j.segmentId === id && ['queued', 'running'].includes(j.status))
function openBatch(action: BatchInput['action']) {
  batchAction.value = action
  showBatch.value = true
}
watch(
  () => project.value.id,
  () => {
    current.value = undefined
    mode.value = project.value.kind === 'text' ? 'dubbed' : 'original'
  },
  { immediate: true }
)
watch(
  settingsProject,
  (id) => {
    if (id !== project.value.id) return
    options.value = {
      name: project.value.name,
      sourceLanguage: project.value.sourceLanguage,
      targetLanguage: normalizeLanguage(project.value.targetLanguage),
      channelId: project.value.channelId
    }
    showOptions.value = true
    settingsProject.value = null
  },
  { immediate: true }
)
function selectLine(id: string) {
  if (dirty.value && !window.confirm('放弃未保存的台词修改？')) return
  dirty.value = false
  current.value = id
  showEditor.value = true
}
function setEditorOpen(open: boolean) {
  if (!open && dirty.value && !window.confirm('放弃未保存的台词修改？')) return
  showEditor.value = open
  if (!open) dirty.value = false
}
function generateLine(id: string) {
  current.value = id
  showGeneration.value = true
}
function openGeneration() {
  showEditor.value = false
  showGeneration.value = true
}
async function pause() {
  await act(() =>
    $fetch(`/api/projects/${project.value.id}/pause`, {
      method: 'POST',
      body: { paused: !project.value.paused }
    })
  )
}
async function saveOptions() {
  if (savingOptions.value || locked.value) return
  savingOptions.value = true
  if (
    await act(
      () => $fetch(`/api/projects/${project.value.id}`, { method: 'PATCH', body: options.value }),
      '项目设置已保存'
    )
  )
    showOptions.value = false
  savingOptions.value = false
}
async function addLine() {
  if (addReason.value) return
  const start = lines.value.at(-1)?.end || 0
  const end = project.value.kind === 'text' ? start + 4 : Math.min(start + 4, project.value.duration)
  await act(async () => {
    const line = await $fetch<{ id: string }>(`/api/projects/${project.value.id}/segments`, {
      method: 'POST',
      body: { start, end, text: '', translation: '', speaker: '角色 1', enabled: true }
    })
    current.value = line.id
    showEditor.value = true
  }, '台词已添加')
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
      <div class="workspace-title">
        <span class="workspace-project-name">{{ project.name }}</span>
        <span class="help">{{ normalizeLanguage(project.targetLanguage) }} · {{ lines.length }} 句台词</span>
      </div>
      <div class="row-actions">
        <span v-if="lines.length" class="help">{{ completed }} / {{ enabledCount }} 句已配音</span>
        <UButton
          v-if="locked || project.paused"
          color="neutral"
          variant="ghost"
          :icon="project.paused ? 'i-carbon-play' : 'i-carbon-pause'"
          @click="pause"
          >{{ project.paused ? '继续任务' : '暂停任务' }}</UButton
        >
        <StudioAction
          v-if="panel === 'script'"
          color="neutral"
          variant="ghost"
          icon="i-carbon-add"
          :reason="addReason"
          @click="addLine"
          >添加台词</StudioAction
        >
        <StudioAction
          v-if="panel === 'script' && lines.length"
          color="neutral"
          variant="ghost"
          icon="i-carbon-language"
          :reason="dirty ? '请先保存台词修改' : ''"
          @click="openBatch('translate')"
          >翻译台词</StudioAction
        >
        <StudioAction
          v-if="panel === 'preview'"
          color="neutral"
          variant="soft"
          icon="i-carbon-video"
          @click="openBatch('render')"
          >合成成片</StudioAction
        >
        <StudioAction
          v-if="panel === 'script'"
          icon="i-carbon-batch-job"
          :reason="dirty ? '请先保存台词修改' : ''"
          @click="openBatch(lines.length ? 'synthesize' : 'prepare')"
          >{{ lines.length ? '批量配音' : '处理素材' }}</StudioAction
        >
        <UButton
          v-if="project.outputPath"
          :href="mediaUrl(project.outputPath, true)"
          icon="i-carbon-download"
          color="neutral"
          variant="soft"
          >导出成片</UButton
        >
      </div>
    </header>
    <section v-if="panel === 'script'" class="script-panel">
      <div v-if="!lines.length" class="project-start">
        <UIcon name="i-carbon-script" class="empty-icon" />
        <h2>{{ project.kind === 'text' ? '先添加需要配音的台词' : '先识别素材中的台词' }}</h2>
        <p>
          {{
            project.kind === 'text'
              ? '填写台词后，可以逐句选择 AI 配音或微软 TTS。'
              : '在本机分离人声与背景音，再识别台词。中文识别结果使用简体中文。'
          }}
        </p>
        <StudioAction
          :reason="locked ? '素材正在处理中，完成后即可校对台词' : ''"
          @click="project.kind === 'text' ? addLine() : openBatch('prepare')"
          >{{ project.kind === 'text' ? '添加台词' : '识别台词 · 本机处理' }}</StudioAction
        >
        <div class="start-manual-note">
          <UIcon name="i-carbon-information" />
          <p>识别完成后先校对，再按需翻译或配音。翻译和 AI 配音消耗接口额度，只有手动发起才会执行。</p>
        </div>
      </div>
      <template v-else>
        <details class="workspace-guide">
          <summary>
            <UIcon name="i-carbon-information" />处理指引<span>校对后逐句配音，翻译按需使用</span
            ><UIcon name="i-carbon-chevron-down" />
          </summary>
          <div class="guide-content">
            <p><strong>校对台词</strong>检查时间和原文，在右列填写希望说出的内容。</p>
            <p><strong>按需翻译</strong>需要其他语言时，点击“翻译台词”。会使用翻译接口额度。</p>
            <p><strong>生成配音</strong>每句可独立选择 AI 或免费 TTS；需要统一处理时使用“批量配音”。</p>
            <p><strong>试听并合成</strong>左右对照试听，满意后到“预览成片”手动合成。</p>
          </div>
        </details>
        <div class="comparison-heading"><span>原文与原声</span><span>配音台词与新声音</span></div>
        <div class="comparison-list">
          <article
            v-for="(line, i) in lines"
            :key="line.id"
            class="comparison-row"
            :class="{ selected: current === line.id, 'not-replaced': !line.enabled }"
          >
            <header class="comparison-meta">
              <div class="line-meta">
                <span class="line-number">{{ String(i + 1).padStart(2, '0') }}</span
                ><time>{{ formatTime(line.start) }} – {{ formatTime(line.end) }}</time
                ><span>{{ line.speaker }}</span>
              </div>
              <div class="line-meta">
                <span v-if="lineJob(line.id)" class="status-running">{{
                  lineJob(line.id)?.status === 'running' ? '正在生成' : '等待生成'
                }}</span
                ><span v-else-if="!line.enabled">保留原声</span
                ><span v-else-if="line.generatedPath" class="status-completed"
                  >已生成 · {{ line.synthesisMode === 'tts' ? '微软 TTS' : 'AI 配音' }}</span
                ><span v-else>待配音</span>
              </div>
            </header>
            <div class="comparison-source">
              <div class="dialogue-content">
                <p class="dialogue-original">{{ line.text || '尚未填写原文' }}</p>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-carbon-edit"
                  :aria-label="`编辑第 ${i + 1} 句原文与时间`"
                  @click="selectLine(line.id)"
                />
              </div>
              <ClipAudio
                :src="
                  project.kind !== 'text' && project.sourcePath
                    ? `/api/segments/${line.id}/original?t=${line.start}-${line.end}`
                    : undefined
                "
                :label="`第 ${i + 1} 句原声`"
                :empty="project.kind === 'text' ? '文本台词，无原声音频' : '尚无可试听的原声素材'"
              />
            </div>
            <div class="comparison-generated">
              <div class="dialogue-content">
                <div>
                  <p class="dialogue-translation">
                    {{ line.translation || line.text || '填写要生成的配音台词' }}
                  </p>
                  <small v-if="!line.translation && line.text" class="help">使用原文配音</small>
                </div>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-carbon-edit"
                  :aria-label="`编辑第 ${i + 1} 句配音台词`"
                  @click="selectLine(line.id)"
                />
              </div>
              <div class="generated-output">
                <ClipAudio
                  v-if="line.generatedPath"
                  :src="mediaUrl(line.generatedPath)"
                  :label="`第 ${i + 1} 句生成配音`"
                />
                <div v-else class="audio-placeholder">
                  <UIcon name="i-carbon-waveform" /><span>{{
                    lineJob(line.id) ? '完成后可在此试听' : '生成后在此试听'
                  }}</span>
                </div>
                <UButton
                  variant="soft"
                  size="sm"
                  icon="i-carbon-microphone"
                  :aria-label="`第 ${i + 1} 句${lineJob(line.id) ? '配音设置' : line.generatedPath ? '重新生成' : '生成配音'}`"
                  @click="generateLine(line.id)"
                  >{{ lineJob(line.id) ? '配音设置' : line.generatedPath ? '重新生成' : '生成配音' }}</UButton
                >
              </div>
            </div>
          </article>
        </div>
      </template>
    </section>

    <section v-else class="preview-panel">
      <header class="content-heading">
        <div class="row-actions" role="group" aria-label="预览音轨">
          <StudioAction
            color="neutral"
            :variant="mode === 'original' ? 'soft' : 'ghost'"
            :reason="project.kind === 'text' ? '文本项目没有原始音轨' : ''"
            @click="switchMode('original')"
            >原始素材</StudioAction
          >
          <StudioAction
            color="neutral"
            :variant="mode === 'dubbed' ? 'soft' : 'ghost'"
            :reason="!project.outputPath ? '请先点击“合成成片”' : ''"
            @click="switchMode('dubbed')"
            >配音成片</StudioAction
          >
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
          <p v-else>尚未合成成片。先完成配音，再点击“合成成片”。</p></template
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
          variant="ghost"
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
    <USlideover
      :open="showEditor"
      @update:open="setEditorOpen"
      title="编辑台词"
      side="right"
      :ui="{ content: 'sm:max-w-lg ring-0', header: 'border-0' }"
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
            :blocked-reason="generationBlock"
            :key="selected.id"
            @close="showGeneration = false"
            @generated="showGeneration = false"
          />
        </div>
      </template>
    </UDrawer>
    <USlideover
      v-model:open="showOptions"
      title="项目设置"
      side="right"
      :ui="{ content: 'sm:max-w-md ring-0', header: 'border-0' }"
      ><template #body
        ><form class="project-options-form" @submit.prevent="saveOptions">
          <p class="help">
            修改目标语言会清除译文、配音和成片；修改 AI 渠道会清除配音和成片。仅修改名称不影响结果。
          </p>
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
                { label: '韩语', value: 'ko' },
                { label: '西班牙语', value: 'es' },
                { label: '法语', value: 'fr' },
                { label: '德语', value: 'de' },
                { label: '俄语', value: 'ru' }
              ]" /></UFormField
          ><UFormField label="目标语言"
            ><USelect
              v-model="options.targetLanguage"
              class="w-full"
              :disabled="locked"
              :items="languageOptions(options.targetLanguage)"
              aria-label="目标语言" /></UFormField
          ><UFormField label="AI 配音渠道" description="密钥在左下角设置中配置；微软 TTS 无需密钥。"
            ><USelect
              v-model="options.channelId"
              class="w-full"
              :disabled="locked"
              :items="
                channels
                  .filter((c) => c.type === 'volcengine' && c.enabled)
                  .map((c) => ({ label: c.name, value: c.id }))
              " /></UFormField
          ><StudioAction
            type="submit"
            :reason="locked ? '请等待当前项目任务完成' : !options.name.trim() ? '请填写项目名称' : ''"
            :loading="savingOptions"
            >保存设置</StudioAction
          >
        </form></template
      ></USlideover
    >
    <UModal
      v-model:open="showBatch"
      title="批量处理"
      :ui="{ content: 'sm:max-w-2xl ring-0', header: 'border-0' }"
      ><template #body
        ><BatchProcessing
          v-if="showBatch"
          :initial-action="batchAction"
          @close="showBatch = false"
          @submitted="showBatch = false" /></template
    ></UModal>
  </section>
</template>
