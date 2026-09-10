/**
 * 定时效果：sticky / cooldown / delay。
 * 对齐 SillyTavern world-info.js:479 WorldInfoTimedEffects。
 *
 * 语义：
 *  - sticky N   触发后连续 N 条消息保持激活；窗口关闭时**立刻**开启一个受保护的 cooldown
 *  - cooldown N 失活后 N 条消息内不可再激活
 *  - delay N    会话前 N 条消息内不可激活
 *
 * ⚠️ 三处时钟必须同口径：start / end / delay 都用同一个 `chatLength`
 * （= 参与提示词的非系统消息条数）。用「含系统消息的总数」或「UI 显示条数」
 * 会导致效果永不过期或立刻过期。
 *
 * ⚠️ dryRun（提示词预览）**不得推进** sticky/cooldown —— 调用方需先克隆 state。
 */

import { hashObject } from '../hash'
import type { TimedEffect, TimedWorldInfo } from '@/types/chat'
import type { ResolvedEntry } from '@/types/worldinfo'

export type TimedType = 'sticky' | 'cooldown'

function keyOf(entry: { world: string; uid: number }): string {
  return `${entry.world}.${entry.uid}`
}

/**
 * 条目身份哈希。必须用**固定键序**序列化，否则同一条目从不同路径
 * （新建 / 导入 / IndexedDB 反序列化）拿到的 hash 不同，正在跑的 sticky 会莫名断掉。
 */
export function entryHash(entry: { key: string[]; content: string; comment: string }): number {
  return hashObject({ key: entry.key, content: entry.content, comment: entry.comment })
}

export class WorldInfoTimedEffects {
  #state: TimedWorldInfo
  #chatLength: number
  #isDryRun: boolean
  /** 本轮新激活、待写入 sticky 的条目 */
  #toSetSticky: ResolvedEntry[] = []

  constructor(state: TimedWorldInfo, chatLength: number, isDryRun: boolean) {
    state.sticky ??= {}
    state.cooldown ??= {}
    this.#state = state
    this.#chatLength = chatLength
    this.#isDryRun = isDryRun
  }

  /** 清理过期效果；sticky 结束时接力开启受保护的 cooldown */
  checkTimedEffects(entries: ResolvedEntry[]) {
    // dryRun 时完全不推进 sticky/cooldown（delay 是纯计算，不受影响）
    if (this.#isDryRun) return
    const byKey = new Map(entries.map((e) => [keyOf(e), e]))

    for (const type of ['sticky', 'cooldown'] as TimedType[]) {
      const bucket = this.#state[type]
      for (const k of Object.keys(bucket)) {
        const eff = bucket[k]
        if (!eff) continue
        const entry = byKey.get(k)
        // 条目内容变了 → 身份失效
        if (entry && eff.hash !== entry.hash) {
          delete bucket[k]
          continue
        }
        // 会话被回退到 start 之前（删消息/分支）→ 失效，除非受保护
        if (this.#chatLength < eff.start && !eff.protected) {
          delete bucket[k]
          continue
        }
        if (this.#chatLength >= eff.end) {
          delete bucket[k]
          // sticky 结束 → 立刻进入受保护的 cooldown
          if (type === 'sticky' && entry?.cooldown && entry.cooldown > 0) {
            this.#state.cooldown[k] = {
              hash: entry.hash,
              start: this.#chatLength,
              end: this.#chatLength + entry.cooldown,
              protected: true,
            }
          }
        }
      }
    }
  }

  isEffectActive(type: TimedType, entry: ResolvedEntry): boolean {
    const eff: TimedEffect | undefined = this.#state[type][keyOf(entry)]
    return !!eff && this.#chatLength < eff.end
  }

  /** delay：会话前 N 条消息内不可激活。纯计算，无状态 */
  isDelayed(entry: ResolvedEntry): boolean {
    if (!entry.delay || entry.delay <= 0) return false
    return this.#chatLength < entry.delay
  }

  /** 本轮激活的条目：登记待写入的 sticky */
  setTimedEffects(entries: ResolvedEntry[]) {
    if (this.#isDryRun) return
    for (const e of entries) {
      if (!e.sticky || e.sticky <= 0) continue
      const k = keyOf(e)
      // 已在 sticky 窗口内的不重置（否则永远不会结束）
      if (this.#state.sticky[k]) continue
      this.#toSetSticky.push(e)
    }
    for (const e of this.#toSetSticky) {
      this.#state.sticky[keyOf(e)] = {
        hash: e.hash,
        start: this.#chatLength,
        end: this.#chatLength + (e.sticky ?? 0),
        protected: false,
      }
    }
    this.#toSetSticky = []
  }

  get state(): TimedWorldInfo {
    return this.#state
  }
}
