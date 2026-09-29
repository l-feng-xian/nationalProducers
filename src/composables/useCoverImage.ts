/**
 * 封面图 + 深度图（立绘视差）的替换与生成。角色编辑页与群聊编辑页共用。
 *
 * 规则（原来写在角色编辑页里，两处照搬会漂移，所以抽出来）：
 *  - 换封面：先落新引用、保存；**旧图不直接删**，只作废 objectURL 缓存 ——
 *    同一张图可能被别的角色 / 消息共享，孤儿交给引用清理（blobsRepo.gc / pruneUnreferenced）；
 *  - 保存失败回滚到旧引用，并删掉刚写入的新图；
 *  - 深度图只在启用了深度模型时生成，失败只提示、不回滚（封面已经换好了，视差有没有是另一回事）；
 *  - 「重新生成深度图」替换掉的旧深度图可以直接删：它只属于这张封面。
 */
import { ref } from 'vue'
import { blobsRepo } from '@/db/repositories'
import { invalidateObjectUrl } from '@/composables/useObjectUrl'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import { generateDepth } from '@/services/depth/generate'

export interface CoverTarget {
  avatarBlobId?: string | undefined
  depthBlobId?: string | undefined
}

export function useCoverImage(opts: {
  /** 当前编辑的对象（角色 / 群聊的草稿），会被就地修改 */
  target: () => CoverTarget | null | undefined
  /** 落盘 */
  save: () => Promise<void>
  /** 换图前的清理（摘掉视差画布：它还挂着旧图） */
  beforeReplace?: () => void
}) {
  const settings = useSettingsStore()
  const toast = useToast()
  const avatarBusy = ref(false)
  const depthBusy = ref(false)
  const depthPct = ref(0)

  async function replace(source: Blob) {
    const m = opts.target()
    if (!m || avatarBusy.value || depthBusy.value) throw new Error('图片正在保存，请稍后重试')
    avatarBusy.value = true
    const old = m.avatarBlobId
    const oldDepth = m.depthBlobId
    try {
      const id = await blobsRepo.put(source)
      opts.beforeReplace?.()
      m.avatarBlobId = id
      m.depthBlobId = undefined
      try {
        await opts.save()
      } catch (error) {
        m.avatarBlobId = old
        m.depthBlobId = oldDepth
        await blobsRepo.remove(id)
        throw error
      }
      // 先保存新引用；旧图片留给引用清理，避免破坏共享该封面的其他对象。
      if (old) invalidateObjectUrl(old)
      if (oldDepth) invalidateObjectUrl(oldDepth)
      await makeDepth(source)
    } finally {
      avatarBusy.value = false
    }
  }

  /** 生成并保存深度图。模型没启用就直接跳过 —— 这是「勾选启用才生成」的执行点 */
  async function makeDepth(source: Blob) {
    const m = opts.target()
    const modelId = settings.settings.depth.modelId
    if (!m || !modelId) return
    depthBusy.value = true
    depthPct.value = 0
    try {
      const { promise } = generateDepth(source, modelId, (loaded, total) => {
        if (total) depthPct.value = Math.round((loaded / total) * 100)
      })
      const res = await promise
      m.depthBlobId = await blobsRepo.put(res.blob)
      await opts.save()
      toast.success(`深度图已生成（${res.width}×${res.height}，${(res.ms / 1000).toFixed(1)} 秒）`)
    } catch (err) {
      toast.error(`深度图生成失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      depthBusy.value = false
    }
  }

  /** 给已有封面补生成 / 重新生成。上传时会自动跑，这是给「先有图、后启用模型」的情况兜底 */
  async function regenDepth() {
    const m = opts.target()
    if (!m?.avatarBlobId || depthBusy.value) return
    const blob = await blobsRepo.get(m.avatarBlobId)
    if (!blob) return
    const oldDepth = m.depthBlobId
    await makeDepth(blob)
    if (oldDepth && m.depthBlobId !== oldDepth) {
      invalidateObjectUrl(oldDepth)
      await blobsRepo.remove(oldDepth)
    }
  }

  return { avatarBusy, depthBusy, depthPct, replace, regenDepth }
}
