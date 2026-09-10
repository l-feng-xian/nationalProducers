/**
 * 扫描缓冲区。对齐 SillyTavern world-info.js:199 WorldInfoBuffer。
 *
 * 四个来源：消息窗口 / 递归缓冲 / 注入缓冲 / 卡片字段（按条目 opt-in）。
 */

import { escapeRegex, parseRegexFromString } from './regex'
import {
  MAX_SCAN_DEPTH,
  scan_state,
  world_info_logic,
  type ScanState,
  type WorldInfoEntry,
  type GenerationTrigger,
} from '@/types/worldinfo'
import type { WorldInfoSettings } from '@/types/settings'

export interface WIGlobalScanData {
  personaDescription: string
  characterDescription: string
  characterPersonality: string
  characterDepthPrompt: string
  scenario: string
  creatorNotes: string
  trigger: GenerationTrigger
}

/**
 * `\x01` 是非单词字符，充当「合成词边界」：
 *  ① 每条消息的开头/结尾都能整词匹配
 *  ② 匹配不会跨越消息边界（否则上一条结尾+下一条开头会拼出并不存在的词）
 */
const MATCHER = '\x01'
const JOINER = '\n' + MATCHER

export interface ResolvedLike extends WorldInfoEntry {
  world: string
}

export class WorldInfoBuffer {
  #depthBuffer: string[] = []
  #recurseBuffer: string[] = []
  #injectBuffer: string[] = []
  #globalScanData: WIGlobalScanData
  #settings: WorldInfoSettings
  #skew = 0
  #startDepth = 0
  #external: Map<string, ResolvedLike>

  constructor(
    messages: string[],
    globalScanData: WIGlobalScanData,
    settings: WorldInfoSettings,
    external: Map<string, ResolvedLike> = new Map(),
  ) {
    this.#globalScanData = globalScanData
    this.#settings = settings
    this.#external = external
    for (let depth = 0; depth < MAX_SCAN_DEPTH && depth < messages.length; depth++) {
      const m = messages[depth]
      if (m !== undefined) this.#depthBuffer[depth] = m.trim()
    }
  }

  #transform(str: string, entry: WorldInfoEntry): string {
    const cs = entry.caseSensitive ?? this.#settings.world_info_case_sensitive
    return cs ? str : str.toLowerCase()
  }

  /** 组装本条目的 haystack。scanState 只影响「是否包含递归缓冲」 */
  get(entry: WorldInfoEntry, scanState: ScanState): string {
    let depth = entry.scanDepth ?? this.getDepth()
    if (depth <= this.#startDepth) return ''
    if (depth < 0) return ''
    if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH

    let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER)
    const g = this.#globalScanData
    if (entry.matchPersonaDescription && g.personaDescription) {
      result += JOINER + g.personaDescription
    }
    if (entry.matchCharacterDescription && g.characterDescription) {
      result += JOINER + g.characterDescription
    }
    if (entry.matchCharacterPersonality && g.characterPersonality) {
      result += JOINER + g.characterPersonality
    }
    if (entry.matchCharacterDepthPrompt && g.characterDepthPrompt) {
      result += JOINER + g.characterDepthPrompt
    }
    if (entry.matchScenario && g.scenario) result += JOINER + g.scenario
    if (entry.matchCreatorNotes && g.creatorNotes) result += JOINER + g.creatorNotes

    if (this.#injectBuffer.length > 0) result += JOINER + this.#injectBuffer.join(JOINER)
    // MIN_ACTIVATIONS 扩窗时**故意排除**递归缓冲，
    // 否则「只靠递归文本命中」的条目会因为扩窗被反复触发
    if (this.#recurseBuffer.length > 0 && scanState !== scan_state.MIN_ACTIVATIONS) {
      result += JOINER + this.#recurseBuffer.join(JOINER)
    }
    return result
  }

  matchKeys(haystack: string, needle: string, entry: WorldInfoEntry): boolean {
    // 正则 key 覆盖大小写 / 整词的全部设置
    const keyRegex = parseRegexFromString(needle)
    if (keyRegex) return keyRegex.test(haystack)

    const hay = this.#transform(haystack, entry)
    const nee = this.#transform(needle, entry)
    const whole = entry.matchWholeWords ?? this.#settings.world_info_match_whole_words

    if (whole) {
      // 多词短语无法整词匹配，回退子串（与 ST 一致）
      if (nee.split(/\s+/).length > 1) return hay.includes(nee)
      return new RegExp(`(?:^|\\W)(${escapeRegex(nee)})(?:$|\\W)`).test(hay)
    }
    return hay.includes(nee)
  }

  /** 包含组内评分：命中的主键数（+ 正向逻辑下的副键数） */
  getScore(entry: WorldInfoEntry, scanState: ScanState): number {
    const state = this.get(entry, scanState)
    let nPrimary = 0
    let nSecondary = 0
    let primary = 0
    let secondary = 0
    if (Array.isArray(entry.key)) {
      nPrimary = entry.key.length
      for (const k of entry.key) if (this.matchKeys(state, k, entry)) primary++
    }
    if (Array.isArray(entry.keysecondary)) {
      nSecondary = entry.keysecondary.length
      for (const k of entry.keysecondary) if (this.matchKeys(state, k, entry)) secondary++
    }
    if (!nPrimary) return 0
    if (nSecondary > 0) {
      if (entry.selectiveLogic === world_info_logic.AND_ANY) return primary + secondary
      if (entry.selectiveLogic === world_info_logic.AND_ALL) {
        return secondary === nSecondary ? primary + secondary : primary
      }
    }
    return primary
  }

  addRecurse(m: string) {
    this.#recurseBuffer.push(m)
  }
  addInject(m: string) {
    this.#injectBuffer.push(m)
  }
  hasRecurse() {
    return this.#recurseBuffer.length > 0
  }
  /** MIN_ACTIVATIONS 扩窗 */
  advanceScan() {
    this.#skew++
  }
  getDepth() {
    return this.#settings.world_info_depth + this.#skew
  }
  getExternallyActivated(entry: ResolvedLike): ResolvedLike | undefined {
    return this.#external.get(`${entry.world}.${entry.uid}`)
  }
  resetExternalEffects() {
    this.#external.clear()
  }
}
