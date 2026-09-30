# 全部页面 UI/UX 与组件设计（含关系图谱 SVG 画布）

# UI/UX 与组件总设计

> 前置约定：所有代码 **无分号 / 单引号 / 2 空格 / `<script setup lang="ts">` / `@/` 别名**；颜色**只用 `var(--cbx-*)`**；移动端断点统一 `@media (max-width: 767px)`；`arr[i]` 一律当 `T | undefined` 处理。

---

## 0. 需要先补的设计系统底座（tokens.css / base.css）

### 0.1 新增 token

- 新增 **颜色 / 阴影** token **必须写 3 处**：`:root`、`:root[data-theme="dark"]`、`@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`
- 新增 **纯尺寸** token（宽度 / 间距 / 圆角 / 字号）**只写 `:root` 一处** —— 两个暗色块内不含任何尺寸 token，照抄会引入一堆主题无关的重复声明

```css
/* 气泡 */
--cbx-bubble-user-bg: var(--cbx-brand);
--cbx-bubble-user-text: var(--cbx-text-on-brand);
--cbx-bubble-ai-bg: var(--cbx-bg-secondary);
--cbx-bubble-ai-text: var(--cbx-text);
--cbx-bubble-ai-border: var(--cbx-border);
--cbx-code-bg: var(--cbx-gray-1);          /* dark: #1b1b1b */

/* 1vN 角色区分色（8 色轮转，索引 = characterId 哈希 % 8） */
--cbx-char-1: #228be6; --cbx-char-2: #12b886; --cbx-char-3: #fab005;
--cbx-char-4: #fa5252; --cbx-char-5: #7950f2; --cbx-char-6: #e64980;
--cbx-char-7: #15aabf; --cbx-char-8: #fd7e14;
/* dark 下整体提亮一档：#339af0 #20c997 #fcc419 #ff6b6b #9775fa #f06595 #22b8cf #ff922b */

/* 布局 */
--cbx-topbar-h: 56px;
--cbx-read-w: 820px;   /* 阅读宽：聊天气泡/消息流/输入条 + 表单内的 textarea 与说明段落
                          （只管长文本行长，**勿用作表单列宽**，见 --cbx-form-w） */
--cbx-form-w: 100%;    /* 表单内容列宽（.cbx-form-col，左对齐不居中、跟随视口自适应不封顶） */
--cbx-fieldw-num: 120px;  /* 数字 / 百分比 / 深度 / 轮数（自动兜底） */
--cbx-fieldw-sm: 240px;   /* 短枚举 select / 人名 / 版本号 */
--cbx-fieldw-md: 400px;   /* 模型名 / 标识符 / 组名 */
--cbx-fieldw-lg: 620px;   /* URL / API Key / 路径 */
/* ⚠ 是 fieldw- 不是 fw-：--cbx-fw-* 已是字重命名空间（--cbx-fw-medium: 500） */
--cbx-safe-b: env(safe-area-inset-bottom, 0px);
```

**顺手修补暗色缺口**：`--cbx-gray-4/-5` 在暗色未覆盖，导致滚动条拇指是亮灰。暗色块加 `--cbx-gray-4: #4a4a4a; --cbx-gray-5: #5c5c5c;`。

### 0.2 新增 `.cbx-*` 通用类（追加到 base.css，风格对齐既有 BEM-ish）

| 类 | 规格要点 |
|---|---|
| `.cbx-textarea` | `width:100%; min-height:80px; padding:var(--cbx-space-3); font:inherit; font-size:var(--cbx-fs-sm); border:1px solid var(--cbx-border-strong); border-radius:var(--cbx-radius-md); background:var(--cbx-bg); color:var(--cbx-text); resize:vertical;` focus 复用 `.cbx-input` 配方（`border-color:var(--cbx-border-focus); box-shadow:0 0 0 3px var(--cbx-brand-light)`）。移动端 `font-size:var(--cbx-fs-md)` |
| `.cbx-textarea--auto` | `resize:none; overflow-y:auto;`（高度由 JS 控制） |
| `.cbx-select` | 与 `.cbx-input` 同尺寸，`appearance:none` + 右侧 ▾ 背景图（用 `--cbx-text-tertiary` 的 SVG data-uri，唯一允许写死色值的地方改用 `currentColor` mask 更安全） |
| `.cbx-avatar` / `--xs(24) --sm(32) --md(40) --lg(64) --xl(96)` | `border-radius:var(--cbx-radius-pill); object-fit:cover; flex-shrink:0; background:var(--cbx-bg-active)`；`.cbx-avatar--card` 用 2:3 + `--cbx-radius-md` |
| `.cbx-avatar__fallback` | `display:grid; place-items:center; font-weight:var(--cbx-fw-bold); color:var(--cbx-text-secondary)` |
| `.cbx-bubble` `--user` `--ai` `--system` | 见 §2.3 |
| `.cbx-md` | Markdown 排版（p/ul/ol/pre/code/blockquote/table/hr/h1-h6/img） |
| `.cbx-modal__scrim` `.cbx-modal` `__head` `__body` `__foot` `--wide` `--sheet` | 见 §7.2 |
| `.cbx-sheet` | 移动端底部动作面板 |
| `.cbx-toast` `--success/--error/--warning` | 见 §7.3 |
| `.cbx-empty` `__icon` `__title` `__desc` | 居中空态 |
| `.cbx-spinner` | 16px 环形，`border-top-color:var(--cbx-brand)` |
| `.cbx-typing` `__dot` | 三点跳动 |
| `.cbx-skeleton` | `background:linear-gradient` ❌ → 用 `background:var(--cbx-bg-active)` + opacity 呼吸动画（规范禁渐变） |
| `.cbx-tabs` `.cbx-tab` `--active` | 下划线式，`overflow-x:auto` 移动端可横滑，`scrollbar-width:none` |
| `.cbx-collapse` `__head` `__body` `--open` | 折叠面板，head 高 44px |
| `.cbx-switch` | `input[type=checkbox]` 隐藏 + 轨道 40×22 + 拇指 18；`:checked` 轨道 `--cbx-brand`；移动端外层 `min-height:var(--cbx-tap-min)` |
| `.cbx-slider` | `input[type=range]` 的 webkit/moz 轨道与拇指；拇指 20px（移动 24px） |
| `.cbx-field` `__label` `__hint` `__error` `--row` | 表单行；`--row` 在 ≥768px 时 `grid-template-columns: 160px 1fr`，<768px 退回单列堆叠 |
| `.cbx-chip` `--active` `--removable` | 圆角 pill，`min-height:28px`（移动 32px） |
| `.cbx-seg` `__btn` `--active` | 分段控件，`--active` 用 `--cbx-bg` + `shadow-xs` 浮起 |
| `.cbx-icon-btn` | 36×36（移动 44×44）ghost 方钮，`border-radius:var(--cbx-radius-md)` |
| `.cbx-scroll` | `overflow-y:auto; min-height:0; overscroll-behavior:contain; -webkit-overflow-scrolling:touch` |
| `.cbx-safe-b` | `padding-bottom: max(var(--cbx-space-3), var(--cbx-safe-b))` |

### 0.3 新依赖决策
- `markdown-it` + `dompurify`（+ `@types/markdown-it`）：LLM 输出是不可信 HTML 源，**不要手搓 sanitizer**。
- 不引入 `@vueuse/core`（`useBreakpoint` 15 行自写）、不引入拖拽库（图谱与排序自写 pointer events）、不引入图表/裁剪库。
- **Tauri v2**（`@tauri-apps/cli` + `api` + `plugin-http` / `plugin-dialog` / `plugin-fs` / `plugin-barcode-scanner`）：
  打包安卓原生 App。引入它的**真正理由不是"做个壳"，而是 CORS** —— 打包后 webview 跑在
  自定义协议上，直连 AI 接口的请求带 `Content-Type: application/json` + `Authorization`，
  **一律触发预检**，没有任何侥幸空间；而要求每个用户自备 https 反代是不可接受的。
  plugin-http 把请求交给 Rust 的 reqwest 发出，从根上绕开同源策略。
  另外三个插件各自对应一个"安卓上会失效的 Web API"：
  `dialog`+`fs` 顶替 `<a download>`（**安卓 WebView 不处理 blob: 下载**），
  `barcode-scanner` 顶替 `getUserMedia`（WebView 扫码要改每次都会被重新生成的
  `RustWebChromeClient.kt`，改了留不住）。
  ⚠️ 版本必须 npm 与 crate 对齐，Tauri CLI 会在构建前直接拒绝不一致的组合；
  `tauri-plugin-http` 因此锁在 2.6（npm 侧最新只到 2.6.1，crate 已到 2.7）。
- `virtua`（`virtua/vue`）：聊天页消息虚拟滚动。**这是本项目少数几个"不自写"的决定**，理由是
  消息高度天然不可预知（Markdown、异步配图、swipe 换文、内联编辑、流式边生成边变高），
  手写就得自己维护高度缓存 + 屏外尺寸变化的滚动补偿，而这正是滚动跳动类 bug 的温床；
  virtua 用 ResizeObserver 自动测量，无需提供任何高度估值。选它而非 `@tanstack/vue-virtual`
  也是这个原因（后者要手工 `measureElement`）。零运行时依赖，框架 peer 全是 optional。
  用法见 `ChatView.vue`：**只在消息数超过阈值时启用**，低于阈值仍走扁平 `v-for`。

---

## 1. 应用外壳（App.vue 改造）

### 1.1 组件树

```
App.vue
├── .scrim            v-if ui.drawerOpen（<768px）
├── AppSidebar        :open  @close
│   ├── .brand
│   ├── button.cbx-btn--soft  「＋ 新建对话」→ NewChatSheet
│   ├── .search  input.cbx-input
│   ├── .cbx-scroll   会话列表
│   │   ├── .cbx-group-label 「今天 / 昨天 / 更早」
│   │   └── SessionListItem × n   (RouterLink to /chat/:id)
│   └── footer
│       ├── nav .cbx-nav-item ×3  角色 / 世界书 / 设置
│       └── button.cbx-btn--ghost  主题切换
├── main.main > RouterView
├── CbxToastHost      (Teleport body)
├── CbxConfirmHost    (Teleport body)
└── NewChatSheet      (Teleport body, v-if ui.newChatOpen)
```

**关键改动**：主题逻辑与 `drawerOpen` 从 App.vue 抬到 `stores/ui.ts`；侧栏样式搬进 `AppSidebar.vue`（避免依赖 scoped 样式穿透到子组件根节点这种脆弱行为）；`.main` 保留 `min-width:0`。

### 1.2 `src/App.vue` 骨架

```vue
<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import CbxToastHost from '@/components/ui/CbxToastHost.vue'
import CbxConfirmHost from '@/components/ui/CbxConfirmHost.vue'
import NewChatSheet from '@/components/chat/NewChatSheet.vue'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const route = useRoute()

onMounted(() => ui.initTheme())
// 移动端：路由变化自动收抽屉
watch(() => route.fullPath, () => ui.closeDrawer())
</script>

<template>
  <div class="shell">
    <div v-if="ui.drawerOpen" class="scrim" @click="ui.closeDrawer()" />
    <AppSidebar :open="ui.drawerOpen" @close="ui.closeDrawer()" />
    <main class="main">
      <RouterView v-slot="{ Component }">
        <KeepAlive include="ChatView">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>
    <CbxToastHost />
    <CbxConfirmHost />
    <NewChatSheet v-if="ui.newChatOpen" @close="ui.newChatOpen = false" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  height: 100dvh; /* iOS 地址栏收缩时不跳动 */
  overflow: hidden;
}
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.scrim { display: none; }

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
```

### 1.3 `AppSidebar.vue`（离屏抽屉范式，逐字沿用原 App.vue 的 CSS）

