/**
 * 提示词组装。输出可直接发给 OpenAI 兼容接口的 messages 数组。
 *
 * 最终顺序（自上而下）：
 *   1  main（全局系统提示词）
 *   2  charSystem（角色卡 system_prompt 覆盖）
 *   3  worldInfoBefore        ← 世界书 position 0
 *   4  charDescription
 *   5  charPersonality
 *   6  scenario
 *   7  worldInfoAfter         ← 世界书 position 1
 *   8  personaDescription
 *   9  [1vN] 其余成员简介块
 *   10 对话示例（EMTop → 卡片 → EMBottom）
 *   11 [开始新的对话] 标记
 *   12 聊天历史（深度注入已 splice 其中）
 *   13 [1vN] group nudge
 *   14 postHistoryInstructions（PHI / 越狱）
 */

import { estimateTokens, type TokenCounter } from '../tokens'
import { fnv1a } from '../hash'
import { baseChatReplace, evaluateMacros } from '../macro/engine'
import { emptyCardFields, makeVarsApi, type MacroEnv } from '../macro/env'
import { injectAtDepths, materializeInjections } from './depth'
import { fitWithinBudget } from './budget'
import { exampleBlockToMessages, parseMesExamples, type ExampleNames } from './examples'
import { renderRelations } from './relations'
import { checkWorldInfo } from '../worldinfo/engine'
import { resolveSortedEntries, type LoreSources } from '../worldinfo/sources'
import type { WIScanResult } from '../worldinfo/engine'
import {
  DEFAULT_ORDER,
  EXT_POSITION,
  EXT_ROLE,
  makeInjection,
  type Injection,
  type PromptMessage,
} from '@/types/prompt'
import type { Character } from '@/types/character'
import type { ChatMessage, TimedWorldInfo } from '@/types/chat'
import type { GroupRelation } from '@/types/group'
import type { Settings } from '@/types/settings'
import type { GenerationTrigger } from '@/types/worldinfo'

/** 参与本轮生成的角色（1v1 即唯一角色；1vN 为当前发言者） */
export interface SpeakerLite {
  id: string
  name: string
  char: Character
}

export interface BuildPromptInput {
  isGroup: boolean
  speaker: SpeakerLite
  /** 1vN 全体成员（含静音）；1v1 = [speaker] */
  members: SpeakerLite[]
  mutedIds: string[]
  settings: Settings
  /** 旧→新时序 */
  history: ChatMessage[]
  chatId: string
  chatIdHash: number
  /** 会话级变量，会被 {{setvar}} 就地修改 */
  variables: Record<string, string>
  relations?: GroupRelation[]
  relationTemplate?: string
  isContinue?: boolean
  trigger?: GenerationTrigger
  /** 输入框当前文本，供 {{input}} */
  composerText?: string
  count?: TokenCounter
  // ── 世界书（需求 5） ──
  /** 本轮生效的世界书来源；不传则跳过扫描 */
  loreSources?: LoreSources
  /** 定时效果状态，就地修改。dryRun 时调用方需传克隆副本 */
  timedStore?: TimedWorldInfo
  /** 提示词预览等场景置 true：不推进 sticky/cooldown */
  isDryRun?: boolean
}

export interface BuiltPrompt {
  messages: { role: 'system' | 'user' | 'assistant'; content: string; name?: string }[]
  debug: {
    sections: PromptMessage[]
    injections: Injection[]
    tokens: number
    reserved: number
    droppedHistory: number
    droppedExamples: number
    worldInfo: WIScanResult
  }
}

/** wi_anchor_position.before */
const WI_ANCHOR_BEFORE = 0

function cardFieldsOf(c: Character) {
  const f = emptyCardFields()
  f.description = c.data.description
  f.personality = c.data.personality
  f.scenario = c.data.scenario
  f.mesExample = c.data.mes_example
  f.creatorNotes = c.data.creator_notes
  f.systemPrompt = c.data.system_prompt
  f.postHistoryInstructions = c.data.post_history_instructions
  f.characterVersion = c.data.character_version
  f.depthPrompt = c.data.extensions.depth_prompt?.prompt ?? ''
  f.firstMes = c.data.first_mes
  f.alternateGreetings = c.data.alternate_greetings
  return f
}

