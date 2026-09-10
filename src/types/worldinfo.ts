/**
 * 世界书（World Info / Lorebook）类型 —— 完整对齐 SillyTavern v1.18.0。
 *
 * 字段名与数值**必须**与 ST 一致，社区世界书才能零转换互导。
 * 权威来源：SillyTavern/public/scripts/world-info.js
 *   - 枚举 L27/L33/L43/L855
 *   - 条目 schema L4002 newWorldInfoEntryDefinition
 *
 * 数值枚举一律用 `as const` 对象 + 派生 union，不用 `enum`（isolatedModules 友好）。
 */

export const world_info_logic = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 } as const
export type WorldInfoLogic = (typeof world_info_logic)[keyof typeof world_info_logic]

export const world_info_position = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
} as const
export type WorldInfoPosition = (typeof world_info_position)[keyof typeof world_info_position]

export const wi_anchor_position = { before: 0, after: 1 } as const
export type WiAnchorPosition = (typeof wi_anchor_position)[keyof typeof wi_anchor_position]

/** 扫描状态机。NONE=0 是主循环 `while (scanState)` 的终止条件 */
export const scan_state = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 } as const
export type ScanState = (typeof scan_state)[keyof typeof scan_state]

export const world_info_insertion_strategy = {
  evenly: 0,
  character_first: 1,
  global_first: 2,
} as const
export type WorldInfoInsertionStrategy =
  (typeof world_info_insertion_strategy)[keyof typeof world_info_insertion_strategy]

export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 } as const
export type ExtensionPromptRole = 0 | 1 | 2

export const GENERATION_TYPE_TRIGGERS = [
  'normal',
  'continue',
  'impersonate',
  'swipe',
  'regenerate',
  'quiet',
] as const
export type GenerationTrigger = (typeof GENERATION_TYPE_TRIGGERS)[number]

export const DEFAULT_DEPTH = 4
export const DEFAULT_WEIGHT = 100
export const MAX_SCAN_DEPTH = 1000
export const MAX_UID = 1_000_000
export const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'] as const

export interface CharacterFilter {
  isExclude: boolean
  names: string[]
  tags: string[]
}

/**
 * 与 ST `newWorldInfoEntryDefinition` 一一对应（40 字段）。
 *
 * ⚠️ `scanDepth` / `caseSensitive` / `matchWholeWords` / `useGroupScoring` /
 * `sticky` / `cooldown` / `delay` 的 `null` 是**三态语义**：null = 继承全局设置，
 * 与 false / 0 完全不同。任何把 null 折叠成 false/0 的写法都会破坏「继承全局」
 * 并污染导出的 ST 世界书。
 */
