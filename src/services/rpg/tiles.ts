/**
 * 图块图集的布局约定与程序化像素图生成。
 *
 * `public/` 里目前没有任何场景素材，而 HD-2D 的观感几乎全靠美术。
 * 这里用 canvas 现画一套**占位**像素图集：结构、尺寸、采样方式都按真素材
 * 来设计，将来换图只改 `AssetManifest`，渲染与逻辑一行不动。
 *
 * 纯 service：不 import vue/pinia。
 */

import { BIOME, type Biome } from './noise'
import { seededRandom } from '@/services/hash'

/** 单块图块的像素边长。32 是 HD-2D 常见档位，放大后颗粒清晰又不至于糊 */
export const TILE_PX = 32
/** 图集一行放几块。四种生态一行刚好 */
export const ATLAS_COLS = 4

/** 图块在图集里的列序号 —— 与 BIOME 的数值刻意一致，省一层查表 */
export const TILE_INDEX: Record<Biome, number> = {
  [BIOME.water]: 0,
  [BIOME.shallow]: 1,
  [BIOME.sand]: 2,
  [BIOME.grass]: 3,
}

/**
 * 每种生态的配色（由深到浅三档）。
 * 像素风的关键不是色数多，而是**同一色相里明度分层**够干脆。
 */
const PALETTE: Record<Biome, [string, string, string]> = {
  [BIOME.water]: ['#1b4b7a', '#2266a3', '#2f7fc4'],
  [BIOME.shallow]: ['#2f7fc4', '#49a0d8', '#7cc4ea'],
  [BIOME.sand]: ['#c2a878', '#d9c391', '#eadcb4'],
  [BIOME.grass]: ['#3f7a34', '#4f9441', '#63ad52'],
}

/**
 * 画一块图块。
 *
 * 用**确定性随机**撒噪点：同一种生态每次生成的图案完全一致，
 * 否则热更新一次地面就变一次，调参时根本没法比对。
 */
function paintTile(ctx: CanvasRenderingContext2D, ox: number, b: Biome): void {
  const pal = PALETTE[b]
  ctx.fillStyle = pal[0]
  ctx.fillRect(ox, 0, TILE_PX, TILE_PX)

  const rnd = seededRandom(0x5eed ^ (b * 0x9e37))
  // 两层噪点：先铺中间调，再点少量高光，出「颗粒感」而不是纯色块
  for (let i = 0; i < TILE_PX * 6; i++) {
    const x = Math.floor(rnd() * TILE_PX)
    const y = Math.floor(rnd() * TILE_PX)
    ctx.fillStyle = pal[1]
    ctx.fillRect(ox + x, y, 1, 1)
  }
  for (let i = 0; i < TILE_PX * 2; i++) {
    const x = Math.floor(rnd() * TILE_PX)
    const y = Math.floor(rnd() * TILE_PX)
    ctx.fillStyle = pal[2]
    ctx.fillRect(ox + x, y, 1, 1)
  }
}

/** 生成图块图集（一行 N 块）。返回可直接喂给 THREE.CanvasTexture 的 canvas */
export function buildTileAtlas(): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = TILE_PX * ATLAS_COLS
  cv.height = TILE_PX
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('无法创建图块图集的 2D 上下文')
  ctx.imageSmoothingEnabled = false
  for (const b of [BIOME.water, BIOME.shallow, BIOME.sand, BIOME.grass] as Biome[]) {
    paintTile(ctx, TILE_INDEX[b] * TILE_PX, b)
  }
  return cv
}

/** 场景装饰物的种类 */
export type PropKind = 'tree' | 'house' | 'bush'

/** 装饰物立绘的像素尺寸（宽 × 高）。房子比树宽、树比草丛高 */
export const PROP_SIZE: Record<PropKind, [number, number]> = {
  tree: [32, 48],
  house: [48, 40],
  bush: [24, 18],
}

