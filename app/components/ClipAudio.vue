<script setup lang="ts">
const props = defineProps<{ src?: string; label: string; empty?: string }>()
const failed = ref(false)
const player = ref<HTMLAudioElement>()
watch(
  () => props.src,
  () => {
    failed.value = false
  }
)
function play() {
  document.querySelectorAll('audio, video').forEach((el) => {
    if (el !== player.value) (el as HTMLMediaElement).pause()
  })
}
function retry() {
  failed.value = false
  player.value?.load()
}
</script>
<template>
  <div class="clip-audio">
    <audio
      v-if="src"
      ref="player"
      :src="src"
      :aria-label="label"
      controls
      controlslist="nodownload noplaybackrate"
      preload="none"
      @play="play"
      @error="failed = true"
    />
    <span v-else class="help">{{ empty || '暂无音频' }}</span>
    <div v-if="failed" class="row-actions">
      <span class="help">音频读取失败</span
      ><UButton color="neutral" variant="outline" @click="retry">重新加载</UButton>
    </div>
  </div>
</template>
