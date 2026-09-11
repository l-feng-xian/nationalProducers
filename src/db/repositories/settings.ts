import { getDb } from '../schema'
import { toPlain } from '../plain'
import { defaultSettings, type Settings } from '@/types/settings'

/** 读取全局配置；不存在则写入默认值。同时做浅层补齐，防止新增字段读到 undefined */
export async function load(): Promise<Settings> {
  const db = await getDb()
  const existing = await db.get('settings', 'app')
  if (!existing) {
    const s = defaultSettings()
    await db.put('settings', toPlain(s))
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
    // memory.vector 是**嵌套两层**的，必须单独补 —— 只写 `{...d.memory, ...existing.memory}`
    // 的话，老配置里有 memory 但没有 vector 时，vector 会被整个覆盖成 undefined，
    // 设置页的 v-model="mem.vector.enabled" 直接抛错。
    memory: {
      ...d.memory,
      ...existing.memory,
      vector: { ...d.memory.vector, ...existing.memory?.vector },
    },
    // 同 memory：老配置里整个 depth 都不存在，不补的话
    // 模型管理页读 settings.depth.modelId 直接抛错
    depth: { ...d.depth, ...existing.depth },
    chat: { ...d.chat, ...existing.chat },
  }
  return merged
}

export async function save(s: Settings): Promise<void> {
  s.updatedAt = Date.now()
  const db = await getDb()
  await db.put('settings', toPlain(s))
}
