import { defineStore } from 'pinia'
import { ref } from 'vue'
import { buildChatPrompt, type BuiltPrompt } from '@/services/prompt/builder'
import { streamChat, chatOnce } from '@/services/provider/openaiCompatible'
import { ProviderError, type ProviderConfig } from '@/types/provider'
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

export const useGenerationStore = defineStore('generation', () => {
  const busy = ref(false)
  /** 最近一次组装结果，供「提示词预览」面板 */
  const lastPrompt = ref<BuiltPrompt | null>(null)
  let controller: AbortController | null = null
  /** 1vN 串行生成时，任一环节失败/中断就停掉后续发言者 */
  let aborted = false

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
    return cfg
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
    } = {},
  ): BuiltPrompt | null {
    const chats = useChatsStore()
    const chars = useCharactersStore()
    const settings = useSettingsStore()
    const worlds = useWorldsStore()
    const meta = chats.current
    if (!meta) return null

    const char = resolveSpeaker(meta)
    const speaker = { id: char.id, name: char.data.name, char }

    // 需求 5：全局世界书只在全局配置启用；角色世界书随角色带入
    const loreSources = worlds.resolveSources({
      globalBookIds: settings.settings.worldInfo.globalBookIds,
      characterBookIds: char.worldBookIds,
      chatBookId: meta.chat_metadata.worldBookId,
      personaBookId: settings.settings.persona.worldBookId,
    })

    // 向量召回的结果由 prepareRecall() 在 build() **之前**算好放在 runtime 里 ——
    // build() 是同步的，这是整个方案唯一的架构阻碍。把它改成 async 会牵动
    // send/sendGroup/generateOne 三处加 PromptPreview.vue，返工面太大。
    const mem = settings.settings.memory
    if (mem.enabled && mem.vector.modelId) {
      const book = buildMemoryBook({
        stateCard: '',
        hits: memRuntime.currentHits(),
        stateDepth: mem.depth,
        recallDepth: mem.vector.recallDepth,
      })
      if (book) loreSources.chat = [book, ...loreSources.chat]
    }

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
      loreSources,
      timedStore,
      isDryRun,
      stateCard: meta.chat_metadata.stateCard?.text ?? '',
    })
    lastPrompt.value = built
    return built
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

    try {
      // 检索必须在 build() 之前：build() 是同步的，拿不到 await
      await prepareRecall(meta.id)
      // 预检期间用户按了停止：此刻还没有占位行，干净退出即可
      if (ctl.signal.aborted) return

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
      }

      if (p.stream) {
        let lastFlush = 0
        // ⚠️ 用捕获的 ctl 而不是模块字段 controller：stop() 会把 controller
        // 置 null，而正在飞的这一轮仍然需要自己的 signal
        for await (const chunk of streamChat(cfg, req, ctl.signal)) {
          if (chunk.delta) text += chunk.delta
          if (chunk.reasoningDelta) reasoning += chunk.reasoningDelta
          // 节流刷新，避免每个 token 触发一次整列表重渲染
          const now = Date.now()
          if (now - lastFlush >= settings.settings.chat.streamFlushMs) {
            lastFlush = now
            chats.patchLocal(row.id, { mes: text })
          }
        }
      } else {
        text = await chatOnce(cfg, req, ctl.signal)
      }

      // 按 chatId 写回，不看用户现在开着哪段会话（切走了也不能丢回复）
      await chats.writeRow(meta.id, row, {
        mes: text,
        extra: {
          ...row.extra,
          model: p.model,
          duration: Date.now() - started,
          ...(reasoning ? { reasoning } : {}),
        },
      })

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
        else
          await chats.writeRow(meta.id, row, { mes: text, extra: { ...row.extra, stopped: true } })
      } else {
        toast.error(err.message)
        // 生成失败：把空的占位消息删掉，别在历史里留残骸
        if (!text) await chats.removeRowFrom(meta.id, row)
        // 超时同样是「话说到一半被掐」，打上 stopped 让气泡显示「已中断」，
        // 别让一条被截断的回复看起来像是模型自己说完了
        else
          await chats.writeRow(meta.id, row, {
            mes: text,
            ...(err.kind === 'timeout' ? { extra: { ...row.extra, stopped: true } } : {}),
          })
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
    // 下一次群聊在第一个发言者结束时就 `if (aborted) break` 静默停掉其余成员，
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
      toast.error('找不到该群聊的配置，可能已被删除')
      return
    }

    const p = settings.settings.provider
    if (!p.baseUrl || !p.model) {
      toast.error('请先在「模型管理 → 模型服务」里添加并选择服务')
      return
    }

    const charById = new Map(
      g.members
        .map((id) => [id, chars.byId(id)])
        .filter((e): e is [string, NonNullable<ReturnType<typeof chars.byId>>] => !!e[1]),
    )
    const speakers = selectSpeakers(
      {
        group: g,
        charById,
        chat: chats.messages,
        isUserInput: opts.isUserInput ?? true,
        activationText: opts.isUserInput
          ? (chats.messages[chats.messages.length - 1]?.mes ?? '')
          : '',
      },
      opts.forceId,
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
      })
      await chats.refreshMeta(meta.id)
      aborted = false
      // 挂在 sendGroup 的 finally 而不是 generateOne —— 否则 5 个成员的群聊
      // 一轮会发 5 次提炼请求
      void maybeExtractMemory(meta.id)
      void catchUpIndex(meta.id)
    }
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
    const worlds = useWorldsStore()
    const toast = useToast()
    const meta = chats.current
    if (!meta) return

    const { group: g, speakerChar: char, members, genId } = args
    const memberList = g.members
      .map((mid) => members.get(mid))
      .filter((c): c is Character => !!c)
      .map((c) => ({ id: c.id, name: c.data.name, char: c }))
    const speaker = { id: char.id, name: char.data.name, char }
    const allNames = memberList.map((m) => m.name)

    const built = buildChatPrompt({
      isGroup: true,
      speaker,
      members: memberList,
      mutedIds: g.disabled_members,
      settings: settings.settings,
      history: chats.messages,
      chatId: meta.id,
      chatIdHash: meta.chat_metadata.chat_id_hash ?? 0,
      variables: meta.chat_metadata.variables,
      stateCard: meta.chat_metadata.stateCard?.text ?? '',
      group: g,
      relations: meta.chat_metadata.relationGraph?.relations ?? g.relations,
      relationTemplate: meta.chat_metadata.relationGraph?.relationTemplate ?? g.relationTemplate,
      trigger: 'normal',
      loreSources: worlds.resolveSources({
        globalBookIds: settings.settings.worldInfo.globalBookIds,
        characterBookIds: g.mergeMemberBooks
          ? [...new Set(memberList.flatMap((m) => m.char.worldBookIds))]
          : char.worldBookIds,
        chatBookId: meta.chat_metadata.worldBookId,
        personaBookId: settings.settings.persona.worldBookId,
      }),
      timedStore: meta.chat_metadata.timedWorldInfo,
    })
    lastPrompt.value = built

    const row = await chats.appendAi(char.data.name, char.id)
    if (!row) return
    chats.patchLocal(row.id, { extra: { ...row.extra, gen_id: genId } })

    const ctl = new AbortController()
    controller = ctl
    const p = settings.settings.provider
    let text = ''
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
      }
      if (p.stream) {
        let lastFlush = 0
        for await (const chunk of streamChat(cfg, req, ctl.signal)) {
          if (chunk.delta) text += chunk.delta
          const now = Date.now()
          if (now - lastFlush >= settings.settings.chat.streamFlushMs) {
            lastFlush = now
            chats.patchLocal(row.id, { mes: text })
          }
        }
      } else {
        text = await chatOnce(cfg, req, ctl.signal)
      }
      // 兜底：模型仍然替别人续写时，从那里截断
      const cleaned = cleanGroupMessage(text, char.data.name, allNames)
      // 按 chatId 写回，不看用户现在开着哪段会话（与 send() 同理）
      await chats.writeRow(meta.id, row, {
        mes: cleaned,
        extra: { ...row.extra, gen_id: genId, model: p.model },
      })
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError('unknown', String(e))
      if (err.kind === 'aborted') {
        aborted = true
        if (!text) await chats.removeRowFrom(meta.id, row)
        else
          await chats.writeRow(meta.id, row, {
            mes: text,
            extra: { ...row.extra, gen_id: genId, stopped: true },
          })
      } else {
        toast.error(err.message)
        aborted = true
        if (!text) await chats.removeRowFrom(meta.id, row)
        else
          await chats.writeRow(meta.id, row, {
            mes: text,
            ...(err.kind === 'timeout'
              ? { extra: { ...row.extra, gen_id: genId, stopped: true } }
              : {}),
          })
      }
    } finally {
      // ⚠️ 只清自己那一个。controller 是全局单例、每个发言者都会重新赋值，
      // 无条件置 null 会把下一位刚建好的那个抹掉 —— 于是整轮里只有第一位能被停止
      if (controller === ctl) controller = null
    }
  }

  /** 重新生成：删掉最后一条 AI 消息再发 */
  async function regenerate(): Promise<void> {
    const chats = useChatsStore()
    if (busy.value) return
    const last = chats.messages[chats.messages.length - 1]
    if (!last || last.is_user) return
    await chats.removeTail(1)
    await send()
  }

  return {
    busy,
    lastPrompt,
    build,
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
