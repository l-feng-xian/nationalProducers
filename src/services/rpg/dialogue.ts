/**
 * 游戏内与 NPC 对话 —— **完全复用**现有的提示词与 provider 管线。
 *
 * 这里一行提示词逻辑都不写：世界书、会话记忆、深度注入、状态卡、流式、
 * 历史落库全都由 stores/generation 那条既有链路负责。RPG 只做三件事：
 * 把 `chats.current` 切到该 NPC 的会话、把玩家那句话追加进去、等生成结束。
 *
 * ⚠️ 这是唯一一个 import pinia 的 rpg 文件 —— 它本来就是「把游戏接到 store 上」
 * 的胶水层，放在 services/ 下是因为它没有任何 UI。其余 rpg/** 仍然是纯 TS。
 */

import { watch } from 'vue'
import { chatsRepo, rpgWorldsRepo } from '@/db/repositories'
import type { RpgChatBinding } from '@/types/chat'
import { useChatsStore } from '@/stores/chats'
import { useCharactersStore } from '@/stores/characters'
import { useSettingsStore } from '@/stores/settings'
import { useGenerationStore } from '@/stores/generation'
import { resolveNpc, type RpgNpc, type RpgWorld } from '@/types/rpg'

export interface TalkResult {
  ok: boolean
  /** NPC 的完整回复 */
  text: string
  /** 失败原因，直接显示给玩家 */
  error?: string
}

/**
 * 确保这个 NPC 有一段可用的会话，返回 chatId。
 *
 * 权威来源是 `npc.chatId`：**不能**靠 `listByCharacter` 去找，那会把玩家在
 * 普通聊天页跟同一个角色的对话也捞进来，NPC 会莫名其妙接上另一段历史。
 * 而且纯游戏 NPC（没有 characterId）根本进不了那个索引。
 */
/**
 * 这一段会话的 RPG 身份，写进 chat_metadata。
 *
 * 每轮都重写一遍（而不是建会话时写一次）：世界简介、玩家身份、NPC 关联的卡
 * 都可以在 NpcEditor 里随时改，而 chatId 不会作废。不刷新的话，从聊天页
 * 或 ↻ 发起的那一轮用的就是过期身份。situation 同理 —— NPC 会走动,
 * 每轮都该带上它此刻在哪、在干什么。
 */
function bindingOf(world: RpgWorld, npc: RpgNpc, situation?: string): RpgChatBinding {
  return {
    worldId: world.id,
    npcId: npc.id,
    worldName: world.name,
    worldDescription: world.description ?? '',
    persona: { name: world.persona.name, description: world.persona.description },
    ...(npc.characterId ? { characterId: npc.characterId } : {}),
    npcName: npc.name,
    npcDescription: npc.description,
    ...(situation ? { situation } : {}),
  }
}

async function ensureChat(
  world: RpgWorld,
  npc: RpgNpc,
  situation?: string,
): Promise<string | null> {
  const chats = useChatsStore()
  const chars = useCharactersStore()

  // 会话可能已被「数据管理」页删掉。陈旧 id 是条**静默死路**：
  // chats.open() 对不存在的 id 只是把 current 置 null，随后 send() 直接 return，
  // 全程不报错，表现为「按了没反应」。所以必须先验一次。
  if (npc.chatId && (await chatsRepo.get(npc.chatId))) {
    await chatsRepo.patchMetadata(npc.chatId, { rpg: bindingOf(world, npc, situation) })
    return npc.chatId
  }

  const card = chars.byId(npc.characterId)
  const { name } = resolveNpc(npc, card, world.name)
  // 世界人设要在**建会话时**就传进去：开场白里的 {{user}} 在播种那一刻就被
  // 展开并永久落库（整个 swipes 池都是），事后再补绑定也改不回来了
  const meta = await chats.createSolo(npc.characterId, `${world.name} · ${name}`, world.persona)
  await chatsRepo.patchMetadata(meta.id, { rpg: bindingOf(world, npc, situation) })
  npc.chatId = meta.id
  // ⚠️ 必须落库。只改内存的话重进游戏 chatId 又是空的，于是**每次说话都新建
  // 一段会话** —— NPC 永远记不住上一句，而且会话列表被刷屏。
  await rpgWorldsRepo.save(world)
  return meta.id
}

