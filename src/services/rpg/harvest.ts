/**
 * 采集玩法的**规则层**：有哪些工具、哪些道具能采、采出什么、多久长回来。
 *
 * 参考 jamfer.com/it/「小岛时光」的工具制交互：数字键选工具，对着目标按空格使用，
 * 上下文提示气泡随「手里拿什么 + 面前是什么」变化。
 *
 * 这里只有**数据与纯函数**，不碰世界、不碰存档、不碰渲染 —— 于是「砍树给几根木头」
 * 这类平衡性调整永远只改这一个文件。
 *
 * 纯 service：不 import vue/pinia。
 */

import type { PropKind } from './world'

/** 工具 id。空手也是一件「工具」—— 与参考站一致，它占第 1 格 */
export type ToolId = 'hand' | 'axe' | 'pick'

export interface Tool {
  id: ToolId
  name: string
  /** 快捷栏图标。用 emoji 而不是贴图：零资源、零加载，且在各平台都有字形 */
  icon: string
}

/** 快捷栏顺序即数字键顺序（1 起）。空手恒在第一格 */
export const TOOLS: readonly Tool[] = [
  { id: 'hand', name: '空手', icon: '✋' },
  { id: 'axe', name: '斧头', icon: '🪓' },
  { id: 'pick', name: '矿镐', icon: '⛏️' },
]

export type ItemId = 'wood' | 'stone' | 'branch' | 'flower' | 'veggie'

export interface ItemDef {
  id: ItemId
  name: string
  icon: string
}

export const ITEMS: Readonly<Record<ItemId, ItemDef>> = {
  wood: { id: 'wood', name: '木材', icon: '🪵' },
  stone: { id: 'stone', name: '石头', icon: '🪨' },
  branch: { id: 'branch', name: '树枝', icon: '🌿' },
  flower: { id: 'flower', name: '花', icon: '🌼' },
  veggie: { id: 'veggie', name: '蔬菜', icon: '🥬' },
}

export interface HarvestRule {
  /** 需要拿着哪件工具 */
  tool: ToolId
  item: ItemId
  /** 一次采几个 */
  count: number
  /**
   * 多久长回来，单位是**游戏分钟**。
   *
   * ⚠️ 不能照搬参考站的「10 分钟」—— 那是现实时间，而我们的时钟是游戏分钟
   * （默认流速下现实 1 秒 = 游戏 1 分，一整天 = 现实 24 分钟）。照搬的话树会在
   * 十秒内长回来，采集就失去了意义。这里按「游戏内几个小时」取值。
   */
  respawn: number
  /** 动作词，直接进提示气泡：「砍伐」「敲碎」「采摘」 */
  verb: string
}

/**
 * 哪些道具能采、怎么采。没列进来的（房屋、水井、篱笆、稻草人……）一律不可采 ——
 * 村子的构件被玩家拆光了会很难看，而且那是别人的家。
 */
export const HARVEST: Readonly<Partial<Record<PropKind, HarvestRule>>> = {
  tree: { tool: 'axe', item: 'wood', count: 2, respawn: 300, verb: '砍伐' },
  pine: { tool: 'axe', item: 'wood', count: 2, respawn: 300, verb: '砍伐' },
  rock: { tool: 'pick', item: 'stone', count: 1, respawn: 420, verb: '敲碎' },
  bush: { tool: 'hand', item: 'branch', count: 1, respawn: 180, verb: '采摘' },
  flower: { tool: 'hand', item: 'flower', count: 1, respawn: 120, verb: '采摘' },
  crop: { tool: 'hand', item: 'veggie', count: 1, respawn: 480, verb: '采摘' },
}

/** 这种道具能不能采 */
export function ruleFor(kind: PropKind): HarvestRule | undefined {
  return HARVEST[kind]
}

/** 道具的显示名，进提示气泡（「面向**橡树**·空格砍伐」） */
const PROP_LABEL: Partial<Record<PropKind, string>> = {
  tree: '树木',
  pine: '松树',
  rock: '石头',
  bush: '灌木',
  flower: '花丛',
  crop: '作物',
}

export function propLabel(kind: PropKind): string {
  return PROP_LABEL[kind] ?? '东西'
}

/** 采集覆盖层的格键。与 `y*W+x` 等价，但存档里是 JSON 对象，用字符串更可读可诊断 */
export function cellKey(x: number, y: number): string {
  return `${x},${y}`
}