```vue
<template>
  <aside class="sidebar" :class="{ 'sidebar--open': open }">
    <!-- brand / 新建 / 搜索 / 会话列表 / footer -->
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex; flex-direction: column;
  width: var(--cbx-sidebar-w);
  padding: var(--cbx-space-3);
  background: var(--cbx-bg-secondary);
  border-right: 1px solid var(--cbx-border);
  flex-shrink: 0;
  min-height: 0;
}
.sidebar__list { flex: 1; overflow-y: auto; min-height: 0; margin: 0 calc(var(--cbx-space-2) * -1); padding: 0 var(--cbx-space-2); }
.sidebar__foot { margin-top: auto; padding-top: var(--cbx-space-2); border-top: 1px solid var(--cbx-border); }

@media (max-width: 767px) {
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 30;
    width: min(84vw, 320px);
    transform: translateX(-100%);
    transition: transform var(--cbx-transition);
    box-shadow: var(--cbx-shadow-lg);
    padding-top: max(var(--cbx-space-3), env(safe-area-inset-top));
    padding-bottom: max(var(--cbx-space-3), var(--cbx-safe-b));
  }
  .sidebar--open { transform: translateX(0); }
}
</style>
```

### 1.4 `AppTopbar.vue`（每个 view 自己渲染，统一汉堡）

```vue
<script setup lang="ts">
import { useUiStore } from '@/stores/ui'
defineProps<{ title?: string; back?: string }>()
const ui = useUiStore()
</script>

<template>
  <header class="topbar">
    <button v-if="back" class="cbx-icon-btn menu-btn--always" @click="$router.push(back)" aria-label="返回">‹</button>
    <button v-else class="cbx-icon-btn menu-btn" @click="ui.openDrawer()" aria-label="菜单">☰</button>
    <div class="topbar__title"><slot name="title">{{ title }}</slot></div>
    <div class="topbar__actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex; align-items: center; gap: var(--cbx-space-2);
  height: var(--cbx-topbar-h); flex-shrink: 0;
  padding: 0 var(--cbx-space-4);
  border-bottom: 1px solid var(--cbx-border);
  background: var(--cbx-bg);
  padding-top: env(safe-area-inset-top, 0px);
}
.topbar__title { flex: 1; min-width: 0; font-weight: var(--cbx-fw-bold); font-size: var(--cbx-fs-lg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar__actions { display: flex; gap: var(--cbx-space-1); }
.menu-btn { display: none; }
@media (max-width: 767px) {
  .menu-btn { display: inline-flex; }
  .topbar { padding: 0 var(--cbx-space-3); }
  .topbar__title { font-size: var(--cbx-fs-md); }
}
</style>
```

### 1.5 路由表（`src/router/index.ts`）

```ts
const routes = [
  { path: '/', redirect: '/chat' },
  { path: '/chat', name: 'chat-empty', component: () => import('@/views/ChatView.vue') },
  { path: '/chat/:id', name: 'chat', component: () => import('@/views/ChatView.vue'), props: true },
  { path: '/characters', name: 'characters', component: () => import('@/views/CharacterListView.vue') },
  { path: '/characters/new', name: 'character-new', component: () => import('@/views/CharacterEditView.vue') },
  { path: '/characters/:id', name: 'character-edit', component: () => import('@/views/CharacterEditView.vue'), props: true },
  { path: '/groups/new', name: 'group-new', component: () => import('@/views/GroupEditView.vue') },
  { path: '/groups/:id', name: 'group-edit', component: () => import('@/views/GroupEditView.vue'), props: true },
  { path: '/worlds/:bookId?/:uid?', name: 'worlds', component: () => import('@/views/WorldBooksView.vue'), props: true },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
]
```
世界书用**同一个 view 吃三级参数**：桌面三栏同屏、移动端按参数深度只渲染最深一栏，天然获得浏览器返回键。

---

## 2. 聊天页（1v1 / 1vN 共用）

### 2.1 组件树

```
ChatView.vue
├── AppTopbar
│   ├── title: 1v1 → 角色名 ; 1vN → 群名 + 成员头像叠放 (AvatarStack)
│   └── actions: [重新生成] [会话设置⚙] [⋯ 更多]
├── MessageList.vue            .cbx-scroll flex:1
│   ├── (空态) CbxEmpty  「发一条消息开始吧」
│   └── MessageBubble.vue × n
│        ├── CbxAvatar（1vN 必显；1v1 仅 AI 侧显）
│        ├── .meta  名字 + 时间（1vN 必显）
│        ├── .cbx-bubble
│        │    ├── MarkdownBody.vue  /  TypingDots.vue  /  内联编辑 CbxTextarea
│        │    └── .stream-caret（流式中）
│        ├── SwipeBar（仅最后一条 AI 消息：◀ 2/4 ▶ ↻）
│        └── MessageActions（hover 显示 / 移动端长按弹 CbxSheet）
├── GroupSpeakerTray.vue       仅 1vN 且策略=手动：一排头像，点击 = 让 TA 说
└── ChatComposer.vue           sticky bottom + safe-area
```

### 2.2 `ChatView.vue` 骨架

```vue
<script setup lang="ts">
import { computed, watch } from 'vue'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import MessageList from '@/components/chat/MessageList.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import GroupSpeakerTray from '@/components/chat/GroupSpeakerTray.vue'
import CbxEmpty from '@/components/ui/CbxEmpty.vue'
import { useSessionsStore } from '@/stores/sessions'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{ id?: string }>()
const sessions = useSessionsStore()
const ui = useUiStore()

watch(() => props.id, (id) => { if (id) void sessions.open(id) }, { immediate: true })

const session = computed(() => sessions.active)
const isGroup = computed(() => session.value?.mode === 'group')
const manualTray = computed(() => isGroup.value && session.value?.activationStrategy === 2)
</script>

<template>
  <template v-if="!session">
    <AppTopbar title="对话" />
    <CbxEmpty icon="💬" title="还没有对话" desc="从左侧新建，或先去创建一个角色">
      <button class="cbx-btn cbx-btn--primary" @click="ui.newChatOpen = true">＋ 新建对话</button>
    </CbxEmpty>
  </template>

  <template v-else>
    <AppTopbar :title="session.title">
      <template #actions>
        <button class="cbx-icon-btn" title="重新生成" @click="sessions.regenerate()">↻</button>
        <button class="cbx-icon-btn" title="会话设置" @click="ui.sessionPanelOpen = true">⚙</button>
      </template>
    </AppTopbar>

    <MessageList :session-id="session.id" />
    <GroupSpeakerTray v-if="manualTray" :members="session.members" />
    <ChatComposer :session-id="session.id" />
  </template>
</template>
```

### 2.3 `MessageBubble.vue` —— 视觉与交互

**视觉规格**
- 用户：右对齐，`background: var(--cbx-bubble-user-bg)`、`color: var(--cbx-bubble-user-text)`、`border-radius: 16px 16px 4px 16px`、无边框。
- AI：左对齐，`background: var(--cbx-bubble-ai-bg)`、`1px solid var(--cbx-bubble-ai-border)`、`border-radius: 16px 16px 16px 4px`。
- 系统/旁白：整行居中，无气泡，`--cbx-fs-xs` + `--cbx-text-tertiary`。
- **1vN 说话人区分**：气泡 `border-left: 3px solid var(--cbx-char-N)`，名字同色；`N = hash(characterId) % 8 + 1`，由 `charAccentClass(id)` 返回 `char-a`…`char-h` 类名（**不在组件里写色值**，8 个 token 已在 tokens.css）。
- 气泡最大宽 `min(var(--cbx-read-w), 82%)`；移动端 `88%`。

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import MarkdownBody from './MarkdownBody.vue'
import TypingDots from './TypingDots.vue'
import CbxTextarea from '@/components/ui/CbxTextarea.vue'
import { useSessionsStore } from '@/stores/sessions'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { useLongPress } from '@/composables/useLongPress'
import { charAccent } from '@/utils/charAccent'
import type { ChatMessage } from '@/types/chat'

const props = defineProps<{ message: ChatMessage; isLast: boolean; showAvatar: boolean }>()
const sessions = useSessionsStore()
const { isMobile } = useBreakpoint()

const editing = ref(false)
const draft = ref('')
const rowEl = ref<HTMLElement | null>(null)

const isStreaming = computed(() => sessions.streamingId === props.message.id)
const isEmptyStream = computed(() => isStreaming.value && !props.message.mes)
const canSwipe = computed(() => props.isLast && !props.message.isUser && !props.message.isSystem)
const swipeLabel = computed(() => `${props.message.swipeId + 1}/${Math.max(1, props.message.swipes.length)}`)
const accent = computed(() => charAccent(props.message.characterId))

useLongPress(rowEl, () => { if (isMobile.value) sessions.openActionSheet(props.message.id) })

function startEdit() { draft.value = props.message.mes; editing.value = true }
async function saveEdit() { await sessions.editMessage(props.message.id, draft.value); editing.value = false }
</script>

<template>
  <div ref="rowEl" class="row" :class="{ 'row--user': message.isUser, 'row--system': message.isSystem }">
    <CbxAvatar v-if="showAvatar && !message.isUser" :src="message.avatarId" :name="message.name" size="sm" />
    <div class="col">
      <div v-if="showAvatar && !message.isUser" class="meta" :class="accent">
        <span class="meta__name">{{ message.name }}</span>
        <span class="meta__time">{{ message.timeLabel }}</span>
      </div>

      <div class="cbx-bubble" :class="[message.isUser ? 'cbx-bubble--user' : 'cbx-bubble--ai', accent]">
        <template v-if="editing">
          <CbxTextarea v-model="draft" :max-height="320" auto-focus />
          <div class="edit-actions">
            <button class="cbx-btn cbx-btn--primary" @click="saveEdit">保存</button>
            <button class="cbx-btn cbx-btn--ghost" @click="editing = false">取消</button>
          </div>
        </template>
        <TypingDots v-else-if="isEmptyStream" />
        <MarkdownBody v-else :text="message.mes" :streaming="isStreaming" />
      </div>

      <div v-if="canSwipe" class="swipes">
        <button class="cbx-icon-btn" :disabled="isStreaming" @click="sessions.swipe(-1)">◀</button>
        <span class="swipes__pos">{{ swipeLabel }}</span>
        <button class="cbx-icon-btn" :disabled="isStreaming" @click="sessions.swipe(1)">▶</button>
      </div>

      <div v-if="!isMobile" class="actions">
        <button class="act" title="复制" @click="sessions.copy(message.id)">⧉</button>
        <button class="act" title="编辑" @click="startEdit">✎</button>
        <button v-if="canSwipe" class="act" title="重新生成" @click="sessions.regenerate()">↻</button>
        <button class="act" title="删除" @click="sessions.confirmDelete(message.id)">🗑</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; gap: var(--cbx-space-3); padding: var(--cbx-space-3) 0; }
.row--user { flex-direction: row-reverse; }
.row--system { justify-content: center; }
.col { display: flex; flex-direction: column; max-width: min(var(--cbx-read-w), 82%); min-width: 0; }
.row--user .col { align-items: flex-end; }

.meta { display: flex; align-items: baseline; gap: var(--cbx-space-2);
  font-size: var(--cbx-fs-xs); color: var(--cbx-text-tertiary); margin-bottom: 2px; padding: 0 var(--cbx-space-2); }
.meta__name { font-weight: var(--cbx-fw-medium); color: var(--cbx-char-accent, var(--cbx-text-secondary)); }

/* 8 色轮转：只切换一个局部变量，气泡与名字共用 */
.char-a { --cbx-char-accent: var(--cbx-char-1); }
.char-b { --cbx-char-accent: var(--cbx-char-2); }
/* … char-c ~ char-h 同理 */

.actions { display: flex; gap: 2px; margin-top: var(--cbx-space-1);
  opacity: 0; transition: opacity var(--cbx-transition); }
.row:hover .actions, .actions:focus-within { opacity: 1; }
.act { width: 28px; height: 26px; border: none; background: transparent; border-radius: var(--cbx-radius-sm);
  color: var(--cbx-text-tertiary); cursor: pointer; }
.act:hover { background: var(--cbx-bg-active); color: var(--cbx-text); }

