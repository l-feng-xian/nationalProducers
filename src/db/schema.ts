/**
 * IndexedDB schema。
 *
 * 铁律：**一个 IDB 事务内只能 await IDB 请求**。
 * 禁止在事务里 await fetch / await repo / await 任何非 IDB Promise —— 事务会静默自动提交。
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Character } from '@/types/character'
import type { WorldBook } from '@/types/worldinfo'
import type { Group } from '@/types/group'
import type { ChatMeta, ChatMessage } from '@/types/chat'
import type { Settings } from '@/types/settings'

export const DB_NAME = 'np-chat'
export const DB_VERSION = 1

export interface BlobRecord {
  id: string
  mime: string
  size: number
  data: Blob
  createdAt: number
}

export interface SecretRecord {
  ref: string
  value: string
}

export interface NpDB extends DBSchema {
  settings: { key: string; value: Settings }
  secrets: { key: string; value: SecretRecord }
  characters: {
    key: string
    value: Character
    indexes: { by_updatedAt: number; by_name: string; by_fav: number }
  }
  worldbooks: {
    key: string
    value: WorldBook
    indexes: { by_updatedAt: number; by_name: string }
  }
  groups: {
    key: string
    value: Group
    indexes: { by_updatedAt: number }
  }
  chats: {
    key: string
    value: ChatMeta
    indexes: { by_updatedAt: number; by_characterId: string; by_groupId: string }
  }
  messages: {
    key: [string, number]
    value: ChatMessage
    indexes: { by_msgId: [string, string] }
  }
  blobs: { key: string; value: BlobRecord }
}

let dbPromise: Promise<IDBPDatabase<NpDB>> | null = null

export function getDb(): Promise<IDBPDatabase<NpDB>> {
  if (dbPromise) return dbPromise
  dbPromise = openDB<NpDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // 迁移阶梯：加版本只追加 if 块，永不改动已发布的块。
      // 这里只做结构变更，数据重写走 migrations.ts（upgrade 事务里遍历几万条消息会卡死首屏）。
      if (oldVersion < 1) {
        db.createObjectStore('settings', { keyPath: 'id' })
        db.createObjectStore('secrets', { keyPath: 'ref' })

        const chars = db.createObjectStore('characters', { keyPath: 'id' })
        chars.createIndex('by_updatedAt', 'updatedAt')
        chars.createIndex('by_name', 'data.name')
        // IDB 不索引 boolean，故用冗余的 favIdx: 0|1
        chars.createIndex('by_fav', 'favIdx')

        const worlds = db.createObjectStore('worldbooks', { keyPath: 'id' })
        worlds.createIndex('by_updatedAt', 'updatedAt')
        worlds.createIndex('by_name', 'name')

        const groups = db.createObjectStore('groups', { keyPath: 'id' })
        groups.createIndex('by_updatedAt', 'updatedAt')

        const chats = db.createObjectStore('chats', { keyPath: 'id' })
        chats.createIndex('by_updatedAt', 'updatedAt')
        chats.createIndex('by_characterId', 'characterId')
        chats.createIndex('by_groupId', 'groupId')

        const msgs = db.createObjectStore('messages', { keyPath: ['chatId', 'seq'] })
        msgs.createIndex('by_msgId', ['chatId', 'id'])

        db.createObjectStore('blobs', { keyPath: 'id' })
      }
    },
    blocked() {
      console.warn('[db] 另一个标签页正占用旧版本数据库')
    },
    blocking() {
      dbPromise = null
    },
  })
  return dbPromise
}

/**
 * 一个会话的全部消息主键区间。
 *
 * IDB 键序为 number < date < string < binary < array，所以 `[chatId, 任意数字] < [chatId, []]`；
 * 而长度 1 的 `[chatId]` 作为前缀排在所有 `[chatId, x]` 之前。这是规范写法。
 */
export function chatRange(chatId: string): IDBKeyRange {
  return IDBKeyRange.bound([chatId], [chatId, []])
}
