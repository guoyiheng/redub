<script setup lang="ts">
import type { Channel } from '../../shared/types'
const { channels, settings, act } = useStudio()
const selected = ref<string>(),
  draft = ref<Channel>(),
  saving = ref(false)
const health = ref<{ ffmpeg: boolean; ffprobe: boolean; models: boolean }>(),
  checking = ref(false)
const queueDraft = ref({ ...settings.value })
const desktopStatus = ref(''),
  desktopBusy = ref(false)
const desktop = computed(() => import.meta.client && !!(window as any).redub)
function edit(channel: Channel) {
  selected.value = channel.id
  draft.value = { ...channel }
}
function add() {
  selected.value = undefined
  draft.value = {
    id: '',
    name: '新的配音渠道',
    type: 'volcengine',
    endpoint: 'https://openspeech.bytedance.com/api/v3/tts/create',
    model: 'seed-audio-1.0',
    keyEnv: 'CUSTOM_API_KEY',
    enabled: true,
    pitch: 0,
    speed: 0,
    loudness: 0
  }
}
async function save() {
  if (!draft.value) return
  saving.value = true
  if (
    await act(
      () =>
        $fetch(selected.value ? `/api/channels/${selected.value}` : '/api/channels', {
          method: selected.value ? 'PATCH' : 'POST',
          body: draft.value
        }),
      '渠道已保存'
    )
  )
    draft.value = undefined
  saving.value = false
}
async function check() {
  checking.value = true
  await act(async () => {
    health.value = await $fetch('/api/health')
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
    <header class="page-header"><h1>渠道与设置</h1></header>
    <section class="settings-section">
      <div class="section-heading">
        <div>
          <h2>AI 渠道</h2>
        </div>
        <UButton icon="i-carbon-add" color="neutral" variant="outline" @click="add">添加渠道</UButton>
      </div>
      <div class="channel-list">
        <button v-for="channel in channels" :key="channel.id" class="channel-row" @click="edit(channel)">
          <UIcon
            :name="channel.type === 'volcengine' ? 'i-carbon-microphone' : 'i-carbon-language'"
            class="size-6"
          />
          <div>
            <strong>{{ channel.name }}</strong
            ><span>{{ channel.model }}</span>
          </div>
          <UBadge
            :color="!channel.enabled ? 'neutral' : channel.configured ? 'success' : 'warning'"
            variant="soft"
            >{{ !channel.enabled ? '已停用' : channel.configured ? '已配置 Key' : '未配置 Key' }}</UBadge
          ><UIcon name="i-carbon-chevron-right" />
        </button>
      </div>
      <form v-if="draft" class="channel-editor" @submit.prevent="save">
        <div class="form-grid">
          <UFormField label="渠道名称"><UInput v-model="draft.name" class="w-full" /></UFormField
          ><UFormField label="类型"
            ><USelect
              v-model="draft.type"
              :items="[
                { label: '火山 Audio 配音', value: 'volcengine' },
                { label: 'OpenAI 兼容翻译', value: 'openai' }
              ]"
              class="w-full"
          /></UFormField>
        </div>
        <UFormField label="接口地址"><UInput v-model="draft.endpoint" class="w-full" /></UFormField>
        <div class="form-grid">
          <UFormField label="模型 ID"><UInput v-model="draft.model" class="w-full" /></UFormField
          ><UFormField label="Key 环境变量" description="在 .env 填写，重启生效。"
            ><UInput v-model="draft.keyEnv" class="w-full"
          /></UFormField>
        </div>
        <details v-if="draft.type === 'volcengine'" class="advanced-options">
          <summary>声音参数</summary>
          <div class="time-fields">
            <UFormField label="音调（-12 ～ 12）"
              ><UInput
                class="w-full"
                v-model.number="draft.pitch"
                type="number"
                min="-12"
                max="12" /></UFormField
            ><UFormField label="语速（-50 ～ 100）"
              ><UInput
                class="w-full"
                v-model.number="draft.speed"
                type="number"
                min="-50"
                max="100" /></UFormField
            ><UFormField label="音量（-50 ～ 100）"
              ><UInput class="w-full" v-model.number="draft.loudness" type="number" min="-50" max="100"
            /></UFormField>
          </div>
        </details>
        <UCheckbox v-model="draft.enabled" label="启用渠道" />
        <div class="row-actions">
          <UButton type="submit" :loading="saving">保存渠道</UButton
          ><UButton color="neutral" variant="ghost" @click="draft = undefined">取消</UButton>
        </div>
      </form>
    </section>
    <section class="settings-section">
      <div class="section-heading">
        <div>
          <h2>本机音频处理</h2>
        </div>
        <UButton color="neutral" variant="ghost" icon="i-carbon-renew" :loading="checking" @click="check"
          >检查环境</UButton
        >
      </div>
      <UButton
        v-if="desktop && health && !health.models"
        color="neutral"
        variant="outline"
        :loading="desktopBusy"
        @click="updateDesktop('models')"
        >安装本地模型环境</UButton
      >
      <p v-if="desktopBusy" class="help">正在安装，请保持应用打开。</p>
      <div class="health-list">
        <span
          ><i :class="{ ok: health?.ffmpeg && health?.ffprobe }" />音视频引擎
          {{ !health ? '检查中' : health.ffmpeg && health.ffprobe ? '已就绪' : '待安装' }}</span
        ><span
          ><i :class="{ ok: health?.models }" />本地模型环境
          {{ !health ? '检查中' : health.models ? '已就绪' : '待安装' }}</span
        >
      </div>
      <p v-if="health && !health.models" class="help">需安装 Python 3.11 与模型依赖，见 README。</p>
    </section>
    <section class="settings-section">
      <h2>任务与识别</h2>
      <form
        class="queue-form"
        @submit.prevent="
          act(() => $fetch('/api/settings', { method: 'PATCH', body: queueDraft }), '任务设置已保存')
        "
      >
        <div class="form-grid">
          <UFormField label="并发任务数"
            ><USelect
              v-model="queueDraft.concurrency"
              class="w-full"
              :items="[1, 2, 3, 4, 5, 6, 7, 8]" /></UFormField
          ><UFormField label="本地识别模型"
            ><USelect
              v-model="queueDraft.whisperModel"
              class="w-full"
              :items="['tiny', 'base', 'small', 'medium', 'large-v3']"
          /></UFormField>
        </div>
        <UFormField label="翻译渠道"
          ><USelect
            v-model="queueDraft.translationChannelId"
            class="w-full"
            :items="
              channels
                .filter((c) => c.type === 'openai' && c.enabled)
                .map((c) => ({ label: c.name, value: c.id }))
            "
        /></UFormField>
        <UCheckbox v-model="queueDraft.pauseOnFailure" label="失败后暂停队列" />

        <UButton color="neutral" variant="outline" type="submit">保存任务设置</UButton>
      </form>
    </section>
    <section v-if="desktop" class="settings-section">
      <h2>桌面应用与更新</h2>

      <div class="row-actions">
        <UButton color="neutral" variant="outline" :loading="desktopBusy" @click="updateDesktop('check')"
          >检查桌面更新</UButton
        ><UButton color="neutral" variant="outline" :loading="desktopBusy" @click="updateDesktop('download')"
          >下载更新</UButton
        ><UButton color="neutral" variant="outline" @click="updateDesktop('install')">重启并安装</UButton
        ><UButton color="neutral" variant="outline" :loading="desktopBusy" @click="updateDesktop('web')"
          >更新网页界面</UButton
        ><UButton color="neutral" variant="ghost" @click="updateDesktop('config')">打开本地配置</UButton>
      </div>
      <p v-if="desktopStatus" role="status" class="help">{{ desktopStatus }}</p>
    </section>
  </section>
</template>
