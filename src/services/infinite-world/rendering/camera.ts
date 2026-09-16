/**
 * 相机：正交投影、固定 62° 俯角、**偏航恒为 0**。
 *
 * ## ⚠️ 偏航必须是 0，这不只是美术选择
 * 偏航为 0 时屏幕基向量是常量：
 *
 *     right   = (1, 0, 0)
 *     up      = (0, cos62°, -sin62°)
 *     forward = (0, -sin62°, -cos62°)
 *
 * 于是 `up · forward = 0` —— 沿 up 移动**完全不改变深度**。
 * 这条性质是整套精灵管线的地基：屏幕对齐四边形的整片深度恒等于脚底深度，
 * 所以「草丛 / 树冠 / 角色互相穿插」这个风险在这套相机下**结构上不存在**，
 * 不是靠调排序压下去的。
 *
 * 改俯角可以（重算一下 up 即可），**改偏航会让这条性质失效**，
 * 精灵排序会立刻需要每帧重排。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import { CHUNK, PITCH, TILE_PX, WORLD_SIZE } from '../core/constants'

/** 相机到焦点的距离。正交投影下只影响近远裁剪，不影响成像大小 */
const CAM_DISTANCE = 200

/** 精灵外扩余量（格）。最高的树约 3.5 世界单位，换算到地面 Z 约 4，取 8 兜住 */
const SPRITE_MARGIN = 8

export interface WorldCamera {
  camera: THREE.OrthographicCamera
  /** 可见半径的平方（世界格）。chunk 剔除用 */
  viewR2: number
  /** 把相机移到焦点上方 */
  focus(x: number, y: number): void
  /** 视口变化时重算投影与 viewR2 */
  resize(widthPx: number, heightPx: number): number
}

export function createWorldCamera(): WorldCamera {
  const camera = new THREE.OrthographicCamera(-12, 12, 9, -9, 1, CAM_DISTANCE * 2)
  let viewR2 = 60 * 60

  const focus = (x: number, y: number) => {
    camera.position.set(x, Math.sin(PITCH) * CAM_DISTANCE, y + Math.cos(PITCH) * CAM_DISTANCE)
    camera.lookAt(x, 0, y)
    // ⚠️ 这里必须重新看向焦点：OrthographicCamera 的 up 默认是 (0,1,0)，
    // lookAt 会据此算出无偏航的朝向 —— 正是我们要的
    camera.updateMatrixWorld()
  }

  const resize = (widthPx: number, heightPx: number): number => {
    const halfW = widthPx / 2 / TILE_PX
    const halfH = heightPx / 2 / TILE_PX
    camera.left = -halfW
    camera.right = halfW
    camera.top = halfH
    camera.bottom = -halfH
    camera.updateProjectionMatrix()

    // 地面上纵向被俯角拉长 1/sin θ；再加 chunk 半对角（判定用块心）与精灵外扩
    const r = Math.hypot(halfW, halfH / Math.sin(PITCH)) + CHUNK * 0.71 + SPRITE_MARGIN

    // ⚠️ 必须 clamp 在 (W - CHUNK)/2。越过它，同一块 chunk 的两个镜像
    // 可能同时入画 —— 「每块只画最近的那个镜像」这个前提会整个塌掉，
    // 表现为「远处出现一片和脚下一模一样的地形」
    const limit = (WORLD_SIZE - CHUNK) / 2
    viewR2 = Math.min(r, limit) ** 2
    return viewR2
  }

  return {
    camera,
    get viewR2() {
      return viewR2
    },
    focus,
    resize,
  }
}

/** 屏幕基向量。偏航恒为 0，所以它们是常量 —— 精灵着色器直接用 */
export const SCREEN_RIGHT = new THREE.Vector3(1, 0, 0)
export const SCREEN_UP = new THREE.Vector3(0, Math.cos(PITCH), -Math.sin(PITCH))
