import { getDb } from '../schema'
import { defaultSettings, type Settings } from '@/types/settings'

/** 读取全局配置；不存在则写入默认值。同时做浅层补齐，防止新增字段读到 undefined */
export async function load(): Promise<Settings> {
  const db = await getDb()
  const existing = await db.get('settings', 'app')
  if (!existing) {
    const s = defaultSettings()
    await db.put('settings', s)
    return s
  }
  const d = defaultSettings()
  const merged: Settings = {
    ...d,
    ...existing,
    provider: { ...d.provider, ...existing.provider },
    worldInfo: { ...d.worldInfo, ...existing.worldInfo },
    persona: { ...d.persona, ...existing.persona },
    prompt: { ...d.prompt, ...existing.prompt },
    constraint: {
      solo: { ...d.constraint.solo, ...existing.constraint?.solo },
      group: { ...d.constraint.group, ...existing.constraint?.group },
    },
    chat: { ...d.chat, ...existing.chat },
  }
  return merged
}

export async function save(s: Settings): Promise<void> {
  s.updatedAt = Date.now()
  const db = await getDb()
  await db.put('settings', s)
}
