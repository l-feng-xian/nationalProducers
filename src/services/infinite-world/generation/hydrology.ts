/**
 * 水文：填洼 → 流向 → 汇流 → 抽折线 → spline → 栅格化。
 *
 * ## 为什么不能用噪声阈值造河
 * `noise(x,y) > T → 水` 给出的是一堆互不相连的水斑，无论怎么调参都连不起来。
 * 而「河流必须贯通、必须汇入湖海」是玩家一眼就能看出来的性质。
 *
 * 这里的做法让**贯通性成为构造的结果而不是事后检查**：
 * 填洼之后每个非终端格都有一条严格下降的流向链通到某个盆地；
 * 河格是这些链上汇流量超过阈值的那一段 —— 它天然连通、天然汇入湖海。
 * 所以不需要「确保初始河流贯通」这种事后修复步骤。
 *
 * ## 环面的便利
 * 平面版填洼要把地图四边当作出水口（否则水无处可去）。
 * 环面上**没有边界**，所以出水口只能是「低于海平面的格」——
 * 这反而让语义更干净：海平面之下即是终端盆地。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { MinHeap } from '@/utils/binaryHeap'
import { WORLD_SIZE } from '../core/constants'
import { DIR8, DIST8, wrap, wrapTile } from '../core/torus'
import type { Fields } from './fields'

const N = WORLD_SIZE * WORLD_SIZE

/** 水体等级 */
export const WATER = {
  none: 0,
  shallow: 1,
  deep: 2,
} as const
export type WaterLevel = (typeof WATER)[keyof typeof WATER]

export interface HydrologyParams {
  elevation: Float32Array
  seaLevel: number
  fields: Fields
  /** 河网密度 0..1。越大河越多越宽 */
  riverDensity: number
}

export interface Hydrology {
  /** 填洼后的高度（每格 ≥ elevation，且沿流向严格下降） */
  filled: Float32Array
  /** D8 流向：0..7 对应 DIR8，-1 表示终端盆地 */
  flow: Int8Array
  /** 汇流面积（上游格数） */
  accum: Float32Array
  /** 水体等级 */
  water: Uint8Array
  /** 湿地标记 */
  marsh: Uint8Array
  /** 河道阈值（accum 超过它即成河） */
  riverThreshold: number
  /** 抽出的河道中心线（世界坐标，已回绕），供调试与桥梁选址 */
  rivers: RiverPolyline[]
}

export interface RiverPolyline {
  /** 采样点，x,y 交错 */
  points: Float32Array
  /** 每个采样点处的河宽（格） */
  widths: Float32Array
}

/**
 * ⚠️ 填洼的 epsilon。
 *
 * 必须 > 0：它保证填洼后沿流向**严格**下降，平坦区不会出现「找不到下游」的格。
 * 若取 0，大片同高的洼地填平后每格的八邻都等高，D8 会全部判成终端盆地，
 * 汇流面积全是 1，一条河都出不来 —— 而地形看起来完全正常。
 *
 * 取 1e-6：512 格的最长路径累积抬升 5e-4，远小于生态阈值间距 0.03。
 */
const FILL_EPS = 1e-6

/**
 * 河道沿域扭曲摆动的幅度系数。
 *
 * warp 本身是 ±7 格，乘 0.12 后约 ±0.85 格 —— 足以把 D8 的 45°/90° 阶梯
 * 打散成自然弯曲，又不会把河冲出它自己挖的河谷。
 * 调大会让河道脱离地形（出现「河爬上山坡」），调小则看得出 D8 的方格痕迹。
 */
const RIVER_WANDER = 0.12

/**
 * 内陆湖的最小填洼深度。见 applySeaAndLakes 的注释：
 * 这个值从 0.01 抬到 0.06 是「满屏池塘」→「河流为主、湖为点缀」的关键。
 */
const LAKE_MIN_DEPTH = 0.06

