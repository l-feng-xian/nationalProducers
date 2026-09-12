/**
 * 世界时钟与天色。
 *
 * ## 时钟为什么跟着 dt 走，而不是反推墙钟
 * NPC 的位置是玩家离开时存下的快照。用墙钟的话，隔三天再进游戏会落在一个随机
 * 时辰上，而全村人还站在三天前的位置 —— 一进门集体瞬移。世界在你不看的时候
 * 就该是停着的。而且 dt 早被 MAX_DT 夹住，切走标签页再回来不会快进，
 * 这一条是白捡的。
 *
 * ## 作息与天色共用同一张时段表
 * 分成两张迟早会出现「提示词说黄昏、画面已经全黑」这种对不上。
 *
 * 纯 service：不 import three / vue / pinia，可单独 import 跑断言。
 */

import type { RGB } from './palette'
// 常量定义在 types/ —— db 仓储层要用它回填，而那一层不依赖 services/
export { DEFAULT_TIME_SCALE } from '@/types/rpg'

export const MINUTES_PER_DAY = 1440

/**
 * 说完一句话推进的游戏分钟。
 *
 * 对话期间时钟是**冻结**的，每轮定额推进这么多。理由：模型花的是现实时间，
 * 但故事里你们只是交换了几句话。照现实时间走的话一次对话等于游戏里五小时，
 * 聊完对方「应该」早就不在原地，提示词里刚说的时段当场作废。
 */
export const TALK_MINUTES = 5

export interface WorldClock {
  /** 世界诞生以来的总游戏分钟（单调） */
  readonly total: number
  /** 第几天，0 起 */
  readonly day: number
  /** 当天第几分钟，0..1439 */
  readonly minuteOfDay: number
}

export function clockOf(total: number): WorldClock {
  const t = Math.max(0, total)
  return {
    total: t,
    day: Math.floor(t / MINUTES_PER_DAY),
    minuteOfDay: Math.floor(t % MINUTES_PER_DAY),
  }
}

/** '第 3 天 07:42' */
export function formatClock(c: WorldClock): string {
  const hh = String(Math.floor(c.minuteOfDay / 60)).padStart(2, '0')
  const mm = String(c.minuteOfDay % 60).padStart(2, '0')
  return `第 ${c.day + 1} 天 ${hh}:${mm}`
}

export type Phase = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'dusk' | 'night' | 'lateNight'

/** 时段边界（当天分钟）。作息表与天色**共用这一张表** */
const PHASES: ReadonlyArray<[number, Phase]> = [
  [270, 'dawn'],
  [390, 'morning'],
  [660, 'noon'],
  [780, 'afternoon'],
  [1020, 'dusk'],
  [1170, 'night'],
  [1380, 'lateNight'],
]

export function phaseOf(minuteOfDay: number): Phase {
  const m = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  let cur: Phase = 'lateNight' // 0:00~4:30 属于前一天的深夜
  for (const [from, p] of PHASES) {
    if (m >= from) cur = p
  }
  return cur
}

const PHASE_LABEL: Record<Phase, string> = {
  dawn: '拂晓',
  morning: '上午',
  noon: '正午',
  afternoon: '下午',
  dusk: '黄昏',
  night: '夜里',
  lateNight: '深夜',
}

export function phaseLabel(p: Phase): string {
  return PHASE_LABEL[p]
}

// ── 天色 ──

interface SkyKey {
  /** 当天分钟 */
  at: number
  /** 天空色 */
  sky: string
  /** 地面与角色的整体色调乘子（乘在烘焙顶点色上） */
  tint: string
  /** 灯火强度 0..1 */
  lamp: number
}

