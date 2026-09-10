import { defineStore } from 'pinia'
import { ref } from 'vue'
import { buildChatPrompt, type BuiltPrompt } from '@/services/prompt/builder'
import { streamChat, chatOnce } from '@/services/provider/openaiCompatible'
import { ProviderError, type ProviderConfig } from '@/types/provider'
import { useChatsStore } from './chats'
import { useCharactersStore, defaultAssistantCharacter } from './characters'
import { useSettingsStore } from './settings'
import { useToast } from '@/composables/useToast'
import { chatsRepo } from '@/db/repositories'

export const useGenerationStore = defineStore('generation', () => {
  const busy = ref(false)
  /** 最近一次组装结果，供「提示词预览」面板 */
  const lastPrompt = ref<BuiltPrompt | null>(null)
  let controller: AbortController | null = null

  function stop() {
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
  function build(opts: { composerText?: string; isContinue?: boolean } = {}): BuiltPrompt | null {
    const chats = useChatsStore()
    const chars = useCharactersStore()
    const settings = useSettingsStore()
    const meta = chats.current
    if (!meta) return null

    const char = chars.byId(meta.characterId) ?? defaultAssistantCharacter()
    const speaker = { id: char.id, name: char.data.name, char }

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
      await chats.refreshMeta(meta.id)
      // 会话变量可能被 {{setvar}} 改过
      await chatsRepo.patchMetadata(meta.id, { variables: meta.chat_metadata.variables })
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

  return { busy, lastPrompt, build, send, regenerate, stop }
})
