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

## 内容宽度：阅读宽 ≠ 表单宽

两类内容对宽度的诉求相反，用两个令牌分开，**不要互相借用**：

| 令牌 | 值 | 管什么 | 消费点 |
|---|---|---|---|
| `--cbx-read-w` | 820px | **长文本的行长**：聊天气泡 / 消息流 / 输入条，以及表单里的 `textarea` 与说明段落 | `ChatView .stream` · `ChatComposer .inner` · `.cbx-form-col .cbx-textarea` · `.note` |
| `--cbx-form-w` | 1280px | **表单内容列**的上限 | `.cbx-form-col`（设置 / 角色编辑 / 群聊编辑） |

`ChatView .stream` 与 `ChatComposer .inner` 必须始终同值，否则聊天页输入框与消息流左右错位
——所以**永远不要为了修表单去调 `--cbx-read-w` 的值**。

## 表单宽度（内容感知）

表单页的内容列一律套 `.cbx-form-col`（定义在 `base.css`），**左对齐，不写 `margin: 0 auto`**。
左对齐后列的左缘恰好等于滚动区的 `padding-left`，与 `AppTopbar` 的 `padding-left`
（同为 `space-5`，移动端同为 `space-3`）相等，页面标题与卡片左缘严格对齐；
一旦居中就会出现 246px 的标题错位（820 居中时卡片左缘 506 vs 标题左缘 260）。

控件宽度只有 4 档，定义在 `tokens.css`，是**封闭词表**——新字段必须归入其中一档，不允许现场写新宽度：

| 档 | 令牌 | 值 | 用于 | 怎么用 |
|---|---|---|---|---|
| num | `--cbx-fieldw-num` | 120px | 数字、百分比、深度、轮数 | **自动**，无需写 class |
| sm | `--cbx-fieldw-sm` | 240px | 短枚举 `select`、人名、版本号 | `select` **自动**；文本写 `.cbx-field--sm` |
| md | `--cbx-fieldw-md` | 400px | 模型名、标识符、组名 | `.cbx-field--md` |
| lg | `--cbx-fieldw-lg` | 620px | URL、API Key、路径 | `.cbx-field--lg` |

> ⚠ 命名是 `fieldw-` 不是 `fw-`：`--cbx-fw-*` 已经是**字重**命名空间（`--cbx-fw-medium: 500`）。
> 两者混在一起会造出 `--cbx-fw-md: 400px` 与 `--cbx-fw-medium: 500` 并排的陷阱，写错时 CSS 不报错、只静默失效。

- **档位只作用于控件**，字段行本身始终占满所在轨道。于是同一列里所有 label 的左缘对齐在同一条竖线上，
  右缘按内容分 4 级；长 label（如「扫描深度（往回看几条消息）」182px）也不会被窄控件逼得折行。
- `input[type=number]` 与 `select` **自动兜底**（这两类的内容长度由 type 本身封顶，是唯一可以隐式的情况），
  忘记标档也不会被拉宽；`min()` 保证标了 `--lg` 的数字框依然是 num 宽。
  **其余文本字段必须显式标档**——`type="text"` 说明不了内容长短，「你的名字」和「baseURL」都是 text。
- 一律只写 `max-width`，**绝不写死 `width`**（呼应上面的「单位」条）。`< 768px` 由 `base.css` 的移动端块整体解除，
  回到单列满宽；唯一保留的是数字框的 120px（≫ 44px 触控下限，高度与字号不受影响）。
- 输入框 + 紧邻图标按钮用 `.cbx-ctl` 包一层，让整行作为一个整体受档位约束。
- `.cbx-textarea` **不参与档位**，由 `--cbx-read-w` 封顶——多行文本要的是行长可读性。
- 布尔开关不进字段网格，进 `.switchrow`：它的「内容宽度」就是 40×22 的 track，不该占一条 300px 的轨道。
  开关用**单层** `<label class="cbx-switch">`，文字 `<span>` 放在 `__track` 之后
  （`input:checked + __track` 是相邻兄弟选择器，追加 span 不影响它）；
  **禁止** `<label class="cbx-field">` 套 `<label class="cbx-switch">`，那是非法 HTML。
- 表单里的多列网格用 `repeat(auto-fill, minmax(260px, 1fr))`，**不要用 `auto-fit`**——
  项数少时 `auto-fit` 会折叠空轨道，把两个短字段各拉到约 400px。移动端仍显式降为 `1fr`。

> ⚠ 改这套 CSS 时注意 specificity，两个坑都只在特定环境暴露：
> 1. `.cbx-form-col .cbx-field > .cbx-input` 是 (0,3,0)，自动兜底必须写成
>    `> select.cbx-input` (0,3,1) / `> .cbx-input[type='number']` (0,4,0)；
>    移动端解除规则要与桌面规则**逐字同形**（媒体查询本身不加权重）。
>    写松了的后果是桌面完全正常、只有手机上留下一个窄框。
> 2. **SFC 里 scoped 会给选择器加一层属性**（`.swopt[data-v-x]` = (0,2,0)），
>    会压过 `base.css` 里 (0,1,0) 的 `.cbx-switch{min-height:44px}`。
>    页面级组件若给触控元素设了 `min-height`，必须在自己的移动端块里显式写回 44px。

> 已知天花板：本机制在 1600 视口把右侧空白压到 60px，但 ≥1920 时卡片仍止步 1540，
> 右侧会回到约 350px 背景。token 层只能重新分配空白、不能填充空白。
> 真正的结构解法是「桌面左侧 sticky 锚点导航列」，属于带 scroll-spy 的独立一步。

## 明暗主题

- 在 `<html>` 上写 `data-theme="light|dark"` 手动切换；不写则跟随系统 `prefers-color-scheme`。
- 暗色下品牌色提亮一档（`#339af0`），背景走 Mantine dark 阶（`#242424` / `#1f1f1f` / `#2e2e2e`）。
- 切换逻辑参考 `App.vue` 的 `applyTheme`（含 localStorage 记忆）。
