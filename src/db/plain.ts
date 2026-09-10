/**
 * 把（可能是 Vue reactive 代理的）对象深拷贝成纯数据，供 IndexedDB 写入。
 *
 * ⚠️ 这是 Vue + IndexedDB 的经典坑：`structuredClone`（IDB put 内部用的就是它）
 * **无法克隆 Proxy**，直接把 store 里的 reactive 对象丢给 db.put() 会抛
 * `DataCloneError: #<Object> could not be cloned`。
 *
 * 放在仓储层这个唯一收口处，任何 store 都不必记得手动 toRaw —— 忘记一次就是一个静默丢数据的 bug。
 *
 * 实现上刻意**不 import vue**（db/ 与 services/ 必须保持零框架依赖）：
 * 通过代理读属性拿到的是值，重新构造纯对象即可，不需要 toRaw。
 */

/** 这些类型 IndexedDB 原生支持，必须原样保留（尤其 Blob —— 头像就是它） */
function isPassthrough(v: unknown): boolean {
  return (
    v instanceof Blob ||
    v instanceof File ||
    v instanceof Date ||
    v instanceof ArrayBuffer ||
    ArrayBuffer.isView(v) ||
    v instanceof RegExp
  )
}

export function toPlain<T>(value: T): T {
  return clone(value) as T
}

function clone(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (isPassthrough(v)) return v
  if (Array.isArray(v)) return v.map(clone)
  if (v instanceof Map) {
    const m = new Map()
    for (const [k, val] of v) m.set(clone(k), clone(val))
    return m
  }
  if (v instanceof Set) {
    const s = new Set()
    for (const val of v) s.add(clone(val))
    return s
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(v as Record<string, unknown>)) {
    const val = (v as Record<string, unknown>)[key]
    // undefined 可以进 IDB，但会平白占位，去掉更干净
    if (val === undefined) continue
    out[key] = clone(val)
  }
  return out
}
