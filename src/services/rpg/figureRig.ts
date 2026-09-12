/**
 * 程序化方块小人。
 *
 * 参考图里的村民：大_HEAD 方块身躯、四肢摆动的行走、草帽农夫。
 * 全部几何由 blocks.ts 的 MeshBuilder 生成（顶点色 + 烘焙明暗，与地形同管线），
 * 每个身体部件一个 Mesh 挂在自己的 pivot Group 下，动画就是转 pivot。
 *
 * ## 每个部件为什么要独立 Mesh
 * 四肢要各自绕肩/髋摆动，合并成一个几何就做不到顶点级骨骼变换 ——
 * 6 个小 mesh 的 draw call 成本可以忽略（NPC 通常个位数）。
 *
 * ## 配色
 * 玩家固定「草帽 + 蓝背带裤」农夫造型；NPC 用 id 哈希从低饱和调色板取色，
 * 同一个 NPC 每次进世界都长得一样，不同 NPC 各不相同。
 *
 * ## 动画相位
 * 每个 rig 的相位随机 —— 否则所有 NPC 同频呼吸、同帧迈腿，非常出戏
 * （这是当年 Spine 共享 SkeletonData 踩过的同一个坑）。
 *
 * 纯 service：不 import vue/pinia。
 */

import { MeshBuilder, addShadowFan, rgb, type RGB } from './blocks'
import type { CharacterRig, RigState } from './rig'
import type * as THREE_NS from 'three'
import { seededRandom } from '@/services/hash'

/** 小人的世界高度（格）。方块比例下略矮胖，比 1.7 的旧立绘更 Q */
const FIGURE_H = 1.55
/** 行走步频（弧度/秒）。9 ≈ 每秒一步半，配合 5.2 格/秒的移速 */
const WALK_FREQ = 9

const SKIN: RGB[] = ['#f2c9a4', '#e8b98c', '#d9a878', '#c69069', '#a9744f'].map(rgb)
const SHIRT: RGB[] = [
  '#d95f4e',
  '#5f9ea0',
  '#e0a34e',
  '#7aa95c',
  '#8f7fbf',
  '#c97b9e',
  '#6f8fc9',
].map(rgb)
const PANTS: RGB[] = ['#5a6b7c', '#7a5a44', '#4e6151', '#6e5a6e', '#8a6f4d'].map(rgb)
const HAIR: RGB[] = ['#3a2d22', '#6b4a2a', '#2b2118', '#8a6338', '#c9a05a'].map(rgb)
const STRAW = rgb('#e8c968')
const EYE = rgb('#2b2118')

export interface FigureOptions {
  THREE: typeof THREE_NS
  /** NPC 配色种子（如 fnv1a(npc.id)）。玩家模式忽略 */
  seed?: number
  /** 玩家固定造型：草帽 + 蓝背带裤 */
  player?: boolean
}

