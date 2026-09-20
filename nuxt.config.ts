export default defineNuxtConfig({
  compatibilityDate: '2026-09-19',
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ssr: false,
  devtools: { enabled: false },
  ui: { fonts: false },
  colorMode: { preference: 'light' },
  icon: { serverBundle: { collections: ['carbon'] } },
  nitro: { preset: 'node-server', externals: { external: ['@libsql/client', 'ffmpeg-static', 'ffprobe-static'] } },
  app: { head: { title: 'ReDub · 配音工作室', htmlAttrs: { lang: 'zh-CN' }, meta: [{ name: 'description', content: '保留故事，赋予新的声音。本地 AI 配音工作室。' }] } }
})
