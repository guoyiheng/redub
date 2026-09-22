<script setup lang="ts">
import type { Channel } from '../../shared/types'
import { settingsSchema } from '../../shared/settings'

interface Health {
  ffmpeg: boolean
  ffprobe: boolean
  models: boolean
  versions?: {
    ffmpeg?: string
    ffprobe?: string
    python?: string
  }
  modelStatus?: {
    demucs: boolean
    fasterWhisper: boolean
    opencc: boolean
  }
  paths?: {
    ffmpeg?: string
    ffprobe?: string
    python?: string
  }
}

interface DesktopUpdateState {
  currentVersion: string
  state:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'unsupported'
    | 'error'
  availableVersion: string | null
  progress: number | null
  message: string
  packaged: boolean
  configured: boolean
}

type SettingsSection = 'channels' | 'local' | 'queue' | 'desktop'

const { channels, settings, act, toast, errorMessage } = useStudio()
const activeSection = ref<SettingsSection>('channels')
const modalOpen = ref(false),
  selected = ref<string>(),
  saving = ref(false)
const draft = ref<Channel & { apiKey: string }>()
const health = ref<Health>(),
  checking = ref(false)
const queueDraft = ref({ ...settings.value }),
  desktopStatus = ref(''),
  desktopBusy = ref(false)
const queueSaving = ref(false)
async function saveQueue() {
  if (queueSaving.value) return
  queueSaving.value = true
  try {
    await act(() => $fetch('/api/settings', { method: 'PATCH', body: queueDraft.value }), '任务设置已保存')
  } finally {
    queueSaving.value = false
  }
}
const desktopUpdate = ref<DesktopUpdateState>({
  currentVersion: '',
  state: 'idle',
  availableVersion: null,
  progress: null,
  message: '',
  packaged: false,
  configured: false
})
let stopUpdateListener: (() => void) | undefined
const updateRequestBusy = ref(false)
const desktop = computed(() => import.meta.client && !!(window as any).redub)
const channelTitle = computed(() => (selected.value ? '编辑渠道' : '添加渠道'))
const engineReady = computed(() => !!health.value?.ffmpeg && !!health.value?.ffprobe)
const modelReady = computed(() => !!health.value?.models)
const updateBusy = computed(
  () =>
    updateRequestBusy.value || ['checking', 'downloading', 'installing'].includes(desktopUpdate.value.state)
)

const defaultModelPresets: Record<'volcengine' | 'openai', string[]> = {
  volcengine: ['seed-audio-1.0', 'seed-audio-2.0', 'seed-tts-1.0', 'seed-tts-2.0'],
  openai: [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'deepseek-chat',
    'deepseek-reasoner',
    'qwen-plus',
    'qwen-turbo',
    'moonshot-v1-8k',
    'claude-3-5-sonnet-20241022'
  ]
}
const modelOptions = ref<string[]>([])
const fetchingModels = ref(false)

const modelDropdownItems = computed(() => {
  if (!modelOptions.value.length) {
    return [[{ label: '暂无可用模型，请先拉取', disabled: true }]]
  }
  return [
    modelOptions.value.map((m) => ({
      label: m,
      onSelect: () => {
        if (draft.value) draft.value.model = m
      }
    }))
  ]
})

function onTypeChange(val: unknown) {
  if (!draft.value) return
  const type = val === 'openai' ? 'openai' : 'volcengine'
  draft.value.type = type
  const preset = defaultModelPresets[type]
  modelOptions.value = [...preset]
  if (!preset.includes(draft.value.model)) {
    draft.value.model = preset[0] || ''
  }
  if (type === 'volcengine' && draft.value.endpoint.includes('openai.com')) {
    draft.value.endpoint = 'https://openspeech.bytedance.com/api/v3/tts/create'
  } else if (type === 'openai' && draft.value.endpoint.includes('bytedance.com')) {
    draft.value.endpoint = 'https://api.openai.com/v1'
  }
}

