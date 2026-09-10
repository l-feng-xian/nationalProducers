/**
 * 全局配置。需求 4 的双模式约束提示词与插入深度在 `Settings.constraint`。
 */

import { world_info_insertion_strategy } from './worldinfo'

export type ChatMode = 'solo' | 'group'

/**
 * 需求 4：1v1 / 1vN 各一套约束提示词，各自可配插入深度（默认 0）。
 *
 * depth N 的语义 = 注入之后仍有 N 条真实消息在其后；
 * depth 0 = 追加到历史最末，作为**独立的一条 message**。
 */
export interface ConstraintPromptConfig {
  enabled: boolean
  /** 支持宏：{{user}} {{char}} {{group}} {{groupNotMuted}} {{notChar}} {{relations}} */
  text: string
  depth: number
  role: 0 | 1 | 2
  /** 同 depth 多来源的排序，越大越贴近模型回复（世界书用 100，约束提示词默认 200） */
  order: number
}

export interface ProviderSettings {
  /** 例 https://api.deepseek.com/v1 */
  baseUrl: string
  model: string
  /** secrets store 的 ref，不直接存 key */
  secretRef: string
  /** 代理前缀。空 = 直连；开发期可填 /llm 走 vite proxy */
  proxyPrefix: string
  stream: boolean
  temperature: number
  maxTokens: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  stop: string[]
  contextWindow: number
  extraHeaders: Record<string, string>
  modelCache?: { at: number; ids: string[] }
}

/** 与 ST 全局世界书设置一一对应（world-info.js L69-82） */
export interface WorldInfoSettings {
  world_info_depth: number
  world_info_min_activations: number
  world_info_min_activations_depth_max: number
  /** 占 maxContext 的百分比 */
  world_info_budget: number
  /** 绝对 token 上限，0 = 无上限 */
  world_info_budget_cap: number
  world_info_include_names: boolean
  world_info_recursive: boolean
  world_info_max_recursion_steps: number
  world_info_overflow_alert: boolean
  world_info_case_sensitive: boolean
  world_info_match_whole_words: boolean
  world_info_use_group_scoring: boolean
  world_info_character_strategy: 0 | 1 | 2
  /** 需求 5：全局世界书只在全局配置中启用 */
  globalBookIds: string[]
}

export interface PersonaSettings {
  /** {{user}} 的值 */
  name: string
  description: string
  avatarBlobId?: string
  /** 0=IN_PROMPT 2=TOP_AN 3=BOTTOM_AN 4=AT_DEPTH 9=NONE */
  position: 0 | 2 | 3 | 4 | 9
  depth: number
  role: 0 | 1 | 2
  worldBookId?: string
}

export interface PromptSettings {
  mainPrompt: string
  squashSystemMessages: boolean
  newChatPrompt: string
  newGroupChatPrompt: string
  groupNudge: string
  exampleChatMarker: string
  /** 世界书注入的包装格式，{0} 是占位 */
  wiFormat: string
  pinExamples: boolean
  /** 每条消息的固定 token 开销估算 */
  perMessageTokens: number
}

export interface Settings {
  id: 'app'
  schemaVersion: number
  theme: 'light' | 'dark' | 'system'
  provider: ProviderSettings
  worldInfo: WorldInfoSettings
  persona: PersonaSettings
  prompt: PromptSettings
  /** 需求 4 核心 */
  constraint: Record<ChatMode, ConstraintPromptConfig>
  chat: { streamFlushMs: number; sendOnEnter: boolean; showTokens: boolean }
  updatedAt: number
}

export const DEFAULT_SOLO_CONSTRAINT =
  '[你正在扮演 {{char}}。始终以 {{char}} 的身份、语气与性格回应 {{user}}；不要跳出角色，不要代替 {{user}} 发言，不要输出解释性旁白。]'

export const DEFAULT_GROUP_CONSTRAINT = `[本场景为多人对话，参与者：{{group}}。本轮只以 {{char}} 的身份发言，不要替 {{notChar}} 说话。
角色之间的关系如下：
{{relations}}
请让 {{char}} 的态度与措辞符合上述关系。]`

export const DEFAULT_MAIN_PROMPT =
  '请以沉浸式角色扮演的方式续写对话。保持角色一致性，输出自然、有细节的中文回应。'

export function defaultSettings(): Settings {
  return {
    id: 'app',
    schemaVersion: 1,
    theme: 'system',
    provider: {
      baseUrl: '',
      model: '',
      secretRef: 'default',
      proxyPrefix: '',
      stream: true,
      temperature: 0.9,
      maxTokens: 1024,
      stop: [],
      contextWindow: 16384,
      extraHeaders: {},
    },
    worldInfo: {
      world_info_depth: 2,
      world_info_min_activations: 0,
      world_info_min_activations_depth_max: 0,
      world_info_budget: 25,
      world_info_budget_cap: 0,
      world_info_include_names: true,
      world_info_recursive: false,
      world_info_max_recursion_steps: 0,
      world_info_overflow_alert: false,
      world_info_case_sensitive: false,
      world_info_match_whole_words: false,
      world_info_use_group_scoring: false,
      world_info_character_strategy: world_info_insertion_strategy.character_first,
      globalBookIds: [],
    },
    persona: {
      name: '我',
      description: '',
      position: 0,
      depth: 2,
      role: 0,
    },
    prompt: {
      mainPrompt: DEFAULT_MAIN_PROMPT,
      squashSystemMessages: true,
      newChatPrompt: '[开始新的对话]',
      newGroupChatPrompt: '[开始新的多人对话。参与者：{{group}}]',
      groupNudge: '[接下来只以 {{char}} 的身份写下一条回复。]',
      exampleChatMarker: '[对话示例]',
      wiFormat: '{0}',
      pinExamples: false,
      perMessageTokens: 16,
    },
    constraint: {
      solo: { enabled: true, text: DEFAULT_SOLO_CONSTRAINT, depth: 0, role: 0, order: 200 },
      group: { enabled: true, text: DEFAULT_GROUP_CONSTRAINT, depth: 0, role: 0, order: 200 },
    },
    chat: { streamFlushMs: 100, sendOnEnter: true, showTokens: false },
    updatedAt: Date.now(),
  }
}
