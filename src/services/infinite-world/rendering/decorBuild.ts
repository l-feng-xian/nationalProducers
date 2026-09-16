/**
 * 装饰 → 精灵实例（纯函数，不 import three）。
 *
 * 逐格读 `grid.decor`，映射到精灵帧，算出脚底世界坐标、公告牌世界尺寸、
 * 左右翻转与变体，最后**按脚底 z 升序**排好 —— 这样透明公告牌从远到近绘制，
 * 近处的自然盖住远处的（见 sprite.tsl 的零排序说明）。
 *
 * ## 帧缺失就跳过
 * 某种装饰的精灵还没生成时（`meta.has(name)` 为假），该装饰**不渲染**，
 * 而不是渲染成占位方块。于是精灵可以分批出：先有树就先长树。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { CHUNK, WORLD_SIZE } from '../core/constants'
import { wrapTile } from '../core/torus'
import { Decor, type WorldGrid } from '../generation/grid'
import { hashTile01 } from '../generation/rng'
import type { BuildingKind, TownBuilding } from '../generation/settlement'

/** 精灵图集里每帧的最小元数据（避开对 three 的依赖） */
export interface SpriteMetaLite {
  has(name: string): boolean
  get(name: string): { layer: number; hFrac: number; wFrac: number } | undefined
}

/**
 * 每种装饰用哪些帧、目标世界高度（格）、风摆强度（0=刚体不动，1=柔草满摆）。
 * 有多个帧名时按 hash 选变体。
 */
const DECOR_SPRITE: Record<number, { names: readonly string[]; h: number; sway: number }> = {
  [Decor.TreeBroad]: { names: ['oak-round', 'oak-spreading'], h: 3.2, sway: 0.32 },
  [Decor.TreeConifer]: { names: ['oak-spreading'], h: 3.3, sway: 0.28 }, // 暂借阔叶，待针叶精灵
  [Decor.TreeBirch]: { names: ['birch-tall', 'birch-young'], h: 3.1, sway: 0.36 },
  [Decor.Bush]: { names: ['leafy-bush'], h: 1.1, sway: 0.55 },
  [Decor.Rock]: { names: ['mossy-rock'], h: 0.8, sway: 0 },
  [Decor.Flower]: { names: ['wildflower'], h: 0.6, sway: 0.9 },
  [Decor.TallGrass]: { names: ['grass-tuft'], h: 0.7, sway: 1 },
  [Decor.Reed]: { names: ['cattail-reed'], h: 1.2, sway: 0.85 },
  [Decor.Stump]: { names: ['tree-stump'], h: 0.7, sway: 0 },
  [Decor.Mushroom]: { names: ['mushroom'], h: 0.45, sway: 0 },
  [Decor.LilyPad]: { names: ['lily-pad'], h: 0.6, sway: 0.15 },
}

export interface SpriteInstances {
  /** 2 per：脚底世界坐标（未镜像 x,z） */
  foot: Float32Array
  /** 1 per：公告牌世界边长 */
  size: Float32Array
  /** 1 per：数组纹理层号 */
  layer: Float32Array
  /** 1 per：左右翻转 0/1 */
  flip: Float32Array
  /** 1 per：风摆强度 0..1（含每株微相位差） */
  sway: Float32Array
  count: number
}

const EMPTY: SpriteInstances = {
  foot: new Float32Array(0),
  size: new Float32Array(0),
  layer: new Float32Array(0),
  flip: new Float32Array(0),
  sway: new Float32Array(0),
  count: 0,
}

interface Item {
  x: number
  z: number
  size: number
  layer: number
  flip: number
  sway: number
}

/**
 * 建筑 → 精灵帧名。
 * 单层房两个变体（木屋 / 石基木屋）按格 hash 挑；两层及以上用专属的两层房。
 */
function buildingFrame(b: TownBuilding): string {
  switch (b.kind) {
    case 'well':
      return 'well'
    case 'shop':
      return 'shop'
    case 'inn':
      return 'inn'
    case 'workshop':
      return 'workshop'
    case 'barn':
      return 'barn'
    case 'house':
      if (b.storeys >= 2) return 'two-storey-house'
      return hashTile01(0x8b21, b.x, b.y) < 0.5 ? 'cottage' : 'cottage-stone'
  }
}

/** 建筑目标世界宽度（格）：井小、谷仓略宽，其余 = 占地宽 + 一点屋檐外挑。 */
function buildingWidth(b: TownBuilding): number {
  if (b.kind === 'well') return 1.3
  if (b.kind === 'barn') return b.w + 0.6
  return b.w + 0.5
}