.swipes { display: flex; align-items: center; gap: var(--cbx-space-1); margin-top: var(--cbx-space-1); }
.swipes__pos { font-size: var(--cbx-fs-xs); color: var(--cbx-text-tertiary); min-width: 32px; text-align: center; }

@media (max-width: 767px) {
  .col { max-width: 88%; }
  .swipes .cbx-icon-btn { width: var(--cbx-tap-min); height: 36px; }
}
</style>
```

配套 base.css：

```css
.cbx-bubble {
  padding: var(--cbx-space-3) var(--cbx-space-4);
  border-radius: var(--cbx-radius-lg);
  font-size: var(--cbx-fs-md);
  line-height: var(--cbx-lh);
  word-break: break-word;
  overflow-wrap: anywhere;
}
.cbx-bubble--user { background: var(--cbx-bubble-user-bg); color: var(--cbx-bubble-user-text);
  border-radius: var(--cbx-radius-lg) var(--cbx-radius-lg) var(--cbx-radius-sm) var(--cbx-radius-lg); }
.cbx-bubble--ai { background: var(--cbx-bubble-ai-bg); color: var(--cbx-bubble-ai-text);
  border: 1px solid var(--cbx-bubble-ai-border);
  border-radius: var(--cbx-radius-lg) var(--cbx-radius-lg) var(--cbx-radius-lg) var(--cbx-radius-sm);
  border-left: 3px solid var(--cbx-char-accent, transparent); }
```

### 2.4 流式打字

`MarkdownBody.vue`：**流式期间节流渲染**（每 100ms 一次，避免每 token 重跑 markdown-it + DOMPurify）；结束后立刻做一次终态渲染。

```vue
<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue'
import { renderMarkdown } from '@/composables/useMarkdown'

const props = defineProps<{ text: string; streaming?: boolean }>()
const shown = ref(props.text)
let timer: number | null = null

watch(() => props.text, (t) => {
  if (!props.streaming) { shown.value = t; return }
  if (timer !== null) return
  timer = window.setTimeout(() => { timer = null; shown.value = props.text }, 100)
})
watch(() => props.streaming, (s) => { if (!s) shown.value = props.text })
onUnmounted(() => { if (timer !== null) window.clearTimeout(timer) })

const html = computed(() => renderMarkdown(shown.value))
</script>

<template>
  <div class="cbx-md" :class="{ 'cbx-md--streaming': streaming }" v-html="html" />
</template>
```

光标：`.cbx-md--streaming > :last-child::after { content:''; display:inline-block; width:2px; height:1em; vertical-align:-0.15em; margin-left:2px; background:currentColor; animation: cbx-blink 1s steps(2,start) infinite }`

### 2.5 `ChatComposer.vue` —— 多行自增高 + 安全区

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useAutosize } from '@/composables/useAutosize'
import { useBreakpoint } from '@/composables/useBreakpoint'
import { useSessionsStore } from '@/stores/sessions'

const props = defineProps<{ sessionId: string }>()
const sessions = useSessionsStore()
const { isMobile } = useBreakpoint()

const text = ref('')
const ta = ref<HTMLTextAreaElement | null>(null)
const { resize } = useAutosize(ta, 200)

async function send() {
  if (sessions.isGenerating) { sessions.stop(); return }
  const t = text.value.trim()
  if (!t) return
  text.value = ''
  resize()
  await sessions.sendMessage(props.sessionId, t)
}

function onKeydown(e: KeyboardEvent) {
  // 移动端 Enter 永远换行；桌面 Enter 发送、Shift+Enter 换行
  if (isMobile.value) return
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send() }
}
</script>

<template>
  <div class="composer">
    <div class="composer__inner">
      <textarea
        ref="ta"
        v-model="text"
        class="cbx-textarea cbx-textarea--auto composer__ta"
        rows="1"
        placeholder="说点什么…"
        @input="resize"
        @keydown="onKeydown"
      />
      <button
        class="composer__send"
        :class="{ 'composer__send--stop': sessions.isGenerating }"
        :disabled="!sessions.isGenerating && !text.trim()"
        @click="send"
      >{{ sessions.isGenerating ? '■' : '↑' }}</button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  flex-shrink: 0;
  border-top: 1px solid var(--cbx-border);
  background: var(--cbx-bg);
  padding: var(--cbx-space-3) var(--cbx-space-4);
  padding-bottom: max(var(--cbx-space-3), var(--cbx-safe-b));
}
.composer__inner {
  max-width: var(--cbx-read-w); margin: 0 auto;
  display: flex; align-items: flex-end; gap: var(--cbx-space-2);
  padding: var(--cbx-space-2);
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border-strong);
  border-radius: var(--cbx-radius-lg);
  transition: border-color var(--cbx-transition), box-shadow var(--cbx-transition);
}
.composer__inner:focus-within { border-color: var(--cbx-border-focus); box-shadow: 0 0 0 3px var(--cbx-brand-light); }
.composer__ta {
  flex: 1; min-height: 28px; max-height: 200px;
  border: none; background: transparent; padding: var(--cbx-space-1) var(--cbx-space-2);
}
.composer__ta:focus { outline: none; box-shadow: none; border-color: transparent; }
.composer__send {
  width: 36px; height: 36px; flex-shrink: 0; border: none; cursor: pointer;
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-brand); color: var(--cbx-text-on-brand);
}
.composer__send:disabled { background: var(--cbx-bg-disabled); color: var(--cbx-text-disabled); cursor: not-allowed; }
.composer__send--stop { background: var(--cbx-error); }

@media (max-width: 767px) {
  .composer { padding: var(--cbx-space-2) var(--cbx-space-3); padding-bottom: max(var(--cbx-space-2), var(--cbx-safe-b)); }
  .composer__ta { font-size: var(--cbx-fs-md); } /* ≥16px 防 iOS 聚焦缩放 */
  .composer__send { width: var(--cbx-tap-min); height: var(--cbx-tap-min); }
}
</style>
```

`useAutosize.ts`：
```ts
import { onMounted, type Ref } from 'vue'

export function useAutosize(el: Ref<HTMLTextAreaElement | null>, max = 200) {
  function resize() {
    const n = el.value
    if (!n) return
    n.style.height = 'auto'
    n.style.height = `${Math.min(n.scrollHeight, max)}px`
    n.style.overflowY = n.scrollHeight > max ? 'auto' : 'hidden'
  }
  onMounted(resize)
  return { resize }
}
```

### 2.6 移动端聊天页要点
- `.shell{height:100dvh}` + `MessageList` 用 `.cbx-scroll`：键盘弹出时 dvh 收缩，composer 自然上移；再监听 `window.visualViewport` 的 `resize`，键盘出现时 `scrollToBottom()`。
- 消息操作走**长按 → `CbxSheet` 底部面板**（复制/编辑/重新生成/删除/从此分支），避免 hover 依赖。
- swipe 按钮在移动端撑到 44px 高。
- `GroupSpeakerTray` 横向可滑，`overflow-x:auto`，头像 40px，`scroll-snap-type: x proximity`。

---

## 3. 角色创建 / 编辑页

### 3.1 页面结构（`views/CharacterEditView.vue`）

```
AppTopbar back="/characters"  title="新建角色 / 编辑角色"
  actions: [导出卡片] [保存 primary]
CbxTabs: 基本 | 开场白 | 对话示例 | 高级
  ── 基本 ─────────────────────────────
     AvatarPicker (2:3 卡面裁剪)  + name + tags(CbxTagInput) + creator_notes
     description  (CbxTextarea tall, 带 {{user}}/{{char}} 插入按钮 + 字数)
     personality  (CbxTextarea)
     scenario     (CbxTextarea)
  ── 开场白 ───────────────────────────
     GreetingsEditor  (greetings[] = [first_mes, ...alternate_greetings])
  ── 对话示例 ─────────────────────────
     ExampleDialogueEditor (mes_example ⇄ 块结构)
  ── 高级 ─────────────────────────────
     角色世界书：[未关联 ▾ 选择已有] [＋ 新建内嵌世界书 → /worlds/:id?char=]
     depth_prompt: prompt(textarea) + depth(number,默认4) + role(seg: system/user/assistant)
     talkativeness: CbxSlider 0~1 step .05（默认 0.5，附文案「1vN 自然顺序时的发言概率」）
     system_prompt 覆盖 / post_history_instructions 覆盖（折叠）
```

**宏辅助条**：每个大文本域上方一排 `.cbx-chip`：`{{user}}` `{{char}}`，点击在光标位置插入（`setRangeText` + 保持焦点）。右下角显示「≈N tokens」。

### 3.2 `GreetingsEditor.vue`

数据映射：UI 只维护 `greetings: string[]`；保存时 `first_mes = greetings[0] ?? ''`，`alternate_greetings = greetings.slice(1)`。

```
[卡片] 开场白 1 · 默认            [预览] [↑] [↓] [🗑]
       CbxTextarea (auto, max 400)
[卡片] 开场白 2 ...
[＋ 添加开场白]
提示条：新对话会从这些开场白中随机挑一条；在聊天里可以左右切换查看其余的。
```
- 第 1 条角标写「默认」，删除第 1 条时后一条自动升为默认（因为只是数组 shift）。
- 「预览」按钮把 `{{user}}`/`{{char}}` 替换成当前用户名/角色名，弹 `CbxModal` 显示 Markdown 渲染结果。
- 排序用**上下按钮**而非拖拽（移动端可靠、无依赖）。桌面额外支持 pointer 拖拽把手（`CbxSortable`）。

### 3.3 `ExampleDialogueEditor.vue` —— `<START>` 分块编辑器

**数据结构**

```ts
export interface ExampleTurn { who: 'user' | 'char'; text: string }
export interface ExampleBlock { id: string; turns: ExampleTurn[]; raw?: string } // raw 存在 = 该块解析失败，走源码模式
```

**解析**（`utils/mesExample.ts`）

```ts
const USER_RE = /^\s*(?:\{\{user\}\}|<USER>)\s*[:：]\s*/i
const CHAR_RE = /^\s*(?:\{\{char\}\}|<BOT>|<CHAR>)\s*[:：]\s*/i

export function parseMesExample(src: string): ExampleBlock[] {
  if (!src.trim()) return []
  const chunks = src.split(/<START>/gi)
  const body = chunks[0]?.trim() ? chunks : chunks.slice(1) // 无前导 <START> 时不丢首块
  const blocks: ExampleBlock[] = []
  for (const chunk of body) {
    const lines = chunk.split(/\r?\n/)
    const turns: ExampleTurn[] = []
    let orphan = false
    for (const line of lines) {
      if (!line.trim()) continue
      if (USER_RE.test(line)) { turns.push({ who: 'user', text: line.replace(USER_RE, '') }); continue }
      if (CHAR_RE.test(line)) { turns.push({ who: 'char', text: line.replace(CHAR_RE, '') }); continue }
      const last = turns[turns.length - 1]
      if (last) last.text += `\n${line}`   // 多行续接
      else orphan = true                   // 块首出现无归属文本 → 该块降级为源码模式
    }
    if (!turns.length && !chunk.trim()) continue
    blocks.push(orphan ? { id: uid(), turns: [], raw: chunk.trim() } : { id: uid(), turns })
  }
  return blocks
}

export function serializeMesExample(blocks: ExampleBlock[]): string {
  return blocks
    .map((b) => {
      if (b.raw !== undefined) return `<START>\n${b.raw}`
      const body = b.turns
        .map((t) => `${t.who === 'user' ? '{{user}}' : '{{char}}'}: ${t.text}`)
        .join('\n')
      return `<START>\n${body}`
    })
    .join('\n')
}
```

**UI**

