<script setup lang="ts">
defineProps<{ src?: string; label: string; empty?: string; duration?: number; compact?: boolean }>()
</script>

<template>
  <AudioPlayer :src="src" :label="label" :empty="empty" :duration="duration" :compact="compact">
    <template v-if="$slots.leading" #leading>
      <slot name="leading" />
    </template>
    <template v-if="$slots.trailing" #trailing>
      <slot name="trailing" />
    </template>
  </AudioPlayer>
</template>
