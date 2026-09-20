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
      <p class="sidebar-caption">让故事，换一种声音。</p>
      <UButton
        icon="i-carbon-add"
        class="new-project-button"
        color="neutral"
        variant="outline"
        @click="show('home', true)"
        >新建配音项目</UButton
      >
      <nav class="sidebar-nav" aria-label="主导航">
        <button :class="{ active: view === 'home' }" @click="show('home')">
          <UIcon name="i-carbon-folder" />我的项目<span>{{ projects.length }}</span></button
        ><button :class="{ active: view === 'settings' }" @click="show('settings')">
          <UIcon name="i-carbon-settings" />渠道与设置
        </button>
      </nav>
      <div class="sidebar-projects">
        <p class="eyebrow">最近的故事</p>
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
        <p v-if="!projects.length" class="help">你的第一个项目<br />将从这里开始。</p>
      </div>
      <div class="sidebar-bottom">
        <UIcon name="i-carbon-laptop" />
        <div><strong>本地工作室</strong><span>素材与项目保存在此设备</span></div>
        <span class="local-dot" />
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
        <header class="home-top">
          <span class="eyebrow">YOUR LOCAL DUBBING STUDIO</span><span class="edition">ReDub / 01</span>
        </header>
        <div class="home-intro">
          <div>
            <p class="intro-kicker">保留情绪，延续故事</p>
            <h1>熟悉的画面，<br />新的<span>声音。</span></h1>
            <p class="subtitle">从一句台词，到一部作品。<br />在原有的声音世界里，完成自然的 AI 配音。</p>
            <UButton icon="i-carbon-add" size="lg" @click="importing = true">开始一个新项目</UButton>
          </div>
          <div class="story-illustration" aria-hidden="true">
            <svg viewBox="0 0 330 280" fill="none">
              <path
                d="M43 139c20-56 50-79 99-84 62-7 111 17 129 60 16 39 5 92-39 119-33 20-84 18-127-5-35-19-64-56-62-90Z"
                fill="#eae6d9"
              />
              <path
                d="M122 74c-22 19-35 40-36 67-2 28 11 47 35 68M207 75c22 17 37 40 37 67 0 28-16 51-37 67"
                stroke="#c96442"
                stroke-width="2"
                stroke-linecap="round"
              />
              <path
                d="M108 95c-13 14-21 29-21 47s7 31 20 43M220 96c12 14 19 29 19 46s-7 32-19 46"
                stroke="#c96442"
                stroke-width="2"
                stroke-linecap="round"
              />
              <rect
                x="142"
                y="77"
                width="45"
                height="112"
                rx="23"
                stroke="#4d4c48"
                stroke-width="2.5"
                transform="rotate(-9 142 77)"
                fill="#faf9f5"
              />
              <path
                d="m151 105 23-4m-21 16 24-4m-23 17 24-4m-22 17 24-4M129 146c1 36 17 59 48 56 26-2 39-25 31-54M176 202l5 29m-24 4 51-8"
                stroke="#4d4c48"
                stroke-width="2.5"
                stroke-linecap="round"
              />
              <path
                d="m251 42 4 16 14-8m-15 8 13 8m-13-8-11 11M49 205l-11 7m9-15-14 1"
                stroke="#8e9a7e"
                stroke-width="2"
                stroke-linecap="round"
              /></svg
            ><span>Same story. A new voice.</span>
          </div>
        </div>
        <div class="home-process">
          <span><b>01</b> 导入素材</span><UIcon name="i-carbon-arrow-right" /><span><b>02</b> 校对与配音</span
          ><UIcon name="i-carbon-arrow-right" /><span><b>03</b> 预览与导出</span>
          <p>原声参考 · 背景保留 · 逐句替换</p>
        </div>
        <section class="project-library">
          <div class="section-heading">
            <h2>
              我的项目 <small>{{ projects.length }}</small>
            </h2>
            <UInput
              v-if="projects.length"
              v-model="query"
              icon="i-carbon-search"
              placeholder="查找项目"
              aria-label="查找项目"
            />
          </div>
          <div v-if="!projects.length" class="library-empty">
            <div>
              <h3>给下一个故事，留一个位置。</h3>
              <p>导入视频、音频或台词，ReDub 会从合适的步骤开始。</p>
            </div>
            <UButton color="neutral" variant="outline" icon="i-carbon-upload" @click="importing = true"
              >导入素材</UButton
            >
          </div>
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
        <footer class="home-footer">
          <span>为每一种表达，找到合适的声音。</span><span>LOCAL FIRST. STORY ALWAYS.</span>
        </footer>
      </section>
    </main>
    <TaskManager />
  </div>
</template>