```
[卡片 .cbx-card] 示例对话 1                 [源码] [↑] [↓] [🗑]
  ┌ [{{user}} ▾] CbxTextarea(auto)         [🗑] ┐   ← 一行 = 一个 turn
  │ [{{char}} ▾] CbxTextarea(auto)         [🗑] │
  └ [＋ 用户发言]  [＋ 角色发言]                 ┘
[卡片] 示例对话 2 ...
[＋ 添加示例块]
```
- 说话人切换用 `.cbx-chip--active` 小 pill（点一下 user↔char 互换），比下拉更快。
- 顶部一个全局「源码模式」开关，切回结构模式时重新 `parseMesExample`；解析出 `raw` 的块显示黄色 `.cbx-badge--warning`「原样保留」，不强改用户内容。
- 移动端：turn 行由 `flex` 改为 `grid-template-areas`，说话人 pill 单独一行在文本域上方。

### 3.4 头像上传裁剪 `CbxImageCropper.vue`

- 触发：点击 `AvatarPicker` → `<input type="file" accept="image/*" hidden>` → 选中后读为 `createImageBitmap(file)` → 打开 `CbxModal--wide`。
- 画布：一个 `position:relative` 容器，内含 `<img>`（`transform: translate(tx,ty) scale(k)`）+ 一个 `pointer-events:none` 的 2:3 遮罩框（四周 `--cbx-bg-mask`，中间镂空用 `box-shadow: 0 0 0 9999px var(--cbx-bg-mask)`）。
- 交互：单指拖拽平移（pointer events + `setPointerCapture`），双指捏合缩放，桌面滚轮缩放；底部一条 `CbxSlider` 兜底缩放。容器 `touch-action: none`。
- 输出：`canvas` 尺寸 **400×600**（ST 卡面标准），`ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, 400, 600)`（由 tx/ty/k 反解 source 矩形），再 `canvas.toBlob(cb, 'image/png')`。同时生成 **96×96 方形缩略图**（居中偏上 `object-position: 50% 20%` 的等效裁剪）用于聊天头像。
- 存储：两个 Blob 存 IndexedDB（`assets` store，key = `${charId}:card` / `${charId}:thumb`）。
- 显示：`useBlobUrl(assetId)` 维护 `Map<string, {url, refs}>`，组件卸载 refs-- 到 0 时 `URL.revokeObjectURL`。**这是最容易内存泄漏的地方，必须集中管理，禁止组件里散写 createObjectURL。**

---

## 4. 世界书管理页

### 4.1 三栏 / 三级路由

`/worlds/:bookId?/:uid?`

```
桌面 (≥768px)  grid-template-columns: 260px 320px 1fr
┌ 书列表 ┬ 条目列表 ┬ 条目编辑器 ┐
移动端 (<768px)  只渲染最深一级 + AppTopbar 的 ‹ 返回
```

```ts
const showBooks   = computed(() => !isMobile.value || !props.bookId)
const showEntries = computed(() => !isMobile.value ? !!props.bookId : (!!props.bookId && !props.uid))
const showEditor  = computed(() => !!props.bookId && !!props.uid)
```

**书列表栏**：`[＋ 新建] [导入 JSON]`；分两组 `.cbx-group-label`「全局世界书」「角色世界书」；每行 = 名字 + 条目数 `.cbx-badge` + 全局启用开关 `.cbx-switch`（对应 `settings.enabledWorlds`）+ ⋯（重命名/导出/删除）。

**条目列表栏**：顶部搜索 `.cbx-input`（匹配 comment / key / content）+ 过滤 chips（启用/禁用/常量/atDepth）+ `[＋ 新建条目]` + 排序切换（order ▾ / 手动 displayIndex）。行 = `WiEntryRow`：
```
[⋮⋮拖拽] [开关] 标题(comment 或 key 前 100 字)   [常量🔵/关键词/向量🟢] [位置徽标] [order]
```

### 4.2 条目编辑器字段分组（40+ 字段的信息层级）

> 原则：**「什么时候触发」→「触发后放哪」→「内容」永远可见，其余全部折叠**；折叠区标题带「已修改」小圆点，避免用户忘了自己改过高级项。

**A 区 · 基础（常驻展开）**
| 控件 | 字段 |
|---|---|
| 标题输入 | `comment` |
| 触发模式 `CbxSegmented` 三选一 | `constant` / 普通关键词 / `vectorized` |
| 主关键词 `CbxTagInput`（支持 `/regex/flags`，非法正则实时红字） | `key[]` |
| 次要关键词 `CbxTagInput` + 逻辑 `CbxSelect` | `keysecondary[]` + `selectiveLogic`（0 AND ANY / 1 NOT ALL / 2 NOT ANY / 3 AND ALL） |
| 内容 `CbxTextarea tall` + 字符/≈token 计数 | `content` |
| 插入位置 `CbxSelect` 8 项 | `position` 0 前置角色定义 / 1 后置角色定义 / 2 作者注顶 / 3 作者注底 / 4 ＠深度 / 5 示例对话顶 / 6 示例对话底 / 7 命名出口 |
| 条件显示 | `position===4` → `depth`(0-1000) + `role`(seg system/user/assistant)；`position===7` → `outletName`（空则红字警告） |
| 排序 | `order`（number，说明「降序，越大越靠前」） |

**B 区 · 折叠「匹配与扫描」**
`scanDepth`(CbxNullableNumber，关=继承全局) · `caseSensitive`(CbxTriState) · `matchWholeWords`(CbxTriState) · `useGroupScoring`(CbxTriState) · 扫描源开关 6 个 chips：`matchPersonaDescription` `matchCharacterDescription` `matchCharacterPersonality` `matchCharacterDepthPrompt` `matchScenario` `matchCreatorNotes`

**C 区 · 折叠「递归」**
`excludeRecursion`(开关「不被递归激活」) · `preventRecursion`(开关「不触发其它条目」) · `delayUntilRecursion`(CbxNullableNumber，值=递归层级，1 起)

**D 区 · 折叠「概率与预算」**
`useProbability` 开关 + `probability` CbxSlider 0-100（关时禁用滑块） · `ignoreBudget` 开关

**E 区 · 折叠「包含组」**
`group`(CbxTagInput，逗号分隔多组) · `groupOverride`(开关「组内优先，按 order 直取」) · `groupWeight`(number 1-10000，仅非 override 时启用)

**F 区 · 折叠「定时效果」**
`sticky` / `cooldown` / `delay` 三个 `CbxNullableNumber`（1-10000），每个带一句人话说明。

**G 区 · 折叠「触发类型」**
`triggers[]` 6 个 chips：normal / continue / impersonate / swipe / regenerate / quiet（全不选 = 全部）

**H 区 · 折叠「角色过滤」**
`characterFilter.isExclude`(seg 仅限/排除) + `names[]`(角色多选 chips) + `tags[]`(CbxTagInput)

**I 区 · 折叠「其它」**
`automationId`(text) · `uid`(只读) · `displayIndex`(只读，拖拽时自动) · `addMemo`/`selective` **不出 UI**（恒定值，仅导出时写回）

**两个复用控件**

```vue
<!-- CbxTriState.vue : null | true | false -->
<script setup lang="ts">
const model = defineModel<boolean | null>({ required: true })
const opts = [
  { v: null as boolean | null, l: '继承' },
  { v: true as boolean | null, l: '是' },
  { v: false as boolean | null, l: '否' },
]
</script>
<template>
  <div class="cbx-seg">
    <button v-for="o in opts" :key="String(o.v)" class="cbx-seg__btn"
      :class="{ 'cbx-seg__btn--active': model === o.v }" @click="model = o.v">{{ o.l }}</button>
  </div>
</template>
```

```vue
<!-- CbxNullableNumber.vue : null | number -->
<script setup lang="ts">
const model = defineModel<number | null>({ required: true })
const props = withDefaults(defineProps<{ min?: number; max?: number; fallback?: number }>(),
  { min: 0, max: 10000, fallback: 1 })
function toggle(on: boolean) { model.value = on ? (model.value ?? props.fallback) : null }
</script>
<template>
  <div class="nn">
    <label class="cbx-switch"><input type="checkbox" :checked="model !== null"
      @change="toggle(($event.target as HTMLInputElement).checked)" /><span /></label>
    <input class="cbx-input nn__num" type="number" :min="min" :max="max" :disabled="model === null"
      :value="model ?? ''" @input="model = Number(($event.target as HTMLInputElement).value)" />
  </div>
</template>
```

**移动端**：`.cbx-field` 全部退回单列堆叠；折叠区默认全关；编辑器底部一条 sticky 操作栏 `[删除] [保存]`（带 safe-area）。条目列表拖拽排序在移动端隐藏拖拽把手，改用 ⋯ 菜单里的「上移/下移/移到顶部」。

---

## 5. 1vN 演绎创建 + 关系图谱

### 5.1 `GroupEditView.vue` 结构

```
AppTopbar back  title="新建演绎"  actions=[保存]
CbxTabs: 成员 | 关系 | 策略
── 成员 ──
   已选成员（可拖拽排序 = members 顺序，决定「列表顺序」发言次序）
     行：拖拽把手 · 头像 · 名字 · 静音开关(disabled_members) · 移除
   [＋ 添加成员] → CharacterPicker (CbxModal，多选，带搜索)
   群名 input（留空自动「演绎：A、B、C」）+ 群头像（默认 2×2 成员拼贴）
── 关系 ──
   CbxTabs 内嵌：图谱 | 列表      ← 移动端默认「列表」，桌面默认「图谱」
   [图谱] RelationGraph.vue  + 工具条
   [列表] RelationList.vue  （A → B ：关系名 / 描述 / 编辑 / 删除）
   底部预览：「插入到提示词的文本」只读代码块
── 策略 ──
   发言策略 CbxSegmented: 手动(2) 自然(0) 列表(1) 轮询(3) + 每项一句说明
   生成模式 CbxSegmented: 交换角色卡(0) 合并·排除静音(1) 合并·含静音(2)
     └ 仅合并模式显示：join 前缀 / 后缀（支持 {{char}} 与 <FIELDNAME>，附示例）
   allow_self_responses 开关 · auto_mode_delay(1-999s)
```

### 5.2 关系数据模型

```ts
export interface GroupNode { characterId: string; x: number; y: number }
export interface GroupRelation {
  id: string
  from: string        // characterId
  to: string          // characterId（有向；A→B 与 B→A 各自独立一条）
  label: string       // 关系名，如「姐姐」
  desc?: string       // 补充描述，可空
}
// 存在 group 记录上：{ graph: { nodes: GroupNode[], relations: GroupRelation[] } }
```

提示词渲染（供 prompt 层调用，UI 只负责预览）：
```
[角色关系]
- 爱丽丝 → 鲍勃：姐姐（很宠他，说话带命令口吻）
- 鲍勃 → 爱丽丝：弟弟
```

### 5.3 `RelationGraph.vue` —— 完整实现思路

#### (a) 坐标系
- `<svg>` **不设 `viewBox`**（用户单位 = CSS 像素，屏幕↔用户单位 1:1，省掉 `getScreenCTM` 的矩阵反解）。
- 所有内容包在一个视图组里：`<g :transform="\`translate(${view.x},${view.y}) scale(${view.k})\`">`。
- 屏幕 → 世界：

```ts
const view = ref({ x: 0, y: 0, k: 1 })
const svgEl = ref<SVGSVGElement | null>(null)

function toWorld(clientX: number, clientY: number) {
  const el = svgEl.value
  if (!el) return { x: 0, y: 0 }
  const r = el.getBoundingClientRect()
  return { x: (clientX - r.left - view.value.x) / view.value.k,
           y: (clientY - r.top - view.value.y) / view.value.k }
}
```

#### (b) 指针状态机（统一鼠标/触摸/笔）

```ts
type DragState =
  | { kind: 'none' }
  | { kind: 'node'; id: string; ox: number; oy: number; moved: boolean }
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'link'; from: string; tip: { x: number; y: number } }
  | { kind: 'pinch'; d0: number; k0: number; c0: { x: number; y: number }; v0: { x: number; y: number } }

const drag = ref<DragState>({ kind: 'none' })
const pointers = new Map<number, { x: number; y: number }>()
```

