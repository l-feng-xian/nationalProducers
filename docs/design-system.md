# 设计规范 —— Chatbox 风格

本项目 UI 复刻 [ChatboxAI](https://web.chatboxai.app/guide) 的视觉语言。其底层为 **Mantine 定制 `chatbox` 调色板**，我们抽取成原生 CSS 变量落在 `src/assets/styles/tokens.css`。

## 一句话风格

> 干净、留白、扁平。白/浅灰双层背景，**单一蓝色品牌点缀**，圆润大圆角（默认 16px），细描边 + 低透明度分层软阴影。**无玻璃拟态、无重边框、无渐变**。

## 核心令牌（引用，勿写死色值）

| 类别 | 令牌 | 亮色值 |
|---|---|---|
| 品牌主色 | `--cbx-brand` | `#228be6` |
| 品牌 hover | `--cbx-brand-hover` | `#1e7ac9` |
| 主背景 | `--cbx-bg` | `#ffffff` |
| 次背景（侧栏） | `--cbx-bg-secondary` | `#f3f3f3` |
| hover 底 | `--cbx-bg-hover` | `#f8f9fa` |
| 主文字 | `--cbx-text` | `#212529` |
| 次要文字 | `--cbx-text-secondary` | `#495057` |
| 说明/图标 | `--cbx-text-tertiary` | `#868e96` |
| 描边 | `--cbx-border` | `#dee2e6` |
| 输入描边 | `--cbx-border-strong` | `#ced4da` |
| 成功/警告/错误 | `--cbx-success` / `--cbx-warning` / `--cbx-error` | `#12b886` / `#fab005` / `#fa5252` |

圆角 `--cbx-radius-{xs..xxl}` = 2/4/8/16/24/32px，**组件默认用 `lg`(16px)**。
阴影 `--cbx-shadow-{xs..xl}`；间距 `--cbx-space-{1..10}`（4px 基准）。
字号 `--cbx-fs-sm`(14, 控件) / `--cbx-fs-md`(16, 正文) / `--cbx-fs-h1`(24)。

## 用法约定

1. **只用语义令牌** `var(--cbx-*)`，不要在组件里写 `#228be6` 之类的裸色值。
2. 通用类（`.cbx-btn`、`.cbx-card`、`.cbx-input`、`.cbx-nav-item`、`.cbx-badge`…）见 `base.css`，可直接套用或作为 Vue 组件样式范式。
3. **按钮**：主操作 `--primary`（实心蓝）；次操作 `--soft`（浅蓝底蓝字，即 Chatbox 的 New Chat）；工具/图标 `--ghost`。
4. **卡片**：默认细描边 `.cbx-card`；需要强调/浮层时用 `.cbx-card--raised`（去边框换 `shadow-md`）。
5. **层级**：主区 `--cbx-bg` 白，侧栏/次级面板 `--cbx-bg-secondary` 浅灰，二者用 `--cbx-border` 分隔。
6. **文字层级**靠颜色区分：标题/正文 `--cbx-text`、辅助 `--cbx-text-secondary`、弱化 `--cbx-text-tertiary`。

## 移动端兼容（必须遵守）

本项目**必须兼容移动端**，按响应式/移动优先开发：

- **断点**（Mantine 默认）：xs 576 · **sm 768** · md 992 · lg 1200 · xl 1408px。**以 768px 为桌面/移动分界**。
- **布局**：桌面侧栏固定 `--cbx-sidebar-w`(240px)；< 768px 时侧栏改为**离屏抽屉**（`position:fixed` + `translateX` + 遮罩 `--cbx-bg-mask`），顶栏出汉堡按钮。内容多列网格在移动端降为单列。参考 `App.vue`。
- **触控目标**：移动端控件最小 `--cbx-tap-min`(44px)。`base.css` 已在 `@media (max-width:767px)` 自动放大 `.cbx-btn/.cbx-input/.cbx-nav-item`。
- **输入框**：移动端字号 ≥16px（`--cbx-fs-md`）防止 iOS 聚焦自动缩放（已内置）。
- **安全区**：`index.html` 已开启 `viewport-fit=cover`；贴边固定元素用 `env(safe-area-inset-*)` 留刘海/底部条空间。
- **单位**：优先 `%`/`flex`/`grid` + `max-width:100%`，避免写死像素宽导致移动端横向溢出。

## 明暗主题

- 在 `<html>` 上写 `data-theme="light|dark"` 手动切换；不写则跟随系统 `prefers-color-scheme`。
- 暗色下品牌色提亮一档（`#339af0`），背景走 Mantine dark 阶（`#242424` / `#1f1f1f` / `#2e2e2e`）。
- 切换逻辑参考 `App.vue` 的 `applyTheme`（含 localStorage 记忆）。
