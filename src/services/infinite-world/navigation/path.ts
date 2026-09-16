/**
 * 环面四邻接 A*。
 *
 * 相对旧实现的四处改动，每一处都是为了 512×512（26 万格）而不是 32×32：
 *
 * 1. **环面感知**：邻接用 neighbours4()，启发式用 torusManhattan()。
 *    ⚠️ 启发式若用裸曼哈顿，跨接缝时会**高估**真实代价 → 启发式不再可采纳
 *    → A* 绕远路，或在预算耗尽后返回空路径（表现为「NPC 突然不动了」）。
 *    verify-torus.ts 里有这条的负向断言。
 * 2. **二叉堆**：旧实现每次弹出都线性遍历整个 open 表。预算 3000 时那是
 *    数百万次比较，是寻路的主要开销。
 * 3. **数值键 + 可复用缓冲**：旧实现用 `p.join(',')` 当 Map 键，每个节点
 *    都要建一个字符串。改成 tileIndex() 数值索引 + 模块级复用的定型数组，
 *    靠「代次戳」做 O(1) 重置，不再每次调用分配。
 * 4. **可达性前置否决**：传入 reach 后，不连通的目标直接返回空，
 *    而不是展开 3000 个节点才放弃。河对岸的目标从「最慢的一次寻路」
 *    变成一次数组查。
 *
 * ## ⚠️ 只支持 512×512 环面，不支持老世界的无限平面
 * 坐标一律 `wrapTile()` 回绕，索引缓冲也按 512² 开。
 * 老世界（`terrain-1` / `dual-grid-0.1`）是 `WORLD_LIMIT = 100_000` 的无限平面，
 * 玩家若走出 512 格，这里会把 x=600 当成 x=88，寻路指向与画面不符的地形。
 *
 * **刻意不为此做兼容层**：那需要并行维护第二套索引方案（老实现用的是
 * `Map<string>` 字符串键），而 terrain-1 的全部内容都在 x∈[0,40]、y∈[0,30]
 * 之内，外面只有同质噪声，且 findPath 只在点击可见地面时触发、目标恒在
 * 玩家附近 —— 实际路径上走不到那里。
 *
 * 正确的收口是方案里那一步：**老世界在进入时拦截并提供导出**，
 * 而不是让两种拓扑在同一个寻路器里共存。`torus-1` 落地后补上。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { MinHeap } from '@/utils/binaryHeap'
import { WORLD_SIZE } from '../core/constants'
import { neighbours4, tileIndex, torusDist, torusManhattan, wrapTile } from '../core/torus'
import type { TerrainTile } from '../generation/terrain'

export type Point = [number, number]
export type Sampler = (x: number, y: number) => TerrainTile

/**
 * 可达性预言机。由 navigation/regions.ts 实现。
 *
 * 这里只声明结构不 import 实现，避免 path ↔ regions 循环依赖，
 * 也让调用方可以在还没有连通域图时先跑寻路。
 */
export interface ReachabilityOracle {
  connected(ax: number, ay: number, bx: number, by: number): boolean
}

export interface PathOptions {
  /** 展开节点上限。超过即放弃并返回空 */
  budget?: number
  /** 代价上限。远距离目标应该走 LOD 直线而不是精确寻路 */
  maxCost?: number
  /** 传入后，不连通的目标 O(1) 否决 */
  reach?: ReachabilityOracle
  /**
   * 单步代价。默认是「湿地 2、其余 1、不可通行则跳过」。
   *
   * 修路时会传一个完全不同的代价场：坡度越陡越贵、水面很贵**但不是无穷**——
   * 这样 A\* 会自己找河最窄的地方过去，路线也会沿河谷和缓坡走，
   * 而不是从 A 到 B 拉一条直线再遇水架桥。
   *
   * 返回 `Infinity` 表示此格绝对不可通行。
   */
  costOf?: (tile: TerrainTile, x: number, y: number) => number
  /**
   * 是否忽略 `tile.walkable`。
   *
   * 修路要跨水，而水是 `walkable: false` 的。此时通行性完全交给 `costOf`
   * （返回 Infinity 即不可通行）。
   */
  ignoreWalkable?: boolean
}

const N = WORLD_SIZE * WORLD_SIZE

/**
 * 模块级复用缓冲（约 4.2 MB）。
 *
 * 用「代次戳」而不是每次 fill()：26 万个元素清零要 ~0.3ms，
 * 而 NPC 每秒会寻路十几次。gen 自增后，stamp[i] !== gen 即视为未访问。
 */
let gen = 0
let gScore: Float64Array | null = null
let stamp: Int32Array | null = null
let parent: Int32Array | null = null