export function createFigureRig(opts: FigureOptions): CharacterRig {
  const { THREE } = opts

  // ── 配色 ──
  let skin: RGB
  let shirt: RGB
  let pants: RGB
  let hair: RGB
  let strawHat: boolean
  if (opts.player) {
    skin = SKIN[0]!
    shirt = rgb('#efe2c8') // 米白衬衫袖
    pants = rgb('#4f7fb5') // 蓝背带裤
    hair = HAIR[1]!
    strawHat = true
  } else {
    const rnd = seededRandom(opts.seed ?? 0)
    skin = SKIN[Math.floor(rnd() * SKIN.length)]!
    shirt = SHIRT[Math.floor(rnd() * SHIRT.length)]!
    pants = PANTS[Math.floor(rnd() * PANTS.length)]!
    hair = HAIR[Math.floor(rnd() * HAIR.length)]!
    strawHat = rnd() < 0.3 // 村里三成人也戴草帽
  }

  const mat = new THREE.MeshBasicMaterial({ vertexColors: true })
  const geos: THREE_NS.BufferGeometry[] = []
  const part = (paint: (b: MeshBuilder) => void): THREE_NS.Mesh => {
    const b = new MeshBuilder()
    paint(b)
    const g = b.toGeometry(THREE)
    geos.push(g)
    return new THREE.Mesh(g, mat)
  }

  // ── 身体结构。局部坐标：脚底 y=0，+Z 面向相机 ──
  // 腿：髋部 pivot 在 0.55，迈步时绕 X 摆
  const legL = new THREE.Group()
  legL.position.set(-0.14, 0.55, 0)
  legL.add(part((b) => b.box(0, -0.275, 0, 0.2, 0.55, 0.24, pants)))
  const legR = new THREE.Group()
  legR.position.set(0.14, 0.55, 0)
  legR.add(part((b) => b.box(0, -0.275, 0, 0.2, 0.55, 0.24, pants)))

  // 躯干+头+手臂挂在 bodyGroup 下，行走起伏/待机呼吸整体动
  const body = new THREE.Group()
  body.add(part((b) => b.box(0, 0.82, 0, 0.56, 0.54, 0.34, shirt)))
  // 背带裤：胸前一小块裤子色盖在衬衫上，玩家是蓝背带 + 米白衫
  body.add(part((b) => b.box(0, 0.76, 0.18, 0.34, 0.4, 0.02, pants)))

  const head = new THREE.Group()
  head.position.set(0, 1.09, 0)
  head.add(part((b) => b.box(0, 0.19, 0, 0.44, 0.38, 0.38, skin)))
  // 眼睛贴在 +Z 脸上
  head.add(
    part((b) => {
      b.box(-0.09, 0.22, 0.2, 0.05, 0.06, 0.02, EYE)
      b.box(0.09, 0.22, 0.2, 0.05, 0.06, 0.02, EYE)
    }),
  )
  head.add(
    part((b) => {
      if (strawHat) {
        // 草帽：宽帽檐 + 圆帽冠
        b.cylinder(0, 0.4, 0, 0.32, 0.32, 0.05, 8, STRAW)
        b.cylinder(0, 0.45, 0, 0.18, 0.2, 0.14, 8, STRAW)
      } else {
        b.box(0, 0.36, 0, 0.46, 0.1, 0.4, hair)
      }
    }),
  )
  body.add(head)

  const armL = new THREE.Group()
  armL.position.set(-0.36, 1.03, 0)
  armL.add(
    part((b) => {
      b.box(0, -0.2, 0, 0.14, 0.34, 0.18, shirt)
      b.box(0, -0.4, 0, 0.13, 0.1, 0.17, skin) // 手
    }),
  )
  const armR = new THREE.Group()
  armR.position.set(0.36, 1.03, 0)
  armR.add(
    part((b) => {
      b.box(0, -0.2, 0, 0.14, 0.34, 0.18, shirt)
      b.box(0, -0.4, 0, 0.13, 0.1, 0.17, skin)
    }),
  )
  body.add(armL, armR)

  const root = new THREE.Group()
  root.add(legL, legR, body)

  // 脚下接触阴影：贴地半透明椭圆,不随走路动画起伏。挂在 root 下会跟着
  // 转身一起转,但椭圆接近正圆,误差看不出来
  const extraMats: THREE_NS.Material[] = []
  {
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x243038,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    })
    const sb = new MeshBuilder()
    addShadowFan(sb, 0, 0, 0.02, 0.3, 0.26, 0)
    geos.push(sb.toGeometry(THREE))
    const shadowMesh = new THREE.Mesh(geos[geos.length - 1]!, shadowMat)
    shadowMesh.renderOrder = 1
    root.add(shadowMesh)
    extraMats.push(shadowMat)
  }

  let state: RigState = 'idle'
  /** 相位随机：NPC 之间不同步 */
  let t = Math.random() * 20
  /** 行走幅度 0..1，状态切换时平滑淡入淡出 */
  let walkAmp = 0
  let yaw = 0
  let targetYaw = 0

  return {
    object: root,
    height: FIGURE_H,
    setFacing(dx, dy) {
      if (dx * dx + dy * dy < 1e-4) return
      targetYaw = Math.atan2(dx, dy)
    },
    play(s) {
      state = s
    },
    update(dt) {
      t += dt
      const target = state === 'walk' ? 1 : 0
      walkAmp += (target - walkAmp) * Math.min(1, dt * 8)

      const ph = t * WALK_FREQ
      const swing = Math.sin(ph) * 0.6 * walkAmp
      const idle = Math.sin(t * 1.7) * 0.05 * (1 - walkAmp)
      legL.rotation.x = swing
      legR.rotation.x = -swing
      armL.rotation.x = -swing * 0.8 + idle
      armR.rotation.x = swing * 0.8 - idle
      // 行走起伏 + 待机呼吸（呼吸在走路时压掉，避免双重起伏）
      body.position.y = Math.abs(Math.cos(ph)) * 0.05 * walkAmp
      body.scale.y = 1 + Math.sin(t * 2.2) * 0.012 * (1 - walkAmp)

      // 平滑转身（走最短弧）
      let d = targetYaw - yaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      yaw += d * Math.min(1, dt * 10)
      root.rotation.y = yaw
    },
    dispose() {
      for (const g of geos) g.dispose()
      for (const m of extraMats) m.dispose()
      mat.dispose()
    },
  }
}
