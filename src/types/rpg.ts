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
  /** 格坐标（整数）。NPC 漫游时引擎会就近更新它 */
  x: number
  y: number
  /**
   * 漫游锚点（出生格，整数）。NPC 只在锚点半径内活动 —— 角色扮演世界里
   * 村民不该瞬移到大陆另一头。旧存档没有这两个字段时,引擎把当前格当锚点
   */
  homeX?: number
  homeY?: number
  /** 漫游半径（格）。缺省由 id 哈希派生 3..6 */
  roamR?: number
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

/**
 * 地形生成参数。
 *
 * ⚠️ 每个字段的「旧值」就是引入本接口之前生成器里写死的那个常量（见 LEGACY_GEN）。
 * 这不是随便挑的默认值 —— 存档里只有种子，地形是每次进游戏现算的，参数一变，
 * 玩家回到自己的世界会发现海岸线和村子全挪了位置。
 */
export interface RpgGenParams {
  /** 海平面。越高水越多；同时整块陆地的台阶等级会一起降（levelAt 以它为基准） */
  seaLevel: number
  /** 环面半径（地貌尺度）。越大绕一圈经过的噪声越多，大陆碎成群岛 */
  radius: number
  /** 湿度偏置。>0 更多森林，<0 更多荒原与沙 */
  moistureBias: number
  /** 聚落场门限。越低越多大区够格出村 */
  districtGate: number
  /** 每个区域的落村概率 */
  villageChance: number
  /** 内陆湖。⚠️ 老世界必须是 false —— 开了会改地形 */
  lakes: boolean
}

/** 引入 gen 字段之前那一版生成器的行为。老存档一律回填成它 */
export const LEGACY_GEN: RpgGenParams = {
  seaLevel: -0.08,
  radius: 1.6,
  moistureBias: 0,
  districtGate: 0.1,
  villageChance: 0.62,
  lakes: false,
}

/**
 * 新建世界的默认值。与 LEGACY_GEN **只差 lakes** ——
 * 新世界才吃新生态，老世界的海岸线一格都不许动。
 */
export const DEFAULT_GEN: RpgGenParams = { ...LEGACY_GEN, lakes: true }

/**
 * 逐字段兜底。
 *
 * ⚠️ 不能写成 `{ ...LEGACY_GEN, ...raw }`：导入的存档可能只有一半字段，
 * 展开运算符会把 `undefined` 也一并铺进去，把好好的默认值盖成空。
 */
export function normalizeGen(raw: unknown): RpgGenParams {
  const g = (raw ?? {}) as Partial<RpgGenParams>
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : d
  return {
    seaLevel: num(g.seaLevel, LEGACY_GEN.seaLevel),
    radius: num(g.radius, LEGACY_GEN.radius),
    moistureBias: num(g.moistureBias, LEGACY_GEN.moistureBias),
    districtGate: num(g.districtGate, LEGACY_GEN.districtGate),
    villageChance: num(g.villageChance, LEGACY_GEN.villageChance),
    // ⚠️ 缺省即 false，不是 DEFAULT_GEN 的 true —— 老存档没有这个字段，
    // 兜底成 true 会让所有老世界一夜之间长出湖来
    lakes: g.lakes === true,
  }
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
  /** 地形生成参数。老存档由 rpgworlds 仓储的 normalize 回填成 LEGACY_GEN */
  gen: RpgGenParams
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
    gen: { ...DEFAULT_GEN },
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
