/**
 * 路网与桥梁：在代价场上跑 A*，而不是两点之间画直线。
 *
 * ## 为什么不画直线
 * 直线 + 小幅摆动做出来的路「像是用尺子画的」：它会笔直地爬上陡坡、
 * 笔直地插进湖里再架一座横跨全湖的桥。而真实的路是**顺着地形走**的。
 *
 * 换成 A* 之后，这些都是代价场的自然结果，不需要任何特例：
 *   - 坡度贵      → 路沿河谷和缓坡绕行
 *   - 水面很贵但有限 → 路自己找河最窄的地方过去，桥自然短
 *   - **已有路面便宜** → 后修的路会并进已有干道，路网收敛成主干+支线
 *     （这一条是「看起来像人修的」的关键；少了它每条边都是独立线段）
 *
 * 顺带解决了直线版 30% 的边连不通 —— A* 会绕路，而不是遇水就放弃。
 *
 * ## ⚠️ 补环边时必须要求两镇够远
 * 两个贴脸的镇之间那条边会整段落在它们各自的影响圈里，
 * 结果那个镇在 MST 里「连通」却一条看得见的路都没有。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { WORLD_SIZE } from '../core/constants'
import { torusDist, wrapTile } from '../core/torus'
import { findPath, type Sampler } from '../navigation/path'
import { WATER } from './hydrology'
import type { Town } from './settlement'

const N = WORLD_SIZE * WORLD_SIZE

export interface Bridge {
  cells: Int32Array
  span: number
}

export interface RoadNetwork {
  road: Uint8Array
  bridge: Uint8Array
  bridges: Bridge[]
  links: { a: number; b: number; ok: boolean }[]
}

export interface RoadParams {
  towns: readonly Town[]
  water: Uint8Array
  elevation: Float32Array
  /** 城镇掩码：镇内走村道，代价低 */
  townMask: Uint8Array
}

/** 坡度惩罚系数。越大路越贴着等高线绕 */
const SLOPE_PENALTY = 260
/** 过水的代价。必须有限 —— 无穷就退化成「绕开所有水」，永远不架桥 */
const WATER_COST = 26
/** 深水比浅水更贵，让桥优先架在浅滩 */
const DEEP_EXTRA = 14
/** 已有路面的代价。低于 1 才会产生「并线」效果 */
const EXISTING_ROAD_COST = 0.35
/** 镇内代价 */
const TOWN_COST = 0.5
/** 单座桥的最大跨度。超过就说明 A* 选错了渡口，放弃这条边 */
const MAX_BRIDGE_SPAN = 8

