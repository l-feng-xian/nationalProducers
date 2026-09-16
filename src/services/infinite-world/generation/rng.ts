/**
 * 世界生成的随机流。
 *
 * ## ⚠️ 铁律：每个用途一条独立的流，按**标签**派生，绝不共享
 * 共享一个 PRNG 的话，只要哪天在某处多摇了一次（或少摇了一次），
 * 它后面**所有**消费方的结果都会整体错位 —— 同一个种子生成出完全不同的世界，
 * 而改动本身看起来完全无关（「我只是在树的密度里加了个随机抖动」）。
 *
 * 这类错位的可怕之处在于：它不报错、不崩溃，只是老存档的房子和树悄悄搬了家。
 * 所以这里一律 `streamSeed(base, '用途')` 派生，各流之间互不影响。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { fnv1a, seededRandom } from '@/services/hash'

export { seededRandom }

/** 世界种子字符串 → 32 位基数 */
export function seedOf(seed: string): number {
  return fnv1a(seed)
}

/**
 * 按标签派生一条独立的种子。
 *
 * 换标签即换流，与调用顺序无关 —— 这是「加一个新噪声场不会挪动已有地形」
 * 这条性质的来源。
 */
export function streamSeed(base: number, label: string): number {
  return (base ^ fnv1a(label)) >>> 0
}

/** 派生一条独立的 PRNG */
export function streamRandom(base: number, label: string): () => number {
  return seededRandom(streamSeed(base, label))
}

/**
 * 逐格哈希：给定 (base, x, y) 得到一个稳定的 32 位值。
 *
 * ⚠️ 必须与「先 wrap 再哈希」配套使用。x=512 与 x=0 是环面上的同一格，
 * 但它们的哈希不同 —— 调用方不回绕就会在接缝上得到两种不同的装饰。
 */
export function hashTile(base: number, x: number, y: number): number {
  let h = base ^ 0x9e3779b9
  h = Math.imul(h ^ (x | 0), 0x85ebca6b)
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** 逐格 [0,1) 随机数 */
export function hashTile01(base: number, x: number, y: number): number {
  return hashTile(base, x, y) / 4294967296
}

/** 任意键的 [0,1) 随机数。用于「这个区域出不出村」这类一次性判定 */
export function hash01(base: number, ...parts: (string | number)[]): number {
  let h = base >>> 0
  for (const p of parts) h = Math.imul(h ^ fnv1a(String(p)), 0x01000193) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** 任意键的 [0, max) 整数 */
export function hashInt(base: number, max: number, ...parts: (string | number)[]): number {
  return Math.floor(hash01(base, ...parts) * max)
}
