/**
 * 激活条目 → 输出分桶。对齐 SillyTavern world-info.js:5070。
 *
 * ⚠️ 约定：按 order **降序**遍历 + `unshift`（outlet 桶除外，它用 push）。
 * 写成「升序 sort + push」看似等价，但**相同 order 的并列条目顺序会反过来** ——
 * 用户把三条同 order=100 的设定放进同一个桶，顺序就乱了，且只在特定数据下复现。
 */

import {
  DEFAULT_DEPTH,
  extension_prompt_roles,
  wi_anchor_position,
  world_info_position,
  type ExtensionPromptRole,
  type ResolvedEntry,
  type WiAnchorPosition,
} from '@/types/worldinfo'

export interface WIDepthBucket {
  depth: number
  role: ExtensionPromptRole
  entries: string[]
}

export interface WIExampleEntry {
  position: WiAnchorPosition
  content: string
}

export interface WIBuckets {
  worldInfoBefore: string
  worldInfoAfter: string
  emEntries: WIExampleEntry[]
  anTop: string[]
  anBottom: string[]
  depthEntries: WIDepthBucket[]
  outletEntries: Record<string, string[]>
  /**
   * 缓存友好布局下，从 before/after 挪出来的**非常驻**条目（before 组在前、after 组在后，
   * 组内顺序与原桶一致）。由提示词组装按 `dynamicWIDepth` 注入。未开启时缺省。
   */
  dynamicEntries?: string[]
}

export interface BucketOptions {
  /** true = 非常驻的 before/after 条目改进 dynamicEntries，前缀只留常驻条目 */
  splitDynamic?: boolean
}

/**
 * 条目是否「每轮稳定出现」。只有无概率门槛的常驻条目算；关键词触发、sticky、
 * 带概率的常驻都可能下一轮就不在了，放进前缀会让缓存整段失效。
 */
function isStable(e: ResolvedEntry): boolean {
  return e.constant && (!e.useProbability || e.probability >= 100)
}

export function bucketActivatedEntries(
  activated: ResolvedEntry[],
  opts: BucketOptions = {},
): WIBuckets {
  const before: string[] = []
  const after: string[] = []
  const dynBefore: string[] = []
  const dynAfter: string[] = []
  const em: WIExampleEntry[] = []
  const anTop: string[] = []
  const anBottom: string[] = []
  const depth: WIDepthBucket[] = []
  const outlet: Record<string, string[]> = {}

  // order 降序：大的先处理，配合 unshift 让最终读出来是「小 order 在前」
  const sorted = [...activated].sort((a, b) => b.order - a.order)

  for (const entry of sorted) {
    const content = entry.content
    if (!content) continue

    switch (entry.position) {
      case world_info_position.before:
        ;(opts.splitDynamic && !isStable(entry) ? dynBefore : before).unshift(content)
        break
      case world_info_position.after:
        ;(opts.splitDynamic && !isStable(entry) ? dynAfter : after).unshift(content)
        break
      case world_info_position.ANTop:
        anTop.unshift(content)
        break
      case world_info_position.ANBottom:
        anBottom.unshift(content)
        break
      case world_info_position.EMTop:
        em.unshift({ position: wi_anchor_position.before, content })
        break
      case world_info_position.EMBottom:
        em.unshift({ position: wi_anchor_position.after, content })
        break
      case world_info_position.atDepth: {
        const d = entry.depth ?? DEFAULT_DEPTH
        const role = entry.role ?? extension_prompt_roles.SYSTEM
        // 同 (depth, role) 合并到一个桶
        const found = depth.find((x) => x.depth === d && x.role === role)
        if (found) found.entries.unshift(content)
        else depth.push({ depth: d, role, entries: [content] })
        break
      }
      case world_info_position.outlet: {
        const key = entry.outletName || 'default'
        // 唯一用 push 的桶
        ;(outlet[key] ??= []).push(content)
        break
      }
    }
  }

  return {
    worldInfoBefore: before.join('\n'),
    worldInfoAfter: after.join('\n'),
    emEntries: em,
    anTop,
    anBottom,
    depthEntries: depth,
    outletEntries: outlet,
    ...(opts.splitDynamic ? { dynamicEntries: [...dynBefore, ...dynAfter] } : {}),
  }
}
