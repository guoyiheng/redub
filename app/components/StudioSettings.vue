<script setup lang="ts">
import type { Channel } from '../../shared/types'
import { ttsVoices, formatVoiceName } from '../../shared/voice'
import { aiVoices } from '../../shared/ai-voices'
import { mediaUrl } from '../composables/useStudio'
import { useIntersectionObserver } from '@vueuse/core'
import { useTaskNavigation, type TaskNavigationTarget } from '../composables/useTaskNavigation'

interface Health {
  ffmpeg: boolean
  ffprobe: boolean
  models: boolean
  cuda?: boolean
  cudaDevice?: string
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

type SettingsSection = 'channels' | 'voices' | 'local' | 'general' | 'desktop'

const { channels, settings, act, toast, errorMessage } = useStudio()
const {
  voices: refVoices,
  load: loadRefVoices,
  add: addRefVoice,
  rename: renameRefVoice
} = useReferenceVoices()

const activeSection = ref<SettingsSection>('channels')
const modalOpen = ref(false)
const selected = ref<string>()
const saving = ref(false)
const showApiKey = ref(false)
const draft = ref<Channel & { apiKey: string }>()
const health = ref<Health>()
const checking = ref(false)

const desktopStatus = ref('')
const desktopBusy = ref(false)
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
const channelTitle = computed(() => {
  if (selected.value) {
    return draft.value?.type === 'volcengine' ? '编辑配音渠道' : '编辑翻译渠道'
  }
  return draft.value?.type === 'volcengine' ? '添加配音渠道' : '添加翻译渠道'
})

const dubbingChannels = computed(() => channels.value.filter((c) => c.type === 'volcengine'))
const translationChannels = computed(() => channels.value.filter((c) => c.type === 'openai'))

function channelConcurrency(channel: Channel) {
  if (channel.enabled) {
    return channel.type === 'openai'
      ? settings.value.translationConcurrency
      : settings.value.synthesisConcurrency
  }
  return channel.concurrency ?? (channel.type === 'openai' ? 10 : 5)
}

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
  if (type === 'volcengine') {
    if (draft.value.endpoint.includes('openai.com')) {
      draft.value.endpoint = 'https://openspeech.bytedance.com/api/v3/tts/create'
    }
    if (!draft.value.concurrency) draft.value.concurrency = 5
  } else if (type === 'openai') {
    if (draft.value.endpoint.includes('bytedance.com')) {
      draft.value.endpoint = 'https://api.openai.com/v1'
    }
    if (!draft.value.concurrency) draft.value.concurrency = 10
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
    description: '配音与翻译渠道',
    icon: 'i-carbon-api'
  },
  {
    id: 'voices',
    label: '音色管理',
    description: '渠道音色与参考音色',
    icon: 'i-carbon-volume-up'
  },
  {
    id: 'local',
    label: '本机处理',
    description: '引擎、模型与环境',
    icon: 'i-carbon-chip'
  },
  {
    id: 'general',
    label: '通用设置',
    description: 'NSFW 遮罩与偏好',
    icon: 'i-carbon-settings'
  },
  {
    id: 'desktop',
    label: '桌面应用',
    description: '版本与更新',
    icon: 'i-carbon-application',
    desktopOnly: true
  }
]