/** 主入口 */
export function buildHydrology(p: HydrologyParams): Hydrology {
  const filled = priorityFlood(p.elevation, p.seaLevel)
  const flow = computeFlowD8(filled)
  const accum = computeAccumulation(filled, flow)
  const riverThreshold = pickRiverThreshold(accum, p.riverDensity)
  const rivers = traceRivers(accum, flow, riverThreshold, p.fields)

  const water = new Uint8Array(N)
  rasterizeRivers(water, rivers)
  applySeaAndLakes(water, p.elevation, filled, p.seaLevel)

  const marsh = computeMarsh(water, p.elevation, filled, p.fields)

  return { filled, flow, accum, water, marsh, riverThreshold, rivers }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Priority-Flood 填洼（环面版）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把所有洼地填到「有出路」为止。
 *
 * 种子 = 全部低于海平面的格（终端盆地）。从它们开始按高度从低到高外扩，
 * 每格的填充高度取 `max(自身高度, 上游填充高度 + EPS)`。
 *
 * ⚠️ 若整张图没有一格低于海平面（waterRatio 极小时可能发生），
 * 就退化成「用全局最低点当唯一种子」—— 否则没有种子，整张图都填不了，
 * 后面 D8 会把每一格都判成终端盆地，一条河都没有。
 */
export function priorityFlood(elevation: Float32Array, seaLevel: number): Float32Array {
  const filled = new Float32Array(N)
  const visited = new Uint8Array(N)
  const heap = new MinHeap<{ i: number; h: number }>((a, b) => a.h - b.h)

  let seeds = 0
  for (let i = 0; i < N; i++) {
    if (elevation[i]! <= seaLevel) {
      filled[i] = elevation[i]!
      visited[i] = 1
      heap.push({ i, h: elevation[i]! })
      seeds++
    }
  }

  if (seeds === 0) {
    let lowest = 0
    for (let i = 1; i < N; i++) if (elevation[i]! < elevation[lowest]!) lowest = i
    filled[lowest] = elevation[lowest]!
    visited[lowest] = 1
    heap.push({ i: lowest, h: elevation[lowest]! })
  }

  while (heap.size > 0) {
    const cur = heap.pop()!
    const cx = cur.i % WORLD_SIZE
    const cy = (cur.i - cx) / WORLD_SIZE
    for (let k = 0; k < 8; k++) {
      const d = DIR8[k]!
      const nx = wrapTile(cx + d[0]!)
      const ny = wrapTile(cy + d[1]!)
      const ni = ny * WORLD_SIZE + nx
      if (visited[ni]) continue
      const h = Math.max(elevation[ni]!, filled[cur.i]! + FILL_EPS)
      filled[ni] = h
      visited[ni] = 1
      heap.push({ i: ni, h })
    }
  }

  return filled
}

// ─────────────────────────────────────────────────────────────────────────
// 2. D8 流向
// ─────────────────────────────────────────────────────────────────────────

/**
 * 每格指向最陡下降的邻居。
 *
 * 用「高差 / 距离」而不是纯高差 —— 否则对角邻居会被系统性偏好
 * （它们天然高差更大），河道会全变成 45° 斜线。
 */
export function computeFlowD8(filled: Float32Array): Int8Array {
  const flow = new Int8Array(N).fill(-1)
  for (let y = 0; y < WORLD_SIZE; y++) {
    const row = y * WORLD_SIZE
    for (let x = 0; x < WORLD_SIZE; x++) {
      const i = row + x
      const h = filled[i]!
      let bestSlope = 0
      let best = -1
      for (let k = 0; k < 8; k++) {
        const d = DIR8[k]!
        const ni = wrapTile(y + d[1]!) * WORLD_SIZE + wrapTile(x + d[0]!)
        const slope = (h - filled[ni]!) / DIST8[k]!
        if (slope > bestSlope) {
          bestSlope = slope
          best = k
        }
      }
      flow[i] = best
    }
  }
  return flow
}

/** 沿流向走一步，返回下游格索引；-1 表示终端 */
export function downstream(i: number, flow: Int8Array): number {
  const k = flow[i]!
  if (k < 0) return -1
  const x = i % WORLD_SIZE
  const y = (i - x) / WORLD_SIZE
  const d = DIR8[k]!
  return wrapTile(y + d[1]!) * WORLD_SIZE + wrapTile(x + d[0]!)
}

// ─────────────────────────────────────────────────────────────────────────
// 3. 汇流面积
// ─────────────────────────────────────────────────────────────────────────

/**
 * 每格的上游格数。
 *
 * 按 `filled` **降序**处理即可保证上游先于下游 ——
 * 这是填洼时那个 EPS 换来的：沿流向严格下降，所以高度序就是拓扑序，
 * 不需要真的建 DAG 做拓扑排序。
 */
export function computeAccumulation(filled: Float32Array, flow: Int8Array): Float32Array {
  const order = new Uint32Array(N)
  for (let i = 0; i < N; i++) order[i] = i
  // 原生 sort + 数值比较，26 万条约 100ms
  const arr = Array.from(order)
  arr.sort((a, b) => filled[b]! - filled[a]!)

  const accum = new Float32Array(N).fill(1)
  for (const i of arr) {
    const down = downstream(i, flow)
    if (down >= 0) accum[down]! += accum[i]!
  }
  return accum
}

/**
 * 按目标河格占比反解汇流阈值。
 *
 * 与海平面同一手法（直方图分位数），让 `riverDensity` 有精确语义。
 * accum 的动态范围很大（1 到几万），所以直方图建在 log 空间上。
 */
export function pickRiverThreshold(accum: Float32Array, riverDensity: number): number {
  const targetRatio = 0.004 + Math.max(0, Math.min(1, riverDensity)) * 0.012
  const target = Math.round(targetRatio * N)

  const BUCKETS = 2048
  const hist = new Int32Array(BUCKETS)
  let maxLog = 0
  for (let i = 0; i < N; i++) {
    const l = Math.log2(accum[i]!)
    if (l > maxLog) maxLog = l
  }
  if (maxLog <= 0) return Infinity
  for (let i = 0; i < N; i++) {
    let b = Math.floor((Math.log2(accum[i]!) / maxLog) * BUCKETS)
    if (b < 0) b = 0
    else if (b >= BUCKETS) b = BUCKETS - 1
    hist[b]!++
  }
  // 从高往低累计，找到「恰好 target 格在其之上」的桶
  let acc = 0
  let bucket = BUCKETS - 1
  for (; bucket >= 0; bucket--) {
    acc += hist[bucket]!
    if (acc >= target) break
  }
  return 2 ** ((Math.max(0, bucket) / BUCKETS) * maxLog)
}

// ─────────────────────────────────────────────────────────────────────────
// 4. 抽折线 + spline
// ─────────────────────────────────────────────────────────────────────────

/** 沿流向把河道抽成折线，再用 Catmull-Rom 重采样并加域扭曲 */
export function traceRivers(
  accum: Float32Array,
  flow: Int8Array,
  threshold: number,
  fields: Fields,
): RiverPolyline[] {
  if (!Number.isFinite(threshold)) return []

  const isRiver = (i: number) => accum[i]! >= threshold
  const visited = new Uint8Array(N)
  const out: RiverPolyline[] = []

  for (let i = 0; i < N; i++) {
    if (!isRiver(i) || visited[i]) continue
    // 只从「源头」起笔：上游没有任何河格流进来
    let hasRiverInflow = false
    const x = i % WORLD_SIZE
    const y = (i - x) / WORLD_SIZE
    for (let k = 0; k < 8; k++) {
      const d = DIR8[k]!
      const ni = wrapTile(y + d[1]!) * WORLD_SIZE + wrapTile(x + d[0]!)
      if (isRiver(ni) && downstream(ni, flow) === i) {
        hasRiverInflow = true
        break
      }
    }
    if (hasRiverInflow) continue

    // 沿流向一路走到汇（或走进已访问的干流）
    const raw: number[] = []
    const w: number[] = []
    let cur = i
    let guard = 0
    while (cur >= 0 && isRiver(cur) && guard++ < N) {
      visited[cur] = 1
      raw.push(cur % WORLD_SIZE, (cur - (cur % WORLD_SIZE)) / WORLD_SIZE)
      w.push(widthOf(accum[cur]!, threshold))
      const next = downstream(cur, flow)
      if (next < 0) break
      // 汇入已成形的干流即止，避免重复画同一段
      if (visited[next]) {
        raw.push(next % WORLD_SIZE, (next - (next % WORLD_SIZE)) / WORLD_SIZE)
        w.push(widthOf(accum[next]!, threshold))
        break
      }
      cur = next
    }

    if (raw.length >= 4) out.push(smoothPolyline(raw, w, fields))
  }

  return out
}

/** 河宽随汇流量对数增长，钳在 [0.8, 4.5] 格 */
function widthOf(accum: number, threshold: number): number {
  const w = 0.8 + 0.55 * Math.log2(Math.max(1, accum / threshold))
  return w < 0.8 ? 0.8 : w > 4.5 ? 4.5 : w
}

/**
 * Catmull-Rom 重采样 + 域扭曲。
 *
 * ⚠️ 折线的相邻点可能跨接缝（x 从 511 跳到 0）。必须在**展开坐标**上做插值，
 * 最后再回绕 —— 直接对回绕后的坐标插值会让河道横穿整张地图。
 */
function smoothPolyline(raw: number[], widths: number[], fields: Fields): RiverPolyline {
  const n = raw.length / 2
  // 展开：让相邻点之间不跨缝
  const ux = new Float64Array(n)
  const uy = new Float64Array(n)
  ux[0] = raw[0]!
  uy[0] = raw[1]!
  for (let i = 1; i < n; i++) {
    ux[i] = ux[i - 1]! + shortestStep(ux[i - 1]!, raw[i * 2]!)
    uy[i] = uy[i - 1]! + shortestStep(uy[i - 1]!, raw[i * 2 + 1]!)
  }

  const pts: number[] = []
  const wd: number[] = []
  const STEP = 0.5 // 每格采两个点，保证栅格化不漏格
  for (let i = 0; i < n - 1; i++) {
    const p0 = i > 0 ? i - 1 : 0
    const p3 = i + 2 < n ? i + 2 : n - 1
    const segLen = Math.hypot(ux[i + 1]! - ux[i]!, uy[i + 1]! - uy[i]!)
    const steps = Math.max(1, Math.ceil(segLen / STEP))
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const cx = catmullRom(ux[p0]!, ux[i]!, ux[i + 1]!, ux[p3]!, t)
      const cy = catmullRom(uy[p0]!, uy[i]!, uy[i + 1]!, uy[p3]!, t)
      // 域扭曲：让河道不是 D8 的阶梯直线。用回绕后的**整数**坐标取扭曲值，
      // 保证同一格恒得同一偏移（跨缝也一致）；再用浮点 wrap 回绕结果。
      const [dx, dy] = fields.warp(Math.round(cx), Math.round(cy))
      pts.push(wrap(cx + dx * RIVER_WANDER), wrap(cy + dy * RIVER_WANDER))
      wd.push(widths[i]! + (widths[Math.min(i + 1, n - 1)]! - widths[i]!) * t)
    }
  }
  // 补上终点
  pts.push(wrap(ux[n - 1]!), wrap(uy[n - 1]!))
  wd.push(widths[n - 1]!)

  return { points: Float32Array.from(pts), widths: Float32Array.from(wd) }
}

