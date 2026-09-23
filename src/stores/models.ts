/**
 * 嵌入模型的下载与启用状态。
 *
 * 「是否已下载」的唯一真相是**浏览器缓存本身**（由 transformers 的 ModelRegistry 查），
 * 不在本地另存一份标记。存标记看起来省事，但它会和真相漂移：浏览器在磁盘吃紧时
 * 会把 Cache Storage 整个清掉，标记还写着「已下载」，于是用户点启用之后毫无反应，
 * 且没有任何地方能看出原因。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  checkCached,
  downloadModel,
  removeModel,
  requestPersistence,
  type DownloadHandle,
} from '@/services/vector/manager'
import { EMBED_PRESETS, findPreset, toSpec } from '@/services/vector/presets'
import { purgeHtmlPoison } from '@/services/ml/cacheRepair'
import { DEPTH_PRESETS, DEPTH_TASK, findDepthPreset } from '@/services/depth/presets'
import { useSettingsStore } from './settings'
import * as memRuntime from '@/services/memory/runtime'

export interface DownloadState {
  loaded: number
  total: number
  file: string
}

export const useModelsStore = defineStore('models', () => {
  const presets = EMBED_PRESETS
  const depthPresets = DEPTH_PRESETS

  /**
   * 每个模型属于哪一类任务。下载/查缓存/删除都必须带上它 ——
   * transformers 的 is_pipeline_cached 是按 task 决定要查哪些文件的，
   * 用错 task 查深度模型会得到「没下载」，然后用户怎么点下载都没反应。
   */
  const taskOf = (id: string) =>
    findDepthPreset(id) ? (DEPTH_TASK as 'depth-estimation') : undefined
  /** id → 是否已完整下载。未查过时为 undefined，UI 要能区分「未知」和「没有」 */
  const cached = ref<Record<string, boolean | undefined>>({})
  const checking = ref(false)
  /** 正在下载的 id，空串 = 无。同一时刻只允许一个，避免几百 MB 并发抢带宽和内存 */
  const downloadingId = ref('')
  const progress = ref<DownloadState | null>(null)
  const errors = ref<Record<string, string>>({})
  const persisted = ref<boolean | null>(null)
  let handle: DownloadHandle | null = null

  const settings = useSettingsStore()
  const activeId = computed(() => settings.settings.memory.vector.modelId)
  const activeDepthId = computed(() => settings.settings.depth.modelId)

  async function refresh() {
    checking.value = true
    try {
      // ⚠️ 先自愈再判断：SPA 回落的 index.html 可能被当成权重缓存下来（见 cacheRepair.ts），
      // 那条毒条目会让「已下载」判定和后续加载全部命中 HTML，且缓存命中短路网络、修好代理也不恢复。
      // 放在 checkCached 之前，进一次模型管理页就把中毒的浏览器修好。
      await purgeHtmlPoison()
      // 两类模型要分别按各自的 task 去查，不能合成一次调用
      const [emb, dep] = await Promise.all([
        checkCached(presets.map((p) => p.id)),
        checkCached(
          depthPresets.map((p) => p.id),
          DEPTH_TASK as 'depth-estimation',
        ),
      ])
      cached.value = { ...emb, ...dep }
    } catch (e) {
      // 查不出来时把全部置为 false 而不是留空：留空会让按钮一直是「检查中」的样子
      cached.value = Object.fromEntries([...presets, ...depthPresets].map((p) => [p.id, false]))
      errors.value = { ...errors.value, __check: errText(e) }
    } finally {
      checking.value = false
    }
  }

  async function download(id: string) {
    const p = findPreset(id) ?? findDepthPreset(id)
    if (!p || downloadingId.value) return
    const next = { ...errors.value }
    delete next[id]
    errors.value = next

    // 先要持久化许可再下：否则用户下完 100MB，浏览器某天清缓存就白下了
    persisted.value = await requestPersistence()

    downloadingId.value = id
    progress.value = { loaded: 0, total: p.bytes, file: '' }
    // 深度模型没有 pooling 这类嵌入专属字段，toSpec 只在嵌入预设上有意义
    const spec = 'pooling' in p ? toSpec(p) : { id: p.id, pooling: 'cls' as const }
    handle = downloadModel(
      spec,
      (pr) => {
        progress.value = pr
      },
      taskOf(id),
    )
    try {
      await handle.promise
      cached.value = { ...cached.value, [id]: true }
    } catch (e) {
      errors.value = { ...errors.value, [id]: errText(e) }
      // 失败后重新核对一次真实状态：可能是下到一半被取消，
      // 部分文件其实已经在缓存里了，下次点下载会接着下
      await refresh()
    } finally {
      handle = null
      downloadingId.value = ''
      progress.value = null
    }
  }

  function cancel() {
    handle?.cancel()
  }

  async function remove(id: string) {
    // 删掉正在用的模型就必须同时取消启用，否则设置里留着一个指向空气的 id
    if (activeId.value === id) await select('')
    if (activeDepthId.value === id) await selectDepth('')
    try {
      await removeModel(id, taskOf(id))
    } catch (e) {
      errors.value = { ...errors.value, [id]: errText(e) }
    }
    await refresh()
  }

  /**
   * 选中即启用。传空串 = 停用。
   *
   * 换模型会让**所有会话**已建的向量索引作废（维度和分布都不同）。这里不去逐个
   * 会话清库 —— catchUp 每次都会比对 `state.model`，不一致就自己清掉重建，
   * 惰性处理既省一次全库扫描，也天然覆盖了「切走再切回」。
   */
  async function select(id: string) {
    if (id && !cached.value[id]) return
    settings.settings.memory.vector.modelId = id
    // 正在服务的 worker 装的是旧模型，必须扔掉
    memRuntime.disposeAll()
    // flushNow 而不是 touch：这是用户的显式决定，不能压在 400ms 防抖里，
    // 立刻关页面就丢了
    await settings.flushNow()
  }

  /**
   * 启用/停用深度模型。选中即启用，空串即停用。
   *
   * 它只在**上传角色图片时**起作用 —— 启用之后新上传的立绘会顺带生成深度图；
   * 已经存在的立绘不会被追溯生成（那会是一次几十秒的批量 CPU 占用），
   * 需要的话去角色编辑页单独点生成。
   */
  async function selectDepth(id: string) {
    if (id && !cached.value[id]) return
    settings.settings.depth.modelId = id
    await settings.flushNow()
  }

  return {
    presets,
    depthPresets,
    activeDepthId,
    selectDepth,
    cached,
    checking,
    downloadingId,
    progress,
    errors,
    persisted,
    activeId,
    refresh,
    download,
    cancel,
    remove,
    select,
  }
})

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
