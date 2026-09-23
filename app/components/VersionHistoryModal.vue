<script setup lang="ts">
import type { Segment, TranslationVersion, AudioVersion } from '../../shared/types'
import { mediaUrl } from '../composables/useStudio'

const props = defineProps<{
  segment: Segment | null
  globalIndex: number
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  restored: [segment: Segment]
}>()

const toast = useToast()
const activeTab = ref<'translation' | 'audio'>('translation')
const restoringId = ref<string | null>(null)

const localOpen = computed({
  get: () => props.open,
  set: (val) => emit('update:open', val)
})

// Build list of translation versions
const translationList = computed(() => {
  if (!props.segment) return []
  const list = [...(props.segment.translationHistory || [])]
  // If current translation exists and not present in history, show as current version
  if (
    props.segment.translation &&
    !list.some((item) => item.text.trim() === props.segment!.translation.trim())
  ) {
    list.unshift({
      id: 'current',
      name: '当前译文',
      text: props.segment.translation,
      createdAt: Date.now()
    })
  }
  return list.slice().reverse()
})

// Build list of audio versions
const audioList = computed(() => {
  if (!props.segment) return []
  const list = [...(props.segment.audioHistory || [])]
  // If current audio exists and not present in history, show as current version
  if (props.segment.generatedPath && !list.some((item) => item.audioPath === props.segment!.generatedPath)) {
    list.unshift({
      id: 'current',
      name: '当前配音',
      audioPath: props.segment.generatedPath,
      duration: props.segment.generatedDuration,
      synthesisMode: props.segment.synthesisMode,
      speaker: props.segment.synthesisMode === 'ai' ? props.segment.aiSpeaker : props.segment.ttsVoice,
      subtitle: props.segment.subtitle,
      createdAt: Date.now()
    })
  }
  return list.slice().reverse()
})

function isCurrentTranslation(item: TranslationVersion) {
  if (!props.segment) return false
  return item.text.trim() === props.segment.translation.trim()
}

function isCurrentAudio(item: AudioVersion) {
  if (!props.segment) return false
  return item.audioPath === props.segment.generatedPath
}

function formatTime(ts: number) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function restoreVersion(type: 'translation' | 'audio', item: { id: string; name: string }) {
  if (!props.segment || restoringId.value) return
  restoringId.value = item.id
  try {
    const res = await $fetch<{ ok: boolean; segment: Segment }>(
      `/api/segments/${props.segment.id}/restore-version`,
      {
        method: 'POST',
        body: { type, versionId: item.id }
      }
    )
    if (res?.ok && res.segment) {
      toast.add({
        title: '已设为终稿',
        description: `已将版本 ${item.name} 恢复为当前${type === 'translation' ? '译文' : '配音'}终稿`,
        color: 'success'
      })
      emit('restored', res.segment)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '恢复版本失败'
    toast.add({
      title: '操作失败',
      description: message,
      color: 'error'
    })
  } finally {
    restoringId.value = null
  }
}
</script>

<template>
  <UModal
    v-model:open="localOpen"
    :title="`第 ${globalIndex} 句历史版本`"
    :description="`查看和对比本句的历史译文与历史配音，支持将任一版本设为可用终稿。`"
    :ui="{ content: 'sm:max-w-2xl ring-0' }"
  >
    <template #body>
      <div class="version-modal-content">
        <UTabs
          v-model="activeTab"
          color="neutral"
          variant="link"
          :content="false"
          aria-label="历史版本类型"
          :items="[
            {
              label: '译文版本',
              value: 'translation',
              icon: 'i-carbon-language',
              badge: translationList.length
            },
            { label: '配音版本', value: 'audio', icon: 'i-carbon-microphone', badge: audioList.length }
          ]"
        />

        <!-- Translation Tab -->
        <div v-if="activeTab === 'translation'" class="version-list-pane">
          <div v-if="!translationList.length" class="version-empty-state">
            <UIcon name="i-carbon-document-blank" class="empty-icon" />
            <p>暂无译文历史版本</p>
            <small>翻译生成或修改译文后会自动记录版本</small>
          </div>
          <div v-else class="version-card-list">
            <div
              v-for="item in translationList"
              :key="item.id"
              class="version-card"
              :class="{ 'is-current': isCurrentTranslation(item) }"
            >
              <div class="version-card-header">
                <div class="version-info">
                  <span class="version-tag">{{ item.name }}</span>
                  <span v-if="isCurrentTranslation(item)" class="current-draft-badge">当前终稿</span>
                  <time class="version-time">{{ formatTime(item.createdAt) }}</time>
                </div>
                <div class="version-actions">
                  <UButton
                    v-if="!isCurrentTranslation(item)"
                    size="md"
                    variant="outline"
                    color="neutral"
                    icon="i-carbon-checkmark"
                    :loading="restoringId === item.id"
                    @click="restoreVersion('translation', item)"
                    >设为终稿</UButton
                  >
                  <span v-else class="current-active-label">使用中</span>
                </div>
              </div>
              <div class="version-text-body">
                {{ item.text }}
              </div>
            </div>
          </div>
        </div>

        <!-- Audio Tab -->
        <div v-if="activeTab === 'audio'" class="version-list-pane">
          <div v-if="!audioList.length" class="version-empty-state">
            <UIcon name="i-carbon-waveform" class="empty-icon" />
            <p>暂无配音历史版本</p>
            <small>生成配音后会自动记录音频历史版本并物理保留</small>
          </div>
          <div v-else class="version-card-list">
            <div
              v-for="item in audioList"
              :key="item.id"
              class="version-card"
              :class="{ 'is-current': isCurrentAudio(item) }"
            >
              <div class="version-card-header">
                <div class="version-info">
                  <span class="version-tag">{{ item.name }}</span>
                  <span v-if="isCurrentAudio(item)" class="current-draft-badge">当前终稿</span>
                  <span class="version-voice-meta">
                    {{ item.synthesisMode === 'tts' ? '微软 TTS' : 'AI 配音' }}
                    <span v-if="item.speaker">· {{ item.speaker }}</span>
                  </span>
                  <span v-if="item.duration" class="version-duration">{{ item.duration.toFixed(1) }}s</span>
                  <time class="version-time">{{ formatTime(item.createdAt) }}</time>
                </div>
                <div class="version-actions">
                  <UButton
                    v-if="!isCurrentAudio(item)"
                    size="md"
                    variant="outline"
                    color="neutral"
                    icon="i-carbon-checkmark"
                    :loading="restoringId === item.id"
                    @click="restoreVersion('audio', item)"
                    >设为终稿</UButton
                  >
                  <span v-else class="current-active-label">使用中</span>
                </div>
              </div>
              <div class="version-audio-player">
                <AudioPlayer :src="mediaUrl(item.audioPath)" :label="`${item.name} 试听`" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
