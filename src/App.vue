<script setup lang="ts">
import { watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import CbxToastHost from '@/components/ui/CbxToastHost.vue'
import NewChatSheet from '@/components/chat/NewChatSheet.vue'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const route = useRoute()

// 移动端：路由变化自动收起抽屉
watch(
  () => route.fullPath,
  () => ui.closeDrawer(),
)
</script>

<template>
  <div class="shell">
    <div v-if="ui.drawerOpen" class="scrim" @click="ui.closeDrawer()" />
    <AppSidebar :open="ui.drawerOpen" />
    <main class="main">
      <RouterView />
    </main>
    <CbxToastHost />
    <NewChatSheet v-if="ui.newChatOpen" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  /* dvh 让移动端地址栏收起/展开时不跳动 */
  height: 100dvh;
}

/* min-width:0 必须保留，否则长内容会把侧栏挤没 */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.scrim {
  display: none;
}

@media (max-width: 767px) {
  .scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 20;
    background: var(--cbx-bg-mask);
  }
}
</style>
