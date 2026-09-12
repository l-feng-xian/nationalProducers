/**
 * 世界查询层：格子回绕、可行走判定、地形高度、生态群落摆放。
 *
 * 这一层刻意**不持有任何渲染对象**，只回答「(x,y) 那格是什么」。
 * 渲染、输入、存档都从这里取数据，互不依赖 —— 也因此它能整体挪进 Worker。
 *
 * ## 生态群落
 * 装饰物不是均匀撒的，而是三个群落层：
 * - **森林**：湿度场高处树密度拉满，高海拔/湿冷长针叶、低地长阔叶；
 * - **花田草原**：中等湿度的开阔地，零星树 + 成片小花；
 * - **村庄**：聚落场（noise.district）划出的「文明大区」里，按 24×24 区域
 *   掷出村落 —— 村心水井、十字土路、田垄、房屋（3×3 哈希极大值法保间距）、
 *   干草垛与围栏。全部确定性推导，零存储、回绕后必然一致。
 *
 * 纯 service：不 import vue/pinia。
 */

import {
  BIOME,
  BLOCK_H,
  SHALLOW_BED_Y,
  WATER_BED_Y,
  createSampler,
  isWalkable,
  type Biome,
  type WorldParams,
  type WorldSampler,
} from './noise'
import { fnv1a, hashTile } from '@/services/hash'
import type { RpgGenParams } from '@/types/rpg'
import { WILD_REGION, villageName, wildName, type TerrainClass } from './names'

/** 场景装饰物的种类 */
export type PropKind =
  | 'tree'
  | 'pine'
  | 'bush'
  | 'flower'
  | 'house'
  | 'well'
  | 'haystack'
  | 'haybale'
  | 'fence'
  | 'crop'
  | 'scarecrow'
  | 'rock'
  | 'bench'
  | 'lantern'
  | 'signpost'

export interface PropInstance {
  kind: PropKind
  /** 格坐标（整数，已回绕） */
  x: number
  y: number
  /** 同格内的亚格偏移，避免所有装饰物都钉在格心 */
  ox: number
  oy: number
  /** 变体：挑颜色 / 体量 / 屋顶配色 */
  variant: number
  /** 朝向 0-3（×90°）。建筑与围栏用它；田垄恒为 0 保证垄线平行 */
  rot: number
}

export interface World {
  readonly params: Required<Pick<WorldParams, 'width' | 'height' | 'seed'>>
  readonly sampler: WorldSampler
  biomeAt(x: number, y: number): Biome
  walkableAt(x: number, y: number): boolean
  /** 该格能不能站人/走过去：陆地且没有「实体感」道具（房、井、树、灯柱……） */
  blockedAt(x: number, y: number): boolean
  /** 该格地表顶面的世界高度。角色与道具都站在它上面；水格是海床 */
  heightAt(x: number, y: number): number
  /** 该格是不是村道（影响地块颜色，也不摆装饰物） */
  pathAt(x: number, y: number): boolean
  /** 该格的装饰物。确定性：同一格永远算出同一个结果 */
  propAt(x: number, y: number): PropInstance | null
  /** 一句话描述该格所在的区域（村庄/森林/沙滩……），给对话情境用 */
  describeArea(x: number, y: number): string
  /** 某格的内容签名，用于「绕一圈回到同一处」的断言 */
  signatureAt(x: number, y: number): number
  /**
   * 全世界的村庄。结果走既有的区域缓存，重复调用不重算。
   *
   * 一处添加服务三个用途：创建向导的缩略图标点与数量读数、NPC 按角色落点、
   * 以及地名。
   */
  listVillages(): readonly Village[]
}

/**
 * 挡路的道具种类：体积大到「人站进去会穿模」的才算。
 * 花、作物、草丛、干草垛这类贴地小件刻意不挡 —— 村里本来就该能踩着走，
 * 全挡的话村庄会变成迷宫，NPC 的落点/漫游目标也几乎无处可选。
 */