function edit(channel?: Channel, defaultType: 'volcengine' | 'openai' = 'volcengine') {
  selected.value = channel?.id
  showApiKey.value = false
  const type = channel?.type || defaultType
  const preset = defaultModelPresets[type]
  const currentModel = channel?.model || (type === 'volcengine' ? 'seed-audio-1.0' : 'gpt-4o')
  modelOptions.value = Array.from(new Set([currentModel, ...preset]))
  draft.value = {
    id: channel?.id || '',
    name: channel?.name || (type === 'volcengine' ? '火山 Audio 配音' : 'OpenAI 兼容翻译'),
    type,
    endpoint:
      channel?.endpoint ||
      (type === 'volcengine'
        ? 'https://openspeech.bytedance.com/api/v3/tts/create'
        : 'https://api.openai.com/v1'),
    model: currentModel,
    keyEnv: channel?.keyEnv || (type === 'volcengine' ? 'VOLCENGINE_API_KEY' : 'OPENAI_API_KEY'),
    apiKey: channel?.apiKey || '',
    concurrency: channel ? channelConcurrency(channel) : type === 'openai' ? 10 : 5,
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

async function onWhisperModelChange(model: unknown) {
  if (typeof model !== 'string') return
  await act(
    () => $fetch('/api/settings', { method: 'PATCH', body: { whisperModel: model } }),
    '本地识别模型已切换'
  )
}

// 音色管理状态
const voiceSourceTab = ref<'ark' | 'tts' | 'reference'>('ark')
const auditionVoice = ref('')
const isAuditionLoading = ref(false)
const isAuditionPlaying = ref(false)
let auditionAudio: HTMLAudioElement | null = null
let auditionController: AbortController | null = null
let auditionUrl = ''

function stopAudition() {
  auditionController?.abort()
  auditionController = null
  if (auditionAudio) {
    auditionAudio.pause()
    auditionAudio = null
  }
  if (auditionUrl) URL.revokeObjectURL(auditionUrl)
  auditionUrl = ''
  auditionVoice.value = ''
  isAuditionPlaying.value = false
  isAuditionLoading.value = false
}

async function toggleTtsAudition(voice: string) {
  if (auditionVoice.value === voice && (isAuditionPlaying.value || isAuditionLoading.value)) {
    stopAudition()
    return
  }
  stopAudition()
  const controller = new AbortController()
  auditionController = controller
  auditionVoice.value = voice
  isAuditionLoading.value = true
  const voiceLabel = formatVoiceName(voice, 'tts') || voice
  try {
    const blob = await $fetch<Blob>('/api/tts/preview', {
      method: 'POST',
      signal: controller.signal,
      responseType: 'blob',
      body: { voice, voiceLabel }
    })
    if (controller.signal.aborted) return
    auditionUrl = URL.createObjectURL(blob)
    const audio = new Audio(auditionUrl)
    auditionAudio = audio
    audio.onended = stopAudition
    audio.onerror = () => {
      stopAudition()
      toast.add({ title: '音色试听播放失败', color: 'error' })
    }
    await audio.play()
    if (!controller.signal.aborted) isAuditionPlaying.value = true
  } catch (error) {
    if (controller.signal.aborted) return
    stopAudition()
    toast.add({ title: '音色试听失败', description: errorMessage(error), color: 'error' })
  } finally {
    if (auditionController === controller) isAuditionLoading.value = false
  }
}

async function toggleAiAudition(speaker: string, speakerLabel?: string) {
  if (auditionVoice.value === speaker && (isAuditionPlaying.value || isAuditionLoading.value)) {
    stopAudition()
    return
  }
  stopAudition()
  const controller = new AbortController()
  auditionController = controller
  auditionVoice.value = speaker
  isAuditionLoading.value = true
  const resolvedSpeakerLabel = speakerLabel || aiVoices.find((v) => v.value === speaker)?.label || speaker
  try {
    const blob = await $fetch<Blob>('/api/tts/preview', {
      method: 'POST',
      signal: controller.signal,
      responseType: 'blob',
      body: { speaker, speakerLabel: resolvedSpeakerLabel }
    })
    if (controller.signal.aborted) return
    auditionUrl = URL.createObjectURL(blob)
    const audio = new Audio(auditionUrl)
    auditionAudio = audio
    audio.onended = stopAudition
    audio.onerror = () => {
      stopAudition()
      toast.add({ title: '音色试听播放失败', color: 'error' })
    }
    await audio.play()
    if (!controller.signal.aborted) isAuditionPlaying.value = true
  } catch (error) {
    if (controller.signal.aborted) return
    stopAudition()
    toast.add({ title: '音色试听失败', description: errorMessage(error), color: 'error' })
  } finally {
    if (auditionController === controller) isAuditionLoading.value = false
  }
}

async function toggleRefAudition(voice: { id: string; path: string }) {
  if (auditionVoice.value === voice.id && (isAuditionPlaying.value || isAuditionLoading.value)) {
    stopAudition()
    return
  }
  stopAudition()
  const controller = new AbortController()
  auditionController = controller
  auditionVoice.value = voice.id
  isAuditionLoading.value = true
  try {
    const audio = new Audio(mediaUrl(voice.path))
    auditionAudio = audio
    audio.onended = stopAudition
    audio.onerror = () => {
      stopAudition()
      toast.add({ title: '音色试听播放失败', color: 'error' })
    }
    await audio.play()
    if (!controller.signal.aborted) isAuditionPlaying.value = true
  } catch (error) {
    if (controller.signal.aborted) return
    stopAudition()
    toast.add({ title: '音色试听失败', description: errorMessage(error), color: 'error' })
  } finally {
    if (auditionController === controller) isAuditionLoading.value = false
  }
}

async function setAsDefaultTtsVoice(voice: string) {
  await act(
    () => $fetch('/api/settings', { method: 'PATCH', body: { defaultTtsVoice: voice } }),
    '已设置为默认音色'
  )
}

async function setAsDefaultAiVoice(speaker: string) {
  await act(
    () => $fetch('/api/settings', { method: 'PATCH', body: { defaultAiSpeaker: speaker } }),
    speaker ? '已设置为默认 AI 音色' : '已恢复为自动音色'
  )
}

const currentDefaultAiLabel = computed(() => {
  const speaker = settings.value?.defaultAiSpeaker
  if (!speaker) return '自动音色'
  return aiVoices.find((v) => v.value === speaker)?.label || speaker
})

// 火山方舟 AI 音色筛选与列表
const arkSearch = ref('')
const arkGender = ref<'all' | 'female' | 'male'>('all')
const arkCategory = ref('全部')
const arkLimit = ref(20)

const arkGenderOptions = [
  { label: '全部性别', value: 'all' },
  { label: '女声', value: 'female' },
  { label: '男声', value: 'male' }
]

const arkCategories = computed(() => {
  const set = new Set<string>()
  for (const v of aiVoices) {
    if (v.category) {
      for (const cat of v.category.split(/[,，]/)) {
        const trimmed = cat.trim()
        if (trimmed) set.add(trimmed)
      }
    }
  }
  return ['全部', ...Array.from(set)]
})

const sortedArkVoices = computed(() => {
  const terms = arkSearch.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const cat = arkCategory.value
  const gender = arkGender.value
  const pinned = new Set(settings.value?.pinnedVoices || [])

  const matched = aiVoices.filter((voice) => {
    if (gender !== 'all' && voice.gender !== gender) {
      return false
    }
    if (cat !== '全部' && !voice.category.includes(cat)) {
      return false
    }
    if (terms.length) {
      const genderKeyword = voice.gender === 'female' ? '女声 女' : '男声 男'
      const text = [voice.label, voice.value, voice.language, voice.category, genderKeyword]
        .join(' ')
        .toLocaleLowerCase()
      if (!terms.every((term) => text.includes(term))) {
        return false
      }
    }
    return true
  })

  return matched.sort((a, b) => {
    const aPinned = pinned.has(a.value) ? 1 : 0
    const bPinned = pinned.has(b.value) ? 1 : 0
    if (aPinned !== bPinned) return bPinned - aPinned
    return 0
  })
})

const visibleArkVoices = computed(() => {
  return sortedArkVoices.value.slice(0, arkLimit.value)
})

watch([arkSearch, arkCategory, arkGender], () => {
  arkLimit.value = 20
})

watch(voiceSourceTab, () => {
  stopAudition()
})

const taskNavigation = useTaskNavigation()
const highlightedVoice = ref('')
let highlightTimer: ReturnType<typeof setTimeout> | null = null

function handleVoiceNavigation(target: TaskNavigationTarget | null) {
  if (!target || target.type !== 'voice') return
  activeSection.value = 'voices'
  voiceSourceTab.value = target.voiceType
  if (target.voiceType === 'ark') {
    arkGender.value = 'all'
    arkCategory.value = '全部'
    arkSearch.value = target.voiceLabel || target.voiceKey
  }
  highlightedVoice.value = target.voiceKey
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => {
    highlightedVoice.value = ''
  }, 4000)

  nextTick(() => {
    const el = document.getElementById(`settings-voice-${target.voiceKey}`)
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  })
}

watch(taskNavigation, (target) => {
  handleVoiceNavigation(target)
})

const arkSentinelRef = ref<HTMLElement | null>(null)

function loadMoreArkVoices() {
  if (arkLimit.value >= sortedArkVoices.value.length) return
  arkLimit.value = Math.min(arkLimit.value + 30, sortedArkVoices.value.length)
}

useIntersectionObserver(
  arkSentinelRef,
  ([entry]) => {
    if (entry?.isIntersecting && arkLimit.value < sortedArkVoices.value.length) {
      loadMoreArkVoices()
    }
  },
  { rootMargin: '200px' }
)

function onWindowScroll() {
  if (activeSection.value !== 'voices' || voiceSourceTab.value !== 'ark') return
  if (arkLimit.value >= sortedArkVoices.value.length) return
  const scrollBottom = window.innerHeight + window.scrollY
  if (scrollBottom >= document.documentElement.scrollHeight - 300) {
    loadMoreArkVoices()
  }
}

async function togglePinVoice(id: string) {
  const current = new Set(settings.value.pinnedVoices || [])
  const isPinned = current.has(id)
  if (isPinned) {
    current.delete(id)
  } else {
    current.add(id)
  }
  const updated = Array.from(current)
  await act(
    () => $fetch('/api/settings', { method: 'PATCH', body: { pinnedVoices: updated } }),
    isPinned ? '已取消置顶' : '已置顶音色'
  )
}

const sortedTtsVoices = computed(() => {
  const pinned = new Set(settings.value.pinnedVoices || [])
  return [...ttsVoices].sort((a, b) => {
    const aPinned = pinned.has(a.value) ? 1 : 0
    const bPinned = pinned.has(b.value) ? 1 : 0
    if (aPinned !== bPinned) return bPinned - aPinned
    return 0
  })
})

const sortedRefVoices = computed(() => {
  const pinned = new Set(settings.value.pinnedVoices || [])
  return [...refVoices.value].sort((a, b) => {
    const aPinned = pinned.has(a.id) ? 1 : 0
    const bPinned = pinned.has(b.id) ? 1 : 0
    if (aPinned !== bPinned) return bPinned - aPinned
    return 0
  })
})

// 参考音色管理
const refFile = ref<File | null>(null)
const refName = ref('')
const refSaving = ref(false)
const refEditing = ref('')
const refEditName = ref('')

watch(refFile, (val) => {
  if (val && !refName.value) {
    refName.value = val.name.replace(/\.[^.]+$/, '').slice(0, 80)
  }
})

async function addReferenceVoice() {
  if (!refFile.value || refSaving.value) return
  refSaving.value = true
  try {
    if (refFile.value.size > 10 * 1024 ** 2) throw new Error('参考音频不能超过 10 MB')
    await addRefVoice(refFile.value, refName.value)
    refFile.value = null
    refName.value = ''
    toast.add({ title: '参考音色已添加', color: 'success' })
  } catch (e) {
    toast.add({ title: '添加失败', description: errorMessage(e), color: 'error' })
  } finally {
    refSaving.value = false
  }
}

function startReferenceRename(voice: { id: string; name: string }) {
  refEditing.value = voice.id
  refEditName.value = voice.name
}

async function saveReferenceName() {
  if (!refEditing.value || !refEditName.value.trim()) return
  refSaving.value = true
  try {
    await renameRefVoice(refEditing.value, refEditName.value.trim())
    refEditing.value = ''
    toast.add({ title: '音色已重命名', color: 'success' })
  } catch (e) {
    toast.add({ title: '修改失败', description: errorMessage(e), color: 'error' })
  } finally {
    refSaving.value = false
  }
}

async function setAsDefaultRefVoice(voiceId: string) {
  await act(
    () => $fetch('/api/settings', { method: 'PATCH', body: { defaultReferenceVoice: voiceId } }),
    voiceId ? '已设置为默认参考音色' : '已取消默认参考音色'
  )
}

const currentDefaultRefLabel = computed(() => {
  const id = settings.value?.defaultReferenceVoice
  if (!id) return ''
  return refVoices.value.find((v) => v.id === id)?.name || id
})

// 通用设置（NSFW与偏好）
const generalDraft = ref({
  nsfwDefaultEnabled: true,
  nsfwDefaultTransparency: 0,
  pauseOnFailure: true
})

watchEffect(() => {
  if (settings.value) {
    generalDraft.value.nsfwDefaultEnabled = settings.value.nsfwDefaultEnabled ?? true
    generalDraft.value.nsfwDefaultTransparency = settings.value.nsfwDefaultTransparency ?? 0
    generalDraft.value.pauseOnFailure = settings.value.pauseOnFailure ?? true
  }
})

const generalSaving = ref(false)
async function saveGeneral() {
  generalSaving.value = true
  try {
    await act(
      () =>
        $fetch('/api/settings', {
          method: 'PATCH',
          body: {
            nsfwDefaultEnabled: generalDraft.value.nsfwDefaultEnabled,
            nsfwDefaultTransparency: generalDraft.value.nsfwDefaultTransparency,
            pauseOnFailure: generalDraft.value.pauseOnFailure
          }
        }),
      '通用设置已保存'
    )
  } finally {
    generalSaving.value = false
  }
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

watch(activeSection, (sec) => {
  if (sec !== 'voices') stopAudition()
  if (sec === 'voices') void loadRefVoices()
})

onMounted(async () => {
  check()
  void loadRefVoices()
  handleVoiceNavigation(taskNavigation.value)
  window.addEventListener('scroll', onWindowScroll, { passive: true })
  if (!desktop.value) return
  stopUpdateListener = (window as any).redub.onUpdateStatus?.((state: DesktopUpdateState) => {
    desktopUpdate.value = state
  })
  await updateDesktop('status')
})

onBeforeUnmount(() => {
  stopAudition()
  if (highlightTimer) clearTimeout(highlightTimer)
  stopUpdateListener?.()
  window.removeEventListener('scroll', onWindowScroll)
})
</script>

<template>
  <section class="settings-page">
    <div class="settings-layout">
      <nav class="settings-menu" aria-label="设置分类">
        <button
          v-for="item in sections.filter((item) => !item.desktopOnly || desktop)"
          :key="item.id"
          type="button"
          :class="{ active: activeSection === item.id }"
          :aria-current="activeSection === item.id ? 'page' : undefined"
          @click="activeSection = item.id"
        >
          <UIcon :name="item.icon" />
          <span>
            <strong>{{ item.label }}</strong>
            <small>{{ item.description }}</small>
          </span>
          <UIcon name="i-carbon-chevron-right" class="menu-chevron" />
        </button>
      </nav>

      <div class="settings-content">
        <!-- AI 渠道（翻译和配音分开，一行一个渠道） -->
        <section v-if="activeSection === 'channels'" class="space-y-6">
          <!-- 配音渠道 -->
          <div class="settings-card settings-section">
            <div class="settings-card-header">
              <div>
                <h2>配音渠道</h2>
                <p class="help">AI 配音使用的服务。每次启用一个配音渠道，生成时自动使用配置的并发数。</p>
              </div>
              <UButton icon="i-carbon-add" size="sm" @click="edit(undefined, 'volcengine')"
                >添加配音渠道</UButton
              >
            </div>
            <div v-if="dubbingChannels.length" class="channel-list">
              <button
                v-for="channel in dubbingChannels"
                :key="channel.id"
                type="button"
                class="channel-row"
                @click="edit(channel)"
              >
                <div class="channel-icon-badge">
                  <UIcon name="i-carbon-microphone" />
                </div>
                <div class="channel-info">
                  <div class="channel-title-row">
                    <strong class="channel-name">{{ channel.name }}</strong>
                    <div class="flex items-center gap-2">
                      <UBadge color="neutral" variant="subtle" size="sm"
                        >并发: {{ channelConcurrency(channel) }}</UBadge
                      >
                      <UBadge
                        :color="!channel.enabled ? 'neutral' : channel.configured ? 'success' : 'warning'"
                        variant="soft"
                        size="sm"
                        >{{
                          !channel.enabled ? '已停用' : channel.configured ? '已启用' : '待配置密钥'
                        }}</UBadge
                      >
                    </div>
                  </div>
                  <div class="channel-meta-row">
                    <span class="channel-type-tag">火山 Audio</span>
                    <span class="channel-meta-sep">·</span>
                    <span class="channel-model-name" :title="channel.model">{{ channel.model }}</span>
                  </div>
                </div>
                <UIcon name="i-carbon-chevron-right" class="channel-chevron" />
              </button>
            </div>
            <div v-else class="settings-empty">
              <UIcon name="i-carbon-microphone" />
              <div>
                <strong>暂无配音渠道</strong>
                <p>添加火山 Audio 配音渠道后即可开始生成配音。</p>
              </div>
            </div>
          </div>

          <!-- 翻译渠道 -->
          <div class="settings-card settings-section">
            <div class="settings-card-header">
              <div>
                <h2>翻译渠道</h2>
                <p class="help">台词翻译使用的服务。每次启用一个翻译渠道，翻译时自动使用配置的并发数。</p>
              </div>
              <UButton icon="i-carbon-add" size="sm" @click="edit(undefined, 'openai')">添加翻译渠道</UButton>
            </div>
            <div v-if="translationChannels.length" class="channel-list">
              <button
                v-for="channel in translationChannels"
                :key="channel.id"
                type="button"
                class="channel-row"
                @click="edit(channel)"
              >
                <div class="channel-icon-badge">
                  <UIcon name="i-carbon-translate" />
                </div>
                <div class="channel-info">
                  <div class="channel-title-row">
                    <strong class="channel-name">{{ channel.name }}</strong>
                    <div class="flex items-center gap-2">
                      <UBadge color="neutral" variant="subtle" size="sm"
                        >并发: {{ channelConcurrency(channel) }}</UBadge
                      >
                      <UBadge
                        :color="!channel.enabled ? 'neutral' : channel.configured ? 'success' : 'warning'"
                        variant="soft"
                        size="sm"
                        >{{
                          !channel.enabled ? '已停用' : channel.configured ? '已启用' : '待配置密钥'
                        }}</UBadge
                      >
                    </div>
                  </div>
                  <div class="channel-meta-row">
                    <span class="channel-type-tag">OpenAI 兼容</span>
                    <span class="channel-meta-sep">·</span>
                    <span class="channel-model-name" :title="channel.model">{{ channel.model }}</span>
                  </div>
                </div>
                <UIcon name="i-carbon-chevron-right" class="channel-chevron" />
              </button>
            </div>
            <div v-else class="settings-empty">
              <UIcon name="i-carbon-translate" />
              <div>
                <strong>暂无翻译渠道</strong>
                <p>添加 OpenAI 兼容翻译渠道后即可开始台词翻译。</p>
              </div>
            </div>
          </div>
        </section>

        <!-- 音色管理 -->
        <section v-else-if="activeSection === 'voices'" class="settings-card settings-section">
          <div class="settings-card-header">
            <div>
              <h2>音色管理</h2>
              <p class="help">按渠道管理和试听音色，可将音色置顶或设置为全局默认音色。</p>
            </div>
          </div>

          <div class="mb-4 border-b border-default pb-px">
            <UTabs
              v-model="voiceSourceTab"
              color="neutral"
              variant="link"
              :content="false"
              aria-label="音色渠道分类"
              :items="[
                { label: '火山方舟 (AI 音色)', value: 'ark', icon: 'i-carbon-machine-learning-model' },
                { label: '微软 Edge TTS', value: 'tts', icon: 'i-carbon-volume-up' },
                { label: '本地参考音色', value: 'reference', icon: 'i-carbon-waveform' }
              ]"
            />
          </div>

          <!-- 火山方舟 (AI 音色) 列表 -->
          <div v-if="voiceSourceTab === 'ark'" class="flex flex-col gap-3">
            <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <UInput
                v-model="arkSearch"
                icon="i-carbon-search"
                aria-label="搜索方舟音色"
                placeholder="搜索音色名称、ID、语言或适用场景..."
                class="flex-1"
              />
              <USelect
                v-model="arkGender"
                :items="arkGenderOptions"
                class="w-full sm:w-32 shrink-0"
                aria-label="按性别筛选"
              />
              <USelect
                v-model="arkCategory"
                :items="arkCategories"
                class="w-full sm:w-36 shrink-0"
                aria-label="按分类筛选"
              />
            </div>

            <div
              v-if="settings.defaultAiSpeaker"
              class="flex items-center justify-between p-2.5 rounded-lg bg-primary/5 border border-primary/20 text-xs"
            >
              <div class="flex items-center gap-1.5 min-w-0 flex-1 truncate">
                <UIcon name="i-carbon-checkmark-filled" class="size-3.5 text-primary shrink-0" />
                <span class="truncate">
                  当前全局默认 AI 音色：<strong class="text-default">{{ currentDefaultAiLabel }}</strong>
                  <span class="text-muted font-mono ml-1">({{ settings.defaultAiSpeaker }})</span>
                </span>
              </div>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                class="shrink-0"
                @click="setAsDefaultAiVoice('')"
              >
                恢复自动音色
              </UButton>
            </div>

            <div class="flex flex-col gap-2.5">
              <div
                v-for="voice in visibleArkVoices"
                :id="`settings-voice-${voice.value}`"
                :key="voice.value"
                class="settings-voice-row"
                :class="{ 'is-highlighted': highlightedVoice === voice.value }"
              >
                <div class="flex items-center gap-3 min-w-0 flex-1">
                  <div
                    class="flex items-center justify-center w-9 h-9 rounded-lg bg-elevated border border-default text-primary shrink-0"
                  >
                    <UIcon name="i-carbon-machine-learning-model" class="w-5 h-5" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <strong class="text-sm font-semibold text-default truncate">{{ voice.label }}</strong>
                      <UBadge color="neutral" variant="subtle" size="xs" class="gap-0.5">
                        <UIcon
                          :name="
                            voice.gender === 'female' ? 'i-carbon-gender-female' : 'i-carbon-gender-male'
                          "
                          class="size-3"
                        />
                        {{ voice.gender === 'female' ? '女声' : '男声' }}
                      </UBadge>
                      <UBadge
                        v-if="settings.defaultAiSpeaker === voice.value"
                        color="primary"
                        variant="solid"
                        size="xs"
                        >默认音色</UBadge
                      >
                      <UBadge
                        v-if="settings.pinnedVoices?.includes(voice.value)"
                        color="neutral"
                        variant="soft"
                        size="xs"
                        >已置顶</UBadge
                      >
                    </div>
                    <p class="text-xs text-muted font-mono mt-0.5 truncate">
                      {{ voice.value }} · {{ voice.language }} · {{ voice.category }}
                    </p>
                    <p v-if="voice.note" class="text-xs text-muted mt-0.5 whitespace-normal">
                      {{ voice.note }}
                    </p>
                  </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <UButton
                    color="neutral"
                    variant="outline"
                    size="xs"
                    :icon="
                      auditionVoice === voice.value && isAuditionPlaying
                        ? 'i-carbon-stop-filled'
                        : 'i-carbon-play-filled-alt'
                    "
                    :loading="auditionVoice === voice.value && isAuditionLoading"
                    @click="toggleAiAudition(voice.value, voice.label)"
                  >
                    {{
                      auditionVoice === voice.value && isAuditionPlaying
                        ? '停止'
                        : auditionVoice === voice.value && isAuditionLoading
                          ? '加载'
                          : '试听'
                    }}
                  </UButton>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :disabled="settings.defaultAiSpeaker === voice.value"
                    @click="setAsDefaultAiVoice(voice.value)"
                  >
                    设为默认
                  </UButton>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :icon="
                      settings.pinnedVoices?.includes(voice.value) ? 'i-carbon-pin-filled' : 'i-carbon-pin'
                    "
                    :title="settings.pinnedVoices?.includes(voice.value) ? '取消置顶' : '置顶音色'"
                    @click="togglePinVoice(voice.value)"
                  >
                    {{ settings.pinnedVoices?.includes(voice.value) ? '取消' : '置顶' }}
                  </UButton>
                </div>
              </div>

              <div
                v-if="arkLimit < sortedArkVoices.length"
                ref="arkSentinelRef"
                class="flex items-center justify-center p-3 text-xs text-muted cursor-pointer hover:text-default transition-colors border border-dashed border-default rounded-lg"
                @click="loadMoreArkVoices"
              >
                <UIcon name="i-carbon-circle-dash" class="animate-spin mr-1.5 size-4" />
                正在加载更多音色... (已显示 {{ arkLimit }} / 共 {{ sortedArkVoices.length }} 个)
              </div>
              <div
                v-else-if="sortedArkVoices.length > 20"
                class="flex items-center justify-center p-3 text-xs text-muted border border-default/40 rounded-lg bg-elevated/40"
              >
                已加载全部 {{ sortedArkVoices.length }} 个音色
              </div>

              <div v-if="!sortedArkVoices.length" role="status" class="text-muted p-8 text-center text-sm">
                没有找到匹配的方舟音色
              </div>
            </div>
          </div>

          <!-- 微软 Edge TTS 音色列表 -->
          <div v-else-if="voiceSourceTab === 'tts'" class="flex flex-col gap-2.5">
            <div
              v-for="voice in sortedTtsVoices"
              :id="`settings-voice-${voice.value}`"
              :key="voice.value"
              class="settings-voice-row"
              :class="{ 'is-highlighted': highlightedVoice === voice.value }"
            >
              <div class="flex items-center gap-3 min-w-0 flex-1">
                <div
                  class="flex items-center justify-center w-9 h-9 rounded-lg bg-elevated border border-default text-primary shrink-0"
                >
                  <UIcon name="i-carbon-volume-up" class="w-5 h-5" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <strong class="text-sm font-semibold text-default truncate">{{ voice.label }}</strong>
                    <UBadge
                      v-if="settings.defaultTtsVoice === voice.value"
                      color="primary"
                      variant="solid"
                      size="xs"
                      >默认音色</UBadge
                    >
                    <UBadge
                      v-if="settings.pinnedVoices?.includes(voice.value)"
                      color="neutral"
                      variant="soft"
                      size="xs"
                      >已置顶</UBadge
                    >
                  </div>
                  <p class="text-xs text-muted font-mono mt-0.5 truncate">
                    {{ voice.value }} · {{ voice.lang }}
                  </p>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <UButton
                  color="neutral"
                  variant="outline"
                  size="xs"
                  :icon="
                    auditionVoice === voice.value && isAuditionPlaying
                      ? 'i-carbon-stop-filled'
                      : 'i-carbon-play-filled-alt'
                  "
                  :loading="auditionVoice === voice.value && isAuditionLoading"
                  @click="toggleTtsAudition(voice.value)"
                >
                  {{
                    auditionVoice === voice.value && isAuditionPlaying
                      ? '停止'
                      : auditionVoice === voice.value && isAuditionLoading
                        ? '加载'
                        : '试听'
                  }}
                </UButton>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :disabled="settings.defaultTtsVoice === voice.value"
                  @click="setAsDefaultTtsVoice(voice.value)"
                >
                  设为默认
                </UButton>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :icon="
                    settings.pinnedVoices?.includes(voice.value) ? 'i-carbon-pin-filled' : 'i-carbon-pin'
                  "
                  :title="settings.pinnedVoices?.includes(voice.value) ? '取消置顶' : '置顶音色'"
                  @click="togglePinVoice(voice.value)"
                >
                  {{ settings.pinnedVoices?.includes(voice.value) ? '取消' : '置顶' }}
                </UButton>
              </div>
            </div>
          </div>

          <!-- 本地参考音色列表 -->
          <div v-else-if="voiceSourceTab === 'reference'" class="space-y-4">
            <div class="p-4 rounded-lg border border-default bg-muted/30 space-y-3">
              <strong class="text-sm font-semibold">添加本地参考音频</strong>
              <UFileUpload
                v-model="refFile"
                accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac"
                label="拖入音频，或点击选择"
                description="30 秒以内 · 最大 10 MB"
                icon="i-carbon-music"
                file-icon="i-carbon-music"
                :disabled="refSaving"
                :file-image="false"
                class="w-full min-h-24"
              />
              <div class="flex items-center gap-2">
                <UInput
                  v-model="refName"
                  aria-label="音色名称"
                  placeholder="音色名称（默认使用文件名）"
                  :maxlength="80"
                  :disabled="refSaving"
                  class="flex-1"
                />
                <UButton
                  type="button"
                  color="primary"
                  icon="i-carbon-add"
                  :disabled="!refFile"
                  :loading="refSaving"
                  @click="addReferenceVoice"
                >
                  添加音色
                </UButton>
              </div>
            </div>

            <div
              v-if="settings.defaultReferenceVoice"
              class="flex items-center justify-between p-2.5 rounded-lg bg-primary/5 border border-primary/20 text-xs"
            >
              <div class="flex items-center gap-1.5 min-w-0 flex-1 truncate">
                <UIcon name="i-carbon-checkmark-filled" class="size-3.5 text-primary shrink-0" />
                <span class="truncate">
                  当前默认参考音色：<strong class="text-default">{{ currentDefaultRefLabel }}</strong>
                  <span class="text-muted font-mono ml-1">({{ settings.defaultReferenceVoice }})</span>
                </span>
              </div>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                class="shrink-0"
                @click="setAsDefaultRefVoice('')"
              >
                取消默认
              </UButton>
            </div>

            <div v-if="sortedRefVoices.length" class="flex flex-col gap-2.5">
              <div v-for="voice in sortedRefVoices" :key="voice.id" class="settings-voice-row">
                <div class="flex items-center gap-3 min-w-0 flex-1">
                  <div
                    class="flex items-center justify-center w-9 h-9 rounded-lg bg-elevated border border-default text-primary shrink-0"
                  >
                    <UIcon name="i-carbon-waveform" class="w-5 h-5" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <template v-if="refEditing === voice.id">
                      <div class="flex items-center gap-2">
                        <UInput
                          v-model="refEditName"
                          aria-label="修改参考音色名称"
                          class="min-w-0 flex-1"
                          size="sm"
                          @keydown.enter.prevent="saveReferenceName"
                        />
                        <UButton size="xs" color="primary" :loading="refSaving" @click="saveReferenceName"
                          >保存</UButton
                        >
                        <UButton size="xs" color="neutral" variant="ghost" @click="refEditing = ''"
                          >取消</UButton
                        >
                      </div>
                    </template>
                    <template v-else>
                      <div class="flex items-center gap-1.5 min-w-0">
                        <strong class="text-sm font-semibold text-default truncate">{{ voice.name }}</strong>
                        <UButton
                          color="neutral"
                          variant="ghost"
                          size="xs"
                          icon="i-carbon-edit"
                          title="重命名"
                          aria-label="重命名参考音色"
                          class="shrink-0 text-muted hover:text-default"
                          @click="startReferenceRename(voice)"
                        />
                        <UBadge
                          v-if="settings.defaultReferenceVoice === voice.id"
                          color="primary"
                          variant="solid"
                          size="xs"
                          class="shrink-0"
                          >默认音色</UBadge
                        >
                        <UBadge
                          v-if="settings.pinnedVoices?.includes(voice.id)"
                          color="neutral"
                          variant="soft"
                          size="xs"
                          class="shrink-0"
                          >已置顶</UBadge
                        >
                      </div>
                      <p class="text-xs text-muted font-mono mt-0.5 truncate">
                        {{ voice.id }} · 时长 {{ voice.duration.toFixed(1) }}s
                      </p>
                    </template>
                  </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <UButton
                    color="neutral"
                    variant="outline"
                    size="xs"
                    :icon="
                      auditionVoice === voice.id && isAuditionPlaying
                        ? 'i-carbon-stop-filled'
                        : 'i-carbon-play-filled-alt'
                    "
                    :loading="auditionVoice === voice.id && isAuditionLoading"
                    @click="toggleRefAudition(voice)"
                  >
                    {{
                      auditionVoice === voice.id && isAuditionPlaying
                        ? '停止'
                        : auditionVoice === voice.id && isAuditionLoading
                          ? '加载'
                          : '试听'
                    }}
                  </UButton>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :disabled="settings.defaultReferenceVoice === voice.id"
                    @click="setAsDefaultRefVoice(voice.id)"
                  >
                    设为默认
                  </UButton>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :icon="settings.pinnedVoices?.includes(voice.id) ? 'i-carbon-pin-filled' : 'i-carbon-pin'"
                    :title="settings.pinnedVoices?.includes(voice.id) ? '取消置顶' : '置顶音色'"
                    @click="togglePinVoice(voice.id)"
                  >
                    {{ settings.pinnedVoices?.includes(voice.id) ? '取消' : '置顶' }}
                  </UButton>
                </div>
              </div>
            </div>
            <div v-else class="settings-empty">
              <UIcon name="i-carbon-waveform" />
              <div>
                <strong>暂无参考音色</strong>
                <p>上传本地音频后，即可在配音时复用参考音色。</p>
              </div>
            </div>
          </div>
        </section>

        <!-- 本机处理（单列展示，Whisper模型直接在卡片内设置） -->
        <section v-else-if="activeSection === 'local'" class="settings-card settings-section">
          <div class="settings-card-header">
            <div>
              <h2>本机处理</h2>
              <p class="help">检查本机媒体引擎和 AI 模型是否完整。处理过程不会把素材上传到外部服务。</p>
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
              <span>
                <strong>音视频引擎</strong>
                <small>{{ !health ? '检查中' : engineReady ? '已就绪' : '待安装' }}</small>
              </span>
            </div>
            <div>
              <i :class="{ ok: modelReady }" />
              <span>
                <strong>本地模型环境</strong>
                <small>{{ !health ? '检查中' : modelReady ? '已就绪' : '待安装' }}</small>
              </span>
            </div>
          </div>

          <div class="settings-block">
            <div class="settings-block-heading">
              <div>
                <h3>音视频引擎</h3>
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
                <h3>本地模型</h3>
                <p class="help">用于人声分离、语音活动检测和台词识别，首次使用时可能自动下载权重。</p>
              </div>
              <div class="flex items-center gap-2">
                <UBadge
                  v-if="health?.cuda"
                  color="success"
                  variant="soft"
                  :title="health?.cudaDevice || 'NVIDIA CUDA'"
                >
                  <UIcon name="i-carbon-chip" class="mr-1" />
                  CUDA 加速已启用 ({{ health?.cudaDevice || 'GPU' }})
                </UBadge>
                <UBadge :color="modelReady ? 'success' : 'warning'" variant="soft">{{
                  modelReady ? '环境已就绪' : '环境待安装'
                }}</UBadge>
              </div>
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
                  <p>
                    把原始音轨分离为人声和背景音。当前版本固定使用 htdemucs{{
                      health?.cuda ? '（已启用 CUDA 显卡加速）' : ''
                    }}。
                  </p>
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
                  <p>
                    把语音识别为文字。可在下方直接选择识别模型，模型首次使用时会自动下载权重。{{
                      health?.cuda ? '已启用 CUDA float16 推理加速。' : ''
                    }}
                  </p>
                  <div
                    class="mt-3 pt-3 border-t border-default/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div class="min-w-0 flex-1">
                      <strong class="text-xs font-semibold text-default">本地识别模型</strong>
                      <p class="text-xs text-muted mt-0.5">本地识别模型模型越大，精度越高，内存占用越多。</p>
                    </div>
                    <div class="w-48 shrink-0">
                      <USelect
                        :model-value="settings.whisperModel || 'small'"
                        class="w-full"
                        :items="[
                          { label: 'Tiny · 最快', value: 'tiny' },
                          { label: 'Base · 轻量', value: 'base' },
                          { label: 'Small · 推荐', value: 'small' },
                          { label: 'Medium · 更准确', value: 'medium' },
                          { label: 'Large v3 · 最准确', value: 'large-v3' }
                        ]"
                        @update:model-value="onWhisperModelChange"
                      />
                    </div>
                  </div>
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

        <!-- 通用设置（NSFW 遮罩与队列偏好） -->
        <section v-else-if="activeSection === 'general'" class="settings-card settings-section">
          <div class="settings-card-header">
            <div>
              <h2>通用设置</h2>
              <p class="help">配置全局默认偏好。每个项目仍可单独调整自己的选项并自动记住。</p>
            </div>
          </div>

          <form class="settings-general-form" @submit.prevent="saveGeneral">
            <div class="p-4 rounded-lg border border-default bg-muted/30 space-y-4">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <strong class="text-sm font-semibold text-default">默认开启 NSFW 毛玻璃遮罩</strong>
                  <p class="text-xs text-muted mt-0.5">
                    新建项目或打开未单独配置的项目时，视频画面默认开启毛玻璃遮罩。
                  </p>
                </div>
                <USwitch v-model="generalDraft.nsfwDefaultEnabled" aria-label="默认开启 NSFW 遮罩" />
              </div>

              <div class="space-y-1.5 pt-3 border-t border-default/50">
                <div class="flex items-center justify-between text-xs">
                  <strong class="font-semibold text-default">默认毛玻璃遮罩透光度</strong>
                  <span class="text-muted">{{ generalDraft.nsfwDefaultTransparency }}% 透光</span>
                </div>
                <input
                  v-model.number="generalDraft.nsfwDefaultTransparency"
                  aria-label="默认遮罩透光度"
                  type="range"
                  min="0"
                  max="75"
                  step="1"
                  class="w-full accent-primary"
                />
                <div class="flex justify-between text-[11px] text-muted">
                  <span>0%（完全遮挡）</span>
                  <span>75%（高透光）</span>
                </div>
              </div>
            </div>

            <div class="p-4 rounded-lg border border-default bg-muted/30">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <strong class="text-sm font-semibold text-default">任务失败后暂停队列</strong>
                  <p class="text-xs text-muted mt-0.5">
                    当台词翻译或配音遇到错误时，自动暂停后续任务以防连续报错。
                  </p>
                </div>
                <USwitch v-model="generalDraft.pauseOnFailure" aria-label="任务失败后暂停队列" />
              </div>
            </div>

            <div class="flex justify-end">
              <UButton type="submit" :loading="generalSaving">保存通用设置</UButton>
            </div>
          </form>
        </section>

        <!-- 桌面应用 -->
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

    <!-- 渠道编辑弹窗 -->
    <UModal v-model:open="modalOpen" :title="channelTitle" :ui="{ content: 'sm:max-w-xl' }">
      <template #body>
        <form v-if="draft" class="channel-editor space-y-4" @submit.prevent="save">
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
          <div class="channel-editor-grid">
            <UFormField
              :label="draft.type === 'openai' ? '翻译并发数' : '配音并发数'"
              :description="
                draft.type === 'openai' ? '同时翻译的台词数量，默认 10。' : '同时生成的配音数量，默认 5。'
              "
            >
              <UInputNumber v-model="draft.concurrency" :min="1" :max="32" :step="1" class="w-full" />
            </UFormField>
            <UFormField label="API Key" description="只保存在本机数据库中；点击右侧眼睛可查看明文。">
              <div class="relative flex items-center w-full">
                <UInput
                  v-model="draft.apiKey"
                  class="w-full"
                  :ui="{ base: 'pr-10' }"
                  :type="showApiKey ? 'text' : 'password'"
                  placeholder="输入 API Key"
                />
                <UButton
                  type="button"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="absolute right-1"
                  :icon="showApiKey ? 'i-carbon-view-off' : 'i-carbon-view'"
                  :title="showApiKey ? '隐藏 API Key' : '查看明文 API Key'"
                  :aria-label="showApiKey ? '隐藏 API Key' : '查看明文 API Key'"
                  @click="showApiKey = !showApiKey"
                />
              </div>
            </UFormField>
          </div>
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
