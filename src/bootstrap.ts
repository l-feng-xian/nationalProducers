/**
 * 应用启动序列。在 mount 之前跑完，保证首屏就有正确的主题与配置。
 */

import { getDb } from './db/schema'
import { runDataMigrations } from './db/migrations'
import { useSettingsStore } from './stores/settings'
import { useUiStore } from './stores/ui'
import { useCharactersStore } from './stores/characters'
import { useWorldsStore } from './stores/worlds'

export async function bootstrap(): Promise<void> {
  const ui = useUiStore()
  // 主题优先于任何 await，避免首屏白闪
  ui.initTheme()

  await getDb()
  await runDataMigrations()

  const settings = useSettingsStore()
  await settings.load()

  // 角色与世界书是提示词组装的必需输入，必须在首次生成前就绪 ——
  // 只在各自页面里 load 的话，直接进聊天页会静默拿到空列表（世界书就不会生效）。
  await Promise.all([useCharactersStore().load(), useWorldsStore().load()])

  // 配置里存的主题优先于 localStorage（跨设备同一份配置时更符合预期）
  if (settings.settings.theme !== ui.theme) ui.applyTheme(settings.settings.theme)
}
