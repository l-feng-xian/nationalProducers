/**
 * 世界书扫描主循环 —— 完整对齐 SillyTavern world-info.js:4597 checkWorldInfo。
 *
 * ⚠️ 下面第 1 步的 16 步拒绝级联，**顺序本身就是语义**：
 *    delay 压过一切（含 sticky 与 constant）；sticky 压过 cooldown / delayUntilRecursion /
 *    excludeRecursion；四个正向短路（装饰器 / 外部激活 / constant / sticky）都排在关键词扫描之前。
 *    任何「顺手整理一下」的重排都会产生用不出来、但排查极难的偏差。
 *    改动前请对照 world-info.js L4685-4877 逐行核对。
 */

import { WorldInfoBuffer, type WIGlobalScanData } from './buffer'
import { WorldInfoTimedEffects } from './timed'
import { filterByInclusionGroups } from './groups'
import { bucketActivatedEntries, type WIBuckets } from './buckets'
import { scan_state, world_info_logic, type ResolvedEntry, type ScanState } from '@/types/worldinfo'
import type { TimedWorldInfo } from '@/types/chat'
import type { WorldInfoSettings } from '@/types/settings'

export interface WIScanInput {
  /** 新→旧倒序的消息文本（includeNames 时已是 `Name: mes`） */
  chat: string[]
  /** 定时效果时钟：参与提示词的非系统消息条数 */
  chatLength: number
  maxContext: number
  isDryRun: boolean
  globalScanData: WIGlobalScanData
  /** resolveSortedEntries 的产物（**必须已深拷贝**，扫描会就地改写 content） */
  sortedEntries: ResolvedEntry[]
  settings: WorldInfoSettings
  /** 就地修改；dryRun 时调用方需传克隆副本 */
  timedStore: TimedWorldInfo
  /** scan:true 的注入文本（约束提示词等，若允许被世界书扫描） */
  injects: string[]
  countTokens: (text: string) => number
  substitute: (text: string) => string
  characterName?: string
  characterTags?: string[]
  externalActivations?: Map<string, ResolvedEntry>
  /** 缓存友好布局：非常驻的 before/after 条目另放进 dynamicEntries，见 buckets.ts */
  splitDynamic?: boolean
}

export type WIScanResult = WIBuckets & {
  allActivatedEntries: ResolvedEntry[]
  budget: number
  budgetOverflowed: boolean
}

const emptyResult = (budget: number): WIScanResult => ({
  worldInfoBefore: '',
  worldInfoAfter: '',
  emEntries: [],
  anTop: [],
  anBottom: [],
  depthEntries: [],
  outletEntries: {},
  allActivatedEntries: [],
  budget,
  budgetOverflowed: false,
})

const entryId = (e: ResolvedEntry) => `${e.world}.${e.uid}`

