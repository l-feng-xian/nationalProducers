<script setup lang="ts">
import { KeepAlive, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import CbxToastHost from '@/components/ui/CbxToastHost.vue'
import CbxConfirmHost from '@/components/ui/CbxConfirmHost.vue'
import NewChatSheet from '@/components/chat/NewChatSheet.vue'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'

const ui = useUiStore()
const route = useRoute()
const settings = useSettingsStore()

// 移动端：路由变化自动收起抽屉
watch(
  () => route.fullPath,
  () => ui.closeDrawer(),
)

// 对话消息字号：写入 :root 变量（.cbx-bubble 使用），设置页拖动滑块即时生效。
// 手改备份可能带越界值，这里统一钳回 10–30px。
watch(
  () => settings.settings.chat.messageFontSize,
  (size) => {
    const clamped = Math.min(30, Math.max(10, Math.round(Number(size) || 16)))
    document.documentElement.style.setProperty('--cbx-message-fs', `${clamped}px`)
  },
  { immediate: true },
)

/**
 * 需要跨导航保活的页面（按组件 name 白名单，见各 SFC 的 defineOptions）。
 *
 * **刻意只列角色页**，不是全都缓存：
 * - 角色页是立绘墙，从编辑页回来时整页重建会把几十个 objectURL 释放再重取、
 *   滚动位置也归零，观感就是「闪一下」。保活之后 DOM 原样还在，零重建。
 * - 其它页不缓存：要么有会话态（ChatView 切会话必须重来），要么本来就轻。
 *   无差别缓存只会让「改了数据回来还是旧的」这类问题遍地开花。
 *
 * ⚠️ 保活的组件 onMounted 只跑一次。往这里加页面前，先确认它没有
 * 「每次进入都得重新拉一遍」的逻辑，否则要改用 onActivated。
 */
const KEEP_ALIVE = ['CharactersView']
</script>

<template>
  <div class="shell">
    <div v-if="ui.drawerOpen" class="scrim" @click="ui.closeDrawer()" />
    <AppSidebar :open="ui.drawerOpen" />
    <main class="main">
      <RouterView v-slot="{ Component }">
        <KeepAlive :include="KEEP_ALIVE">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>
    <CbxToastHost />
    <CbxConfirmHost />
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
