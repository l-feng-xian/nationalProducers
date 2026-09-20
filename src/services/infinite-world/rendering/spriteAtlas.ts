/**
 * 精灵图集：把 `public/world/v1/` 里 `kind:'sprite'` 的帧装成一张 `DataArrayTexture`。
 *
 * ## 为什么用 DataArrayTexture 而不是打包图集
 * 每帧是**独立一层**：`ClampToEdge` 在层内夹死，mipmap 逐层生成，
 * 缩小时绝不会串到隔壁精灵 —— 打包图集在缩小/mipmap 时必然渗边。
 *
 * ## ⚠️ 层尺寸必须一致，但精灵尺寸各不相同
 * 数组纹理要求每层同尺寸，而树 284×472、灌木、石头尺寸都不同。
 * 所以装载时把每个精灵**按内容包围盒等比缩放**、底边对齐地塞进一张
 * 固定的 `SPRITE_PX²` 方形层，四周透明留白。每帧记下内容高度占比 `hFrac`，
 * 渲染时据此把公告牌四边形缩放到目标世界高度。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import { heroGroupScales } from './heroScale'
import { spriteNormalPixels } from './spriteNormals'

/** 每层的边长（像素）。树最高，256 足够，再大只是浪费显存 */
export const SPRITE_PX = 256
/** 内容底边在层内的归一化位置（离顶）。留 2% 余量 */
export const SPRITE_FOOT_V = 0.98
/** 内容等比缩放后允许占据的最大边长占比 */
const FILL = 0.92

export interface SpriteFrameMeta {
  /** 数组纹理层号 */
  layer: number
  /** 内容高度 / SPRITE_PX（渲染时用它反算公告牌世界高度） */
  hFrac: number
  /** 内容宽度 / SPRITE_PX（建筑按占地宽度反算尺寸时用它，草木不用） */
  wFrac: number
}

export interface SpriteAtlas {
  texture: THREE.DataArrayTexture
  largeTexture?: THREE.DataArrayTexture
  normalTexture?: THREE.DataArrayTexture
  largeNormalTexture?: THREE.DataArrayTexture
  /** 帧名 → 元数据。查不到的帧名表示这张精灵还没生成 */
  meta: Map<string, SpriteFrameMeta>
  has(name: string): boolean
  dispose(): void
}

interface ManifestFrame {
  file: string
  kind: string
  w: number
  h: number
  /** Animation frames keep a common canvas, pivot and reference height. */
  pivot?: [number, number]
  frameHeight?: number
  tier?: number
}

export interface LoadSpriteOptions {
  baseUrl?: string
  maxAnisotropy?: number
  onMessage?: (text: string) => void
}

/** 空图集：一张 1×1 透明层，`has()` 恒 false。素材没到位时用它，精灵一律不渲染 */
function emptyAtlas(): SpriteAtlas {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)
  tex.needsUpdate = true
  return { texture: tex, meta: new Map(), has: () => false, dispose: () => tex.dispose() }
}

export async function loadSpriteAtlas(o: LoadSpriteOptions = {}): Promise<SpriteAtlas> {
  const base = o.baseUrl ?? '/world/v5'
  try {
    const res = await fetch(`${base}/manifest.json`)
    if (!res.ok) throw new Error(`manifest ${res.status}`)
    const manifest = (await res.json()) as { frames: Record<string, ManifestFrame> }

    const names = Object.entries(manifest.frames)
      .filter(([, f]) => f.kind === 'sprite')
      .map(([name]) => name)
    if (names.length === 0) return emptyAtlas()

    const meta = new Map<string, SpriteFrameMeta>()
    const heroImages = new Map<string, Decoded>()
    const heroHeights = new Map<string, number>()
    for (const name of names) {
      const spec = manifest.frames[name]!
      if (
        !/^(walk|idle|hero)-(down|up|left|right)(-|$)/.test(name) ||
        !spec.frameHeight ||
        !spec.pivot
      )
        continue
      const img = await decode(`${base}/${spec.file}`)
      heroImages.set(name, img)
      const solid = alphaBBox(img, 160)
      if (solid) heroHeights.set(name, solid.h)
    }
    const heroScales = heroGroupScales(heroHeights)
    const normals: THREE.DataArrayTexture[] = []
    const makeTier = async (large: boolean) => {
      const selected = names.filter((n) => (manifest.frames[n]!.tier === 512) === large)
      if (!selected.length) return undefined
      const px = large ? 512 : SPRITE_PX
      const layerBytes = px * px * 4
      const data = new Uint8Array(layerBytes * selected.length)
      const normalData = new Uint8Array(128 * 128 * 4 * selected.length)
      for (let i = 0; i < selected.length; i++) {
        const name = selected[i]!,
          spec = manifest.frames[name]!
        const img = heroImages.get(name) ?? (await decode(`${base}/${spec.file}`))
        const { layer, hFrac, wFrac } = normalize(img, spec, px, heroScales.get(name) ?? 1)
        heroImages.delete(name)
        data.set(layer, layerBytes * i)
        normalData.set(spriteNormalPixels(layer, px, name), 128 * 128 * 4 * i)
        meta.set(name, { layer: i + (large ? 1024 : 0), hFrac, wFrac })
      }
      const tex = new THREE.DataArrayTexture(data, px, px, selected.length)
      tex.format = THREE.RGBAFormat
      tex.type = THREE.UnsignedByteType
      tex.colorSpace = THREE.SRGBColorSpace
      // ⚠️ 层内独立，用 ClampToEdge —— 精灵不平铺，绝不能 Repeat
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.magFilter = THREE.LinearFilter
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.generateMipmaps = true
      if (o.maxAnisotropy && o.maxAnisotropy > 1) tex.anisotropy = Math.min(8, o.maxAnisotropy)
      tex.needsUpdate = true
      const normal = new THREE.DataArrayTexture(normalData, 128, 128, selected.length)
      normal.format = THREE.RGBAFormat
      normal.magFilter = normal.minFilter = THREE.LinearFilter
      normal.needsUpdate = true
      normals[large ? 1 : 0] = normal
      o.onMessage?.(`精灵图集 ${selected.length} 层 ${px}²`)
      return tex
    }
    const tex = (await makeTier(false)) ?? emptyAtlas().texture
    const largeTexture = await makeTier(true)
    return {
      texture: tex,
      largeTexture,
      normalTexture: normals[0],
      largeNormalTexture: normals[1],
      meta,
      has: (n) => meta.has(n),
      dispose: () => {
        tex.dispose()
        largeTexture?.dispose()
        normals.forEach((n) => n.dispose())
      },
    }
  } catch (e) {
    o.onMessage?.(`精灵图集未载入（${(e as Error)?.message ?? e}）`)
    return emptyAtlas()
  }
}