function roleByName(r: string): 0 | 1 | 2 {
  return r === 'user' ? EXT_ROLE.USER : r === 'assistant' ? EXT_ROLE.ASSISTANT : EXT_ROLE.SYSTEM
}

/** 构建宏求值环境 */
export function buildMacroEnv(input: BuildPromptInput, relationsText: string): MacroEnv {
  const s = input.settings
  return {
    user: s.persona.name,
    char: input.speaker.name,
    groupMembers: input.members.map((m) => m.name),
    mutedMembers: input.members.filter((m) => input.mutedIds.includes(m.id)).map((m) => m.name),
    card: cardFieldsOf(input.speaker.char),
    persona: s.persona.description,
    relations: relationsText,
    chatId: input.chatId,
    chatIdHash: input.chatIdHash,
    contentHash: 0,
    messages: input.history.map((m) => ({
      name: m.name,
      mes: m.mes,
      isUser: m.is_user,
      isSystem: m.is_system,
    })),
    model: s.provider.model,
    maxContext: s.provider.contextWindow,
    maxResponse: s.provider.maxTokens,
    input: input.composerText ?? '',
    lastMessageAt: input.history[input.history.length - 1]?.send_date,
    originalUsed: { value: false },
    vars: makeVarsApi(input.variables, {}),
    outlets: {},
    replaceCharacterCard: true,
  }
}

