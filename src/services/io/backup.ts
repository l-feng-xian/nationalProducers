/**
 * 整库导入导出。
 *
 * 头像等 Blob 转成 base64 data URL 以便塞进 JSON；
 * API Key（secrets）**刻意不导出**，避免用户把备份发给别人时泄漏密钥。
 */

import { getDb } from '@/db/schema'
import { toPlain } from '@/utils/plain'
import { collectBlobRefs } from '@/db/repositories/blobs'

/**
 * ⚠️ `format` 是**数据格式标识，不是应用名**。应用改名（国货优选 → 幕间）时
 * 刻意没有跟着改：它被 importAll 用作校验值，一旦改动，用户此前导出的所有备份
 * 都会被判成「不是本应用导出的备份文件」而拒绝导入。除非同时写好双向兼容，
 * 否则**永远不要动这个字符串**。用户可见的文件名走 APP_NAME，与它无关。
 */
export interface BackupFile {
  format: 'nationalproducers-backup'
  version: 1
  exportedAt: number
  settings: unknown
  characters: unknown[]
  worldbooks: unknown[]
  groups: unknown[]
  chats: unknown[]
  messages: unknown[]
  blobs: { id: string; mime: string; dataUrl: string }[]
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsDataURL(b)
  })
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url)
  return res.blob()
}

/**
 * 会话记忆的**向量块刻意不导出**。
 *
 * 一是体积：JSON 里 Float32Array 会被摊成 `{"0":0.12,"1":-0.03,…}`，512 维一块就是
 * 上万字符，一个长会话几千块直接把备份撑到几十 MB，正常的备份/恢复都做不成。
 * 二是它本就是从 messages 推导出来的派生数据，还绑定具体模型 —— 换模型后照样作废。
 *
 * 但**水位线必须一起抹掉**：memIndex.throughSeq 说「已经索引到第 N 条了」，
 * 而导入的库里一个向量块都没有。追赶逻辑只认水位线，会认定无事可做，
 * 于是导入的会话记忆永远是空的，且不报任何错。这是必须成对处理的两件事。
 */
function stripMemIndex(row: unknown): unknown {
  if (!row || typeof row !== 'object') return row
  const meta = (row as { chat_metadata?: { memIndex?: unknown } }).chat_metadata
  if (!meta || typeof meta !== 'object' || !('memIndex' in meta)) return row
  const { memIndex: _drop, ...rest } = meta
  return { ...(row as object), chat_metadata: rest }
}

/**
 * 一次搬运包含哪几类数据。
 *
 * `chats` 连带 messages —— 光有会话没有消息是个空壳，分开勾没有意义。
 * `settings` 单列是因为它会**整包覆盖**对方的接口地址、模型、人设，
 * 所以扫码同步默认不勾它；整库导出则默认全都要。
 */
export interface SyncScope {
  characters: boolean
  worldbooks: boolean
  groups: boolean
  chats: boolean
  settings: boolean
}

export const FULL_SCOPE: SyncScope = {
  characters: true,
  worldbooks: true,
  groups: true,
  chats: true,
  settings: true,
}

/**
 * 按范围组装备份对象。
 *
 * 图片**按可达性挑选**，而不是无脑 `getAll('blobs')`：只勾角色时不该把群头像
 * 也塞进去。可达集统一走 `collectBlobRefs`，那里同时认 avatarBlobId 和
 * depthBlobId —— 漏掉深度图会让对方收到的角色卡失去视差效果。
 */
export async function buildBackup(scope: Partial<SyncScope> = {}): Promise<BackupFile> {
  const s: SyncScope = { ...FULL_SCOPE, ...scope }
  const db = await getDb()

  const characters = s.characters ? await db.getAll('characters') : []
  const groups = s.groups ? await db.getAll('groups') : []
  const settings = s.settings ? ((await db.get('settings', 'app')) ?? null) : null

  const wanted = collectBlobRefs({
    characters,
    groups,
    persona: settings?.persona,
  })
  const blobs: BackupFile['blobs'] = []
  for (const b of await db.getAll('blobs')) {
    if (!wanted.has(b.id)) continue
    blobs.push({ id: b.id, mime: b.mime, dataUrl: await blobToDataUrl(b.data) })
  }

  return {
    format: 'nationalproducers-backup',
    version: 1,
    exportedAt: Date.now(),
    settings,
    characters,
    worldbooks: s.worldbooks ? await db.getAll('worldbooks') : [],
    groups,
    chats: s.chats ? await db.getAll('chats') : [],
    messages: s.chats ? await db.getAll('messages') : [],
    blobs,
    // 注意：secrets（API Key）不导出
  }
}

export async function exportAll(): Promise<Blob> {
  const file = await buildBackup()
  return new Blob([JSON.stringify(file)], { type: 'application/json' })
}

export interface ImportResult {
  characters: number
  worldbooks: number
  groups: number
  chats: number
  messages: number
  blobs: number
}

/** 合并导入：同 id 覆盖，不清空现有数据 */
export async function importAll(text: string): Promise<ImportResult> {
  const file = JSON.parse(text) as Partial<BackupFile>
  if (file.format !== 'nationalproducers-backup') {
    throw new Error('不是本应用导出的备份文件')
  }
  return applyBackup(file)
}

/**
 * 把备份对象合并进本地库：同 id 覆盖，不清空现有数据。
 *
 * 与 importAll 的区别只在于**不做 format 校验**：扫码同步的数据是从对端
 * 直接构造出来的对象，不经过文件，校验在握手阶段就做过了。
 */
export async function applyBackup(file: Partial<BackupFile>): Promise<ImportResult> {
  const db = await getDb()
  const out: ImportResult = {
    characters: 0,
    worldbooks: 0,
    groups: 0,
    chats: 0,
    messages: 0,
    blobs: 0,
  }

  // Blob 先还原，角色记录才有头像可指
  for (const b of file.blobs ?? []) {
    const data = await dataUrlToBlob(b.dataUrl)
    await db.put('blobs', {
      id: b.id,
      mime: b.mime,
      size: data.size,
      data,
      createdAt: Date.now(),
    })
    out.blobs++
  }

  const bulk = async (
    store: 'characters' | 'worldbooks' | 'groups' | 'chats' | 'messages',
    rows: unknown[],
  ) => {
    for (const r of rows) {
      // 各 store 的 value 类型不同，这里是按备份文件原样回写，用 never 绕过联合类型收窄
      await db.put(store, toPlain(r) as never)
      out[store]++
    }
  }
  await bulk('characters', file.characters ?? [])
  await bulk('worldbooks', file.worldbooks ?? [])
  await bulk('groups', file.groups ?? [])
  await bulk('chats', (file.chats ?? []).map(stripMemIndex))
  await bulk('messages', file.messages ?? [])

  if (file.settings) await db.put('settings', toPlain(file.settings) as never)
  return out
}

/** 存储用量（浏览器给的是整个源的估算值） */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const e = await navigator.storage.estimate()
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
