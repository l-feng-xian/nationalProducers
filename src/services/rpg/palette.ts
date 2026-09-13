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

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055

/**
 * '#rrggbb' → 0..1 的**线性**分量。
 *
 * ⚠️ 这里必须转换，而且这是整张地图「发灰发白」的总根源。
 *
 * 这些颜色最终是写进**顶点色**的，而 three 把顶点色当线性量，渲染完再统一
 * 编码回 sRGB 输出。原先只做了 `/255`，等于把 sRGB 数值当线性用 ——
 * 输出时被整体提亮一大截：`#4f9a45` 这样一个饱和中绿，实际显示出来是
 * `#96cc8f`（惨白的抹茶色）。整张世界因此像蒙了一层雾，
 * 而调色板里写的是什么颜色根本对不上眼睛看到的。
 *
 * 与 time.ts 里天色的处理完全同源，那边也踩过一次（见 SKY_KEYS 上方）。
 */
export function rgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return {
    r: srgbToLinear(((n >> 16) & 0xff) / 255),
    g: srgbToLinear(((n >> 8) & 0xff) / 255),
    b: srgbToLinear((n & 0xff) / 255),
  }
}

/**
 * 草地按台阶等级由深到浅 —— 越高越亮，梯田的层次全靠它。
 *
 * ⚠️ 这条色阶**刻意压窄**。原先是 #7eb468 → #beecad，跨度太大，高处的台阶
 * 褪成接近白的浅绿，整张图看上去是「蒙了层雾的沙盘」而不是草地。参考图里
 * 地面自始至终是饱和的中绿，层次只靠细微明度差来读。
 */
const GRASS_LEVEL_HEX = [
  '#4f9a45',
  '#57a24b',
  '#5faa52',
  '#67b258',
  '#6fba5f',
  '#77c266',
  '#7fca6c',
  '#87d273',
  '#8fda7a',
]

export const TERRAIN = {
  grassLevels: GRASS_LEVEL_HEX.map(rgb),
  /** 地块侧面（土崖） */
  dirt: rgb('#cba372'),
  /** 水下海床（隔着水面看） */
  waterBed: rgb('#9e8f63'),
  /** 浅滩海床 */
  shallowBed: rgb('#c8b784'),
  sand: rgb('#e8d49c'),
  /** 村道。参考图里是暖陶土砖，不是浅沙 —— 村子因此能从草地里跳出来 */
  path: rgb('#cf9f6e'),
  /** 深水水面 */
  waterDeep: rgb('#59c2c0'),
  /** 浅滩水面 */
  waterShallow: rgb('#8adedb'),
}

/**
 * 生态分区的地表**染色系数**（需求 2：让生态分界更明显）。
 *
 * 是**乘在草色上**的系数，不是替换色 —— 这样台阶明暗（grassLevels 的层次）
 * 原样保留，只是整片森林偏冷深、草甸偏亮暖、干草原偏橄榄土黄，一眼能分出
 * 三种地。系数写在线性空间（草色本就是线性），各分量都 <1/略 >1，不会把
 * 顶点色顶爆。只作用于**草**格；沙/水/村道各有自己的颜色，不染。
 *
 * ⚠️ 与 scene.ts、WorldPreview 共用同一张表，游戏里与缩略图才配得上。
 */
export const REGION_TINT: Record<'forest' | 'meadow' | 'wilds', RGB> = {
  forest: { r: 0.86, g: 1.02, b: 0.8 },
  meadow: { r: 1.06, g: 1.05, b: 0.82 },
  wilds: { r: 1.04, g: 0.94, b: 0.66 },
}

/** 分量相乘（染色）。放这里让 scene 与预览共用同一处 */
export function tintOf(c: RGB, t: RGB): RGB {
  return { r: c.r * t.r, g: c.g * t.g, b: c.b * t.b }
}

/**
 * 0..1 线性分量 → 'rgb(r,g,b)'，给 canvas 2D 用。
 *
 * ⚠️ 必须转回 sRGB。canvas 2D 的 fillStyle 收的是 sRGB 数值，没有任何色彩管理；
 * 直接把线性值乘 255 递过去，创建向导的缩略图会比进游戏后看到的地形暗一大截 ——
 * 而那张图的全部价值就是「跟真的长一样」。
 */
export function cssOf(c: RGB): string {
  const b = (v: number): number => Math.round(Math.max(0, Math.min(1, linearToSrgb(v))) * 255)
  return `rgb(${b(c.r)},${b(c.g)},${b(c.b)})`
}
