/**
 * 城镇规划：确定性推导，零存储。
 *
 * ## 布局参考日式 RPG 的镇子
 * 早期的散点式布局（在镇半径内按 3×3 极大值撒房子）虽然保证了「房子不相邻」，
 * 但看起来是**随机村落**而不是**有人规划过的镇**：没有中心、没有街、
 * 每栋房子孤零零站着、全是一格见方。
 *
 * 现在的结构：
 *   1. **中央广场**（带水井）—— 镇的重心，建筑沿广场四边朝内而立
 *   2. **弯折的街巷** —— 从广场向外，每隔几格拐一次 90°，不是笔直四臂
 *   3. **沿街建筑** —— 占地 2×2 ~ 3×3 不等，朝向街道，
 *      与街道的退距按哈希在 0/1 之间抖动 → **错落**
 *   4. **楼层 1~3 层** → **高低**；越靠近广场越可能是二三层的商铺/客栈
 *
 * ## 零存储怎么做到
 * 全图切成 16×16 个 32 格见方的区域，每个区域独立掷点。
 * 输入只有 (seed, rx, ry) 与噪声场 —— 同一个种子任何时候算都是同一结果。
 *
 * ⚠️ `REGION = 32` 必须整除 `WORLD_SIZE = 512`，否则最后一列区域只有半格宽，
 * 而「回绕后必然一致」依赖于区域网格本身也在环面上闭合。
 *
 * ## ⚠️ 判断「在不在镇里」只能用 townAt()
 * 不要去嗅地名字面量。镇名后缀有十种，`includes('村')` 一种都认不出来。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { REGION, WORLD_SIZE } from '../core/constants'
import { delta, torusDist2, wrapTile } from '../core/torus'
import type { Fields } from './fields'
import { WATER } from './hydrology'
import { hash01, hashInt, hashTile01, seedOf } from './rng'

const N = WORLD_SIZE * WORLD_SIZE
const REGIONS_PER_SIDE = WORLD_SIZE / REGION

export type BuildingKind = 'house' | 'shop' | 'inn' | 'workshop' | 'barn' | 'well'

export interface TownBuilding {
  /** 占地左上角（已回绕） */
  x: number
  y: number
  /** 占地尺寸（格） */
  w: number
  h: number
  /** 正面朝向：0=东 1=南 2=西 3=北。正面对着它所依附的那条街 */
  facing: 0 | 1 | 2 | 3
  /** 楼层数，1..3。渲染时决定高度，让镇子的天际线错落 */
  storeys: 1 | 2 | 3
  kind: BuildingKind
}

export interface Town {
  /** `t${rx}:${ry}` —— 确定性，可直接当 POI 主键 */
  id: string
  name: string
  cx: number
  cy: number
  radius: number
  /** 广场格，x,y 交错 */
  plaza: Int32Array
  /** 街巷格，x,y 交错 */
  paths: Int32Array
  buildings: TownBuilding[]
  /** 田块格，x,y 交错 */
  fields: Int32Array
  /** 道路接入点（各条街的末端），x,y 交错 */
  gates: Int32Array
}

export interface SettlementParams {
  seed: string
  fields: Fields
  elevation: Float32Array
  water: Uint8Array
  marsh: Uint8Array
  townDensity: number
  fieldDensity: number
}

/**
 * 选址时的平坦度要求（四邻高差）。只用于挑镇心。
 */
const FLAT_TOLERANCE = 0.04

/**
 * 建筑落地的平坦度要求，**刻意比选址宽松**。
 *
 * ⚠️ 用同一个 0.04 的话，镇心周围稍有起伏的格子全被否掉，
 * 一个镇只剩七八栋房、街巷长不出来 —— 而镇心本身已经在选址阶段验过平坦了，
 * 没必要对每一格再卡同样严的标准。真实的镇本来就依着地势铺开。
 */
const BUILD_FLAT_TOLERANCE = 0.1
/** 落点螺旋搜索的最大半径（格） */
const SPIRAL_MAX = 10
/** 少于这个数的建筑不算一个镇，整个丢弃 */
const MIN_BUILDINGS = 4