function buffers() {
  if (!gScore) {
    gScore = new Float64Array(N)
    stamp = new Int32Array(N)
    parent = new Int32Array(N)
  }
  return { gScore: gScore!, stamp: stamp!, parent: parent! }
}

/** 湿地缓行，其余通行代价 1。与渲染共用同一个 sampler —— 视觉与通行规则必须一致 */
function defaultCost(tile: TerrainTile): number {
  return tile.biome === 'wetland' ? 2 : 1
}

/**
 * 求路径。返回**绝对环面坐标**（[0,512) + 0.5，即格心），起点不含在内。
 *
 * ⚠️ 消费方沿路径移动时必须用 torus.delta() 求方向。
 * 直接写 `target[0] - pos[0]` 在跨缝处会让角色朝反方向跑 511 格 ——
 * 这是环面化最容易漏、也最难从现象反推回来的一处。
 */
export function findPath(
  sample: Sampler,
  start: Point,
  target: Point,
  opts: PathOptions = {},
): Point[] {
  const budget = opts.budget ?? 3000
  const maxCost = opts.maxCost ?? Infinity
  const ignoreWalkable = opts.ignoreWalkable ?? false
  const costOf = opts.costOf ?? defaultCost

  const sx = wrapTile(start[0])
  const sy = wrapTile(start[1])
  const gx = wrapTile(target[0])
  const gy = wrapTile(target[1])

  if (sx === gx && sy === gy) return []
  if (!ignoreWalkable && !sample(gx, gy).walkable) return []
  if (!Number.isFinite(costOf(sample(gx, gy), gx, gy))) return []
  // O(1) 否决：不连通就根本不用展开
  if (opts.reach && !opts.reach.connected(sx, sy, gx, gy)) return []

  const { gScore, stamp, parent } = buffers()
  gen++
  // gen 溢出保护：Int32 用完后整片重置一次，代次从 1 重新开始
  if (gen === 0x7fffffff) {
    stamp.fill(0)
    gen = 1
  }

  const startIdx = tileIndex(sx, sy)
  const goalIdx = tileIndex(gx, gy)

  const open = new MinHeap<{ i: number; f: number }>((a, b) => a.f - b.f)
  gScore[startIdx] = 0
  stamp[startIdx] = gen
  parent[startIdx] = -1
  open.push({ i: startIdx, f: torusManhattan(sx, sy, gx, gy) })

  const nb = new Int32Array(8)
  let expanded = 0

  while (open.size > 0) {
    const node = open.pop()!
    if (node.i === goalIdx) break
    if (++expanded > budget) return []

    // 堆里可能有同一格的陈旧条目（我们不做 decrease-key，而是重复入堆）。
    // 用 f 与当前 g 对不上来识别并跳过 —— 比维护索引堆简单得多，代价是堆大一点。
    const cx = node.i % WORLD_SIZE
    const cy = (node.i - cx) / WORLD_SIZE
    const cg = gScore[node.i]!
    if (node.f > cg + torusManhattan(cx, cy, gx, gy) + 1e-9) continue

    neighbours4(cx, cy, nb)
    for (let k = 0; k < 4; k++) {
      const nx = nb[k * 2]!
      const ny = nb[k * 2 + 1]!
      const tile = sample(nx, ny)
      if (!ignoreWalkable && !tile.walkable) continue
      const step = costOf(tile, nx, ny)
      if (!Number.isFinite(step)) continue
      const ni = tileIndex(nx, ny)
      const g = cg + step
      if (g > maxCost) continue
      if (stamp[ni] === gen && g >= gScore[ni]!) continue
      stamp[ni] = gen
      gScore[ni] = g
      parent[ni] = node.i
      open.push({ i: ni, f: g + torusManhattan(nx, ny, gx, gy) })
    }
  }

  if (stamp[goalIdx] !== gen) return []

  // 回溯
  const path: Point[] = []
  let cur = goalIdx
  while (cur !== -1 && cur !== startIdx) {
    const x = cur % WORLD_SIZE
    const y = (cur - x) / WORLD_SIZE
    path.push([x + 0.5, y + 0.5])
    cur = parent[cur]!
  }
  path.reverse()
  return path
}

/**
 * 不跑 A*，用环面直线距离 × 迂回系数估通勤耗时（游戏分钟）。
 *
 * 用在两处：① 日程推导时插入 commute 段的长度；② 远距 NPC 的 LOD 直线移动。
 * 1.4 是绕障碍的经验迂回系数。
 */
export function estimateTravelMinutes(a: Point, b: Point, speed: number): number {
  if (speed <= 0) return Infinity
  return (torusDist(a[0], a[1], b[0], b[1]) * 1.4) / speed
}