/** a → b 的最短步长（b 是已回绕的目标格） */
function shortestStep(from: number, to: number): number {
  let d = (to - from) % WORLD_SIZE
  if (d > WORLD_SIZE / 2) d -= WORLD_SIZE
  else if (d < -WORLD_SIZE / 2) d += WORLD_SIZE
  return d
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

// ─────────────────────────────────────────────────────────────────────────
// 5. 栅格化
// ─────────────────────────────────────────────────────────────────────────

/**
 * 沿中心线画圆盘。
 *
 * ⚠️ 相邻采样中心成对角时要补一个正交角格。这不是为了防「斜着穿河」
 * （4 邻接本来就不能斜走），而是为了 (a) 双网格的水层不出现 5/10 夹点，
 * (b) 将来钓鱼/行船能沿河连通。
 */
export function rasterizeRivers(water: Uint8Array, rivers: RiverPolyline[]): void {
  for (const r of rivers) {
    const n = r.widths.length
    let px = -1
    let py = -1
    for (let i = 0; i < n; i++) {
      const cx = r.points[i * 2]!
      const cy = r.points[i * 2 + 1]!
      const w = r.widths[i]!
      stampDisk(water, cx, cy, w)

      const gx = wrapTile(cx)
      const gy = wrapTile(cy)
      if (px >= 0) {
        const dx = shortestStep(px, gx)
        const dy = shortestStep(py, gy)
        // 对角步：补一个正交角格，保证 4 连通
        if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
          setWater(water, wrapTile(px + dx), py, WATER.deep)
        }
      }
      px = gx
      py = gy
    }
  }
}

