/**
 * 地表材质：AI 出的可平铺贴图 → 一张 `DataArrayTexture`。
 *
 * ## ⚠️ 这不是方案里否掉的那种「打包图集」
 * 方案的结论是「可平铺材质不能塞进打包图集」，理由是：图集里的一帧被邻居包着，
 * `RepeatWrapping` 会绕到隔壁帧上去，mipmap 更会把邻居混进来。
 *
 * `DataArrayTexture` 不是那种图集 —— **每一层是一张独立的图**：
 *   - `RepeatWrapping` 在层**内部**绕回，绕不到别的层
 *   - mipmap 逐层生成（三条后端路径都是按 `baseArrayLayer` 循环的）
 *   - 层号是采样的第三个坐标，不参与插值
 * 所以它同时满足「一次 draw call 画完一层的所有格子」和「平铺零串色」。
 *
 * ## 世界空间 UV，不是逐格 UV
 * UV 取 `(世界坐标)/TILE_WORLD` 而不是每格 0..1。逐格 UV 会让每一格都是**同一张图的副本**，
 * 缩到远处就是一片整齐的方格纹 —— 这正是程序化地形最容易露馅的地方。
 * 世界空间 UV 让贴图横跨若干格连续铺开，格子边界在画面上消失。
 *
 * ⚠️ **`TILE_WORLD` 必须整除 `WORLD_SIZE`**。否则环面接缝处 UV 从 `512/TILE_WORLD`
 * 跳回 0，不是整数圈就对不上，接缝上会出现一条一格宽的错位带。
 * 下面有断言。
 *
 * ## 缺素材时不能炸
 * `public/world/v1/` 是素材管线的产物，仓库里可能还没有（G2 之前只有 4 张）。
 * 载不到就退回「1×1 白 + 纯色 tint」——画面等同于贴图接入之前，引擎照常跑。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import { WORLD_SIZE } from '../core/constants'

/** 一张贴图横跨多少个世界格。⚠️ 必须整除 WORLD_SIZE，见文件头 */
export const TILE_WORLD = 8

if (WORLD_SIZE % TILE_WORLD !== 0) {
  throw new Error(`TILE_WORLD=${TILE_WORLD} 不整除 WORLD_SIZE=${WORLD_SIZE}，环面接缝会错位`)
}

/**
 * 交给 chunkBuild 的纯数据（**刻意不含任何 three 类型**）。
 * chunkBuild 不 import three 是有意的设计，见那个文件的头注释。
 */
export interface GroundPalette {
  /** 材质名 → 数组纹理的层号。查不到的名字由 `indexOf` 沿替身链兜底 */
  indexOf(name: string): number
  /**
   * 材质名 → **实际被采样的**那张贴图的名字（沿替身链解析之后）。
   *
   * 有专属贴图时返回它自己；还没出图时返回顶替它的那张；一张都没载到时返回 null。
   * 调用方（chunkBuild）拿它算色调补偿 —— 「想要的参考色 ÷ 借来的参考色」，
   * 同名时恰好是 1。G2 补齐贴图之后这个函数会自然开始返回自身，色调补偿自动归 1。
   */
  sourceOf(name: string): string | null
  /** 真的载到贴图了吗。false 表示当前是纯色兜底 */
  readonly ready: boolean
}

export interface GroundTextures {
  array: THREE.DataArrayTexture
  palette: GroundPalette
  dispose(): void
}

/**
 * 还没出图的材质借谁的贴图。
 *
 * 只写「缺 → 借」这一个方向，`indexOf` 顺着链找到第一个真的存在的。
 * G2 出完图之后这张表会自然失效（每个名字都能直接命中），不用删。
 */
const STAND_IN: Record<string, string> = {
  'forest-floor': 'grass-meadow',
  'grass-dry': 'grass-meadow',
  sand: 'dirt-path',
  marsh: 'grass-meadow',
  'water-deep': 'water-shallow',
  cobble: 'dirt-path',
  road: 'dirt-path',
}

interface ManifestFrame {
  file: string
  kind: string
  w: number
  h: number
}

interface Manifest {
  frames: Record<string, ManifestFrame>
}

export interface LoadGroundOptions {
  /** 素材根目录。带版本段做缓存破坏符 */
  baseUrl?: string
  /** 各向异性上限。62° 俯角下地表被压得很扁，这个值直接决定远处糊不糊 */
  maxAnisotropy?: number
  onMessage?: (text: string) => void
}

