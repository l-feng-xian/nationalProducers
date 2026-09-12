/**
 * RPG 世界存档仓储。
 *
 * 存档很小（只有种子、玩家位置、人设与 NPC，地形是算出来的），
 * 所以整取整存即可，不需要像 messages 那样做分页与区间删除。
 */

import { getDb } from '../schema'
import { toPlain } from '../plain'
import { emptyWorld, normalizeGen, type RpgWorld } from '@/types/rpg'

/**
 * 补齐可能缺失的字段。
 *
 * 导入备份走的是 `db.put(store, toPlain(row))` **零校验原样回写**，
 * 所以一份手工改过、或由旧版本导出的记录完全可能没有 npcs / persona。
 * 读路径统一过一遍，消费方就不必各自防御（与 groups.ts 的 normalize 同一套路）。
 */
function normalize(w: RpgWorld): RpgWorld {
  if (!Array.isArray(w.npcs)) w.npcs = []
  if (!w.persona) w.persona = { name: '', description: '' }
  // 世界简介是后加的字段，本模块上线前存的世界都没有它
  if (typeof w.description !== 'string') w.description = ''
  // 地形参数同样是后加的。逐字段兜底成 LEGACY_GEN —— 也就是参数化之前那版
  // 生成器的行为，老世界因此逐格不变。⚠️ 这里是整个向后兼容故事的落点
  w.gen = normalizeGen(w.gen)
  return w
}

export async function list(): Promise<RpgWorld[]> {
  const db = await getDb()
  const rows = await db.getAllFromIndex('rpgworlds', 'by_updatedAt')
  return rows.reverse().map(normalize)
}

export async function get(id: string): Promise<RpgWorld | undefined> {
  const db = await getDb()
  const w = await db.get('rpgworlds', id)
  return w ? normalize(w) : undefined
}

export async function create(name = '新世界', seed?: number): Promise<RpgWorld> {
  const w = emptyWorld(crypto.randomUUID(), name, seed)
  const db = await getDb()
  await db.put('rpgworlds', toPlain(w))
  return w
}

export async function save(w: RpgWorld): Promise<void> {
  w.updatedAt = Date.now()
  const db = await getDb()
  // ⚠️ 必须 toPlain：w 多半来自 Pinia，响应式代理无法结构化克隆，
  // db.put 会静默失败（整个持久化都不生效且不报错）
  await db.put('rpgworlds', toPlain(w))
}

export async function remove(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('rpgworlds', id)
}