/**
 * 跟 NPC 说一句话，等它说完。
 *
 * `onDelta` 是流式增量。管线**没有任何回调或事件**，只能 watch store 里的
 * 最后一条消息；而且刷新是节流的（默认 100ms），所以别指望逐字。
 * 用户要是在设置里关了流式，就只会触发一次 —— 打字机效果得 UI 侧自己兜。
 */
export async function talkToNpc(
  world: RpgWorld,
  npc: RpgNpc,
  text: string,
  onDelta?: (t: string) => void,
  /** 引擎给的 NPC 此刻处境,进【场景】。不传则不带（聊天页续聊就是这种） */
  situation?: string,
): Promise<TalkResult> {
  const chats = useChatsStore()
  const chars = useCharactersStore()
  const settings = useSettingsStore()
  const gen = useGenerationStore()

  // characters store 没 load 过时 byId 返回 undefined，管线会**静默**回落到
  // 「一个乐于助人的 AI 助手」—— 角色卡整卡丢失且毫无报错
  if (!chars.loaded) await chars.load()

  const p = settings.settings.provider
  if (!p.baseUrl || !p.model) {
    return {
      ok: false,
      text: '',
      error: '还没配置模型服务：请到「设置 → 模型服务」填 baseURL 与模型名',
    }
  }
  // busy 是全局单例，重入是**静默 return**。玩家连按两次交互键，
  // 第二次就是「按了没反应」—— 自己先挡住并给出人话
  if (gen.busy) return { ok: false, text: '', error: '上一句还没说完' }

  const chatId = await ensureChat(world, npc, situation)
  if (!chatId) return { ok: false, text: '', error: '无法创建对话' }

  // send() 不接 chatId，只认 chats.current。漏了这步，NPC 的话会被说进
  // 玩家当前打开的那段普通聊天里
  if (chats.current?.id !== chatId) await chats.open(chatId)
  if (chats.current?.id !== chatId) {
    return { ok: false, text: '', error: '打不开这段对话' }
  }

  let out = ''
  const stop = watch(
    () => chats.messages[chats.messages.length - 1],
    (m) => {
      if (!m || m.is_user) return
      out = m.mes
      onDelta?.(out)
    },
  )

  try {
    // 名字也要用世界人设：提示词走的是 personaOverride，历史记录若还记全局人设的
    // 名字，玩家在聊天页翻这段会看到「阿明」在跟 NPC 说话
    await chats.appendUser(text, world.persona.name)
    // 身份不再靠参数传递：ensureChat 刚把它写进了 chat_metadata.rpg，
    // build() 会自己取。这样游戏里、聊天页、↻ 重新生成走的是同一份身份，
    // 不会因为入口不同而分叉（这正是之前聊天页会丢掉世界人设的原因）。
    await gen.send()
  } catch (e) {
    stop()
    return { ok: false, text: out, error: e instanceof Error ? e.message : String(e) }
  }
  stop()

  const last = chats.messages[chats.messages.length - 1]
  const final = last && !last.is_user ? last.mes : out
  if (!final) {
    // 生成失败时管线只删掉 AI 占位、留下用户那条。错误本身只走全局 toast，
    // 而游戏是全屏 canvas，玩家多半看不见 —— 所以这里也回一份给对话框
    return { ok: false, text: '', error: '没有收到回复，检查模型服务是否可用' }
  }
  return { ok: true, text: final }
}

/**
 * 打断当前生成。
 *
 * ⚠️ 掐的是**全局那一个** controller：游戏里按停会把同时在跑的聊天页生成
 * 一起中断，反之亦然。管线只有这一个，没法只停自己这一路。
 */
export function stopTalking(): void {
  useGenerationStore().stop()
}
