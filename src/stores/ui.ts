import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'

const THEME_KEY = 'cbx-theme'
/** 状态侧栏是否固定常驻（仅桌面）。设备级偏好，不随设置同步 */
const STATUS_PIN_KEY = 'cbx-status-pinned'

function readPinned(): boolean {
  try {
    return localStorage.getItem(STATUS_PIN_KEY) === '1'
  } catch {
    return false
  }
}

/** 全局 UI 状态：主题、移动端抽屉、各类浮层开关 */
export const useUiStore = defineStore('ui', () => {
  const theme = ref<ThemeMode>('system')
  const drawerOpen = ref(false)
  /**
   * 手指拖动抽屉时的展开进度 0..1（null = 没在拖）。
   * 拖动期间侧栏与遮罩跟手，松手后清回 null，交给 CSS 过渡落到开 / 关。
   */
  const drawerDrag = ref<number | null>(null)
  /**
   * 状态侧栏。pinned 只在桌面有意义：固定时侧栏常驻并挤窄聊天列；
   * 不固定（以及手机上一律）是浮层，发送 / 聚焦输入框时自动收起。
   * 固定时 statusOpen 仍然表示「此刻开着」，关掉固定的侧栏不会取消固定偏好。
   */
  const statusPinned = ref(readPinned())
  // 手机上一律从关着开始（固定偏好只对桌面有意义）。
  // 断点与 DRAWER_MQ 相同；不 import 它是因为 useDrawerSwipe 反过来依赖本 store
  const statusOpen = ref(statusPinned.value && !matchMedia('(max-width: 767px)').matches)

  function applyTheme(t: ThemeMode) {
    theme.value = t
    const el = document.documentElement
    // 'system' 时移除属性，交给 prefers-color-scheme 媒体查询
    if (t === 'system') el.removeAttribute('data-theme')
    else el.setAttribute('data-theme', t)
    try {
      localStorage.setItem(THEME_KEY, t)
    } catch {
      // 隐私模式 / 站点数据被禁用时会抛，忽略即可
    }
  }

  function initTheme() {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(THEME_KEY)
    } catch {
      saved = null
    }
    const t: ThemeMode =
      saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
    applyTheme(t)
  }

  /** 在 浅色 → 深色 → 跟随系统 之间轮转 */
  function cycleTheme() {
    applyTheme(theme.value === 'light' ? 'dark' : theme.value === 'dark' ? 'system' : 'light')
  }

  function openDrawer() {
    drawerOpen.value = true
  }
  function closeDrawer() {
    drawerOpen.value = false
  }
  function toggleDrawer() {
    drawerOpen.value = !drawerOpen.value
  }

  function setStatusPinned(on: boolean) {
    statusPinned.value = on
    try {
      localStorage.setItem(STATUS_PIN_KEY, on ? '1' : '0')
    } catch {
      // 同 applyTheme
    }
  }

  return {
    theme,
    drawerOpen,
    drawerDrag,
    statusOpen,
    statusPinned,
    setStatusPinned,
    applyTheme,
    initTheme,
    cycleTheme,
    openDrawer,
    closeDrawer,
    toggleDrawer,
  }
})
