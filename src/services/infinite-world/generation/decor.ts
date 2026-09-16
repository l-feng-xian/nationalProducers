/**
 * 地表装饰：树、灌木、石头、花草、芦苇。
 *
 * ## 确定性推导，零存储
 * 装饰完全由 (seed, x, y, 噪声场) 决定，**不进存档**。
 * 玩家砍掉一棵树时，存的是「(x,y) 处装饰被移除」这一条差量，
 * 而不是整张 26 万格的装饰图。
 *
 * ## ⚠️ 装饰不能堵路
 * 树和石头会清掉 `Walkable`。如果它们落在街巷、桥、广场或建筑门口，
 * 镇里就会出现「看着有路却走不过去」——而且这种问题在全局预览图上
 * 完全看不出来，要进游戏走到那儿才发现。
 * 所以本模块只在**已确定不是路面/建筑**的格上落装饰。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { WORLD_SIZE } from '../core/constants'
import { wrapTile } from '../core/torus'
import type { Fields } from './fields'
import { Decor, Flag, type DecorId } from './grid'
import { WATER } from './hydrology'
import { hashTile01 } from './rng'

const N = WORLD_SIZE * WORLD_SIZE

/** 会挡路的装饰 */
const BLOCKING = new Set<number>([Decor.TreeBroad, Decor.TreeConifer, Decor.TreeBirch, Decor.Rock])

export function isBlockingDecor(d: DecorId): boolean {
  return BLOCKING.has(d)
}

export interface DecorParams {
  base: number
  fields: Fields
  elevation: Float32Array
  water: Uint8Array
  marsh: Uint8Array
  flags: Uint16Array
  /** 森林覆盖 0..1 */
  forestDensity: number
}

/**
 * 逐格推导装饰，同时把挡路的装饰从 `Walkable` 里扣掉。
 *
 * 就地写入 `decor` 与 `flags`。
 */
export function deriveDecor(decor: Uint8Array, p: DecorParams): void {
  const { base, fields, water, marsh, flags } = p

  for (let y = 0; y < WORLD_SIZE; y++) {
    const row = y * WORLD_SIZE
    for (let x = 0; x < WORLD_SIZE; x++) {
      const i = row + x
      const f = flags[i]!

      // ⚠️ 路面 / 桥 / 广场 / 建筑 / 农田 上一律不落装饰
      if (f & (Flag.Road | Flag.Bridge | Flag.Plaza | Flag.Building | Flag.Farmland)) continue

      const w = water[i]!
      if (w === WATER.deep) {
        // 深水只可能有零星睡莲
        if (hashTile01(base ^ 0x11ee, x, y) < 0.02) decor[i] = Decor.LilyPad
        continue
      }
      if (w === WATER.shallow) {
        const r = hashTile01(base ^ 0x11ee, x, y)
        if (r < 0.1) decor[i] = Decor.Reed
        else if (r < 0.14) decor[i] = Decor.LilyPad
        continue
      }
      if (marsh[i]) {
        const r = hashTile01(base ^ 0x22dd, x, y)
        if (r < 0.26) decor[i] = Decor.Reed
        else if (r < 0.34) decor[i] = Decor.TallGrass
        else if (r < 0.37) decor[i] = Decor.Mushroom
        continue
      }

      // 陆地：用域扭曲后的湿度决定森林与否，与 pipeline 的生态判定同源
      const [wx, wy] = fields.warp(x, y)
      const moist = fields.moisture(x + wx, y + wy)
      const macro = fields.macro(x, y)
      const score = moist + macro * 0.45 + (p.forestDensity - 0.5) * 0.6

      const r = hashTile01(base ^ 0x33cc, x, y)
      const detail = fields.detail(x, y)

      if (score > 0.2) {
        // ── 森林 ──
        // 密度随 score 上升；同一片林子里树种由高度与湿度分化，
        // 而不是逐格乱掷 —— 那样会得到「针阔混生的斑点」
        const density = 0.3 + Math.min(0.32, (score - 0.2) * 0.9)
        if (r < density) {
          const high = p.elevation[i]! > 0.15
          decor[i] = high || moist < 0.25 ? Decor.TreeConifer : r < density * 0.45 ? Decor.TreeBirch : Decor.TreeBroad
        } else if (r < density + 0.06) decor[i] = Decor.Bush
        else if (r < density + 0.1) decor[i] = Decor.TallGrass
        else if (r < density + 0.12) decor[i] = Decor.Mushroom
        else if (r < density + 0.135) decor[i] = Decor.Stump
      } else {
        // ── 野外草原 ──
        // 稀疏孤树 + 成片小花。花的成片靠 detail 场（高频噪声）而不是逐格哈希，
        // 逐格哈希撒出来是均匀噪点，看不出「一片花田」
        if (r < 0.035) decor[i] = Decor.TreeBroad
        else if (r < 0.055) decor[i] = Decor.Bush
        else if (r < 0.075) decor[i] = Decor.Rock
        else if (detail > 0.35 && r < 0.3) decor[i] = Decor.Flower
        else if (r < 0.2) decor[i] = Decor.TallGrass
      }
    }
  }

  // 挡路的装饰扣掉 Walkable
  for (let i = 0; i < N; i++) {
    if (BLOCKING.has(decor[i]!)) flags[i] = flags[i]! & ~Flag.Walkable
  }

  // ⚠️ 建筑门口必须留出一格。
  // 门前若恰好长了棵树，那栋房子就永远进不去 —— 而这在预览图上看不出来。
  // 这里在装饰推导之后统一清一遍（比在推导时逐格判断门口便宜得多）。
  clearDoorways(decor, flags)
}

/** 把所有 Road/Plaza 的四邻装饰清掉，保证路边不被树堵死 */
function clearDoorways(decor: Uint8Array, flags: Uint16Array): void {
  const toClear: number[] = []
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const i = y * WORLD_SIZE + x
      if (!(flags[i]! & (Flag.Road | Flag.Plaza | Flag.Bridge))) continue
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const ni = wrapTile(y + dy) * WORLD_SIZE + wrapTile(x + dx)
        if (BLOCKING.has(decor[ni]!)) toClear.push(ni)
      }
    }
  }
  for (const i of toClear) {
    decor[i] = Decor.None
    flags[i] = flags[i]! | Flag.Walkable
  }
}
