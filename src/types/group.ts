/**
 * 群聊（1vN）类型 —— 对齐 SillyTavern group-chats.js，外加自研的**角色关系图谱**。
 *
 * 枚举数值权威来源：SillyTavern/public/scripts/group-chats.js L122 / L129
 */

import type { GroupStatusConfig } from './status'

export const group_activation_strategy = { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 } as const
export type GroupActivationStrategy =
  (typeof group_activation_strategy)[keyof typeof group_activation_strategy]

export const group_generation_mode = { SWAP: 0, APPEND: 1, APPEND_DISABLED: 2 } as const
export type GroupGenerationMode = (typeof group_generation_mode)[keyof typeof group_generation_mode]

export const DEFAULT_AUTO_MODE_DELAY = 5

/**
 * 关系图谱里代表「用户自己」的节点 id。
 *
 * 用户不是角色、没有 characterId，但沉浸式群聊里「我和她是什么关系」和
 * 「她和他是什么关系」同样重要。用一个不可能与 UUID 冲突的哨兵串把用户接进
 * **同一套**有向边里，关系渲染、画布节点、成员移除清理全都不需要开特例分支。
 */
export const USER_NODE_ID = '__user__'

/**
 * 群聊内用户扮演的身份。
 *
 * 两项都留空 = 沿用全局人设。做成群聊级而非会话级，是因为它和关系图谱是一对：
 * 同一个群聊里「我是谁」和「我跟她们什么关系」必须一起成立，分开配会互相矛盾。
 */
export interface GroupPersona {
  name: string
  description: string
}

/**
 * 关系图谱的**有向**边（需求 3）。
 * A→B 与 B→A 是两条独立的边，可以完全不同
 * （例：A→B「暗恋」，B→A「当成妹妹」）。
 */
export interface GroupRelation {
  id: string
  /** characterId */
  from: string
  /** characterId */
  to: string
  /** 关系名，注入提示词的主体：「妹妹」「宿敌」「暗恋对象」 */
  label: string
  /** 补充描述 */
  desc?: string
}

/** 画布逻辑坐标 */
export interface GroupNodeLayout {
  x: number
  y: number
}

export interface Group {
  id: string
  name: string
  /** 有序 characterId 列表 = ST 的 list order，决定 LIST 策略发言顺序与卡片拼接顺序 */
  members: string[]
  /** 静音成员（不会被自动选为发言者，但仍可被点名） */
  disabled_members: string[]
  activation_strategy: GroupActivationStrategy
  generation_mode: GroupGenerationMode
  /** 仅 APPEND 模式：每个成员字段的前缀，支持宏与 <FIELDNAME> */
  generation_mode_join_prefix: string
  generation_mode_join_suffix: string
  auto_mode_delay: number
  /** NATURAL 策略下是否允许上一个发言者连续发言 */
  allow_self_responses: boolean
  fav: boolean
  // ── 自研：关系图谱（需求 3） ──
  relations: GroupRelation[]
  /** characterId → 画布坐标 */
  layout: Record<string, GroupNodeLayout>
  /** 关系行模板，支持 {{from}} {{to}} {{label}} {{desc}} */
  relationTemplate: string
  /** 本群聊里用户扮演的身份，留空则沿用全局人设 */
  persona: GroupPersona
  /**
   * false = 照搬 ST（只用当前发言者的世界书）；
   * true  = 并集去重所有成员的世界书。
   */
  mergeMemberBooks: boolean
  /** 自研：本群聊的角色状态字段覆盖与初始状态（types/status.ts） */
  status?: GroupStatusConfig
  /** 群聊封面（横版 3:2），blobs 表 id */
  avatarBlobId?: string
  /** 封面的深度图（视差），blobs 表 id。换封面时清空重算 */
  depthBlobId?: string
  createdAt: number
  updatedAt: number
}

export const DEFAULT_RELATION_TEMPLATE = '{{from}} 对 {{to}}：{{label}}'

export function emptyGroup(id: string, name = '新群聊'): Group {
  const now = Date.now()
  return {
    id,
    name,
    members: [],
    disabled_members: [],
    activation_strategy: group_activation_strategy.NATURAL,
    generation_mode: group_generation_mode.SWAP,
    generation_mode_join_prefix: '',
    generation_mode_join_suffix: '',
    auto_mode_delay: DEFAULT_AUTO_MODE_DELAY,
    allow_self_responses: false,
    fav: false,
    relations: [],
    layout: {},
    relationTemplate: DEFAULT_RELATION_TEMPLATE,
    persona: { name: '', description: '' },
    mergeMemberBooks: false,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 解析本轮实际生效的用户身份：群聊级覆盖优先，否则回落到全局人设。
 *
 * 用 `|| fallback` 而不是 `?? fallback`：空串也要回落。否则用户把名字清空后
 * `{{user}}` 会渲染成空，提示词里出现「 对 她：师徒」这种断头行。
 */
export function resolvePersona(
  g: Group | undefined,
  fallback: { name: string; description: string },
): { name: string; description: string } {
  return {
    name: g?.persona?.name?.trim() || fallback.name,
    description: g?.persona?.description?.trim() || fallback.description,
  }
}

export function enabledMembers(g: Group): string[] {
  return g.members.filter((m) => !g.disabled_members.includes(m))
}
