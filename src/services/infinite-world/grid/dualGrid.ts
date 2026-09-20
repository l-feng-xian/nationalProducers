/**
 * 双网格：逻辑格存内容，显示格画边界。
 *
 * ## 坐标关系（唯一定义，别处不许再推一遍）
 * 逻辑格 `L(x,y)` 占世界矩形 `[x, x+1) × [y, y+1)`，格心在 `(x+0.5, y+0.5)`。
 * 显示格 `D(i,j)` 的**中心恰在世界点 `(i, j)`**，覆盖 `[i-0.5, i+0.5] × [j-0.5, j+0.5]`
 * —— 也就是说它坐在四个逻辑格的公共角点上。
 *
 *     NW = L(i-1, j-1)   NE = L(i,   j-1)
 *     SW = L(i-1, j  )   SE = L(i,   j  )
 *
 *     mask = NW + 2·NE + 4·SE + 8·SW      // 0..15
 *
 * `i, j ∈ [0, 512)` 时显示格覆盖 `x ∈ [-0.5, 511.5]`，在环面上首尾严丝合缝，
 * **没有边界特例**。
 *
 * ## ⚠️ 形状与材质是分开的
 * 16 个遮罩是**程序化生成的 alpha 形状**（拓扑精确、免费、一套复用到所有层），
 * 材质是 AI 生成的可平铺贴图。渲染是 `mix(基础材质, 覆盖材质, 遮罩alpha)`。
 *
 * 让图像模型去画 16 个几何精确的角点拓扑是行不通的：6 层 × 16 = 96 张，
 * 要烧约 $9，而且拼不上 —— 模型没有「这四个角必须和邻格严丝合缝」的概念。
 *
 * ## ⚠️ 对角形态 5 / 10 一律画成「连通」
 * `mask=5`（NW+SE）与 `mask=10`（NE+SW）在几何上是歧义的：两个对角块
 * 算连着还是断开？这里一律**连通**，三条理由都是结构性的：
 *   1. 断开的对角在手绘风里会出现尖锐夹点，描边会打架
 *   2. 寻路只读**逻辑网格**，显示层对通行性零影响。而 A* 是四邻接，
 *      逻辑上对角本来就不连通 —— 所以「画成连通」不会造成
 *      「看着能走、实际走不过去」
 *   3. 河道与道路在栅格化时都做了 4 连通补角（见 hydrology/roads），
 *      所以 water/road 这两个最要命的层**结构上不会产生 5/10**。
 *      5/10 只可能出现在 dirt/marsh/tilled 这些纯装饰层上。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { WORLD_SIZE } from '../core/constants'
import { wrapTile } from '../core/torus'
import { Flag, Surface, type WorldGrid } from '../generation/grid'

export type LayerId = 'cobble' | 'dirt' | 'bank' | 'water' | 'road' | 'tilled'

export interface LayerDef {
  id: LayerId
  /** 该逻辑格属不属于本层 —— 这就是「二值」的全部含义 */
  test: (g: WorldGrid, i: number) => boolean
  /** 绘制顺序，小的先画 */
  order: number
  /**
   * mask=15（四角全属本层）时可用的填充变体数。
   *
   * 大片同色会显得很死板，用 hash 在几个变体里挑一个打散。
   * 0 表示不做变体（水面靠 TSL 的波动打散，不需要贴图变体）。
   */
  fillVariants: number
  /** 边缘用哪套遮罩 */
  maskSet: MaskSetId
}

export type MaskSetId = 'organic' | 'stepped' | 'hard'

/**
 * 层定义表。
 *
 * 顺序即绘制顺序：**底色（自然面软混合）→ cobble → dirt → water → road → tilled**。
 *
 * ## ⚠️ 这里只放**人造面**（cobble/dirt/road/tilled）与水
 * 自然面（草地 / 林地 / 湿地）**不在这张表里** —— 它们在底色层走
 * 世界空间软混合（见 `groundField.ts`、`createBaseMaterial`）。原因是逐格遮罩
 * 柔化上限就一格，做不出参考图那种跨十几格的自然斑块。
 * 土路、沙岸和水面使用跨格的连续轮廓；桥面与耕地保留双网格遮罩。
 */
