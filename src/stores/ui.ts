import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'

const THEME_KEY = 'cbx-theme'

/** 全局 UI 状态：主题、移动端抽屉、各类浮层开关 */
export const useUiStore = defineStore('ui', () => {
  const theme = ref<ThemeMode>('system')
  const drawerOpen = ref(false)
  const newChatOpen = ref(false)

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

  return {
    theme,
    drawerOpen,
    newChatOpen,
    applyTheme,
    initTheme,
    cycleTheme,
    openDrawer,
    closeDrawer,
    toggleDrawer,
  }
})
