/**
 * 宏求值环境。所有取值都是**显式参数**，不依赖任何全局可变状态
 * （ST 靠全局 name2 + setCharacterName('')，这正是「生成之外 {{char}} 为空」那个坑的来源）。
 */

export interface MacroCardFields {
  description: string
  personality: string
  scenario: string
  mesExample: string
  creatorNotes: string
  systemPrompt: string
  postHistoryInstructions: string
  characterVersion: string
  depthPrompt: string
  firstMes: string
  alternateGreetings: string[]
}

export interface MacroVarsApi {
  getLocal(name: string): string
  setLocal(name: string, value: string): void
  hasLocal(name: string): boolean
  delLocal(name: string): void
  getGlobal(name: string): string
  setGlobal(name: string, value: string): void
  hasGlobal(name: string): boolean
  delGlobal(name: string): void
}

export interface MacroMessageLite {
  name: string
  mes: string
  isUser: boolean
  isSystem: boolean
}

export interface MacroEnv {
  /** 用户名（人设名） */
  user: string
  /** 1v1 = 角色名；**1vN = 本轮当前发言者** */
  char: string
  /** 全体成员名（含静音）。1v1 = [char] */
  groupMembers: string[]
  /** 静音成员名 */
  mutedMembers: string[]
  /** 当前发言者的卡片字段（1vN SWAP 语义） */
  card: MacroCardFields
  persona: string
  /** 已渲染的关系图谱文本（1vN），供 {{relations}} */
  relations: string
  chatId: string
  chatIdHash: number
  /** 本次求值输入原文的 hash，{{pick}} 稳定性用 */
  contentHash: number
  pickRerollSeed?: number
  /** 旧→新时序 */
  messages: MacroMessageLite[]
  model: string
  maxContext: number
  maxResponse: number
  /** 输入框当前文本，{{input}} 用 */
  input: string
  lastMessageAt?: number
  /** {{original}}，一次性 */
  original?: string
  originalUsed: { value: boolean }
  vars: MacroVarsApi
  /** 世界书 outlet 桶（已 join('\n')） */
  outlets: Record<string, string>
  /**
   * 递归护栏：展开卡片字段本身时置 false，卡片字段类宏会 fail-open 返回原样，
   * 从而一张写了 {{description}} 的卡片不会无限展开。
   * 注意 {{char}}/{{user}} 在这一层**仍要正常展开**（卡片正文里大量使用）。
   */
  replaceCharacterCard: boolean
}

export function emptyCardFields(): MacroCardFields {
  return {
    description: '',
    personality: '',
    scenario: '',
    mesExample: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    characterVersion: '',
    depthPrompt: '',
    firstMes: '',
    alternateGreetings: [],
  }
}

/** 内存变量实现（局部变量落在 ChatMeta.variables，全局落 settings） */
export function makeVarsApi(
  local: Record<string, string>,
  global: Record<string, string>,
): MacroVarsApi {
  return {
    getLocal: (n) => local[n] ?? '',
    setLocal: (n, v) => {
      local[n] = v
    },
    hasLocal: (n) => n in local,
    delLocal: (n) => {
      delete local[n]
    },
    getGlobal: (n) => global[n] ?? '',
    setGlobal: (n, v) => {
      global[n] = v
    },
    hasGlobal: (n) => n in global,
    delGlobal: (n) => {
      delete global[n]
    },
  }
}

// ── 派生名称 ──
export function groupNames(env: MacroEnv): string {
  return env.groupMembers.join(', ')
}
export function groupNotMutedNames(env: MacroEnv): string {
  return env.groupMembers.filter((n) => !env.mutedMembers.includes(n)).join(', ')
}
export function notCharNames(env: MacroEnv): string {
  const others = env.groupMembers.filter((n) => n !== env.char)
  return [...others, env.user].filter(Boolean).join(', ')
}
