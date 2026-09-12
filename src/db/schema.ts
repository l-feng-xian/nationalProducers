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
import type { RpgWorld } from '@/types/rpg'

export const DB_NAME = 'np-chat'
export const DB_VERSION = 4

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
  /**
   * 会话记忆的向量块。
   *
   * 三段复合主键 `[chatId, kindRank, ord]` 是刻意的：
   *  - number < array，所以 `chatRange(chatId)` 原样复用，级联删除一行搞定；
   *  - kindRank 在前，让「对话窗口块(0)」与「LLM 事实(1)」各占一段连续键空间，
   *    失效时能用 IDBKeyRange 一刀切掉「endSeq ≥ S 的全部窗口块」。
   *
   * **刻意零二级索引**：IDB 每个索引在写入时都要同步维护，移动端上索引维护
   * 常比主记录写入还慢，而这里的查询模式（按会话整取）主键已经全覆盖。
   */
  memchunks: { key: [string, number, number]; value: MemChunk }
  /**
   * RPG 世界存档。
   *
   * 刻意**不存地形**：地形完全由 seed 算出来，存了反而是双真相源
   * （改了生成算法就与存档对不上）。这里只存种子、玩家位置、人设与 NPC，
   * 所以一份存档就几 KB，跟着整库备份走毫无压力。
   */
  rpgworlds: {
    key: string
    value: RpgWorld
    indexes: { by_updatedAt: number }
  }
}

/** 一块可检索的记忆。向量写入前已 L2 归一化，检索时余弦退化成纯点积 */
export interface MemChunk {
  chatId: string
  /** 0=对话窗口块，1=LLM 提炼的事实。排序用，也用于键空间分段 */
  kindRank: 0 | 1
  /** 同一 kind 内的序号，保证主键唯一且有序 */
  ord: number
  /** 渲染后的正文，注入时原样使用 */
  text: string
  /** 本块覆盖的消息 seq 列表。失效与去重都靠它 */
  srcSeqs: number[]
  /** 覆盖到的最大 seq，范围失效用 */
  endSeq: number
  /** L2 归一化后的向量 */
  vec: Float32Array
  /** 源文本的 fnv1a，消息被编辑后能发现内容变了 */
  srcHash: number
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
      // v2：会话记忆的向量块。
      // 追加而不是改动 v1 那块 —— v1 已经发布过，改它会让老库升不上来。
      if (oldVersion < 2) {
        db.createObjectStore('memchunks', { keyPath: ['chatId', 'kindRank', 'ord'] })
      }
      // v3：补建 memchunks。
      //
      // 开发期的真实事故：DB_VERSION 先 bump 到 2、建 store 的代码后写，
      // 中间刷新过一次页面的库就永久停在「version=2 但没有 memchunks」——
      // 版本号已经到位，`oldVersion < 2` 再也不会触发，于是记忆功能一开就
      // NotFoundError，而且删库重来才能修（会赔上没被导出的 API Key）。
      // 加一级台阶把这种库捞回来；v2 本来就正确的库走到这里是空转。
      if (!db.objectStoreNames.contains('memchunks')) {
        db.createObjectStore('memchunks', { keyPath: ['chatId', 'kindRank', 'ord'] })
      }
      // v4：RPG 世界存档。
      // ⚠️ bump 版本号与建 store 必须**同一次提交**——见上面 v3 那段记着的事故。
      if (oldVersion < 4) {
        const worlds = db.createObjectStore('rpgworlds', { keyPath: 'id' })
        worlds.createIndex('by_updatedAt', 'updatedAt')
      }
      // 同 memchunks 的补救台阶：万一有库走到 v4 却没建上，这里捞回来
      if (!db.objectStoreNames.contains('rpgworlds')) {
        const worlds = db.createObjectStore('rpgworlds', { keyPath: 'id' })
        worlds.createIndex('by_updatedAt', 'updatedAt')
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