export function buildChatPrompt(input: BuildPromptInput): BuiltPrompt {
  const s = input.settings
  const count = input.count ?? estimateTokens

  // ── 1. 关系图谱文本（1vN），供 {{relations}} ──
  const nameOf = new Map(input.members.map((m) => [m.id, m.name]))
  const relationsText = input.relations?.length
    ? renderRelations({
        relations: input.relations,
        nameOf,
        template: input.relationTemplate ?? '{{from}} 对 {{to}}：{{label}}',
      })
    : ''

  const env = buildMacroEnv(input, relationsText)
  const sub = (t: string) => evaluateMacros(t, { ...env, contentHash: fnv1a(t) })
  const base = (t: string) => baseChatReplace(t, { ...env, contentHash: fnv1a(t) })

  // ── 2. 卡片字段（1vN SWAP 语义：只用当前发言者的卡） ──
  const c = input.speaker.char
  const card = {
    description: base(c.data.description),
    personality: base(c.data.personality),
    scenario: base(c.data.scenario),
    mesExample: base(c.data.mes_example),
    persona: base(s.persona.description),
    systemPrompt: base(c.data.system_prompt),
    postHistory: base(c.data.post_history_instructions),
    depthPrompt: base(c.data.extensions.depth_prompt?.prompt ?? ''),
  }

  // ── 3. 世界书扫描（需求 5） ──
  const wi = runWorldInfo(input, card, sub, count)
  // outlet 桶回填进宏环境，{{outlet::key}} 此时才可用
  for (const [k, v] of Object.entries(wi.outletEntries)) env.outlets[k] = v.join('\n')

  // ── 4. 注入注册表（每次生成重建，杜绝陈旧注入） ──
  const injections: Injection[] = []

  // 4a. 世界书 atDepth：一个 (depth, role) 一条
  for (const e of wi.depthEntries) {
    injections.push(
      makeInjection({
        key: `customDepthWI_${e.depth}_${e.role}`,
        value: e.entries.join('\n'),
        depth: e.depth,
        role: e.role,
        order: DEFAULT_ORDER,
        scan: false, // 世界书不能再扫自己
      }),
    )
  }
  // 4b. 世界书 ANTop/ANBottom（本项目无独立作者注释功能，落在其默认深度 4）
  const anText = [...wi.anTop, ...wi.anBottom].filter((s) => s.trim()).join('\n')
  if (anText) {
    injections.push(
      makeInjection({ key: '2_authors_note', value: anText, depth: 4, order: DEFAULT_ORDER }),
    )
  }

  // 3a. 角色深度提示词（卡片 depth_prompt）
  if (card.depthPrompt.trim()) {
    const dp = c.data.extensions.depth_prompt
    injections.push(
      makeInjection({
        key: 'DEPTH_PROMPT',
        value: card.depthPrompt,
        depth: dp?.depth ?? 4,
        role: roleByName(dp?.role ?? 'system'),
        order: DEFAULT_ORDER,
        scan: true,
      }),
    )
  }

  // 3b. 需求 4：双模式约束提示词。注册成一条普通深度注入，零特例代码。
  const cfg = input.isGroup ? s.constraint.group : s.constraint.solo
  if (cfg.enabled) {
    const text = sub(cfg.text).trim()
    if (text) {
      injections.push(
        makeInjection({
          key: 'CONSTRAINT',
          value: text,
          depth: cfg.depth,
          role: cfg.role,
          order: cfg.order, // 默认 200，高于世界书的 100 → 更贴近回复
          scan: false,
        }),
      )
    }
  }

  // ── 4. 固定块（顺序即最终输出顺序） ──
  const S = (content: string, source: string): PromptMessage[] =>
    content.trim() ? [{ role: 'system', content: content.trim(), source }] : []

  const fmtWI = (t: string) => (t && s.prompt.wiFormat ? s.prompt.wiFormat.replace('{0}', t) : t)

  const mandatory: PromptMessage[] = [
    ...S(sub(s.prompt.mainPrompt), 'main'),
    ...S(card.systemPrompt, 'charSystem'),
    ...S(fmtWI(wi.worldInfoBefore), 'worldInfoBefore'),
    ...S(card.description, 'charDescription'),
    ...S(card.personality, 'charPersonality'),
    ...S(card.scenario, 'scenario'),
    ...S(fmtWI(wi.worldInfoAfter), 'worldInfoAfter'),
    ...S(card.persona, 'personaDescription'),
  ]

  // ── 5. 对话示例 ──
  const names: ExampleNames = {
    user: env.user,
    char: env.char,
    members: input.members.map((m) => m.name),
    isGroup: input.isGroup,
  }
  const blocks: PromptMessage[][] = []
  const pushBlocks = (raw: string) => {
    for (const b of parseMesExamples(raw)) {
      blocks.push([
        { role: 'system', content: sub(s.prompt.exampleChatMarker), source: 'dialogueExamples' },
        ...exampleBlockToMessages(b, names),
      ])
    }
  }
  // 世界书 EMTop 夹在卡片示例之前，EMBottom 在之后
  for (const em of wi.emEntries) if (em.position === WI_ANCHOR_BEFORE) pushBlocks(em.content)
  pushBlocks(card.mesExample)
  for (const em of wi.emEntries) if (em.position !== WI_ANCHOR_BEFORE) pushBlocks(em.content)

  // ── 6. 真实历史 ──
  const history: PromptMessage[] = input.history
    .filter((m) => !m.is_system && !m.exclude)
    .map((m) => ({
      role: m.is_user ? ('user' as const) : ('assistant' as const),
      // 1vN 里 AI 消息前缀发言者名，模型才知道是谁说的
      content: input.isGroup && !m.is_user ? `${m.name}: ${m.mes}` : m.mes,
      source: 'chatHistory',
    }))

  // ── 7. 预算：注入先预留，再填历史 ──
  const injectedPreview = materializeInjections(injections, { isContinue: input.isContinue })
  const newChatMarker: PromptMessage = {
    role: 'system',
    content: sub(input.isGroup ? s.prompt.newGroupChatPrompt : s.prompt.newChatPrompt),
    source: 'newChat',
  }
  const groupNudge: PromptMessage[] =
    input.isGroup && input.trigger !== 'impersonate'
      ? [{ role: 'system', content: sub(s.prompt.groupNudge), source: 'groupNudge' }]
      : []
  const phi: PromptMessage[] = card.postHistory.trim()
    ? [{ role: 'system', content: card.postHistory.trim(), source: 'jailbreak' }]
    : []

  const budget = Math.max(512, s.provider.contextWindow - s.provider.maxTokens - 8)
  const fit = fitWithinBudget({
    mandatory: [...mandatory, newChatMarker, ...groupNudge, ...phi],
    injected: injectedPreview,
    history,
    exampleBlocks: blocks,
    budget,
    count,
    pinExamples: s.prompt.pinExamples,
    perMessage: s.prompt.perMessageTokens,
  })

  // ── 8. 装配：注入在**裁剪后**的历史上做 splice ──
  const withInjections = injectAtDepths(fit.history, injections, {
    isContinue: input.isContinue,
  })

  const all: PromptMessage[] = [
    ...mandatory,
    ...fit.examples,
    ...(newChatMarker.content.trim() ? [newChatMarker] : []),
    ...withInjections,
    ...groupNudge, // group nudge 永远在最末，压过 depth-0 注入
    ...phi,
  ]

  const final = s.prompt.squashSystemMessages ? squashSystem(all) : all

  return {
    messages: final.map(({ role, content, name }) =>
      name ? { role, content, name } : { role, content },
    ),
    debug: {
      sections: all,
      injections,
      tokens: final.reduce((t, m) => t + count(m.content) + s.prompt.perMessageTokens, 0),
      reserved: fit.reserved,
      droppedHistory: fit.droppedHistory,
      droppedExamples: fit.droppedExamples,
      worldInfo: wi,
    },
  }
}