export async function loadGroundTextures(o: LoadGroundOptions = {}): Promise<GroundTextures> {
  const base = o.baseUrl ?? '/world/v1'
  try {
    const res = await fetch(`${base}/manifest.json`)
    if (!res.ok) throw new Error(`manifest ${res.status}`)
    const manifest = (await res.json()) as Manifest

    const names = Object.entries(manifest.frames)
      .filter(([, f]) => f.kind === 'tiling')
      .map(([name]) => name)
    if (names.length === 0) throw new Error('清单里没有可平铺材质')

    const images = await Promise.all(names.map((n) => decode(`${base}/${manifest.frames[n]!.file}`)))

    // ⚠️ 数组纹理要求每一层尺寸完全一致。切图脚本保证了这点，
    // 但素材是外部产物，这里必须自己确认 —— 尺寸不一致时
    // DataArrayTexture 不会报错，只会把后面的层读歪（画面像是花屏）
    const w = images[0]!.width
    const h = images[0]!.height
    for (let i = 0; i < images.length; i++) {
      const im = images[i]!
      if (im.width !== w || im.height !== h) {
        throw new Error(`${names[i]} 是 ${im.width}×${im.height}，与首层 ${w}×${h} 不一致`)
      }
    }

    const layer = w * h * 4
    const data = new Uint8Array(layer * images.length)
    const index: Record<string, number> = {}
    for (let i = 0; i < images.length; i++) {
      data.set(images[i]!.data, layer * i)
      index[names[i]!] = i
    }

    const array = makeArrayTexture(data, w, h, images.length, o.maxAnisotropy)
    o.onMessage?.(`地表材质 ${images.length} 层 ${w}×${h}`)
    return { array, palette: makePalette(index, true), dispose: () => array.dispose() }
  } catch (e) {
    // 素材还没生成、或路径不对：退回纯色。引擎照常跑，只是没有贴图
    o.onMessage?.(`地表贴图未载入（${(e as Error)?.message ?? e}），使用纯色`)
    const white = new Uint8Array([255, 255, 255, 255])
    const array = makeArrayTexture(white, 1, 1, 1, undefined)
    array.generateMipmaps = false
    array.minFilter = THREE.LinearFilter
    return {
      array,
      palette: makePalette({}, false),
      dispose: () => array.dispose(),
    }
  }
}

function makePalette(index: Record<string, number>, ready: boolean): GroundPalette {
  /** 顺着替身链找第一个真的存在的名字 */
  const resolve = (name: string): string | null => {
    const seen = new Set<string>()
    let cur: string | undefined = name
    while (cur && !seen.has(cur)) {
      if (cur in index) return cur
      seen.add(cur)
      cur = STAND_IN[cur]
    }
    return null
  }
  return {
    ready,
    indexOf: (name) => {
      const hit = resolve(name)
      return hit === null ? 0 : index[hit]!
    },
    sourceOf: resolve,
  }
}

function makeArrayTexture(
  data: Uint8Array,
  w: number,
  h: number,
  depth: number,
  maxAnisotropy: number | undefined,
): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(data, w, h, depth)
  tex.format = THREE.RGBAFormat
  tex.type = THREE.UnsignedByteType
  // 贴图是**颜色**，必须声明 sRGB 让 three 采样时转线性。
  // 漏了这条的症状是整片地表发白——与 chunkBuild.toLinear 那条注释是同一类坑
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  // ⚠️ 62° 俯角下地表在屏幕上被压到约 0.47 倍，纵横方向的缩小率差一倍。
  // 不开各向异性时 GPU 只能按较大的那个缩小率选 mip，远处描边会直接糊掉 ——
  // 这正是 G1 那条「0.5×/0.25× 下描边不糊」要防的
  if (maxAnisotropy && maxAnisotropy > 1) tex.anisotropy = Math.min(8, maxAnisotropy)
  tex.needsUpdate = true
  return tex
}

interface Decoded {
  data: Uint8ClampedArray
  width: number
  height: number
}

async function decode(url: string): Promise<Decoded> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  const bitmap = await createImageBitmap(await res.blob())
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    // ⚠️ willReadFrequently 之外还要 colorSpace:'srgb'。默认画布在广色域屏上
    // 可能是 display-p3，getImageData 拿到的就不是原始 sRGB 字节了 ——
    // 症状是「同一份素材在不同显示器上颜色不一样」，极难复现
    const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
    if (!ctx) throw new Error('拿不到 2d 上下文')
    ctx.drawImage(bitmap, 0, 0)
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' })
    return { data: img.data, width: img.width, height: img.height }
  } finally {
    bitmap.close()
  }
}