function stampDisk(water: Uint8Array, cx: number, cy: number, w: number): void {
  const r = w / 2
  const rr = Math.ceil(r + 1)
  for (let oy = -rr; oy <= rr; oy++) {
    for (let ox = -rr; ox <= rr; ox++) {
      const d = Math.hypot(ox, oy)
      if (d > r + 1) continue
      const x = wrapTile(cx + ox)
      const y = wrapTile(cy + oy)
      setWater(water, x, y, d <= Math.max(0.5, r - 0.5) ? WATER.deep : WATER.shallow)
    }
  }
}

function setWater(water: Uint8Array, x: number, y: number, level: WaterLevel): void {
  const i = wrapTile(y) * WORLD_SIZE + wrapTile(x)
  if (water[i]! < level) water[i] = level
}

/** 海与内陆湖 */
function applySeaAndLakes(
  water: Uint8Array,
  elevation: Float32Array,
  filled: Float32Array,
  seaLevel: number,
): void {
  for (let i = 0; i < N; i++) {
    const e = elevation[i]!
    if (e <= seaLevel) {
      // 深浅之分：离岸越深越是 deep
      const level = e < seaLevel - 0.03 ? WATER.deep : WATER.shallow
      if (water[i]! < level) water[i] = level
      continue
    }
    // 内陆湖：被填洼填起来**足够深**的洼地。
    //
    // ⚠️ 阈值原本是 0.01，渲染出来是「满屏圆形池塘」—— 填洼会把**每一个**
    // 微小凹陷都填起来，0.01 的门槛等于把它们全判成湖。真实的湖是少数显著洼地。
    // 抬到 0.06 之后只剩真正的盆地，河流才成为水系的主角。
    const depth = filled[i]! - e
    if (depth > LAKE_MIN_DEPTH && filled[i]! <= seaLevel + 0.3) {
      if (water[i]! < WATER.deep) water[i] = WATER.deep
    }
  }
}

/** 湿地：浅填洼残差 + 岸边缓冲 */
function computeMarsh(
  water: Uint8Array,
  elevation: Float32Array,
  filled: Float32Array,
  fields: Fields,
): Uint8Array {
  const marsh = new Uint8Array(N)
  for (let y = 0; y < WORLD_SIZE; y++) {
    const row = y * WORLD_SIZE
    for (let x = 0; x < WORLD_SIZE; x++) {
      const i = row + x
      if (water[i] !== WATER.none) continue
      const depth = filled[i]! - elevation[i]!
      // 浅填洼 = 天然沼泽
      if (depth > 0 && depth <= 0.01) {
        marsh[i] = 1
        continue
      }
      // 岸边 2 格内且够湿
      let nearWater = false
      for (let oy = -2; oy <= 2 && !nearWater; oy++) {
        for (let ox = -2; ox <= 2; ox++) {
          const ni = wrapTile(y + oy) * WORLD_SIZE + wrapTile(x + ox)
          if (water[ni] !== WATER.none) {
            nearWater = true
            break
          }
        }
      }
      if (nearWater && fields.moisture(x, y) > 0.1) marsh[i] = 1
    }
  }
  return marsh
}
