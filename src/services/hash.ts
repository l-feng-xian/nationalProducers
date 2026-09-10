/**
 * FNV-1a 32 位哈希。用于：
 *  - 世界书定时效果的条目身份（内容变更即失效，与 ST 语义一致）
 *  - {{pick}} 的稳定随机种子
 *
 * ⚠️ 条目 hash 必须用**固定键序**序列化，否则同一条目从不同路径
 * （新建 / 导入 / IndexedDB 反序列化）拿到的 hash 会不同，正在跑的 sticky 会莫名断掉。
 */

export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 固定键序的 JSON 序列化，保证 hash 稳定 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function hashObject(value: unknown): number {
  return fnv1a(stableStringify(value))
}

/** 确定性 PRNG（mulberry32），供 {{pick}} 使用 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
