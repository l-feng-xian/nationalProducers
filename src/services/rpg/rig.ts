/**
 * 角色渲染层的抽象。
 *
 * 游戏逻辑只认这个接口，不关心底下是什么 —— 当前实现是 figureRig.ts 的
 * 程序化方块小人（顶点色 + 烘焙明暗，与地形同一套管线）。
 *
 * ## 朝向的约定
 * rig 的根节点被场景摆到 (x, 地表高度, y)，自身 +Z 朝相机。setFacing(dx, dy)
 * 给出移动/注视方向，rig 内部把 yaw 平滑转向 atan2(dx, dy) ——
 * 八个方向全部有效（旧横向立绘时代「上下沿用水平朝向」的约定已废弃）。
 *
 * 纯 service：不 import vue/pinia。
 */

import type * as THREE_NS from 'three'

export type RigState = 'idle' | 'walk'

export interface CharacterRig {
  /** 挂进场景的根节点。位置由调用方设置 */
  readonly object: THREE_NS.Object3D
  /** 世界单位下的视觉高度，用于站位与深度排序 */
  readonly height: number
  /**
   * 按移动/注视方向设朝向。传 (0,0) 表示没在动、保持当前朝向。
   */
  setFacing(dx: number, dy: number): void
  play(state: RigState): void
  /** dt 单位是秒 */
  update(dt: number): void
  dispose(): void
}
