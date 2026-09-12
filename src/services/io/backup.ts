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
  /** RPG 世界存档。很小（地形是算出来的，只存种子与 NPC），随包走无压力 */
  rpgworlds: unknown[]
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
  rpgworlds: boolean
}

export const FULL_SCOPE: SyncScope = {
  characters: true,
  worldbooks: true,
  groups: true,
  chats: true,
  settings: true,
  rpgworlds: true,
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
    rpgworlds: s.rpgworlds ? await db.getAll('rpgworlds') : [],
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
  rpgworlds: number
  /**
   * 写不进去、被跳过的行数。
   *
   * 备份是**零校验原样回写**的（这是有意的：校验在各仓储的读路径 normalize 里）。
   * 但「不校验」不等于「什么都写得进去」——IndexedDB 自己有一道硬门槛：
   * 取不出主键的行会直接抛 DataError。缺 id 的世界、缺 seq 的消息（复合主键
   * `[chatId, seq]`）都属于这一类。
   *
   * ⚠️ 以前这里没有 try/catch：**第一行坏数据就会掀掉整次导入**，而前面已经写进去的
   * 行不会回滚，用户看到的是一句原始的 `Failed to execute 'put' on 'IDBObjectStore'`，
   * 既不知道进了多少、也不知道是谁坏了。现在改成逐行隔离、继续往下走、最后报总数：
   * 宁可少进几行并说清楚，也不要半途炸掉还不吭声。
   */
  skipped: number
  /** 跳过的行都出在哪些 store，给 UI 说人话用 */
  skippedBy: Partial<Record<BackupStore, number>>
}

type BackupStore =
  | 'characters'
  | 'worldbooks'
  | 'groups'
  | 'chats'
  | 'messages'
  | 'rpgworlds'
  | 'blobs'
  | 'settings'

/** 列表读的是 by_updatedAt 索引的那几个 store */
const INDEXED_BY_UPDATED_AT: ReadonlySet<string> = new Set([
  'characters',
  'worldbooks',
  'groups',
  'chats',
  'rpgworlds',
])

/**
 * 索引键兜底：`updatedAt` 不是合法键时补一个。
 *
 * ⚠️ 这是全仓**唯一一处必须写在导入侧**的校验，不能留给读路径的 normalize ——
 * 因为读路径**结构上够不着它**：
 *
 * IndexedDB 对索引键的处理是「不是合法键就把这行从索引里略过」，而**行本身正常存下**，
 * 不报错。于是 `updatedAt` 缺失 / 为 null / 为布尔 / 为 NaN 的一行会安静地进库。
 * 而 characters / worldbooks / groups / chats / rpgworlds 的 list() 全都走
 * `getAllFromIndex('by_updatedAt')`，`.map(normalize)` 映的是那个查询的**结果** ——
 * 被索引丢掉的行根本不在数组里，normalize 永远没机会跑。
 *
 * 结果就是一行「在库里占着配额、在任何界面上都不存在、也没法删」的幽灵数据：
 * 导入还会把它算进成功计数，用户看到「导入完成：角色 1」然后角色列表是空的。
 *
 * 补的是导入时刻 —— 它是个诚实的「最后一次被动过」，顺带让这行排在列表最前面，
 * 用户一眼就能看见刚进来的东西。
 */
function fixIndexKey(store: string, row: unknown): unknown {
  if (!INDEXED_BY_UPDATED_AT.has(store) || !row || typeof row !== 'object') return row
  const u = (row as { updatedAt?: unknown }).updatedAt
  if (typeof u === 'number' && Number.isFinite(u)) return row
  return { ...(row as object), updatedAt: Date.now() }
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
 *
 * @param scope 只允许写这些类别。**接收方必须传**自己确认过的那份 scope ——
 *   见下方说明。不传表示全收（文件导入就是这种：文件是用户自己选的）。
 */
export async function applyBackup(
  file: Partial<BackupFile>,
  scope?: Partial<SyncScope>,
): Promise<ImportResult> {
  /**
   * ⚠️ 范围必须在**接收侧**兜住，不能只信发送侧。
   *
   * 同步握手里，接收方看到的是对端 manifest 声明的 scope，并据此点「接收」——
   * 但此前 eof 分支是把收到的整包原样 applyBackup 的。声明 `settings: false`
   * 却在包里塞一份 settings，照样会把接收方的接口地址、模型、人设整包盖掉，
   * 而用户以为自己拒绝了这一项。**用户同意的是 manifest，落地的必须也是它。**
   */
  const allow: SyncScope = scope ? { ...FULL_SCOPE, ...scope } : FULL_SCOPE
  const db = await getDb()
  const out: ImportResult = {
    characters: 0,
    worldbooks: 0,
    groups: 0,
    chats: 0,
    messages: 0,
    blobs: 0,
    rpgworlds: 0,
    skipped: 0,
    skippedBy: {},
  }

  /**
   * 记一行跳过。
   *
   * 只对每个 store 的头 3 行打 console —— 一份被截断的备份可能有上千行坏数据，
   * 全打出来只会把控制台刷爆，反而看不见别的。总数在返回值里，UI 会显示。
   */
  const skip = (store: BackupStore, err: unknown) => {
    out.skipped++
    const n = (out.skippedBy[store] ?? 0) + 1
    out.skippedBy[store] = n
    if (n <= 3) console.warn(`[导入] 跳过一行 ${store}：`, err)
  }

  // Blob 先还原，角色记录才有头像可指。
  // 它不是独立的一类，而是依附于角色/群/人设的 —— 三者都不在范围内就没人指向它了
  const wantBlobs = allow.characters || allow.groups || allow.settings
  for (const b of wantBlobs ? (file.blobs ?? []) : []) {
    try {
      // ⚠️ dataUrlToBlob 走的是 fetch()，一个被手改坏的 data URL 会直接 reject。
      // 不接住的话，一张坏头像就能让整次导入前功尽弃
      const data = await dataUrlToBlob(b.dataUrl)
      await db.put('blobs', {
        id: b.id,
        mime: b.mime,
        size: data.size,
        data,
        createdAt: Date.now(),
      })
      out.blobs++
    } catch (e) {
      skip('blobs', e)
    }
  }

  const bulk = async (
    store: 'characters' | 'worldbooks' | 'groups' | 'chats' | 'messages' | 'rpgworlds',
    rows: unknown[],
  ) => {
    for (const r of rows) {
      try {
        // 各 store 的 value 类型不同，这里是按备份文件原样回写，用 never 绕过联合类型收窄。
        // 语义校验一律交给各仓储读路径的 normalize，这里只负责两件读路径够不着的事：
        // 「写不进去的别连累别人」，以及下面这条索引键兜底
        await db.put(store, fixIndexKey(store, toPlain(r)) as never)
        out[store]++
      } catch (e) {
        skip(store, e)
      }
    }
  }
  await bulk('characters', allow.characters ? (file.characters ?? []) : [])
  await bulk('worldbooks', allow.worldbooks ? (file.worldbooks ?? []) : [])
  await bulk('groups', allow.groups ? (file.groups ?? []) : [])
  // messages 跟着 chats 走：光有消息没有会话是一堆挂不上的孤儿（见 SyncScope 的说明）
  await bulk('chats', allow.chats ? (file.chats ?? []).map(stripMemIndex) : [])
  await bulk('messages', allow.chats ? (file.messages ?? []) : [])
  await bulk('rpgworlds', allow.rpgworlds ? (file.rpgworlds ?? []) : [])

  if (allow.settings && file.settings) {
    try {
      await db.put('settings', toPlain(file.settings) as never)
    } catch (e) {
      skip('settings', e)
    }
  }
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
