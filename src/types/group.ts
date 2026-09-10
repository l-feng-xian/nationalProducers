/**
 * 群聊（1vN）类型 —— 对齐 SillyTavern group-chats.js，外加自研的**角色关系图谱**。
 *
 * 枚举数值权威来源：SillyTavern/public/scripts/group-chats.js L122 / L129
 */

export const group_activation_strategy = { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 } as const
export type GroupActivationStrategy =
  (typeof group_activation_strategy)[keyof typeof group_activation_strategy]

export const group_generation_mode = { SWAP: 0, APPEND: 1, APPEND_DISABLED: 2 } as const
export type GroupGenerationMode = (typeof group_generation_mode)[keyof typeof group_generation_mode]

export const DEFAULT_AUTO_MODE_DELAY = 5

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
  /**
   * false = 照搬 ST（只用当前发言者的世界书）；
   * true  = 并集去重所有成员的世界书。
   */
  mergeMemberBooks: boolean
  avatarBlobId?: string
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
    mergeMemberBooks: false,
    createdAt: now,
    updatedAt: now,
  }
}

export function enabledMembers(g: Group): string[] {
  return g.members.filter((m) => !g.disabled_members.includes(m))
}