export const LAYERS: readonly LayerDef[] = [
  {
    // 石铺公共地面。建筑自己的薄石基由精灵提供，不再铺矩形台座。
    id: 'cobble',
    order: 1,
    fillVariants: 0,
    maskSet: 'organic',
    test: (g, i) => g.surface[i] === Surface.Cobble && !(g.flags[i]! & Flag.Building),
  },
  {
    id: 'dirt',
    order: 2,
    fillVariants: 3,
    maskSet: 'organic',
    // One continuous dirt contour includes ordinary paths; no second overlapping road fringe.
    test: (g, i) =>
      !(g.flags[i]! & (Flag.Bridge | Flag.Building)) &&
      (g.surface[i] === Surface.Dirt ||
        ((g.flags[i]! & Flag.Road) !== 0 && g.surface[i] !== Surface.Cobble)),
  },
  {
    // 河岸沙滩：水与草之间的自然过渡圈。organic 软边，画在水之下 ——
    // 于是水的边缘压在沙岸上，像水拍着岸。
    id: 'bank',
    order: 3,
    fillVariants: 0,
    maskSet: 'organic',
    // Continue the river bed below the translucent water, so its edge reveals sand, not grass.
    test: (g, i) =>
      g.surface[i] === Surface.Sand ||
      g.surface[i] === Surface.ShallowWater ||
      g.surface[i] === Surface.DeepWater,
  },
  {
    id: 'water',
    order: 4,
    fillVariants: 0,
    maskSet: 'organic',
    test: (g, i) => g.surface[i] === Surface.ShallowWater || g.surface[i] === Surface.DeepWater || (g.generatorVersion==='torus-4' && !!(g.flags[i]!&Flag.Bridge)),
  },
  {
    // 桥面位于水层之上。
    id: 'road',
    order: 5,
    fillVariants: 2,
    maskSet: 'organic',
    // The elevated pass is only needed for bridges over water.
    test: (g, i) => (g.flags[i]! & Flag.Bridge) !== 0,
  },
  {
    // 耕地是人划出来的，边界应当是直的
    id: 'tilled',
    order: 6,
    fillVariants: 4,
    maskSet: 'hard',
    test: (g, i) => (g.flags[i]! & Flag.Farmland) !== 0,
  },
]

/** 对角歧义的处理策略。见文件头 */
export const DIAGONAL_POLICY: 'connect' | 'separate' = 'connect'

/**
 * 计算显示格 `D(i,j)` 在某一层上的遮罩号。
 *
 * ⚠️ 四个角的取法与位权顺序是**唯一定义**，改了会让整套遮罩图集错位，
 * 而错位的表现是「某些转角处地表缺一块」——很难从现象反推回这里。
 */
export function maskAt(g: WorldGrid, layer: LayerDef, i: number, j: number): number {
  const nw = layer.test(g, idx(i - 1, j - 1)) ? 1 : 0
  const ne = layer.test(g, idx(i, j - 1)) ? 2 : 0
  const se = layer.test(g, idx(i, j)) ? 4 : 0
  const sw = layer.test(g, idx(i - 1, j)) ? 8 : 0
  return nw | ne | se | sw
}

function idx(x: number, y: number): number {
  return wrapTile(y) * WORLD_SIZE + wrapTile(x)
}

/**
 * 遮罩号 → 图集帧号。
 *
 * 返回 -1 表示这一格本层完全没有内容，不必绘制（最常见的情况，
 * 一整张图里绝大多数显示格在绝大多数层上都是 0）。
 */
export function frameOf(layer: LayerDef, mask: number, hash: number): number {
  if (mask === 0) return -1
  if (mask === 15 && layer.fillVariants > 0) return 16 + (hash % layer.fillVariants)
  return mask
}

/** 一层最多占多少帧：16 个边界形态 + 填充变体 */
export function frameCountOf(layer: LayerDef): number {
  return 16 + layer.fillVariants
}

/**
 * 把某一层在整张图上的遮罩号铺出来，供调试与离线验收。
 *
 * ⚠️ 只用于验证。运行时是按 chunk 增量算的，不会铺全图。
 */
export function bakeLayerMasks(g: WorldGrid, layer: LayerDef): Uint8Array {
  const out = new Uint8Array(WORLD_SIZE * WORLD_SIZE)
  for (let j = 0; j < WORLD_SIZE; j++) {
    for (let i = 0; i < WORLD_SIZE; i++) {
      out[j * WORLD_SIZE + i] = maskAt(g, layer, i, j)
    }
  }
  return out
}

/** 统计某层出现了哪些遮罩形态，用来确认 16 种都被覆盖到 */
export function maskHistogram(g: WorldGrid, layer: LayerDef): Int32Array {
  const hist = new Int32Array(16)
  for (let j = 0; j < WORLD_SIZE; j++) {
    for (let i = 0; i < WORLD_SIZE; i++) {
      hist[maskAt(g, layer, i, j)]!++
    }
  }
  return hist
}
