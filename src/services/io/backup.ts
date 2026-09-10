/**
 * 整库导入导出。
 *
 * 头像等 Blob 转成 base64 data URL 以便塞进 JSON；
 * API Key（secrets）**刻意不导出**，避免用户把备份发给别人时泄漏密钥。
 */

import { getDb } from '@/db/schema'
import { toPlain } from '@/utils/plain'

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

export async function exportAll(): Promise<Blob> {
  const db = await getDb()
  const blobRecs = await db.getAll('blobs')
  const blobs: BackupFile['blobs'] = []
  for (const b of blobRecs) {
    blobs.push({ id: b.id, mime: b.mime, dataUrl: await blobToDataUrl(b.data) })
  }
  const file: BackupFile = {
    format: 'nationalproducers-backup',
    version: 1,
    exportedAt: Date.now(),
    settings: (await db.get('settings', 'app')) ?? null,
    characters: await db.getAll('characters'),
    worldbooks: await db.getAll('worldbooks'),
    groups: await db.getAll('groups'),
    chats: await db.getAll('chats'),
    messages: await db.getAll('messages'),
    blobs,
    // 注意：secrets（API Key）不导出
  }
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
  await bulk('chats', file.chats ?? [])
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
