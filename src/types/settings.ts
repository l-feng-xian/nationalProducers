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

/**
 * 会话记忆设置。
 *
 * 一期只有状态卡（每 N 条消息让模型整体重写一次的现在时快照）。
 * 向量召回是二期，届时在这里加 `vector.*`。
 */
export interface MemorySettings {
  enabled: boolean
  /** 距上次提炼新增多少条消息才触发一次。约等于每 intervalMessages/2 轮往返 */
  intervalMessages: number
  /** 新对话不足这么多字符就跳过本次提炼，防「连发三个『嗯』就烧一次 API」 */
  minNewChars: number
  /** 喂给提炼器的新对话字符上限，**从尾部截断**（保留最新的）。提炼成本的大头 */
  dialogueCharLimit: number
  /** 状态卡的深度注入位置。2 = 注入后仍有 2 条真实消息，贴近回复且不破坏前缀缓存 */
  depth: number
  /** 向量召回。没选模型时一个字节都不会下载 */
  vector: {
    /**
     * 启用哪个嵌入模型，空串 = 不启用向量召回。
     *
     * 刻意**不再单独设一个 enabled 开关**：一个「开关」加一个「选哪个模型」会产生
     * 「开着但没选」「选了但关着」两种没有意义的状态，UI 还得替它们各编一句解释。
     * 选中即启用，取消选中即停用 —— 只有一处真相。
     *
     * 值是 EMBED_PRESETS 里的 id。模型未下载时选不中（模型管理页会禁用），
     * 即使被手改成没下载的 id，推理侧也只会静默不召回而不会去联网。
     */
    modelId: string
    /** 召回几条 */
    topK: number
    /** 相似度下限。见 search.ts 里 minScore 的实测说明 */
    minScore: number
    /** 召回片段的注入深度。比状态卡(2)靠前，因为它是「曾经」不是「此刻」 */
    recallDepth: number
    /** 用最近几条消息作为查询 */
    queryWindow: number
    /** 首次回填只做最近这么多条；全历史给显式按钮 */
    backfillLimit: number
  }
  /**
   * 提炼专用模型，空 = 沿用主对话模型。
   * 主聊用推理模型时把提炼切到普通模型能省一半以上成本。
   */
  model: string
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

/**
 * 立绘深度视差。
 *
 * 与向量召回同一套语义：**选中即启用，空串即停用**，只有一处真相。
 * 启用后，上传角色图片时会顺带生成深度图（实测约 3 秒）并永久缓存；
 * 没启用就一个字节都不下载、也不会产生任何额外耗时。
 */
export interface DepthSettings {
  /** DEPTH_PRESETS 里的 id，空 = 不启用 */
  modelId: string
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
  memory: MemorySettings
  depth: DepthSettings
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
    memory: {
      enabled: false,
      intervalMessages: 12,
      minNewChars: 40,
      dialogueCharLimit: 3000,
      depth: 2,
      model: '',
      vector: {
        modelId: '',
        topK: 3,
        minScore: 0.4,
        recallDepth: 6,
        queryWindow: 2,
        backfillLimit: 400,
      },
    },
    depth: { modelId: '' },
    constraint: {
      solo: { enabled: true, text: DEFAULT_SOLO_CONSTRAINT, depth: 0, role: 0, order: 200 },
      group: { enabled: true, text: DEFAULT_GROUP_CONSTRAINT, depth: 0, role: 0, order: 200 },
    },
    chat: { streamFlushMs: 100, sendOnEnter: true, showTokens: false },
    updatedAt: Date.now(),
  }
}
