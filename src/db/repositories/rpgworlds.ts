/**
 * RPG 世界存档仓储。
 *
 * 存档很小（只有种子、玩家位置、人设与 NPC，地形是算出来的），
 * 所以整取整存即可，不需要像 messages 那样做分页与区间删除。
 */

import { getDb } from '../schema'
import { toPlain } from '../plain'
import {
  DEFAULT_TIME_SCALE,
  emptyWorld,
  normalizeGen,
  type RpgNpc,
  type RpgWorld,
} from '@/types/rpg'

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

/**
 * 数字兜底。**数字字符串按数字收**（`"12"` → 12）——
 * 导出这份数据的可能是别的工具、也可能是手改的，把坐标写成字符串太常见了；
 * 一律丢成 0 等于把 NPC 全堆到世界原点，比保留原意糟得多。
 * 真正没救的（`null`/`"abc"`/`{}`/NaN）才落到 d。
 */
const num = (v: unknown, d: number): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : d
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return d
}

/**
 * 一个 NPC 的兜底。返回 null 表示这条记录救不回来，整条丢掉。
 *
 * ⚠️ 这一层是必须的，不是防御性编程洁癖。`normalize` 原先只查了 `Array.isArray(w.npcs)`，
 * 数组**里面**一个字段都没看过，而消费方全都是裸取：
 *  - 缺 `id` → `fnv1a(npc.id)` 读 `undefined.length` 抛在 `createEngine` 里，
 *    **整个世界渲染不出来**，报错还写成「渲染器启动失败」，指向完全无关的 GPU；
 *  - `x` 是字符串 → `n.x + 0.5` 是字符串拼接，几帧后变成 NaN 并**被落盘**，
 *    NPC 从此隐形、够不着，连它原来站在哪都被覆盖掉了；
 *  - 缺 `description` → `resolveNpc` 里 `.trim()` 抛在 **rAF 回调**内，
 *    而 `tick` 没有 try/catch、重新排 rAF 在它后面 —— 画面就地永久冻结；
 *  - `routine` 只有一半（有 pois 没 slots）→ `slotIndexAt` 同样抛在 rAF 里。
 *    注意 `if (!n.routine)` 这种存在性检查**挡不住半个对象**。
 */
function normalizeNpc(raw: unknown): RpgNpc | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Partial<RpgNpc>
  // id 是身份，编不出来 —— 没有就只能丢
  if (typeof n.id !== 'string' || !n.id) return null
  const out: RpgNpc = {
    id: n.id,
    x: Math.floor(num(n.x, 0)),
    y: Math.floor(num(n.y, 0)),
    name: str(n.name),
    description: str(n.description),
  }
  if (typeof n.characterId === 'string') out.characterId = n.characterId
  if (typeof n.chatId === 'string') out.chatId = n.chatId
  if (typeof n.homeX === 'number' && Number.isFinite(n.homeX)) out.homeX = Math.floor(n.homeX)
  if (typeof n.homeY === 'number' && Number.isFinite(n.homeY)) out.homeY = Math.floor(n.homeY)
  if (typeof n.roamR === 'number' && Number.isFinite(n.roamR) && n.roamR > 0) out.roamR = n.roamR
  // 作息要么完整、要么整个丢掉让引擎重推 —— 半个对象比没有更危险
  const r = n.routine
  if (r && Array.isArray(r.pois) && Array.isArray(r.slots) && r.pois.length) {
    out.routine = {
      kind: r.kind,
      pois: r.pois.map((p) => ({
        x: Math.floor(num(p?.x, 0)),
        y: Math.floor(num(p?.y, 0)),
        label: str(p?.label, '某处'),
        act: str(p?.act, '待着'),
        r: num(p?.r, 2),
      })),
      slots: r.slots.map((s) => ({ from: num(s?.from, 0), poi: Math.floor(num(s?.poi, 0)) })),
    }
  }
  return out
}

/**
 * 补齐可能缺失的字段。
 *
 * 导入备份走的是 `db.put(store, toPlain(row))` **零校验原样回写**，
 * 所以一份手工改过、或由旧版本导出的记录完全可能没有 npcs / persona。
 * 读路径统一过一遍，消费方就不必各自防御（与 groups.ts 的 normalize 同一套路）。
 */
function normalize(w: RpgWorld): RpgWorld {
  // ⚠️ 不只是「是不是数组」，每一条都要过一遍 —— 见 normalizeNpc
  w.npcs = Array.isArray(w.npcs)
    ? w.npcs.map(normalizeNpc).filter((n): n is RpgNpc => n !== null)
    : []
  // ⚠️ persona 也要看**形状**，不能只看存在。`{description:'…'}` 这种半个对象是
  // 真的：RpgPlayView 的 send() 第一行就是 `w.persona.name.trim()`，抛在 try 之前，
  // 表现是「按发送毫无反应」，连用户自己那句都不会出现，且没有任何报错
  w.persona = {
    name: str(w.persona?.name),
    description: str(w.persona?.description),
  }
  // 世界简介是后加的字段，本模块上线前存的世界都没有它
  if (typeof w.description !== 'string') w.description = ''
  // 地形参数同样是后加的。逐字段兜底成 LEGACY_GEN —— 也就是参数化之前那版
  // 生成器的行为，老世界因此逐格不变。⚠️ 这里是整个向后兼容故事的落点
  w.gen = normalizeGen(w.gen)
  // 时钟是后加的字段。⚠️ 回填成第 0 天 08:00 而不是 0（午夜）——
  // 老存档一进去就是一片漆黑，用户只会以为渲染坏了
  if (typeof w.worldMinutes !== 'number' || !Number.isFinite(w.worldMinutes)) w.worldMinutes = 480
  if (typeof w.timeScale !== 'number' || !(w.timeScale >= 0)) w.timeScale = DEFAULT_TIME_SCALE
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
