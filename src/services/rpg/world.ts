/**
 * 世界查询层：格子回绕、可行走判定、装饰物摆放。
 *
 * 这一层刻意**不持有任何渲染对象**，只回答「(x,y) 那格是什么」。
 * 渲染、输入、存档都从这里取数据，互不依赖 —— 也因此它能整体挪进 Worker。
 *
 * 纯 service：不 import vue/pinia。
 */

import {
  BIOME,
  createSampler,
  isWalkable,
  type Biome,
  type WorldParams,
  type WorldSampler,
} from './noise'
import { fnv1a } from '@/services/hash'
import type { PropKind } from './tiles'

export interface PropInstance {
  kind: PropKind
  /** 格坐标（整数），已回绕 */
  x: number
  y: number
  /** 同格内的亚像素偏移，避免所有装饰物都钉在格心 */
  ox: number
  oy: number
}

export interface World {
  readonly params: Required<Pick<WorldParams, 'width' | 'height' | 'seed'>>
  readonly sampler: WorldSampler
  biomeAt(x: number, y: number): Biome
  walkableAt(x: number, y: number): boolean
  /** 取以 (cx,cy) 为中心、边长 size 的方形窗口内的装饰物 */
  propsAround(cx: number, cy: number, size: number): PropInstance[]
  /** 某格的内容签名，用于「绕一圈回到同一处」的断言 */
  signatureAt(x: number, y: number): number
}

/**
 * 坐标哈希（murmur3 的 fmix32 收尾）。
 *
 * ⚠️ 这里**不能用 `fnv1a(\`${seed}:${x}:${y}\`)`**，踩过：FNV-1a 对「只差最后
 * 几位」的短字符串雪崩很差，高位几乎不变，而我又恰好取 `h >>> 8` 的高 24 位 ——
 * 结果是**同一列上连续七八格同时低于阈值**，树木排成竖直的柱子。
 * 实测 41×41 视窗里 39 棵树只落在 9 个不同的 x 上。
 *
 * fmix32 的雪崩足够，相邻坐标的输出完全不相关。顺带把每格一次的字符串拼接
 * 也省掉了 —— 80×80 的视窗每次跨格重建要拼 6400 个字符串，纯属浪费。
 */
function hashTile(seed: number, x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * 装饰物的确定性摆放。
 *
 * 不预生成整张表（256×256 就得存 65536 条，且大部分是空的），而是**按需算**：
 * 每格用自己的坐标哈希出一个稳定随机数，决定这格有没有东西、是什么。
 * 好处是零存储、任意大世界都成立，且**回绕后必然算出同一个结果** ——
 * 因为喂进哈希的是已回绕的坐标。
 */
function propAt(seed: number, x: number, y: number, b: Biome): PropInstance | null {
  if (!isWalkable(b)) return null
  const h = hashTile(seed, x, y)
  const r = (h >>> 8) / 0x1000000 // 0..1

  let kind: PropKind | null = null
  if (b === BIOME.grass) {
    if (r < 0.055) kind = 'tree'
    else if (r < 0.075) kind = 'bush'
    else if (r < 0.079) kind = 'house'
  } else if (b === BIOME.sand) {
    if (r < 0.012) kind = 'bush'
  }
  if (!kind) return null

  // 再取哈希的另外两段做格内偏移，免得所有东西都钉在格心排成网格
  const ox = (((h >>> 3) & 0xff) / 255 - 0.5) * 0.6
  const oy = (((h >>> 19) & 0xff) / 255 - 0.5) * 0.6
  return { kind, x, y, ox, oy }
}

export function createWorld(p: WorldParams): World {
  const sampler = createSampler(p)
  const { wrapX, wrapY } = sampler

  const biomeAt = (x: number, y: number): Biome =>
    sampler.biomeAt(wrapX(Math.floor(x)), wrapY(Math.floor(y)))

  const walkableAt = (x: number, y: number): boolean => isWalkable(biomeAt(x, y))

  const propsAround = (cx: number, cy: number, size: number): PropInstance[] => {
    const out: PropInstance[] = []
    const half = Math.ceil(size / 2)
    const gx = Math.floor(cx)
    const gy = Math.floor(cy)
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const wx = wrapX(gx + dx)
        const wy = wrapY(gy + dy)
        const pr = propAt(p.seed, wx, wy, sampler.biomeAt(wx, wy))
        if (!pr) continue
        // 摆放位置用**未回绕**的坐标，渲染端才不会在接缝处把东西画回世界另一头
        out.push({ ...pr, x: gx + dx, y: gy + dy })
      }
    }
    return out
  }

  const signatureAt = (x: number, y: number): number => {
    const wx = wrapX(Math.floor(x))
    const wy = wrapY(Math.floor(y))
    const b = sampler.biomeAt(wx, wy)
    const pr = propAt(p.seed, wx, wy, b)
    return fnv1a(`${b}:${pr?.kind ?? '-'}`)
  }

  return {
    params: { width: sampler.width, height: sampler.height, seed: p.seed },
    sampler,
    biomeAt,
    walkableAt,
    propsAround,
    signatureAt,
  }
}
