<script setup lang="ts">
const { projects, selected, detail, jobs, refresh, select, errorMessage } = useStudio()
const view = ref<'home' | 'project' | 'settings'>('home'),
  importing = ref(false),
  loading = ref(true),
  error = ref(''),
  query = ref('')
const list = computed(() =>
  projects.value.filter((p) => p.name.toLowerCase().includes(query.value.toLowerCase()))
)
let timer: ReturnType<typeof setInterval> | undefined
let refreshing = false
function show(next: 'home' | 'project' | 'settings', create = false) {
  view.value = next
  importing.value = create
}
async function choose(id: string) {
  importing.value = false
  view.value = 'project'
  try {
    await select(id)
  } catch (e) {
    error.value = errorMessage(e)
  }
}
async function created(id: string) {
  await choose(id)
}
async function load() {
  loading.value = true
  error.value = ''
  try {
    await refresh()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}
onMounted(async () => {
  await load()
  const id = useRoute().query.project
  if (typeof id === 'string' && projects.value.some((p) => p.id === id)) await choose(id)
  timer = setInterval(async () => {
    if (refreshing || !jobs.value.some((j) => ['running', 'queued'].includes(j.status))) return
    refreshing = true
    try {
      await refresh()
    } catch {
      /* A visible retry appears if the next requested operation fails. */
    } finally {
      refreshing = false
    }
  }, 2000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>
<template>
  <div class="studio-shell">
    <aside class="sidebar">
      <button class="wordmark" aria-label="ReDub 首页" @click="show('home')">
        <svg width="31" height="31" viewBox="0 0 31 31" fill="none" aria-hidden="true">
          <path
            d="M4 12v7M10 6v19M16 2v27M22 8v15M28 12v7"
            stroke="currentColor"
            stroke-width="3.4"
            stroke-linecap="round"
          /></svg
        ><span>ReDub<span class="logo-dot">.</span></span>
      </button>
      <nav class="sidebar-nav" aria-label="主导航">
        <button :class="{ active: view === 'home' }" @click="show('home')">
          <UIcon name="i-carbon-folder" />项目</button
        ><button :class="{ active: view === 'settings' }" @click="show('settings')">
          <UIcon name="i-carbon-settings" />渠道与设置
        </button>
      </nav>
      <div v-if="projects.length" class="sidebar-projects">
        <p class="nav-label">最近项目</p>
        <button
          v-for="p in projects.slice(0, 8)"
          :key="p.id"
          :class="{ active: selected === p.id && view === 'project' }"
          @click="choose(p.id)"
        >
          <UIcon
            :name="
              p.kind === 'video'
                ? 'i-carbon-video'
                : p.kind === 'audio'
                  ? 'i-carbon-music'
                  : 'i-carbon-document'
            "
          /><span>{{ p.name }}</span>
        </button>
      </div>
    </aside>
    <main class="main-content">
      <div v-if="error" class="page-error">
        <UAlert color="error" title="连接遇到问题" :description="error" /><UButton
          color="neutral"
          variant="outline"
          @click="load"
          >重新连接</UButton
        >
      </div>
      <div v-if="loading" class="loading-view">
        <USkeleton class="h-10 w-64" /><USkeleton class="h-72 w-full" />
      </div>
      <ImportProject v-else-if="importing" @created="created" @cancel="importing = false" />
      <StudioSettings v-else-if="view === 'settings'" />
      <ProjectWorkspace v-else-if="view === 'project' && detail" :key="detail.project.id" />
      <section v-else class="home-page">
        <section class="project-library">
          <header class="page-header">
            <h1>项目</h1>
            <div class="row-actions">
              <UInput
                v-if="projects.length"
                v-model="query"
                icon="i-carbon-search"
                placeholder="查找项目"
                aria-label="查找项目"
              />
              <UButton icon="i-carbon-add" @click="importing = true">新建项目</UButton>
            </div>
          </header>
          <div v-if="!projects.length" class="empty-state"><p>暂无项目</p></div>
          <div v-else class="project-list">
            <button v-for="p in list" :key="p.id" class="project-row" @click="choose(p.id)">
              <div class="project-symbol">
                <UIcon
                  :name="
                    p.kind === 'video'
                      ? 'i-carbon-video'
                      : p.kind === 'audio'
                        ? 'i-carbon-music'
                        : 'i-carbon-document'
                  "
                />
              </div>
              <div class="project-row-name">
                <strong>{{ p.name }}</strong
                ><span
                  >{{ p.kind === 'video' ? '视频' : p.kind === 'audio' ? '音频' : '文本' }} ·
                  {{ formatTime(p.duration) }} · {{ p.targetLanguage }}</span
                >
              </div>
              <span class="project-date">{{ new Date(p.updatedAt).toLocaleDateString('zh-CN') }}</span
              ><UBadge :color="p.outputPath ? 'success' : p.paused ? 'warning' : 'neutral'" variant="soft">{{
                p.outputPath ? '可导出' : p.paused ? '已暂停' : '编辑中'
              }}</UBadge
              ><UIcon name="i-carbon-arrow-up-right" />
            </button>
            <p v-if="!list.length" class="help">没有找到匹配的项目。</p>
          </div>
        </section>
      </section>
    </main>
    <TaskManager />
  </div>
</template>