/** 把一帧按内容包围盒等比缩放、底边对齐塞进 SPRITE_PX 方层 */
function normalize(
  img: Decoded,
  meta: ManifestFrame,
  SPRITE_PX = 256,
  animationScale = 1,
): { layer: Uint8Array; hFrac: number; wFrac: number } {
  const box = alphaBBox(img)
  const canvas = document.createElement('canvas')
  canvas.width = SPRITE_PX
  canvas.height = SPRITE_PX
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })!
  ctx.clearRect(0, 0, SPRITE_PX, SPRITE_PX)

  if (box) {
    const fixed = meta.frameHeight && meta.pivot
    const source = fixed ? { x: 0, y: 0, w: img.width, h: img.height } : box
    const scale =
      (animationScale * (FILL * SPRITE_PX)) / (fixed ? meta.frameHeight! : Math.max(box.w, box.h))
    const dw = source.w * scale
    const dh = source.h * scale
    const dx = fixed ? SPRITE_PX / 2 - meta.pivot![0] * dw : (SPRITE_PX - dw) / 2
    const dy = SPRITE_FOOT_V * SPRITE_PX - (fixed ? meta.pivot![1] * dh : dh)
    // 把源图搬进一个临时 canvas 再缩放绘制（drawImage 需要可绘制源）
    const src = document.createElement('canvas')
    src.width = img.width
    src.height = img.height
    src.getContext('2d', { colorSpace: 'srgb' })!.putImageData(toImageData(img), 0, 0)
    ctx.drawImage(src, source.x, source.y, source.w, source.h, dx, dy, dw, dh)
    const out = ctx.getImageData(0, 0, SPRITE_PX, SPRITE_PX, { colorSpace: 'srgb' })
    const layer = new Uint8Array(out.data.buffer.slice(0))
    bleedTransparentEdges(layer, SPRITE_PX, SPRITE_PX)
    return { layer, hFrac: fixed ? FILL : dh / SPRITE_PX, wFrac: (box.w * scale) / SPRITE_PX }
  }
  const out = ctx.getImageData(0, 0, SPRITE_PX, SPRITE_PX, { colorSpace: 'srgb' })
  return { layer: new Uint8Array(out.data.buffer.slice(0)), hFrac: 1, wFrac: 1 }
}

/** Canvas clears RGB at alpha=0. Extend edge colors before GPU filtering to avoid dark halos. */
export function bleedTransparentEdges(data: Uint8Array, width: number, height: number): void {
  const count = width * height
  const seen = new Uint8Array(count)
  const queue = new Int32Array(count)
  let head = 0
  let tail = 0
  for (let i = 0; i < count; i++) {
    // Near-zero alpha from chroma extraction can contain saturated matte RGB.
    // Do not use those almost invisible pixels as color sources for the mip fringe.
    if (data[i * 4 + 3]! <= 8) data[i * 4 + 3] = 0
    else {
      seen[i] = 1
      queue[tail++] = i
    }
  }
  // Eight texels cover the relevant mip footprint without filling the whole canvas.
  for (let ring = 0; ring < 8; ring++) {
    const end = tail
    while (head < end) {
      const i = queue[head++]!
      const x = i % width
      const neighbours = [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width]
      for (const j of neighbours) {
        if (j < 0 || j >= count || seen[j]) continue
        seen[j] = 1
        for (let c = 0; c < 3; c++) data[j * 4 + c] = data[i * 4 + c]!
        queue[tail++] = j
      }
    }
  }
}

interface Decoded {
  data: Uint8ClampedArray
  width: number
  height: number
}

function toImageData(img: Decoded): ImageData {
  // ⚠️ 拷进新的 Uint8ClampedArray：getImageData 的 buffer 类型被推成
  // ArrayBufferLike（可能 SharedArrayBuffer），ImageData 构造器只吃 ArrayBuffer
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
}

function alphaBBox(
  img: Decoded,
  threshold = 12,
): { x: number; y: number; w: number; h: number } | null {
  const { data, width, height } = img
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! < threshold) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

async function decode(url: string): Promise<Decoded> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  const bitmap = await createImageBitmap(await res.blob())
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })!
    ctx.drawImage(bitmap, 0, 0)
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' })
    return { data: img.data, width: img.width, height: img.height }
  } finally {
    bitmap.close()
  }
}
