import { defineStore } from 'pinia'
import { ref } from 'vue'
import { buildChatPrompt, type BuiltPrompt } from '@/services/prompt/builder'
import { streamChat, chatOnce } from '@/services/provider/openaiCompatible'
import { ProviderError, thinkingField, type ProviderConfig } from '@/types/provider'
import { useChatsStore } from './chats'
import { useCharactersStore, defaultAssistantCharacter } from './characters'
import { useSettingsStore } from './settings'
import { useWorldsStore } from './worlds'
import { useGroupsStore } from './groups'
import { selectSpeakers } from '@/services/group/activation'
import { cleanGroupMessage, groupStopStrings } from '@/services/group/cards'
import { group_activation_strategy, type Group } from '@/types/group'
import type { Character } from '@/types/character'
import type { ChatMeta } from '@/types/chat'
import type { ProviderSettings } from '@/types/settings'
import { toPlain } from '@/utils/plain'
import { useToast } from '@/composables/useToast'
import { chatsRepo } from '@/db/repositories'
import { emptyStateCard, extractStateCard, mergeStateCard } from '@/services/memory/stateCard'
import { memchunksRepo } from '@/db/repositories'
import * as memRuntime from '@/services/memory/runtime'
import { buildMemoryBook } from '@/services/memory/book'
import { catchUp, emptyIndexState } from '@/services/memory/vectorIndex'
import { extractStatus, stripStatusForStream } from '@/services/status/parse'
import { normalizeNumberFields } from '@/services/status/template'
import {
  aiTurnCount,
  evaluateFlow,
  guideBlock,
  latestFlowState,
  loreKeys,
  hasFlow,
  type FlowSourceInput,
} from '@/services/flow/engine'
import type { FlowState } from '@/types/flow'
import type { MessageStatus } from '@/types/status'
import {
  completeStatus,
  resolveStatusContext,
  type StatusContext,
} from '@/services/status/complete'
import { resolvePersona } from '@/types/group'
import type { MessageExtra } from '@/types/chat'
import type { Usage } from '@/types/provider'
import { comparePrefix, signPrompt, type PrefixReport } from '@/services/prompt/cache'
import { estimateTokens } from '@/services/tokens'

