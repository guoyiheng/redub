<script setup lang="ts">
const {
  projects,
  selected,
  detail,
  jobs,
  refresh,
  select,
  settingsProject,
  workspacePanels,
  errorMessage,
  toast
} = useStudio()
const taskNavigation = useTaskNavigation()
watch(taskNavigation, (target) => {
  if (!target) return
  if (target.type === 'voice') {
    view.value = 'settings'
    return
  }
  if (target.projectId) void choose(target.projectId, 'script')
})
const view = ref<'home' | 'project' | 'settings'>('home'),
  importing = ref(false),
  loading = ref(true),
  error = ref(''),
  query = ref(''),
  projectFilter = ref<'active' | 'archived'>('active')

const archivedCount = computed(() => projects.value.filter((p) => p.archived).length)
const activeCount = computed(() => projects.value.filter((p) => !p.archived).length)

const list = computed(() => {
  const q = query.value.trim().toLowerCase()
  return projects.value
    .filter((p) => (projectFilter.value === 'archived' ? p.archived : !p.archived))
    .filter((p) => !q || p.name.toLowerCase().includes(q))
})

const sidebarProjects = computed(() => projects.value.filter((p) => !p.archived || p.id === selected.value))
const isPreviewMode = computed(
  () =>
    view.value === 'project' &&
    !importing.value &&
    !!selected.value &&
    workspacePanels.value[selected.value] === 'preview'
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
async function togglePin(id: string, pinned: boolean) {
  try {
    await $fetch(`/api/projects/${id}/pin`, {
      method: 'POST',
      body: { pinned }
    })
    await refresh()
  } catch (e) {
    error.value = errorMessage(e)
  }
}
async function toggleArchive(id: string, archived: boolean) {
  try {
    await $fetch(`/api/projects/${id}/archive`, {
      method: 'POST',
      body: { archived }
    })
    await refresh()
    toast.add({
      title: archived ? '项目已归档隐藏' : '已恢复项目',
      color: 'success'
    })
  } catch (e) {
    error.value = errorMessage(e)
  }
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
  <div class="studio-shell" :class="{ 'preview-active': isPreviewMode }">
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
      <div v-if="sidebarProjects.length" class="sidebar-projects">
        <p class="nav-label">最近项目</p>
        <div
          v-for="p in sidebarProjects"
          :key="p.id"
          class="sidebar-project-group"
          :class="{ 'is-selected': selected === p.id && view === 'project' }"
        >
          <div class="sidebar-project-item">
            <button
              class="sidebar-project-main"
              :title="p.name"
              :aria-current="selected === p.id && view === 'project' ? 'page' : undefined"
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
                class="shrink-0"
              /><span class="truncate">{{ p.name }}</span>
              <UIcon
                v-if="p.pinned"
                name="i-carbon-pin-filled"
                class="sidebar-pin-icon shrink-0"
                title="已置顶"
              />
              <UIcon
                v-if="p.archived"
                name="i-carbon-archive"
                class="sidebar-archive-icon shrink-0"
                title="已归档"
              />
            </button>
            <UDropdownMenu
              :items="[
                [
                  {
                    label: p.pinned ? '取消置顶' : '置顶项目',
                    icon: p.pinned ? 'i-carbon-pin-filled' : 'i-carbon-pin',
                    onSelect: () => togglePin(p.id, !p.pinned)
                  },
                  {
                    label: p.archived ? '取消归档' : '归档项目',
                    icon: p.archived ? 'i-carbon-undo' : 'i-carbon-archive',
                    onSelect: () => toggleArchive(p.id, !p.archived)
                  },
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
              <UIcon name="i-carbon-microphone" />配音
            </button>
            <button
              :class="{
                active: selected === p.id && view === 'project' && workspacePanels[p.id] === 'preview'
              }"
              @click="choose(p.id, 'preview')"
            >
              <UIcon name="i-carbon-play-outline" />预览
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
    <main
      class="main-content"
      :class="{
        'project-main': view === 'project' && !importing,
        'preview-mode': isPreviewMode,
        'settings-main': view === 'settings'
      }"
    >
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
            <div class="flex items-center gap-3">
              <h1>{{ projectFilter === 'archived' ? '已归档项目' : '项目' }}</h1>
              <UBadge v-if="projectFilter === 'archived'" color="neutral" variant="subtle">
                {{ list.length }}
              </UBadge>
            </div>
            <div class="row-actions">
              <UButton
                v-if="archivedCount > 0 || projectFilter === 'archived'"
                :color="projectFilter === 'archived' ? 'primary' : 'neutral'"
                :variant="projectFilter === 'archived' ? 'soft' : 'outline'"
                icon="i-carbon-archive"
                size="sm"
                @click="projectFilter = projectFilter === 'archived' ? 'active' : 'archived'"
              >
                {{ projectFilter === 'archived' ? '返回项目列表' : `已归档 (${archivedCount})` }}
              </UButton>
              <UInput
                v-if="projects.length"
                v-model="query"
                icon="i-carbon-search"
                :placeholder="projectFilter === 'archived' ? '查找已归档项目' : '查找项目'"
                aria-label="查找项目"
              />
              <UButton v-if="projectFilter !== 'archived'" icon="i-carbon-add" @click="importing = true"
                >新建项目</UButton
              >
            </div>
          </header>
          <div v-if="!projects.length" class="empty-state"><p>暂无项目</p></div>
          <div v-else-if="!list.length" class="empty-state">
            <UIcon
              :name="projectFilter === 'archived' ? 'i-carbon-archive' : 'i-carbon-folder'"
              class="text-3xl opacity-40"
            />
            <p>
              {{
                query ? '没有找到匹配的项目' : projectFilter === 'archived' ? '暂无已归档项目' : '暂无项目'
              }}
            </p>
          </div>
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
                  <div class="project-title-row">
                    <strong class="truncate">{{ p.name }}</strong>
                    <UIcon
                      v-if="p.pinned"
                      name="i-carbon-pin-filled"
                      class="project-pin-icon"
                      title="已置顶"
                    />
                  </div>
                  <span
                    >{{ p.kind === 'video' ? '视频' : p.kind === 'audio' ? '音频' : '文本' }} ·
                    {{ formatTime(p.duration) }} · {{ p.targetLanguage }}</span
                  >
                </div>
                <span class="project-date">{{ new Date(p.updatedAt).toLocaleDateString('zh-CN') }}</span
                ><UBadge v-if="p.archived" color="neutral" variant="subtle">已归档</UBadge
                ><UBadge
                  v-else
                  :color="p.outputPath ? 'success' : p.paused ? 'warning' : 'neutral'"
                  variant="soft"
                  >{{ p.outputPath ? '可导出' : p.paused ? '已暂停' : '编辑中' }}</UBadge
                ><UIcon name="i-carbon-arrow-up-right" />
              </button>
              <UDropdownMenu
                :items="[
                  [
                    {
                      label: p.pinned ? '取消置顶' : '置顶项目',
                      icon: p.pinned ? 'i-carbon-pin-filled' : 'i-carbon-pin',
                      onSelect: () => togglePin(p.id, !p.pinned)
                    },
                    {
                      label: p.archived ? '取消归档' : '归档项目',
                      icon: p.archived ? 'i-carbon-undo' : 'i-carbon-archive',
                      onSelect: () => toggleArchive(p.id, !p.archived)
                    },
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
          </div>
        </section>
      </section>
    </main>
    <TaskManager />
  </div>
</template>
