<script setup lang="ts">
import { computed, KeepAlive, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import CbxToastHost from '@/components/ui/CbxToastHost.vue'
import CbxConfirmHost from '@/components/ui/CbxConfirmHost.vue'
import NewChatSheet from '@/components/chat/NewChatSheet.vue'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useBackClose } from '@/composables/useBackClose'
import { DRAWER_MQ, useDrawerSwipe, useMediaQuery } from '@/composables/useDrawerSwipe'
import { useRouteTransition } from '@/composables/useRouteTransition'

const ui = useUiStore()
const route = useRoute()
const settings = useSettingsStore()

// 移动端：路由变化自动收起抽屉
watch(
  () => route.fullPath,
  () => ui.closeDrawer(),
)

// ── 移动端抽屉：返回键关闭 + 边缘右滑拉出 / 左滑推回 ──
const isDrawerMode = useMediaQuery(DRAWER_MQ)
// 宽屏下侧栏常驻、不是浮层，不登记历史
useBackClose(
  () => ui.closeDrawer(),
  () => ui.drawerOpen,
  () => isDrawerMode.value,
)
// 转成宽屏时抽屉态没有意义，顺手收掉（否则转回窄屏会凭空弹出来）
watch(isDrawerMode, (on) => {
  if (!on) ui.closeDrawer()
})
const shellEl = ref<HTMLElement | null>(null)
useDrawerSwipe(
  () => shellEl.value,
  () => shellEl.value?.querySelector<HTMLElement>('.sidebar') ?? null,
)
// 全部路由切换的过渡（离场 → 换页 → 入场），动的是右侧内容区
const mainEl = ref<HTMLElement | null>(null)
useRouteTransition(useRouter(), () => mainEl.value)

const scrimVisible = computed(() => ui.drawerOpen || ui.drawerDrag !== null)
const scrimStyle = computed(() =>
  ui.drawerDrag !== null ? { opacity: ui.drawerDrag, transition: 'none' } : undefined,
)

/**
 * 软键盘兜底（主要是 iOS Safari）。
 *
 * 正路是 index.html 视口里的 `interactive-widget=resizes-content`（安卓 Chrome 108+）
 * 与安卓壳 MainActivity 里按 IME inset 缩 WebView —— 两者都让布局视口本身变矮，
 * 100dvh 跟着缩，输入条自然落在键盘上沿，页面不动。
 *
 * 不认这个参数的浏览器只缩 visual viewport，然后把整页往上推去露出输入框，
 * 顶栏被推出屏幕 —— 就是「一打开键盘页面整体上移」。这里检测到键盘遮挡时，
 * 把外壳高度钉成可视高度、并跟住 visual viewport 的偏移。
 */
const vvOffset = ref(0)
function syncViewport() {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement
  // 双指缩放页面时 visual viewport 也会变小，那不是键盘，别动
  const covered = Math.abs(vv.scale - 1) < 0.01 ? window.innerHeight - vv.height : 0
  if (covered > 80) {
    root.style.setProperty('--cbx-app-h', `${Math.round(vv.height)}px`)
    vvOffset.value = Math.round(vv.offsetTop)
  } else {
    root.style.removeProperty('--cbx-app-h')
    vvOffset.value = 0
  }
}
const shellStyle = computed(() =>
  vvOffset.value ? { transform: `translateY(${vvOffset.value}px)` } : undefined,
)
onMounted(() => {
  window.visualViewport?.addEventListener('resize', syncViewport)
  window.visualViewport?.addEventListener('scroll', syncViewport)
  syncViewport()
})
onBeforeUnmount(() => {
  window.visualViewport?.removeEventListener('resize', syncViewport)
  window.visualViewport?.removeEventListener('scroll', syncViewport)
})

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
  <div ref="shellEl" class="shell" :style="shellStyle">
    <!-- 常驻 + 透明度开合（不用 v-if）：松手时从拖到的透明度直接过渡到终态，不会先跳满再淡出 -->
    <div
      class="scrim"
      :class="{ 'scrim--on': scrimVisible }"
      :style="scrimStyle"
      aria-hidden="true"
      @click="ui.closeDrawer()"
    />
    <AppSidebar :open="ui.drawerOpen" :drag="ui.drawerDrag" :drawer-mode="isDrawerMode" />
    <main ref="mainEl" class="main">
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
  /* dvh 让移动端地址栏收起/展开时不跳动；--cbx-app-h 是软键盘兜底（见 syncViewport） */
  height: var(--cbx-app-h, 100dvh);
  /* 钉在布局视口上：iOS 弹键盘时会滚动文档，fixed 才能配合 visual viewport 偏移跟住 */
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
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
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--cbx-transition);
    /* 遮罩上的横滑交给抽屉手势，别让浏览器当成页面滚动 */
    touch-action: pan-y;
  }
  .scrim--on {
    opacity: 1;
    pointer-events: auto;
  }
}
</style>