const NAME_PREFIX = ['青', '临', '望', '柳', '石', '云', '槐', '澜', '梅', '沙', '松', '白']
const NAME_SUFFIX = ['川', '溪', '渡', '坳', '原', '岭', '湾', '集', '桥', '塘']

const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const

export function planTowns(p: SettlementParams): Town[] {
  const base = seedOf(p.seed)
  const towns: Town[] = []

  const at = (x: number, y: number) => wrapTile(y) * WORLD_SIZE + wrapTile(x)
  const isDry = (x: number, y: number) => {
    const i = at(x, y)
    return p.water[i] === WATER.none && p.marsh[i] === 0
  }
  const flatWithin = (x: number, y: number, tol: number) => {
    const h = p.elevation[at(x, y)]!
    return (
      Math.abs(p.elevation[at(x + 1, y)]! - h) < tol &&
      Math.abs(p.elevation[at(x - 1, y)]! - h) < tol &&
      Math.abs(p.elevation[at(x, y + 1)]! - h) < tol &&
      Math.abs(p.elevation[at(x, y - 1)]! - h) < tol
    )
  }
  const isFlat = (x: number, y: number) => flatWithin(x, y, FLAT_TOLERANCE)
  const canBuild = (x: number, y: number) => flatWithin(x, y, BUILD_FLAT_TOLERANCE)

  for (let ry = 0; ry < REGIONS_PER_SIDE; ry++) {
    for (let rx = 0; rx < REGIONS_PER_SIDE; rx++) {
      // ── 两道门控 ──
      //
      // ⚠️ 标定依据是**玩家的步行时间**，不是「地图上看起来多不多」。
      // 512 格世界步行穿越约 3 分钟。最初的参数产出 65 个镇 = 每 60 格一个 =
      // 每走 20 秒撞见一个镇 —— 那是城市群，不是生活模拟。
      //
      // 门控 1（settlement 场）决定**聚集在哪**，让镇扎堆而不是均匀撒在格点上；
      // 门控 2（哈希）在合格区域里再稀疏一次。
      const gate = 0.35 - p.townDensity * 0.3
      if (p.fields.settlement(rx * REGION + REGION / 2, ry * REGION + REGION / 2) <= gate) continue
      if (hash01(base, 'town', rx, ry) >= 0.1 + p.townDensity * 0.25) continue

      // ⚠️ 半径必须在选址**之前**算出来：间距检查要用「已有镇半径 + 新镇半径」。
      // 只用已有镇半径加固定余量 8 是不够的 —— 半径范围 6..9，最坏需要 18 格
      // 而固定余量只保证 14，于是偶尔出现影响圈重叠。
      const newRadius = townRadius(base, rx, ry)

      const ox = hashInt(base, REGION - 12, 'tx', rx, ry) + 6
      const oy = hashInt(base, REGION - 12, 'ty', rx, ry) + 6
      const spot = spiralFind(rx * REGION + ox, ry * REGION + oy, (x, y) => {
        if (!isDry(x, y) || !isFlat(x, y)) return false
        for (const t of towns) {
          const need = t.radius + newRadius + 2
          if (torusDist2(x, y, t.cx, t.cy) < need * need) return false
        }
        return true
      })
      // ⚠️ 找不到就是这片区域这一把没镇，**不重掷** —— 重掷会让结果依赖尝试次数
      if (!spot) continue

      const town = buildTown(base, rx, ry, spot[0], spot[1], newRadius, p, isDry, canBuild)
      // ⚠️ 被地形（水/陡坡）挤住的落点会产出「只有两栋房」的退化镇。
      // 那不是镇，是两间孤屋 —— 与其放宽验收标准，不如在这里直接淘汰。
      // 淘汰是确定性的（只依赖已算出的 town 本身），不破坏零存储。
      if (town.buildings.filter((b) => b.kind !== 'well').length < MIN_BUILDINGS) continue
      towns.push(town)
    }
  }

  return towns
}

/**
 * 镇的半径。由 (seed, rx, ry) 确定，必须能在选址前独立算出来。
 *
 * ⚠️ 原本是 6..9，渲染出来「广场占了大半、只有七八栋房、街巷没长出来」——
 * 光广场就 7×5，建筑每栋要 2..3 格，半径 8 的圆里根本排不下一条街。
 * 10..16 才装得下「广场 + 几条巷 + 沿街两排房」这个结构。
 */