export const useGenerationStore = defineStore('generation', () => {
  const busy = ref(false)
  /** 最近一次组装结果，供「提示词预览」面板 */
  const lastPrompt = ref<BuiltPrompt | null>(null)
  let controller: AbortController | null = null
  /** 1vN 串行生成时，任一环节失败/中断就停掉后续发言者 */
  let aborted = false

  // ── 前缀缓存诊断 ───────────────────────────────────────────
  /**
   * 每个「会话 × 发言者」最近一次**真实发出**的提示词签名（squash 前逐块）。
   * 只在内存里：重启后第一轮没有对照，这无妨。按发言者分开是因为演绎里
   * 不同成员的系统块本来就不同，拿 A 的去比 B 的只会得到一个无意义的「全不同」。
   */
  const sentSignatures = new Map<string, number[]>()
  const sigKey = (chatId: string, speakerId: string) => `${chatId}${speakerId}`

  function recordSent(chatId: string, built: BuiltPrompt) {
    sentSignatures.set(sigKey(chatId, built.debug.speakerId), signPrompt(built.debug.sections))
  }

  /** 预览面板：这份组装结果与该发言者上一次真实请求的公共前缀 */
  function prefixReport(built: BuiltPrompt): PrefixReport | null {
    const speakerId = built.debug.speakerId
    const meta = useChatsStore().current
    if (!meta) return null
    const per = useSettingsStore().settings.prompt.perMessageTokens
    return comparePrefix(
      built.debug.sections,
      sentSignatures.get(sigKey(meta.id, speakerId)),
      (m) => estimateTokens(m.content) + per,
    )
  }

  /** 非 dryRun 组装后：把本轮历史起点写回会话元数据（随 finally 里的 patchMetadata 落库） */
  function keepHistoryStart(meta: ChatMeta, built: BuiltPrompt, isDryRun: boolean) {
    if (isDryRun) return
    const seq = built.debug.historyStartSeq
    if (seq == null) delete meta.chat_metadata.historyStartSeq
    else meta.chat_metadata.historyStartSeq = seq
  }

  function stop() {
    aborted = true
    controller?.abort()
    controller = null
  }

  // ── 会话记忆 · 状态卡 ──────────────────────────────────────
  /** 提炼是单例的：并发跑两次会互相覆盖 throughSeq */
  let memoryBusy = false
  /**
   * 提炼用独立的 AbortController。
   * ⚠️ 绝不能复用生成用的 `controller` —— 用户点「停止生成」会连提炼一起杀掉。
   */
  let memoryController: AbortController | null = null

  /**
   * 一轮生成收尾后，够条数就在后台提炼一次状态卡。
   *
   * ⚠️ 只挂在 send / sendGroup 的 finally，**绝不能挂进 build()** ——
   * 「预览提示词」面板每次打开和刷新都会调 build()，挂那儿等于
   * 「用户每排查一次提示词就烧一次 API」。
   */
  async function maybeExtractMemory(chatId: string): Promise<void> {
    const settings = useSettingsStore()
    const mem = settings.settings.memory
    if (!mem.enabled || memoryBusy) return

    const chats = useChatsStore()
    // 全程用捕获的 chatId 取数，绝不读 chats.current —— 提炼要十几秒，
    // 期间用户完全可能切走，读当前会话会把 A 的记忆写进 B
    const meta = chats.list.find((c) => c.id === chatId)
    if (!meta || meta.id !== chats.current?.id) return

    const card = meta.chat_metadata.stateCard ?? emptyStateCard()
    const msgs = chats.messages.filter((m) => !m.is_system && !m.exclude)
    const last = msgs[msgs.length - 1]
    if (!last) return
    const interval = Math.max(2, mem.intervalMessages)
    const fresh = msgs.filter((m) => m.seq > card.throughSeq)
    if (fresh.length < interval) return

    const dialogue = fresh.map((m) => `${m.name}：${m.mes}`).join('\n')
    if (dialogue.trim().length < mem.minNewChars) return

    memoryBusy = true
    memoryController = new AbortController()
    try {
      const p = settings.settings.provider
      const cfg = await providerConfig(p)
      const outcome = await extractStateCard({
        prev: card,
        // 从**尾部**截断：保留最新的对话，旧的那头本来就已经被上一次提炼覆盖过
        dialogue: dialogue.slice(-mem.dialogueCharLimit),
        cfg,
        model: mem.model.trim() || p.model,
        signal: memoryController.signal,
      })
      const merged = mergeStateCard(card, outcome, last.seq)
      // 写库前再确认一次会话没变
      if (chats.current?.id !== chatId) return
      await chatsRepo.patchMetadata(chatId, { stateCard: merged })
      await chats.refreshMeta(chatId)
    } catch {
      // 记忆是尽力而为，任何异常都不许把聊天搞崩
    } finally {
      memoryBusy = false
      memoryController = null
    }
  }

  /** 设置页/记忆面板的「立即提炼」按钮：绕过条数门槛 */
  async function extractMemoryNow(chatId: string): Promise<boolean> {
    const settings = useSettingsStore()
    const saved = settings.settings.memory.intervalMessages
    settings.settings.memory.intervalMessages = 2
    try {
      await maybeExtractMemory(chatId)
      const chats = useChatsStore()
      return !(chats.list.find((c) => c.id === chatId)?.chat_metadata.stateCard?.failures ?? 0)
    } finally {
      settings.settings.memory.intervalMessages = saved
    }
  }

  // ── 会话记忆 · 向量召回（二期）────────────────────────────
  let vecBusy = false

  /** 在 build() 之前算好本轮召回。失败静默 —— 记忆是增强，不能拖垮生成 */
  async function prepareRecall(chatId: string): Promise<void> {
    const settings = useSettingsStore()
    const mem = settings.settings.memory
    memRuntime.clearHits()
    // 没选模型 = 不启用。选了个不存在的 id 也当没启用处理，
    // 这样即使配置被手改坏，最坏结果也只是没有召回，不会去联网拉模型
    const preset = memRuntime.activePreset(mem.vector.modelId)
    if (!mem.enabled || !preset) return
    const chats = useChatsStore()
    await memRuntime.prepareRecall({
      chatId,
      messages: chats.messages,
      queryWindow: mem.vector.queryWindow,
      preset,
      opts: {
        topK: mem.vector.topK,
        minScore: mem.vector.minScore,
      },
    })
  }

  /** 生成收尾后把索引追到最新。fire-and-forget */
  async function catchUpIndex(chatId: string): Promise<void> {
    const settings = useSettingsStore()
    const mem = settings.settings.memory
    const preset = memRuntime.activePreset(mem.vector.modelId)
    if (!mem.enabled || !preset || vecBusy) return
    const chats = useChatsStore()
    const meta = chats.list.find((c) => c.id === chatId)
    if (!meta || chats.current?.id !== chatId) return

    vecBusy = true
    try {
      const emb = memRuntime.getEmbedder(preset)
      if (emb.dead) return
      await emb.ensure()
      const state = meta.chat_metadata.memIndex ?? emptyIndexState(preset.id, emb.dim)
      const res = await catchUp({
        chatId,
        messages: chats.messages,
        state,
        embedder: emb,
        model: preset.id,
        docPrefix: preset.docPrefix,
        backfillLimit: mem.vector.backfillLimit,
      })
      if (res.added > 0) {
        if (chats.current?.id !== chatId) return
        await chatsRepo.patchMetadata(chatId, { memIndex: res.state })
        await chats.refreshMeta(chatId)
        // 索引变了，打包缓存要重建
        memRuntime.invalidateIndex(chatId)
      }
    } catch {
      // 尽力而为
    } finally {
      vecBusy = false
    }
  }

  /** 设置面板用：把整段历史都索引一遍 */
  async function backfillAll(chatId: string, onProgress?: (a: number, b: number) => void) {
    const settings = useSettingsStore()
    const chats = useChatsStore()
    const preset = memRuntime.activePreset(settings.settings.memory.vector.modelId)
    if (!preset) throw new Error('尚未启用嵌入模型')
    const emb = memRuntime.getEmbedder(preset)
    await emb.ensure()
    await memchunksRepo.clearChat(chatId)
    const res = await catchUp({
      chatId,
      messages: chats.messages,
      state: emptyIndexState(preset.id, emb.dim),
      embedder: emb,
      model: preset.id,
      docPrefix: preset.docPrefix,
      backfillLimit: Number.MAX_SAFE_INTEGER,
      ...(onProgress ? { onProgress } : {}),
    })
    await chatsRepo.patchMetadata(chatId, { memIndex: res.state })
    await chats.refreshMeta(chatId)
    memRuntime.invalidateIndex(chatId)
    void settings
    return res
  }

  async function providerConfig(p: ProviderSettings): Promise<ProviderConfig> {
    const settings = useSettingsStore()
    const cfg: ProviderConfig = { baseUrl: p.baseUrl }
    const key = await settings.getApiKey(p.secretRef)
    if (key) cfg.apiKey = key
    if (p.proxyPrefix) cfg.proxyPrefix = p.proxyPrefix
    if (Object.keys(p.extraHeaders).length) cfg.headers = p.extraHeaders
    Object.assign(cfg, thinkingField(p.thinking))
    return cfg
  }

  /**
   * 会话记忆的两路输入，1v1 的 build() 与 1vN 的 generateOne() **共用这一处**。
   *
   * ⚠️ 两个曾经的坑，都是因为两条路径各写各的：
   *  1. 演绎漏了向量召回：sendGroup 照常 prepareRecall 算好了命中，generateOne 却从没把
   *     记忆书并进 loreSources —— 索引在建、检索在跑，结果全被丢掉，演绎里召回永远不生效。
   *  2. 状态卡只看「有没有」、不看开关：关掉「启用会话记忆」后，之前提炼好的状态卡照样
   *     每轮注入。开关必须对注入生效，而不只是停止提炼。
   */
  function memoryInputs(
    meta: ChatMeta,
    loreSources: ReturnType<ReturnType<typeof useWorldsStore>['resolveSources']>,
  ) {
    const mem = useSettingsStore().settings.memory
    if (!mem.enabled) return { stateCard: '', loreSources }
    // 向量召回的结果由 prepareRecall() 在组装**之前**算好放在 runtime 里 ——
    // 组装是同步的，这是整个方案唯一的架构阻碍
    if (mem.vector.modelId) {
      const book = buildMemoryBook({
        stateCard: '',
        hits: memRuntime.currentHits(),
        stateDepth: mem.depth,
        recallDepth: mem.vector.recallDepth,
      })
      if (book) loreSources = { ...loreSources, chat: [book, ...loreSources.chat] }
    }
    return { stateCard: meta.chat_metadata.stateCard?.text ?? '', loreSources }
  }

  /**
   * 回复 → 正文 + 状态。关着开关时原样返回，免得误伤正文里恰好出现的 JSON。
   * quiet：用户自己按了停止，没写完状态是预期内的，不记失败、不在侧栏报警。
   */
  function splitStatus(
    text: string,
    ctx: StatusContext | null,
    quiet = false,
  ): {
    mes: string
    status?: MessageExtra['status']
    error?: string
  } {
    if (!ctx) return { mes: text }
    const r = extractStatus(text)
    if (!r.data) return { mes: r.body, ...(r.error && !quiet ? { error: r.error } : {}) }
    // 用户与每个角色都必须有记录：漏写的人 / 字段沿用上一份
    // number 字段收敛成纯数字并夹在 min/max 内；取不出数的沿用上一份
    const data = normalizeNumberFields(
      completeStatus(r.data, ctx.current, ctx),
      ctx.fields,
      ctx.current,
    )
    return { mes: r.body, status: { data, source: 'ai', updatedAt: Date.now() } }
  }

  /** 把解析结果合进 extra：成功写 status、失败写 statusError，两者互斥 */
  function withStatus(extra: MessageExtra, parsed: ReturnType<typeof splitStatus>): MessageExtra {
    const { status: _s, statusError: _e, ...rest } = extra
    if (parsed.status) return { ...rest, status: parsed.status }
    if (parsed.error) return { ...rest, statusError: parsed.error }
    return rest
  }

  // ── 流程控制（services/flow/engine.ts） ──

  /**
   * 本轮参与求值的规则来源。
   * 1v1：角色卡。演绎：演绎自己的规则（{{char}} = 本轮发言者）+ 每位成员角色卡上的规则
   * （{{char}} = 那位成员本人，所以同一张卡放进不同演绎照样能用）。
   */
  function flowSourcesFor(meta: ChatMeta, speaker: Character): FlowSourceInput[] {
    if (meta.kind === 'group' && meta.groupId) {
      const g = useGroupsStore().byId(meta.groupId)
      if (!g) return []
      return [
        { ownerId: g.id, config: g.flow, charName: speaker.data.name },
        ...[...groupMembers(g).values()].map((c) => ({
          ownerId: c.id,
          config: c.data.extensions.np?.flow,
          charName: c.data.name,
        })),
      ]
    }
    return [
      {
        ownerId: speaker.id,
        config: speaker.data.extensions.np?.flow,
        charName: speaker.data.name,
      },
    ]
  }

  function flowUserName(meta: ChatMeta): string {
    const settings = useSettingsStore().settings
    const g =
      meta.kind === 'group' && meta.groupId ? useGroupsStore().byId(meta.groupId) : undefined
    return g ? resolvePersona(g, settings.persona).name : settings.persona.name
  }

  /** 本轮要注入的剧情引导：来自最新一份运行态 */
  function flowGuideFor(
    meta: ChatMeta,
    speaker: Character,
  ): { flowGuide?: string; flowLore?: string[] } {
    // 规则引导 + 每个来源当前阶段的常驻引导（阶段引导里的 {{char}} 按来源替换）
    const state = latestFlowState(useChatsStore().messages)
    const text = guideBlock(state, flowSourcesFor(meta, speaker))
    // 流程强制激活、仍在生效的世界书条目
    const lore = loreKeys(state)
    return {
      ...(text ? { flowGuide: text } : {}),
      ...(lore.length ? { flowLore: lore } : {}),
    }
  }

  interface FlowResult {
    state: FlowState
    status?: MessageStatus
    says: { speaker: string; text: string }[]
  }

  /**
   * 回复落库前跑一次规则。只在用户仍停留在这段会话时执行 ——
   * 求值依赖内存里的消息列表，切走后那份列表已经是别的会话了。
   * 会话变量就地写回 meta（随 finally 里的 patchMetadata 落库）。
   */
  function runFlow(
    meta: ChatMeta,
    row: { id: string },
    speaker: Character,
    reply: string,
    parsed: ReturnType<typeof splitStatus>,
    ctx: StatusContext | null,
  ): FlowResult | null {
    const chats = useChatsStore()
    if (chats.current?.id !== meta.id) return null
    const sources = flowSourcesFor(meta, speaker)
    const history = chats.messages.filter((m) => m.id !== row.id)
    const prev = latestFlowState(history)
    // 没有规则、也没有残留的引导要扣减：什么都不写，别给每条消息都挂个空运行态
    if (!prev && !sources.some((src) => hasFlow(src.config))) return null
    const out = evaluateFlow({
      sources,
      prev,
      turn: aiTurnCount(chats.messages),
      status: parsed.status?.data ?? ctx?.current ?? null,
      fields: ctx?.fields ?? [],
      vars: meta.chat_metadata.variables,
      reply,
      userName: ctx?.userName ?? flowUserName(meta),
    })
    if (out.varsChanged) meta.chat_metadata.variables = out.vars
    return {
      state: out.state,
      ...(out.statusChanged && out.status
        ? { status: { data: out.status, source: 'ai' as const, updatedAt: Date.now() } }
        : {}),
      says: out.says,
    }
  }

  /** 运行态与规则改过的状态合进 extra；规则写了状态就不再算「本轮解析失败」 */
  function mergeFlow(extra: MessageExtra, flow: FlowResult | null): MessageExtra {
    if (!flow) return extra
    const next: MessageExtra = { ...extra, flow: flow.state }
    if (flow.status) {
      next.status = flow.status
      delete next.statusError
    }
    return next
  }

  /** 固定台词：接在回复后面原样插入，不调用模型 */
  async function insertSays(
    meta: ChatMeta,
    speaker: Character,
    says: FlowResult['says'],
    extra: MessageExtra = {},
  ) {
    if (!says.length) return
    const chats = useChatsStore()
    const g =
      meta.kind === 'group' && meta.groupId ? useGroupsStore().byId(meta.groupId) : undefined
    const members = g ? [...groupMembers(g).values()] : [speaker]
    for (const s of says) {
      const who = members.find((c) => c.data.name === s.speaker) ?? speaker
      await chats.appendAiTo(meta.id, s.speaker || who.data.name, who.id, s.text, {
        ...extra,
        flowSay: true,
      })
    }
  }

  /**
   * 当前会话的角色状态上下文（字段、必须出现的人、最新快照 / 初始状态）。
   * 关着开关或没有字段时为 null。侧栏（stores/status.ts）用同一个 resolveStatusContext。
   *
   * ⚠️ 读的是 chats.messages，只对**当前打开**的会话成立 —— 生成时必须在流式开始前取好，
   * 用户中途切走会话后再取就是别人的消息了。
   */
  function statusContextFor(meta: ChatMeta): StatusContext | null {
    const settings = useSettingsStore().settings
    if (!settings.status.enabled) return null
    const chats = useChatsStore()
    const g =
      meta.kind === 'group' && meta.groupId ? useGroupsStore().byId(meta.groupId) : undefined
    const ctx = resolveStatusContext({
      settings: settings.status,
      messages: chats.messages,
      userName: resolvePersona(g, settings.persona).name,
      ...(g
        ? { members: [...groupMembers(g).values()], groupConfig: g.status ?? null }
        : { char: resolveSpeaker(meta) }),
    })
    return ctx.fields.length ? ctx : null
  }

  /** 注入参数。build() 与 buildGroup() 共用，理由同 memoryInputs：两条路径各写各的迟早漂移 */
  function statusInputs(meta: ChatMeta) {
    const ctx = statusContextFor(meta)
    if (!ctx) return undefined
    return {
      fields: ctx.fields,
      current: ctx.current,
      depth: useSettingsStore().settings.status.depth,
      charNames: ctx.required.slice(0, -1),
    }
  }

  /** 本轮发言者。build() 与 send() 必须算出同一个人，所以只此一处 */
  function resolveSpeaker(meta: ChatMeta): Character {
    const chars = useCharactersStore()
    return chars.byId(meta.characterId) ?? defaultAssistantCharacter()
  }

  /** 组装本轮提示词（dryRun 也走这里，用于预览面板） */
  function build(
    opts: {
      composerText?: string
      isContinue?: boolean
      isDryRun?: boolean
      /** 仅演绎：预览哪位成员的提示词；缺省 = 按策略的下一位发言者 */
      speakerId?: string
    } = {},
  ): BuiltPrompt | null {
    const chats = useChatsStore()
    const chars = useCharactersStore()
    const settings = useSettingsStore()
    const worlds = useWorldsStore()
    const meta = chats.current
    if (!meta) return null

    // ⚠️ 演绎必须走演绎组装。这里原本不分会话类型一律按 1v1 组装，演绎会话没有
    // characterId，resolveSpeaker 回落成「助手」—— 「预览提示词」看到的是一份
    // 根本不会发出去的提示词（没有成员卡、关系图谱、演绎约束）。
    if (meta.kind === 'group') {
      const g = meta.groupId ? useGroupsStore().byId(meta.groupId) : undefined
      if (!g) return null
      const members = groupMembers(g)
      const id =
        opts.speakerId && members.has(opts.speakerId) ? opts.speakerId : nextGroupSpeaker(g)
      const speakerChar = id ? members.get(id) : undefined
      if (!speakerChar) return null
      return buildGroup({
        group: g,
        speakerChar,
        members,
        ...(opts.isDryRun ? { isDryRun: true } : {}),
      })
    }

    const char = resolveSpeaker(meta)
    const speaker = { id: char.id, name: char.data.name, char }

    // 需求 5：全局世界书只在全局配置启用；角色世界书随角色带入
    const memory = memoryInputs(
      meta,
      worlds.resolveSources({
        globalBookIds: char.worldBookId ? [char.worldBookId] : settings.settings.worldInfo.globalBookIds,
        characterBookIds: char.worldBookId ? [] : char.worldBookIds,
        chatBookId: meta.chat_metadata.worldBookId,
        personaBookId: settings.settings.persona.worldBookId,
      }),
    )

    // dryRun 必须克隆定时效果，否则每点一次预览就推进一格 sticky/cooldown
    const isDryRun = opts.isDryRun ?? false
    const timedStore = isDryRun
      ? toPlain(meta.chat_metadata.timedWorldInfo)
      : meta.chat_metadata.timedWorldInfo

    const built = buildChatPrompt({
      isGroup: false,
      speaker,
      members: [speaker],
      mutedIds: [],
      settings: settings.settings,
      history: chats.messages,
      chatId: meta.id,
      chatIdHash: meta.chat_metadata.chat_id_hash ?? 0,
      variables: meta.chat_metadata.variables,
      isContinue: opts.isContinue ?? false,
      trigger: 'normal',
      composerText: opts.composerText ?? '',
      loreSources: memory.loreSources,
      timedStore,
      isDryRun,
      stateCard: memory.stateCard,
      status: statusInputs(meta),
      ...flowGuideFor(meta, char),
      ...historyStartOf(meta),
    })
    keepHistoryStart(meta, built, isDryRun)
    lastPrompt.value = built
    return built
  }

  function historyStartOf(meta: ChatMeta): { historyStartSeq?: number } {
    const seq = meta.chat_metadata.historyStartSeq
    return seq != null ? { historyStartSeq: seq } : {}
  }

  /** 发送一轮：组装 → 流式 → 落盘 */
  async function send(): Promise<void> {
    const chats = useChatsStore()
    const chars = useCharactersStore()
    const settings = useSettingsStore()
    const toast = useToast()
    const meta = chats.current
    if (!meta || busy.value) return

    const p = settings.settings.provider
    if (!p.baseUrl || !p.model) {
      toast.error('请先在「模型管理 → 模型服务」里添加并选择服务')
      return
    }

    // 第一个 await 前就锁定本轮并创建取消控制器，避免重复发送且支持预检时停止。
    busy.value = true
    const ctl = new AbortController()
    controller = ctl
    /** 只有真的建了占位行才算「这一轮生成过」，收尾动作全挂在它上面 */
    let generated = false
    let row: Awaited<ReturnType<typeof chats.appendAi>> = null

    const started = Date.now()
    let text = ''
    let reasoning = ''
    let usage: Usage | undefined
    let statusCtx: StatusContext | null = null

    try {
      // 检索必须在 build() 之前：build() 是同步的，拿不到 await
      await prepareRecall(meta.id)
      // 预检期间用户按了停止：此刻还没有占位行，干净退出即可
      if (ctl.signal.aborted) return

      // 状态上下文在流式开始前取好（见 statusContextFor）
      statusCtx = statusContextFor(meta)
      const built = build()
      if (!built) return

      const char = resolveSpeaker(meta)
      row = await chats.appendAi(char.data.name, char.id)
      if (!row) return
      await chats.markTainted()
      generated = true
      // ↑ 之后再按停止不必单独判：fetch 对已中断的信号会立刻 reject，
      //   走下面 catch 的 aborted 分支，空占位行会被 removeRowFrom 删掉
      const cfg = await providerConfig(p)
      const req = {
        model: p.model,
        messages: built.messages,
        stream: p.stream,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
        ...(p.topP != null ? { topP: p.topP } : {}),
        ...(p.stop.length ? { stop: p.stop } : {}),
        cacheKey: meta.id,
      }
      recordSent(meta.id, built)

      if (p.stream) {
        let lastFlush = 0
        // ⚠️ 用捕获的 ctl 而不是模块字段 controller：stop() 会把 controller
        // 置 null，而正在飞的这一轮仍然需要自己的 signal
        for await (const chunk of streamChat(cfg, req, ctl.signal)) {
          if (chunk.usage) usage = chunk.usage
          if (chunk.delta) text += chunk.delta
          if (chunk.reasoningDelta) reasoning += chunk.reasoningDelta
          // 节流刷新，避免每个 token 触发一次整列表重渲染
          const now = Date.now()
          if (now - lastFlush >= settings.settings.chat.streamFlushMs) {
            lastFlush = now
            chats.patchLocal(row.id, { mes: stripStatusForStream(text) })
          }
        }
      } else {
        text = await chatOnce(cfg, req, ctl.signal, undefined, (u) => (usage = u))
      }

      // 状态块先剥出来，正文落库时就不带它 —— 下一轮历史里也就不会有旧快照
      const parsed = splitStatus(text, statusCtx)
      const flow = runFlow(meta, row, char, parsed.mes, parsed, statusCtx)
      // 按 chatId 写回，不看用户现在开着哪段会话（切走了也不能丢回复）
      await chats.writeRow(meta.id, row, {
        mes: parsed.mes,
        extra: {
          ...mergeFlow(withStatus(row.extra, parsed), flow),
          model: p.model,
          duration: Date.now() - started,
          ...(reasoning ? { reasoning } : {}),
          ...(usage ? { usage } : {}),
        },
      })
      if (flow) await insertSays(meta, char, flow.says)

      // 首轮回复后用用户第一句话给会话命名
      if (meta.title === '新对话') {
        const firstUser = chats.messages.find((m) => m.is_user)
        if (firstUser) await chats.rename(meta.id, firstUser.mes.slice(0, 20))
      }
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError('unknown', String(e))
      // 预检阶段就抛了（还没有占位行）：没什么可收拾的，报一声即可
      if (!row) {
        if (err.kind !== 'aborted') toast.error(err.message)
      } else if (err.kind === 'aborted') {
        // 一个字都没出就被中断（首字之前按停止很常见，带思维链的模型 TTFB 好几秒），
        // 留着就是一条永久空白的 assistant，还会被塞进之后每一轮提示词
        if (!text) await chats.removeRowFrom(meta.id, row)
        else {
          const parsed = splitStatus(text, statusCtx, true)
          await chats.writeRow(meta.id, row, {
            mes: parsed.mes,
            extra: { ...withStatus(row.extra, parsed), stopped: true },
          })
        }
      } else {
        toast.error(err.message)
        // 生成失败：把空的占位消息删掉，别在历史里留残骸
        if (!text) await chats.removeRowFrom(meta.id, row)
        // 超时同样是「话说到一半被掐」，打上 stopped 让气泡显示「已中断」，
        // 别让一条被截断的回复看起来像是模型自己说完了
        else {
          const parsed = splitStatus(text, statusCtx)
          await chats.writeRow(meta.id, row, {
            mes: parsed.mes,
            extra: {
              ...withStatus(row.extra, parsed),
              ...(err.kind === 'timeout' ? { stopped: true } : {}),
            },
          })
        }
      }
    } finally {
      busy.value = false
      // 只有还是自己那一个才清：防止将来这里加了 await 之后清掉下一轮的
      if (controller === ctl) controller = null
      // ⚠️ 下面全部由 generated 把门。预检阶段返回的那几条路**什么都没生成**，
      //    此时提炼记忆等于「用户点了发送、发现没配好，结果后台照样烧一次 API」
      if (generated) {
        // 会话变量可能被 {{setvar}} 改过；世界书定时效果（sticky/cooldown）也要落盘
        await chatsRepo.patchMetadata(meta.id, {
          variables: meta.chat_metadata.variables,
          timedWorldInfo: meta.chat_metadata.timedWorldInfo,
          historyStartSeq: meta.chat_metadata.historyStartSeq,
        })
        await chats.refreshMeta(meta.id)
        // fire-and-forget：提炼要十几秒，不能卡住 UI 收尾
        void maybeExtractMemory(meta.id)
        void catchUpIndex(meta.id)
      }
    }
  }

  /**
   * 1vN：按策略选出本轮发言者，**串行**依次生成。
   * 每条消息带 gen_id 批号，便于「重掷整批」。
   */
  async function sendGroup(opts: { forceId?: string; isUserInput?: boolean } = {}): Promise<void> {
    // ⚠️ 进门就复位，别只依赖上一轮 finally 的清理。
    // `stop()` 会把 aborted 置 true，而它**只在本函数的 finally 里复位** ——
    // 于是在 1v1 里按过一次停止之后，标志会一直挂着，
    // 下一次演绎在第一个发言者结束时就 `if (aborted) break` 静默停掉其余成员，
    // 表现是「群里只有一个人说话」且毫无报错。
    aborted = false
    const chats = useChatsStore()
    const chars = useCharactersStore()
    const groups = useGroupsStore()
    const settings = useSettingsStore()
    const toast = useToast()
    const meta = chats.current
    if (!meta?.groupId || busy.value) return

    const g = groups.byId(meta.groupId)
    if (!g) {
      toast.error('找不到该演绎的配置，可能已被删除')
      return
    }

    const p = settings.settings.provider
    if (!p.baseUrl || !p.model) {
      toast.error('请先在「模型管理 → 模型服务」里添加并选择服务')
      return
    }

    const charById = groupMembers(g)
    const { group: gFlow, next: flowNext } = flowGroupView(g, charById)
    const forceId = opts.forceId ?? flowNext
    const speakers = selectSpeakers(
      {
        group: gFlow,
        charById,
        chat: chats.messages,
        isUserInput: opts.isUserInput ?? true,
        activationText: opts.isUserInput
          ? (chats.messages[chats.messages.length - 1]?.mes ?? '')
          : '',
      },
      forceId,
    )
    if (!speakers.length) {
      // 手动策略下用户发言不触发回复是**预期行为**，不该报错
      if (g.activation_strategy !== group_activation_strategy.MANUAL) {
        toast.error('没有可发言的成员：请检查成员列表与静音状态')
      }
      return
    }

    // ⚠️ 上面那句 `if (busy.value) return` 到这里之间一行 await 都不许有，
    // 否则就是 send() 里那个 TOCTOU：两次快点击双双通过闸门
    busy.value = true
    // 预检期间也要有东西可掐。每个发言者随后会在 generateOne 里换上自己的，
    // 这一个纯粹是为了覆盖 markTainted / prepareRecall 这段窗口
    controller = new AbortController()
    const genId = Date.now()
    await chats.markTainted()

    // 整轮**只检索一次**：放进循环的话，3 个成员就会嵌入 3 次同样的查询，
    // 纯属白烧 CPU，而且每人召回的还是同一批片段
    await prepareRecall(meta.id)

    try {
      for (const id of speakers) {
        // ⚠️ 判在**进入**循环体时。原先只判在末尾：用户在 prepareRecall 期间
        // 按停止，aborted 已经是 true，第一个发言者却还是会完整生成一遍
        if (aborted) break
        const char = charById.get(id)
        if (!char) continue
        await generateOne({ group: g, speakerChar: char, members: charById, genId })
      }
    } finally {
      busy.value = false
      controller = null
      await chatsRepo.patchMetadata(meta.id, {
        variables: meta.chat_metadata.variables,
        timedWorldInfo: meta.chat_metadata.timedWorldInfo,
        historyStartSeq: meta.chat_metadata.historyStartSeq,
      })
      await chats.refreshMeta(meta.id)
      aborted = false
      // 挂在 sendGroup 的 finally 而不是 generateOne —— 否则 5 个成员的演绎
      // 一轮会发 5 次提炼请求
      void maybeExtractMemory(meta.id)
      void catchUpIndex(meta.id)
    }
  }

  /** 演绎成员 id → 角色；已删除的角色跳过 */
  function groupMembers(g: Group): Map<string, Character> {
    const chars = useCharactersStore()
    return new Map(
      g.members.map((id) => [id, chars.byId(id)]).filter((e): e is [string, Character] => !!e[1]),
    )
  }

  /**
   * 预览 / 默认发言者：按演绎策略选出**下一位**会说话的人。
   * 用户刚说完话就按「用户发言」激活，否则按「自动续聊」激活；
   * 策略选不出人（手动点名、全员静音）时退回第一个未静音成员，预览总得有人可看。
   */
  /**
   * 流程控制对演绎选人的影响。sendGroup 与预览（nextGroupSpeaker）共用，两边永远选同一个人：
   *  - 本会话内被流程静音的成员并进 disabled_members（返回副本，不改演绎设置）
   *  - 指定的下一位发言者（没被静音时）作为 next 返回
   */
  function flowGroupView(
    g: Group,
    charById: Map<string, Character>,
  ): { group: Group; next?: string } {
    const flowState = latestFlowState(useChatsStore().messages)
    const idOf = (name: string | undefined) =>
      name ? g.members.find((id) => charById.get(id)?.data.name === name) : undefined
    const muted = (flowState?.muted ?? []).map(idOf).filter((id): id is string => !!id)
    const group = muted.length
      ? { ...g, disabled_members: [...new Set([...g.disabled_members, ...muted])] }
      : g
    const next = idOf(flowState?.nextSpeaker)
    return next && !group.disabled_members.includes(next) ? { group, next } : { group }
  }

  function nextGroupSpeaker(g: Group): string | undefined {
    const chats = useChatsStore()
    const charById = groupMembers(g)
    const { group: gFlow, next } = flowGroupView(g, charById)
    if (next) return next
    const last = chats.messages[chats.messages.length - 1]
    const isUserInput = !!last?.is_user
    const picked = selectSpeakers({
      group: gFlow,
      charById,
      chat: chats.messages,
      isUserInput,
      activationText: isUserInput ? (last?.mes ?? '') : '',
    })[0]
    return (
      picked ??
      g.members.find((id) => charById.has(id) && !gFlow.disabled_members.includes(id)) ??
      g.members.find((id) => charById.has(id))
    )
  }

  /**
   * 组装 1vN 某位成员这一轮的提示词。**纯组装、无副作用**：
   * 真实生成（generateOne）与「预览提示词」共用，两边永远看到同一份提示词。
   * dryRun 克隆定时效果与会话变量，看几眼预览不会推进 sticky/cooldown，也不会被 {{setvar}} 改掉变量。
   */
  function buildGroup(args: {
    group: Group
    speakerChar: Character
    members: Map<string, Character>
    isDryRun?: boolean
  }): BuiltPrompt | null {
    const chats = useChatsStore()
    const settings = useSettingsStore()
    const worlds = useWorldsStore()
    const meta = chats.current
    if (!meta) return null

    const { group: g, speakerChar: char, members } = args
    const isDryRun = args.isDryRun ?? false
    const memberList = g.members
      .map((mid) => members.get(mid))
      .filter((c): c is Character => !!c)
      .map((c) => ({ id: c.id, name: c.data.name, char: c }))
    const speaker = { id: char.id, name: char.data.name, char }
    // 与 1v1 共用：状态卡按开关注入，向量召回命中并进记忆书（见 memoryInputs）
    const memory = memoryInputs(
      meta,
      worlds.resolveSources({
        globalBookIds: g.worldBookId
          ? [g.worldBookId]
          : settings.settings.worldInfo.globalBookIds,
        characterBookIds: g.worldBookId ? [] : g.mergeMemberBooks
          ? [...new Set(memberList.flatMap((m) => m.char.worldBookId ? [m.char.worldBookId] : m.char.worldBookIds))]
          : char.worldBookId ? [] : char.worldBookIds,
        chatBookId: meta.chat_metadata.worldBookId,
        personaBookId: settings.settings.persona.worldBookId,
      }),
    )

    const built = buildChatPrompt({
      isGroup: true,
      speaker,
      members: memberList,
      mutedIds: g.disabled_members,
      settings: settings.settings,
      history: chats.messages,
      chatId: meta.id,
      chatIdHash: meta.chat_metadata.chat_id_hash ?? 0,
      variables: isDryRun ? toPlain(meta.chat_metadata.variables) : meta.chat_metadata.variables,
      stateCard: memory.stateCard,
      status: statusInputs(meta),
      ...flowGuideFor(meta, char),
      group: g,
      relations: meta.chat_metadata.relationGraph?.relations ?? g.relations,
      relationTemplate: meta.chat_metadata.relationGraph?.relationTemplate ?? g.relationTemplate,
      trigger: 'normal',
      loreSources: memory.loreSources,
      timedStore: isDryRun
        ? toPlain(meta.chat_metadata.timedWorldInfo)
        : meta.chat_metadata.timedWorldInfo,
      isDryRun,
      ...historyStartOf(meta),
    })
    keepHistoryStart(meta, built, isDryRun)
    lastPrompt.value = built
    return built
  }

  /** 生成单个角色的一条回复（1vN 内部用） */
  async function generateOne(args: {
    group: Group
    speakerChar: Character
    members: Map<string, Character>
    genId: number
  }): Promise<void> {
    const chats = useChatsStore()
    const settings = useSettingsStore()
    const toast = useToast()
    const meta = chats.current
    if (!meta) return

    const { group: g, speakerChar: char, members, genId } = args
    const allNames = g.members
      .map((mid) => members.get(mid)?.data.name)
      .filter((n): n is string => !!n)
    // 上一位发言者已经落库，这里取到的「最新快照」就是他写的那份（见 statusContextFor）
    const statusCtx = statusContextFor(meta)
    const built = buildGroup({ group: g, speakerChar: char, members })
    if (!built) return

    const row = await chats.appendAi(char.data.name, char.id)
    if (!row) return
    chats.patchLocal(row.id, { extra: { ...row.extra, gen_id: genId } })

    const ctl = new AbortController()
    controller = ctl
    const p = settings.settings.provider
    let text = ''
    let usage: Usage | undefined
    try {
      const cfg = await providerConfig(p)
      const req = {
        model: p.model,
        messages: built.messages,
        stream: p.stream,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
        // 其他成员名做 stop sequence，从源头压制模型替别人说话
        stop: [...p.stop, ...groupStopStrings(char.data.name, allNames)],
        cacheKey: meta.id,
      }
      recordSent(meta.id, built)
      if (p.stream) {
        let lastFlush = 0
        for await (const chunk of streamChat(cfg, req, ctl.signal)) {
          if (chunk.usage) usage = chunk.usage
          if (chunk.delta) text += chunk.delta
          const now = Date.now()
          if (now - lastFlush >= settings.settings.chat.streamFlushMs) {
            lastFlush = now
            chats.patchLocal(row.id, { mes: stripStatusForStream(text) })
          }
        }
      } else {
        text = await chatOnce(cfg, req, ctl.signal, undefined, (u) => (usage = u))
      }
      // ⚠️ 先剥状态、再防串台截断。反过来的话截断可能连状态块一起切掉
      const parsed = splitStatus(text, statusCtx)
      // 兜底：模型仍然替别人续写时，从那里截断
      const cleaned = cleanGroupMessage(parsed.mes, char.data.name, allNames)
      const flow = runFlow(meta, row, char, cleaned, parsed, statusCtx)
      // 按 chatId 写回，不看用户现在开着哪段会话（与 send() 同理）
      await chats.writeRow(meta.id, row, {
        mes: cleaned,
        extra: {
          ...mergeFlow(withStatus(row.extra, parsed), flow),
          gen_id: genId,
          model: p.model,
          ...(usage ? { usage } : {}),
        },
      })
      // 带上批号：「重掷整批」时固定台词跟着一起删
      if (flow) await insertSays(meta, char, flow.says, { gen_id: genId })
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError('unknown', String(e))
      if (err.kind === 'aborted') {
        aborted = true
        if (!text) await chats.removeRowFrom(meta.id, row)
        else {
          const parsed = splitStatus(text, statusCtx, true)
          await chats.writeRow(meta.id, row, {
            mes: parsed.mes,
            extra: { ...withStatus(row.extra, parsed), gen_id: genId, stopped: true },
          })
        }
      } else {
        toast.error(err.message)
        aborted = true
        if (!text) await chats.removeRowFrom(meta.id, row)
        else {
          const parsed = splitStatus(text, statusCtx)
          await chats.writeRow(meta.id, row, {
            mes: parsed.mes,
            extra: {
              ...withStatus(row.extra, parsed),
              gen_id: genId,
              ...(err.kind === 'timeout' ? { stopped: true } : {}),
            },
          })
        }
      }
    } finally {
      // ⚠️ 只清自己那一个。controller 是全局单例、每个发言者都会重新赋值，
      // 无条件置 null 会把下一位刚建好的那个抹掉 —— 于是整轮里只有第一位能被停止
      if (controller === ctl) controller = null
    }
  }

  /**
   * 重新生成：删掉最后一条 AI 消息，**由同一个角色**重新说一遍（与 SillyTavern 一致）。
   *
   * ⚠️ 演绎必须走 sendGroup。原来无条件调 send()（1v1 路径），而演绎会话没有 characterId，
   * resolveSpeaker 回落到 defaultAssistantCharacter() —— 重新生成出来的发言者就成了「助手」，
   * 提示词也按 1v1 组装（没有成员卡、关系图谱、演绎约束）。
   */
  async function regenerate(): Promise<void> {
    const chats = useChatsStore()
    const groups = useGroupsStore()
    if (busy.value) return
    const meta = chats.current
    // 末尾的流程控制固定台词是上一条回复的附属品：一起删掉再重来
    const msgs = chats.messages
    let tail = 0
    while (tail < msgs.length && msgs[msgs.length - 1 - tail]?.extra?.flowSay) tail++
    const last = msgs[msgs.length - 1 - tail]
    if (!meta || !last || last.is_user) return
    await chats.removeTail(tail + 1)
    if (meta.kind === 'group') {
      const g = meta.groupId ? groups.byId(meta.groupId) : undefined
      // original_avatar 是这条消息权威的发言者 id；该成员已被移出演绎时退回按策略选人
      const speakerId = last.original_avatar
      const forceId = speakerId && g?.members.includes(speakerId) ? speakerId : undefined
      await sendGroup({ ...(forceId ? { forceId } : {}), isUserInput: false })
      return
    }
    await send()
  }

  /** 预览面板用：演绎成员（按列表顺序）与默认预览对象。非演绎返回 null */
  function previewSpeakers(): {
    members: { id: string; name: string }[]
    defaultId: string
  } | null {
    const chats = useChatsStore()
    const meta = chats.current
    if (meta?.kind !== 'group' || !meta.groupId) return null
    const g = useGroupsStore().byId(meta.groupId)
    if (!g) return null
    const byId = groupMembers(g)
    const members = g.members
      .filter((id) => byId.has(id))
      .map((id) => ({ id, name: byId.get(id)!.data.name }))
    return { members, defaultId: nextGroupSpeaker(g) ?? members[0]?.id ?? '' }
  }

  return {
    busy,
    lastPrompt,
    build,
    prefixReport,
    previewSpeakers,
    send,
    sendGroup,
    regenerate,
    stop,
    extractMemoryNow,
    prepareRecall,
    catchUpIndex,
    backfillAll,
  }
})
