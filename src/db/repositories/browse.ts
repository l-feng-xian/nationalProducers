/**
 * 数据管理页「其他数据表」的浏览层。
 *
 * 这个页面面对的是「可能已经很大的库」：消息几万条、向量块几 MB、
 * 世界书 / 无限世界单行可能几 MB。所以这里的一切查询都必须：
 *   1. 走游标分页（keyset，主键升序），绝不 getAll 全表；
 *   2. 行数据轻量化 —— 剥离正文、条目、NPC 蓝图、二进制，只留列表要展示的字段；
 *   3. JSON 详情按主键单行取（getStoreRow），列表不拖着全量数据。
 */
import { getDb, chatRange } from '../schema'
import { collectBlobRefs } from './blobs'

/** 数据管理页允许浏览的六张表。messages / memchunks 走会话级，settings 有专门页面 */
export type BrowseStore = 'characters' | 'groups' | 'worldbooks' | 'gameworlds' | 'blobs' | 'secrets'

/** 各表数据列的标签与格式；顺序与 BrowseRow.cols 一一对应 */
export const BROWSE_COLUMNS: Record<BrowseStore, { label: string; kind?: 'bytes' }[]> = {
  characters: [
    { label: '世界书' },
    { label: '图片' },
  ],
  groups: [{ label: '成员' }, { label: '关系' }, { label: '头像', kind: undefined }],
  worldbooks: [{ label: '条目' }],
  gameworlds: [{ label: 'NPC' }],
  blobs: [{ label: '类型' }, { label: '大小', kind: 'bytes' }],
  secrets: [{ label: '值' }, { label: '长度' }],
}

export interface BrowseRow {
  /** 主键（删除 / 详情都用它） */
  key: string
  /** 主标签：名称 / ref / id 缩写 */
  title: string
  /** 数据列的值，顺序与 BROWSE_COLUMNS[store] 一一对应 */
  cols: (string | number)[]
  /** 更新时间（blobs 是创建时间），统一渲染成行尾的「更新时间」列 */
  at?: number
}

export interface BrowsePage {
  rows: BrowseRow[]
  hasMore: boolean
  /** 下一页的 keyset 起点：本页最后一行的主键 */
  nextKey: string | undefined
}

/** 每张表的行轻量化：只留列表要展示的字段，大字段在这里就被丢掉 */
function lighten(store: BrowseStore, value: unknown): BrowseRow {
  switch (store) {
    case 'characters': {
      const c = value as {
        id: string
        data: { name: string }
        favIdx?: number
        worldBookIds?: string[]
        avatarBlobId?: string
        depthBlobId?: string
        updatedAt: number
      }
      const images = (c.avatarBlobId ? 1 : 0) + (c.depthBlobId ? 1 : 0)
      return {
        key: c.id,
        title: c.data?.name || '（未命名）',
        cols: [c.worldBookIds?.length ?? 0, images],
        at: c.updatedAt,
      }
    }
    case 'groups': {
      const g = value as {
        id: string
        name: string
        members?: string[]
        relations?: unknown[]
        avatarBlobId?: string
        updatedAt: number
      }
      return {
        key: g.id,
        title: g.name || '（未命名）',
        cols: [g.members?.length ?? 0, g.relations?.length ?? 0, g.avatarBlobId ? '有' : '—'],
        at: g.updatedAt,
      }
    }
    case 'worldbooks': {
      const w = value as {
        id: string
        name: string
        entries?: Record<string, unknown>
        updatedAt: number
      }
      return {
        key: w.id,
        title: w.name || '（未命名）',
        cols: [Object.keys(w.entries ?? {}).length],
        at: w.updatedAt,
      }
    }
    case 'gameworlds': {
      const w = value as { id: string; name: string; npcs?: unknown[]; updatedAt: number }
      return {
        key: w.id,
        title: w.name || '（未命名）',
        cols: [w.npcs?.length ?? 0],
        at: w.updatedAt,
      }
    }
    case 'blobs': {
      // 绝不把 data Blob 带进列表 —— 只留元数据，预览走 blobsRepo.get 单取
      const b = value as { id: string; mime: string; size: number; createdAt: number }
      return {
        key: b.id,
        title: `${b.id.slice(0, 8)}…`,
        cols: [b.mime || 'application/octet-stream', b.size],
        at: b.createdAt,
      }
    }
    case 'secrets': {
      const s = value as { ref: string; value: string }
      const v = s.value ?? ''
      const masked = v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`
      return { key: s.ref, title: s.ref, cols: [masked, v.length] }
    }
  }
}

/**
 * 通用游标分页（主键升序 keyset）。
 *
 * before 传上一页的 nextKey（排他）。多取一行判断 hasMore，
 * 页大小固定 50 —— 数据管理页不提供「全量加载」这条路。
 */
export async function browseStore(
  store: BrowseStore,
  opts: { limit?: number; before?: string } = {},
): Promise<BrowsePage> {
  const limit = opts.limit ?? 50
  const db = await getDb()
  const range = opts.before ? IDBKeyRange.lowerBound(opts.before, true) : undefined
  const rows: BrowseRow[] = []
  let nextKey: string | undefined
  let cursor = await db.transaction(store).store.openCursor(range)
  while (cursor) {
    if (rows.length >= limit) break
    rows.push(lighten(store, cursor.value))
    nextKey = String(cursor.key)
    cursor = await cursor.continue()
  }
  return { rows, hasMore: cursor !== null, nextKey: cursor === null ? undefined : nextKey }
}

export async function countStore(store: BrowseStore): Promise<number> {
  const db = await getDb()
  return db.count(store)
}

/** JSON 详情按主键单行取全量。blobs 走 blobsRepo（二进制要预览不是 JSON） */
export async function getStoreRow(
  store: Exclude<BrowseStore, 'blobs'>,
  key: string,
): Promise<unknown> {
  const db = await getDb()
  return db.get(store, key)
}

/**
 * 全库可达的图片 id 集（与 gc 同源的引用面，但不删除）。
 * 图片表用它标注「未引用 / 被引用」，决定单行删除的安全性。
 */
export async function referencedBlobIds(): Promise<Set<string>> {
  const db = await getDb()
  return collectBlobRefs({
    characters: await db.getAll('characters'),
    messages: await db.getAll('messages'),
    groups: await db.getAll('groups'),
    gameworlds: await db.getAll('gameworlds'),
    persona: (await db.get('settings', 'app'))?.persona,
  })
}

/**
 * 单游标扫一遍会话消息，收集图片引用（供会话展开的「图片」子表）。
 * 返回 Map<blobId, 引用次数>；force_avatar 与 images[].blobId 都算。
 */
export async function chatBlobRefs(chatId: string): Promise<Map<string, number>> {
  const db = await getDb()
  const out = new Map<string, number>()
  let cursor = await db.transaction('messages').store.openCursor(chatRange(chatId))
  while (cursor) {
    const m = cursor.value as { force_avatar?: string; images?: { blobId?: string }[] }
    if (m.force_avatar) out.set(m.force_avatar, (out.get(m.force_avatar) ?? 0) + 1)
    for (const img of m.images ?? [])
      if (img.blobId) out.set(img.blobId, (out.get(img.blobId) ?? 0) + 1)
    cursor = await cursor.continue()
  }
  return out
}
