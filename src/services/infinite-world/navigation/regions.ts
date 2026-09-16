/**
 * 连通域标号：把整张环面网格的可行走区切成若干互不相连的分量。
 *
 * ## 它一次性解决三件事
 * 1. **A\* 前置否决**：目标在河对岸时，`connected()` 一次数组查就能否决，
 *    而不是展开 3000 个节点后才放弃。「不可达」从最慢的一次寻路变成最快的一次。
 * 2. **NPC 选址**：居民的家与工作点必须与出生点同域，否则创建时一切正常，
 *    进游戏后那个 NPC 永远走不到工作点（现状就允许把家放在河对岸孤岛上）。
 * 3. **向导校验**：「出生点 / NPC 目的地 / 农田 / 商店 / 桥可达」这条验收，
 *    从「要跑一遍寻路去测」变成一句 `labelAt(a) === labelAt(b)`。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { WORLD_SIZE } from '../core/constants'
import { neighbours4, wrapTile } from '../core/torus'
import type { ReachabilityOracle, Sampler } from './path'

const N = WORLD_SIZE * WORLD_SIZE

export interface RegionMap extends ReachabilityOracle {
  /**
   * 每格的分量号。**0 表示不可通行**，可通行的分量从 1 开始编号。
   *
   * ⚠️ 用 Int32Array 而不是 Uint16Array：病态地形（棋盘格）最多能产生
   * 13 万个分量，会溢出 16 位。多花 0.5 MB 换掉一类「只在特定种子上复现」
   * 的错误，是划算的。
   */
  readonly labels: Int32Array
  /** 分量号 → 格数 */
  readonly sizes: ReadonlyMap<number, number>
  /** 最大的可行走分量。出生点应当落在它里面 */
  readonly mainLabel: number
  readonly mainSize: number
  /** 可行走分量个数（不含 0） */
  readonly regionCount: number
  labelAt(x: number, y: number): number
  walkableAt(x: number, y: number): boolean
  connected(ax: number, ay: number, bx: number, by: number): boolean
}

/**
 * 一次泛洪，26 万格。
 *
 * ⚠️ 先把 walkable 铺成位图再泛洪，而不是在泛洪里反复调 sample()。
 * 泛洪会把每格作为邻居访问约 4 次，直接调 sample 就是 130 万次噪声求值；
 * 预铺之后是 26 万次，之后全是纯数组操作。
 */
export function buildRegionMap(sample: Sampler): RegionMap {
  const walkable = new Uint8Array(N)
  for (let y = 0; y < WORLD_SIZE; y++) {
    const row = y * WORLD_SIZE
    for (let x = 0; x < WORLD_SIZE; x++) {
      walkable[row + x] = sample(x, y).walkable ? 1 : 0
    }
  }

  const labels = new Int32Array(N)
  const sizes = new Map<number, number>()
  // BFS 队列：最坏情况整张图都在队列里，所以一次开满，不用动态数组
  const queue = new Int32Array(N)
  const nb = new Int32Array(8)

  let nextLabel = 1
  let mainLabel = 0
  let mainSize = 0

  for (let seed = 0; seed < N; seed++) {
    if (walkable[seed] === 0 || labels[seed] !== 0) continue

    const label = nextLabel++
    let head = 0
    let tail = 0
    queue[tail++] = seed
    labels[seed] = label

    while (head < tail) {
      const c = queue[head++]!
      const cx = c % WORLD_SIZE
      const cy = (c - cx) / WORLD_SIZE
      neighbours4(cx, cy, nb)
      for (let k = 0; k < 4; k++) {
        const ni = nb[k * 2 + 1]! * WORLD_SIZE + nb[k * 2]!
        if (walkable[ni] === 0 || labels[ni] !== 0) continue
        labels[ni] = label
        queue[tail++] = ni
      }
    }

    sizes.set(label, tail)
    if (tail > mainSize) {
      mainSize = tail
      mainLabel = label
    }
  }

  const labelAt = (x: number, y: number): number =>
    labels[wrapTile(y) * WORLD_SIZE + wrapTile(x)]!

  return {
    labels,
    sizes,
    mainLabel,
    mainSize,
    regionCount: nextLabel - 1,
    labelAt,
    walkableAt: (x, y) => labelAt(x, y) !== 0,
    connected: (ax, ay, bx, by) => {
      const a = labelAt(ax, ay)
      // 0 是不可通行 —— 两个不可通行的格**不算**连通，否则「墙里到墙里」会被判成可达
      return a !== 0 && a === labelAt(bx, by)
    },
  }
}

/**
 * 按 `${seed}:${generatorVersion}` 缓存。
 *
 * 向导会在每次校验时问连通性，泛洪虽然只要几十毫秒，但拖旋钮时会连着调几十次。
 * 上限 3：同时最多比较「当前草稿 / 上一版 / 已打开的世界」。
 */
const cache = new Map<string, RegionMap>()
const CACHE_LIMIT = 3

export function getRegionMap(key: string, sample: Sampler): RegionMap {
  const hit = cache.get(key)
  if (hit) {
    // 触碰一下维持 LRU 顺序（Map 保持插入序）
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const map = buildRegionMap(sample)
  cache.set(key, map)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return map
}

export function clearRegionCache(): void {
  cache.clear()
}