```ts
function onPointerDown(e: PointerEvent, target: { type: 'node' | 'handle' | 'edge' | 'bg'; id?: string }) {
  svgEl.value?.setPointerCapture(e.pointerId)
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

  if (pointers.size === 2) { startPinch(); return }

  const w = toWorld(e.clientX, e.clientY)
  if (target.type === 'handle' && target.id) {
    drag.value = { kind: 'link', from: target.id, tip: w }
  } else if (target.type === 'node' && target.id) {
    const n = nodes.value.find((x) => x.characterId === target.id)
    if (!n) return
    drag.value = { kind: 'node', id: target.id, ox: w.x - n.x, oy: w.y - n.y, moved: false }
    selectedId.value = target.id
  } else if (target.type === 'bg') {
    drag.value = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.value.x, vy: view.value.y }
    selectedId.value = null
  }
}

let raf = 0
function onPointerMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (raf) return
  raf = requestAnimationFrame(() => { raf = 0; applyMove(e) })   // rAF 节流，避免每个 move 触发 Vue patch
}

function applyMove(e: PointerEvent) {
  const d = drag.value
  if (d.kind === 'pinch') { applyPinch(); return }
  if (d.kind === 'pan') {
    view.value = { ...view.value, x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy) }
    return
  }
  const w = toWorld(e.clientX, e.clientY)
  if (d.kind === 'node') {
    const n = nodes.value.find((x) => x.characterId === d.id)
    if (!n) return
    n.x = w.x - d.ox
    n.y = w.y - d.oy
    d.moved = true
  } else if (d.kind === 'link') {
    d.tip = w
  }
}

function onPointerUp(e: PointerEvent) {
  pointers.delete(e.pointerId)
  const d = drag.value
  if (d.kind === 'link') {
    const hit = hitTestNode(d.tip)                    // 命中测试见 (e)
    if (hit && hit !== d.from) emit('create-relation', { from: d.from, to: hit })
  }
  if (d.kind === 'node' && d.moved) emit('persist')   // 只在真移动后落库（防抖 300ms）
  if (pointers.size < 2) drag.value = { kind: 'none' }
}
```

#### (c) 缩放（滚轮 + 捏合，都以锚点为中心）

```ts
function zoomAt(px: number, py: number, factor: number) {
  const k = Math.min(3, Math.max(0.3, view.value.k * factor))
  const s = k / view.value.k
  view.value = { k, x: px - (px - view.value.x) * s, y: py - (py - view.value.y) * s }
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const r = svgEl.value?.getBoundingClientRect()
  if (!r) return
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015))
}

function startPinch() {
  const ps = [...pointers.values()]
  const a = ps[0], b = ps[1]
  if (!a || !b) return
  drag.value = {
    kind: 'pinch',
    d0: Math.hypot(b.x - a.x, b.y - a.y),
    k0: view.value.k,
    c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    v0: { x: view.value.x, y: view.value.y },
  }
}

function applyPinch() {
  const d = drag.value
  if (d.kind !== 'pinch') return
  const ps = [...pointers.values()]
  const a = ps[0], b = ps[1]
  const r = svgEl.value?.getBoundingClientRect()
  if (!a || !b || !r || d.d0 < 1) return
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  const k = Math.min(3, Math.max(0.3, (d.k0 * dist) / d.d0))
  const s = k / d.k0
  const cx = d.c0.x - r.left, cy = d.c0.y - r.top
  // 以初始中点为锚点缩放，再叠加中点的平移（双指同时拖动）
  const mx = (a.x + b.x) / 2 - d.c0.x, my = (a.y + b.y) / 2 - d.c0.y
  view.value = { k, x: cx - (cx - d.v0.x) * s + mx, y: cy - (cy - d.v0.y) * s + my }
}
```

> **必须**：`<svg style="touch-action: none">`，否则浏览器抢走手势去滚页面/系统缩放；外层容器加 `overscroll-behavior: contain`。

#### (d) 边的几何（`utils/graphGeometry.ts`）

```ts
export interface Pt { x: number; y: number }

const R_NODE = 30      // 节点视觉半径
const ARROW = 10       // 箭头长度补偿
const BOW = 26         // 弯曲量（同一对角色的正反向各偏一侧）

function toward(a: Pt, b: Pt, dist: number): Pt {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { x: a.x + (dx / len) * dist, y: a.y + (dy / len) * dist }
}

/** 二次贝塞尔弯边：起终点裁到节点圆外，控制点沿法线偏移 */
export function edgeGeometry(a: Pt, b: Pt, bowSign: 1 | -1) {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1) return null
  const nx = -dy / len, ny = dx / len                          // 单位法线
  const c: Pt = { x: (a.x + b.x) / 2 + nx * BOW * bowSign,
                  y: (a.y + b.y) / 2 + ny * BOW * bowSign }
  const a2 = toward(a, c, R_NODE)                              // 起点沿"指向控制点"方向推出圆外
  const b2 = toward(b, c, R_NODE + ARROW)                      // 终点额外让出箭头长度
  const d = `M${a2.x.toFixed(1)} ${a2.y.toFixed(1)} Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${b2.x.toFixed(1)} ${b2.y.toFixed(1)}`
  // 贝塞尔 t=0.5 的点：¼A + ½C + ¼B
  const mid: Pt = { x: 0.25 * a2.x + 0.5 * c.x + 0.25 * b2.x,
                    y: 0.25 * a2.y + 0.5 * c.y + 0.25 * b2.y }
  return { d, mid }
}

/** A→B 与 B→A 必须朝两侧弯开：按 id 字典序定符号 */
export const bowSignOf = (from: string, to: string): 1 | -1 => (from < to ? 1 : -1)
```

**箭头**：用 SVG `<marker>` 让浏览器自动算切线，不用手算角度。

```html
<defs>
  <clipPath id="rg-clip"><circle cx="0" cy="0" r="27" /></clipPath>
  <marker id="rg-arrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
    <path d="M0,0 L10,5 L0,10 Z" class="arrow" />
  </marker>
  <marker id="rg-arrow-on" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
    <path d="M0,0 L10,5 L0,10 Z" class="arrow arrow--on" />
  </marker>
</defs>
```
（`marker` 无法被引用它的线单独着色，所以定义**两个** marker：普通态 `--cbx-text-tertiary`，选中态 `--cbx-brand`，`:marker-end` 用计算属性切 id。）

#### (e) 命中测试
- **节点**：不做数学计算，直接放一个更大的透明圆 `<circle r="34" fill="transparent">` 当热区（直径 68px > 44px 触控标准），DOM 命中即可。
- **拖线释放时的命中**（此时指针 capture 在 svg 上，`document.elementFromPoint` 会拿到 svg 本身），所以用纯数学：

```ts
function hitTestNode(p: Pt): string | null {
  for (const n of nodes.value) {
    if ((p.x - n.x) ** 2 + (p.y - n.y) ** 2 <= 34 * 34) return n.characterId
  }
  return null
}
```
- **边**：同一条 `d` 画两遍，底下一条透明粗线专管点击：
```html
<path :d="g.d" fill="none" stroke="transparent" stroke-width="22"
      pointer-events="stroke" @pointerdown.stop="onEdgeTap(rel)" />
<path :d="g.d" fill="none" class="edge" :class="{ 'edge--on': selectedEdge === rel.id }"
      :marker-end="selectedEdge === rel.id ? 'url(#rg-arrow-on)' : 'url(#rg-arrow)'" />
```
`pointer-events="stroke"` 让透明描边也可命中（默认 `visiblePainted` 对 `transparent` 无效）。

#### (f) 模板骨架

```vue
<template>
  <div class="graph" :class="{ 'graph--full': fullscreen }">
    <div class="graph__bar">
      <button class="cbx-btn cbx-btn--ghost" @click="relayout">重新排列</button>
      <button class="cbx-btn cbx-btn--ghost" @click="fitView">适应画布</button>
      <button class="cbx-icon-btn" @click="zoomAtCenter(1 / 1.25)">−</button>
      <button class="cbx-icon-btn" @click="zoomAtCenter(1.25)">＋</button>
      <span class="graph__hint">拖头像移动 · 拖 ＋ 到另一角色建立关系 · 点连线编辑</span>
      <button class="cbx-icon-btn" @click="fullscreen = !fullscreen">{{ fullscreen ? '✕' : '⤢' }}</button>
    </div>

    <svg ref="svgEl" class="graph__svg"
      @pointerdown="onPointerDown($event, { type: 'bg' })"
      @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp"
      @wheel.prevent="onWheel">
      <defs><!-- clipPath + 两个 marker --></defs>

      <g :transform="`translate(${view.x},${view.y}) scale(${view.k})`">
        <!-- 边先画，节点后画（节点压在上面） -->
        <g class="edges">
          <g v-for="e in edgeViews" :key="e.rel.id">
            <path :d="e.d" fill="none" stroke="transparent" stroke-width="22"
                  pointer-events="stroke" @pointerdown.stop="onEdgeTap(e.rel)" />
            <path :d="e.d" fill="none" class="edge" :class="{ 'edge--on': selectedEdge === e.rel.id }"
                  :marker-end="selectedEdge === e.rel.id ? 'url(#rg-arrow-on)' : 'url(#rg-arrow)'" />
            <text :x="e.mid.x" :y="e.mid.y" class="edge__label" text-anchor="middle"
                  dominant-baseline="middle">{{ e.rel.label }}</text>
          </g>
        </g>

        <!-- 拖拽中的临时连线 -->
        <path v-if="linkPreview" :d="linkPreview" class="edge edge--ghost" fill="none" />

        <g class="nodes">
          <g v-for="n in nodes" :key="n.characterId" :transform="`translate(${n.x},${n.y})`"
             class="node" :class="{ 'node--on': selectedId === n.characterId }">
            <circle r="34" fill="transparent"
                    @pointerdown.stop="onPointerDown($event, { type: 'node', id: n.characterId })" />
            <circle r="30" class="node__ring" />
            <image v-if="avatarUrl(n.characterId)" :href="avatarUrl(n.characterId)"
                   x="-27" y="-27" width="54" height="54"
                   clip-path="url(#rg-clip)" preserveAspectRatio="xMidYMid slice" />
            <text v-else class="node__initial" text-anchor="middle" dominant-baseline="middle">
              {{ nameOf(n.characterId).charAt(0) }}
            </text>
            <text y="50" class="node__label" text-anchor="middle">{{ nameOf(n.characterId) }}</text>

            <!-- 选中时出现的连线柄 -->
            <g v-if="selectedId === n.characterId" class="handle"
               @pointerdown.stop="onPointerDown($event, { type: 'handle', id: n.characterId })">
              <circle cx="26" cy="-26" r="13" class="handle__bg" />
              <text x="26" y="-26" text-anchor="middle" dominant-baseline="middle" class="handle__plus">＋</text>
            </g>
          </g>
        </g>
      </g>
    </svg>
  </div>
</template>
```

`edgeViews`：
```ts
const edgeViews = computed(() =>
  relations.value.flatMap((rel) => {
    const a = nodes.value.find((n) => n.characterId === rel.from)
    const b = nodes.value.find((n) => n.characterId === rel.to)
    if (!a || !b) return []
    const g = edgeGeometry(a, b, bowSignOf(rel.from, rel.to))
    return g ? [{ rel, d: g.d, mid: g.mid }] : []
  }),
)
```

#### (g) 样式（全部 token；SVG 用 CSS 控制 fill/stroke）

