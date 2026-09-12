/**
 * RPG 世界的数据模型。
 *
 * 只放类型与纯 factory（与 types/** 的既有约定一致）。
 */

import { emptyCharacter, type Character } from './character'

/** 世界尺寸与噪声参数都由种子决定，所以存档本身很小 —— 地形是算出来的，不是存出来的 */
export const RPG_WORLD_SIZE = 256

/**
 * 一个 NPC。
 *
 * `characterId` 关联到角色卡：关联了就用卡里的名字与简介，没关联就用自填的
 * `name`/`description` —— 两种情形都要能沉浸式扮演，这是需求里明确要的。
 */
export interface RpgNpc {
  id: string
  /** 格坐标（整数） */
  x: number
  y: number
  /** 关联的角色卡 id。留空表示这是一个只在游戏里存在的 NPC */
  characterId?: string
  /** 未关联角色卡时使用 */
  name: string
  description: string
  /** 与该 NPC 的会话 id。第一次说话时创建并记住，之后继续同一段对话 */
  chatId?: string
}

/**
 * 玩家在这个世界里的身份。
 *
 * 与群聊的 GroupPersona 同构：两项都留空就回落到全局人设。
 * 刻意复用同一套形状，好直接调既有的 resolvePersona()。
 */
export interface RpgPersona {
  name: string
  description: string
}

export interface RpgWorld {
  id: string
  name: string
  /**
   * 世界简介：这是个什么地方、什么年代、有什么规矩。
   *
   * 会作为【场景】进入**这个世界里每一段** NPC 对话的提示词 —— NPC 站在这个
   * 世界里，总得知道自己身在何处。角色卡自带的 scenario 不会被顶掉，两段并存。
   */
  description: string
  /** 地形种子。同一个种子必然长出同一个世界 */
  seed: number
  width: number
  height: number
  /** 玩家上次站的位置，进游戏时从这里续上 */
  playerX: number
  playerY: number
  persona: RpgPersona
  npcs: RpgNpc[]
  createdAt: number
  updatedAt: number
}

export function emptyWorld(id: string, name = '新世界', seed?: number): RpgWorld {
  const now = Date.now()
  return {
    id,
    name,
    description: '',
    // 不传种子就随机一个。用 crypto 而不是 Math.random，避免同一毫秒建两个世界撞种子
    seed: seed ?? crypto.getRandomValues(new Uint32Array(1))[0] ?? 1,
    width: RPG_WORLD_SIZE,
    height: RPG_WORLD_SIZE,
    // -1 表示「还没进去过」，首次进入时由引擎找一块陆地
    playerX: -1,
    playerY: -1,
    persona: { name: '', description: '' },
    npcs: [],
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 没关联角色卡、又没填简介的 NPC 的兜底身份：这个世界的原住民。
 *
 * 兜底成「原住民」而不是留空，是因为空简介会让模型无所依凭，张口就飘到
 * 现代都市或者干脆出戏；而「本地人」这个身份配上世界简介（它会作为【场景】
 * 一起进提示词）足以让对话落在这个世界里 —— 玩家在地图上随手放一个 NPC
 * 就能直接说话，不必先写人设。
 */
export function nativeIdentity(worldName?: string): string {
  const where = worldName?.trim() ? `「${worldName.trim()}」` : '这个世界'
  return `${where}的原住民，在此地生活多年，熟悉本地的人事、地方与风土。`
}

/**
 * NPC 实际显示的名字与简介。
 *
 * 关联了角色卡就以卡为准 —— 用户改了角色卡，游戏里立刻跟着变，
 * 不需要再同步一遍（把卡里的内容拷进 npc 记录是双真相源，迟早对不上）。
 *
 * 没关联卡且没填简介时回落成「世界原住民」，见 nativeIdentity。
 */
export function resolveNpc(
  npc: RpgNpc,
  card: { data: { name: string; description: string } } | undefined,
  worldName?: string,
): { name: string; description: string } {
  if (card) {
    return { name: card.data.name, description: card.data.description }
  }
  return {
    name: npc.name || '无名者',
    description: npc.description.trim() || nativeIdentity(worldName),
  }
}

/**
 * 用 NPC 的自填身份合成一张**临时**角色卡。只在一轮生成里存在，不落库、
 * 不进角色列表。
 *
 * 不合成的话，`chars.byId(undefined)` 查不到卡，管线会**静默回落**成
 * 「一个乐于助人的 AI 助手」—— 用户在 NPC 编辑器里写的简介一个字都进不了
 * 提示词，而「不关联角色卡也要能设置人物简介」是需求里明确要的。
 *
 * 放在 types/ 是因为 build() 也要用它，而它不能 import dialogue.ts：
 * 那个文件反过来 import 了 generation store，会绕成循环依赖。
 */
export function synthNpcCard(
  npcId: string,
  name: string,
  description: string,
  worldName?: string,
): Character {
  const c = emptyCharacter(`__rpg_npc_${npcId}__`, name || '无名者')
  c.data.description = description.trim() || nativeIdentity(worldName)
  return c
}

/** 交互距离（格）。比一格略大，站在斜对角也够得着 */
export const NPC_REACH = 1.4

/** 找出玩家够得着的最近的那个 NPC */
export function nearestNpc(
  npcs: RpgNpc[],
  px: number,
  py: number,
  w: number,
  h: number,
): RpgNpc | null {
  let best: RpgNpc | null = null
  let bestD = NPC_REACH
  for (const n of npcs) {
    // 环面世界上两点的距离要取「绕过去」与「直接走」的较小者，
    // 否则站在接缝两侧明明贴着脸，算出来却是横跨整个世界
    const dx = Math.min(Math.abs(n.x + 0.5 - px), w - Math.abs(n.x + 0.5 - px))
    const dy = Math.min(Math.abs(n.y + 0.5 - py), h - Math.abs(n.y + 0.5 - py))
    const d = Math.hypot(dx, dy)
    if (d < bestD) {
      bestD = d
      best = n
    }
  }
  return best
}
