/**
 * IndexedDB Blob → objectURL 的集中缓存与引用计数。
 *
 * ⚠️ 不要在组件里散写 URL.createObjectURL：切换会话 / 滚动长列表会持续泄漏几十上百 MB。
 * 所有头像显示都必须经过这里（实际上只经过 CbxAvatar 这一个入口）。
 */

import { onUnmounted, ref, watch, type Ref } from 'vue'
import { blobsRepo } from '@/db/repositories'

interface Entry {
  url: string
  refs: number
}

const cache = new Map<string, Entry>()
const pending = new Map<string, Promise<string | null>>()

/**
 * 引用归零后的**回收宽限期**。
 *
 * 路由切换时 Vue 先卸载旧组件、再挂载新组件，于是同一张图会
 * 「release → refs 归零 → revoke → 新组件 acquire → 重查 IDB → createObjectURL」
 * 白跑一整趟。实测列表页→编辑页：revoke 在 913ms、create 在 919ms，
 * 中间那 6ms 里 url 为 null，CbxAvatar 渲染的是**文字兜底 div**，
 * 图片就绪后才换成 img —— 这就是头像「先闪一下文字」的根因。
 *
 * 延后回收让这种「卸载后立刻重新获取」直接命中缓存。
 * 1s 足够覆盖懒加载路由 chunk 已缓存时的切换；上限 16 条防止
 * 快速滚长列表时攒下一大把待回收的 Blob。
 */
const GRACE_MS = 1000
const MAX_GRACE = 16
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()

function cancelGrace(id: string) {
  const t = graceTimers.get(id)
  if (t === undefined) return
  clearTimeout(t)
  graceTimers.delete(id)
}

/** 真正回收 */
function evict(id: string) {
  cancelGrace(id)
  const e = cache.get(id)
  if (!e) return
  URL.revokeObjectURL(e.url)
  cache.delete(id)
}

/**
 * 同步取缓存命中。
 * 命中时**不经过任何 await** —— 否则 url.value 至少有一个微任务是 null，
 * 组件第一帧必然渲染文字兜底，之后再跳成 img。
 */
function acquireSync(id: string): string | null {
  const hit = cache.get(id)
  if (!hit) return null
  cancelGrace(id) // 正在宽限期里被救回来
  hit.refs++
  return hit.url
}

async function acquire(id: string): Promise<string | null> {
  const sync = acquireSync(id)
  if (sync !== null) return sync

  const inflight = pending.get(id)
  if (inflight) {
    const url = await inflight
    const e = cache.get(id)
    if (e) e.refs++
    return url
  }
  const p = (async () => {
    const blob = await blobsRepo.get(id)
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    cache.set(id, { url, refs: 1 })
    return url
  })()
  pending.set(id, p)
  try {
    return await p
  } finally {
    pending.delete(id)
  }
}

function release(id: string) {
  const e = cache.get(id)
  if (!e) return
  e.refs--
  if (e.refs > 0) return

  // 归零不立即回收，先进宽限期；期间被重新 acquire 就原地复活
  cancelGrace(id)
  if (graceTimers.size >= MAX_GRACE) {
    // 满了就先把最早进来的那条真回收掉，避免无上限堆积
    const oldest = graceTimers.keys().next()
    if (!oldest.done) evict(oldest.value)
  }
  graceTimers.set(
    id,
    setTimeout(() => {
      graceTimers.delete(id)
      const cur = cache.get(id)
      if (cur && cur.refs <= 0) {
        URL.revokeObjectURL(cur.url)
        cache.delete(id)
      }
    }, GRACE_MS),
  )
}

/** 图片被替换后调用，强制下次重新取（否则会一直显示旧图）。
 *  必须绕过宽限期立即回收 —— 旧图留在缓存里就等于没换。 */
export function invalidateObjectUrl(id: string) {
  evict(id)
}

export function useObjectUrl(blobId: Ref<string | undefined>) {
  const url = ref<string | null>(null)
  let held: string | null = null

  const sync = (id: string | undefined) => {
    if (held === id) return
    if (held) release(held)
    held = id ?? null
    if (!id) {
      url.value = null
      return
    }
    // 先试同步命中：命中就在**本帧**直接是 img，不会先闪一下文字兜底
    const hit = acquireSync(id)
    if (hit !== null) {
      url.value = hit
      return
    }
    void acquire(id).then((u) => {
      // 期间 blobId 可能又变了，晚到的结果不能覆盖新值
      if (held === id) url.value = u
    })
  }

  watch(blobId, (id) => sync(id), { immediate: true })
  onUnmounted(() => {
    if (held) release(held)
    held = null
  })

  return { url }
}
