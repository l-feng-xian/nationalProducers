/**
 * NPC 仿真：按日程在 home / work 之间生活。
 *
 * ## 日程是隐式的，不写死坐标
 * 每个职业给一对上下班时刻。到点了 NPC 的**目标**就从 home 切到 work（或反之），
 * 它自己走过去 —— 通勤是「走路要花时间」自然涌现的，不需要显式 commute 段。
 *
 * ## 三档 LOD（按到玩家的环面距离）
 *   0  ≤48 格：A* 寻路 + 沿路行走（看得清，要好看）
 *   1  48–128：直线朝目标挪（省掉 A*）
 *   2  >128  ：直接吸附到目标（离屏，怎么跳都看不见）
 * 且**全局每步最多一次 A***：远处几十个 NPC 同时要寻路也不会卡帧。
 *
 * ## ⚠️ 选址必须与出生点同连通域
 * 全图有几百个连通域，多数是被树围死的小口袋。work 一旦落在别的域，
 * NPC 永远走不到，会贴着域边界来回蹭。所以 work 一律在 home 的域里搜。
 *
 * ## ⚠️ 沿路径移动必须用 torus.delta 求方向
 * 直接 `target - pos` 在跨缝处会让 NPC 朝反方向跑 511 格。
 *
 * 纯 service：不 import three/vue/pinia。
 */

import { WORLD_SIZE } from '../core/constants'
import { delta, wrap } from '../core/torus'
import { Flag, type WorldGrid } from '../generation/grid'
import { BIOMES } from '@/types/infiniteWorld'
import type { NpcBlueprint } from '@/types/infiniteWorld'
import { findPath, type Point, type ReachabilityOracle, type Sampler } from '../navigation/path'
import type { TerrainTile } from '../generation/terrain'

/** LOD 距离阈值（格） */
const LOD0 = 48
const LOD1 = 128
/** 到目标多近算「到了」 */
const ARRIVE = 0.6
/** 一步最多推进多少秒（切后台回来别一次冲太远） */
const MAX_DT = 0.25

interface JobHours {
  start: number
  end: number
}

/** 职业 → 上下班时刻（分钟）。关键词匹配，兜底通用 */
function jobHours(profession: string): JobHours {
  const p = profession || ''
  if (/农|田|farm/i.test(p)) return { start: 6 * 60, end: 18 * 60 }
  if (/店|商|铺|shop|keep/i.test(p)) return { start: 8 * 60, end: 19 * 60 }
  if (/林|猎|巡|forest|ranger/i.test(p)) return { start: 7 * 60, end: 17 * 60 }
  if (/渔|fish/i.test(p)) return { start: 5 * 60, end: 15 * 60 }
  return { start: 8 * 60, end: 17 * 60 }
}

export interface NpcRuntime {
  id: string
  /** 挑哪个村民精灵（由帧名决定，渲染层解析） */
  variant: number
  /** 当前位置（环面绝对坐标，格心系，含小数） */
  x: number
  y: number
  home: Point
  work: Point
  hours: JobHours
  speed: number
  /** 当前路径（findPath 结果，格心坐标），空表示不在寻路 */
  path: Point[]
  pathIdx: number
  /** 上次请求寻路时的目标，避免同一目标反复重算 */
  pathTarget: Point | null
  state: 'home' | 'work' | 'commute'
  /** 朝向（-1 左 / 1 右），给精灵翻转用 */
  face: number
}

export interface NpcSim {
  readonly npcs: NpcRuntime[]
  /** 推进仿真。minute=当前世界分钟，(px,py)=玩家位置 */
  step(dt: number, minute: number, px: number, py: number): void
}

function idxOf(x: number, y: number): number {
  return wrap(Math.round(y)) * WORLD_SIZE + wrap(Math.round(x))
}

