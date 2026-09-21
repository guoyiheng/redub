<script setup lang="ts">
defineOptions({ inheritAttrs: false })
defineProps<{ reason?: string; loading?: boolean }>()
</script>
<template>
  <UTooltip
    :text="reason || '正在处理，请稍候'"
    :disabled="!reason && !loading"
    :delay-duration="150"
    :ui="{ content: 'h-auto max-w-xs', text: 'whitespace-normal' }"
  >
    <span class="action-hint" :tabindex="reason || loading ? 0 : undefined" :aria-label="reason || undefined">
      <UButton v-bind="$attrs" :disabled="!!reason || loading" :loading="loading"><slot /></UButton>
    </span>
  </UTooltip>
</template>