export function buildRoads(p: RoadParams): RoadNetwork {
  const road = new Uint8Array(N)
  const bridge = new Uint8Array(N)
  const bridges: Bridge[] = []
  const links: { a: number; b: number; ok: boolean }[] = []
  const towns = p.towns
  if (towns.length < 2) return { road, bridge, bridges, links }

  // 镇内路面预先铺好，A* 才知道「进了镇就便宜」
  for (const t of towns) {
    for (let i = 0; i < t.paths.length; i += 2) road[t.paths[i + 1]! * WORLD_SIZE + t.paths[i]!] = 1
    for (let i = 0; i < t.plaza.length; i += 2) road[t.plaza[i + 1]! * WORLD_SIZE + t.plaza[i]!] = 1
  }

  // 坡度预计算：四邻最大高差
  const slope = new Float32Array(N)
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const i = y * WORLD_SIZE + x
      const h = p.elevation[i]!
      let s = 0
      s = Math.max(s, Math.abs(p.elevation[y * WORLD_SIZE + wrapTile(x + 1)]! - h))
      s = Math.max(s, Math.abs(p.elevation[y * WORLD_SIZE + wrapTile(x - 1)]! - h))
      s = Math.max(s, Math.abs(p.elevation[wrapTile(y + 1) * WORLD_SIZE + x]! - h))
      s = Math.max(s, Math.abs(p.elevation[wrapTile(y - 1) * WORLD_SIZE + x]! - h))
      slope[i] = s
    }
  }

  // findPath 要一个 Sampler，但这里的通行性完全由 costOf 决定，
  // 所以给一个恒定桩，配 ignoreWalkable
  const STUB = { biome: 'wild' as const, height: 0, walkable: true, bridge: false }
  const sample: Sampler = () => STUB

  const costOf = (_t: unknown, x: number, y: number): number => {
    const i = y * WORLD_SIZE + x
    if (road[i]) return EXISTING_ROAD_COST
    if (p.townMask[i]) return TOWN_COST
    const w = p.water[i]!
    if (w !== WATER.none) return WATER_COST + (w === WATER.deep ? DEEP_EXTRA : 0)
    return 1 + slope[i]! * SLOPE_PENALTY
  }

  // ── Prim MST（同距离按索引序破平，保证确定性）──
  const inTree = new Uint8Array(towns.length)
  const edges: [number, number][] = []
  inTree[0] = 1
  for (let added = 1; added < towns.length; added++) {
    let bestA = -1
    let bestB = -1
    let bestD = Infinity
    for (let i = 0; i < towns.length; i++) {
      if (!inTree[i]) continue
      for (let j = 0; j < towns.length; j++) {
        if (inTree[j]) continue
        const d = torusDist(towns[i]!.cx, towns[i]!.cy, towns[j]!.cx, towns[j]!.cy)
        if (d < bestD - 1e-9) {
          bestD = d
          bestA = i
          bestB = j
        }
      }
    }
    if (bestA < 0) break
    inTree[bestB] = 1
    edges.push([bestA, bestB])
  }

  // ── 补环边 ──
  const seen = new Set(edges.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)))
  for (let i = 0; i < towns.length; i++) {
    for (let j = i + 1; j < towns.length; j++) {
      const k = i < j ? `${i}-${j}` : `${j}-${i}`
      if (seen.has(k)) continue
      const a = towns[i]!
      const b = towns[j]!
      const d = torusDist(a.cx, a.cy, b.cx, b.cy)
      // ⚠️ 必须够远 —— 见文件头
      if (d <= a.radius + b.radius + 3) continue
      if (d > 120) continue
      edges.push([i, j])
      seen.add(k)
    }
  }

  // ⚠️ 按长度升序修路。短边先修好之后，长边才有「已有干道」可以并进去；
  // 反过来先修长边，就变成每条边各走各的，并线效果消失。
  edges.sort(
    (e1, e2) =>
      torusDist(towns[e1[0]]!.cx, towns[e1[0]]!.cy, towns[e1[1]]!.cx, towns[e1[1]]!.cy) -
      torusDist(towns[e2[0]]!.cx, towns[e2[0]]!.cy, towns[e2[1]]!.cx, towns[e2[1]]!.cy),
  )

  for (const [ai, bi] of edges) {
    const ok = carve(towns[ai]!, towns[bi]!, sample, costOf, road, bridge, bridges, p)
    links.push({ a: ai, b: bi, ok })
  }

  return { road, bridge, bridges, links }
}

function nearestGate(t: Town, tx: number, ty: number): [number, number] {
  let bx = t.cx
  let by = t.cy
  let best = Infinity
  for (let i = 0; i < t.gates.length; i += 2) {
    const d = torusDist(t.gates[i]!, t.gates[i + 1]!, tx, ty)
    if (d < best) {
      best = d
      bx = t.gates[i]!
      by = t.gates[i + 1]!
    }
  }
  return [bx, by]
}

function carve(
  a: Town,
  b: Town,
  sample: Sampler,
  costOf: (t: unknown, x: number, y: number) => number,
  road: Uint8Array,
  bridge: Uint8Array,
  bridges: Bridge[],
  p: RoadParams,
): boolean {
  const [sx, sy] = nearestGate(a, b.cx, b.cy)
  const [tx, ty] = nearestGate(b, a.cx, a.cy)

  const path = findPath(sample, [sx, sy], [tx, ty], {
    // 长路要展开的节点多；代价场里水很贵，A* 会探很大一片才决定过河
    budget: 90_000,
    costOf,
    ignoreWalkable: true,
  })
  if (path.length === 0) return false

  // 铺路 + 找出连续的水段作为桥
  let run: number[] = []
  const flushBridge = () => {
    if (run.length === 0) return true
    const span = run.length / 2
    if (span > MAX_BRIDGE_SPAN) {
      run = []
      return false
    }
    for (let i = 0; i < run.length; i += 2) {
      const bi = run[i + 1]! * WORLD_SIZE + run[i]!
      bridge[bi] = 1
      road[bi] = 1
    }
    bridges.push({ cells: Int32Array.from(run), span })
    run = []
    return true
  }

  let ok = true
  for (const [fx, fy] of path) {
    const x = wrapTile(fx)
    const y = wrapTile(fy)
    const i = y * WORLD_SIZE + x
    if (p.water[i] !== WATER.none) {
      run.push(x, y)
    } else {
      if (!flushBridge()) ok = false
      road[i] = 1
    }
  }
  if (!flushBridge()) ok = false

  return ok
}
