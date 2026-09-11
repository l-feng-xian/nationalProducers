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
import { joinGroupCards } from '../group/cards'
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
import type { Group, GroupRelation } from '@/types/group'
import type { Settings } from '@/types/settings'
import type { GenerationTrigger } from '@/types/worldinfo'

/**
 * 系统块的分隔标签。
 *
 * `squashSystemMessages`（对齐 ST）会把相邻的 system 块合并成**一条**消息，
 * 不加标签的话主提示词与角色设定表会直接首尾相连：
 *
 *   请以沉浸式角色扮演的方式续写对话。……输出自然、有细节的中文回应。
 *   姓名：陆雪琪
 *   别名：雪琪、陆师姐……
 *
 * 模型分不清哪里是「给你的指令」、哪里是「角色设定表」，设定权重被稀释。
 * 加上标签后边界清晰，也让人在 DevTools 里一眼能认出各块。
 *
 * ⚠️ 标签必须在**组装块的时候**就写进 content，不能等 squashSystem 时才拼 ——
 *    `fitWithinBudget` 跑在 squash **之前**，晚加的标签不会计入 token 预算。
 *
 * 世界书的标签是**有条件**的，见 `sectionLabels()`。
 *
 * main 不加：它是最顶层的指令，本身就是「开场白」，没有需要与之区分的前文。
 */
const SECTION_LABEL: Record<string, string> = {
  charSystem: '【角色专属指令】',
  charDescription: '【角色设定】',
  charPersonality: '【性格】',
  scenario: '【场景】',
  personaDescription: '【用户设定】',
}

/** `prompt.wiFormat` 的默认值：裸占位，等于没有包裹 */
const BARE_WI_FORMAT = '{0}'

/**
 * 世界书块要不要加标签，取决于用户有没有自定义 `prompt.wiFormat`：
 *
 * - 默认的裸 `{0}` → 世界书内容会直接贴在角色块后面，周围全是带标签的块，
 *   只有它裸着，看起来像是上一块的续写。这里补上标签。
 * - 用户自定义了包裹（如 `[世界观]\n{0}`）→ 他已经有自己的壳，
 *   再加就成了两层，所以让位。
 *
 * 注：`wiFormat` 目前还没有暴露到设置页，所以实际总是走第一条分支；
 * 这个判断是为将来暴露该设置时不出双层壳而准备的。
 */
function sectionLabels(wiFormat: string): Record<string, string> {
  if (wiFormat.trim() !== BARE_WI_FORMAT) return SECTION_LABEL
  return {
    ...SECTION_LABEL,
    worldInfoBefore: '【世界设定】',
    worldInfoAfter: '【世界设定】',
  }
}

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
  /** 1vN 群组配置，决定卡片拼接模式与 nudge */
  group?: Group
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
  /** 会话记忆 · 状态卡正文。空/未传则整块不出现 */
  stateCard?: string
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

  // ── 2. 卡片字段 ──
  // 1vN 的 SWAP 模式只用当前发言者的卡；APPEND 模式拼接全体成员的卡。
  // 无论哪种模式，system_prompt / post_history / depth_prompt 都只取当前发言者的。
  const c = input.speaker.char
  const joined =
    input.isGroup && input.group
      ? joinGroupCards(
          input.group,
          input.members.map((m) => m.char),
          input.speaker.id,
          (text, charName) =>
            baseChatReplace(text, { ...env, char: charName, contentHash: fnv1a(text) }),
        )
      : null

  const card = {
    description: joined ? joined.description : base(c.data.description),
    personality: joined ? joined.personality : base(c.data.personality),
    scenario: joined ? joined.scenario : base(c.data.scenario),
    mesExample: joined ? joined.mesExample : base(c.data.mes_example),
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

  // 3c. 会话记忆 · 状态卡。
  // 注册成普通深度注入，零特例：白嫖预算保护（mandatory+injected 先扣）、
  // 深度语义、以及「预览提示词」面板的展示。
  // depth 默认 2 —— 比约束提示词(0)靠前、比世界书靠后：它是「此刻的事实」，
  // 应当压过检索来的历史片段，但不该压过硬规则。
  const stateCard = input.stateCard?.trim()
  if (stateCard) {
    injections.push(
      makeInjection({
        key: 'MEMORY_STATE',
        value: `【会话记忆】\n${sub(stateCard)}`,
        depth: s.memory?.depth ?? 2,
        role: EXT_ROLE.SYSTEM,
        order: 150, // 世界书 100 < 记忆 150 < 约束提示词 200
        scan: false, // 记忆不参与世界书扫描，避免自己触发自己
      }),
    )
  }

  // ── 4. 固定块（顺序即最终输出顺序） ──
  const labels = sectionLabels(s.prompt.wiFormat)
  const S = (content: string, source: string): PromptMessage[] => {
    const t = content.trim()
    if (!t) return []
    const label = labels[source]
    return [{ role: 'system', content: label ? `${label}\n${t}` : t, source }]
  }

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

  // 余量 24 而非 8：squashSystem 在**预算算完之后**才把相邻 system 块用空行拼起来，
  // 那些额外换行没进预算。典型 5~6 个合并点，几个 token，24 足够盖住。
  const budget = Math.max(512, s.provider.contextWindow - s.provider.maxTokens - 24)
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
      // 空行分隔（不是单个 \n）：配合 SECTION_LABEL，让合并后的块之间
      // 有明确的视觉与语义边界。多出来的换行开销由 budget 的安全余量覆盖。
      prev.content = `${prev.content}\n\n${m.content}`
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