export interface WorldInfoEntry {
  uid: number
  /** 主关键词。元素可以是明文，也可以是 `/pattern/flags` 正则字面量 */
  key: string[]
  /** 次关键词，配合 selectiveLogic 使用 */
  keysecondary: string[]
  /** 条目标题 / 备注，不进提示词 */
  comment: string
  /** 注入提示词的正文 */
  content: string
  /** 蓝灯：无视关键词恒定激活 */
  constant: boolean
  /** 向量化检索标记。本项目只存储与往返，不实现向量检索 */
  vectorized: boolean
  /** 死字段（ST 中恒为 true 且 UI 隐藏），只做往返兼容，永不分支 */
  selective: boolean
  selectiveLogic: WorldInfoLogic
  /** 死字段，只做往返兼容 */
  addMemo: boolean
  /** 默认 100。排序为**降序**（大的先插入） */
  order: number
  position: WorldInfoPosition
  disable: boolean
  /** 无视 token 预算 */
  ignoreBudget: boolean
  /** 递归轮次中不可被激活 */
  excludeRecursion: boolean
  /** 自身内容不喂给递归缓冲 */
  preventRecursion: boolean
  // ── 额外扫描源开关：把这些卡片字段也纳入关键词匹配的干草堆 ──
  matchPersonaDescription: boolean
  matchCharacterDescription: boolean
  matchCharacterPersonality: boolean
  matchCharacterDepthPrompt: boolean
  matchScenario: boolean
  matchCreatorNotes: boolean
  /** 延迟到第 N 轮递归才可激活。ST 允许 true，导入时规范化为 1 */
  delayUntilRecursion: number
  /** 0-100 */
  probability: number
  useProbability: boolean
  /** 仅 position === atDepth 有意义 */
  depth: number
  /** 仅 position === outlet 有意义 */
  outletName: string
  /** 包含组，逗号分隔可属多组。同组条目竞争，只有一个胜出 */
  group: string
  groupOverride: boolean
  groupWeight: number
  // ── 三态：null = 继承全局 ──
  scanDepth: number | null
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  useGroupScoring: boolean | null
  automationId: string
  role: ExtensionPromptRole
  /** 触发后连续保持激活 N 条消息 */
  sticky: number | null
  /** 失活后冷却 N 条消息内不可再激活 */
  cooldown: number | null
  /** 从会话开始起 N 条消息内不可激活 */
  delay: number | null
  characterFilter: CharacterFilter
  /** 限定生成类型；空数组 = 不限 */
  triggers: GenerationTrigger[]
  /** 列表拖拽排序用，不参与算法 */
  displayIndex?: number
}

export const DEFAULT_WI_ENTRY: Omit<WorldInfoEntry, 'uid'> = {
  key: [],
  keysecondary: [],
  comment: '',
  content: '',
  constant: false,
  vectorized: false,
  selective: true,
  selectiveLogic: world_info_logic.AND_ANY,
  addMemo: false,
  order: 100,
  position: world_info_position.before,
  disable: false,
  ignoreBudget: false,
  excludeRecursion: false,
  preventRecursion: false,
  matchPersonaDescription: false,
  matchCharacterDescription: false,
  matchCharacterPersonality: false,
  matchCharacterDepthPrompt: false,
  matchScenario: false,
  matchCreatorNotes: false,
  delayUntilRecursion: 0,
  probability: 100,
  useProbability: true,
  depth: DEFAULT_DEPTH,
  outletName: '',
  group: '',
  groupOverride: false,
  groupWeight: DEFAULT_WEIGHT,
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: null,
  useGroupScoring: null,
  automationId: '',
  role: extension_prompt_roles.SYSTEM,
  sticky: null,
  cooldown: null,
  delay: null,
  characterFilter: { isExclude: false, names: [], tags: [] },
  triggers: [],
}

/**
 * 落库形态与 ST 文件格式同构：entries 是 uid 字符串键的对象（不是数组），
 * 因此导入导出几乎零转换。
 */
export interface WorldBook {
  id: string
  name: string
  description: string
  entries: Record<string, WorldInfoEntry>
  createdAt: number
  updatedAt: number
}

/** 扫描运行态（不落库）。引擎内部只见 ResolvedEntry */
export interface ResolvedEntry extends WorldInfoEntry {
  /** 书 id（ST 用书名；我们用 id，导出时映射回书名） */
  world: string
  worldName: string
  /** 定时效果的身份标识；内容变更即失效，与 ST 语义一致 */
  hash: number
  /** 从 content 头部解析出的 @@decorator 行 */
  decorators: string[]
}

/** 对齐 ST getFreeWorldEntryUid：最小未占用非负整数 */
export function nextEntryUid(entries: Record<string, WorldInfoEntry>): number {
  for (let uid = 0; uid < MAX_UID; uid++) {
    if (!(String(uid) in entries)) return uid
  }
  throw new Error('世界书条目数已达上限')
}

export function createEntry(entries: Record<string, WorldInfoEntry>): WorldInfoEntry {
  return { uid: nextEntryUid(entries), ...structuredClone(DEFAULT_WI_ENTRY) }
}
