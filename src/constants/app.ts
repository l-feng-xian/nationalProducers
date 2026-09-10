/**
 * 应用标识。
 *
 * 名字以前硬编码在 AppSidebar 里，index.html 的标题则一直停在脚手架默认的
 * 「Vite App」—— 两处各说各话。统一收在这里，改名只改这一个文件。
 *
 * 注意 index.html 是静态文件，构建期不经过这里，所以它的 <title> 需要手工同步；
 * 运行时由 bootstrap 用 APP_TITLE 覆盖一次，保证两者不会再漂移。
 */

/** 应用名。侧栏品牌位、标签页标题都用它 */
export const APP_NAME = '幕间'

/** 一句话定位，用于标签页标题与 README */
export const APP_TAGLINE = 'AI 沉浸式角色扮演聊天'

/**
 * 侧栏品牌图标现在用的是 `public/logo.jpg`（见 AppSidebar.vue），
 * 原来那个「幕」字贴片已不再使用，故不保留 APP_LOGO_CHAR 常量。
 * 换图只需替换 public/logo.jpg。
 */

/** 浏览器标签页标题 */
export const APP_TITLE = `${APP_NAME} · ${APP_TAGLINE}`

/**
 * 「列表项 → 详情页」共享元素过渡用的 view-transition-name。
 *
 * 刻意是**一个通用固定名**，不是「每张卡一个名字」，也不叫 char-avatar：
 *
 * - **固定名**：同名元素在同一时刻出现两个，规范要求整个过渡被 skip 并让
 *   `.ready` 以 InvalidStateError reject。固定名 + 只在「即将参与过渡的那
 *   一个元素」上条件绑定，绑 `undefined` 时 Vue 直接移除该行内样式，
 *   天然不会撞名、也不需要手动清理。
 * - **通用名**：将来群聊有了封面图，加一行 `:style` 绑定就能复用同一套
 *   composable 与 CSS，不用再造一个名字和一组 ::view-transition 规则。
 *   （当前刻意不给群聊做 —— 列表侧只有一个 👥 emoji，编辑页那个是 32px
 *   圆形成员头像，两端根本没有可配对的共享元素。）
 *
 * ⚠️ 取值是 CSS `<custom-ident>`：**不能以数字开头**。
 * 所以别顺手拿记录的 UUID 当名字 —— 一半的 UUID 以数字开头属于非法标识符，
 * 而且写错**不报错、只静默失效**。
 */
export const MORPH_VT_NAME = 'cbx-morph'