export function createNpcSim(grid: WorldGrid, blueprints: NpcBlueprint[]): NpcSim {
  const sampler: Sampler = (x, y) => {
    const i = idxOf(x, y)
    return {
      biome: BIOMES[grid.biome[i]!] ?? 'wild',
      height: grid.elevation[i]!,
      walkable: (grid.flags[i]! & Flag.Walkable) !== 0,
      bridge: (grid.flags[i]! & Flag.Bridge) !== 0,
    } as TerrainTile
  }
  // 连通域预言机直接查 grid.region（已算好），O(1) 否决不可达目标
  const oracle: ReachabilityOracle = {
    connected: (ax, ay, bx, by) => {
      const ra = grid.region[idxOf(ax, ay)]!
      const rb = grid.region[idxOf(bx, by)]!
      return ra !== 0 && ra === rb
    },
  }

  const npcs: NpcRuntime[] = blueprints.map((bp) => {
    const home: Point = [bp.home[0] + 0.5, bp.home[1] + 0.5]
    const work = pickWork(grid, bp.home, bp.work)
    return {
      id: bp.npcId,
      variant: hashStr(bp.npcId) % 4,
      x: home[0],
      y: home[1],
      home,
      work,
      hours: jobHours(bp.profession),
      speed: bp.speed > 0 ? bp.speed : 2,
      path: [],
      pathIdx: 0,
      pathTarget: null,
      state: 'home',
      face: 1,
    }
  })

  /** 这一刻该在哪 */
  function desiredOf(n: NpcRuntime, minute: number): Point {
    return minute >= n.hours.start && minute < n.hours.end ? n.work : n.home
  }

  /** 全局每步一次 A* 的令牌 */
  let pathBudget = 1

  function step(dt: number, minute: number, px: number, py: number): void {
    dt = Math.min(MAX_DT, dt)
    pathBudget = 1
    // 近的先仿真：LOD0 的 A* 名额优先给最靠近玩家的
    const order = npcs
      .map((n, i) => ({ i, d2: torusD2(n.x, n.y, px, py) }))
      .sort((a, b) => a.d2 - b.d2)

    for (const { i, d2 } of order) {
      const n = npcs[i]!
      const want = desiredOf(n, minute)
      n.state = want === n.work ? 'work' : 'home'
      const dist = Math.sqrt(d2)

      // ── LOD2：离屏，直接吸附目标 ──
      if (dist > LOD1) {
        n.x = want[0]
        n.y = want[1]
        n.path = []
        n.pathTarget = null
        continue
      }

      // 已经到目标附近：停下
      if (torusD2(n.x, n.y, want[0], want[1]) <= ARRIVE * ARRIVE) {
        n.path = []
        n.pathTarget = null
        continue
      }

      // ── LOD1：直线朝目标挪，不寻路 ──
      if (dist > LOD0) {
        moveToward(n, want[0], want[1], dt)
        continue
      }

      // ── LOD0：A* 沿路走 ──
      const needRepath =
        n.path.length === 0 ||
        !n.pathTarget ||
        torusD2(n.pathTarget[0], n.pathTarget[1], want[0], want[1]) > 1
      if (needRepath && pathBudget > 0) {
        pathBudget--
        const p = findPath(sampler, [n.x, n.y], want, { budget: 2500, reach: oracle })
        n.path = p
        n.pathIdx = 0
        n.pathTarget = [want[0], want[1]]
      }

      if (n.path.length > 0) {
        const wp = n.path[Math.min(n.pathIdx, n.path.length - 1)]!
        if (torusD2(n.x, n.y, wp[0], wp[1]) <= ARRIVE * ARRIVE && n.pathIdx < n.path.length - 1) {
          n.pathIdx++
        }
        const t = n.path[Math.min(n.pathIdx, n.path.length - 1)]!
        moveToward(n, t[0], t[1], dt)
      } else {
        // 没路（还没轮到寻路，或目标不可达）：慢慢朝目标直线蹭
        moveToward(n, want[0], want[1], dt * 0.5)
      }
    }
  }

  function moveToward(n: NpcRuntime, tx: number, ty: number, dt: number): void {
    const dx = delta(n.x, tx)
    const dy = delta(n.y, ty)
    const len = Math.hypot(dx, dy)
    if (len < 1e-4) return
    const stepLen = Math.min(len, n.speed * dt)
    n.x = wrap(n.x + (dx / len) * stepLen)
    n.y = wrap(n.y + (dy / len) * stepLen)
    if (Math.abs(dx) > 0.02) n.face = dx > 0 ? 1 : -1
  }

  return { npcs, step }
}

/** 在 home 的连通域里、靠近某个镇、离家有点距离的可走格当作工作点 */
function pickWork(grid: WorldGrid, home: [number, number], explicit?: [number, number]): Point {
  if (explicit) return [explicit[0] + 0.5, explicit[1] + 0.5]
  const region = grid.region[idxOf(home[0], home[1])]!
  // 找 home 所在域里最近的镇
  let town = grid.towns[0]
  let best = Infinity
  for (const t of grid.towns) {
    if (grid.region[idxOf(t.cx, t.cy)] !== region) continue
    const d = torusD2(t.cx, t.cy, home[0], home[1])
    if (d < best) {
      best = d
      town = t
    }
  }
  if (town) {
    // 镇口附近、离家 ≥3 格的可走非建筑格
    for (let r = 2; r <= 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const x = wrap(town.cx + dx)
          const y = wrap(town.cy + dy)
          const i = y * WORLD_SIZE + x
          if (grid.region[i] !== region) continue
          if (!(grid.flags[i]! & Flag.Walkable)) continue
          if (grid.flags[i]! & Flag.Building) continue
          if (torusD2(x, y, home[0], home[1]) < 9) continue
          return [x + 0.5, y + 0.5]
        }
      }
    }
  }
  // 兜底：工作即在家
  return [home[0] + 0.5, home[1] + 0.5]
}

function torusD2(ax: number, ay: number, bx: number, by: number): number {
  const dx = delta(ax, bx)
  const dy = delta(ay, by)
  return dx * dx + dy * dy
}

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
