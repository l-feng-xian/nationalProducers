<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import WiEntryEditor from '@/components/world/WiEntryEditor.vue'
import { useWorldsStore } from '@/stores/worlds'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { world_info_position, type WorldInfoEntry } from '@/types/worldinfo'

const route = useRoute()
const router = useRouter()
const worlds = useWorldsStore()
const settings = useSettingsStore()
const toast = useToast()

const fileInput = ref<HTMLInputElement | null>(null)

const bookId = computed(() => {
  const v = route.params['bookId']
  return Array.isArray(v) ? v[0] : v
})
const uid = computed(() => {
  const v = route.params['uid']
  const s = Array.isArray(v) ? v[0] : v
  return s === undefined ? undefined : Number(s)
})

const book = computed(() => worlds.byId(bookId.value))
const entries = computed<WorldInfoEntry[]>(() => {
  const b = book.value
  if (!b) return []
  return Object.values(b.entries).sort((a, b2) => a.order - b2.order || a.uid - b2.uid)
})
const entry = computed(() => {
  const b = book.value
  if (!b || uid.value === undefined) return undefined
  return b.entries[String(uid.value)]
})

/** 移动端只渲染最深的一栏 */
const mobilePane = computed(() => (entry.value ? 'entry' : book.value ? 'list' : 'books'))

onMounted(() => {
  if (!worlds.loaded) void worlds.load()
  if (!settings.loaded) void settings.load()
})

async function createBook() {
  const b = await worlds.create()
  await router.push(`/worlds/${b.id}`)
}

async function addEntry() {
  const b = book.value
  if (!b) return
  const e = await worlds.addEntry(b.id)
  if (e) await router.push(`/worlds/${b.id}/${e.uid}`)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function onEntryChange() {
  const b = book.value
  const e = entry.value
  if (!b || !e) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void worlds.upsertEntry(b.id, e)
  }, 400)
}

async function removeEntry(u: number) {
  const b = book.value
  if (!b) return
  await worlds.removeEntry(b.id, u)
  if (uid.value === u) await router.push(`/worlds/${b.id}`)
}

async function removeBook() {
  const b = book.value
  if (!b) return
  if (!confirm(`确定删除世界书「${b.name}」？`)) return
  await worlds.remove(b.id)
  toast.success('已删除')
  await router.push('/worlds')
}

function isGlobal(id: string): boolean {
  return settings.settings.worldInfo.globalBookIds.includes(id)
}
function toggleGlobal(id: string) {
  const list = settings.settings.worldInfo.globalBookIds
  const i = list.indexOf(id)
  if (i >= 0) list.splice(i, 1)
  else list.push(id)
  settings.touch()
}

function renameBook(name: string) {
  const b = book.value
  if (!b) return
  b.name = name
  void worlds.save(b)
}

/** 条目摘要：触发方式 + 位置 */
function summary(e: WorldInfoEntry): string {
  const mode = e.constant ? '常驻' : e.key.length ? e.key.slice(0, 3).join('/') : '无关键词'
  const pos =
    e.position === world_info_position.before
      ? '↑卡片'
      : e.position === world_info_position.after
        ? '↓卡片'
        : e.position === world_info_position.atDepth
          ? `@深度${e.depth}`
          : '其它'
  return `${mode} · ${pos}`
}

async function onImport(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    const raw = JSON.parse(await f.text()) as { name?: string; entries?: unknown }
    const b = await worlds.create(raw.name || f.name.replace(/\.json$/i, ''))
    const src = raw.entries
    if (src && typeof src === 'object') {
      const list = Array.isArray(src) ? src : Object.values(src)
      const { DEFAULT_WI_ENTRY } = await import('@/types/worldinfo')
      list.forEach((item, i) => {
        const e = item as Partial<WorldInfoEntry>
        b.entries[String(i)] = { ...structuredClone(DEFAULT_WI_ENTRY), ...e, uid: i }
      })
      await worlds.save(b)
    }
    toast.success(`已导入「${b.name}」`)
    await router.push(`/worlds/${b.id}`)
  } catch (e) {
    toast.error(`导入失败：${e instanceof Error ? e.message : String(e)}`)
  }
  ;(ev.target as HTMLInputElement).value = ''
}