```css
.graph { border: 1px solid var(--cbx-border); border-radius: var(--cbx-radius-lg); overflow: hidden;
  background: var(--cbx-bg); display: flex; flex-direction: column; }
.graph__bar { display: flex; align-items: center; gap: var(--cbx-space-2);
  padding: var(--cbx-space-2) var(--cbx-space-3); border-bottom: 1px solid var(--cbx-border);
  overflow-x: auto; }
.graph__hint { flex: 1; font-size: var(--cbx-fs-xs); color: var(--cbx-text-tertiary); white-space: nowrap; }
.graph__svg { display: block; width: 100%; height: 420px;
  touch-action: none; overscroll-behavior: contain; user-select: none; -webkit-user-select: none; }

.node__ring { fill: var(--cbx-bg-secondary); stroke: var(--cbx-border); stroke-width: 2; }
.node--on .node__ring { stroke: var(--cbx-brand); stroke-width: 3; }
.node__initial { fill: var(--cbx-text-secondary); font-size: 20px; font-weight: var(--cbx-fw-bold); }
.node__label { fill: var(--cbx-text); font-size: 13px;
  stroke: var(--cbx-bg); stroke-width: 4px; paint-order: stroke fill; }   /* 文字描边光晕，压住穿过的连线 */
.handle__bg { fill: var(--cbx-brand); }
.handle__plus { fill: var(--cbx-text-on-brand); font-size: 14px; }

.edge { stroke: var(--cbx-border-strong); stroke-width: 2; }
.edge--on { stroke: var(--cbx-brand); stroke-width: 3; }
.edge--ghost { stroke: var(--cbx-brand); stroke-width: 2; stroke-dasharray: 5 4; }
.edge__label { fill: var(--cbx-text-secondary); font-size: 12px;
  stroke: var(--cbx-bg); stroke-width: 4px; paint-order: stroke fill; }
.arrow { fill: var(--cbx-border-strong); }
.arrow--on { fill: var(--cbx-brand); }

.graph--full { position: fixed; inset: 0; z-index: 40; border-radius: 0;
  padding-bottom: var(--cbx-safe-b); }
.graph--full .graph__svg { height: 100%; flex: 1; }

@media (max-width: 767px) {
  .graph__svg { height: 55vh; }
  .graph__hint { display: none; }
}
```

#### (h) 初始布局 / 适应画布

```ts
function circleLayout(ids: string[], w: number, h: number): GroupNode[] {
  const r = Math.min(w, h) / 2 - 70
  const rr = Math.max(110, Math.min(r, 80 + ids.length * 22))
  return ids.map((id, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, ids.length)
    return { characterId: id, x: w / 2 + rr * Math.cos(a), y: h / 2 + rr * Math.sin(a) }
  })
}

function fitView() {
  const el = svgEl.value
  if (!el || !nodes.value.length) return
  const r = el.getBoundingClientRect()
  const xs = nodes.value.map((n) => n.x), ys = nodes.value.map((n) => n.y)
  const pad = 70
  const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad
  const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad
  const k = Math.min(r.width / (x1 - x0), r.height / (y1 - y0), 1.5)
  view.value = { k, x: r.width / 2 - ((x0 + x1) / 2) * k, y: r.height / 2 - ((y0 + y1) / 2) * k }
}
```
- 成员**新增时**自动补一个圆周位置；成员移除时同时删掉它的所有边。
- 图谱与「关系列表」是同一份数据的两个视图；**移动端默认列表 Tab**，画布作为可选的全屏编辑器。这既是无障碍兜底，也是小屏最快的编辑路径。

#### (i) `RelationEditModal.vue`
`CbxModal`（移动端 `--sheet` 底部弹出）：起点/终点两个只读头像 + 中间「⇄ 交换方向」按钮 · 关系名 `.cbx-input` + 快捷 chips（恋人/朋友/兄妹/师徒/上下级/宿敌/陌生人） · 描述 `CbxTextarea` · 底部 `[删除] [取消] [保存]`。保存时校验 `from !== to` 且同向不重复（重复则改为编辑已有那条）。

---

## 6. 全局配置页（`views/SettingsView.vue`）

用 `CbxCollapse` 分节（桌面默认全开、移动端默认只开第一节），左侧桌面额外一列锚点导航（`position:sticky`）。

**① 模型服务**
`baseURL`（占位 `https://api.openai.com/v1`）· `apiKey`（type=password + 👁 切换 + 「仅保存在本机 IndexedDB」小字）· `model`（input + `[拉取模型列表]` → GET `/models` → 下拉）· `代理地址`（说明：留空走 Vite dev proxy `/llm`；生产需自备反代）· temperature / top_p / max_tokens / presence·frequency penalty（CbxSlider）· 流式开关 · `[测试连接]` → `.cbx-badge--success/--error`。

**② 提示词与深度**
主系统提示词 · 后置指令(jailbreak) · **1v1 约束提示词** + **插入深度**（number，默认 0）· **1vN 约束提示词** + **插入深度**（默认 0）· 演绎 nudge 模板（默认 `[Write the next reply only as {{char}}.]`）· 新演绎开场模板 · 上下文消息上限 / token 预算。

**深度语义可视化 `DepthPreview.vue`**（关键 UX：depth 概念极易误解）

```vue
<script setup lang="ts">
const props = defineProps<{ depth: number }>()
// depth = N 表示插到"倒数第 N 条之前"；0 = 追加到最末尾（离生成最近）
const fake = ['…较早消息', '用户：你好', '{{char}}：你好呀', '用户：在吗']
const slot = computed(() => fake.length - Math.min(props.depth, fake.length))
</script>
<template>
  <div class="dp">
    <template v-for="(m, i) in fake" :key="i">
      <div v-if="i === slot" class="dp__inject">⬅ 约束提示词插在这里</div>
      <div class="dp__msg">{{ m }}</div>
    </template>
    <div v-if="slot >= fake.length" class="dp__inject">⬅ 约束提示词插在这里</div>
    <div class="dp__msg dp__msg--gen">（模型开始生成）</div>
  </div>
</template>
```

**③ 世界书**
全局启用的书（多选 chips，与 `/worlds` 的开关双向同步）· 扫描深度 `world_info_depth`(默认 2) · 预算 `budget %`(25) + `budget cap`(0=不限) · `min_activations`(0) + `min_activations_depth_max`(0) · 递归开关 `recursive` + `max_recursion_steps`(0=不限) · `include_names` · `case_sensitive` · `match_whole_words` · `use_group_scoring` · `overflow_alert` · 插入策略 `character_strategy`（均匀 / 角色优先 / 全局优先，默认角色优先）。每项右侧一个 `ⓘ` tooltip 给一句人话。

**④ 用户身份**
用户名（= `{{user}}` 的值）· 用户头像 · persona 描述 · persona 插入位置/深度。

**⑤ 外观**
主题 `CbxSegmented` 浅色/深色/跟随系统 · 消息最大宽度（滑块 640–1080，写入 `--cbx-read-w`）· 正文字号 · Markdown 渲染开关 · 显示 token 计数 · 显示时间戳。

**⑥ 数据**
`navigator.storage.estimate()` 用量条 · 导出全部（JSON）· 导入 · 清空（双重确认，要求输入「删除」二字）。

---

## 7. 通用组件清单与实现要点

### 7.1 组件一览

| 组件 | 关键 API / 要点 |
|---|---|
| `CbxModal` | `Teleport to="body"`；props `title` `wide` `sheet`；Esc 关闭、scrim 点击关闭、`inert` 焦点陷阱、打开时 `document.body.style.overflow='hidden'`；**<768px 自动变底部 sheet**（`align-items:flex-end`，上圆角，`padding-bottom: var(--cbx-safe-b)`） |
| `CbxSheet` | 底部动作面板，一列 44px 按钮 + 取消 |
| `CbxConfirmHost` + `useConfirm()` | `confirm(msg, { okText, danger }) => Promise<boolean>`（单例 promise resolver） |
| `CbxToastHost` + `useToast()` | 队列 + 4s 自动消失，`bottom: calc(space-4 + var(--cbx-safe-b))`，`transition-group` |
| `CbxTabs` | `v-model` 当前 key，slots 为 `CbxTabPanel`；移动端 `overflow-x:auto` 横滑 |
| `CbxCollapse` | `v-model:open`，head 44px；`--modified` 时 head 右侧一个 6px 品牌色点 |
| `CbxSwitch` / `CbxSlider` / `CbxSelect` | 纯样式包装 + `defineModel` |
| `CbxField` | `label` `hint` `error` + default slot；`--row` 响应式两列/单列 |
| `CbxTextarea` | 自增高、`maxHeight`、`autoFocus`、`defineModel<string>()` |
| `CbxTagInput` | chips + 输入框；Enter/逗号提交，Backspace 删末尾；`validate?: (v)=>string\|null` 用于正则关键词校验 |
| `CbxTriState` / `CbxNullableNumber` | 见 §4.2 |
| `CbxAvatar` | props `src`(assetId 或 url) `name` `size`；`useBlobUrl` 解析 IndexedDB Blob，失败回退首字母 |
| `CbxEmpty` / `CbxSpinner` / `TypingDots` | 纯展示 |
| `CbxImageCropper` | 见 §3.4 |
| `CbxSortable` | `v-model:items`，桌面 pointer 拖拽 + 移动端上下按钮 |
| `CharacterPicker` | 多选角色 modal，搜索 + 网格 |

### 7.2 `CbxModal.vue` 骨架

```vue
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
withDefaults(defineProps<{ title?: string; wide?: boolean }>(), { wide: false })
const emit = defineEmits<{ close: [] }>()

function onKey(e: KeyboardEvent) { if (e.key === 'Escape') emit('close') }
onMounted(() => {
  document.addEventListener('keydown', onKey)
  document.body.style.overflow = 'hidden'
})
onUnmounted(() => {
  document.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <div class="cbx-modal__scrim" @click.self="emit('close')">
      <div class="cbx-modal" :class="{ 'cbx-modal--wide': wide }" role="dialog" aria-modal="true">
        <header class="cbx-modal__head">
          <h3>{{ title }}</h3>
          <button class="cbx-icon-btn" aria-label="关闭" @click="emit('close')">✕</button>
        </header>
        <div class="cbx-modal__body cbx-scroll"><slot /></div>
        <footer v-if="$slots.foot" class="cbx-modal__foot"><slot name="foot" /></footer>
      </div>
    </div>
  </Teleport>
</template>
```

base.css：
```css
.cbx-modal__scrim { position: fixed; inset: 0; z-index: 100; background: var(--cbx-bg-mask);
  display: flex; align-items: center; justify-content: center; padding: var(--cbx-space-4); }
.cbx-modal { display: flex; flex-direction: column; width: 100%; max-width: 520px; max-height: 88vh;
  background: var(--cbx-bg); border-radius: var(--cbx-radius-lg); box-shadow: var(--cbx-shadow-lg); overflow: hidden; }
.cbx-modal--wide { max-width: 880px; }
.cbx-modal__head { display: flex; align-items: center; justify-content: space-between;
  padding: var(--cbx-space-4); border-bottom: 1px solid var(--cbx-border); }
.cbx-modal__body { padding: var(--cbx-space-4); }
.cbx-modal__foot { display: flex; gap: var(--cbx-space-2); justify-content: flex-end;
  padding: var(--cbx-space-3) var(--cbx-space-4); border-top: 1px solid var(--cbx-border); }

@media (max-width: 767px) {
  .cbx-modal__scrim { padding: 0; align-items: flex-end; }
  .cbx-modal { max-width: 100%; max-height: 92vh;
    border-radius: var(--cbx-radius-lg) var(--cbx-radius-lg) 0 0;
    padding-bottom: var(--cbx-safe-b); }
  .cbx-modal__foot .cbx-btn { flex: 1; }
}
```

### 7.3 `useBreakpoint.ts`（不引 @vueuse）

```ts
import { ref, onMounted, onUnmounted } from 'vue'

export function useBreakpoint() {
  const isMobile = ref(false)
  const isTouch = ref(false)
  const mqMobile = window.matchMedia('(max-width: 767px)')
  const mqTouch = window.matchMedia('(pointer: coarse)')
  const sync = () => { isMobile.value = mqMobile.matches; isTouch.value = mqTouch.matches }
  sync()
  onMounted(() => { mqMobile.addEventListener('change', sync); mqTouch.addEventListener('change', sync) })
  onUnmounted(() => { mqMobile.removeEventListener('change', sync); mqTouch.removeEventListener('change', sync) })
  return { isMobile, isTouch }
}
```