/**
 * 把落在本 chunk 的城镇建筑各推成一个大公告牌 item。
 *
 * 建筑与草木**共用同一套精灵**（同 mesh、同深度遮挡），一起按脚底 z 排序 ——
 * 于是主角走到房子北侧会被房子挡、南侧压在房前，和树一样。
 *
 * ## 尺寸按占地宽度
 * `size = 目标宽度 / wFrac`，让建筑正面宽度贴合占地；高度随美术长宽比自然长出来
 * （两/三层的美术天生更高 → 天际线错落）。地基由 cobble 覆盖层单独画。
 *
 * ## 脚底钉在占地**前排中心**
 * 前排 = 南边（离相机近）。公告牌从这里向上/两侧长出建筑主体，压住北侧的占地格。
 * 用连续中心坐标反推脚底格做 chunk 归属，过缝也对（中心 512.x 归到 0.x 的 chunk）。
 */
function pushBuildings(
  grid: WorldGrid,
  i0: number,
  j0: number,
  meta: SpriteMetaLite,
  items: Item[],
): void {
  const i1 = i0 + CHUNK
  const j1 = j0 + CHUNK
  for (const town of grid.towns) {
    for (const b of town.buildings) {
      const cxWorld = b.x + b.w / 2 // 占地中心 x（可能越过 512）
      const cyWorld = b.y + b.h - 0.5 // 前排中心 z
      const ftx = wrapTile(Math.floor(cxWorld))
      const fty = wrapTile(Math.floor(cyWorld))
      if (ftx < i0 || ftx >= i1 || fty < j0 || fty >= j1) continue
      const fm = meta.get(buildingFrame(b))
      if (!fm) continue // 该建筑精灵还没生成，跳过
      items.push({
        x: ftx + (cxWorld - Math.floor(cxWorld)),
        z: fty + (cyWorld - Math.floor(cyWorld)),
        size: buildingWidth(b) / Math.max(0.2, fm.wFrac),
        layer: fm.layer,
        flip: 0,
        sway: 0,
      })
    }
  }
}

export function buildDecor(grid: WorldGrid, cx: number, cy: number, meta: SpriteMetaLite): SpriteInstances {
  const i0 = cx * CHUNK
  const j0 = cy * CHUNK
  const items: Item[] = []

  for (let dj = 0; dj < CHUNK; dj++) {
    for (let di = 0; di < CHUNK; di++) {
      const x = i0 + di
      const y = j0 + dj
      const d = grid.decor[y * WORLD_SIZE + x]!
      if (d === Decor.None) continue
      const spec = DECOR_SPRITE[d]
      if (!spec) continue

      // 变体 + 翻转 + 抖动都用同一格的独立 hash 流，互不串味
      const rv = hashTile01(0x51a0, x, y)
      const name = spec.names[Math.min(spec.names.length - 1, Math.floor(rv * spec.names.length))]!
      const fm = meta.get(name)
      if (!fm) continue // 该精灵还没生成，跳过

      const jx = (hashTile01(0x2b1f, x, y) - 0.5) * 0.44
      const jy = (hashTile01(0x77c3, x, y) - 0.5) * 0.44
      // 每株摆幅乘一点个体差（0.75~1.0），免得整片草像一块板子在晃
      const swayJitter = 0.75 + hashTile01(0x4e6b, x, y) * 0.25
      items.push({
        x: x + 0.5 + jx,
        z: y + 0.5 + jy,
        size: spec.h / Math.max(0.2, fm.hFrac),
        layer: fm.layer,
        flip: hashTile01(0x9d13, x, y) < 0.5 ? 0 : 1,
        sway: spec.sway * swayJitter,
      })
    }
  }

  // 城镇建筑：落在本 chunk 的各出一个大公告牌，并入同一套精灵实例
  pushBuildings(grid, i0, j0, meta, items)

  if (items.length === 0) return EMPTY

  // 脚底 z 升序：远（小 z）先画，近（大 z）后画覆在上面
  items.sort((a, b) => a.z - b.z)

  const n = items.length
  const foot = new Float32Array(n * 2)
  const size = new Float32Array(n)
  const layer = new Float32Array(n)
  const flip = new Float32Array(n)
  const sway = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const it = items[k]!
    foot[k * 2] = it.x
    foot[k * 2 + 1] = it.z
    size[k] = it.size
    layer[k] = it.layer
    flip[k] = it.flip
    sway[k] = it.sway
  }
  return { foot, size, layer, flip, sway, count: n }
}
