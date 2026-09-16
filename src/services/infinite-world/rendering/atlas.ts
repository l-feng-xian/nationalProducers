/**
 * 遮罩图集纹理。
 *
 * 三套遮罩（organic / stepped / hard）各一张 4×4 的单通道图。
 * 它们是**程序化生成**的（见 grid/masks.ts），所以不需要网络加载、
 * 不需要等资源、也不会因为美术管线没跟上而卡住渲染。
 *
 * ⚠️ 必须 `LinearFilter` + 不生成 mipmap。
 * 遮罩是 4×4 拼在一张图上的，开 mipmap 后高层 mip 会把相邻形态混在一起 ——
 * 表现为「远处地表边界糊成一片，且颜色渗到隔壁形态里」。
 * 真正的贴图串色防护靠 DataArrayTexture（每帧独立 ClampToEdge），
 * 那是 AI 贴图到位后的事；遮罩这张小图直接关掉 mipmap 最省心。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import { MASK_ATLAS_PX, generateMaskAtlas } from '../grid/masks'
import type { MaskSetId } from '../grid/dualGrid'

export interface MaskTextures {
  get(set: MaskSetId): THREE.DataTexture
  dispose(): void
}

export function createMaskTextures(): MaskTextures {
  const sets: MaskSetId[] = ['organic', 'stepped', 'hard']
  const map = new Map<MaskSetId, THREE.DataTexture>()

  for (const set of sets) {
    const alpha = generateMaskAtlas(set)
    // 单通道存进 RGBA 的 R（WebGPU 对单通道纹理的支持面不齐，
    // 多花 4 倍显存换确定性 —— 这张图只有 256×256，总共 256 KB）
    const rgba = new Uint8Array(MASK_ATLAS_PX * MASK_ATLAS_PX * 4)
    for (let i = 0; i < alpha.length; i++) {
      rgba[i * 4] = alpha[i]!
      rgba[i * 4 + 1] = alpha[i]!
      rgba[i * 4 + 2] = alpha[i]!
      rgba[i * 4 + 3] = 255
    }
    const tex = new THREE.DataTexture(rgba, MASK_ATLAS_PX, MASK_ATLAS_PX, THREE.RGBAFormat)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    // 遮罩是纯几何数据，不是颜色 —— 不能走 sRGB 转换，否则 alpha 会被伽马曲线拉歪
    tex.colorSpace = THREE.NoColorSpace
    tex.needsUpdate = true
    map.set(set, tex)
  }

  return {
    get: (set) => map.get(set)!,
    dispose: () => {
      for (const t of map.values()) t.dispose()
      map.clear()
    },
  }
}
