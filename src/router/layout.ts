import { DRAWER_MQ } from '@/composables/useDrawerSwipe'

/**
 * 两套导航布局共用的判断。
 *
 * - **桌面宽屏**：左侧常驻侧栏，首页 = 聊天页，侧栏各分区都是顶层（depth 0）。
 * - **手机窄屏**：底部标签栏（角色 / 演绎 / 世界书 / 模型 / 数据），首页 = 角色页；
 *   聊天页、设置页变成压在标签页之上的二级页（route meta.mobileDepth），带返回箭头、不显示标签栏。
 *   会话列表与设置收在左侧抽屉里。
 */

export function isMobileLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DRAWER_MQ).matches
}

/** 首页路由名：在首页按返回 = 退出 App */
export function homeName(): 'characters' | 'chat' {
  return isMobileLayout() ? 'characters' : 'chat'
}

export function homePath(): string {
  return isMobileLayout() ? '/characters' : '/chat'
}

/** 手机底部标签栏，顺序即显示顺序 */
export const MOBILE_TABS = [
  { name: 'characters', to: '/characters', label: '角色' },
  { name: 'groups', to: '/groups', label: '演绎' },
  { name: 'worlds', to: '/worlds', label: '世界书' },
  { name: 'models', to: '/models', label: '模型管理' },
  { name: 'data', to: '/data', label: '数据管理' },
] as const

export const MOBILE_TAB_NAMES: readonly string[] = MOBILE_TABS.map((t) => t.name)