function townRadius(base: number, rx: number, ry: number): number {
  return 10 + hashInt(base, 7, 'radius', rx, ry)
}

function spiralFind(
  sx: number,
  sy: number,
  ok: (x: number, y: number) => boolean,
): [number, number] | null {
  const cx = wrapTile(sx)
  const cy = wrapTile(sy)
  if (ok(cx, cy)) return [cx, cy]
  for (let r = 1; r <= SPIRAL_MAX; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const x = wrapTile(cx + dx)
        const y = wrapTile(cy + dy)
        if (ok(x, y)) return [x, y]
      }
    }
  }
  return null
}

function buildTown(
  base: number,
  rx: number,
  ry: number,
  cx: number,
  cy: number,
  radius: number,
  p: SettlementParams,
  isDry: (x: number, y: number) => boolean,
  canBuild: (x: number, y: number) => boolean,
): Town {
  /** 镇内占用表：街、广场、建筑都登记在这里，防止互相压占 */
  const occupied = new Set<number>()
  const idx = (x: number, y: number) => wrapTile(y) * WORLD_SIZE + wrapTile(x)
  const take = (x: number, y: number) => occupied.add(idx(x, y))
  const free = (x: number, y: number) => !occupied.has(idx(x, y))

  // ── 1. 中央广场 ──
  // 长宽各从 {5,7,9}×{5,7} 里取，做成矩形而不是圆 —— 矩形才有「四条边」
  // 可以让建筑沿边而立，圆形广场周围没法整齐排房
  const pw = 5 + hashInt(base, 3, 'pw', rx, ry) * 2
  const ph = 5 + hashInt(base, 2, 'ph', rx, ry) * 2
  const plaza: number[] = []
  const halfW = Math.floor(pw / 2)
  const halfH = Math.floor(ph / 2)
  for (let dy = -halfH; dy <= halfH; dy++) {
    for (let dx = -halfW; dx <= halfW; dx++) {
      const x = wrapTile(cx + dx)
      const y = wrapTile(cy + dy)
      plaza.push(x, y)
      take(x, y)
    }
  }

  const buildings: TownBuilding[] = []
  // 广场正中一口井
  buildings.push({ x: cx, y: cy, w: 1, h: 1, facing: 1, storeys: 1, kind: 'well' })

  // ── 2. 弯折的街巷 ──
  //
  // ⚠️ 不能用笔直四臂 —— 那是最容易看出「程序生成」的特征之一。
  // 每隔 2-4 格拐一次 90°，拐向由哈希定，走出去的是一条有折角的巷子。
  const paths: number[] = []
  const gates: number[] = []
  // 四个方向都试一遍，留下能走够长度的那些 —— 贴水/贴崖的方向自然出不了巷子
  const MIN_LANE = 5
  const dirOffset = hashInt(base, 4, 'lanedir', rx, ry)
  for (let li = 0; li < 4; li++) {
    const d0 = (li + dirOffset) % 4
    let dir = d0
    let x = wrapTile(cx + DIRS[d0]![0] * (halfW + 1))
    let y = wrapTile(cy + DIRS[d0]![1] * (halfH + 1))
    let sinceTurn = 0
    const cells: number[] = []
    let lastX = x
    let lastY = y

    for (let s = 0; s < radius + 6; s++) {
      if (!isDry(x, y)) break
      if (free(x, y)) cells.push(x, y)
      lastX = x
      lastY = y

      sinceTurn++
      if (sinceTurn >= 2 + hashInt(base, 3, 'turn', rx, ry, li, s)) {
        sinceTurn = 0
        // ⚠️ 拐弯必须带**向外偏置**。
        // 早先写成「25% 左 / 25% 右」的无偏随机游走，结果巷子走 19 步只漂出去
        // 七八格，到不了镇缘 —— 镇看起来就是「广场周围一圈房」而没有街。
        // 这里在左右两个候选里选远离镇心的那个：既保留折角，又保证整体向外。
        const left = (dir + 3) % 4
        const right = (dir + 1) % 4
        const outX = delta(cx, x)
        const outY = delta(cy, y)
        const dotL = DIRS[left]![0] * outX + DIRS[left]![1] * outY
        const dotR = DIRS[right]![0] * outX + DIRS[right]![1] * outY
        dir = dotL >= dotR ? left : right
      }
      x = wrapTile(x + DIRS[dir]![0])
      y = wrapTile(y + DIRS[dir]![1])
      if (torusDist2(x, y, cx, cy) > (radius + 5) ** 2) break
    }

    // 太短的不算一条巷（贴水或贴陡坡的方向）
    if (cells.length / 2 < MIN_LANE) continue
    for (let i = 0; i < cells.length; i += 2) {
      paths.push(cells[i]!, cells[i + 1]!)
      take(cells[i]!, cells[i + 1]!)
    }
    gates.push(lastX, lastY)
  }

  // ── 3. 沿街与沿广场排建筑 ──
  //
  // 对每一段街（以及广场四边），在它两侧尝试落一栋建筑。
  // 退距（setback）按哈希在 0/1 之间抖 —— 这就是「错落」的来源：
  // 相邻两栋房的正面不在一条线上。
  const anchors: { x: number; y: number; nx: number; ny: number }[] = []

  // 街两侧
  for (let i = 0; i < paths.length; i += 2) {
    const px = paths[i]!
    const py = paths[i + 1]!
    for (let d = 0; d < 4; d++) {
      anchors.push({ x: px, y: py, nx: DIRS[d]![0], ny: DIRS[d]![1] })
    }
  }
  // 广场四边朝外
  for (let dx = -halfW; dx <= halfW; dx++) {
    anchors.push({ x: wrapTile(cx + dx), y: wrapTile(cy - halfH), nx: 0, ny: -1 })
    anchors.push({ x: wrapTile(cx + dx), y: wrapTile(cy + halfH), nx: 0, ny: 1 })
  }
  for (let dy = -halfH; dy <= halfH; dy++) {
    anchors.push({ x: wrapTile(cx - halfW), y: wrapTile(cy + dy), nx: -1, ny: 0 })
    anchors.push({ x: wrapTile(cx + halfW), y: wrapTile(cy + dy), nx: 1, ny: 0 })
  }

  for (const a of anchors) {
    const h = hashTile01(base ^ 0x1107, a.x * 7 + a.nx, a.y * 7 + a.ny)
    // 不是每个锚点都盖房，否则街两侧会连成一堵墙
    if (h > 0.58) continue

    // 退距 0 或 1 —— 错落的来源
    const setback = h < 0.14 ? 1 : 0
    const bx0 = a.x + a.nx * (1 + setback)
    const by0 = a.y + a.ny * (1 + setback)

    // 占地：2×2 / 3×2 / 2×3 / 3×3
    const sizeRoll = hashTile01(base ^ 0x5171, a.x + a.nx, a.y + a.ny)
    const w = sizeRoll < 0.5 ? 2 : 3
    const hh = sizeRoll < 0.25 || sizeRoll > 0.75 ? 2 : 3

    // 左上角：让建筑贴着街的那一侧
    const ox = a.nx > 0 ? 0 : a.nx < 0 ? -(w - 1) : -Math.floor(w / 2)
    const oy = a.ny > 0 ? 0 : a.ny < 0 ? -(hh - 1) : -Math.floor(hh / 2)
    const x0 = bx0 + ox
    const y0 = by0 + oy

    // 全部格子必须空闲、干燥、平坦
    let okPlot = true
    for (let yy = 0; yy < hh && okPlot; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const gx = x0 + xx
        const gy = y0 + yy
        if (!free(gx, gy) || !isDry(gx, gy) || !canBuild(gx, gy)) {
          okPlot = false
          break
        }
        // 与镇心距离约束，别把房子甩太远
        if (torusDist2(gx, gy, cx, cy) > (radius + 3) ** 2) {
          okPlot = false
          break
        }
      }
    }
    if (!okPlot) continue

    for (let yy = 0; yy < hh; yy++) for (let xx = 0; xx < w; xx++) take(x0 + xx, y0 + yy)

    // 朝向：正面对着街，即法线的反方向
    const facing: 0 | 1 | 2 | 3 =
      a.nx > 0 ? 2 : a.nx < 0 ? 0 : a.ny > 0 ? 3 : 1

    // 层数与用途：越靠近广场越像商业建筑、越高
    const dPlaza = Math.sqrt(torusDist2(x0, y0, cx, cy))
    const near = dPlaza < halfW + 3
    const kindRoll = hashTile01(base ^ 0x9c0f, x0, y0)
    let kind: BuildingKind
    let storeys: 1 | 2 | 3
    if (near) {
      kind = kindRoll < 0.34 ? 'shop' : kindRoll < 0.56 ? 'inn' : kindRoll < 0.78 ? 'workshop' : 'house'
      storeys = kindRoll < 0.3 ? 3 : 2
    } else {
      kind = kindRoll < 0.12 ? 'barn' : kindRoll < 0.26 ? 'workshop' : 'house'
      storeys = kindRoll < 0.22 ? 2 : 1
    }

    buildings.push({ x: wrapTile(x0), y: wrapTile(y0), w, h: hh, facing, storeys, kind })
  }

  // ── 4. 田块：某个象限、镇外一圈 ──
  const quadrant = hashInt(base, 4, 'quad', rx, ry)
  const qdir = DIRS[quadrant]!
  const fieldCells: number[] = []
  const plots = 2 + (p.fieldDensity > 0.5 ? 1 : 0)
  for (let plot = 0; plot < plots; plot++) {
    const dist = radius + 3 + plot * 3
    const fw = 3 + hashInt(base, 3, 'fw', rx, ry, plot)
    const fh = 2 + hashInt(base, 3, 'fh', rx, ry, plot)
    const ax = cx + qdir[0] * dist - (qdir[0] === 0 ? Math.floor(fw / 2) : 0)
    const ay = cy + qdir[1] * dist - (qdir[1] === 0 ? Math.floor(fh / 2) : 0)
    for (let fy = 0; fy < fh; fy++) {
      for (let fx = 0; fx < fw; fx++) {
        const x = wrapTile(ax + fx)
        const y = wrapTile(ay + fy)
        if (!isDry(x, y) || !canBuild(x, y) || !free(x, y)) continue
        fieldCells.push(x, y)
        take(x, y)
      }
    }
  }

  const name =
    NAME_PREFIX[hashInt(base, NAME_PREFIX.length, 'np', rx, ry)]! +
    NAME_SUFFIX[hashInt(base, NAME_SUFFIX.length, 'ns', rx, ry)]!

  return {
    id: `t${rx}:${ry}`,
    name,
    cx,
    cy,
    radius,
    plaza: Int32Array.from(plaza),
    paths: Int32Array.from(paths),
    buildings,
    fields: Int32Array.from(fieldCells),
    gates: Int32Array.from(gates),
  }
}