const BLOCKERS: ReadonlySet<PropKind> = new Set([
  'house',
  'well',
  'tree',
  'pine',
  'rock',
  'lantern',
  'signpost',
  'scarecrow',
])

// hashTile 搬去了 services/hash —— names.ts 也要用它，留在这里会绕成
// world ⇄ names 的循环依赖（现在能跑只是因为函数声明被提升，改天谁加一行
// 顶层调用就静默炸）。这里 re-export，既有 import 不用改
export { hashTile }

/**
 * 把存档翻成生成参数。
 *
 * **唯一的翻译点** —— 别在各调用处自己展开 gen，那样加一个旋钮就要改 N 处，
 * 而漏掉的那一处会静默地用回默认值（表现为「同一个世界在不同入口长得不一样」）。
 */
export function worldParamsOf(w: {
  seed: number
  width: number
  height: number
  gen: RpgGenParams
}): WorldParams {
  return {
    width: w.width,
    height: w.height,
    seed: w.seed,
    seaLevel: w.gen.seaLevel,
    r1: w.gen.radius,
    r2: w.gen.radius,
    moistureBias: w.gen.moistureBias,
    districtGate: w.gen.districtGate,
    villageChance: w.gen.villageChance,
  }
}

/**
 * 环面上的最短位移：把 d 折进 [-m/2, m/2)。
 *
 * 世界是环面，所以「两点差多少」这件事在本模块里到处都要问一遍：碰撞、
 * 最近 NPC、村庄距离、渲染时该把地块摆到哪个镜像。此前同一个式子在
 * world / engine / types 三处各写了一份，改一处漏两处只是时间问题。
 *
 * 前提 |d| < 1.5m —— 所有调用方的坐标都已回绕进 [0,m)，自然满足。
 */
export function wrapDelta(d: number, m: number): number {
  if (d > m / 2) return d - m
  if (d < -m / 2) return d + m
  return d
}

/** 村落的区域边长（格）。村子半径 ≤ 8，一个村子最多伸进相邻区域一格 */
const REGION = 24

export interface Village {
  /** 村名，如「青柳村」。确定性推导、随村庄一起缓存，零重复开销 */
  name: string
  /** 村心（水井所在格，已回绕） */
  cx: number
  cy: number
  /** 半径（格） */
  r: number
  /** 田垄矩形的左上角（绝对格坐标，已回绕）。恒在村心东南侧，避开十字路 */
  fx: number
  fy: number
}

