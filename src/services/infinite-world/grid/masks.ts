/**
 * 程序化生成双网格的 16 个遮罩形状。
 *
 * ## ⭐ 为什么这些遮罩必然无缝（构造性质，不是调出来的）
 * 显示格 `D(i,j)` 的右边由角点 NE、SE 决定；`D(i+1,j)` 的左边由它的 NW、SW 决定。
 * 而按双网格的定义：
 *
 *     D(i,j).NE = L(i, j-1) = D(i+1,j).NW
 *     D(i,j).SE = L(i, j  ) = D(i+1,j).SW
 *
 * 两条边插值的是**同一对角点值**。所以只要遮罩的 alpha 是
 * 「四角双线性插值」的**纯函数**，共享边上的 alpha 就逐点相同 —— 无缝。
 *
 * ⚠️ 由此推出一条硬约束：**绝不能往遮罩里加逐格噪声**。
 * 加了之后两侧的扰动各掷各的，边上就裂开一条缝。想要有机的手绘边缘，
 * 要么在**着色器里按世界坐标**扰动（两侧取到同一个值），
 * 要么靠沿边界散布的 AI 碎饰条 —— 都不能改遮罩本身。
 *
 * 羽化（organic）是插值值的纯函数，不破坏这条性质。
 * 阶梯（stepped）量化的是**坐标**而不是插值值 —— 同样保持无缝，
 * 理由见 `steppedAlpha` 的注释（边上 u 恰为 0/1 量化到自身，v 两侧公式相同）。
 *
 * ## 鞍点 5 / 10
 * `mask=5`（NW+SE）与 `mask=10`（NE+SW）在中心处插值恰为 0.5，是几何歧义。
 * 按 dualGrid.ts 的策略一律画成**连通**：加一个中心凸起把它推过阈值。
 * ⚠️ 这个凸起在四条边上恒为 0，所以不影响边界匹配。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import type { MaskSetId } from './dualGrid'

/** 每个遮罩瓦片的像素边长 */
export const MASK_TILE_PX = 64
/** 图集按 4×4 排 16 个形态 */
export const MASK_ATLAS_COLS = 4
export const MASK_ATLAS_PX = MASK_TILE_PX * MASK_ATLAS_COLS

/** 鞍点中心凸起的幅度。0.5 + 0.12 = 0.62 > 阈值，刚好连上 */
const SADDLE_BUMP = 0.12
/** stepped 把插值量化成几档 —— 档位越少阶梯越粗 */
const STEPPED_LEVELS = 5

export interface MaskSetOptions {
  /** 羽化宽度（插值单位）。0 = 硬边 */
  feather: number
  /** 是否量化成阶梯 */
  stepped: boolean
}

export const MASK_SETS: Record<MaskSetId, MaskSetOptions> = {
  // 有机：柔和羽化，用于泥土/湿地/水岸
  organic: { feather: 0.16, stepped: false },
  // 阶梯：参考图里土路边缘那种方块感，是双网格瓦片系统的视觉签名
  stepped: { feather: 0.05, stepped: true },
  // 硬边：耕地是人划出来的，边界应当是直的
  hard: { feather: 0.0, stepped: false },
}

/**
 * 四角双线性插值。
 *
 * 角点顺序与 `maskAt` 的位权严格对应：
 *   bit0 = NW (u=0,v=0)   bit1 = NE (u=1,v=0)
 *   bit2 = SE (u=1,v=1)   bit3 = SW (u=0,v=1)
 */