/**
 * 判断一个格在不在某个镇的影响圈里。
 *
 * ⚠️ **这是唯一入口**。不要去嗅地名字面量 —— 镇名后缀有十种，
 * `includes('村')` 一种都认不出来。
 */
export function townAt(towns: readonly Town[], x: number, y: number): Town | null {
  for (const t of towns) {
    if (torusDist2(x, y, t.cx, t.cy) <= t.radius * t.radius) return t
  }
  return null
}

/** 把城镇烙进标记位图 */
export function stampTowns(towns: readonly Town[]): {
  town: Uint8Array
  farm: Uint8Array
  building: Uint8Array
} {
  const town = new Uint8Array(N)
  const farm = new Uint8Array(N)
  const building = new Uint8Array(N)
  for (const t of towns) {
    for (let i = 0; i < t.plaza.length; i += 2) town[t.plaza[i + 1]! * WORLD_SIZE + t.plaza[i]!] = 1
    for (let i = 0; i < t.paths.length; i += 2) town[t.paths[i + 1]! * WORLD_SIZE + t.paths[i]!] = 1
    for (const b of t.buildings) {
      for (let yy = 0; yy < b.h; yy++) {
        for (let xx = 0; xx < b.w; xx++) {
          const i = wrapTile(b.y + yy) * WORLD_SIZE + wrapTile(b.x + xx)
          town[i] = 1
          building[i] = b.storeys
        }
      }
    }
    for (let i = 0; i < t.fields.length; i += 2) farm[t.fields[i + 1]! * WORLD_SIZE + t.fields[i]!] = 1
  }
  return { town, farm, building }
}
