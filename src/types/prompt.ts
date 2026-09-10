import { extension_prompt_roles, type ExtensionPromptRole } from './worldinfo'

export type PromptRole = 'system' | 'user' | 'assistant'

/** 注入位置。对齐 ST extension_prompt_types */
export const EXT_POSITION = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 } as const
export type ExtPosition = (typeof EXT_POSITION)[keyof typeof EXT_POSITION]

export const EXT_ROLE = extension_prompt_roles
export const DEFAULT_ORDER = 100

export interface PromptMessage {
  role: PromptRole
  content: string
  /** example_user / example_assistant */
  name?: string
  /** 标记为注入产生的伪消息 */
  injected?: boolean
  /** 调试面板分组标识：main / wiBefore / charDescription / chatHistory / … */
  source?: string
}

/**
 * 注入注册表条目。
 *
 * 替代 ST 的全局可变 `extension_prompts` —— 这里**每次生成重新构建**，
 * 从根上消除「上一轮的陈旧注入泄漏到下一轮」那一整类 bug
 * （ST 要靠 flushWIInjections/removeDepthPrompts 一堆前缀扫描删除来打补丁）。
 */
export interface Injection {
  key: string
  value: string
  position: ExtPosition
  depth: number
  role: ExtensionPromptRole
  /** 该文本是否参与世界书扫描 */
  scan: boolean
  /**
   * 替代 ST 的「按 key 字典序排」（那是 1_memory/2_floating_prompt 这种
   * 数字前缀 hack 的历史产物）。显式数字优先级，越大越贴近回复。
   */
  order: number
  filter?: () => boolean
}

export function makeInjection(p: Partial<Injection> & { key: string; value: string }): Injection {
  return {
    position: EXT_POSITION.IN_CHAT,
    depth: 0,
    role: EXT_ROLE.SYSTEM,
    scan: false,
    order: DEFAULT_ORDER,
    ...p,
  }
}
