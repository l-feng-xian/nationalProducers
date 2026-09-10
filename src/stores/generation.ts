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
import { toPlain } from '@/utils/plain'
import { useToast } from '@/composables/useToast'
import { chatsRepo } from '@/db/repositories'

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

  async function providerConfig(): Promise<ProviderConfig> {
    const settings = useSettingsStore()
    const p = settings.settings.provider
    const cfg: ProviderConfig = { baseUrl: p.baseUrl }
    const key = await settings.getApiKey()
    if (key) cfg.apiKey = key
    if (p.proxyPrefix) cfg.proxyPrefix = p.proxyPrefix
    if (Object.keys(p.extraHeaders).length) cfg.headers = p.extraHeaders
    return cfg
  }

  /** 组装本轮提示词（dryRun 也走这里，用于预览面板） */
  function build(
    opts: { composerText?: string; isContinue?: boolean; isDryRun?: boolean } = {},
  ): BuiltPrompt | null {
    const chats = useChatsStore()
    const chars = useCharactersStore()
    const settings = useSettingsStore()
    const worlds = useWorldsStore()
    const meta = chats.current
    if (!meta) return null

    const char = chars.byId(meta.characterId) ?? defaultAssistantCharacter()
    const speaker = { id: char.id, name: char.data.name, char }

    // 需求 5：全局世界书只在全局配置启用；角色世界书随角色带入
    const loreSources = worlds.resolveSources({
      globalBookIds: settings.settings.worldInfo.globalBookIds,
      characterBookIds: char.worldBookIds,
      chatBookId: meta.chat_metadata.worldBookId,
      personaBookId: settings.settings.persona.worldBookId,
    })

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
      toast.error('请先在「设置 → 模型服务」里填写 baseURL 与模型名')
      return
    }

    const built = build()
    if (!built) return

    const char = chars.byId(meta.characterId) ?? defaultAssistantCharacter()
    const row = await chats.appendAi(char.data.name, char.id)
    if (!row) return

    busy.value = true
    controller = new AbortController()
    await chats.markTainted()

    const started = Date.now()
    let text = ''
    let reasoning = ''

    try {
      const cfg = await providerConfig()
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
        for await (const chunk of streamChat(cfg, req, controller.signal)) {
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
        text = await chatOnce(cfg, req, controller.signal)
      }

      chats.patchLocal(row.id, {
        mes: text,
        extra: {
          ...row.extra,
          model: p.model,
          duration: Date.now() - started,
          ...(reasoning ? { reasoning } : {}),
        },
      })
      await chats.persist(row.id)

      // 首轮回复后用用户第一句话给会话命名
      if (meta.title === '新对话') {
        const firstUser = chats.messages.find((m) => m.is_user)
        if (firstUser) await chats.rename(meta.id, firstUser.mes.slice(0, 20))
      }
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError('unknown', String(e))
      if (err.kind === 'aborted') {
        chats.patchLocal(row.id, {
          mes: text,
          extra: { ...row.extra, stopped: true },
        })
        await chats.persist(row.id)
      } else {
        toast.error(err.message)
        // 生成失败：把空的占位消息删掉，别在历史里留残骸
        if (!text) await chats.removeTail(1)
        else {
          chats.patchLocal(row.id, { mes: text })
          await chats.persist(row.id)
        }
      }
    } finally {
      busy.value = false
      controller = null
      // 会话变量可能被 {{setvar}} 改过；世界书定时效果（sticky/cooldown）也要落盘
      await chatsRepo.patchMetadata(meta.id, {
        variables: meta.chat_metadata.variables,
        timedWorldInfo: meta.chat_metadata.timedWorldInfo,
      })
      await chats.refreshMeta(meta.id)
    }
  }

  /**
   * 1vN：按策略选出本轮发言者，**串行**依次生成。
   * 每条消息带 gen_id 批号，便于「重掷整批」。
   */
  async function sendGroup(opts: { forceId?: string; isUserInput?: boolean } = {}): Promise<void> {
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
      toast.error('请先在「设置 → 模型服务」里填写 baseURL 与模型名')
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

    busy.value = true
    const genId = Date.now()
    await chats.markTainted()

    try {
      for (const id of speakers) {
        const char = charById.get(id)
        if (!char) continue
        await generateOne({ group: g, speakerChar: char, members: charById, genId })
        if (aborted) break
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

    controller = new AbortController()
    const p = settings.settings.provider
    let text = ''
    try {
      const cfg = await providerConfig()
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
        for await (const chunk of streamChat(cfg, req, controller.signal)) {
          if (chunk.delta) text += chunk.delta
          const now = Date.now()
          if (now - lastFlush >= settings.settings.chat.streamFlushMs) {
            lastFlush = now
            chats.patchLocal(row.id, { mes: text })
          }
        }
      } else {
        text = await chatOnce(cfg, req, controller.signal)
      }
      // 兜底：模型仍然替别人续写时，从那里截断
      const cleaned = cleanGroupMessage(text, char.data.name, allNames)
      chats.patchLocal(row.id, {
        mes: cleaned,
        extra: { ...row.extra, gen_id: genId, model: p.model },
      })
      await chats.persist(row.id)
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError('unknown', String(e))
      if (err.kind === 'aborted') {
        aborted = true
        chats.patchLocal(row.id, {
          mes: text,
          extra: { ...row.extra, gen_id: genId, stopped: true },
        })
        await chats.persist(row.id)
      } else {
        toast.error(err.message)
        aborted = true
        if (!text) await chats.removeTail(1)
        else {
          chats.patchLocal(row.id, { mes: text })
          await chats.persist(row.id)
        }
      }
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

  return { busy, lastPrompt, build, send, sendGroup, regenerate, stop }
})
