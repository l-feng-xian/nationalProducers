<script setup lang="ts">
/**
 * 聊天页右侧「状态」侧栏。
 *
 * 三种形态：
 *  - 桌面 + 固定：常驻在聊天列右侧（挤窄聊天列），发送时不收起；
 *  - 桌面 + 不固定：右侧浮层 + 遮罩，发送后自动收起；
 *  - 手机：一律浮层（镜像 AppSidebar 的抽屉写法），返回键关闭，聚焦输入框 / 发送时收起。
 */
import { computed, ref, watch } from 'vue'
import { History, Pencil, Pin, TriangleAlert, X } from '@/components/icons'
import StatusSnapshot from './StatusSnapshot.vue'
import StatusEditor from './StatusEditor.vue'
import { useUiStore } from '@/stores/ui'
import { useStatusStore } from '@/stores/status'
import { useChatsStore } from '@/stores/chats'
import { useGenerationStore } from '@/stores/generation'
import { useBackClose } from '@/composables/useBackClose'
import { useMediaQuery, DRAWER_MQ } from '@/composables/useDrawerSwipe'
import { useToast } from '@/composables/useToast'
import { changedKeys } from '@/services/status/diff'
import type { StatusData } from '@/types/status'

const ui = useUiStore()
const status = useStatusStore()
const chats = useChatsStore()
const gen = useGenerationStore()
const toast = useToast()

const isMobile = useMediaQuery(DRAWER_MQ)
/** 常驻：只有桌面且固定 */
const docked = computed(() => !isMobile.value && ui.statusPinned)
const overlay = computed(() => !docked.value)

function close() {
  ui.statusOpen = false
}
useBackClose(
  close,
  () => ui.statusOpen,
  () => overlay.value,
)

// 从桌面缩到手机宽度时，常驻侧栏会变成盖满半屏的浮层 —— 直接收起
watch(isMobile, (m) => {
  if (m) close()
})
// 手机上左侧抽屉与右侧状态栏不能同时开
watch(
  () => ui.drawerOpen,
  (v) => {
    if (v && overlay.value) close()
  },
)

/** 用户名与必须出现的人都来自状态上下文（与生成链路同源），见 stores/status.ts */
const userName = computed(() => status.userName)

type Tab = 'now' | 'history'
const tab = ref<Tab>('now')
const editing = ref(false)
const saving = ref(false)
watch(
  () => chats.current?.id,
  () => {
    editing.value = false
    tab.value = 'now'
  },
)
// 生成开始时退出编辑：本轮结束会写入新快照，继续编辑会基于过期的数据
watch(
  () => gen.busy,
  (b) => {
    if (b) editing.value = false
  },
)

const shown = computed<StatusData | null>(() => status.current?.status.data ?? status.initial)
const changed = computed(() => (status.current ? changedKeys(status.current.diff) : undefined))
const sourceLabel = computed(() => {
  const cur = status.current
  if (!cur) return status.initial ? '角色卡初始状态' : ''
  return cur.status.source === 'user' ? `手动修改 · ${cur.msg.name}` : `来自 ${cur.msg.name} 的回复`
})

async function onSave(data: StatusData) {
  saving.value = true
  try {
    if (await status.save(data)) {
      editing.value = false
      toast.success('状态已保存，下一轮会以它为准')
    } else toast.error('会话里还没有 AI 消息，发送第一条消息后再编辑')
  } finally {
    saving.value = false
  }
}
function startEdit() {
  editing.value = true
  tab.value = 'now'
}
function stopEdit() {
  editing.value = false
}
function togglePin() {
  ui.setStatusPinned(!ui.statusPinned)
}
function showNow() {
  tab.value = 'now'
}
function showHistory() {
  tab.value = 'history'
  editing.value = false
}

const history = computed(() => [...status.timeline].reverse())
const expanded = ref<string | null>(null)
function toggleEntry(id: string) {
  expanded.value = expanded.value === id ? null : id
}
function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function sceneSummary(d: StatusData) {
  return ['时间', '地点']
    .map((k) => d.scene[k])
    .filter((v): v is string => typeof v === 'string' && !!v)
    .join(' · ')
}

/** 收起的浮层在屏幕外，里面的控件不能被 Tab 摸到 */
const hidden = computed(() => overlay.value && !ui.statusOpen)
</script>

