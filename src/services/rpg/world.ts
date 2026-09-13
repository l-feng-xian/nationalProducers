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

/**
 * 生态分区（需求 2）。五个值，是**一处真相** —— 道具摆放、地貌措辞、地表着色
 * 都从 regionAt 取，不再各自读一遍湿度阈值。
 *
 * - water：海或湖（不可行走）
 * - beach：挨着水的沙（沙滩）
 * - forest：成林的湿润陆地
 * - meadow：中等湿度的开阔草甸（零星树 + 成片花）
 * - wilds：干旱地 —— 内陆沙漠（沙）或干草原（草），由 biome 再分表现
 */
export type Region = 'water' | 'beach' | 'forest' | 'meadow' | 'wilds'

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
  /** 该格是不是村内土路（村心十字，影响地块颜色，也不摆装饰物） */
  pathAt(x: number, y: number): boolean
  /**
   * 该格是不是**村庄之间的道路**（影响地块颜色，也不摆装饰物）。
   * 与 pathAt 分开：pathAt 是村内十字、绕村心；roadAt 是连接各村的主干道，
   * 走在野地里、绕开村庄内部。渲染两者同色，寻路（阶段三）都偏好走。
   */
  roadAt(x: number, y: number): boolean
  /** 该格所属的生态分区。道具/措辞/着色的唯一真相源 */
  regionAt(x: number, y: number): Region
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
  /**
   * 这一格在不在某个村子的影响范围内（在的话返回那个村）。
   *
   * ⚠️ **判断「在不在村里」只能用它**，绝不能去嗅 `describeArea` 的字面量。
   * 村名的后缀有 村/庄/屯/寨/坞/铺/集 七种（names.ts VILLAGE_SUFFIX），`includes('村')` 只认得出其中一种 ——
   * 作息就是这么把十个村民里的八个判成了「游荡者」的。
   */
  villageAt(x: number, y: number): Village | null
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

/** 一条密度规则：哈希分 r < upto 就摆这个道具（按 upto 升序判定） */
interface PropRoll {
  upto: number
  kind: PropKind
}

/**
 * 各生态带的道具密度（比例）表（需求 2「注意各元素比例」）。
 *
 * 原先这些 `r<0.4` 之类的魔法数散落在 propAt 的四个分支里，想调「树多花少」得
 * 满文件找。收进一张表后，比例一眼可读、可核、可调；阶段四换体素道具尺度时，
 * 只改这里的数就能重新配平，不必再动逻辑。
 *
 * zone 是 propAt 内部的道具带，与对外的 Region 有个小映射：beach 与内陆沙漠
 * 共用 'sand'（两者本就同密度，只是地名不同），wilds 的草地部分是 'steppe'。
 * 'forest' 的 tree 会在高地/极湿处升级成 pine（见 propAt）。
 */
const PROP_MIX: Record<'forest' | 'meadow' | 'steppe' | 'sand', PropRoll[]> = {
  forest: [
    { upto: 0.4, kind: 'tree' },
    { upto: 0.45, kind: 'bush' },
    { upto: 0.47, kind: 'rock' },
  ],
  meadow: [
    { upto: 0.03, kind: 'tree' },
    { upto: 0.05, kind: 'bush' },
    { upto: 0.16, kind: 'flower' },
    { upto: 0.2, kind: 'rock' },
  ],
  steppe: [
    { upto: 0.018, kind: 'tree' },
    { upto: 0.03, kind: 'bush' },
    { upto: 0.04, kind: 'flower' },
    { upto: 0.075, kind: 'rock' },
  ],
  sand: [
    { upto: 0.012, kind: 'bush' },
    { upto: 0.035, kind: 'rock' },
  ],
}

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
    lakes: w.gen.lakes,
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

/**
 * 世界的外部钩子。世界本身是纯推导的，这里是**唯一**允许外部影响它的缝。
 */
export interface WorldHooks {
  /**
   * 该格的道具是否已被采集、还没长回来。缺省恒 false。
   *
   * ⚠️ 由游戏页注入而不是 world 自己去读存档：world.ts 是纯 service，不认识
   * IndexedDB 也不认识时钟。缩略预览、落位、寻路都不传它 —— 它们只关心
   * 「这个种子长什么样」，与某一局的采集进度无关。
   */
  isHarvested?: (x: number, y: number) => boolean
}