/** 跑世界书扫描；未提供来源时返回空结果 */
function runWorldInfo(
  input: BuildPromptInput,
  card: {
    description: string
    personality: string
    scenario: string
    persona: string
    depthPrompt: string
  },
  sub: (t: string) => string,
  count: TokenCounter,
): WIScanResult {
  const s = input.settings
  const empty: WIScanResult = {
    worldInfoBefore: '',
    worldInfoAfter: '',
    emEntries: [],
    anTop: [],
    anBottom: [],
    depthEntries: [],
    outletEntries: {},
    allActivatedEntries: [],
    budget: 0,
    budgetOverflowed: false,
  }
  if (!input.loreSources) return empty

  const sorted = resolveSortedEntries(input.loreSources, s.worldInfo.world_info_character_strategy)
  if (!sorted.length) return empty

  // 新→旧倒序；includeNames 时前缀发言者名
  const scannable = input.history.filter((m) => !m.is_system && !m.exclude)
  const chatForWI = scannable
    .map((m) => (s.worldInfo.world_info_include_names ? `${m.name}: ${m.mes}` : m.mes))
    .reverse()

  return checkWorldInfo({
    chat: chatForWI,
    // 定时效果时钟：参与提示词的非系统消息条数
    chatLength: scannable.length,
    maxContext: s.provider.contextWindow,
    isDryRun: input.isDryRun ?? false,
    globalScanData: {
      personaDescription: card.persona,
      characterDescription: card.description,
      characterPersonality: card.personality,
      characterDepthPrompt: card.depthPrompt,
      scenario: card.scenario,
      creatorNotes: input.speaker.char.data.creator_notes,
      trigger: input.trigger ?? 'normal',
    },
    sortedEntries: sorted,
    settings: s.worldInfo,
    timedStore: input.timedStore ?? { sticky: {}, cooldown: {} },
    injects: [],
    countTokens: count,
    substitute: sub,
    characterName: input.speaker.name,
    characterTags: input.speaker.char.data.tags,
  })
}

/** 合并相邻的、无 name 的 system 消息（对齐 ST squashSystemMessages） */
function squashSystem(msgs: PromptMessage[]): PromptMessage[] {
  const KEEP = new Set(['newChat', 'dialogueExamples', 'groupNudge'])
  const out: PromptMessage[] = []
  for (const m of msgs) {
    const prev = out[out.length - 1]
    if (
      prev &&
      prev.role === 'system' &&
      m.role === 'system' &&
      !prev.name &&
      !m.name &&
      !KEEP.has(prev.source ?? '') &&
      !KEEP.has(m.source ?? '')
    ) {
      prev.content = `${prev.content}\n${m.content}`
      continue
    }
    out.push({ ...m })
  }
  return out
}

/**
 * 开场白（需求 2：多条随机）。
 * 返回被选中的文本与完整池（1v1 把池存进 message.swipes 供左右切换）。
 */
export function pickGreeting(
  c: Character,
  env: MacroEnv,
): { picked: string; pool: string[]; index: number } {
  const raw = [c.data.first_mes, ...c.data.alternate_greetings].filter((x) => x && x.trim())
  if (!raw.length) return { picked: '', pool: [], index: 0 }
  const charEnv: MacroEnv = { ...env, char: c.data.name, card: cardFieldsOf(c) }
  const pool = raw.map((g) => evaluateMacros(g.trim(), { ...charEnv, contentHash: fnv1a(g) }))
  const index = Math.floor(Math.random() * pool.length)
  return { picked: pool[index] ?? '', pool, index }
}

export { EXT_POSITION }
