<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { useChatsStore } from '@/stores/chats'
import type { ChatMeta } from '@/types/chat'

defineProps<{ open: boolean }>()

const ui = useUiStore()
const route = useRoute()
const router = useRouter()
const chats = useChatsStore()

const themeLabel = { light: '☀️ 浅色', dark: '🌙 深色', system: '🖥️ 跟随系统' }

onMounted(() => {
  void chats.loadList()
})

/** 按「今天 / 昨天 / 更早」分组 */
const groups = computed(() => {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const out: { label: string; items: ChatMeta[] }[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '更早', items: [] },
  ]
  for (const c of chats.list) {
    const t = c.lastMessageAt || c.updatedAt
    const bucket = t >= startOfToday ? 0 : t >= startOfYesterday ? 1 : 2
    out[bucket]?.items.push(c)
  }
  return out.filter((g) => g.items.length > 0)
})

async function remove(id: string) {
  await chats.removeChat(id)
  if (route.params['id'] === id) await router.push('/chat')
}

async function newChat() {
  const meta = await chats.createSolo(undefined, '新对话')
  await router.push(`/chat/${meta.id}`)
}
</script>

<template>
  <aside class="sidebar" :class="{ 'sidebar--open': open }">
    <div class="brand">
      <span class="brand__logo">国</span>
      <span class="brand__name">国货优选</span>
    </div>

    <button class="cbx-btn cbx-btn--soft new-chat" @click="newChat">＋ 新建对话</button>

    <div class="cbx-scroll sessions">
      <div v-if="!chats.list.length" class="cbx-empty">
        <span class="cbx-empty__icon">💬</span>
        <span class="cbx-empty__desc">还没有对话</span>
      </div>

      <template v-for="g in groups" :key="g.label">
        <div class="cbx-group-label">{{ g.label }}</div>
        <div
          v-for="c in g.items"
          :key="c.id"
          class="cbx-nav-item item"
          :class="{ 'cbx-nav-item--active': route.params['id'] === c.id }"
          @click="router.push(`/chat/${c.id}`)"
        >
          <span class="item__title">{{ c.title }}</span>
          <button class="cbx-icon-btn item__del" title="删除" @click.stop="remove(c.id)">✕</button>
        </div>
      </template>
    </div>

    <nav class="foot">
      <RouterLink
        to="/characters"
        class="cbx-nav-item"
        :class="{ 'cbx-nav-item--active': route.path.startsWith('/characters') }"
      >
        🎭 角色
      </RouterLink>
      <RouterLink
        to="/worlds"
        class="cbx-nav-item"
        :class="{ 'cbx-nav-item--active': route.path.startsWith('/worlds') }"
      >
        📚 世界书
      </RouterLink>
      <RouterLink
        to="/settings"
        class="cbx-nav-item"
        :class="{ 'cbx-nav-item--active': route.path.startsWith('/settings') }"
      >
        ⚙️ 设置
      </RouterLink>
      <button class="cbx-btn cbx-btn--ghost theme-btn" @click="ui.cycleTheme()">
        {{ themeLabel[ui.theme] }}
      </button>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  width: var(--cbx-sidebar-w);
  flex-shrink: 0;
  padding: var(--cbx-space-4);
  background: var(--cbx-bg-secondary);
  border-right: 1px solid var(--cbx-border);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-3);
  margin-bottom: var(--cbx-space-2);
}
.brand__logo {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  background: var(--cbx-brand);
  color: var(--cbx-text-on-brand);
  border-radius: var(--cbx-radius-md);
  font-weight: var(--cbx-fw-bold);
  font-size: var(--cbx-fs-sm);
}
.brand__name {
  font-weight: var(--cbx-fw-bold);
  font-size: var(--cbx-fs-lg);
}

.new-chat {
  width: 100%;
}

/* min-height:0 让它在 flex 列里真正可滚动 */
.sessions {
  flex: 1;
  min-height: 0;
  margin: var(--cbx-space-2) 0;
}

.item {
  justify-content: space-between;
}
.item__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item__del {
  width: 24px;
  height: 24px;
  font-size: var(--cbx-fs-xs);
  opacity: 0;
  flex-shrink: 0;
}
.item:hover .item__del {
  opacity: 1;
}

.foot {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-1);
  border-top: 1px solid var(--cbx-border);
  padding-top: var(--cbx-space-2);
}
.foot .cbx-nav-item {
  text-decoration: none;
}
.foot .cbx-nav-item:hover {
  text-decoration: none;
}
.theme-btn {
  width: 100%;
  margin-top: var(--cbx-space-1);
}

@media (hover: none) {
  .item__del {
    opacity: 0.5;
    width: var(--cbx-tap-min);
    height: var(--cbx-tap-min);
  }
}

/* ── 移动端：离屏抽屉 ── */
@media (max-width: 767px) {
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 30;
    transform: translateX(-100%);
    transition: transform var(--cbx-transition);
    box-shadow: var(--cbx-shadow-lg);
    padding-bottom: max(var(--cbx-space-4), var(--cbx-safe-b));
  }
  .sidebar--open {
    transform: translateX(0);
  }
}
</style>
