/**
 * WorldGrid：整张世界的 SoA（结构数组）表示。
 *
 * ## 为什么整张常驻而不是按需分块
 * 512×512 固定大小，全部字段加起来约 2.6 MB。一次性算完常驻内存，
 * 一次消掉四个难题：
 *   - 没有「块边界」这回事了 —— 显示格直接 wrap 索引全局数组，halo 成本为零
 *   - 河流的填洼/汇流本来就是**全局**算法，分块流式做不了
 *   - 城镇枚举 256 个区域一次算完，顺序天然确定
 *   - 跨 chunk 只剩「读数组建网格」（~1ms），噪声一次都不再求值
 *
 * ## ⚠️ 全部用定型数组，且可 transfer
 * 生成跑在 Worker 里，结果要 postMessage 回主线程。用普通对象数组的话
 * 结构化克隆会把 26 万个对象逐个复制一遍；定型数组走 transfer 是零拷贝。
 * `transferablesOf()` 收集全部 ArrayBuffer 供 postMessage 第二参数使用。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { WORLD_SIZE } from '../core/constants'
import { wrapTile } from '../core/torus'
import type { Biome } from '@/types/infiniteWorld'
import type { Bridge } from './roads'
import type { Town } from './settlement'

const N = WORLD_SIZE * WORLD_SIZE

/**
 * 地表材质。**数值即图集层号**，渲染端按它查 DataArrayTexture 的切片。
 *
 * ⚠️ 顺序一旦发布就不能改 —— 存档里的 `WorldChunkDelta` 存的是这个数值。
 * 要加新材质就往后追加。
 */
export const Surface = {
  Grass: 0,
  Dirt: 1,
  Sand: 2,
  Marsh: 3,
  ShallowWater: 4,
  DeepWater: 5,
  Cobble: 6,
  Tilled: 7,
  ForestFloor: 8,
} as const
export type SurfaceId = (typeof Surface)[keyof typeof Surface]

/** 逐格标志位。Uint16 够用，留了一半余量 */
export const Flag = {
  Walkable: 1 << 0,
  Road: 1 << 1,
  Bridge: 1 << 2,
  Town: 1 << 3,
  Plaza: 1 << 4,
  Farmland: 1 << 5,
  /** 建筑占地。具体是哪栋去 towns 里查 */
  Building: 1 << 6,
  /** 已耕作（玩家改动，存进 world_chunks） */
  Tilled: 1 << 7,
  /** 河道中心线附近，钓鱼点判定用 */
  RiverBank: 1 << 8,
} as const

/**
 * 装饰物。0 = 无。
 *
 * ⚠️ 装饰是**确定性推导**的，不存盘。玩家砍掉一棵树时存的是
 * 「(x,y) 处的装饰被移除」这条差量，而不是整张装饰图。
 */
export const Decor = {
  None: 0,
  TreeBroad: 1,
  TreeConifer: 2,
  TreeBirch: 3,
  Bush: 4,
  Rock: 5,
  Flower: 6,
  TallGrass: 7,
  Reed: 8,
  Stump: 9,
  Mushroom: 10,
  LilyPad: 11,
} as const
export type DecorId = (typeof Decor)[keyof typeof Decor]

export interface WorldGrid {
  readonly size: number
  readonly seed: string
  readonly generatorVersion: string
  readonly seaLevel: number

  /** 地表材质 */
  surface: Uint8Array
  /** 标志位 */
  flags: Uint16Array
  /** 生态分类（索引进 BIOMES） */
  biome: Uint8Array
  /** 原始高度（未填洼） */
  elevation: Float32Array
  /** 连通分量号，0 = 不可通行 */
  region: Int32Array
  /** 装饰物 */
  decor: Uint8Array

  /** 城镇（含建筑、街巷、广场、田块） */
  towns: Town[]
  bridges: Bridge[]
  /** 出生点建议：主连通域里、镇中广场附近 */
  spawn: [number, number]
  /** 最大可行走连通域的分量号 */
  mainRegion: number
}

export function createEmptyGrid(
  seed: string,
  generatorVersion: string,
  seaLevel: number,
): WorldGrid {
  return {
    size: WORLD_SIZE,
    seed,
    generatorVersion,
    seaLevel,
    surface: new Uint8Array(N),
    flags: new Uint16Array(N),
    biome: new Uint8Array(N),
    elevation: new Float32Array(N),
    region: new Int32Array(N),
    decor: new Uint8Array(N),
    towns: [],
    bridges: [],
    spawn: [0, 0],
    mainRegion: 0,
  }
}

/** 行主序索引。入参会先回绕，传任意坐标都安全 */
export function gridIndex(x: number, y: number): number {
  return wrapTile(y) * WORLD_SIZE + wrapTile(x)
}

export function isWalkable(g: WorldGrid, x: number, y: number): boolean {
  return (g.flags[gridIndex(x, y)]! & Flag.Walkable) !== 0
}

export function hasFlag(g: WorldGrid, x: number, y: number, flag: number): boolean {
  return (g.flags[gridIndex(x, y)]! & flag) !== 0
}

export function surfaceAt(g: WorldGrid, x: number, y: number): SurfaceId {
  return g.surface[gridIndex(x, y)] as SurfaceId
}

export function decorAt(g: WorldGrid, x: number, y: number): DecorId {
  return g.decor[gridIndex(x, y)] as DecorId
}

/**
 * 供 postMessage 第二参数使用的 transfer 清单。
 *
 * ⚠️ transfer 之后 Worker 侧的这些数组会变成**长度 0 的壳**。
 * 发送方在 postMessage 之后不能再碰它们 —— 所以 worldSource 里
 * transfer 完立即丢弃引用，由主线程成为唯一持有者。
 */
export function transferablesOf(g: WorldGrid): ArrayBuffer[] {
  return [
    g.surface.buffer as ArrayBuffer,
    g.flags.buffer as ArrayBuffer,
    g.biome.buffer as ArrayBuffer,
    g.elevation.buffer as ArrayBuffer,
    g.region.buffer as ArrayBuffer,
    g.decor.buffer as ArrayBuffer,
  ]
}

/** 统计每种生态的格数，供预览与验收 */
export function biomeCounts(g: WorldGrid, biomes: readonly Biome[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const b of biomes) out[b] = 0
  for (let i = 0; i < N; i++) {
    const name = biomes[g.biome[i]!]
    if (name) out[name] = (out[name] ?? 0) + 1
  }
  return out
}

/** 约略的内存占用（字节），用于把「2.6 MB 常驻」这个说法钉死 */
export function gridByteLength(g: WorldGrid): number {
  return (
    g.surface.byteLength +
    g.flags.byteLength +
    g.biome.byteLength +
    g.elevation.byteLength +
    g.region.byteLength +
    g.decor.byteLength
  )
}
