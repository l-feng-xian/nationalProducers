/**
 * 地形配色与 RGB 小工具。
 *
 * 从 blocks.ts 拆出来，因为**创建向导的缩略预览也要用同一套颜色** —— 预览与
 * 实际进游戏看到的地不一致的话，那张图就没有参考价值。而 blocks.ts 是 26 KB
 * 的方块几何构建器，为了四个颜色把它整个拖进向导那个路由不划算。
 *
 * blocks.ts 仍然 re-export 这里的东西，既有 import 一个都不用改。
 *
 * 纯数据：不 import three / vue / pinia。
 */

export interface RGB {
  r: number
  g: number
  b: number
}

/** '#rrggbb' → 0..1 分量 */
export function rgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
  }
}

/** 草地按台阶等级由深到浅 —— 越高越亮，梯田的层次全靠它 */
const GRASS_LEVEL_HEX = [
  '#7eb468',
  '#86bb70',
  '#8ec279',
  '#96c981',
  '#9ed08a',
  '#a6d793',
  '#aede9b',
  '#b6e5a4',
  '#beecad',
]

export const TERRAIN = {
  grassLevels: GRASS_LEVEL_HEX.map(rgb),
  /** 地块侧面（土崖） */
  dirt: rgb('#c8a06e'),
  /** 水下海床（隔着水面看） */
  waterBed: rgb('#b3a878'),
  /** 浅滩海床 */
  shallowBed: rgb('#d0c493'),
  sand: rgb('#e6d7a8'),
  /** 村道 */
  path: rgb('#d9c39a'),
  /** 深水水面 */
  waterDeep: rgb('#9fd4cf'),
  /** 浅滩水面 */
  waterShallow: rgb('#b8e4dd'),
}

/** 0..1 分量 → 'rgb(r,g,b)'，给 canvas 2D 用 */
export function cssOf(c: RGB): string {
  return `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`
}
