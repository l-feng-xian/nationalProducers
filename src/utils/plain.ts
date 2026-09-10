/**
 * 把（可能是 Vue reactive 代理的）对象深拷贝成纯数据。
 *
 * ⚠️ **`structuredClone` 无法克隆 Proxy**。这条会以两种面目咬人：
 *   1. `db.put(reactiveObj)` → `DataCloneError`，持久化静默全失败；
 *   2. 组件里 `structuredClone(storeItem)` 做编辑副本 → 直接抛异常。
 * 所以凡是要「脱离响应式拿一份纯数据」，一律用 `toPlain()`，别用 structuredClone。
 *
 * 仓储层已在写入处统一收口；UI 层做编辑草稿时也应显式调用。
 *
 * 实现上刻意**不 import vue**（db/ 与 services/ 必须保持零框架依赖）：
 * 通过代理读属性拿到的就是值，重新构造纯对象即可，不需要 toRaw。
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