function cornerLerp(mask: number, u: number, v: number): number {
  const nw = mask & 1 ? 1 : 0
  const ne = mask & 2 ? 1 : 0
  const se = mask & 4 ? 1 : 0
  const sw = mask & 8 ? 1 : 0
  const top = nw + (ne - nw) * u
  const bottom = sw + (se - sw) * u
  return top + (bottom - top) * v
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** 单个像素的 alpha。这是整套遮罩的**唯一**真相函数 */
export function maskAlphaAt(mask: number, u: number, v: number, opt: MaskSetOptions): number {
  if (mask === 0) return 0
  if (mask === 15) return 1
  if (opt.stepped) return steppedAlpha(mask, u, v, opt)

  let value = cornerLerp(mask, u, v)

  // 鞍点：加中心凸起把对角连起来。边上恒为 0，不影响匹配
  if (mask === 5 || mask === 10) {
    const bx = 1 - 4 * (u - 0.5) * (u - 0.5)
    const by = 1 - 4 * (v - 0.5) * (v - 0.5)
    value += SADDLE_BUMP * Math.max(0, bx) * Math.max(0, by)
  }

  if (opt.feather <= 0) return value >= 0.5 ? 1 : 0
  return smoothstep(0.5 - opt.feather, 0.5 + opt.feather, value)
}

/**
 * 阶梯版：**量化坐标而不是插值值**。
 *
 * ⚠️ 一开始量化的是插值值（`round(v*K)/K`），渲染出来边缘仍是曲线 ——
 * 因为那只是把等值线挪到离散档位，而双线性函数的等值线本身是双曲线，
 * 挪一挪还是曲线。参考图里土路那种方块感来自**边界沿格子走**，
 * 所以该量化的是坐标。
 *
 * 无缝性仍然成立：共享边上 u 恰为 0 或 1，量化到自身；
 * v 在两侧用同一个公式量化，取到同一个值。所以边上 alpha 仍逐点相等。
 */
function steppedAlpha(mask: number, u: number, v: number, opt: MaskSetOptions): number {
  const q = (t: number) => Math.round(t * STEPPED_LEVELS) / STEPPED_LEVELS
  let value = cornerLerp(mask, q(u), q(v))
  if (mask === 5 || mask === 10) {
    const bu = q(u)
    const bv = q(v)
    const bx = 1 - 4 * (bu - 0.5) * (bu - 0.5)
    const by = 1 - 4 * (bv - 0.5) * (bv - 0.5)
    value += SADDLE_BUMP * Math.max(0, bx) * Math.max(0, by)
  }

  if (opt.feather <= 0) return value >= 0.5 ? 1 : 0
  return smoothstep(0.5 - opt.feather, 0.5 + opt.feather, value)
}

/**
 * 生成一套 16 形态的 alpha 图集（4×4 排布，单通道）。
 *
 * 返回 `MASK_ATLAS_PX²` 字节的灰度图，0..255。
 */
export function generateMaskAtlas(set: MaskSetId): Uint8Array {
  const opt = MASK_SETS[set]
  const out = new Uint8Array(MASK_ATLAS_PX * MASK_ATLAS_PX)

  for (let mask = 0; mask < 16; mask++) {
    const tx = (mask % MASK_ATLAS_COLS) * MASK_TILE_PX
    const ty = Math.floor(mask / MASK_ATLAS_COLS) * MASK_TILE_PX
    for (let py = 0; py < MASK_TILE_PX; py++) {
      // 像素中心采样：(py + 0.5) / N，而不是 py / (N-1)。
      // 后者会让 u 取到 0 和 1 两个端点，相邻瓦片的边缘像素重复一次，
      // 表现为「接边处颜色偏深一像素」
      const v = (py + 0.5) / MASK_TILE_PX
      for (let px = 0; px < MASK_TILE_PX; px++) {
        const u = (px + 0.5) / MASK_TILE_PX
        const a = maskAlphaAt(mask, u, v, opt)
        out[(ty + py) * MASK_ATLAS_PX + (tx + px)] = Math.round(Math.min(1, Math.max(0, a)) * 255)
      }
    }
  }
  return out
}

/**
 * 验证：任意两个在双网格里相邻的遮罩，共享边上的 alpha 必须逐点相等。
 *
 * 这是「无缝」这条性质的**可执行形式**。返回最大偏差。
 */
export function maxSeamMismatch(set: MaskSetId): number {
  const opt = MASK_SETS[set]
  let worst = 0

  // 水平相邻：D(i,j) 的右边 vs D(i+1,j) 的左边。
  // 两者的角点关系：left.NE == right.NW，left.SE == right.SW
  for (let left = 0; left < 16; left++) {
    for (let right = 0; right < 16; right++) {
      const leftNE = (left >> 1) & 1
      const leftSE = (left >> 2) & 1
      const rightNW = right & 1
      const rightSW = (right >> 3) & 1
      // 只有角点确实对得上的组合才可能在双网格里相邻
      if (leftNE !== rightNW || leftSE !== rightSW) continue
      for (let k = 0; k < MASK_TILE_PX; k++) {
        const v = (k + 0.5) / MASK_TILE_PX
        const a = maskAlphaAt(left, 1, v, opt)
        const b = maskAlphaAt(right, 0, v, opt)
        worst = Math.max(worst, Math.abs(a - b))
      }
    }
  }

  // 垂直相邻：top.SW == bottom.NW，top.SE == bottom.NE
  for (let top = 0; top < 16; top++) {
    for (let bottom = 0; bottom < 16; bottom++) {
      const topSW = (top >> 3) & 1
      const topSE = (top >> 2) & 1
      const bottomNW = bottom & 1
      const bottomNE = (bottom >> 1) & 1
      if (topSW !== bottomNW || topSE !== bottomNE) continue
      for (let k = 0; k < MASK_TILE_PX; k++) {
        const u = (k + 0.5) / MASK_TILE_PX
        const a = maskAlphaAt(top, u, 1, opt)
        const b = maskAlphaAt(bottom, u, 0, opt)
        worst = Math.max(worst, Math.abs(a - b))
      }
    }
  }

  return worst
}
