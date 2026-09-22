<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import { computed, onMounted } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import SunIcon from '@/components/icons/SunIcon.vue'
import MoonIcon from '@/components/icons/MoonIcon.vue'
import MonitorIcon from '@/components/icons/MonitorIcon.vue'
import CharactersIcon from '@/components/icons/CharactersIcon.vue'
import GroupsIcon from '@/components/icons/GroupsIcon.vue'
import WorldsIcon from '@/components/icons/WorldsIcon.vue'
import GameWorldsIcon from '@/components/icons/GameWorldsIcon.vue'
import ModelsIcon from '@/components/icons/ModelsIcon.vue'
import DataIcon from '@/components/icons/DataIcon.vue'
import SettingsIcon from '@/components/icons/SettingsIcon.vue'
import { useUiStore } from '@/stores/ui'
import { useChatsStore } from '@/stores/chats'
import { APP_NAME } from '@/constants/app'

const BASE_URL = import.meta.env.BASE_URL
import type { ChatMeta } from '@/types/chat'
import { confirmDialog } from '@/composables/useConfirm'

defineProps<{ open: boolean }>()

const ui = useUiStore()
const route = useRoute()
const router = useRouter()
const chats = useChatsStore()

/**
 * 侧栏 7 个顶层分区（角色/群聊/世界书…）之间是**平级**关系，不是逐层深入。
 * 但 RouterLink 默认 push，于是「角色→群聊→世界书→模型」会在历史里叠 4 层，
 * 手势返回要一层层退，很烦（用户报的「路由多层嵌套」）。
 *
 * 规则：当前在**聊天页（首页）**时 push，从别处进分区能靠返回回到聊天；
 * 已经在某个分区里再切别的分区就 replace，平级切换不叠历史。
 * 详情页（/characters/:id 等）的下钻仍由各自页面 push，返回正常回列表。
 */
const replaceNav = computed(() => !route.path.startsWith('/chat'))

/** 图标进按钮、文案进 title —— 见模板里的说明。动画 SVG 组件，切换时新图标弹入。 */
const themeIcon = { light: SunIcon, dark: MoonIcon, system: MonitorIcon }
const themeLabel = { light: '浅色', dark: '深色', system: '跟随系统' }

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

async function remove(id: string, title: string) {
  if (!(await confirmDialog({ text: `删除会话「${title}」？其全部消息将一并删除。` }))) return
  await chats.removeChat(id)
  if (route.params['id'] === id) await router.push('/chat')
}

function newChat() {
  ui.newChatOpen = true
}
</script>

<template>
  <aside class="sidebar" :class="{ 'sidebar--open': open }">
    <div class="brand">
      <!-- public/ 下的资源走 BASE_URL 拼接，部署到子路径时才不会 404 -->
      <img class="brand__logo" :src="`${BASE_URL}logo.jpg`" :alt="APP_NAME" />
      <span class="brand__name">{{ APP_NAME }}</span>
      <!-- 主题切换：收在品牌行右端。只显示图标，当前模式放 title/aria-label，
           否则「跟随系统」这种长文案会把 240px 的侧栏顶栏挤变形 -->
      <button
        class="cbx-icon-btn theme-btn"
        type="button"
        :title="`主题：${themeLabel[ui.theme]}（点击切换）`"
        :aria-label="`主题：${themeLabel[ui.theme]}`"
        @click="ui.cycleTheme()"
      >
        <span class="icon-swap">
          <Transition name="icon-swap">
            <component :is="themeIcon[ui.theme]" :key="ui.theme" />
          </Transition>
        </span>
      </button>
    </div>

    <button class="cbx-btn cbx-btn--soft new-chat" @click="newChat">
      <AppIcon name="Plus" /> 新建对话
    </button>

    <div class="cbx-scroll sessions">
      <div v-if="!chats.list.length" class="cbx-empty">
        <span class="cbx-empty__icon"><AppIcon name="MessageCircle" /></span>
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
          <button class="cbx-icon-btn item__del" title="删除" @click.stop="remove(c.id, c.title)">
            <AppIcon name="X" tone="danger" />
          </button>
        </div>
      </template>
    </div>

    <nav class="foot">
      <!-- 导航与操作图标共享尺寸网格和三态过渡，内部图层按语义运动 -->
      <RouterLink
        to="/characters"
        class="cbx-nav-item"
        :replace="replaceNav"
        :class="{ 'cbx-nav-item--active': route.path.startsWith('/characters') }"
      >
        <span class="nav-ico"><CharactersIcon /></span>
        <span>角色</span>
      </RouterLink>
      <RouterLink
        to="/groups"
        class="cbx-nav-item"
        :replace="replaceNav"
        :class="{ 'cbx-nav-item--active': route.path.startsWith('/groups') }"
      >
        <span class="nav-ico"><GroupsIcon /></span>
        <span>群聊</span>
      </RouterLink>
      <RouterLink
        to="/worlds"
        class="cbx-nav-item"
        :replace="replaceNav"
        :class="{ 'cbx-nav-item--active': route.path.startsWith('/worlds') }"
      >
        <span class="nav-ico"><WorldsIcon /></span>
        <span>世界书</span>
      </RouterLink>
      <RouterLink
        to="/game-worlds"
        class="cbx-nav-item"
        :replace="replaceNav"
        :class="{ 'cbx-nav-item--active': route.path.startsWith('/game-worlds') }"
      >
        <span class="nav-ico"><GameWorldsIcon /></span>
        <span>无限世界</span>
      </RouterLink>
      <RouterLink
        to="/models"
        class="cbx-nav-item"
        :replace="replaceNav"
        :class="{ 'cbx-nav-item--active': route.path.startsWith('/models') }"
      >
        <span class="nav-ico"><ModelsIcon /></span>
        <span>模型管理</span>
      </RouterLink>
      <RouterLink
        to="/data"
        class="cbx-nav-item"
        :replace="replaceNav"
        :class="{ 'cbx-nav-item--active': route.path.startsWith('/data') }"
      >
        <span class="nav-ico"><DataIcon /></span>
        <span>数据管理</span>
      </RouterLink>
      <RouterLink
        to="/settings"
        class="cbx-nav-item"
        :replace="replaceNav"
        :class="{ 'cbx-nav-item--active': route.path.startsWith('/settings') }"
      >
        <span class="nav-ico"><SettingsIcon /></span>
        <span>设置</span>
      </RouterLink>
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
  display: block;
  flex-shrink: 0;
  /* 32 而非原来那个字符贴片的 28：logo 是有细节的几何图案（圆环/山形/星座线），
     28px 下糊成一块蓝斑；36px 又开始压过「幕间」字样。三档实际比过，32 最清楚。 */
  width: 32px;
  height: 32px;
  /* 图是近正方形且自带浅色底（非透明），cover 保证任何比例都不留边、不变形 */
  object-fit: cover;
  border-radius: var(--cbx-radius-md);
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
.nav-ico {
  display: inline-flex;
  flex-shrink: 0;
  width: var(--cbx-icon-md);
  height: var(--cbx-icon-md);
}
.theme-btn {
  margin-left: auto;
  flex-shrink: 0;
}
.item:focus-within .item__del {
  opacity: 1;
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
