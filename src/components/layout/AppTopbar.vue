<script setup lang="ts">
import { useUiStore } from '@/stores/ui'
import MenuIcon from '@/components/icons/MenuIcon.vue'

defineProps<{ title: string }>()

const ui = useUiStore()
</script>

<template>
  <header class="topbar">
    <!-- 菜单：三线 ↔ X 连续变形，可在过渡中反向切换。 -->
    <button
      class="cbx-icon-btn menu-btn"
      type="button"
      aria-label="菜单"
      :aria-expanded="ui.drawerOpen"
      @click="ui.toggleDrawer()"
    >
      <MenuIcon :open="ui.drawerOpen" />
    </button>
    <h1 class="title">{{ title }}</h1>
    <div class="actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-3);
  flex-shrink: 0;
  min-height: var(--cbx-topbar-h);
  padding: var(--cbx-space-2) var(--cbx-space-5);
  border-bottom: 1px solid var(--cbx-border);
  padding-top: max(var(--cbx-space-2), env(safe-area-inset-top, 0px));
}
.title {
  font-size: var(--cbx-fs-xl);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
.menu-btn {
  display: none;
}

@media (max-width: 767px) {
  .menu-btn {
    display: inline-flex;
  }
  .topbar {
    padding-left: var(--cbx-space-3);
    padding-right: var(--cbx-space-3);
  }
  .title {
    font-size: var(--cbx-fs-lg);
  }
}
</style>
