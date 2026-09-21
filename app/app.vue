<script setup lang="ts">
import { zh_cn } from '@nuxt/ui/locale'
</script>
<template>
  <UApp :locale="zh_cn" :toaster="{ position: 'top-right', expand: true, max: 3 }"><NuxtPage /></UApp>
</template>