---

## 8. 移动端适配总表

| 场景 | 具体写法 |
|---|---|
| 断点 | 统一 `@media (max-width: 767px)`；结构性切换用 `useBreakpoint().isMobile` |
| 侧栏 | `position:fixed; inset:0 auto 0 0; transform:translateX(-100%)` + `.sidebar--open`；`.scrim` 用 `--cbx-bg-mask`；路由变化自动关 |
| 触控目标 | 所有可点元素 ≥ `var(--cbx-tap-min)`；`base.css` 已自动放大 `.cbx-btn/.cbx-input/.cbx-nav-item`，新增的 `.cbx-icon-btn/.cbx-switch/.cbx-chip/.cbx-tab` 也要在同一个 media block 里放大 |
| 输入字号 | 所有 `input/textarea` 移动端 `font-size: var(--cbx-fs-md)`（16px）防 iOS 聚焦缩放 |
| 安全区 | composer、modal sheet、toast、sidebar、全屏图谱：`padding-bottom: max(<n>, var(--cbx-safe-b))`；topbar `padding-top: env(safe-area-inset-top, 0px)` |
| 视口高度 | `.shell { height: 100%; height: 100dvh }`；键盘弹出监听 `window.visualViewport` 的 resize → `scrollToBottom()` |
| 滚动 | 所有滚动容器 `.cbx-scroll`（含 `min-height:0`，flex 子项必须，否则不滚） |
| 手势 | 图谱/裁剪画布 `touch-action:none` + `overscroll-behavior:contain`；`@media (hover:none)` 里把 hover-only 的操作条改成常显 0.55 透明度或长按 sheet |
| 多列 → 单列 | 世界书三栏 → 路由深度单栏；角色网格 `repeat(auto-fill, minmax(150px,1fr))`；`.cbx-field--row` 退回堆叠 |
| 模态 | `CbxModal` 自动变底部 sheet；底部按钮 `flex:1` 撑满 |

---

## 9. 页面 ↔ 组件依赖矩阵（实现顺序参考）

| 层 | 产物 | 被谁依赖 |
|---|---|---|
| L0 | tokens 补充 + base.css 新类 | 全部 |
| L1 | `stores/ui.ts`、`useBreakpoint/useToast/useConfirm/useBlobUrl/useAutosize/useAutoScroll/useLongPress` | 全部 |
| L2 | `CbxModal/CbxSheet/CbxToastHost/CbxConfirmHost/CbxTextarea/CbxField/CbxSwitch/CbxSelect/CbxSlider/CbxTabs/CbxCollapse/CbxAvatar/CbxEmpty/CbxSpinner/CbxTagInput/CbxSegmented` | L3+ |
| L3 | `App.vue` / `AppSidebar` / `AppTopbar` / 路由 | 全部页面 |
| L4 | 聊天页全套（1v1） | — |
| L5 | 角色页全套 + `CbxImageCropper` | 聊天页 |
| L6 | 世界书页 + `CbxTriState/CbxNullableNumber` | 角色页 |
| L7 | 演绎页 + `RelationGraph` + `graphGeometry.ts` | 聊天页(1vN) |
| L8 | 设置页 + `DepthPreview` | — |

## FILES
- `assets/styles/tokens.css` — 新增气泡/代码块/8 色角色区分/布局 token（--cbx-bubble-*, --cbx-char-1..8, --cbx-topbar-h, --cbx-read-w, --cbx-safe-b），并补齐暗色下缺失的 --cbx-gray-4/-5  
  reuse: 改编：D:/tauriApp/nationalProducers/src/assets/styles/tokens.css（现有文件，注意 dark 声明块重复了 2 处，新 token 必须写 3 遍）
- `assets/styles/base.css` — 新增 .cbx-textarea/.cbx-avatar/.cbx-bubble/.cbx-md/.cbx-modal/.cbx-sheet/.cbx-toast/.cbx-empty/.cbx-spinner/.cbx-typing/.cbx-tabs/.cbx-collapse/.cbx-switch/.cbx-slider/.cbx-select/.cbx-field/.cbx-chip/.cbx-seg/.cbx-icon-btn/.cbx-scroll/.cbx-safe-b，并在 <768px block 内放大新控件到 44px  
  reuse: 改编：D:/tauriApp/nationalProducers/src/assets/styles/base.css（沿用其 BEM-ish 命名与 focus 环配方）
- `App.vue` — 改造成聊天应用外壳：.shell + .scrim + AppSidebar + main>RouterView + Toast/Confirm/NewChat 宿主；主题与抽屉状态抬到 ui store；height:100dvh  
  reuse: 改编：D:/tauriApp/nationalProducers/src/App.vue（.shell/.scrim/.main 布局与移动端抽屉 CSS 逐字沿用，删掉展示用卡片网格）
- `components/layout/AppSidebar.vue` — 会话列表侧栏：新建对话按钮、搜索、按日期分组的会话列表、底部导航（角色/世界书/设置）与主题切换；<768px 离屏抽屉  
  reuse: 改编：D:/tauriApp/nationalProducers/src/App.vue 的 aside.sidebar 结构与 @media(max-width:767px) 抽屉块
- `components/layout/AppTopbar.vue` — 统一顶栏：汉堡（<768px）/返回箭头、标题、actions 插槽；安全区顶部内边距  
  reuse: 改编：D:/tauriApp/nationalProducers/src/App.vue 的 header.topbar + .menu-btn
- `stores/ui.ts` — setup 式 Pinia：theme(applyTheme/initTheme/localStorage 'cbx-theme')、drawerOpen、newChatOpen、sessionPanelOpen  
  reuse: 改编：D:/tauriApp/nationalProducers/src/App.vue 的 applyTheme/toggleTheme/onMounted 主题逻辑（逐字搬进 store）
- `router/index.ts` — 填充路由：/chat/:id、/characters(/:id|new)、/groups(/:id|new)、/worlds/:bookId?/:uid?、/settings，全部 lazy import  
  reuse: 改编：D:/tauriApp/nationalProducers/src/router/index.ts（routes 当前为空数组）
- `composables/useBreakpoint.ts` — matchMedia('(max-width:767px)') 与 '(pointer:coarse)'，驱动结构性切换（抽屉/底部 sheet/图谱默认 Tab）  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/composables/useBreakpoint.ts（原版依赖 @vueuse，这里手写 matchMedia，断点改 767）
- `composables/useAutosize.ts` — textarea 自增高（height:auto→scrollHeight，clamp 到 maxHeight，超出才开 overflow-y）  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/components/chat/Composer.vue 的 autosize() 函数（抽成 composable）
- `composables/useAutoScroll.ts` — 消息列表贴底：真实用户手势（wheel/touchmove）解除吸附，程序滚动 150ms 抑制窗口  
  reuse: 逐字：D:/tauriApp/sillyTavernTauri/src/composables/useAutoScroll.ts
- `composables/useMarkdown.ts` — markdown-it + DOMPurify 渲染 LLM 输出（html:false, linkify, breaks）  
  reuse: 逐字：D:/tauriApp/sillyTavernTauri/src/composables/useMarkdown.ts（去掉 highlight.js 依赖或保留，看是否引入）
- `composables/useToast.ts` — 全局 toast 队列（4s 自动消失）  
  reuse: 逐字：D:/tauriApp/sillyTavernTauri/src/composables/useToast.ts
- `composables/useConfirm.ts` — 单例 promise 确认对话框（所有破坏性操作走它）  
  reuse: 逐字：D:/tauriApp/sillyTavernTauri/src/composables/useConfirm.ts
- `composables/useBlobUrl.ts` — IndexedDB Blob → objectURL 的集中缓存与引用计数，卸载时 revoke（防内存泄漏）  
  reuse: new
- `composables/useLongPress.ts` — 移动端长按 500ms 打开消息/节点动作面板（pointerdown+定时器+移动阈值取消）  
  reuse: new
- `components/ui/CbxModal.vue` — Teleport 模态：Esc/scrim 关闭、body 锁滚、<768px 自动变底部 sheet 并留安全区  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/components/overlays/Modal.vue（结构照抄，CSS 全部换成 --cbx-*，断点 639→767）
- `components/ui/CbxToastHost.vue` — toast 渲染宿主，bottom 计入 safe-area  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/components/overlays/Toast.vue
- `components/ui/CbxConfirmHost.vue` — 确认框宿主  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/components/overlays/ConfirmDialog.vue
- `components/ui/CbxTextarea.vue` — 自增高多行输入（.cbx-input 是固定 36px 单行，必须新写）；defineModel<string>、maxHeight、autoFocus  
  reuse: new（自增高算法来自 sillyTavernTauri Composer.vue）
- `components/ui/CbxTagInput.vue` — 关键词/标签 chips 输入：Enter 或逗号提交、Backspace 删末尾、可选 validate（校验 /regex/flags）  
  reuse: new
- `components/ui/CbxTriState.vue` — 世界书三态字段（继承/是/否 → null/true/false）：caseSensitive、matchWholeWords、useGroupScoring  
  reuse: new
- `components/ui/CbxNullableNumber.vue` — 开关+数字组合（关=null）：scanDepth、sticky、cooldown、delay、delayUntilRecursion  
  reuse: new
- `components/ui/CbxTabs.vue` — 下划线式标签页，移动端横向可滑  
  reuse: new
- `components/ui/CbxCollapse.vue` — 折叠面板，head 44px，支持 --modified 小圆点提示该组有非默认值  
  reuse: new
- `components/ui/CbxAvatar.vue` — 头像组件：assetId→blob url 解析、首字母兜底、size 变体、圆形/2:3 卡面两种  
  reuse: new
- `components/ui/CbxImageCropper.vue` — 角色图片裁剪：pointer 平移 + 双指/滚轮缩放 + 2:3 遮罩框，canvas 输出 400x600 卡面 Blob 与 96x96 缩略图 Blob  
  reuse: new
- `views/ChatView.vue` — 1v1/1vN 共用聊天页：Topbar + MessageList + (手动策略时)SpeakerTray + Composer；无会话时空态  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/views/ChatView.vue（结构参考，样式重写）
- `components/chat/MessageList.vue` — 滚动容器 + 自动贴底 + 会话内搜索 + 首屏/切换会话强制滚底；流式时 600ms 节奏跟随  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/components/chat/MessageList.vue（逻辑近乎逐字，CSS 换 token）
- `components/chat/MessageBubble.vue` — 用户/AI/系统三种气泡、1vN 头像+名字+8 色左边框、内联编辑、swipe 左右切换、hover 操作条、移动端长按动作面板  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/components/chat/MessageBubble.vue（结构与 swipe/编辑逻辑参考；删除 TTS/翻译/表情包分支，CSS 全换 --cbx-*）
- `components/chat/MarkdownBody.vue` — 流式期间 100ms 节流渲染 markdown，结束立即终态渲染；.cbx-md--streaming 末尾闪烁光标  
  reuse: new（renderMarkdown 复用 useMarkdown）
- `components/chat/ChatComposer.vue` — 自增高多行输入 + 发送/停止按钮；桌面 Enter 发送、移动端 Enter 换行；padding-bottom 计入 env(safe-area-inset-bottom)；移动端字号 16px  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/components/chat/Composer.vue（autosize/send/keydown 逻辑参考，CSS 重写，去掉 impersonate/slash/token 计）
- `components/chat/GroupSpeakerTray.vue` — 1vN 手动策略下的点名条：横滑头像行，点击 = 让该角色发言（对应 force_chid）  
  reuse: 参考：D:/tauriApp/sillyTavernTauri/src/components/chat/GroupBar.vue
- `components/chat/NewChatSheet.vue` — 新建对话：1v1 选角色 / 1vN 选群组或新建群组  
  reuse: new
