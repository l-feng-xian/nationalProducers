/**
 * 应用启动序列。在 mount 之前跑完，保证首屏就有正确的主题与配置。
 */

import { getDb } from './db/schema'
import { runDataMigrations } from './db/migrations'
import { useSettingsStore } from './stores/settings'
import { useUiStore } from './stores/ui'
import { useCharactersStore } from './stores/characters'
import { useWorldsStore } from './stores/worlds'
import { useGroupsStore } from './stores/groups'
import { APP_TITLE } from './constants/app'
import { ensureStarterTemplates, generateStarterCovers, restoreStarterTemplateCovers } from './services/bootstrap/starterTemplates'
import { watch } from 'vue'

export async function bootstrap(): Promise<void> {
  const ui = useUiStore()
  // 主题优先于任何 await，避免首屏白闪
  ui.initTheme()

  // index.html 是静态文件、拿不到这个常量，这里覆盖一次兜底：
  // 万一哪天只改了 constants/app.ts 忘了改 index.html，标签页也不会说错名字
  document.title = APP_TITLE

  await getDb()
  await runDataMigrations()

  const settings = useSettingsStore()
  await settings.load()
  await ensureStarterTemplates()

  // 角色 / 世界书 / 群组都是提示词组装的必需输入，必须在首次生成前就绪 ——
  // 只在各自页面里 load 的话，直接进聊天页会静默拿到空列表
  // （世界书不生效、演绎选不出发言者）。
  await Promise.all([useCharactersStore().load(), useWorldsStore().load(), useGroupsStore().load()])
  await restoreStarterTemplateCovers()
  watch(() => settings.activeImageService?.id, () => { void generateStarterCovers() }, { immediate: true })

  // 配置里存的主题优先于 localStorage（跨设备同一份配置时更符合预期）
  if (settings.settings.theme !== ui.theme) ui.applyTheme(settings.settings.theme)
}