export function checkWorldInfo(input: WIScanInput): WIScanResult {
  const {
    chat,
    chatLength,
    maxContext,
    isDryRun,
    globalScanData,
    sortedEntries,
    settings,
    timedStore,
    injects,
    countTokens,
    substitute,
  } = input

  let budget = Math.round((settings.world_info_budget * maxContext) / 100) || 1
  if (settings.world_info_budget_cap > 0 && budget > settings.world_info_budget_cap) {
    budget = settings.world_info_budget_cap
  }

  if (sortedEntries.length === 0) return emptyResult(budget)

  const buffer = new WorldInfoBuffer(chat, globalScanData, settings, input.externalActivations)
  for (const inj of injects) if (inj) buffer.addInject(inj)

  const timedEffects = new WorldInfoTimedEffects(timedStore, chatLength, isDryRun)
  timedEffects.checkTimedEffects(sortedEntries)

  let scanState: ScanState = scan_state.INITIAL
  let tokenBudgetOverflowed = false
  let count = 0
  const allActivatedEntries = new Map<string, ResolvedEntry>()
  const failedProbabilityChecks = new Set<ResolvedEntry>()
  let allActivatedText = ''

  // sortedEntries.indexOf 在比较器里是 O(n)，预先建索引
  const orderIndex = new Map<ResolvedEntry, number>()
  sortedEntries.forEach((e, i) => orderIndex.set(e, i))
  const idxOf = (e: ResolvedEntry) => orderIndex.get(e) ?? -1

  const availableRecursionDelayLevels = [
    ...new Set(
      sortedEntries.filter((e) => e.delayUntilRecursion).map((e) => Number(e.delayUntilRecursion)),
    ),
  ].sort((a, b) => a - b)
  let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0

  while (scanState) {
    // 注意：maxRecursionSteps 非零时 minActivations 事实上被禁用，反之亦然
    if (
      settings.world_info_max_recursion_steps &&
      settings.world_info_max_recursion_steps <= count
    ) {
      break
    }
    count++

    let nextScanState: ScanState = scan_state.NONE
    const activatedNow = new Set<ResolvedEntry>()

    // ═══ 第 1 步：候选筛选。以下 16 步顺序有语义，禁止重排 ═══
    for (const entry of sortedEntries) {
      // 1 已处理 / 已激活
      if (failedProbabilityChecks.has(entry) || allActivatedEntries.has(entryId(entry))) continue
      // 2 禁用
      if (entry.disable === true) continue
      // 3 生成类型过滤
      if (entry.triggers.length > 0 && !entry.triggers.includes(globalScanData.trigger)) continue
      // 4 角色名过滤
      if (entry.characterFilter.names.length > 0) {
        const included =
          input.characterName !== undefined &&
          entry.characterFilter.names.includes(input.characterName)
        if (entry.characterFilter.isExclude ? included : !included) continue
      }
      // 5 角色标签过滤
      if (entry.characterFilter.tags.length > 0) {
        const tags = input.characterTags ?? []
        const included = tags.some((t) => entry.characterFilter.tags.includes(t))
        if (entry.characterFilter.isExclude ? included : !included) continue
      }

      const isSticky = timedEffects.isEffectActive('sticky', entry)
      const isCooldown = timedEffects.isEffectActive('cooldown', entry)
      const isDelay = timedEffects.isDelayed(entry)

      // 6 delay 优先级最高，压过 sticky 与 constant
      if (isDelay) continue
      // 7 sticky 压过 cooldown
      if (isCooldown && !isSticky) continue
      // 8 非递归轮里的 delayUntilRecursion
      if (scanState !== scan_state.RECURSION && entry.delayUntilRecursion && !isSticky) continue
      // 9 递归轮但等级未到
      if (
        scanState === scan_state.RECURSION &&
        entry.delayUntilRecursion &&
        Number(entry.delayUntilRecursion) > currentRecursionDelayLevel &&
        !isSticky
      ) {
        continue
      }
      // 10 递归轮里的 excludeRecursion
      if (
        scanState === scan_state.RECURSION &&
        settings.world_info_recursive &&
        entry.excludeRecursion &&
        !isSticky
      ) {
        continue
      }

      // ── 正向短路 ──
      // 11 / 12 装饰器
      if (entry.decorators.includes('@@activate')) {
        activatedNow.add(entry)
        continue
      }
      if (entry.decorators.includes('@@dont_activate')) continue
      // 13 外部强制激活（加入的是外部那份对象）
      const external = buffer.getExternallyActivated(entry)
      if (external) {
        activatedNow.add(external as ResolvedEntry)
        continue
      }
      // 14 常驻（蓝灯）
      if (entry.constant) {
        activatedNow.add(entry)
        continue
      }
      // 15 sticky 无需关键词
      if (isSticky) {
        activatedNow.add(entry)
        continue
      }
      // 16 无主键 → 只能靠上面的路径激活
      if (!Array.isArray(entry.key) || !entry.key.length) continue

      // ── 关键词扫描 ──
      const textToScan = buffer.get(entry, scanState)
      const primaryKeyMatch = entry.key.find((k) => {
        const s = substitute(k)
        return !!s && buffer.matchKeys(textToScan, s.trim(), entry)
      })
      if (!primaryKeyMatch) continue

      const hasSecondary =
        entry.selective && Array.isArray(entry.keysecondary) && entry.keysecondary.length > 0
      if (!hasSecondary) {
        activatedNow.add(entry)
        continue
      }
      if (matchSecondaryKeys(buffer, textToScan, entry, substitute)) activatedNow.add(entry)
    }

    // ═══ 第 2 步：候选排序（sticky 优先，其次原优先级序） ═══
    const newEntries = [...activatedNow].sort((a, b) => {
      const sa = timedEffects.isEffectActive('sticky', a) ? 1 : 0
      const sb = timedEffects.isEffectActive('sticky', b) ? 1 : 0
      return sb - sa || idxOf(a) - idxOf(b)
    })

    let newContent = ''
    const textToScanTokens = countTokens(allActivatedText)

    // ═══ 第 3 步：包含组过滤（就地删元素） ═══
    filterByInclusionGroups(
      newEntries,
      allActivatedEntries,
      buffer,
      scanState,
      timedEffects,
      settings,
    )

    // ═══ 第 4 步：概率 + 预算 ═══
    // 这一段整体照抄，不要「优化」：溢出的条目被丢弃但其内容**仍留在 newContent 里**
    // 继续挤压后续条目；overflow 置位后只放行剩余的 ignoreBudget 条目，计数器归零即 break。
    let ignoresBudget = newEntries.filter((e) => e.ignoreBudget).length
    for (const entry of newEntries) {
      ignoresBudget -= entry.ignoreBudget ? 1 : 0
      if (tokenBudgetOverflowed && !entry.ignoreBudget) {
        if (ignoresBudget > 0) continue
        break
      }

      if (!verifyProbability(entry, timedEffects, failedProbabilityChecks)) continue

      // 宏就地展开，之后的分桶直接用这份 content
      entry.content = substitute(entry.content)
      newContent += `${entry.content}\n`

      // 注意是 >=，且计入之前轮次已激活的文本
      if (!entry.ignoreBudget && textToScanTokens + countTokens(newContent) >= budget) {
        tokenBudgetOverflowed = true
        continue
      }
      allActivatedEntries.set(entryId(entry), entry)
    }

    // ═══ 第 5 步：决定下一状态 ═══
    const successfulNewEntries = newEntries.filter((x) => !failedProbabilityChecks.has(x))
    const forRecursion = successfulNewEntries.filter((x) => !x.preventRecursion)

    if (settings.world_info_recursive && !tokenBudgetOverflowed && forRecursion.length) {
      nextScanState = scan_state.RECURSION
    }
    if (
      settings.world_info_recursive &&
      !tokenBudgetOverflowed &&
      scanState === scan_state.MIN_ACTIVATIONS &&
      buffer.hasRecurse()
    ) {
      nextScanState = scan_state.RECURSION
    }

    const minNotSatisfied =
      settings.world_info_min_activations > 0 &&
      allActivatedEntries.size < settings.world_info_min_activations
    if (!nextScanState && !tokenBudgetOverflowed && minNotSatisfied) {
      const overMax =
        (settings.world_info_min_activations_depth_max > 0 &&
          buffer.getDepth() > settings.world_info_min_activations_depth_max) ||
        buffer.getDepth() > chat.length
      if (!overMax) {
        nextScanState = scan_state.MIN_ACTIVATIONS
        buffer.advanceScan()
      }
    }

    if (nextScanState === scan_state.NONE && availableRecursionDelayLevels.length) {
      nextScanState = scan_state.RECURSION
      currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0
    }

    // ═══ 第 6 步：扩展递归缓冲 ═══
    scanState = nextScanState
    if (scanState) {
      const text = forRecursion.map((x) => x.content).join('\n')
      if (text) {
        buffer.addRecurse(text)
        allActivatedText = text + '\n' + allActivatedText
      }
    }
  }

  const activated = [...allActivatedEntries.values()]
  const buckets = bucketActivatedEntries(activated, { splitDynamic: input.splitDynamic ?? false })
  timedEffects.setTimedEffects(activated)
  buffer.resetExternalEffects()
  return {
    ...buckets,
    allActivatedEntries: activated,
    budget,
    budgetOverflowed: tokenBudgetOverflowed,
  }
}

