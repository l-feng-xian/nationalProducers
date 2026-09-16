/**
 * 二叉最小堆。
 *
 * 为 A* 的 open 表而生：原实现每次弹出都线性遍历整个 open 表找最小值，
 * 在 512×512 世界里预算 3000 节点就是数百万次比较，是寻路的主要开销。
 *
 * 纯数据结构：不 import 任何东西。
 */

export class MinHeap<T> {
  private readonly items: T[] = []
  private readonly compare: (a: T, b: T) => number

  /** compare(a, b) < 0 表示 a 优先出队 */
  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare
  }

  get size(): number {
    return this.items.length
  }

  push(value: T): void {
    const items = this.items
    items.push(value)
    let i = items.length - 1
    // 上浮
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.compare(items[i]!, items[parent]!) >= 0) break
      const tmp = items[i]!
      items[i] = items[parent]!
      items[parent] = tmp
      i = parent
    }
  }

  pop(): T | undefined {
    const items = this.items
    if (items.length === 0) return undefined
    const top = items[0]!
    const last = items.pop()!
    if (items.length === 0) return top
    items[0] = last
    // 下沉
    let i = 0
    const n = items.length
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let smallest = i
      if (l < n && this.compare(items[l]!, items[smallest]!) < 0) smallest = l
      if (r < n && this.compare(items[r]!, items[smallest]!) < 0) smallest = r
      if (smallest === i) break
      const tmp = items[i]!
      items[i] = items[smallest]!
      items[smallest] = tmp
      i = smallest
    }
    return top
  }

  peek(): T | undefined {
    return this.items[0]
  }

  clear(): void {
    this.items.length = 0
  }
}
