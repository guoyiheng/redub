<script setup lang="ts">
const props = defineProps<{ title: string; value: string }>()
const full = ref(false)
const large = computed(() => props.value.length > 16000)
</script>
<template>
  <section class="log-block">
    <h4>{{ title }}</h4>
    <pre tabindex="0">{{ large && !full ? value.slice(0, 16000) : value }}</pre>
    <UButton v-if="large" color="neutral" variant="ghost" size="xs" @click="full = !full">{{
      full ? '收起长内容' : `显示完整内容（${value.length.toLocaleString()} 字符）`
    }}</UButton>
  </section>
</template>
<style scoped>
.log-block {
  min-width: 0;
}
h4 {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
pre {
  max-height: 380px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 12px;
  background: var(--ui-bg-muted);
  border-radius: 6px;
  font:
    12px/1.6 ui-monospace,
    monospace;
}
</style>
