<script setup lang="ts">
import type { Channel } from '../../shared/types'

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

type SettingsSection = 'channels' | 'local' | 'queue' | 'desktop'

const { channels, settings, act } = useStudio()
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
const desktop = computed(() => import.meta.client && !!(window as any).redub)
const channelTitle = computed(() => (selected.value ? '编辑渠道' : '添加渠道'))
const engineReady = computed(() => !!health.value?.ffmpeg && !!health.value?.ffprobe)
const modelReady = computed(() => !!health.value?.models)

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
    description: '更新与本地配置',
    icon: 'i-carbon-application',
    desktopOnly: true
  }
]

function edit(channel?: Channel) {
  selected.value = channel?.id
  draft.value = {
    id: channel?.id || '',
    name: channel?.name || '新的配音渠道',
    type: channel?.type || 'volcengine',
    endpoint: channel?.endpoint || 'https://openspeech.bytedance.com/api/v3/tts/create',
    model: channel?.model || 'seed-audio-1.0',
    keyEnv: channel?.keyEnv || 'CUSTOM_API_KEY',
    apiKey: '',
    enabled: channel?.enabled ?? true,
    pitch: channel?.pitch || 0,
    speed: channel?.speed || 0,
    loudness: channel?.loudness || 0
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
async function updateDesktop(action: string) {
  desktopBusy.value = true
  try {
    desktopStatus.value = await (window as any).redub.update(action)
  } catch (e) {
    desktopStatus.value = String(e)
  }
  desktopBusy.value = false
}
onMounted(check)
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
            <button v-for="channel in channels" :key="channel.id" class="channel-row" @click="edit(channel)">
              <UIcon
                :name="channel.type === 'volcengine' ? 'i-carbon-microphone' : 'i-carbon-language'"
                class="size-6"
              />
              <div>
                <strong>{{ channel.name }}</strong
                ><span>{{ channel.type === 'volcengine' ? '配音' : '翻译' }} · {{ channel.model }}</span>
              </div>
              <UBadge
                :color="!channel.enabled ? 'neutral' : channel.configured ? 'success' : 'warning'"
                variant="soft"
                >{{ !channel.enabled ? '已停用' : channel.configured ? '已配置' : '未配置' }}</UBadge
              >
              <UIcon name="i-carbon-chevron-right" />
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
              可以。配音渠道按项目选择，翻译渠道在“任务与识别”中设置；修改渠道参数会使该渠道下已生成的配音和成片失效，需要重新生成。
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
                <div>
                  <strong>FFmpeg</strong>
                  <p>解码与编码音视频，执行裁剪、拼接、混音、波形读取和最终封装。</p>
                  <small>{{ health?.versions?.ffmpeg || '尚未检测到版本' }}</small>
                </div>
                <UBadge :color="health?.ffmpeg ? 'success' : 'warning'" variant="soft">{{
                  health?.ffmpeg ? '已就绪' : '待安装'
                }}</UBadge>
              </article>
              <article>
                <div class="engine-icon"><UIcon name="i-carbon-information" /></div>
                <div>
                  <strong>FFprobe</strong>
                  <p>读取素材时长、编码格式、画面尺寸和音轨数量，为时间轴与导出提供准确信息。</p>
                  <small>{{ health?.versions?.ffprobe || '尚未检测到版本' }}</small>
                </div>
                <UBadge :color="health?.ffprobe ? 'success' : 'warning'" variant="soft">{{
                  health?.ffprobe ? '已就绪' : '待安装'
                }}</UBadge>
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
                <div>
                  <strong>Demucs · htdemucs</strong>
                  <p>把原始音轨分离为人声和背景音。当前版本固定使用 htdemucs，页面中不可切换。</p>
                </div>
                <UBadge :color="health?.modelStatus?.demucs ? 'success' : 'warning'" variant="soft">{{
                  health?.modelStatus?.demucs ? '已安装' : '待安装'
                }}</UBadge>
              </article>
              <article>
                <div>
                  <strong>Faster Whisper · 可切换</strong>
                  <p>把语音识别为文字。可在“任务与识别”中切换 tiny、base、small、medium 或 large-v3。</p>
                </div>
                <UBadge :color="health?.modelStatus?.fasterWhisper ? 'success' : 'warning'" variant="soft">{{
                  health?.modelStatus?.fasterWhisper ? '已安装' : '待安装'
                }}</UBadge>
              </article>
              <article>
                <div>
                  <strong>Silero VAD · 内置</strong>
                  <p>检测人声起止位置，自动切分台词片段；随 Faster Whisper 环境提供，无需单独选择。</p>
                </div>
                <UBadge :color="health?.modelStatus?.fasterWhisper ? 'success' : 'warning'" variant="soft">{{
                  health?.modelStatus?.fasterWhisper ? '已安装' : '待安装'
                }}</UBadge>
              </article>
              <article>
                <div>
                  <strong>OpenCC · 内置</strong>
                  <p>把繁体识别结果转换为简体中文；不参与配音生成，也不需要切换。</p>
                </div>
                <UBadge :color="health?.modelStatus?.opencc ? 'success' : 'warning'" variant="soft">{{
                  health?.modelStatus?.opencc ? '已安装' : '待安装'
                }}</UBadge>
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
              <p class="help">设置队列并发、本机识别模型和默认翻译渠道。</p>
            </div>
          </div>
          <form
            class="settings-form"
            @submit.prevent="
              act(() => $fetch('/api/settings', { method: 'PATCH', body: queueDraft }), '任务设置已保存')
            "
          >
            <UFormField
              label="全局并发任务数"
              description="同时运行的任务总数；预处理、翻译、配音与合成共用此额度。数值越高越占用 CPU 和网络。"
            >
              <USelect v-model="queueDraft.concurrency" class="w-full" :items="[1, 2, 3, 4, 5, 6, 7, 8]" />
            </UFormField>
            <UFormField
              label="本地识别模型"
              description="Faster Whisper 模型越大越准确，但速度越慢、内存占用越高。"
            >
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
            <UFormField label="默认翻译渠道" description="只显示已启用的 OpenAI 兼容渠道。">
              <USelect
                v-model="queueDraft.translationChannelId"
                class="w-full"
                :items="
                  channels
                    .filter((c) => c.type === 'openai' && c.enabled)
                    .map((c) => ({ label: c.name, value: c.id }))
                "
              />
            </UFormField>
            <UCheckbox v-model="queueDraft.pauseOnFailure" label="任务失败后暂停队列" />
            <UButton color="neutral" variant="outline" type="submit" class="settings-save"
              >保存任务设置</UButton
            >
          </form>
        </section>

        <section v-else-if="activeSection === 'desktop' && desktop" class="settings-card settings-section">
          <div class="settings-card-header">
            <div>
              <h2>桌面应用</h2>
              <p class="help">检查更新、安装新版本或打开本地配置文件。</p>
            </div>
          </div>
          <div class="settings-form">
            <UButton color="neutral" variant="outline" :loading="desktopBusy" @click="updateDesktop('check')"
              >检查更新</UButton
            >
            <UButton
              color="neutral"
              variant="outline"
              :loading="desktopBusy"
              @click="updateDesktop('download')"
              >下载更新</UButton
            >
            <UButton color="neutral" variant="outline" @click="updateDesktop('install')">重启并安装</UButton>
            <UButton color="neutral" variant="ghost" @click="updateDesktop('config')">打开本地配置</UButton>
            <p v-if="desktopStatus" role="status" class="help">{{ desktopStatus }}</p>
          </div>
        </section>
      </div>
    </div>

    <UModal v-model:open="modalOpen" :title="channelTitle" :ui="{ content: 'sm:max-w-xl' }">
      <template #body>
        <form v-if="draft" class="channel-editor" @submit.prevent="save">
          <UFormField label="渠道名称"><UInput v-model="draft.name" class="w-full" /></UFormField>
          <UFormField label="类型">
            <USelect
              v-model="draft.type"
              class="w-full"
              :items="[
                { label: '火山 Audio 配音', value: 'volcengine' },
                { label: 'OpenAI 兼容翻译', value: 'openai' }
              ]"
            />
          </UFormField>
          <UFormField label="接口地址"><UInput v-model="draft.endpoint" class="w-full" /></UFormField>
          <UFormField label="模型 ID"><UInput v-model="draft.model" class="w-full" /></UFormField>
          <UFormField label="API Key" description="只保存在本机；编辑已有渠道时留空表示不修改。">
            <UInput v-model="draft.apiKey" class="w-full" type="password" placeholder="输入 API Key" />
          </UFormField>
          <UFormField label="兼容环境变量名">
            <UInput v-model="draft.keyEnv" class="w-full" placeholder="CUSTOM_API_KEY" />
          </UFormField>
          <details v-if="draft.type === 'volcengine'" class="advanced-options">
            <summary>声音参数</summary>
            <div class="settings-form">
              <UFormField label="音调">
                <UInput v-model.number="draft.pitch" class="w-full" type="number" min="-12" max="12" />
              </UFormField>
              <UFormField label="语速">
                <UInput v-model.number="draft.speed" class="w-full" type="number" min="-50" max="100" />
              </UFormField>
              <UFormField label="音量">
                <UInput v-model.number="draft.loudness" class="w-full" type="number" min="-50" max="100" />
              </UFormField>
            </div>
          </details>
          <UCheckbox v-model="draft.enabled" label="启用渠道" />
          <div class="modal-actions">
            <UButton type="submit" :loading="saving">保存渠道</UButton>
            <UButton color="neutral" variant="ghost" type="button" @click="modalOpen = false">取消</UButton>
          </div>
        </form>
      </template>
    </UModal>
  </section>
</template>
