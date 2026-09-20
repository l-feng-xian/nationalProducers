/**
 * Chunk 构建：WorldGrid → 定型数组。
 *
 * ## ⚠️ 本文件刻意**不 import three**
 * 它是纯函数，输入 grid 输出定型数组。好处有三：
 *   1. 可以单测（不必起 WebGL 上下文）
 *   2. 将来要搬进 Worker 只改 chunkMesh.ts，这里一行不动
 *   3. 「建网格」与「造 GPU 对象」分开，前者才是能预算/分帧的那部分
 *
 * ## 为什么跨 chunk 不会掉帧
 * 整张逻辑网格已经常驻内存（pipeline 一次算完），所以这里只是**读数组**，
 * 一次噪声都不求。实测一块约 1ms —— 对比之下，旧实现跨块那一帧要现算
 * 3072 格噪声再建 18 个 InstancedMesh。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { CHUNK, WORLD_SIZE } from '../core/constants'
import { LAYERS, frameOf, maskAt, type LayerDef, type LayerId } from '../grid/dualGrid'
import type { WorldGrid } from '../generation/grid'
import { hashTile } from '../generation/rng'
import { MASK_ATLAS_COLS } from '../grid/masks'
import { CONTOUR_LAYERS } from './contourField'
import { buildDecor, type SpriteInstances, type SpriteMetaLite } from './decorBuild'
import type { GroundPalette } from './groundTextures'
import { buildPlots, type PlotInstances } from './plotBuild'

/**
 * sRGB → 线性。
 *
 * ⚠️ three r152+ 默认开启颜色管理：着色器输出被当作**线性**，最后统一转成 sRGB。
 * 而下面这些手填的色值是照着调色板取的 **sRGB** 值（0.58 ≈ 148/255）。
 * 直接塞进顶点色就会被再转一次，整片地表白得像蒙了层雾 ——
 * 而画面「有内容、不报错」，很容易误判成「地形没渲染出来」。
 *
 * 这与 `Color.setRGB` 把 sRGB 当线性用是同一类坑。
 */
function toLinear(c: readonly [number, number, number]): [number, number, number] {
  const f = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return [f(c[0]), f(c[1]), f(c[2])]
}

/**
 * 每种材质的调色板参考色（sRGB）。
 *
 * ## ⚠️ 这些值**不是**画出来的颜色
 * 贴图接入之后，美术定稿是贴图本身，不是这张表。这张表只剩一个用途：
 * 当某种地表还没有自己的贴图、要借另一张来顶时，给出**两者之间的色差**。
 *
 *     tint = 参考色(想要的) / 参考色(借来的)
 *
 * 于是「有自己贴图」的材质 tint 恒等于 1，贴图原封不动地呈现。
 *
 * ### 试过但错了的做法：`tint = 目标色 / 贴图均值`
 * 那个做法想把贴图的均值**绝对地**拉到调色板色上。实测崩了：
 * AI 贴图比调色板色暗得多也饱和得多（草地贴图线性蓝均值 0.06，
 * 而调色板草地的蓝是 0.155），比值要 2.6×。蓝通道被拉爆之后整片草地
 * 褪成灰绿，`soil-tilled` 更是两个通道同时顶到钳位上限。
 * 症状是「画面蒙了一层白纱」，很容易误判成透明层的混合参数不对。
 *
 * 根因是那个做法把调色板当成了真值 —— 但调色板本来就只是贴图到位前的**近似**。
 */
const MATERIAL_COLOR: Record<string, readonly [number, number, number]> = {
  'grass-meadow': [0.58, 0.65, 0.43],
  'forest-floor': [0.41, 0.48, 0.32],
  'dirt-path': [0.79, 0.56, 0.36],
  sand: [0.84, 0.77, 0.59],
  marsh: [0.43, 0.49, 0.36],
  'water-shallow': [0.47, 0.62, 0.62],
  'water-deep': [0.37, 0.53, 0.56],
  cobble: [0.69, 0.63, 0.52],
  'soil-tilled': [0.75, 0.62, 0.42],
  road: [0.79, 0.56, 0.36],
}

/** 覆盖层用哪张贴图 */
const LAYER_MATERIAL: Record<LayerId, string> = {
  cobble: 'cobble',
  dirt: 'dirt-path',
  bank: 'sand',
  water: 'water-shallow',
  road: 'road',
  tilled: 'soil-tilled',
}

/**
 * 自然面在底色层软混合时用到的三种材质。
 * 顺序即混合次序：草地是底，林地、湿地按场值叠上去。
 */
export const BASE_NATURALS = ['grass-meadow', 'forest-floor', 'marsh'] as const

/**
 * 一种自然面的底色描述：贴图层号 + 亮度补偿。
 *
 * 亮度补偿沿用 G1 的结论「借贴图只借亮度、不动色相」：还没有专属贴图的
 * 林地/湿地借草地贴图，靠这个标量压暗；有了专属贴图后 `source === want`，
 * 标量恰好归 1。
 */
export interface NaturalDescriptor {
  /** DataArrayTexture 层号 */
  layer: number
  /** 亮度补偿标量（贴图 × 它 = 目标亮度） */
  tint: number
}

