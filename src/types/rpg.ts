/**
 * RPG 世界的数据模型。
 *
 * 只放类型与纯 factory（与 types/** 的既有约定一致）。
 */

import { emptyCharacter, type Character } from './character'

/** 世界尺寸与噪声参数都由种子决定，所以存档本身很小 —— 地形是算出来的，不是存出来的 */
export const RPG_WORLD_SIZE = 256

/**
 * 时间流速：现实 1 秒推进多少游戏分钟。
 *
 * 放在 types/ 而不是 services/rpg/time.ts，是因为 db 仓储层要用它做回填，
 * 而那一层只依赖 types/。time.ts 从这里 re-export。
 */
export const DEFAULT_TIME_SCALE = 1

/**
 * 一个世界最多放多少个 NPC。
 *
 * 20 是按**渲染与仿真成本**定的，不是拍脑袋：每个 NPC 一个程序化方块小人，
 * 实测是 10 个 mesh（不是 figureRig 注释里说的 6：躯干/背带/头/眼/发或帽/
 * 双臂/双腿/贴地阴影），20 个就是 200 个 draw call —— 已经和整张地形的可见
 * chunk 数同一量级了。仿真侧每个移动中的 NPC 每帧至少两次 canStand，
 * 作息又让它们比以前走得多得多。
 *
 * ⚠️ 这个上限**只挡新建**，绝不在读档时截断 —— 老存档里超编的 NPC 宁可留着
 * 掉帧，也不能因为我们改了个常量就把用户的角色连同对话历史一起抹掉。
 */
export const NPC_MAX = 20

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
  /**
   * 生活作息。缺省时引擎首次挂载会按周边地貌推导一份并写回 ——
   * 与 homeX/homeY 同一套路：推导一次、落盘一次，之后算法再怎么调都不会让
   * 老 NPC 的家悄悄搬走。
   */
  routine?: RpgRoutine
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

/**
 * 一个兴趣点。存的是**格坐标**，不是「最近的房子」这种描述。
 *
 * 地形确实是算出来的，但 POI 是「这个 NPC 的家是那一间」这样一次性的**选择**：
 * 每次进游戏重算的话，房屋哈希或锚点稍有变动，人的家就会悄悄搬走。
 * 所以确定性推导一次、结果存下来 —— 与 homeX/homeY 完全同源。
 */
export interface RpgPoi {
  x: number
  y: number
  /** 这是什么地方，直接进提示词：'家门口' | '田里' | '水井旁' …… */
  label: string
  /** 在这儿做什么，直接进提示词：'照看庄稼' | '打水' | '与邻里闲话' …… */
  act: string
  /** 在这点周围多大范围内溜达（格）。缺省 2 */
  r?: number
}

/** 一段作息。数组按 from 升序，最后一段回绕接第一段 —— 一天是个圈 */
export interface RpgRoutineSlot {
  /** 起始时刻，当天分钟 0..1439 */
  from: number
  /** 索引进 routine.pois */
  poi: number
}

export type RpgRoutineKind = 'farmer' | 'villager' | 'keeper' | 'wanderer'

/**
 * 作息类别的中文名，给编辑器显示。
 *
 * 放在 types/ 而不是 routine.ts：后者 import 了 world.ts → noise.ts → simplex-noise，
 * 一个只想显示「农夫」两个字的弹窗没必要把整套地形生成器拖进自己的分包。
 */
export const ROUTINE_KIND_LABEL: Record<RpgRoutineKind, string> = {
  farmer: '农夫',
  villager: '村民',
  keeper: '守摊人',
  wanderer: '游荡者',
}

export interface RpgRoutine {
  kind: RpgRoutineKind
  /** 2~4 个点就够：家 / 干活的地方 / 社交的地方 */
  pois: RpgPoi[]
  slots: RpgRoutineSlot[]
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
  /**
   * 世界诞生以来的总游戏分钟。唯一真相源 —— 天数与当天时刻都从它算。
   * 不存成两个字段是因为两个字段迟早会对不上（跨天时先写哪个都错一帧）。
   *
   * ⚠️ 这是**存**出来的，不是从种子算的。地形是「这个世界长什么样」，可以算；
   * 时刻是「玩家走到了哪一步」，属于进度，必须落盘。
   */
  worldMinutes: number
  /** 时间流速：现实 1 秒推进多少游戏分钟。0 = 冻结 */
  timeScale: number
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
    // 第 0 天 08:00。刻意不随机 —— 新世界一进去就是深夜、屏幕一片黑，
    // 第一印象就砸了
    worldMinutes: 480,
    timeScale: DEFAULT_TIME_SCALE,
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
