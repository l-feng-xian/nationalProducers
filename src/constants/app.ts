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

/** 侧栏品牌图标里的字 */
export const APP_LOGO_CHAR = '幕'

/** 浏览器标签页标题 */
export const APP_TITLE = `${APP_NAME} · ${APP_TAGLINE}`