/**
 * 一天的天色关键帧。
 *
 * 这些 hex 一律按**肉眼看到的颜色**（sRGB）来写，`hexToRgb` 负责转成线性 ——
 * 见那里的说明，漏掉转换的话夜晚会亮得像阴天。
 *
 * ⚠️ 两条硬约束：
 * 1. **480 分（上午）的乘子必须是纯白** —— 白天与做这个特性之前**像素级一致**，
 *    于是整件事等于「现在这套是白天的样子」，回归风险为零。
 *    （纯白转换前后都是 1.0，这条不受色空间影响。）
 * 2. **最暗的夜、按 hex 的字面亮度算不低于约 0.42** —— 再暗手机在户外就看不清
 *    路了。注意这说的是 hex 本身，不是 skyAt 返回的线性值（那个约是 0.15）。
 * 另外 1440 必须与 0 同值，否则午夜会跳一下。
 */
const SKY_KEYS: readonly SkyKey[] = [
  { at: 0, sky: '#1b2438', tint: '#6b7590', lamp: 1 },
  { at: 270, sky: '#243049', tint: '#727c96', lamp: 1 },
  { at: 330, sky: '#8a7d93', tint: '#9d95a4', lamp: 0.7 },
  { at: 390, sky: '#e8c39a', tint: '#d8c6ae', lamp: 0.3 },
  { at: 480, sky: '#ece9df', tint: '#ffffff', lamp: 0 },
  { at: 780, sky: '#f2efe4', tint: '#fffdf6', lamp: 0 },
  { at: 1020, sky: '#ecdfc9', tint: '#f0dcbc', lamp: 0 },
  { at: 1110, sky: '#e0a878', tint: '#e6b489', lamp: 0.35 },
  { at: 1170, sky: '#8f6f82', tint: '#9a8393', lamp: 0.75 },
  { at: 1260, sky: '#2b3450', tint: '#78829c', lamp: 1 },
  { at: MINUTES_PER_DAY, sky: '#1b2438', tint: '#6b7590', lamp: 1 },
]

/**
 * sRGB 分量 → 线性分量。
 *
 * ⚠️ 这一步不能省。上面那些 hex 是**按肉眼看到的颜色**写的（sRGB），而消费方
 * `Color.setRGB()` 在 three 默认的工作色空间下是**直接当线性值**写进去的，
 * 渲染完再编码回 sRGB 输出。少这一次转换，线性 0.47 显示出来约是 0.72 ——
 * 于是「深夜」看上去只是个阴天的下午（22:39 的截图就是这么发现的）。
 *
 * 1.0 转换后仍是 1.0，所以「08:00 恒为纯白」那条硬约束不受影响。
 */
const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return {
    r: srgbToLinear(((n >> 16) & 0xff) / 255),
    g: srgbToLinear(((n >> 8) & 0xff) / 255),
    b: srgbToLinear((n & 0xff) / 255),
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const lerpRgb = (a: RGB, b: RGB, t: number): RGB => ({
  r: lerp(a.r, b.r, t),
  g: lerp(a.g, b.g, t),
  b: lerp(a.b, b.b, t),
})

export interface SkyState {
  sky: RGB
  tint: RGB
  lamp: number
  /** 有多少「太阳」：投影与云影按它淡出。0 = 全黑的夜 */
  sun: number
}

/** 某一刻的天色。关键帧之间线性插值 */
export function skyAt(minuteOfDay: number): SkyState {
  const m = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  let lo = SKY_KEYS[0] as SkyKey
  let hi = SKY_KEYS[SKY_KEYS.length - 1] as SkyKey
  for (let i = 0; i < SKY_KEYS.length - 1; i++) {
    const a = SKY_KEYS[i] as SkyKey
    const b = SKY_KEYS[i + 1] as SkyKey
    if (m >= a.at && m <= b.at) {
      lo = a
      hi = b
      break
    }
  }
  const span = hi.at - lo.at
  const t = span > 0 ? (m - lo.at) / span : 0
  return {
    sky: lerpRgb(hexToRgb(lo.sky), hexToRgb(hi.sky), t),
    tint: lerpRgb(hexToRgb(lo.tint), hexToRgb(hi.tint), t),
    lamp: lerp(lo.lamp, hi.lamp, t),
    // 灯火越亮说明太阳越少，正好互补
    sun: 1 - lerp(lo.lamp, hi.lamp, t),
  }
}
