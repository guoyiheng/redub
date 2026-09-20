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
    <header>
      <p class="eyebrow">STUDIO SETTINGS</p>
      <h1>把工具调到顺手。</h1>
      <p class="subtitle">管理声音渠道、本机处理和任务队列。</p>
    </header>
    <section class="settings-section">
      <div class="section-heading">
        <div>
          <h2>AI 渠道</h2>
          <p class="help">配音支持火山 Audio 兼容接口，翻译支持 OpenAI 兼容接口。</p>
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
            >{{ !channel.enabled ? '已停用' : channel.configured ? '已配置 Key' : '等待填写 Key' }}</UBadge
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
        <UFormField
          label="接口地址"
          :description="
            draft.type === 'openai'
              ? '填写基础地址，例如 https://api.openai.com/v1'
              : '填写完整的音频生成接口地址'
          "
          ><UInput v-model="draft.endpoint" class="w-full"
        /></UFormField>
        <div class="form-grid">
          <UFormField label="模型 ID"><UInput v-model="draft.model" class="w-full" /></UFormField
          ><UFormField label="Key 的环境变量名" description="将对应 Key 填入本机 .env 文件，重启后生效。"
            ><UInput v-model="draft.keyEnv" class="w-full"
          /></UFormField>
        </div>
        <div v-if="draft.type === 'volcengine'" class="time-fields">
          <UFormField label="音调（-12 ～ 12）"
            ><UInput v-model.number="draft.pitch" type="number" min="-12" max="12" /></UFormField
          ><UFormField label="语速（-50 ～ 100）"
            ><UInput v-model.number="draft.speed" type="number" min="-50" max="100" /></UFormField
          ><UFormField label="音量（-50 ～ 100）"
            ><UInput v-model.number="draft.loudness" type="number" min="-50" max="100"
          /></UFormField>
        </div>
        <UCheckbox v-model="draft.enabled" label="启用渠道" />
        <div class="row-actions">
          <UButton type="submit" :loading="saving">保存渠道</UButton
          ><UButton color="neutral" variant="ghost" @click="draft = undefined">取消</UButton>
        </div>
      </form>
      <p class="help">配音渠道可在项目设置中选择。翻译默认使用「台词翻译」渠道，请编辑它的地址与模型。</p>
    </section>
    <section class="settings-section">
      <div class="section-heading">
        <div>
          <h2>本机音频处理</h2>
          <p class="help">分离与识别无需上传素材，模型首次运行时下载。</p>
        </div>
        <UButton color="neutral" variant="ghost" icon="i-carbon-renew" :loading="checking" @click="check"
          >检查环境</UButton
        >
      </div>
      <div class="health-list">
        <span
          ><i :class="{ ok: health?.ffmpeg && health?.ffprobe }" />音视频引擎
          {{ !health ? '检查中' : health.ffmpeg && health.ffprobe ? '已就绪' : '待安装' }}</span
        ><span
          ><i :class="{ ok: health?.models }" />本地模型环境
          {{ !health ? '检查中' : health.models ? '已就绪' : '待安装' }}</span
        >
      </div>
      <p v-if="health && !health.models" class="help">
        请按 README 安装本地模型环境；桌面版可在本地配置文件中指定 Python 路径。
      </p>
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
          <UFormField label="同时处理任务数" description="同一项目按步骤执行，不同项目并行。"
            ><USelect v-model="queueDraft.concurrency" :items="[1, 2, 3, 4, 5, 6, 7, 8]" /></UFormField
          ><UFormField label="本地识别模型" description="更大的模型通常更准确，也更慢。"
            ><USelect
              v-model="queueDraft.whisperModel"
              :items="['tiny', 'base', 'small', 'medium', 'large-v3']"
          /></UFormField>
        </div>
        <UCheckbox v-model="queueDraft.pauseOnFailure" label="任务失败后暂停该项目的后续队列" />
        <p class="help">关闭暂停后，失败步骤的依赖任务仍会等待你重试或跳过，其他独立任务可继续。</p>
        <UButton color="neutral" variant="outline" type="submit">保存任务设置</UButton>
      </form>
    </section>
    <section v-if="desktop" class="settings-section">
      <h2>桌面应用与更新</h2>
      <p class="help">网页界面可独立更新；桌面组件更新下载完成后可重启安装。</p>
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
      <p role="status">{{ desktopStatus }}</p>
    </section>
  </section>
</template>
