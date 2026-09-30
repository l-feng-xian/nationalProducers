/**
 * 整库导入导出。
 *
 * 头像等 Blob 转成 base64 data URL 以便塞进 JSON；
 * API Key（secrets）**刻意不导出**，避免用户把备份发给别人时泄漏密钥。
 */

import { chatRange, getDb } from '@/db/schema'
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
  version: 1 | 2
  exportedAt: number
  settings: unknown
  characters: unknown[]
  worldbooks: unknown[]
  groups: unknown[]
  chats: unknown[]
  messages: unknown[]
  blobs: { id: string; mime: string; dataUrl: string }[]
  starterTemplateImages?: { id: string; mime: string; dataUrl: string }[]
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
  const meta = (row as { chat_metadata?: { memIndex?: unknown; rpg?: unknown } }).chat_metadata
  if (!meta || typeof meta !== 'object') return row
  // 旧备份中的世界绑定已失效，导入时一并去掉。
  const { memIndex: _drop, rpg: _legacy, ...rest } = meta
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
  const messages = s.chats ? await db.getAll('messages') : []
  const settings = s.settings ? ((await db.get('settings', 'app')) ?? null) : null

  const wanted = collectBlobRefs({
    characters,
    groups,
    messages,
    persona: settings?.persona,
  })
  const blobs: BackupFile['blobs'] = []
  for (const b of await db.getAll('blobs')) {
    if (!wanted.has(b.id)) continue
    blobs.push({ id: b.id, mime: b.mime, dataUrl: await blobToDataUrl(b.data) })
  }
  const starterTemplateImages: NonNullable<BackupFile['starterTemplateImages']> = []
  if (s.characters || s.groups) {
    const ids = new Set([
      ...(s.characters ? characters.map((c) => c.templateId).filter((id): id is string => !!id) : []),
      ...(s.groups ? groups.map((g) => g.templateId).filter((id): id is string => !!id) : []),
    ])
    for (const image of await db.getAll('starter_template_images')) {
      if (ids.has(image.id)) starterTemplateImages.push({ id: image.id, mime: image.mime, dataUrl: await blobToDataUrl(image.data) })
    }
  }

  return {
    format: 'nationalproducers-backup',
    version: 2,
    exportedAt: Date.now(),
    settings,
    characters,
    worldbooks: s.worldbooks ? await db.getAll('worldbooks') : [],
    groups,
    chats: s.chats ? await db.getAll('chats') : [],
    messages,
    blobs,
    starterTemplateImages,
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
  /**
   * 写不进去、被跳过的行数。
   *
   * 备份是**零校验原样回写**的（这是有意的：校验在各仓储的读路径 normalize 里）。
   * 但「不校验」不等于「什么都写得进去」——IndexedDB 自己有一道硬门槛：
   * 取不出主键的行会直接抛 DataError。缺 id 的角色、缺 seq 的消息（复合主键
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
  | 'blobs'
  | 'starter_template_images'
  | 'settings'

/** 列表读的是 by_updatedAt 索引的那几个 store */
const INDEXED_BY_UPDATED_AT: ReadonlySet<string> = new Set([
  'characters',
  'worldbooks',
  'groups',
  'chats',
])

/**
 * 索引键兜底：`updatedAt` 不是合法键时补一个。
 *
 * ⚠️ 这是全仓**唯一一处必须写在导入侧**的校验，不能留给读路径的 normalize ——
 * 因为读路径**结构上够不着它**：
 *
 * IndexedDB 对索引键的处理是「不是合法键就把这行从索引里略过」，而**行本身正常存下**，
 * 不报错。于是 `updatedAt` 缺失 / 为 null / 为布尔 / 为 NaN 的一行会安静地进库。
 * 而 characters / worldbooks / groups / chats 的 list() 全都走
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
  if (file.version !== undefined && file.version !== 1 && file.version !== 2)
    throw new Error('不支持此备份版本，请更新应用。')
  const db = await getDb()
  const out: ImportResult = {
    characters: 0,
    worldbooks: 0,
    groups: 0,
    chats: 0,
    messages: 0,
    blobs: 0,
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
  // 图片依附于角色、群、人设或聊天附件；只同步聊天时也需要恢复配图。
  const wantBlobs = allow.characters || allow.groups || allow.settings || allow.chats
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

  if (allow.characters || allow.groups) {
    const allowedIds = new Set([
      ...(allow.characters ? (file.characters ?? []).map((row) => (row as { templateId?: string }).templateId) : []),
      ...(allow.groups ? (file.groups ?? []).map((row) => (row as { templateId?: string }).templateId) : []),
    ])
    for (const image of file.starterTemplateImages ?? []) {
      if (!allowedIds.has(image.id)) continue
      try {
        const data = await dataUrlToBlob(image.dataUrl)
        await db.put('starter_template_images', { id: image.id, mime: image.mime, data, createdAt: Date.now() })
      } catch (e) {
        skip('starter_template_images', e)
      }
    }
  }

  const bulk = async (
    store: 'characters' | 'worldbooks' | 'groups' | 'chats' | 'messages',
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

  /**
   * 导入是「同 id 覆盖」，被覆盖的会话元数据整包换成了对方那份，而**本机原有的
   * 消息行还在库里**（导入只写不删）。于是 messageCount 与 nextSeq 描述的是
   * 对方那份的规模，跟本地实际对不上。
   *
   * nextSeq 那一半有 messages 仓储的 allocSeq 兜底，不会再顶掉消息；
   * 但 messageCount 没有任何人会去修 —— 侧栏会一直显示一个偏小的条数，
   * 而且永远不会自己好。这里按库里**真实**情况重算一次。
   */
  if (allow.chats) {
    for (const row of file.chats ?? []) {
      const id = (row as { id?: unknown }).id
      if (typeof id !== 'string' || !id) continue
      try {
        const meta = await db.get('chats', id)
        if (!meta) continue
        const range = chatRange(id)
        /**
         * ⚠️ 向量块必须跟着一起清。
         *
         * stripMemIndex 已经把水位线抹掉了（见它的说明），接收方会从头重建索引；
         * 但**本机原有的 memchunks 一块没删**。而导入会覆盖这段会话的消息正文，
         * 于是那些块描述的是**已经不存在的文本**。
         *
         * 重建也救不回来：新索引 ord 从 0 重新编号，只覆盖得住前 N 块，
         * ord ≥ N 的旧块原样留着；而 loadIndex 是按会话整取、不做任何过滤的，
         * 那些幽灵块会照常被召回、照常进提示词。
         *
         * 「消息没了，基于消息建的索引也必须一起清」这条不变量，数据管理页的
         * 手动清理（clearChat + memIndex: undefined 成对出现）写得明明白白，
         * 导入这条路上一直漏着。memchunks 的主键是 [chatId, kindRank, ord]，
         * number < array，所以 chatRange 原样复用（见 schema.ts 的说明）。
         */
        await db.delete('memchunks', range)
        const count = await db.count('messages', range)
        const last = await db.transaction('messages').store.openCursor(range, 'prev')
        const maxSeq = Array.isArray(last?.key) ? (last.key[1] as unknown) : undefined
        const nextSeq =
          typeof maxSeq === 'number' && Number.isFinite(maxSeq) ? maxSeq + 1 : meta.nextSeq
        // 注意：上面的 memchunks 清理在这个 early-return 之前，
        // 否则「计数恰好没变」的会话就会漏掉清理
        if (meta.messageCount === count && meta.nextSeq >= nextSeq) continue
        meta.messageCount = count
        // 只增不减 —— seq 复用会让游标与分页错乱（见 messages 仓储开头的说明）
        meta.nextSeq = Math.max(meta.nextSeq, nextSeq)
        await db.put('chats', toPlain(meta))
      } catch (e) {
        skip('chats', e)
      }
    }
  }

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
