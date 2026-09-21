<script setup lang="ts">
const { projects, selected, detail, jobs, refresh, select, settingsProject, workspacePanels, errorMessage } =
  useStudio()
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
let lastRefresh = 0
function show(next: 'home' | 'project' | 'settings', create = false) {
  view.value = next
  importing.value = create
}
async function choose(id: string, panel?: 'script' | 'preview') {
  if (panel) workspacePanels.value[id] = panel
  importing.value = false
  view.value = 'project'
  try {
    if (selected.value !== id || !detail.value) await select(id)
  } catch (e) {
    error.value = errorMessage(e)
  }
}
async function created(id: string) {
  await choose(id)
}
async function openProjectSettings(id: string) {
  await choose(id)
  settingsProject.value = id
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
    if (refreshing) return
    if (!jobs.value.some((j) => ['running', 'queued'].includes(j.status)) && Date.now() - lastRefresh < 10000)
      return
    refreshing = true
    try {
      await refresh()
      lastRefresh = Date.now()
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
          <UIcon name="i-carbon-folder" />项目
        </button>
      </nav>
      <div v-if="projects.length" class="sidebar-projects">
        <p class="nav-label">最近项目</p>
        <div
          v-for="p in projects"
          :key="p.id"
          class="sidebar-project-group"
          :class="{ active: selected === p.id && view === 'project' }"
        >
          <div class="sidebar-project-item">
            <button class="sidebar-project-main" @click="choose(p.id)">
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
            <UDropdownMenu
              :items="[
                [
                  {
                    label: '项目设置',
                    icon: 'i-carbon-settings-adjust',
                    onSelect: () => openProjectSettings(p.id)
                  }
                ]
              ]"
            >
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-carbon-overflow-menu-horizontal"
                :aria-label="`${p.name} 的更多操作`"
                size="xs"
              />
            </UDropdownMenu>
          </div>
          <nav class="project-children" :aria-label="`${p.name} 的工作区`">
            <button
              :class="{
                active:
                  selected === p.id && view === 'project' && (workspacePanels[p.id] || 'script') === 'script'
              }"
              @click="choose(p.id, 'script')"
            >
              <UIcon name="i-carbon-script" />配音
            </button>
            <button
              :class="{
                active: selected === p.id && view === 'project' && workspacePanels[p.id] === 'preview'
              }"
              @click="choose(p.id, 'preview')"
            >
              <UIcon name="i-carbon-play-outline" />预览成片
            </button>
          </nav>
        </div>
      </div>
      <div class="sidebar-footer">
        <button :class="{ active: view === 'settings' }" @click="show('settings')">
          <UIcon name="i-carbon-settings" />设置
        </button>
      </div>
    </aside>
    <main class="main-content" :class="{ 'project-main': view === 'project' && !importing }">
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
            <div v-for="p in list" :key="p.id" class="project-row">
              <button class="project-row-main" :aria-label="`打开项目：${p.name}`" @click="choose(p.id)">
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
                ><UBadge
                  :color="p.outputPath ? 'success' : p.paused ? 'warning' : 'neutral'"
                  variant="soft"
                  >{{ p.outputPath ? '可导出' : p.paused ? '已暂停' : '编辑中' }}</UBadge
                ><UIcon name="i-carbon-arrow-up-right" />
              </button>
              <UDropdownMenu
                :items="[
                  [
                    {
                      label: '项目设置',
                      icon: 'i-carbon-settings-adjust',
                      onSelect: () => openProjectSettings(p.id)
                    }
                  ]
                ]"
              >
                <UButton
                  color="neutral"
                  variant="ghost"
                  icon="i-carbon-overflow-menu-horizontal"
                  :aria-label="`${p.name} 的更多操作`"
                />
              </UDropdownMenu>
            </div>
            <p v-if="!list.length" class="help">没有找到匹配的项目。</p>
          </div>
        </section>
      </section>
    </main>
    <TaskManager />
  </div>
</template>