export function createWorld(p: WorldParams): World {
  const sampler = createSampler(p)
  const { wrapX, wrapY } = sampler
  const W = sampler.width
  const H = sampler.height
  const seed = p.seed

  const torusDx = (x: number, cx: number): number => wrapDelta(x - cx, W)
  const torusDy = (y: number, cy: number): number => wrapDelta(y - cy, H)

  // 村庄的两个旋钮。默认值就是参数化之前写死的那两个数，见 noise.ts DEFAULTS 的说明
  const districtGate = p.districtGate ?? 0.1
  const villageChance = p.villageChance ?? 0.62

  /**
   * 当地地貌属于哪一类 —— 只用来挑地名里的那个特征字。
   * 判定顺序即优先级：先看有没有水，再看林，再看地势，最后才是平地。
   */
  const terrainClassAt = (x: number, y: number): TerrainClass => {
    const wx = wrapX(Math.floor(x))
    const wy = wrapY(Math.floor(y))
    // 附近三格内有水就算「水边」—— 村子挨着湖，名字里该有水
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const b = sampler.biomeAt(wrapX(wx + dx), wrapY(wy + dy))
        if (b === BIOME.water || b === BIOME.shallow) return 'water'
      }
    }
    if (sampler.moisture(wx, wy) > 0.18) return 'forest'
    return sampler.levelAt(wx, wy) >= 4 ? 'hill' : 'plain'
  }

  // ── 村落：按区域惰性求值并缓存 ──

  const villages = new Map<number, Village | null>()

  /** 村心落点：从候选点螺旋外扩，找一块 1..4 级的草地（不泡水、不站崖顶） */
  function findVillageSpot(ox: number, oy: number): { x: number; y: number } | null {
    for (let r = 0; r <= 7; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const wx = wrapX(ox + dx)
          const wy = wrapY(oy + dy)
          if (sampler.biomeAt(wx, wy) !== BIOME.grass) continue
          const lv = sampler.levelAt(wx, wy)
          if (lv >= 1 && lv <= 4) return { x: wx, y: wy }
        }
      }
    }
    return null
  }

  function findVillage(rx: number, ry: number): Village | null {
    const key = rx * 4096 + ry
    const cached = villages.get(key)
    if (cached !== undefined) return cached

    let v: Village | null = null
    const h = hashTile(seed ^ 0x3f1a2b, rx, ry)
    // 聚落场门控：只有「文明大区」里的区域才掷骰子
    const gate = sampler.district(wrapX(rx * REGION + REGION / 2), wrapY(ry * REGION + REGION / 2))
    if (gate > districtGate && (h >>> 8) / 0x1000000 < villageChance) {
      const ox = rx * REGION + 4 + ((h >>> 3) & 0xf)
      const oy = ry * REGION + 4 + ((h >>> 19) & 0xf)
      const spot = findVillageSpot(ox, oy)
      if (spot) {
        v = {
          name: villageName(seed, rx, ry, terrainClassAt(spot.x, spot.y)),
          cx: spot.x,
          cy: spot.y,
          r: 5 + ((h >>> 5) & 3),
          fx: wrapX(spot.x + 2),
          fy: wrapY(spot.y + 2),
        }
      }
    }
    villages.set(key, v)
    return v
  }

  /**
   * 全世界的村庄，按区域键升序（确定性 —— NPC 轮转落点要靠这个顺序稳定）。
   * 走的是 findVillage 的既有缓存，重复调用不重算。
   */
  function listVillages(): readonly Village[] {
    const spanX = Math.max(1, Math.ceil(W / REGION))
    const spanY = Math.max(1, Math.ceil(H / REGION))
    const out: Village[] = []
    for (let ry = 0; ry < spanY; ry++) {
      for (let rx = 0; rx < spanX; rx++) {
        const v = findVillage(rx, ry)
        if (v) out.push(v)
      }
    }
    return out
  }

  /** 该格落在哪个村子的影响范围内（查自身 + 八邻区域；村子可能跨区域） */
  function villageNear(x: number, y: number): Village | null {
    const spanX = Math.max(1, Math.ceil(W / REGION))
    const spanY = Math.max(1, Math.ceil(H / REGION))
    const rx = Math.floor(x / REGION)
    const ry = Math.floor(y / REGION)
    let best: Village | null = null
    let bestD = Infinity
    for (let dyy = -1; dyy <= 1; dyy++) {
      for (let dxx = -1; dxx <= 1; dxx++) {
        const v = findVillage(
          (((rx + dxx) % spanX) + spanX) % spanX,
          (((ry + dyy) % spanY) + spanY) % spanY,
        )
        if (!v) continue
        const ddx = torusDx(x, v.cx)
        const ddy = torusDy(y, v.cy)
        const d = ddx * ddx + ddy * ddy
        if (d <= v.r * v.r && d < bestD) {
          best = v
          bestD = d
        }
      }
    }
    return best
  }

  /** 房屋间距：一格是房，当且仅当它的哈希分数是 3×3 邻域严格最大。两房必然不相邻 */
  const houseScore = (x: number, y: number): number =>
    (hashTile(seed ^ 0x2c0ffee, x, y) >>> 8) / 0x1000000

  function isHouseMax(wx: number, wy: number): boolean {
    const s0 = houseScore(wx, wy)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        if (houseScore(wrapX(wx + dx), wrapY(wy + dy)) >= s0) return false
      }
    }
    return true
  }

  /** 田里的相对位置（不在田里返回 null）。田是 4×3，(1,1) 是正中 */
  const fieldPos = (v: Village, wx: number, wy: number): { fx: number; fy: number } | null => {
    const fdx = torusDx(wx, v.fx)
    const fdy = torusDy(wy, v.fy)
    if (fdx >= 0 && fdx < 4 && fdy >= 0 && fdy < 3) return { fx: fdx, fy: fdy }
    return null
  }

  const biomeAt = (x: number, y: number): Biome =>
    sampler.biomeAt(wrapX(Math.floor(x)), wrapY(Math.floor(y)))

  const walkableAt = (x: number, y: number): boolean => isWalkable(biomeAt(x, y))

  const blockedAt = (x: number, y: number): boolean => {
    const pr = propAt(x, y)
    return pr !== null && BLOCKERS.has(pr.kind)
  }

  const heightAt = (x: number, y: number): number => {
    const wx = wrapX(Math.floor(x))
    const wy = wrapY(Math.floor(y))
    const b = sampler.biomeAt(wx, wy)
    if (b === BIOME.water) return WATER_BED_Y
    if (b === BIOME.shallow) return SHALLOW_BED_Y
    return sampler.levelAt(wx, wy) * BLOCK_H
  }

  const pathAt = (x: number, y: number): boolean => {
    const wx = wrapX(Math.floor(x))
    const wy = wrapY(Math.floor(y))
    const b = sampler.biomeAt(wx, wy)
    if (b !== BIOME.grass && b !== BIOME.sand) return false
    const v = villageNear(wx, wy)
    if (!v) return false
    const ddx = torusDx(wx, v.cx)
    const ddy = torusDy(wy, v.cy)
    if (ddx * ddx + ddy * ddy > v.r * v.r) return false
    if (ddx !== 0 && ddy !== 0) return false
    // 断续的土路：哈希留缺口，像被人踩出来的
    return (hashTile(seed ^ 0x7a11, wx, wy) >>> 4) % 5 !== 0
  }

  /**
   * 每格的装饰物（确定性、零存储）。
   * 格坐标哈希出一个稳定随机数，再按「村庄 / 森林 / 花田 / 干草原」分层摆放。
   */
  const propAt = (x: number, y: number): PropInstance | null => {
    const wx = wrapX(Math.floor(x))
    const wy = wrapY(Math.floor(y))
    const b = sampler.biomeAt(wx, wy)
    if (b === BIOME.water || b === BIOME.shallow) return null

    const h = hashTile(seed, wx, wy)
    const r = (h >>> 8) / 0x1000000 // 0..1
    const m = sampler.moisture(wx, wy)
    const lv = sampler.levelAt(wx, wy)
    // 格内偏移：取哈希的另外两段，免得所有东西都钉在格心排成网格
    const jitter = (shift: number, amp: number): number =>
      (((h >>> shift) & 0xff) / 255 - 0.5) * 2 * amp

    // ── 村庄 ──
    const v = villageNear(wx, wy)
    if (v) {
      const ddx = torusDx(wx, v.cx)
      const ddy = torusDy(wy, v.cy)
      const d2 = ddx * ddx + ddy * ddy
      // 村心是水井
      if (d2 === 0) return { kind: 'well', x: wx, y: wy, ox: 0, oy: 0, variant: 0, rot: 0 }
      // 田垄：对齐格心，垄线才会平行；田中央立一个稻草人
      const fp = b === BIOME.grass ? fieldPos(v, wx, wy) : null
      if (fp) {
        if (fp.fx === 1 && fp.fy === 1) {
          return { kind: 'scarecrow', x: wx, y: wy, ox: 0, oy: 0, variant: h & 3, rot: 0 }
        }
        return { kind: 'crop', x: wx, y: wy, ox: 0, oy: 0, variant: h & 3, rot: 0 }
      }
      // 村道不摆东西
      if (pathAt(wx, wy)) return null
      if (b !== BIOME.grass) return null
      // 路灯：紧贴十字路两侧的一圈，偏移把灯柱推离路面
      const roadside = (Math.abs(ddx) === 1 && ddy === 0) || (Math.abs(ddy) === 1 && ddx === 0)
      if (roadside && r < 0.15) {
        return {
          kind: 'lantern',
          x: wx,
          y: wy,
          ox: ddx !== 0 ? Math.sign(ddx) * 0.12 : 0,
          oy: ddy !== 0 ? Math.sign(ddy) * 0.12 : 0,
          variant: 0,
          rot: 0,
        }
      }
      // 指示牌：路口附近
      if ((ddx === 0 || ddy === 0) && d2 >= 2 && d2 <= 9 && r >= 0.15 && r < 0.18) {
        return { kind: 'signpost', x: wx, y: wy, ox: 0, oy: 0, variant: h & 3, rot: 0 }
      }
      if (lv >= 1 && lv <= 4 && isHouseMax(wx, wy)) {
        return {
          kind: 'house',
          x: wx,
          y: wy,
          ox: jitter(3, 0.08),
          oy: jitter(19, 0.08),
          variant: (h >>> 26) & 3,
          rot: (h >>> 6) & 3,
        }
      }
      if (r < 0.22) {
        return {
          kind: 'haystack',
          x: wx,
          y: wy,
          ox: jitter(3, 0.15),
          oy: jitter(19, 0.15),
          variant: h & 3,
          rot: 0,
        }
      }
      if (r < 0.27) {
        return {
          kind: 'haybale',
          x: wx,
          y: wy,
          ox: jitter(3, 0.18),
          oy: jitter(19, 0.18),
          variant: h & 3,
          rot: 0,
        }
      }
      if (r < 0.4 && d2 > 6) {
        return { kind: 'fence', x: wx, y: wy, ox: 0, oy: 0, variant: 0, rot: (h >>> 6) & 3 }
      }
      if (r < 0.44) {
        return { kind: 'bench', x: wx, y: wy, ox: 0, oy: 0, variant: 0, rot: (h >>> 6) & 3 }
      }
      if (r < 0.5) {
        return {
          kind: 'flower',
          x: wx,
          y: wy,
          ox: jitter(3, 0.3),
          oy: jitter(19, 0.3),
          variant: h & 3,
          rot: 0,
        }
      }
      return null
    }

    // ── 荒野 ──
    if (b === BIOME.sand) {
      if (r < 0.012) {
        return {
          kind: 'bush',
          x: wx,
          y: wy,
          ox: jitter(3, 0.3),
          oy: jitter(19, 0.3),
          variant: h & 3,
          rot: 0,
        }
      }
      if (r < 0.035) {
        return {
          kind: 'rock',
          x: wx,
          y: wy,
          ox: jitter(3, 0.25),
          oy: jitter(19, 0.25),
          variant: h & 3,
          rot: 0,
        }
      }
      return null
    }
    // 森林：高密度树。高海拔或很湿 → 针叶，低地 → 阔叶
    if (m > 0.18) {
      const pine = lv >= 3 || m > 0.4
      if (r < 0.4) {
        return {
          kind: pine ? 'pine' : 'tree',
          x: wx,
          y: wy,
          ox: jitter(3, 0.3),
          oy: jitter(19, 0.3),
          variant: h & 3,
          rot: 0,
        }
      }
      if (r < 0.45) {
        return {
          kind: 'bush',
          x: wx,
          y: wy,
          ox: jitter(3, 0.3),
          oy: jitter(19, 0.3),
          variant: h & 3,
          rot: 0,
        }
      }
      if (r < 0.47) {
        return {
          kind: 'rock',
          x: wx,
          y: wy,
          ox: jitter(3, 0.25),
          oy: jitter(19, 0.25),
          variant: h & 3,
          rot: 0,
        }
      }
      return null
    }
    // 花田草原：零星树 + 成片小花
    if (m > 0) {
      if (r < 0.03) {
        return {
          kind: 'tree',
          x: wx,
          y: wy,
          ox: jitter(3, 0.3),
          oy: jitter(19, 0.3),
          variant: h & 3,
          rot: 0,
        }
      }
      if (r < 0.05) {
        return {
          kind: 'bush',
          x: wx,
          y: wy,
          ox: jitter(3, 0.3),
          oy: jitter(19, 0.3),
          variant: h & 3,
          rot: 0,
        }
      }
      if (r < 0.16) {
        return {
          kind: 'flower',
          x: wx,
          y: wy,
          ox: jitter(3, 0.32),
          oy: jitter(19, 0.32),
          variant: h & 3,
          rot: 0,
        }
      }
      if (r < 0.2) {
        return {
          kind: 'rock',
          x: wx,
          y: wy,
          ox: jitter(3, 0.25),
          oy: jitter(19, 0.25),
          variant: h & 3,
          rot: 0,
        }
      }
      return null
    }
    // 干草原
    if (r < 0.018) {
      return {
        kind: 'tree',
        x: wx,
        y: wy,
        ox: jitter(3, 0.3),
        oy: jitter(19, 0.3),
        variant: h & 3,
        rot: 0,
      }
    }
    if (r < 0.03) {
      return {
        kind: 'bush',
        x: wx,
        y: wy,
        ox: jitter(3, 0.3),
        oy: jitter(19, 0.3),
        variant: h & 3,
        rot: 0,
      }
    }
    if (r < 0.04) {
      return {
        kind: 'flower',
        x: wx,
        y: wy,
        ox: jitter(3, 0.3),
        oy: jitter(19, 0.3),
        variant: h & 3,
        rot: 0,
      }
    }
    if (r < 0.075) {
      return {
        kind: 'rock',
        x: wx,
        y: wy,
        ox: jitter(3, 0.25),
        oy: jitter(19, 0.25),
        variant: h & 3,
        rot: 0,
      }
    }
    return null
  }

  /**
   * 一格的内容摘要。绕行闭环断言与「改动前后地形逐格一致」的兼容性预言机都用它。
   *
   * ⚠️ 必须把**台阶等级与道具的变体/朝向**也摘进去。原先只摘
   * `biome:path:propKind`，于是「只改高度不改生态」的格（海平面、内陆湖都属于
   * 这一类）在旧签名下看起来「一样」—— 拿那个去证明兼容性等于没证。
   */
  const signatureAt = (x: number, y: number): number => {
    const wx = wrapX(Math.floor(x))
    const wy = wrapY(Math.floor(y))
    const pr = propAt(wx, wy)
    return fnv1a(
      `${sampler.biomeAt(wx, wy)}:${sampler.levelAt(wx, wy)}:${pathAt(wx, wy) ? 'p' : '-'}:` +
        `${pr?.kind ?? '-'}:${pr?.variant ?? -1}:${pr?.rot ?? -1}:` +
        `${(pr?.ox ?? 0).toFixed(3)}:${(pr?.oy ?? 0).toFixed(3)}`,
    )
  }

  /** 地标优先级：越靠前越是「有故事的地方」,对话情境优先用它 */
  const LANDMARKS: Partial<Record<PropKind, string>> = {
    well: '水井旁',
    crop: '农田边',
    house: '房屋旁',
    bench: '长椅旁',
    haystack: '干草垛旁',
    haybale: '谷仓边',
    lantern: '路灯下',
    scarecrow: '稻草人旁',
  }

  /**
   * 相对村心的方位词。给「青柳村西边的麦田」这种说法用。
   * ⚠️ 中文是**东南/西北**的字序，不是「南东」—— 东西在前，南北在后。
   */
  const bearing = (dx: number, dy: number): string => {
    const we = dx < -1.5 ? '西' : dx > 1.5 ? '东' : ''
    const ns = dy < -1.5 ? '北' : dy > 1.5 ? '南' : ''
    return we || ns ? `${we}${ns}边的` : ''
  }

  /**
   * 一句话描述该格所在的区域，进对话提示词的【场景】。
   *
   * 带上地名是免费的沉浸感：模型收到「青柳村西边的麦田」比收到「农田边」
   * 能推出多得多的东西，而这一个字的 token 都不用额外花。
   */
  const describeArea = (x: number, y: number): string => {
    const wx = wrapX(Math.floor(x))
    const wy = wrapY(Math.floor(y))
    const b = sampler.biomeAt(wx, wy)
    const v = villageNear(wx, wy)
    if (b === BIOME.water || b === BIOME.shallow) {
      if (v) return `${v.name}外的水边`
      const gx = Math.floor(wx / WILD_REGION)
      const gy = Math.floor(wy / WILD_REGION)
      return `${wildName(seed, gx, gy, 'water')}畔`
    }
    if (pathAt(wx, wy)) return v ? `${v.name}的村道上` : '村道上'
    // 半径 2 格内找最近的地标
    for (let r = 1; r <= 2; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const pr = propAt(wrapX(wx + dx), wrapY(wy + dy))
          const mark = pr ? LANDMARKS[pr.kind] : undefined
          if (mark) {
            return v ? `${v.name}${bearing(torusDx(wx, v.cx), torusDy(wy, v.cy))}${mark}` : mark
          }
        }
      }
    }
    if (b === BIOME.sand) return '沙滩上'
    // 野地用比村庄粗得多的网格命名 —— 每走两步换个地名反而出戏
    const gx = Math.floor(wx / WILD_REGION)
    const gy = Math.floor(wy / WILD_REGION)
    const m = sampler.moisture(wx, wy)
    if (m > 0.18) return `${wildName(seed, gx, gy, 'forest')}中`
    if (m > 0) return `${wildName(seed, gx, gy, 'plain')}上`
    return `${wildName(seed, gx, gy, 'hill')}中`
  }

  return {
    params: { width: sampler.width, height: sampler.height, seed: p.seed },
    sampler,
    biomeAt,
    walkableAt,
    blockedAt,
    heightAt,
    pathAt,
    propAt,
    describeArea,
    signatureAt,
    listVillages,
  }
}