<template>
  <div
    v-if="overlay"
    class="sp-scrim"
    :class="{ 'sp-scrim--on': ui.statusOpen }"
    @click="close"
  ></div>
  <aside
    class="sp"
    :class="{
      'sp--docked': docked,
      'sp--overlay': overlay,
      'sp--open': ui.statusOpen,
    }"
    aria-label="角色状态"
    :inert="hidden || undefined"
    :aria-hidden="hidden || undefined"
  >
    <header class="sp-head">
      <div class="sp-head__title">
        <h2>角色状态</h2>
        <span v-if="sourceLabel" class="sp-head__sub">{{ sourceLabel }}</span>
      </div>
      <button
        v-if="!isMobile"
        type="button"
        class="cbx-btn cbx-btn--ghost sp-icon"
        :class="{ 'sp-icon--on': ui.statusPinned }"
        :aria-pressed="ui.statusPinned"
        :title="ui.statusPinned ? '取消固定（改为浮层，发送后自动收起）' : '固定在右侧常驻'"
        aria-label="固定侧栏"
        @click="togglePin"
      >
        <Pin :size="18" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="cbx-btn cbx-btn--ghost sp-icon"
        aria-label="关闭状态栏"
        title="关闭"
        @click="close"
      >
        <X :size="18" aria-hidden="true" />
      </button>
    </header>

    <nav class="cbx-tabs sp-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="cbx-tab"
        :class="{ 'cbx-tab--active': tab === 'now' }"
        :aria-selected="tab === 'now'"
        @click="showNow"
      >
        当前
      </button>
      <button
        type="button"
        role="tab"
        class="cbx-tab"
        :class="{ 'cbx-tab--active': tab === 'history' }"
        :aria-selected="tab === 'history'"
        @click="showHistory"
      >
        历史<span v-if="status.timeline.length" class="sp-count">{{ status.timeline.length }}</span>
      </button>
    </nav>

    <div class="sp-body cbx-scroll">
      <p v-if="status.lastError && !editing" class="sp-warn" role="status">
        <TriangleAlert :size="16" aria-hidden="true" />
        <span
          >最近一轮没有更新状态：{{ status.lastError.error }}。{{
            shown ? '已沿用上一份，' : ''
          }}可以手动编辑补上。</span
        >
      </p>
      <p v-if="gen.busy" class="sp-note">生成中，回复结束后更新…</p>

      <template v-if="tab === 'now'">
        <StatusEditor
          v-if="editing"
          :data="shown"
          :fields="status.fields"
          :user-name="userName"
          :locked-people="status.required"
          :saving="saving"
          @save="onSave"
          @cancel="stopEdit"
        />
        <template v-else>
          <StatusSnapshot
            v-if="shown"
            :data="shown"
            :fields="status.fields"
            :user-name="userName"
            :changed="changed"
          />
          <div v-else class="sp-empty">
            <p>还没有状态。</p>
            <p>发送消息后，AI 会在每轮回复末尾一并更新时间、地点、心情、背包等状态。</p>
          </div>
          <button
            type="button"
            class="cbx-btn cbx-btn--soft sp-edit"
            :disabled="gen.busy || !status.editTarget"
            :title="status.editTarget ? '' : '会话里还没有 AI 消息'"
            @click="startEdit"
          >
            <Pencil :size="16" aria-hidden="true" />{{ shown ? '编辑状态' : '手动填写' }}
          </button>
        </template>
      </template>

      <template v-else>
        <div v-if="!history.length" class="sp-empty">
          <History :size="24" aria-hidden="true" />
          <p>还没有历史快照。</p>
        </div>
        <ol v-else class="sp-hist">
          <li v-for="(e, i) in history" :key="e.msg.id" class="sp-hist__item">
            <button
              type="button"
              class="sp-hist__head"
              :aria-expanded="expanded === e.msg.id"
              @click="toggleEntry(e.msg.id)"
            >
              <span class="sp-hist__who">
                {{ e.msg.name }}
                <span v-if="i === 0" class="cbx-badge cbx-badge--brand">当前</span>
                <span v-if="e.status.source === 'user'" class="cbx-badge cbx-badge--warning"
                  >手动</span
                >
              </span>
              <span class="sp-hist__when">{{ fmtTime(e.status.updatedAt) }}</span>
              <span v-if="sceneSummary(e.status.data)" class="sp-hist__scene">{{
                sceneSummary(e.status.data)
              }}</span>
            </button>
            <ul
              v-if="e.diff.changes.length || e.diff.joined.length || e.diff.left.length"
              class="sp-diff"
            >
              <li v-for="n in e.diff.joined" :key="`j-${n}`" class="sp-diff__add">{{ n }} 登场</li>
              <li v-for="n in e.diff.left" :key="`l-${n}`" class="sp-diff__del">{{ n }} 离场</li>
              <li v-for="(c, ci) in e.diff.changes" :key="ci">
                <span class="sp-diff__k">{{ c.person ? `${c.person} · ${c.key}` : c.key }}</span>
                <template v-if="c.added || c.removed">
                  <span v-for="a in c.added" :key="`a-${a}`" class="sp-diff__add">+{{ a }}</span>
                  <span v-for="r in c.removed" :key="`r-${r}`" class="sp-diff__del">−{{ r }}</span>
                </template>
                <template v-else>
                  <span v-if="c.from" class="sp-diff__from">{{ c.from }}</span>
                  <span class="sp-diff__arrow" aria-hidden="true">→</span>
                  <span class="sp-diff__to">{{ c.to || '（清空）' }}</span>
                </template>
              </li>
            </ul>
            <p v-else-if="i === history.length - 1" class="sp-diff__none">首份快照</p>
            <p v-else class="sp-diff__none">无变化</p>
            <StatusSnapshot
              v-if="expanded === e.msg.id"
              class="sp-hist__full"
              :data="e.status.data"
              :fields="status.fields"
              :user-name="userName"
            />
          </li>
        </ol>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.sp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--cbx-bg-secondary);
}
/* ── 常驻：聊天列右侧的一列 ── */
.sp--docked {
  flex: 0 0 var(--cbx-statusbar-w);
  width: var(--cbx-statusbar-w);
  border-left: 1px solid var(--cbx-border);
}
.sp--docked:not(.sp--open) {
  display: none;
}
/* ── 浮层：从右侧滑入 ── */
.sp--overlay {
  position: fixed;
  inset: 0 0 0 auto;
  z-index: 30;
  width: min(88vw, 360px);
  height: var(--cbx-app-h, 100dvh);
  transform: translateX(100%);
  transition: transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: var(--cbx-safe-b);
  overscroll-behavior: contain;
}
.sp--overlay.sp--open {
  transform: translateX(0);
  box-shadow: var(--cbx-shadow-lg);
}
.sp-scrim {
  position: fixed;
  inset: 0;
  z-index: 29;
  background: var(--cbx-bg-mask);
  opacity: 0;
  pointer-events: none;
  transition: opacity 240ms var(--cbx-ease);
}
.sp-scrim--on {
  opacity: 1;
  pointer-events: auto;
}

