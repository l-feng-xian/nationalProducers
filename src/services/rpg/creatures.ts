/**
 * 鱼与虫的**物种表**（参考「小岛时光」的钓鱼/捕虫）。
 *
 * 与伐木采石不同：鱼虫不是地图上的道具，而是**会动、会来会走的生物**。
 * 所以它们不进世界的确定性推导，也不进存档 —— 只在引擎里活着（见 engine 的
 * CreatureRt）。抓到才变成背包里的一件收藏品，那一件才落盘。
 *
 * 这么定的理由：把每条鱼的位置存进档既无意义（下次进来它早游走了）又会让存档
 * 随时间膨胀；而「离开再回来，鱼还在原地一动不动」反倒比重新生成更出戏。
 *
 * 纯数据 + 纯函数：不 import vue/pinia，也不碰世界与时钟。
 */

import type { ItemId, ToolId } from './harvest'

export type CreatureKind = 'fish' | 'bug'

export interface CreatureDef {
  id: string
  name: string
  kind: CreatureKind
  /** 抓到后进背包的东西 */
  item: ItemId
  /** 要拿什么才抓得到 */
  tool: ToolId
  /** 动作词，进提示气泡：「钓起」「捕捉」 */
  verb: string
  /** 抽取权重，越大越常见 */
  weight: number
  /** 只在夜里出现（参考站也有「有些昆虫和鱼只在晚上出现」） */
  nightOnly?: boolean
  /** 渲染用：颜色（'#rrggbb'）与体量（世界单位） */
  color: string
  size: number
}

export const CREATURES: readonly CreatureDef[] = [
  // ── 鱼：水面下的一团暗影，用鱼竿钓 ──
  {
    id: 'crucian',
    name: '鲫鱼',
    kind: 'fish',
    item: 'fish_crucian',
    tool: 'rod',
    verb: '钓起',
    weight: 5,
    color: '#2f3a3a',
    size: 0.5,
  },
  {
    id: 'bass',
    name: '鲈鱼',
    kind: 'fish',
    item: 'fish_bass',
    tool: 'rod',
    verb: '钓起',
    weight: 3,
    color: '#27343a',
    size: 0.68,
  },
  {
    id: 'koi',
    name: '锦鲤',
    kind: 'fish',
    item: 'fish_koi',
    tool: 'rod',
    verb: '钓起',
    weight: 1,
    color: '#c8502f',
    size: 0.8,
  },
  // ── 虫：草地上方一点点的小方块，用网捕 ──
  {
    id: 'butterfly',
    name: '蝴蝶',
    kind: 'bug',
    item: 'bug_butterfly',
    tool: 'net',
    verb: '捕捉',
    weight: 5,
    color: '#f0a6c4',
    size: 0.2,
  },
  {
    id: 'beetle',
    name: '甲虫',
    kind: 'bug',
    item: 'bug_beetle',
    tool: 'net',
    verb: '捕捉',
    weight: 3,
    color: '#4a6b3a',
    size: 0.22,
  },
  {
    id: 'firefly',
    name: '萤火虫',
    kind: 'bug',
    item: 'bug_firefly',
    tool: 'net',
    verb: '捕捉',
    weight: 2,
    nightOnly: true,
    color: '#ffe27a',
    size: 0.16,
  },
]

/**
 * 按权重抽一种当下会出现的生物。`r` 取 0..1。
 *
 * 夜行物种只在夜里进候选池 —— 白天抽不到萤火虫，夜里它才有 2/10 的份额。
 * 抽不到（理论上只会在候选池为空时）返回 undefined，调用方据此放弃这次生成。
 */
export function pickSpecies(
  kind: CreatureKind,
  r: number,
  isNight: boolean,
): CreatureDef | undefined {
  const pool = CREATURES.filter((c) => c.kind === kind && (isNight || !c.nightOnly))
  const total = pool.reduce((s, c) => s + c.weight, 0)
  if (total <= 0) return undefined
  let acc = Math.max(0, Math.min(0.999999, r)) * total
  for (const c of pool) {
    acc -= c.weight
    if (acc < 0) return c
  }
  return pool[pool.length - 1]
}