export function createWorld(p: WorldParams, hooks: WorldHooks = {}): World {
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
    // 陆地一律平整（需求：地面除水面外设为平整）—— 不再按 levelAt 抬成梯田/悬崖。
    // ⚠️ 只是**高度**不随 levelAt 起伏；levelAt 本身照旧供草色分级与村庄/房屋落点
    // 判定（它们读的是「等级」而非「高度」）。水/浅滩/海床仍各保留深度，岸线的落差照旧。
    return 0
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

  /** 半径 r 内有没有水。给措辞与生态分区用（沙滩 = 挨着水的沙） */
  const waterWithin = (x: number, y: number, r: number): boolean => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const b = sampler.biomeAt(wrapX(x + dx), wrapY(y + dy))
        if (b === BIOME.water || b === BIOME.shallow) return true
      }
    }
    return false
  }

  /**
   * 生态分区（需求 2 的核心）—— 多层噪声叠加，让分界成片、有机、清晰。
   *
   * 不再是「湿度 > 0.18 就是森林」的单场一刀切，而是三层叠加：
   *  1. **宏生态省** macro：极低频，定「这一大片本就偏林还是偏荒」；
   *  2. **域扭曲** warp：把湿度的采样点错开，令森林/草甸的边界犬牙交错而非光滑椭圆；
   *  3. 扭曲后的**湿度**：在省的基调上决定这一小块的干湿。
   * 三者相加得 forestScore，再按两道阈值切出 forest / meadow / wilds。
   * 于是「大片森林里嵌着几块空地、荒野边缘有零星林」这种层次自然出现。
   */
  const regionAt = (x: number, y: number): Region => {
    const wx = wrapX(Math.floor(x))
    const wy = wrapY(Math.floor(y))
    const b = sampler.biomeAt(wx, wy)
    if (b === BIOME.water || b === BIOME.shallow) return 'water'
    if (b === BIOME.sand) {
      // 沙有两种成因：近岸（沙滩）与内陆干旱（荒漠，归 wilds）—— 见 describeArea 同款判据
      return waterWithin(wx, wy, 3) ? 'beach' : 'wilds'
    }
    // 陆地（草）：域扭曲后的湿度 + 宏省 叠加
    const mx = wx + sampler.warpX(wx, wy)
    const my = wy + sampler.warpY(wx, wy)
    const forestScore = sampler.moisture(mx, my) + sampler.macro(wx, wy) * 0.45
    if (forestScore > 0.2) return 'forest'
    if (forestScore > -0.02) return 'meadow'
    return 'wilds'
  }

  // ── 村庄之间的道路（需求 2：地图缺少道路）──
  //
  // 村庄是确定性的固定集合，所以路网也能确定性地一次算好、之后 O(1) 查表。
  // 连边用最小生成树（MST）保证**每个村庄都连得上**，再补几条近邻边成环，
  // 让路网不是一根光秃秃的链。每条边在环面上碾出一条带轻微摆动的路。

  /** 路面格集合（键 = wy*W+wx）。首次 roadAt 时惰性构建、之后一直复用 */
  let roadCells: Set<number> | null = null
  /** 道路摆动幅度（格）。借用域扭曲场当平滑的随机偏移，路才不是直尺画的 */
  const ROAD_WOBBLE = 0.35

  /** 标记一格为路面：只铺在可走的陆地上，且避开村庄内部（村内交给十字村道） */
  const markRoadCell = (cells: Set<number>, gx: number, gy: number): void => {
    const wx = wrapX(gx)
    const wy = wrapY(gy)
    const b = sampler.biomeAt(wx, wy)
    if (b !== BIOME.grass && b !== BIOME.sand) return // 不铺过水/浅滩，遇水断口
    if (villageNear(wx, wy)) return
    cells.add(wy * W + wx)
  }

  /** 在环面上把 a、b 两村心之间碾出一条路 */
  const carveRoad = (cells: Set<number>, a: Village, b: Village): void => {
    const dx = wrapDelta(b.cx - a.cx, W)
    const dy = wrapDelta(b.cy - a.cy, H)
    const steps = Math.max(Math.abs(dx), Math.abs(dy))
    if (steps === 0) return
    const len = Math.hypot(dx, dy) || 1
    // 垂直于路向的单位向量，摆动往这个方向加
    const px = -dy / len
    const py = dx / len
    let prevX = NaN
    let prevY = NaN
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const bx = a.cx + dx * t
      const by = a.cy + dy * t
      const wob = sampler.warpX(Math.round(bx), Math.round(by)) * ROAD_WOBBLE
      const gx = wrapX(Math.round(bx + px * wob))
      const gy = wrapY(Math.round(by + py * wob))
      // 4-连通：与上一格若走成对角，补一个正交角格 —— 否则 NPC（阶段三）沿路走时
      // 会在对角缺口处判成「路断了」
      if (!Number.isNaN(prevX)) {
        const adx = Math.abs(wrapDelta(gx - prevX, W))
        const ady = Math.abs(wrapDelta(gy - prevY, H))
        if (adx >= 1 && ady >= 1) markRoadCell(cells, gx, prevY)
      }
      markRoadCell(cells, gx, gy)
      prevX = gx
      prevY = gy
    }
  }

  /** 一次性构建整张路网 */
  const buildRoads = (): Set<number> => {
    const cells = new Set<number>()
    const vs = listVillages()
    const n = vs.length
    if (n < 2) return cells

    const dist2 = (a: Village, b: Village): number => {
      const ex = wrapDelta(a.cx - b.cx, W)
      const ey = wrapDelta(a.cy - b.cy, H)
      return ex * ex + ey * ey
    }

    // Prim 最小生成树：确定性（同距离按索引序破平），保证全连通
    const inTree = new Array<boolean>(n).fill(false)
    const edges: Array<[number, number]> = []
    inTree[0] = true
    for (let added = 1; added < n; added++) {
      let bi = -1
      let bj = -1
      let bd = Infinity
      for (let i = 0; i < n; i++) {
        if (!inTree[i]) continue
        for (let j = 0; j < n; j++) {
          if (inTree[j]) continue
          const d = dist2(vs[i]!, vs[j]!)
          if (d < bd) {
            bd = d
            bi = i
            bj = j
          }
        }
      }
      if (bj < 0) break
      inTree[bj] = true
      edges.push([bi, bj])
    }

    // 近邻增边：每个村再连它最近的一个村（去重）—— 给路网加环，更像真实路网而非一根链。
    // ⚠️ 要求那个邻村**够远**（村心距 > 两村半径之和 + 3）才连：否则两个「贴脸」的村
    // 之间那条边会整段落在村庄影响圈内被 markRoadCell 全部丢弃，等于没连 —— 结果就是
    // 某个村明明在 MST 里连通、却一条看得见的路都没有。挑够远的邻村保证每个村至少碾出一条路。
    const seen = new Set(edges.map(([i, j]) => (i < j ? i * n + j : j * n + i)))
    for (let i = 0; i < n; i++) {
      let bj = -1
      let bd = Infinity
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const gap = vs[i]!.r + vs[j]!.r + 3
        const d = dist2(vs[i]!, vs[j]!)
        if (d <= gap * gap) continue // 太近，边会被村庄影响圈整段吃掉
        if (d < bd) {
          bd = d
          bj = j
        }
      }
      if (bj < 0) continue
      const key = i < bj ? i * n + bj : bj * n + i
      if (!seen.has(key)) {
        seen.add(key)
        edges.push([i, bj])
      }
    }

    for (const [i, j] of edges) carveRoad(cells, vs[i]!, vs[j]!)
    return cells
  }

  const roadAt = (x: number, y: number): boolean => {
    if (!roadCells) roadCells = buildRoads()
    const wx = wrapX(Math.floor(x))
    const wy = wrapY(Math.floor(y))
    return roadCells.has(wy * W + wx)
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
    // 已被采集、还没长回来 —— 这一格此刻就是空地
    if (hooks.isHarvested?.(wx, wy)) return null
    // 村庄之间的道路上不摆东西（roadAt 已避开村庄内部，不会误伤水井/田/村道十字）
    if (roadAt(wx, wy)) return null

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

    // ── 野地：按生态分区查 PROP_MIX ──
    // 分区是「一处真相」，但 wilds 要按 biome 再分：内陆沙漠走 sand 表（稀疏灌木/石），
    // 干草原走 steppe 表（零星树/花）—— 两者地表色本就不同，道具也该不同。
    const region = regionAt(wx, wy)
    if (region === 'water') return null // 上面 biome 已挡住水，这里只为收窄类型
    const zone =
      region === 'beach'
        ? 'sand'
        : region === 'wilds'
          ? b === BIOME.sand
            ? 'sand'
            : 'steppe'
          : region // 'forest' | 'meadow'
    for (const roll of PROP_MIX[zone]) {
      if (r >= roll.upto) continue
      // 森林里的阔叶树在高地/极湿处升级成针叶；其余原样
      const kind =
        roll.kind === 'tree' && zone === 'forest' && (lv >= 3 || m > 0.4) ? 'pine' : roll.kind
      const amp = roll.kind === 'rock' ? 0.25 : 0.3
      // 开阔地的树用更宽的变体位（h&7）挑更多样式；森林树与灌木/花/石用 h&3
      const variant = roll.kind === 'tree' && zone !== 'forest' ? h & 7 : h & 3
      return { kind, x: wx, y: wy, ox: jitter(3, amp), oy: jitter(19, amp), variant, rot: 0 }
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
    // ⚠️ 生态分区与道路也要摘进来：它们各自决定了地表着色与道具，只摘 biome 的话
    // 「同 biome 不同 region」或「路碾过的格」会被误判成「一样」，兼容性预言机就漏了
    return fnv1a(
      `${sampler.biomeAt(wx, wy)}:${sampler.levelAt(wx, wy)}:${regionAt(wx, wy)}:` +
        `${pathAt(wx, wy) ? 'p' : '-'}:${roadAt(wx, wy) ? 'r' : '-'}:` +
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
      // 湖与海要分开说：「湖畔」和「海边」给模型的画面完全不同
      const lake = sampler.isLakeAt(wx, wy)
      if (v) return lake ? `${v.name}旁的湖畔` : `${v.name}外的海边`
      const gx = Math.floor(wx / WILD_REGION)
      const gy = Math.floor(wy / WILD_REGION)
      return lake
        ? `${wildName(seed, gx, gy, 'water')}湖畔`
        : `${wildName(seed, gx, gy, 'water')}畔`
    }
    if (pathAt(wx, wy)) return v ? `${v.name}的村道上` : '村道上'
    // 村庄之间的大路（roadAt 已避开村内，这里 v 必为 null）
    if (roadAt(wx, wy)) return '村外的大路上'
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
    // ⚠️ 沙有两个互不相干的成因：近岸带与干旱（湿度极低）。一律说「沙滩上」的话，
    // 湿度偏置一调低，满地内陆沙漠都会被描述成海滩 —— 而这句是**逐字进提示词**的，
    // 模型会给站在荒漠里的 NPC 写海浪和海鸥。
    //
    // 判据直接问「附近有没有水」而不是反推生成成因：沙滩的定义本来就是「挨着水的沙」，
    // 这样无论将来沙从哪儿来都不会再说错。三格内有水才算滩。
    if (b === BIOME.sand) return waterWithin(wx, wy, 3) ? '沙滩上' : '荒漠中'
    // 野地用比村庄粗得多的网格命名 —— 每走两步换个地名反而出戏。
    // 措辞跟着 regionAt 走，与地表着色/道具同一套分区，不再各读一遍湿度阈值
    const gx = Math.floor(wx / WILD_REGION)
    const gy = Math.floor(wy / WILD_REGION)
    const region = regionAt(wx, wy)
    if (region === 'forest') return `${wildName(seed, gx, gy, 'forest')}中`
    if (region === 'meadow') return `${wildName(seed, gx, gy, 'plain')}上`
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
    roadAt,
    regionAt,
    propAt,
    describeArea,
    signatureAt,
    listVillages,
    villageAt: (x, y) => villageNear(wrapX(Math.floor(x)), wrapY(Math.floor(y))),
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
