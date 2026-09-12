/**
 * 角色渲染层的抽象。
 *
 * 游戏逻辑只认这个接口，不关心底下是 Spine 骨骼还是一张雪碧图。
 * 这样两件事各自独立：资源没到位时用占位小人照样能跑完整流程；
 * Spine 接上之后游戏逻辑一行不用改。
 *
 * ## 朝向的约定
 * 本项目的 Spine 角色是**横向立绘**（典型手游战斗单位），只有 standby/move
 * 这类侧面动作，没有朝上/朝下的行走。所以约定：
 *   左右 → 水平镜像；上下 → **沿用最近一次的水平朝向**。
 * 这是用横向素材做俯视世界的通行做法（早期的圣剑传说、奇想传说都这么干）。
 *
 * 纯 service：不 import vue/pinia。
 */

import type * as THREE_NS from 'three'
import { CHAR_FRAMES, CHAR_H, CHAR_W, buildCharacterSheet } from './tiles'

export type RigState = 'idle' | 'walk'

export interface CharacterRig {
  /** 挂进场景的根节点。位置由调用方设置 */
  readonly object: THREE_NS.Object3D
  /** 世界单位下的视觉高度，用于站位与深度排序 */
  readonly height: number
  /**
   * 按移动方向设朝向。传 (0,0) 表示没在动、保持当前朝向。
   * dy 单独不改变朝向 —— 见文件头「朝向的约定」。
   */
  setFacing(dx: number, dy: number): void
  play(state: RigState): void
  /** dt 单位是秒 */
  update(dt: number): void
  dispose(): void
}

/** 占位角色的世界高度（格）。24px 的小人按一格 32px 折算约 0.75 格，放大到 1.1 更像主角 */
const PLACEHOLDER_H = 1.1
/** 行走动画帧率 */
const WALK_FPS = 8

export interface PlaceholderOptions {
  THREE: typeof THREE_NS
  /** 相机俯角（弧度），billboard 要按它回正 */
  pitch: number
  tint?: string
}

/**
 * 程序化像素小人。
 *
 * Spine 资源缺失或版本不符时顶上 —— 它的职责是「让流程能跑、能看出朝向与走动」，
 * 不是好看。真正的角色走 SpineRig。
 */
export function createPlaceholderRig(opts: PlaceholderOptions): CharacterRig {
  const { THREE, pitch } = opts
  const sheet = buildCharacterSheet(opts.tint)
  const tex = new THREE.CanvasTexture(sheet)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.NoColorSpace
  // 雪碧图横向排帧：只显示其中一帧，靠 repeat/offset 取窗
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.repeat.set(1 / CHAR_FRAMES, 1)

  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5 })
  const geo = new THREE.PlaneGeometry(1, 1)
  const mesh = new THREE.Mesh(geo, mat)
  const aspect = CHAR_W / CHAR_H
  mesh.scale.set(PLACEHOLDER_H * aspect, PLACEHOLDER_H, 1)
  // 与装饰物同一套「立在地面且正对相机」的姿态
  mesh.rotation.set(-pitch, 0, 0)

  const root = new THREE.Group()
  root.add(mesh)

  let state: RigState = 'idle'
  let facing = 1
  let t = 0

  return {
    object: root,
    height: PLACEHOLDER_H,
    setFacing(dx) {
      if (dx > 0.01) facing = 1
      else if (dx < -0.01) facing = -1
      // dy 不改朝向
      mesh.scale.x = Math.abs(mesh.scale.x) * facing
    },
    play(s) {
      if (s !== state) {
        state = s
        t = 0
      }
    },
    update(dt) {
      t += dt
      // 站立只用第 0 帧，行走循环四帧
      const frame = state === 'walk' ? Math.floor(t * WALK_FPS) % CHAR_FRAMES : 0
      tex.offset.x = frame / CHAR_FRAMES
    },
    dispose() {
      geo.dispose()
      mat.dispose()
      tex.dispose()
    },
  }
}
