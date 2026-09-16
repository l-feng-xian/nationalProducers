/**
 * 关系回写规则引擎。
 *
 * ## ⚠️ 绝不从自然语言解析数值
 * 让模型吐「好感+5」再去解析，会被措辞、语言、幻觉带着乱跳。数值一律由**确定性规则**
 * 算出：交谈本身让人渐渐熟络，初识涨得快、之后微涨。规则是纯函数，可复现、可测。
 *
 * ## 幂等
 * 每次交谈按**回合序号**给一次奖励；面板只对「还没奖励过的新回合」调用。
 * 于是重放同一回合不会重复加好感（对应验收「连点重掷 3 次好感只涨一次」）。
 * 面板另设每场上限，防止一直尬聊把好感刷爆。
 *
 * 纯 service：不 import three/vue/pinia。
 */

import { USER_NODE_ID } from '@/types/group'
import type { GameWorld, WorldRelation } from '@/types/infiniteWorld'

export interface RelationDelta {
  dScore: number
  dTrust: number
}

/** 每场交谈累计好感上限：一直聊也就到这儿 */
export const SESSION_SCORE_CAP = 8
export const SESSION_TRUST_CAP = 5

/** 第 turnIndex 次交谈（0 起）该涨多少。递减：初识长得快，之后微涨 */
export function rewardForTurn(turnIndex: number): RelationDelta {
  if (turnIndex <= 0) return { dScore: 4, dTrust: 3 }
  if (turnIndex <= 2) return { dScore: 2, dTrust: 1 }
  if (turnIndex <= 5) return { dScore: 1, dTrust: 1 }
  return { dScore: 1, dTrust: 0 }
}

/** 玩家与这位居民之间的关系（任一方向），没有则 undefined */
export function findUserRelation(world: GameWorld, npcId: string): WorldRelation | undefined {
  return world.relations.find(
    (r) =>
      (r.from === USER_NODE_ID && r.to === npcId) ||
      (r.from === npcId && r.to === USER_NODE_ID),
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 把一次交谈奖励并入世界关系（就地）。关系不存在则新建（默认「相识」）。
 * 返回并入后的 score/trust，供界面显示。
 */
export function applyReward(
  world: GameWorld,
  npcId: string,
  delta: RelationDelta,
): { score: number; trust: number; label: string } {
  let rel = findUserRelation(world, npcId)
  if (!rel) {
    rel = {
      id: crypto.randomUUID(),
      from: USER_NODE_ID,
      to: npcId,
      label: '相识',
      score: 0,
      trust: 50,
      desc: '',
    }
    world.relations.push(rel)
  }
  rel.score = clamp(rel.score + delta.dScore, -100, 100)
  rel.trust = clamp(rel.trust + delta.dTrust, 0, 100)
  return { score: rel.score, trust: rel.trust, label: rel.label }
}

/** 好感数值 → 一个词，界面与提示词共用同一套口径 */
export function affinityWord(score: number): string {
  return score >= 60 ? '亲密' : score >= 20 ? '亲近' : score > -20 ? '平常' : score > -60 ? '疏远' : '敌对'
}