export function naturalDescriptor(name: string, palette: GroundPalette): NaturalDescriptor {
  const [k] = borrowedTint(
    toLinear(MATERIAL_COLOR[name] ?? WHITE),
    palette.sourceOf(name),
    palette.ready,
  )
  return { layer: palette.indexOf(name), tint: k }
}

const WHITE: readonly [number, number, number] = [1, 1, 1]

/** Rec.709 亮度权重 */
const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722]

/**
 * 借用替身贴图时的补偿：**只借亮度，绝不动色相**。
 *
 * `source` 是 palette 沿替身链解析之后**真正采样的**那张贴图。
 * `source === want`（有专属贴图）时结果恰好是 (1,1,1)，贴图原封不动。
 *
 * ## ⚠️ 为什么不能用逐通道比值
 * 逐通道比值 = 「把替身的颜色掰成目标色」。可是**乘法掰不动色相**：
 * 要把赭色土路变成灰色石板，蓝通道得乘 2.87，结果不是灰色，
 * 是一块蓝得发冷的土 —— 实测城镇地基（Cobble，占镇内 32%）就是这么
 * 变成一片惨白灰蓝矩形的，看起来像渲染坏了，其实是色调补偿在硬掰色相。
 * 而且极端比值会顶到钳位，连「掰到目标色」都没做到。
 *
 * 只借亮度就没有这个问题：替身保留自己的色相，只把明暗对齐到目标。
 * 「比草地暗一半的地面」是可信的林地/湿地，「比土路亮两成的地面」是可信的
 * 夯土广场 —— 都不好看但都**不像 bug**，而这正是替身该有的表现。
 * 等 G2 出了真贴图，`source === want`，这个函数自动归 1。
 */
function borrowedTint(
  wantLinear: readonly [number, number, number],
  source: string | null,
  ready: boolean,
): [number, number, number] {
  if (!ready || source === null) return [wantLinear[0], wantLinear[1], wantLinear[2]]
  const ref = toLinear(MATERIAL_COLOR[source] ?? WHITE)
  const lum =
    LUMA[0] * (wantLinear[0] / ref[0]) +
    LUMA[1] * (wantLinear[1] / ref[1]) +
    LUMA[2] * (wantLinear[2] / ref[2])
  // 同名材质时三个比值都恰为 1，权重和也是 1 —— 结果精确等于 1，不靠钳位
  const k = Math.max(0.45, Math.min(1.6, lum))
  return [k, k, k]
}

/** 覆盖层：整层一种材质 */
function tintFor(want: string, source: string | null, ready: boolean): [number, number, number] {
  return borrowedTint(toLinear(MATERIAL_COLOR[want] ?? WHITE), source, ready)
}

export interface LayerInstances {
  layer: LayerId | 'base'
  /** 2 per instance：显示格中心的世界坐标（未镜像） */
  offset: Float32Array
  /**
   * 2 per instance：遮罩图集里那一格的**归一化偏移**（col/4, row/4）。
   *
   * ⚠️ 刻意在 CPU 上算好，而不是传帧号让着色器去 mod/floor：
   * 一是省掉每个片元的整数运算，二是避开 @types/three 落后版本里
   * TSL 节点算子的类型缺口 —— 那会逼着在着色器代码里撒类型断言。
   */
  atlas: Float32Array
  /** 3 per instance：色调补偿（贴图 × 它 = 目标色），见 `tintFor` */
  color: Float32Array
  /**
   * 1 per instance：数组纹理的层号。
   *
   * ⚠️ 底色层**逐实例**都可能不同（草地挨着沙地），所以它必须是实例属性而不是材质常量。
   * 覆盖层同层同材质，但也照样写，省得两条代码路径。
   */
  mat: Float32Array
  count: number
  /** 这一层画在第几高度（避免 z-fighting） */
  order: number
}

export interface ChunkBuild {
  cx: number
  cy: number
  /** 块心的世界坐标（未镜像） */
  centerX: number
  centerY: number
  layers: LayerInstances[]
  /** 本块的装饰精灵实例（脚底 z 已排序） */
  sprites: SpriteInstances
  plots: PlotInstances[]
  /** 实例总数，用于预算统计 */
  totalInstances: number
}

/**
 * 建一块 chunk。
 *
 * chunk `(cx, cy)` 拥有显示格 `i ∈ [cx*32, cx*32+32)`、`j ∈ [cy*32, cy*32+32)`。
 *
 * ⚠️ 显示格需要读逻辑格 `[cx*32 - 1, cx*32 + 32)` —— halo 是 1。
 * 因为整张网格常驻，halo 就是一次 wrap 索引，零成本。
 */
