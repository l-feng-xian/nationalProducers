/**
 * API Key 等敏感值独立存放，好处：导出设置时天然不泄漏密钥。
 * 目前明文存 IndexedDB（与浏览器同源隔离等价）；将来若要加 passphrase 加密，
 * 只需改这一个文件。
 */

import { getDb } from '../schema'

export async function get(ref: string): Promise<string> {
  const db = await getDb()
  const rec = await db.get('secrets', ref)
  return rec?.value ?? ''
}

export async function set(ref: string, value: string): Promise<void> {
  const db = await getDb()
  await db.put('secrets', { ref, value })
}

export async function remove(ref: string): Promise<void> {
  const db = await getDb()
  await db.delete('secrets', ref)
}