async function pullModels() {
  if (!draft.value) return
  fetchingModels.value = true
  try {
    const res = await $fetch<{ models: string[] }>('/api/channels/fetch-models', {
      method: 'POST',
      body: {
        id: selected.value,
        type: draft.value.type,
        endpoint: draft.value.endpoint,
        apiKey: draft.value.apiKey,
        keyEnv: draft.value.keyEnv
      }
    })
    if (res?.models && res.models.length) {
      modelOptions.value = Array.from(new Set([...res.models, ...modelOptions.value]))
      if (!draft.value.model || !modelOptions.value.includes(draft.value.model)) {
        draft.value.model = res.models[0] || draft.value.model
      }
      toast.add({
        id: 'pull-models-success',
        title: `成功拉取 ${res.models.length} 个模型`,
        color: 'success'
      })
    } else {
      toast.add({
        id: 'pull-models-warn',
        title: '未获取到模型',
        description: '服务未返回模型列表，请手动输入模型 ID',
        color: 'warning'
      })
    }
  } catch (error) {
    toast.add({
      id: 'pull-models-error',
      title: '拉取模型失败',
      description: errorMessage(error),
      color: 'error',
      duration: 8000
    })
  } finally {
    fetchingModels.value = false
  }
}

const sections: {
  id: SettingsSection
  label: string
  description: string
  icon: string
  desktopOnly?: boolean
}[] = [
  {
    id: 'channels',
    label: 'AI 渠道',
    description: '配音与翻译服务',
    icon: 'i-carbon-api'
  },
  {
    id: 'local',
    label: '本机处理',
    description: '引擎、模型与环境',
    icon: 'i-carbon-chip'
  },
  {
    id: 'queue',
    label: '任务与识别',
    description: '并发和识别参数',
    icon: 'i-carbon-task'
  },
  {
    id: 'desktop',
    label: '桌面应用',
    description: '版本与更新',
    icon: 'i-carbon-application',
    desktopOnly: true
  }
]

function edit(channel?: Channel) {
  selected.value = channel?.id
  const type = channel?.type || 'volcengine'
  const preset = defaultModelPresets[type]
  const currentModel = channel?.model || (type === 'volcengine' ? 'seed-audio-1.0' : 'gpt-4o')
  modelOptions.value = Array.from(new Set([currentModel, ...preset]))
  draft.value = {
    id: channel?.id || '',
    name: channel?.name || '新的配音渠道',
    type,
    endpoint:
      channel?.endpoint ||
      (type === 'volcengine'
        ? 'https://openspeech.bytedance.com/api/v3/tts/create'
        : 'https://api.openai.com/v1'),
    model: currentModel,
    keyEnv: channel?.keyEnv || 'CUSTOM_API_KEY',
    apiKey: '',
    enabled: channel?.enabled ?? true
  }
  modalOpen.value = true
}
async function save() {
  if (!draft.value) return
  saving.value = true
  const payload = { ...draft.value }
  payload.apiKey = payload.apiKey.trim()
  const ok = await act(
    () =>
      $fetch(selected.value ? `/api/channels/${selected.value}` : '/api/channels', {
        method: selected.value ? 'PATCH' : 'POST',
        body: payload
      }),
    '渠道已保存'
  )
  if (ok) modalOpen.value = false
  saving.value = false
}
async function check() {
  checking.value = true
  await act(async () => {
    health.value = await $fetch<Health>('/api/health')
  })
  checking.value = false
}
async function updateDesktop(action: 'status' | 'check' | 'download' | 'install' | 'models') {
  if (action === 'models') {
    desktopBusy.value = true
    try {
      desktopStatus.value = await (window as any).redub.update(action)
    } catch (e) {
      desktopStatus.value = String(e)
    }
    desktopBusy.value = false
    return
  }
  if (updateBusy.value) return
  updateRequestBusy.value = true
  try {
    const result = await (window as any).redub.update(action)
    if (result && typeof result === 'object') desktopUpdate.value = result
  } catch (e) {
    desktopUpdate.value = { ...desktopUpdate.value, message: `更新操作失败：${String(e)}` }
  } finally {
    updateRequestBusy.value = false
  }
}
onMounted(async () => {
  check()
  if (!desktop.value) return
  stopUpdateListener = (window as any).redub.onUpdateStatus?.((state: DesktopUpdateState) => {
    desktopUpdate.value = state
  })
  await updateDesktop('status')
})
onBeforeUnmount(() => stopUpdateListener?.())
</script>

