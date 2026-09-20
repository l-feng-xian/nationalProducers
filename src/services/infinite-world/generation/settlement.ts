/**
 * 城镇规划：确定性推导，零存储。
 *
 * 农场生活村庄：水井空地、弯曲主路、独立院落和菜地。
 * villageLayout 负责布局；旧版存档使用 settlementLegacy 保留原有位置。
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
import { torusDist2, wrapTile } from '../core/torus'
import type { Fields } from './fields'
import { WATER } from './hydrology'
import { hash01, hashInt, seedOf } from './rng'
import { buildVillage } from './villageLayout'
import { buildVillage as buildVillageV2 } from './villageLayoutV2'
import { buildReferenceTown, type TownProp, type TownPaving } from './referenceTown'

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
  art?: string
  /** Cell immediately south of the visible doorway, connected to a village lane. */
  door?: [number, number]
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
  /** Planned parcels and boundaries, introduced with torus-3. */
  lots?: TownLot[]
  beds?: FarmBed[]
  boundaries?: TownBoundary[]
  props?: TownProp[]
  paving?: TownPaving[]
}

export interface TownLot {
  x: number
  y: number
  w: number
  h: number
  building: number
  streetY: number
}

export interface FarmBed {
  x: number
  y: number
  w: number
  h: number
  crop: 'cabbage' | 'seedling' | 'wheat' | 'beans'
  density?: 'dense'
}

export interface TownBoundary {
  x: number
  y: number
  w: number
  kind: 'fence' | 'hedge'
  axis?: 'x' | 'y'
}

export interface SettlementParams {
  layoutVersion?: 'torus-2' | 'torus-3' | 'torus-4'
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
      const newRadius =
        p.layoutVersion === 'torus-2'
          ? townRadius(base, rx, ry)
          : 22 + hashInt(base, 3, 'radius', rx, ry)

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

      let town = buildTown(base, rx, ry, spot[0], spot[1], newRadius, p, isDry, canBuild)
      if (p.layoutVersion !== 'torus-2') {
        // Evaluate a bounded set of nearby sites for complete street blocks, not just a dry center.
        // Keep existing-world v2 selection byte-for-byte unchanged.
        const score = (t: Town) => t.buildings.length + (t.beds?.length ?? 0) * 1.5
        let best = score(town)
        const reference = p.layoutVersion === 'torus-4'
        const searchRadius = reference ? 15 : 9
        const target = reference ? 8 + (p.fieldDensity > 0 ? 4.5 : 0) : 13
        for (let dy = -searchRadius; dy <= searchRadius && best < target; dy += 3) {
          for (let dx = -searchRadius; dx <= searchRadius && best < target; dx += 3) {
            const x = wrapTile(spot[0] + dx),
              y = wrapTile(spot[1] + dy)
            if (!isDry(x, y) || !isFlat(x, y)) continue
            if (towns.some((t) => torusDist2(x, y, t.cx, t.cy) < (t.radius + newRadius + 2) ** 2))
              continue
            const trial = buildTown(base, rx, ry, x, y, newRadius, p, isDry, canBuild)
            if (trial.plaza.length < 50 || trial.gates.length < 4) continue
            const quality = score(trial)
            if (quality > best) {
              best = quality
              town = trial
            }
          }
        }
      }
      // ⚠️ 被地形（水/陡坡）挤住的落点会产出「只有两栋房」的退化镇。
      // 那不是镇，是两间孤屋 —— 与其放宽验收标准，不如在这里直接淘汰。
      // 淘汰是确定性的（只依赖已算出的 town 本身），不破坏零存储。
      if (town.buildings.filter((b) => b.kind !== 'well').length < MIN_BUILDINGS) continue
      // The reference layout is a complete neighbourhood. Reject unsuitable sites
      // instead of leaving missing cottages or half a farm inside its street loop.
      if (
        p.layoutVersion === 'torus-4' &&
        (town.buildings.length !== 8 || (p.fieldDensity > 0 && town.beds?.length !== 3))
      )
        continue
      if (town.plaza.length < 50 || town.gates.length < 4) continue
      towns.push(town)
    }
  }

  return towns
}

/**
 * 镇的半径。由 (seed, rx, ry) 确定，必须能在选址前独立算出来。
 *
 * 14..19 格为庭院和菜地预留空间。
 */
function townRadius(base: number, rx: number, ry: number): number {
  return 14 + hashInt(base, 6, 'radius', rx, ry)
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
  const name =
    NAME_PREFIX[hashInt(base, NAME_PREFIX.length, 'np', rx, ry)]! +
    NAME_SUFFIX[hashInt(base, NAME_SUFFIX.length, 'ns', rx, ry)]!
  return {
    id: `t${rx}:${ry}`,
    name,
    ...(p.layoutVersion === 'torus-2'
      ? buildVillageV2
      : p.layoutVersion === 'torus-4'
        ? buildReferenceTown
        : buildVillage)(base, rx, ry, cx, cy, radius, p, isDry, canBuild),
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
  parcel: Uint8Array
  boundary: Uint8Array
} {
  const town = new Uint8Array(N)
  const farm = new Uint8Array(N)
  const building = new Uint8Array(N)
  const parcel = new Uint8Array(N)
  const boundary = new Uint8Array(N)
  for (const t of towns) {
    for (const lot of t.lots ?? [])
      for (let yy = 0; yy < lot.h; yy++)
        for (let xx = 0; xx < lot.w; xx++)
          parcel[wrapTile(lot.y + yy) * WORLD_SIZE + wrapTile(lot.x + xx)] = 1
    for (const edge of t.boundaries ?? [])
      for (let xx = 0; xx < edge.w; xx++)
        boundary[
          wrapTile(edge.y + (edge.axis === 'y' ? xx : 0)) * WORLD_SIZE +
            wrapTile(edge.x + (edge.axis === 'y' ? 0 : xx))
        ] = 1
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
    for (let i = 0; i < t.fields.length; i += 2) {
      const iField = t.fields[i + 1]! * WORLD_SIZE + t.fields[i]!
      farm[iField] = 1
      if (t.paving) parcel[iField] = 1
    }
    if (t.paving)
      for (const edge of t.boundaries ?? [])
        for (let k = 0; k < edge.w; k++)
          parcel[
            wrapTile(edge.y + (edge.axis === 'y' ? k : 0)) * WORLD_SIZE +
              wrapTile(edge.x + (edge.axis === 'y' ? 0 : k))
          ] = 1
  }
  return { town, farm, building, parcel, boundary }
}