.sp-head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-1);
  flex-shrink: 0;
  min-height: var(--cbx-topbar-h);
  padding: 0 var(--cbx-space-2) 0 var(--cbx-space-4);
}
.sp-head__title {
  flex: 1;
  min-width: 0;
}
.sp-head h2 {
  font-size: var(--cbx-fs-md);
  font-weight: var(--cbx-fw-medium);
}
.sp-head__sub {
  display: block;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-icon {
  width: 36px;
  padding: 0;
  flex-shrink: 0;
}
.sp-icon--on {
  color: var(--cbx-brand);
  background: var(--cbx-brand-light);
}
.sp-tabs {
  flex-shrink: 0;
  padding: 0 var(--cbx-space-2);
}
.sp-count {
  margin-left: 4px;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.sp-body {
  flex: 1;
  min-height: 0;
  padding: var(--cbx-space-3);
}
.sp-warn {
  display: flex;
  gap: var(--cbx-space-2);
  margin-bottom: var(--cbx-space-3);
  padding: var(--cbx-space-2) var(--cbx-space-3);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-warning-light);
  color: var(--cbx-text);
  font-size: var(--cbx-fs-xs);
  line-height: 1.6;
}
.sp-warn svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--cbx-warning);
}
.sp-note {
  margin-bottom: var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.sp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-8) var(--cbx-space-3);
  text-align: center;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-tertiary);
  line-height: 1.7;
}
.sp-edit {
  gap: var(--cbx-space-1);
  margin-top: var(--cbx-space-3);
  width: 100%;
}

.sp-hist {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  list-style: none;
  padding: 0;
  margin: 0;
}
.sp-hist__item {
  padding: var(--cbx-space-2) var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-bg);
}
.sp-hist__head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px var(--cbx-space-2);
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
  color: var(--cbx-text);
}
.sp-hist__who {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-1);
  min-width: 0;
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
}
.sp-hist__when {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.sp-hist__scene {
  grid-column: 1 / -1;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-secondary);
}
.sp-hist__full {
  margin-top: var(--cbx-space-2);
}
.sp-diff {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: var(--cbx-space-2) 0 0;
  padding: 0;
  list-style: none;
  font-size: var(--cbx-fs-xs);
  line-height: 1.6;
}
.sp-diff li {
  display: flex;
  flex-wrap: wrap;
  gap: 2px var(--cbx-space-1);
}
.sp-diff__k {
  color: var(--cbx-text-tertiary);
}
.sp-diff__from {
  color: var(--cbx-text-tertiary);
  text-decoration: line-through;
}
.sp-diff__arrow {
  color: var(--cbx-text-tertiary);
}
.sp-diff__to {
  color: var(--cbx-text);
}
.sp-diff__add {
  color: var(--cbx-success);
}
.sp-diff__del {
  color: var(--cbx-error);
}
.sp-diff__none {
  margin-top: var(--cbx-space-1);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}

@media (max-width: 767px) {
  /* scoped 选择器压过 base.css 的移动端 44px，这里显式写回（memory 坑 #11） */
  .sp-icon {
    width: var(--cbx-tap-min);
    height: var(--cbx-tap-min);
  }
  .sp-tabs .cbx-tab {
    min-height: var(--cbx-tap-min);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sp--overlay,
  .sp-scrim {
    transition: none;
  }
}
</style>
