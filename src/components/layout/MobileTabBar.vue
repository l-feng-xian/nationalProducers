<script setup lang="ts">
import { RouterLink, useRoute, useRouter } from 'vue-router'
import CharactersIcon from '@/components/icons/CharactersIcon.vue'
import GroupsIcon from '@/components/icons/GroupsIcon.vue'
import WorldsIcon from '@/components/icons/WorldsIcon.vue'
import ModelsIcon from '@/components/icons/ModelsIcon.vue'
import DataIcon from '@/components/icons/DataIcon.vue'
import { MOBILE_TABS } from '@/router/layout'

/**
 * 手机底部标签栏。只在五个标签页本身显示（App.vue 决定），进二级页（详情 / 聊天 / 设置）就收起，
 * 与常规 App 一致。标签之间平级：历史怎么走由 router/appStack 决定（任何标签按返回都回首页「角色」）。
 */
const route = useRoute()
const router = useRouter()
const ICONS = {
  characters: CharactersIcon,
  groups: GroupsIcon,
  worlds: WorldsIcon,
  models: ModelsIcon,
  data: DataIcon,
} as const

function go(to: string, active: boolean) {
  if (active) {
    // 再点一次当前标签：回到列表顶部（常规 App 手势）
    document
      .querySelector('.main .cbx-scroll, .main [data-scroll-root]')
      ?.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }
  void router.push(to)
}
</script>

<template>
  <nav class="tabbar" aria-label="主导航">
    <RouterLink v-for="t in MOBILE_TABS" :key="t.name" v-slot="{ href }" :to="t.to" custom>
      <a
        :href="href"
        class="tab"
        :class="{ 'tab--active': route.name === t.name }"
        :aria-current="route.name === t.name ? 'page' : undefined"
        @click.prevent="go(t.to, route.name === t.name)"
      >
        <span class="tab__ico"><component :is="ICONS[t.name]" /></span>
        <span class="tab__label">{{ t.label }}</span>
      </a>
    </RouterLink>
  </nav>
</template>

<style scoped>
.tabbar {
  display: flex;
  flex-shrink: 0;
  padding-bottom: var(--cbx-safe-b);
  border-top: 1px solid var(--cbx-border);
  background: var(--cbx-bg);
}
.tab {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 56px;
  padding: var(--cbx-space-1) 0;
  color: var(--cbx-text-tertiary);
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
  transition: color var(--cbx-transition);
}
.tab__ico {
  display: grid;
  place-items: center;
  width: 44px;
  height: 28px;
  border-radius: var(--cbx-radius-pill);
  transition: background var(--cbx-transition);
  /* 未选中时图标去色，选中才显出品牌色，一眼看出在哪一页 */
  filter: grayscale(1);
  opacity: 0.7;
}
.tab__label {
  font-size: var(--cbx-fs-xs);
  line-height: 1.2;
  white-space: nowrap;
}
.tab--active {
  color: var(--cbx-brand);
  font-weight: var(--cbx-fw-medium, 500);
}
.tab--active .tab__ico {
  background: var(--cbx-brand-light);
  filter: none;
  opacity: 1;
}
.tab:active .tab__ico {
  background: var(--cbx-bg-active);
}
@media (prefers-reduced-motion: reduce) {
  .tab,
  .tab__ico {
    transition: none;
  }
}
</style>