- `views/CharacterListView.vue` — 角色/群组两个 Tab；角色卡网格（2:3 卡面 + 名字 + 标签 + 开始聊天 + ⋯ 菜单）；移动端 2 列  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/views/CharactersView.vue
- `views/CharacterEditView.vue` — 角色编辑：基本/开场白/对话示例/高级四个 Tab；头像裁剪、description/personality/scenario、depth_prompt、talkativeness、角色世界书关联；宏插入辅助条  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/views/CharacterEditView.vue（字段清单与保存流程参考；开场白与示例对话编辑器全部重写）
- `components/character/GreetingsEditor.vue` — 多条开场白增删改排序（greetings[] ⇄ first_mes + alternate_greetings），带宏预览  
  reuse: new（sillyTavernTauri 只是 textarea 列表，本设计升级为卡片+排序+预览）
- `components/character/ExampleDialogueEditor.vue` — mes_example 的 <START> 分块可视化编辑器：块/轮次结构化编辑 + 源码模式互转 + 无法解析的块原样保留  
  reuse: new
- `utils/mesExample.ts` — parseMesExample / serializeMesExample：<START> 分块、{{user}}/{{char}} 前缀识别、多行续接、orphan 降级 raw  
  reuse: new（规格来自 03-char-macros.md §3 的 parseMesExamples）
- `views/WorldBooksView.vue` — 世界书三栏（书列表/条目列表/条目编辑器），由 /worlds/:bookId?/:uid? 三级路由驱动；<768px 只渲染最深一栏 + 返回  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/views/WorldInfoView.vue（书/条目 CRUD 与导入导出流程参考；字段仅为子集，需补全到 40+）
- `components/world/WiEntryEditor.vue` — 条目编辑器：基础区常驻 + 匹配扫描/递归/概率预算/包含组/定时效果/触发类型/角色过滤/其它 8 个折叠区；移动端全单列、底部 sticky 保存栏  
  reuse: new（字段与默认值来自 01-wi-model.md §1.1，位置枚举来自 02-wi-positions.md §1）
- `components/world/WiEntryRow.vue` — 条目列表行：开关 + 标题/关键词摘要 + 触发模式徽标 + 位置徽标 + order + 拖拽把手  
  reuse: new
- `views/GroupEditView.vue` — 演绎创建/编辑：成员(排序/静音/移除)、关系(图谱|列表)、策略(activation_strategy/generation_mode/join 前后缀/auto_mode_delay/allow_self_responses)  
  reuse: new（枚举与语义来自 04-group.md §1-2）
- `components/group/RelationGraph.vue` — SVG 可拖拽关系图谱：无 viewBox 的像素坐标系 + translate/scale 视图组、pointer 状态机(node/pan/link/pinch)、rAF 节流、touch-action:none、marker 箭头、二次贝塞尔双向弯边、透明粗描边命中、圆周布局与适应画布、全屏模式  
  reuse: new
- `utils/graphGeometry.ts` — edgeGeometry(a,b,bowSign) 返回裁到节点圆外的 Q 路径与 t=0.5 标签点；bowSignOf 让 A→B 与 B→A 向两侧弯开；hitTestNode 半径命中  
  reuse: new
- `components/group/RelationList.vue` — 关系的列表视图（移动端默认、无障碍兜底）：A → B ：关系名/描述 + 编辑/删除/交换方向  
  reuse: new
- `components/group/RelationEditModal.vue` — 关系编辑弹窗：起终点 + 交换方向、关系名(含快捷 chips)、描述、删除；校验 from!==to 与同向去重  
  reuse: new
- `views/SettingsView.vue` — 全局配置：模型服务/提示词与深度/世界书全局参数/用户身份/外观/数据六节折叠，桌面带锚点导航  
  reuse: 改编：D:/tauriApp/sillyTavernTauri/src/views/SettingsView.vue 与 components/settings/ProvidersPane.vue（分节组织参考）
- `components/settings/DepthPreview.vue` — 插入深度语义可视化：用 4 条假消息演示 depth=N 落在倒数第 N 条之前、0 = 贴着生成位置  
  reuse: new
- `utils/charAccent.ts` — characterId → 'char-a'..'char-h' 类名（哈希 %8），配合 --cbx-char-1..8 token，禁止组件内写死颜色  
  reuse: new

## RISKS
## 最容易出错 / 被低估的 8 个点

**1. `.cbx-input` 固定 36px 会被误复用到多行场景**
`.cbx-input` 有 `height:36px`，任何 `<textarea class="cbx-input">` 都会被压成单行且内容不可见。必须新建 `.cbx-textarea`（无 height、有 min-height）。规避：base.css 里在 `.cbx-input` 上方写注释「仅单行，多行用 .cbx-textarea」；code review 时 grep `textarea class="cbx-input"`。

**2. flex 滚动容器忘写 `min-height:0`**
`.shell`→`.main`→`MessageList` 三层 flex，任一层缺 `min-height:0`（或 `min-width:0`）都会让消息列表撑破视口、composer 被挤出屏幕，而且**只在内容变长后才暴露**。规避：把 `min-height:0` 固化进 `.cbx-scroll`，并让 `.main` 保留原 App.vue 的 `min-width:0`。

**3. 图谱手势被浏览器抢走**
不写 `touch-action:none` 时，移动端拖节点会变成页面滚动、双指变成系统缩放，且**桌面调试完全发现不了**。另外 `pointercancel` 必须和 `pointerup` 走同一处理（iOS 会在系统手势介入时发 cancel），否则拖拽状态卡死。规避：真机（iOS Safari + Android Chrome）过一遍；`@pointercancel="onPointerUp"` 与 `@pointerup` 同绑。

**4. SVG marker 无法跟随引用它的线着色**
`context-stroke` 兼容性不齐，选中态箭头会保持灰色。规避：定义两个 marker id（`rg-arrow` / `rg-arrow-on`），用计算属性切 `marker-end`。同理 `markerUnits` 必须是 `userSpaceOnUse`，否则箭头大小会被 `stroke-width` 放大。

**5. Blob objectURL 泄漏**
角色头像存 IndexedDB Blob，若在组件里散写 `URL.createObjectURL`，切换会话/滚动长列表会持续泄漏几十上百 MB。规避：**只允许通过 `useBlobUrl(assetId)` 取 URL**，内部 Map 引用计数，refs 归零才 revoke；`CbxAvatar` 是唯一显示入口。

**6. 流式渲染卡顿**
每个 token 都跑 markdown-it + DOMPurify + `v-html`，长回复在移动端会掉到个位数帧率，还会打断用户选中文本。规避：`MarkdownBody` 100ms 节流；`MessageList` 的跟随滚动 600ms 节流；流式期间不重建整棵列表（`:key` 用消息 id，别用 index）。

**7. 世界书条目 40+ 字段一次全铺 → 不可用**
尤其移动端。规避：严格执行「基础区 7 项常驻 + 8 个折叠区」的分层；折叠 head 带「已修改」圆点，否则用户会忘记自己改过 `preventRecursion` 之类的隐藏开关而调试半天。三态字段一律用 `CbxTriState` 显式展示「继承」，绝不用 checkbox 冒充（checkbox 无法表达 null，会把 null 静默写成 false，破坏「继承全局」语义并污染导出的 ST 世界书）。

**8. 新增 token 只写了一处 dark 块**
tokens.css 的暗色声明**重复了两份**（`[data-theme="dark"]` 与 `prefers-color-scheme` 媒体查询）。只改一处的结果是「手动切暗色正常、跟随系统暗色错乱」，测试时极易漏。规避：每次加**颜色/阴影** token 都 3 处同步；长期建议把两块合并为一个 `@mixin` 式的共享类，但那属于重构，不在本期范围。

> 已核实的边界：这条**只约束有明暗变体的颜色/阴影 token**。两个暗色块内不含任何尺寸/间距/字号/圆角 token，
> 因此**纯尺寸 token 只写 `:root` 一处**；把它们复制进暗色块只会产生一堆主题无关的重复声明。

**次要但会返工的**：`noUncheckedIndexedAccess` 下 `nodes.value.find(...)` 返回 `T|undefined`、`pointers` 取 `[...map.values()][0]` 也是 `undefined`，图谱代码里到处需要早返回守卫；`CbxModal` 打开时锁 `body.overflow` 必须在 `onUnmounted` 还原，多层模态叠加时要用计数器而非布尔，否则关掉内层模态会解锁整页滚动。

## PHASING
## 与「分阶段先跑通 1v1」的对齐

### 阶段 0 · 底座（半天，无可见产出但全员阻塞项）
- tokens.css 补 token（3 处 dark 同步）+ base.css 新增 `.cbx-textarea` / `.cbx-scroll` / `.cbx-bubble` / `.cbx-md` / `.cbx-modal` / `.cbx-icon-btn` / `.cbx-empty` / `.cbx-typing` / `.cbx-safe-b`。
- `stores/ui.ts`（主题从 App.vue 抬出）+ `useBreakpoint` / `useToast` / `useConfirm` / `useAutosize`。
- `App.vue` 改造 + `AppSidebar` + `AppTopbar` + 路由骨架（先只挂 `/chat`、`/settings` 两条，其余留空占位）。
- 验收：`npm run type-check` 通过，浅/暗色切换正常，移动端抽屉可开关。

### 阶段 1 · 1v1 聊天闭环（本期主线）
按依赖顺序：`CbxTextarea` → `ChatComposer` → `MarkdownBody`(+ markdown-it/dompurify) → `MessageBubble`(先只做用户/AI 两种气泡 + 流式 + 复制) → `MessageList`(+ useAutoScroll) → `ChatView`。
- **本阶段先不做**：swipe 条、编辑/删除、长按 sheet、1vN 相关的头像+名字+8 色边框（但 CSS class 先留好钩子，避免二次改结构）。
- 同时做**设置页的「模型服务」一节**（baseURL/key/model/代理/测试连接），否则聊天页无法真跑。
- 验收：桌面 + 手机浏览器各发一条消息，看到流式打字、Markdown 渲染、贴底滚动、键盘弹出时 composer 不被遮挡。

### 阶段 2 · 角色（让 1v1 有内容）
`CbxModal` / `CbxTabs` / `CbxField` / `CbxTagInput` / `CbxAvatar` → `CharacterListView` → `CharacterEditView`（基本 Tab 先行）→ `GreetingsEditor` → `ExampleDialogueEditor` + `utils/mesExample.ts` → `CbxImageCropper`（最后做，前期先用「直接上传原图 + object-fit:cover」兜底，不阻塞主线）。
- 同步把 `MessageBubble` 补上头像与 swipe 条（开场白多条 → 首条消息即有 swipes，此时才有东西可切）。
- 验收：创建角色 → 新对话随机命中某条开场白 → 可左右切换全部开场白。

### 阶段 3 · 世界书 UI
`CbxCollapse` / `CbxSwitch` / `CbxSlider` / `CbxTriState` / `CbxNullableNumber` → `WorldBooksView` 三栏路由 → `WiEntryRow` → `WiEntryEditor`（基础区 → 折叠区逐组补齐）→ 设置页「世界书」一节的全局参数。
- 可与引擎侧并行：UI 先按完整 40+ 字段落地，引擎实现到哪一档，UI 就已经能填。

### 阶段 4 · 1vN 与关系图谱
`GroupEditView`(成员/策略两个 Tab) → `RelationList`（**先列表后画布**，列表就能让功能可用并解锁提示词联调）→ `utils/graphGeometry.ts` → `RelationGraph` → `RelationEditModal` → `GroupSpeakerTray` → `MessageBubble` 的 1vN 分支（名字/8 色边框）。
- 图谱是纯增强项，把它排在列表之后，可以保证即使画布在真机上遇到手势坑，1vN 功能本身不被阻塞。

### 阶段 5 · 打磨
移动端长按动作 sheet、消息编辑/删除/分支、设置页「提示词与深度」+ `DepthPreview`、外观与数据两节、空态/骨架屏/错误态、`CbxSortable` 拖拽排序、全屏图谱。

**每阶段结束固定动作**：`npm run type-check` + `npm run format`，再用 Chrome DevTools 设备模拟（iPhone SE 375px 与 iPad 768px 两档）跑一遍，最后真机验证一次触控与安全区。