function exportBook() {
  const b = book.value
  if (!b) return
  const blob = new Blob([JSON.stringify({ name: b.name, entries: b.entries }, null, 2)], {
    type: 'application/json',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${b.name}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// 切书时若停留在不存在的条目上，回退到列表
watch([bookId, uid], () => {
  if (uid.value !== undefined && !entry.value && book.value) {
    void router.replace(`/worlds/${book.value.id}`)
  }
})
</script>

<template>
  <AppTopbar title="世界书">
    <template #actions>
      <button class="cbx-btn cbx-btn--ghost" @click="fileInput?.click()">导入</button>
      <button class="cbx-btn cbx-btn--primary" @click="createBook">＋ 新建</button>
      <input ref="fileInput" type="file" accept=".json" hidden @change="onImport" />
    </template>
  </AppTopbar>

  <div class="panes">
    <!-- 书列表 -->
    <div class="pane pane--books cbx-scroll" :class="{ 'pane--hide': mobilePane !== 'books' }">
      <div v-if="!worlds.items.length" class="cbx-empty">
        <span class="cbx-empty__icon">📚</span>
        <span class="cbx-empty__desc">还没有世界书</span>
      </div>
      <div
        v-for="b in worlds.items"
        :key="b.id"
        class="cbx-nav-item row"
        :class="{ 'cbx-nav-item--active': b.id === bookId }"
        @click="router.push(`/worlds/${b.id}`)"
      >
        <span class="row__title">{{ b.name }}</span>
        <span class="row__meta">{{ Object.keys(b.entries).length }}</span>
        <span
          class="cbx-badge"
          :class="isGlobal(b.id) ? 'cbx-badge--success' : 'cbx-badge--brand'"
          :title="isGlobal(b.id) ? '已全局启用' : '点击全局启用'"
          @click.stop="toggleGlobal(b.id)"
        >
          {{ isGlobal(b.id) ? '全局' : '停用' }}
        </span>
      </div>
    </div>

    <!-- 条目列表 -->
    <div class="pane pane--list cbx-scroll" :class="{ 'pane--hide': mobilePane !== 'list' }">
      <template v-if="book">
        <div class="head">
          <button class="cbx-icon-btn back" @click="router.push('/worlds')">‹</button>
          <input
            class="cbx-input name"
            :value="book.name"
            @change="renameBook(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="head-ops">
          <button class="cbx-btn cbx-btn--soft sm" @click="addEntry">＋ 新建条目</button>
          <button class="cbx-btn cbx-btn--ghost sm" @click="exportBook">导出</button>
          <button class="cbx-btn cbx-btn--ghost sm del" @click="removeBook">删除本书</button>
        </div>

        <div v-if="!entries.length" class="cbx-empty">
          <span class="cbx-empty__desc">还没有条目</span>
        </div>
        <div
          v-for="e in entries"
          :key="e.uid"
          class="cbx-nav-item row"
          :class="{ 'cbx-nav-item--active': e.uid === uid, 'row--off': e.disable }"
          @click="router.push(`/worlds/${book.id}/${e.uid}`)"
        >
          <span class="row__title">{{ e.comment || e.key.join(', ') || '（未命名条目）' }}</span>
          <span class="row__meta">{{ summary(e) }}</span>
          <button class="cbx-icon-btn tiny" title="删除" @click.stop="removeEntry(e.uid)">✕</button>
        </div>
      </template>
      <div v-else class="cbx-empty">
        <span class="cbx-empty__desc">选择一本世界书</span>
      </div>
    </div>

    <!-- 条目编辑 -->
    <div class="pane pane--entry cbx-scroll" :class="{ 'pane--hide': mobilePane !== 'entry' }">
      <template v-if="entry && book">
        <div class="head">
          <button class="cbx-icon-btn back" @click="router.push(`/worlds/${book.id}`)">‹</button>
          <h3>编辑条目</h3>
        </div>
        <WiEntryEditor :entry="entry" @change="onEntryChange" />
      </template>
      <div v-else class="cbx-empty">
        <span class="cbx-empty__desc">选择一个条目</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panes {
  flex: 1;
  display: flex;
  min-height: 0;
}
.pane {
  padding: var(--cbx-space-4);
}
.pane--books {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--cbx-border);
}
.pane--list {
  width: 300px;
  flex-shrink: 0;
  border-right: 1px solid var(--cbx-border);
}
.pane--entry {
  flex: 1;
  min-width: 0;
}

.row {
  justify-content: space-between;
  gap: var(--cbx-space-2);
}
.row__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row__meta {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  flex-shrink: 0;
}
.row--off {
  opacity: 0.5;
}
.tiny {
  width: 22px;
  height: 22px;
  font-size: var(--cbx-fs-xs);
  flex-shrink: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  margin-bottom: var(--cbx-space-3);
}
.head .name {
  flex: 1;
}
.back {
  display: none;
}
.head-ops {
  display: flex;
  gap: var(--cbx-space-2);
  margin-bottom: var(--cbx-space-3);
  flex-wrap: wrap;
}
.sm {
  height: 30px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
.del {
  color: var(--cbx-error);
}

@media (max-width: 767px) {
  .pane--hide {
    display: none;
  }
  .pane--books,
  .pane--list,
  .pane--entry {
    width: 100%;
    flex: 1;
    border-right: none;
    padding: var(--cbx-space-3);
  }
  .back {
    display: inline-flex;
  }
  .sm {
    height: var(--cbx-tap-min);
  }
}
</style>
