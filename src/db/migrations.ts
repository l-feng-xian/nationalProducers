/**
 * 数据级迁移（与 schema.ts 的结构级 DB_VERSION 分开）。
 *
 * 结构层只在 upgrade 事务里建 store/index —— 在那里遍历几万条消息会卡死首屏。
 * 字段语义变更、默认值补齐这类数据重写放这里，惰性执行、可分批、可显进度。
 */

import type { IDBPDatabase } from 'idb'
import { getDb, type NpDB } from './schema'

export const DATA_SCHEMA_VERSION = 2

interface Migration {
  to: number
  run: (db: IDBPDatabase<NpDB>) => Promise<void>
}

const MIGRATIONS: Migration[] = [
  {
    to: 2,
    async run(db) {
      // 只移除旧世界绑定，保留会话、消息和记忆。
      const tx = db.transaction('chats', 'readwrite')
      let cursor = await tx.store.openCursor()
      while (cursor) {
        const chat = cursor.value
        const metadata = chat.chat_metadata
        if (metadata && typeof metadata === 'object' && 'rpg' in metadata) {
          delete metadata.rpg
          await cursor.update(chat)
        }
        cursor = await cursor.continue()
      }
      await tx.done
    },
  },
]

export async function runDataMigrations(): Promise<void> {
  const db = await getDb()
  const s = await db.get('settings', 'app')
  let from = s?.schemaVersion ?? 0
  for (const m of MIGRATIONS) {
    if (m.to <= from) continue
    await m.run(db)
    from = m.to
  }
  if (s && from !== s.schemaVersion) {
    await db.put('settings', { ...s, schemaVersion: from })
  }
}