function verifyProbability(
  entry: ResolvedEntry,
  timedEffects: WorldInfoTimedEffects,
  failed: Set<ResolvedEntry>,
): boolean {
  if (!entry.useProbability || entry.probability === 100) return true
  // sticky 不重新掷骰，否则窗口内会闪断
  if (timedEffects.isEffectActive('sticky', entry)) return true
  if (Math.random() * 100 <= entry.probability) return true
  failed.add(entry)
  return false
}

function matchSecondaryKeys(
  buffer: WorldInfoBuffer,
  textToScan: string,
  entry: ResolvedEntry,
  substitute: (s: string) => string,
): boolean {
  const logic = entry.selectiveLogic ?? world_info_logic.AND_ANY
  let hasAnyMatch = false
  let hasAllMatch = true
  for (const raw of entry.keysecondary) {
    const s = substitute(raw)
    const hit = !!s && buffer.matchKeys(textToScan, s.trim(), entry)
    if (hit) hasAnyMatch = true
    else hasAllMatch = false
    if (logic === world_info_logic.AND_ANY && hit) return true
    if (logic === world_info_logic.NOT_ALL && !hit) return true
  }
  if (logic === world_info_logic.NOT_ANY && !hasAnyMatch) return true
  if (logic === world_info_logic.AND_ALL && hasAllMatch) return true
  return false
}
