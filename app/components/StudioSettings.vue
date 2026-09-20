<script setup lang="ts">
import type { Channel } from '../../shared/types'
const { channels, settings, act } = useStudio()
const modalOpen = ref(false),
  selected = ref<string>(),
  saving = ref(false)
const draft = ref<Channel & { apiKey: string }>()
const health = ref<{ ffmpeg: boolean; ffprobe: boolean; models: boolean }>(),
  checking = ref(false)
const queueDraft = ref({ ...settings.value }),
  desktopStatus = ref(''),
  desktopBusy = ref(false)
const desktop = computed(() => import.meta.client && !!(window as any).redub)
const channelTitle = computed(() => (selected.value ? '编辑渠道' : '添加渠道'))
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
    <header class="page-header settings-header">
      <div>
        <h1>设置</h1>
        <p class="help">渠道、处理环境和任务参数</p>
      </div>
    </header>
    <div class="settings-grid">
      <section class="settings-card settings-channels">
        <div class="settings-card-header">
          <div>
            <h2>AI 渠道</h2>
            <p class="help">配音和翻译使用的服务</p>
          </div>
          <UButton icon="i-carbon-add" size="sm" @click="edit()">添加渠道</UButton>
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
              >{{ !channel.enabled ? '已停用' : channel.configured ? '已配置' : '未配置' }}</UBadge
            >
            <UIcon name="i-carbon-chevron-right" />
          </button>
        </div>
      </section>
      <section class="settings-card settings-local">
        <div class="settings-card-header">
          <div>
            <h2>本机处理</h2>
            <p class="help">人声分离与台词识别</p>
          </div>
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-carbon-renew"
            :loading="checking"
            @click="check"
            >检查</UButton
          >
        </div>
        <div class="health-list">
          <span
            ><i :class="{ ok: health?.ffmpeg && health?.ffprobe }" />音视频引擎
            {{ !health ? '检查中' : health.ffmpeg && health.ffprobe ? '已就绪' : '待安装' }}</span
          ><span
            ><i :class="{ ok: health?.models }" />本地模型
            {{ !health ? '检查中' : health.models ? '已就绪' : '待安装' }}</span
          >
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
        <p v-if="health && !health.models" class="help">需安装 Python 3.11 与模型依赖。</p>
      </section>
      <section class="settings-card settings-queue">
        <div class="settings-card-header">
          <div>
            <h2>任务与识别</h2>
            <p class="help">队列并发和默认识别设置</p>
          </div>
        </div>
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
          <UCheckbox v-model="queueDraft.pauseOnFailure" label="失败后暂停队列" /><UButton
            color="neutral"
            variant="outline"
            type="submit"
            class="settings-save"
            >保存任务设置</UButton
          >
        </form>
      </section>
      <section v-if="desktop" class="settings-card settings-desktop">
        <div class="settings-card-header">
          <div>
            <h2>桌面应用</h2>
            <p class="help">更新和本地配置</p>
          </div>
        </div>
        <div class="row-actions">
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :loading="desktopBusy"
            @click="updateDesktop('check')"
            >检查更新</UButton
          ><UButton
            color="neutral"
            variant="outline"
            size="sm"
            :loading="desktopBusy"
            @click="updateDesktop('download')"
            >下载更新</UButton
          ><UButton color="neutral" variant="outline" size="sm" @click="updateDesktop('install')"
            >重启安装</UButton
          ><UButton color="neutral" variant="ghost" size="sm" @click="updateDesktop('config')"
            >打开本地配置</UButton
          >
        </div>
        <p v-if="desktopStatus" role="status" class="help">{{ desktopStatus }}</p>
      </section>
    </div>
    <UModal v-model:open="modalOpen" :title="channelTitle" :ui="{ content: 'sm:max-w-xl' }">
      <template #body
        ><form v-if="draft" class="channel-editor" @submit.prevent="save">
          <div class="form-grid">
            <UFormField label="渠道名称"><UInput v-model="draft.name" class="w-full" /></UFormField
            ><UFormField label="类型"
              ><USelect
                v-model="draft.type"
                class="w-full"
                :items="[
                  { label: '火山 Audio 配音', value: 'volcengine' },
                  { label: 'OpenAI 兼容翻译', value: 'openai' }
                ]"
            /></UFormField>
          </div>
          <UFormField label="接口地址"><UInput v-model="draft.endpoint" class="w-full" /></UFormField>
          <div class="form-grid">
            <UFormField label="模型 ID"><UInput v-model="draft.model" class="w-full" /></UFormField
            ><UFormField label="API Key" description="只保存在本机；编辑已有渠道时留空表示不修改。"
              ><UInput v-model="draft.apiKey" class="w-full" type="password" placeholder="输入 API Key"
            /></UFormField>
          </div>
          <UFormField label="兼容环境变量名"
            ><UInput v-model="draft.keyEnv" class="w-full" placeholder="CUSTOM_API_KEY"
          /></UFormField>
          <details v-if="draft.type === 'volcengine'" class="advanced-options">
            <summary>声音参数</summary>
            <div class="time-fields">
              <UFormField label="音调"
                ><UInput
                  v-model.number="draft.pitch"
                  class="w-full"
                  type="number"
                  min="-12"
                  max="12" /></UFormField
              ><UFormField label="语速"
                ><UInput
                  v-model.number="draft.speed"
                  class="w-full"
                  type="number"
                  min="-50"
                  max="100" /></UFormField
              ><UFormField label="音量"
                ><UInput v-model.number="draft.loudness" class="w-full" type="number" min="-50" max="100"
              /></UFormField>
            </div>
          </details>
          <UCheckbox v-model="draft.enabled" label="启用渠道" />
          <div class="modal-actions">
            <UButton type="submit" :loading="saving">保存渠道</UButton
            ><UButton color="neutral" variant="ghost" type="button" @click="modalOpen = false">取消</UButton>
          </div>
        </form></template
      >
    </UModal>
  </section>
</template>
