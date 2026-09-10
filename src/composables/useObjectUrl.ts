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

async function acquire(id: string): Promise<string | null> {
  const hit = cache.get(id)
  if (hit) {
    hit.refs++
    return hit.url
  }
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
  if (e.refs <= 0) {
    URL.revokeObjectURL(e.url)
    cache.delete(id)
  }
}

/** 图片被替换后调用，强制下次重新取（否则会一直显示旧图） */
export function invalidateObjectUrl(id: string) {
  const e = cache.get(id)
  if (!e) return
  URL.revokeObjectURL(e.url)
  cache.delete(id)
}

export function useObjectUrl(blobId: Ref<string | undefined>) {
  const url = ref<string | null>(null)
  let held: string | null = null

  const sync = async (id: string | undefined) => {
    if (held === id) return
    if (held) release(held)
    held = id ?? null
    url.value = id ? await acquire(id) : null
  }

  watch(blobId, (id) => void sync(id), { immediate: true })
  onUnmounted(() => {
    if (held) release(held)
    held = null
  })

  return { url }
}