/**
 * 画一株装饰物。全部画在透明底上，之后当 billboard 立在地面。
 *
 * 这些是**占位**：形状只求轮廓可辨（树是伞盖+树干，房子是坡顶+墙+门，
 * 草丛是几簇短弧），不追求细节 —— 细节等真素材。
 */
function paintProp(ctx: CanvasRenderingContext2D, kind: PropKind): void {
  const [w, h] = PROP_SIZE[kind]
  ctx.clearRect(0, 0, w, h)
  const px = (x: number, y: number, ww: number, hh: number, color: string) => {
    ctx.fillStyle = color
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(ww), Math.round(hh))
  }

  if (kind === 'tree') {
    px(w / 2 - 3, h - 14, 6, 14, '#6b4a2a') // 树干
    px(w / 2 - 2, h - 14, 2, 14, '#8a6338') // 树干高光
    // 伞盖：三层梯形，越往上越窄
    px(2, 10, w - 4, 14, '#2f6b2a')
    px(4, 4, w - 8, 12, '#3d8235')
    px(8, 0, w - 16, 10, '#4d9a41')
    px(10, 2, 6, 3, '#63ad52') // 高光
    return
  }
  if (kind === 'house') {
    px(4, h - 22, w - 8, 22, '#c9b48d') // 墙
    px(4, h - 22, w - 8, 2, '#e0cda8')
    // 坡顶
    px(0, h - 30, w, 9, '#8c3f35')
    px(4, h - 33, w - 8, 5, '#a24d41')
    px(w / 2 - 5, h - 14, 10, 14, '#5c4326') // 门
    px(8, h - 18, 7, 7, '#7fb6d8') // 窗
    px(w - 15, h - 18, 7, 7, '#7fb6d8')
    return
  }
  // bush
  px(2, h - 8, 8, 8, '#356e2d')
  px(8, h - 12, 10, 12, '#3f8134')
  px(16, h - 7, 6, 7, '#356e2d')
  px(10, h - 11, 4, 3, '#54a046')
}

/** 生成一张装饰物立绘 */
export function buildProp(kind: PropKind): HTMLCanvasElement {
  const [w, h] = PROP_SIZE[kind]
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('无法创建装饰物的 2D 上下文')
  ctx.imageSmoothingEnabled = false
  paintProp(ctx, kind)
  return cv
}

/**
 * 占位角色：一个 16×24 的小人，四帧行走。
 *
 * Spine 资源就位前用它顶上（见 rig.ts 的降级说明）。刻意画得简单 ——
 * 它的职责是「让切片能跑、能看出朝向与走动」，不是好看。
 */
export const CHAR_W = 16
export const CHAR_H = 24
export const CHAR_FRAMES = 4

export function buildCharacterSheet(tint = '#d9534f'): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = CHAR_W * CHAR_FRAMES
  cv.height = CHAR_H
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('无法创建角色图的 2D 上下文')
  ctx.imageSmoothingEnabled = false

  for (let f = 0; f < CHAR_FRAMES; f++) {
    const ox = f * CHAR_W
    // 腿的相位：0/2 并拢，1 左迈，3 右迈 —— 四帧循环出走路感
    const swing = f === 1 ? -1 : f === 3 ? 1 : 0
    ctx.fillStyle = '#3a2d22'
    ctx.fillRect(ox + 5 + swing, CHAR_H - 5, 3, 5)
    ctx.fillRect(ox + 9 - swing, CHAR_H - 5, 3, 5)
    ctx.fillStyle = tint
    ctx.fillRect(ox + 4, CHAR_H - 14, 8, 9) // 身体
    ctx.fillStyle = '#f0c9a0'
    ctx.fillRect(ox + 5, CHAR_H - 22, 6, 8) // 头
    ctx.fillStyle = '#2b2118'
    ctx.fillRect(ox + 5, CHAR_H - 22, 6, 3) // 头发
    ctx.fillRect(ox + 6, CHAR_H - 18, 1, 1) // 眼
    ctx.fillRect(ox + 9, CHAR_H - 18, 1, 1)
  }
  return cv
}