/**
 * 从 (x,y) 螺旋外扩找一块能站人的格。
 *
 * 从 engine.ts 搬过来的：它只问世界，不需要引擎、更不需要 WebGPU 上下文 ——
 * 而创建向导要在地图还没渲染过一帧的时候就给 NPC 定位。
 *
 * `avoid` 传的是**格心**浮点坐标，与引擎里 npcRt 的坐标约定一致，搬家后
 * 引擎那边的行为一格不差。
 */
export function findStandSpot(
  world: World,
  x: number,
  y: number,
  opts: {
    maxR?: number
    avoid?: ReadonlyArray<{ x: number; y: number }>
    minDist?: number
  } = {},
): { x: number; y: number } | null {
  const W = world.params.width
  const H = world.params.height
  const maxR = opts.maxR ?? 12
  const minDist = opts.minDist ?? 0
  const avoid = opts.avoid ?? []
  const gx = Math.floor(x)
  const gy = Math.floor(y)
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // 只看当前这一圈的边，内圈上一轮已经查过了
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const tx = (((gx + dx) % W) + W) % W
        const ty = (((gy + dy) % H) + H) % H
        const cx = tx + 0.5
        const cy = ty + 0.5
        if (!world.walkableAt(cx, cy) || world.blockedAt(cx, cy)) continue
        if (minDist > 0) {
          const crowded = avoid.some(
            (a) => Math.hypot(wrapDelta(a.x - cx, W), wrapDelta(a.y - cy, H)) < minDist,
          )
          if (crowded) continue
        }
        return { x: tx, y: ty }
      }
    }
  }
  return null
}

/**
 * 找一块可以站人的出生地。
 *
 * 从中心开始按螺旋外扩 —— 直接用中心点的话，种子一换很可能开局站在海里。
 * 与 findStandSpot 的区别：出生点不忌讳道具（站在树边没问题），且搜索半径大得多。
 */
export function findSpawn(world: World): { x: number; y: number } {
  const cx = Math.floor(world.params.width / 2)
  const cy = Math.floor(world.params.height / 2)
  for (let r = 0; r < 160; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const x = cx + dx
        const y = cy + dy
        if (world.walkableAt(x, y)) return { x: x + 0.5, y: y + 0.5 }
      }
    }
  }
  return { x: cx + 0.5, y: cy + 0.5 }
}