<template>
  <section class="settings-page">
    <header class="page-header settings-header">
      <div>
        <h1>设置</h1>
        <p class="help">管理 AI 渠道、本机引擎与任务参数。所有密钥和模型均保存在本机。</p>
      </div>
    </header>

    <div class="settings-layout">
      <nav class="settings-menu" aria-label="设置分类">
        <button
          v-for="item in sections.filter((item) => !item.desktopOnly || desktop)"
          :key="item.id"
          type="button"
          :class="{ active: activeSection === item.id }"
          @click="activeSection = item.id"
        >
          <UIcon :name="item.icon" />
          <span
            ><strong>{{ item.label }}</strong
            ><small>{{ item.description }}</small></span
          >
          <UIcon name="i-carbon-chevron-right" class="menu-chevron" />
        </button>
      </nav>

      <div class="settings-content">
        <section v-if="activeSection === 'channels'" class="settings-card settings-section">
          <div class="settings-card-header">
            <div>
              <h2>AI 渠道</h2>
              <p class="help">配音和翻译使用的服务。可以添加多个渠道，并在项目中切换启用的配音渠道。</p>
            </div>
            <UButton icon="i-carbon-add" size="sm" @click="edit()">添加渠道</UButton>
          </div>
          <div v-if="channels.length" class="channel-list">
            <button
              v-for="channel in channels"
              :key="channel.id"
              type="button"
              class="channel-row"
              @click="edit(channel)"
            >
              <div class="channel-icon-badge">
                <UIcon :name="channel.type === 'volcengine' ? 'i-carbon-microphone' : 'i-carbon-language'" />
              </div>
              <div class="channel-info">
                <div class="channel-title-row">
                  <strong class="channel-name">{{ channel.name }}</strong>
                  <UBadge
                    :color="!channel.enabled ? 'neutral' : channel.configured ? 'success' : 'warning'"
                    variant="soft"
                    size="sm"
                    >{{ !channel.enabled ? '已停用' : channel.configured ? '已启用' : '待配置密钥' }}</UBadge
                  >
                </div>
                <div class="channel-meta-row">
                  <span class="channel-type-tag">{{ channel.type === 'volcengine' ? '配音' : '翻译' }}</span>
                  <span class="channel-meta-sep">·</span>
                  <span class="channel-model-name" :title="channel.model">{{ channel.model }}</span>
                </div>
              </div>
              <UIcon name="i-carbon-chevron-right" class="channel-chevron" />
            </button>
          </div>
          <div v-else class="settings-empty">
            <UIcon name="i-carbon-api" />
            <div>
              <strong>还没有 AI 渠道</strong>
              <p>添加火山 Audio 或 OpenAI 兼容渠道后即可开始处理。</p>
            </div>
          </div>
          <div class="settings-note">
            <strong>渠道可以切换吗？</strong>
            <p>
              可以。配音和翻译各启用一个渠道。启用新渠道会自动停用同功能的其他渠道，之后生成时自动使用这里的配置；已有配音和译文会保留。
            </p>
          </div>
        </section>

        <section v-else-if="activeSection === 'local'" class="settings-card settings-section">
          <div class="settings-card-header">
            <div>
              <h2>本机处理</h2>
              <p class="help">检查本机媒体引擎和 AI 模型是否完整。处理过程不会把素材上传到模型服务。</p>
            </div>
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              icon="i-carbon-renew"
              :loading="checking"
              @click="check"
              >重新检查</UButton
            >
          </div>

          <div class="health-summary">
            <div>
              <i :class="{ ok: engineReady }" />
              <span
                ><strong>音视频引擎</strong
                ><small>{{ !health ? '检查中' : engineReady ? '已就绪' : '待安装' }}</small></span
              >
            </div>
            <div>
              <i :class="{ ok: modelReady }" />
              <span
                ><strong>本地模型环境</strong
                ><small>{{ !health ? '检查中' : modelReady ? '已就绪' : '待安装' }}</small></span
              >
            </div>
          </div>

          <div class="settings-block">
            <div class="settings-block-heading">
              <div>
                <h3>音视频引擎是什么</h3>
                <p class="help">负责读取素材、提取音轨、分离声道、混音和封装成片。</p>
              </div>
              <UBadge color="neutral" variant="soft">应用内置，不支持页面切换</UBadge>
            </div>
            <div class="engine-list">
              <article>
                <div class="engine-icon"><UIcon name="i-carbon-video" /></div>
                <div class="engine-info">
                  <div class="engine-title-row">
                    <strong>FFmpeg</strong>
                    <UBadge :color="health?.ffmpeg ? 'success' : 'warning'" variant="soft" size="sm">{{
                      health?.ffmpeg ? '已就绪' : '待安装'
                    }}</UBadge>
                  </div>
                  <p>解码与编码音视频，执行裁剪、拼接、混音、波形读取和最终封装。</p>
                  <small>{{ health?.versions?.ffmpeg || '尚未检测到版本' }}</small>
                </div>
              </article>
              <article>
                <div class="engine-icon"><UIcon name="i-carbon-information" /></div>
                <div class="engine-info">
                  <div class="engine-title-row">
                    <strong>FFprobe</strong>
                    <UBadge :color="health?.ffprobe ? 'success' : 'warning'" variant="soft" size="sm">{{
                      health?.ffprobe ? '已就绪' : '待安装'
                    }}</UBadge>
                  </div>
                  <p>读取素材时长、编码格式、画面尺寸和音轨数量，为时间轴与导出提供准确信息。</p>
                  <small>{{ health?.versions?.ffprobe || '尚未检测到版本' }}</small>
                </div>
              </article>
            </div>
            <p class="settings-footnote">
              当前版本随应用打包
              FFmpeg/FFprobe，不提供普通用户切换入口，避免不同版本导致导出结果不一致。高级部署可通过
              <code>REDUB_FFMPEG</code> 和 <code>REDUB_FFPROBE</code> 环境变量替换。
            </p>
          </div>

          <div class="settings-block">
            <div class="settings-block-heading">
              <div>
                <h3>本地模型是什么</h3>
                <p class="help">用于人声分离、语音活动检测和台词识别，首次使用时可能自动下载权重。</p>
              </div>
              <UBadge :color="modelReady ? 'success' : 'warning'" variant="soft">{{
                modelReady ? '环境已就绪' : '环境待安装'
              }}</UBadge>
            </div>
            <div class="model-list">
              <article>
                <div class="model-icon"><UIcon name="i-carbon-voice-activate" /></div>
                <div class="model-info">
                  <div class="model-title-row">
                    <strong>Demucs · htdemucs</strong>
                    <UBadge
                      :color="health?.modelStatus?.demucs ? 'success' : 'warning'"
                      variant="soft"
                      size="sm"
                      >{{ health?.modelStatus?.demucs ? '已安装' : '待安装' }}</UBadge
                    >
                  </div>
                  <p>把原始音轨分离为人声和背景音。当前版本固定使用 htdemucs，页面中不可切换。</p>
                </div>
              </article>
              <article>
                <div class="model-icon"><UIcon name="i-carbon-speech-to-text" /></div>
                <div class="model-info">
                  <div class="model-title-row">
                    <strong>Faster Whisper · 可切换</strong>
                    <UBadge
                      :color="health?.modelStatus?.fasterWhisper ? 'success' : 'warning'"
                      variant="soft"
                      size="sm"
                      >{{ health?.modelStatus?.fasterWhisper ? '已安装' : '待安装' }}</UBadge
                    >
                  </div>
                  <p>把语音识别为文字。可在“任务与识别”中切换 tiny、base、small、medium 或 large-v3。</p>
                </div>
              </article>
              <article>
                <div class="model-icon"><UIcon name="i-carbon-audio-console" /></div>
                <div class="model-info">
                  <div class="model-title-row">
                    <strong>Silero VAD · 内置</strong>
                    <UBadge
                      :color="health?.modelStatus?.fasterWhisper ? 'success' : 'warning'"
                      variant="soft"
                      size="sm"
                      >{{ health?.modelStatus?.fasterWhisper ? '已安装' : '待安装' }}</UBadge
                    >
                  </div>
                  <p>检测人声起止位置，自动切分台词片段；随 Faster Whisper 环境提供，无需单独选择。</p>
                </div>
              </article>
              <article>
                <div class="model-icon"><UIcon name="i-carbon-translate" /></div>
                <div class="model-info">
                  <div class="model-title-row">
                    <strong>OpenCC · 内置</strong>
                    <UBadge
                      :color="health?.modelStatus?.opencc ? 'success' : 'warning'"
                      variant="soft"
                      size="sm"
                      >{{ health?.modelStatus?.opencc ? '已安装' : '待安装' }}</UBadge
                    >
                  </div>
                  <p>把繁体识别结果转换为简体中文；不参与配音生成，也不需要切换。</p>
                </div>
              </article>
            </div>
            <p v-if="desktop && health && !health.models" class="settings-footnote">
              当前缺少 Python 3.11 或模型依赖，可点击安装；首次处理时还会下载 Demucs 和所选 Whisper 模型权重。
            </p>
          </div>

          <UButton
            v-if="desktop && health && !health.models"
            color="neutral"
            variant="outline"
            size="sm"
            :loading="desktopBusy"
            @click="updateDesktop('models')"
            >安装模型环境</UButton
          >
          <p v-if="desktopBusy" class="help">正在安装，请保持应用打开。</p>
        </section>

        <section v-else-if="activeSection === 'queue'" class="settings-card settings-section">
          <div class="settings-card-header">
            <div>
              <h2>任务与识别</h2>
              <p class="help">翻译和配音分别控制并发，互不占用额度。</p>
            </div>
          </div>
          <UForm
            class="settings-form"
            :schema="settingsSchema"
            :state="queueDraft"
            :disabled="queueSaving"
            @submit="saveQueue"
          >
            <div class="settings-form-grid">
              <UFormField
                name="translationConcurrency"
                label="翻译并发数"
                description="同时翻译的台词数量，默认 10。"
              >
                <UInputNumber
                  v-model="queueDraft.translationConcurrency"
                  increment-icon="i-carbon-add"
                  decrement-icon="i-carbon-subtract"
                  class="w-full"
                  :min="1"
                  :max="32"
                  :step="1"
                />
              </UFormField>
              <UFormField
                name="synthesisConcurrency"
                label="配音并发数"
                description="同时生成的配音数量，默认 5。"
              >
                <UInputNumber
                  v-model="queueDraft.synthesisConcurrency"
                  increment-icon="i-carbon-add"
                  decrement-icon="i-carbon-subtract"
                  class="w-full"
                  :min="1"
                  :max="32"
                  :step="1"
                />
              </UFormField>
            </div>
            <div class="settings-form-grid">
              <UFormField label="本地识别模型" description="模型越大，精度越高，内存占用越多。">
                <USelect
                  v-model="queueDraft.whisperModel"
                  class="w-full"
                  :items="[
                    { label: 'Tiny · 最快', value: 'tiny' },
                    { label: 'Base · 轻量', value: 'base' },
                    { label: 'Small · 推荐', value: 'small' },
                    { label: 'Medium · 更准确', value: 'medium' },
                    { label: 'Large v3 · 最准确', value: 'large-v3' }
                  ]"
                />
              </UFormField>
            </div>
            <div class="settings-form-footer">
              <UCheckbox v-model="queueDraft.pauseOnFailure" label="任务失败后暂停队列" />
              <UButton
                color="neutral"
                variant="outline"
                type="submit"
                class="settings-save"
                :loading="queueSaving"
                >保存任务设置</UButton
              >
            </div>
          </UForm>
        </section>

        <section v-else-if="activeSection === 'desktop' && desktop" class="settings-card settings-section">
          <div class="settings-card-header">
            <div>
              <h2>桌面应用</h2>
              <p class="help">检查新版本，下载后重启安装。</p>
            </div>
          </div>
          <div class="desktop-update-card">
            <div class="desktop-version">
              <span>当前版本</span>
              <strong>v{{ desktopUpdate.currentVersion || '—' }}</strong>
            </div>

            <div v-if="desktopUpdate.state === 'available'" class="desktop-update-action">
              <div>
                <strong>发现新版本 v{{ desktopUpdate.availableVersion }}</strong>
                <span>下载不会中断当前任务，完成后可自行选择重启安装。</span>
              </div>
              <UButton :loading="updateBusy" @click="updateDesktop('download')">下载更新</UButton>
            </div>

            <div v-else-if="desktopUpdate.state === 'downloading'" class="desktop-update-action">
              <div class="desktop-download-copy">
                <strong>正在下载 v{{ desktopUpdate.availableVersion }}</strong>
                <span>{{ desktopUpdate.progress ?? 0 }}%</span>
              </div>
              <div
                class="desktop-progress"
                role="progressbar"
                aria-label="更新下载进度"
                :aria-valuenow="desktopUpdate.progress ?? 0"
                :aria-valuemin="0"
                :aria-valuemax="100"
              >
                <span :style="{ width: `${desktopUpdate.progress ?? 0}%` }" />
              </div>
            </div>

            <div
              v-else-if="['downloaded', 'installing'].includes(desktopUpdate.state)"
              class="desktop-update-action"
            >
              <div>
                <strong>新版本已准备好</strong>
                <span>重启后会完成安装，未保存的操作请先处理。</span>
              </div>
              <UButton color="neutral" :loading="updateBusy" @click="updateDesktop('install')"
                >重启并安装</UButton
              >
            </div>

            <div v-else class="desktop-update-action">
              <UButton
                color="neutral"
                variant="outline"
                :loading="updateBusy"
                :disabled="desktopUpdate.state === 'unsupported'"
                @click="updateDesktop('check')"
                >检查更新</UButton
              >
            </div>

            <p v-if="desktopUpdate.message" role="status" class="desktop-update-message">
              {{ desktopUpdate.message }}
            </p>
          </div>
        </section>
      </div>
    </div>

    <UModal v-model:open="modalOpen" :title="channelTitle" :ui="{ content: 'sm:max-w-xl' }">
      <template #body>
        <form v-if="draft" class="channel-editor" @submit.prevent="save">
          <div class="channel-editor-grid">
            <UFormField label="渠道名称"><UInput v-model="draft.name" class="w-full" /></UFormField>
            <UFormField label="类型">
              <USelect
                v-model="draft.type"
                class="w-full"
                :items="[
                  { label: '火山 Audio 配音', value: 'volcengine' },
                  { label: 'OpenAI 兼容翻译', value: 'openai' }
                ]"
                @update:model-value="onTypeChange"
              />
            </UFormField>
          </div>
          <div class="channel-editor-grid">
            <UFormField label="接口地址"><UInput v-model="draft.endpoint" class="w-full" /></UFormField>
            <UFormField label="兼容环境变量名">
              <UInput v-model="draft.keyEnv" class="w-full" placeholder="CUSTOM_API_KEY" />
            </UFormField>
          </div>
          <UFormField label="API Key" description="只保存在本机；编辑已有渠道时留空表示不修改。">
            <UInput v-model="draft.apiKey" class="w-full" type="password" placeholder="输入 API Key" />
          </UFormField>
          <UFormField label="模型 ID" description="支持手动输入，或从接口拉取后在右侧下拉选择">
            <div class="channel-model-picker">
              <UInput
                v-model="draft.model"
                list="channel-model-suggestions"
                class="channel-model-input"
                placeholder="输入或选择模型 ID"
              />
              <datalist id="channel-model-suggestions">
                <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
              </datalist>
              <div class="channel-model-actions">
                <UButton
                  color="neutral"
                  variant="outline"
                  icon="i-carbon-cloud-download"
                  :loading="fetchingModels"
                  type="button"
                  @click="pullModels"
                >
                  拉取
                </UButton>
                <UDropdownMenu
                  :items="modelDropdownItems"
                  :ui="{ content: 'max-h-64 overflow-y-auto min-w-44' }"
                >
                  <UButton
                    color="neutral"
                    variant="outline"
                    trailing-icon="i-carbon-chevron-down"
                    type="button"
                    :disabled="!modelOptions.length"
                  >
                    选择
                  </UButton>
                </UDropdownMenu>
              </div>
            </div>
          </UFormField>
          <div class="channel-editor-footer">
            <UCheckbox v-model="draft.enabled" label="启用渠道" description="自动停用同功能的其他渠道" />
            <div class="modal-actions">
              <UButton color="neutral" variant="ghost" type="button" @click="modalOpen = false">取消</UButton>
              <UButton type="submit" :loading="saving">保存渠道</UButton>
            </div>
          </div>
        </form>
      </template>
    </UModal>
  </section>
</template>
