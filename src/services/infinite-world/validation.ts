/**
 * 世界与存档校验。
 *
 * ## ⚠️ 拆成两段是有原因的，别再合回去
 *
 * **形状校验**（`validateWorldShape` / `validateSaveShape`）只看字段：名称、ID、
 * 数值区间、关系是否成对。纯同步、不碰地形，**可以安全地在 IDB 事务内调用**。
 *
 * **落点校验**（`validatePlacement`）要知道「这一格能不能走」，因此需要一整张
 * 已生成的 WorldGrid。它**只能在事务外**调用。
 *
 * 原实现把两者混在一起：`validateSave` 里直接 `createTerrain(world)`，
 * 而 `gameworlds.ts` 在**已打开的 readwrite 事务内部**调它。今天靠
 * 「那个采样器是同步且便宜的」侥幸不炸；换成需要 await 或耗时的生成器，
 * 事务会静默自动提交或卡死 —— 而且症状是「存档偶尔丢失」，极难定位。
 *
 * ⚠️ 另一条：**绝不要收紧 `validPosition`**。它跑在每一次
 * `validateSave` 上，收紧了会让已有存档直接打不开，而用户没有任何自救路径。
 * 新的环面约束走 `validTorusPosition`，只给新生成器用。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { USER_NODE_ID } from '@/types/group'
import type { GameWorld, WorldSave } from '@/types/infiniteWorld'
import { WORLD_SIZE } from './core/constants'
import { Flag, type WorldGrid } from './generation/grid'
import { WORLD_LIMIT } from './generation/terrain'

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

/**
 * 宽松的坐标合法性。⚠️ 见文件头：不要收紧它。
 */
export function validPosition(p: unknown): p is [number, number] {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    p.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= WORLD_LIMIT)
  )
}

/** 环面坐标：必须落在 [0, 512)。只给 torus-1 用 */
export function validTorusPosition(p: unknown): p is [number, number] {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    p.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < WORLD_SIZE)
  )
}

/** 纯形状校验。不碰地形，事务内调用是安全的 */
export function validateWorldShape(world: GameWorld): void {
  check(world && typeof world.id === 'string' && world.id, '世界缺少 ID。')
  check(typeof world.name === 'string' && world.name.trim(), '请填写世界名称。')
  check(typeof world.seed === 'string' && world.seed.trim(), '请填写世界种子。')
  check(typeof world.lore?.premise === 'string' && world.lore.premise.trim(), '请填写世界背景。')
  check(typeof world.player?.name === 'string' && world.player.name.trim(), '请填写玩家名字。')
  check(
    Number.isFinite(world.createdAt) && Number.isFinite(world.updatedAt),
    '世界时间格式不正确。',
  )
  const s = world.settings
  check(
    s && Number.isFinite(s.dayMinutes) && s.dayMinutes >= 5 && s.dayMinutes <= 120,
    '一天时长应在 5～120 分钟之间。',
  )
  check(
    [s.fieldDensity, s.forestDensity, s.waterRatio].every(
      (v) => Number.isFinite(v) && v >= 0 && v <= 1,
    ),
    '生态比例应在 0～100% 之间。',
  )
  check(Number.isInteger(s.season) && s.season >= 0 && s.season <= 3, '请选择有效季节。')
  check(validPosition(world.player.spawn), '出生地点坐标无效。')
  check(Array.isArray(world.npcs) && Array.isArray(world.relations), '居民或关系数据不完整。')

  const ids = new Set([USER_NODE_ID])
  for (const npc of world.npcs) {
    check(
      npc && typeof npc.npcId === 'string' && npc.npcId && !ids.has(npc.npcId),
      '居民 ID 重复或缺失。',
    )
    check(typeof npc.name === 'string' && npc.name.trim(), '请填写居民名字。')
    check(validPosition(npc.home), '居民住处坐标无效。')
    ids.add(npc.npcId)
  }

  const pairs = new Set<string>()
  const relationIds = new Set<string>()
  for (const r of world.relations) {
    check(r && typeof r.id === 'string' && r.id && !relationIds.has(r.id), '关系 ID 重复或缺失。')
    check(
      ids.has(r.from) && ids.has(r.to) && r.from !== r.to,
      '关系必须连接两个不同的现有居民或玩家。',
    )
    const pair = JSON.stringify([r.from, r.to])
    check(!pairs.has(pair), '两个节点之间的同向关系重复。')
    check(typeof r.label === 'string' && r.label.trim(), '请填写关系名称。')
    check(
      Number.isFinite(r.score) &&
        r.score >= -100 &&
        r.score <= 100 &&
        Number.isFinite(r.trust) &&
        r.trust >= 0 &&
        r.trust <= 100,
      '好感应在 -100～100，信任应在 0～100。',
    )
    pairs.add(pair)
    relationIds.add(r.id)
  }
}

export function validateSaveShape(save: WorldSave, world: GameWorld): void {
  check(
    save && typeof save.id === 'string' && save.id && save.worldId === world.id,
    '存档与世界不匹配。',
  )
  check(Number.isInteger(save.revision) && save.revision >= 0, '存档版本无效。')
  check(
    Number.isInteger(save.day) &&
      save.day >= 1 &&
      Number.isFinite(save.minute) &&
      save.minute >= 0 &&
      save.minute < 1440,
    '存档日期无效。',
  )
  check(validPosition(save.playerPosition), '存档位置坐标无效。')
  check(
    Number.isFinite(save.stamina) &&
      save.stamina >= 0 &&
      save.stamina <= 100 &&
      Number.isFinite(save.money) &&
      save.money >= 0,
    '存档资源数值无效。',
  )
  check(
    save.inventory && Object.values(save.inventory).every((n) => Number.isInteger(n) && n >= 0),
    '背包数量无效。',
  )
  check(
    ['clear', 'rain', 'storm'].includes(save.weather) && Number.isFinite(save.updatedAt),
    '存档天气或时间无效。',
  )
}

/**
 * 落点校验：需要一整张已生成的 grid。
 *
 * ⚠️ **只能在 IDB 事务外调用**。见文件头。
 */
export function validatePlacement(world: GameWorld, grid: WorldGrid): void {
  const walkable = (p: readonly [number, number]) => {
    const x = ((Math.floor(p[0]) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
    const y = ((Math.floor(p[1]) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
    return (grid.flags[y * WORLD_SIZE + x]! & Flag.Walkable) !== 0
  }
  check(validTorusPosition(world.player.spawn) && walkable(world.player.spawn), '出生地点不可通行。')
  for (const npc of world.npcs) {
    check(validTorusPosition(npc.home) && walkable(npc.home), `居民「${npc.name}」的住处不可通行。`)
    // ⚠️ 必须与出生点同连通域，否则创建时一切正常，
    // 进游戏后那个居民永远走不到任何地方
    const home = regionOf(grid, npc.home)
    const spawn = regionOf(grid, world.player.spawn)
    check(home !== 0 && home === spawn, `居民「${npc.name}」被水或山挡在了出生点到不了的地方。`)
  }
}

function regionOf(grid: WorldGrid, p: readonly [number, number]): number {
  const x = ((Math.floor(p[0]) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
  const y = ((Math.floor(p[1]) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
  return grid.region[y * WORLD_SIZE + x]!
}

// ── 兼容旧调用点 ──
// ⚠️ 这两个别名故意只做**形状**校验。原来的同名函数会连带做落点校验，
// 而那需要地形 —— 正是它把 createTerrain 拖进了 IDB 事务里。
// 调用方若需要落点校验，必须显式在事务外调 validatePlacement。
export const validateWorld = validateWorldShape
export const validateSave = validateSaveShape