export function buildChunk(
  grid: WorldGrid,
  cx: number,
  cy: number,
  palette: GroundPalette,
  spriteMeta: SpriteMetaLite,
): ChunkBuild {
  const i0 = cx * CHUNK
  const j0 = cy * CHUNK
  const cells = CHUNK * CHUNK

  // ── 底色层：每个显示格一个实例，仅用作把地面铺满的四边形 ──
  //
  // ⚠️ 底色不再逐格挑贴图/算色调 —— 那正是「过暗的网格拼花」的来源。
  // 外观完全由 `createBaseMaterial` 在世界空间决定（软混合草地/林地/湿地），
  // 这里只提供每格的世界坐标，其余属性留空占位（几何统一，材质不读）。
  const baseOffset = new Float32Array(cells * 2)
  const baseAtlas = new Float32Array(cells * 2)
  const baseColor = new Float32Array(cells * 3)
  const baseMat = new Float32Array(cells)

  let n = 0
  for (let dj = 0; dj < CHUNK; dj++) {
    for (let di = 0; di < CHUNK; di++) {
      baseOffset[n * 2] = i0 + di
      baseOffset[n * 2 + 1] = j0 + dj
      n++
    }
  }

  const layers: LayerInstances[] = [
    {
      layer: 'base',
      offset: baseOffset,
      atlas: baseAtlas,
      color: baseColor,
      mat: baseMat,
      count: cells,
      order: 0,
    },
  ]

  // ── 覆盖层：只收非空的显示格 ──
  const planted = new Set<number>()
  for (const town of grid.towns)
    for (let k = 0; k < town.fields.length; k += 2)
      planted.add(town.fields[k + 1]! * WORLD_SIZE + town.fields[k]!)
  for (const def of LAYERS) {
    // Only suppress cells replaced by raised beds. Unrelated/player-authored farmland
    // must keep its normal ground layer even when this world contains a town farm.
    const visibleDef =
      def.id === 'tilled' && planted.size
        ? { ...def, test: (g: WorldGrid, i: number) => def.test(g, i) && !planted.has(i) }
        : def
    const inst = buildOverlay(grid, visibleDef, i0, j0, palette)
    if (inst.count > 0) layers.push(inst)
  }

  const sprites = buildDecor(grid, cx, cy, spriteMeta)
  const plots = buildPlots(grid, cx, cy)

  return {
    cx,
    cy,
    centerX: i0 + CHUNK / 2,
    centerY: j0 + CHUNK / 2,
    layers,
    sprites,
    plots,
    totalInstances:
      layers.reduce((s, l) => s + l.count, 0) +
      sprites.count +
      plots.reduce((s, p) => s + p.count, 0),
  }
}

function buildOverlay(
  grid: WorldGrid,
  def: LayerDef,
  i0: number,
  j0: number,
  palette: GroundPalette,
): LayerInstances {
  // 先数一遍再分配，避免动态数组的反复扩容
  const masks = new Uint8Array(CHUNK * CHUNK)
  let count = 0
  for (let dj = 0; dj < CHUNK; dj++) {
    for (let di = 0; di < CHUNK; di++) {
      let m = maskAt(grid, def, i0 + di, j0 + dj)
      // Continuous contours can cross an empty display cell. Include a two-tile halo so
      // per-chunk geometry never clips the reconstructed curve into a square.
      if (m === 0 && CONTOUR_LAYERS.includes(def.id)) {
        search: for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const x = (i0 + di + dx + WORLD_SIZE) % WORLD_SIZE
            const y = (j0 + dj + dy + WORLD_SIZE) % WORLD_SIZE
            if (def.test(grid, y * WORLD_SIZE + x)) {
              m = 1
              break search
            }
          }
      }
      masks[dj * CHUNK + di] = m
      if (m !== 0) count++
    }
  }

  const offset = new Float32Array(count * 2)
  const atlas = new Float32Array(count * 2)
  const color = new Float32Array(count * 3)
  const mat = new Float32Array(count)
  const matName = LAYER_MATERIAL[def.id]
  const matIndex = palette.indexOf(matName)
  const c = tintFor(matName, palette.sourceOf(matName), palette.ready)

  let n = 0
  for (let dj = 0; dj < CHUNK; dj++) {
    for (let di = 0; di < CHUNK; di++) {
      const m = masks[dj * CHUNK + di]!
      if (m === 0) continue
      const i = i0 + di
      const j = j0 + dj
      offset[n * 2] = i
      offset[n * 2 + 1] = j
      // ⚠️ frame ≥ 16 是填充变体，它们没有独立的遮罩形状（形状就是满格），
      // 一律折回 15 号格。变体的差异将来由贴图体现。
      const f = Math.min(15, frameOf(def, m, hashTile(0x9e37, i, j)))
      atlas[n * 2] = (f % MASK_ATLAS_COLS) / MASK_ATLAS_COLS
      atlas[n * 2 + 1] = Math.floor(f / MASK_ATLAS_COLS) / MASK_ATLAS_COLS
      color[n * 3] = c[0]
      color[n * 3 + 1] = c[1]
      color[n * 3 + 2] = c[2]
      mat[n] = matIndex
      n++
    }
  }

  return { layer: def.id, offset, atlas, color, mat, count, order: def.order }
}

/** chunk 坐标 → 键 */
export function chunkKey(cx: number, cy: number): number {
  const n = WORLD_SIZE / CHUNK
  return (((cy % n) + n) % n) * n + (((cx % n) + n) % n)
}

export const CHUNKS_PER_SIDE = WORLD_SIZE / CHUNK
