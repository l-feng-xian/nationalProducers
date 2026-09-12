/**
 * 渲染场景：WebGPU 渲染器、固定 2.5D 相机、方块地形、生态装饰物、水面。
 *
 * ## 地形为什么一次预生成整张世界
 * 256×256 = 65536 根方块柱，合并进 32×32 的 chunk 网格后只有几十万三角形，
 * WebGPU/WebGL 都轻松。换来的是**游玩期零重建** —— 不用跟着玩家滚动重算
 * 视窗，环面回绕在建柱时就消化掉了。构建在进入游戏前一次性完成（页面
 * 本来就盖着「正在生成世界…」遮罩），每 4 个 chunk 让一帧出来，遮罩有机会
 * 刷新。渲染时只开玩家周围一圈 chunk（见 setPlayer 的可见性开关），
 * 视野外连遍历都不进，再由视锥剔除兜底。
 *
 * ## 为什么是正交相机
 * 固定俯角 + 斜向偏航 + 正交 = 经典 2.5D 倾斜视角（参考图的菱形沙盘）：
 * 透视会让远处的方块变形，而正交下整张地图的格子大小完全一致，梯台地形
 * 读起来是规整的方块感。WASD 仍是屏幕方向 —— 引擎按同一个 yaw 把输入
 * 旋进世界坐标（见 engine.ts），玩家手感与视角无关。
 *
 * ## 明暗为什么烘焙进顶点色
 * 太阳方向与相机角度恒定，建几何时把「面法线 · 太阳」乘进顶点色即可，
 * 全程 unlit（MeshBasicMaterial + vertexColors），见 blocks.ts。
 *
 * 纯 service：不 import vue/pinia。three 是动态 import，不进游戏页一个字节。
 */

import type * as THREE_NS from 'three'
import type { World, PropKind } from './world'
import { hashTile } from './world'
import type { CharacterRig } from './rig'
import {
  MeshBuilder,
  TERRAIN,
  addBench,
  addBush,
  addCrop,
  addFence,
  addFlower,
  addHaybale,
  addHaystack,
  addHouse,
  addLantern,
  addPine,
  addPropShadow,
  addRock,
  addScarecrow,
  addSignpost,
  addTree,
  addWell,
  type RGB,
} from './blocks'
import { BIOME, WATER_SURFACE_Y } from './noise'

/**
 * 每种道具的投影参数 [椭圆半径, 参考高度]。null = 太小不投影。
 * 高度只用来算阴影拉长量，不必精确。
 */
const PROP_SHADOW: Record<PropKind, [number, number] | null> = {
  tree: [0.55, 1.5],
  pine: [0.5, 1.55],
  bush: [0.26, 0.5],
  flower: null,
  house: [0.78, 1.35],
  well: [0.36, 0.95],
  haystack: [0.4, 0.65],
  haybale: [0.32, 0.45],
  fence: [0.38, 0.38],
  crop: null,
  scarecrow: [0.22, 1.15],
  rock: [0.26, 0.25],
  bench: [0.36, 0.42],
  lantern: [0.16, 1.1],
  signpost: [0.13, 1.0],
}

/** 相机俯角。用户在自由视角里定稿：32.4° 的低俯角让方块立面占屏更足 */
const PITCH_DEG = 32.4
/** 相机偏航。用户定稿 42.4°：菱形沙盘视角，同时露出 +X 与 +Z 两个方向的立面 */
const YAW_DEG = 42.4
/** 一格在屏幕上的目标像素高。决定整体缩放 —— 越小看得越远。43.2 = 定稿 zoom 1.35 × 32 */
const TILE_SCREEN_PX = 43.2
/** chunk 边长（格）。32 → 256² 的世界共 64 块，兼顾客机剔除与构建粒度 */
const CHUNK = 32
/** 背景色：参考图那种米白天空 */
const BACKGROUND = 0xece9df
/** 水面顶色的 alpha */
const WATER_ALPHA = 0.62
/** 云影平面的高度。要高于最高台阶(9×0.3=2.7)，低于相机(~64) */
const CLOUD_Y = 30

type WebGPURendererCtor = typeof import('three/webgpu').WebGPURenderer

export interface SceneHandle {
  readonly canvas: HTMLCanvasElement
  /** 当前后端，'webgpu' | 'webgl' —— UI 上要显示，也是回退验证的观测点 */
  readonly backend: string
  /** 相机偏航（弧度）。引擎要按它把屏幕方向的输入旋进世界坐标 */
  readonly yaw: number
  /** three 名字空间。three 是动态 import 的，外面建 rig 时拿不到，从这里取 */
  readonly THREE: typeof THREE_NS
  setPlayer(x: number, y: number): void
  /** 挂一个角色（玩家或 NPC）。重复挂是空操作 */
  addRig(rig: CharacterRig): void
  removeRig(rig: CharacterRig): void
  /** 把某个 rig 立到格坐标 (x,y) 的地表上。rig 自己负责朝向 */
  placeRig(rig: CharacterRig, x: number, y: number): void
  resize(w: number, h: number): void
  render(): void
  dispose(): void
}

export interface CreateSceneArgs {
  world: World
  /** 是否强制走 WebGL 后端。用于验证移动端回退路径 */
  forceWebGL?: boolean
}

/** 把某种装饰物的几何写进累加器。世界单位，(x, z) 是道具落点 */
function addPropGeometry(
  b: MeshBuilder,
  kind: PropKind,
  x: number,
  z: number,
  groundY: number,
  variant: number,
  rot: number,
): void {
  switch (kind) {
    case 'tree':
      addTree(b, x, z, groundY, variant)
      break
    case 'pine':
      addPine(b, x, z, groundY, variant)
      break
    case 'bush':
      addBush(b, x, z, groundY, variant)
      break
    case 'flower':
      addFlower(b, x, z, groundY, variant)
      break
    case 'house':
      addHouse(b, x, z, groundY, variant, rot)
      break
    case 'well':
      addWell(b, x, z, groundY)
      break
    case 'haystack':
      addHaystack(b, x, z, groundY, variant)
      break
    case 'haybale':
      addHaybale(b, x, z, groundY, variant)
      break
    case 'fence':
      addFence(b, x, z, groundY, rot)
      break
    case 'crop':
      addCrop(b, x, z, groundY, variant)
      break
    case 'scarecrow':
      addScarecrow(b, x, z, groundY, variant)
      break
    case 'rock':
      addRock(b, x, z, groundY, variant)
      break
    case 'bench':
      addBench(b, x, z, groundY, rot)
      break
    case 'lantern':
      addLantern(b, x, z, groundY)
      break
    case 'signpost':
      addSignpost(b, x, z, groundY, variant)
      break
  }
}

/** 颜色等比压暗，出「接地阴影」/ 草地明度微差 */
function scaled(c: RGB, k: number): RGB {
  return { r: c.r * k, g: c.g * k, b: c.b * k }
}

export async function createScene(args: CreateSceneArgs): Promise<SceneHandle> {
  const { world } = args
  // ⚠️ 基础类也从 'three/webgpu' 取，**不要**再 import 'three'。
  // 两个入口共用同一份 three.core.js，类的身份完全一致，但 'three' 会额外
  // 拖进 three.module.js（含整个 WebGLRenderer，约 365 kB）—— 本模块一行都用不上。
  const THREE = (await import('three/webgpu')) as unknown as typeof THREE_NS
  const { WebGPURenderer } = (await import('three/webgpu')) as {
    WebGPURenderer: WebGPURendererCtor
  }
  const { createWaterMaterial, createFoamMaterial } = await import('./water.tsl')
  const { createCloudShadowMaterial } = await import('./clouds.tsl')

  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'

  const renderer = new WebGPURenderer({
    canvas,
    antialias: true, // 低模几何的斜边需要平滑，不再是硬像素风
    alpha: false,
    forceWebGL: args.forceWebGL === true,
  })
  // DPR 封到 2：再高只是烧填充率，顶点色几何没有高频细节
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  await renderer.init()

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BACKGROUND)

  // 正交相机：视野以「格」为单位，resize 时按像素比例重算
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400)
  const pitch = (PITCH_DEG * Math.PI) / 180
  const yaw = (YAW_DEG * Math.PI) / 180

  // ── 地形：整张世界一次预生成 ──
  const terrainMat = new THREE.MeshBasicMaterial({ vertexColors: true })
  const waterMat = createWaterMaterial({ color: TERRAIN.waterDeep, alpha: WATER_ALPHA })
  const foamMat = createFoamMaterial()
  // 道具/角色的贴地投影：统一半透明暗色,不写深度
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x243038,
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
  })
  const solidGeos: THREE_NS.BufferGeometry[] = []
  const waterGeos: THREE_NS.BufferGeometry[] = []
  const foamGeos: THREE_NS.BufferGeometry[] = []
  const shadowGeos: THREE_NS.BufferGeometry[] = []
  /** 全部 chunk 层网格及其中心 —— 玩家走动时按距离开关可见性 */
  const chunkMeshes: Array<{ m: THREE_NS.Mesh; cx: number; cz: number }> = []
  /** 泡沫条的顶点色占位 —— 颜色完全由泡沫材质给 */
  const FOAM_COLOR: RGB = { r: 1, g: 1, b: 1 }

  const W = world.params.width
  const H = world.params.height

  // 顶面高度与生态先铺成数组：侧面落差的邻格查询是 O(4/格)，
  // 直接调 heightAt 的话同一格要重复算四五次噪声
  const topY = new Float32Array(W * H)
  const biome = new Uint8Array(W * H)
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x
      biome[i] = world.biomeAt(x, z)
      topY[i] = world.heightAt(x, z)
    }
  }
  const wrapIdx = (v: number, m: number): number => ((v % m) + m) % m
  const heightIdx = (x: number, z: number): number => topY[wrapIdx(z, H) * W + wrapIdx(x, W)] ?? 0

  function buildChunk(cx0: number, cz0: number): void {
    const land = new MeshBuilder()
    const water = new MeshBuilder()
    const foam = new MeshBuilder()
    const shadow = new MeshBuilder()
    const cw = Math.min(CHUNK, W - cx0)
    const ch = Math.min(CHUNK, H - cz0)
    for (let z = cz0; z < cz0 + ch; z++) {
      for (let x = cx0; x < cx0 + cw; x++) {
        const b = biome[z * W + x]!
        const y = topY[z * W + x]!

        // ── 顶面 ──
        let top: RGB
        if (b === BIOME.water) top = TERRAIN.waterBed
        else if (b === BIOME.shallow) top = TERRAIN.shallowBed
        else if (b === BIOME.sand) top = TERRAIN.sand
        else {
          const lv = Math.min(8, Math.max(0, world.sampler.levelAt(x, z)))
          top = TERRAIN.grassLevels[lv]!
        }
        if (world.pathAt(x, z)) top = TERRAIN.path
        // 草地/沙地按格哈希撒两档明度，打破大色块的死板
        if ((b === BIOME.grass || b === BIOME.sand) && hashTile(world.params.seed, x, z) & 0x40) {
          top = scaled(top, 0.955)
        }

        // ── 装饰物（先取，顺便给顶面压一层接地阴影） ──
        const prop = world.propAt(x, z)
        if (prop) top = scaled(top, 0.9)
        land.topQuad(x, y, z, x + 1, z + 1, top)

        // ── 侧面：与四邻的落差各生成一片土崖 ──
        const dirt = b === BIOME.water || b === BIOME.shallow ? TERRAIN.waterBed : TERRAIN.dirt
        // [邻格位移, 上棱两端点]：棱方向决定法线朝向（见 MeshBuilder.sideQuad）
        const sides: Array<[number, number, number, number, number, number]> = [
          [1, 0, x + 1, z, x + 1, z + 1], // 东
          [-1, 0, x, z + 1, x, z], // 西
          [0, 1, x + 1, z + 1, x, z + 1], // 南
          [0, -1, x, z, x + 1, z], // 北
        ]
        for (const [dx, dz, ax, az, bx, bz] of sides) {
          const ny = heightIdx(x + dx, z + dz)
          if (ny < y - 1e-4) land.sideQuad(ax, y, az, bx, bz, ny, dirt)
        }

        // ── 水面（深水与浅滩同一张面片，颜色由材质统一给）+ 岸线泡沫 ──
        if (b === BIOME.water || b === BIOME.shallow) {
          water.topQuad(x, WATER_SURFACE_Y, z, x + 1, z + 1, TERRAIN.waterShallow)
          // 泡沫：水格贴着陆地的那条边生成窄条带（骑在波面上方一点），
          // 颜色由泡沫材质统一给，顶点色只是占位
          const F = 0.16
          const fy = WATER_SURFACE_Y + 0.02
          const isLand = (dx: number, dz: number): boolean => {
            const nb = biome[wrapIdx(z + dz, H) * W + wrapIdx(x + dx, W)]!
            return nb !== BIOME.water && nb !== BIOME.shallow
          }
          if (isLand(1, 0)) foam.topQuad(x + 1 - F, fy, z, x + 1, z + 1, FOAM_COLOR)
          if (isLand(-1, 0)) foam.topQuad(x, fy, z, x + F, z + 1, FOAM_COLOR)
          if (isLand(0, 1)) foam.topQuad(x, fy, z + 1 - F, x + 1, z + 1, FOAM_COLOR)
          if (isLand(0, -1)) foam.topQuad(x, fy, z, x + 1, z + F, FOAM_COLOR)
        }

        if (prop) {
          addPropGeometry(
            land,
            prop.kind,
            x + 0.5 + prop.ox,
            z + 0.5 + prop.oy,
            y,
            prop.variant,
            prop.rot,
          )
          const sh = PROP_SHADOW[prop.kind]
          if (sh) {
            addPropShadow(shadow, x + 0.5 + prop.ox, z + 0.5 + prop.oy, y, sh[0], sh[1])
          }
        }
      }
    }
    /** 挂一块 chunk 层网格：静态、不自更新矩阵，并登记中心供可见性开关 */
    const addChunkMesh = (
      g: THREE_NS.BufferGeometry,
      material: THREE_NS.Material,
      order: number,
    ): void => {
      const m = new THREE.Mesh(g, material)
      m.renderOrder = order
      m.matrixAutoUpdate = false // 几何已是世界坐标且永不挪动,冻结矩阵
      m.updateMatrix()
      scene.add(m)
      chunkMeshes.push({ m, cx: cx0 + cw / 2, cz: cz0 + ch / 2 })
    }
    if (land.triangles > 0) {
      const g = land.toGeometry(THREE)
      solidGeos.push(g)
      addChunkMesh(g, terrainMat, 0)
    }
    if (shadow.triangles > 0) {
      const g = shadow.toGeometry(THREE)
      shadowGeos.push(g)
      addChunkMesh(g, shadowMat, 1) // 贴地阴影最先画,水面泡沫盖在其上
    }
    if (water.triangles > 0) {
      const g = water.toGeometry(THREE)
      waterGeos.push(g)
      addChunkMesh(g, waterMat, 2)
    }
    if (foam.triangles > 0) {
      const g = foam.toGeometry(THREE)
      foamGeos.push(g)
      addChunkMesh(g, foamMat, 3)
    }
  }

  // 每 4 个 chunk 让出一帧，启动遮罩才有机会刷新
  let built = 0
  for (let cz = 0; cz < H; cz += CHUNK) {
    for (let cx = 0; cx < W; cx += CHUNK) {
      buildChunk(cx, cz)
      if (++built % 4 === 0) await new Promise((r) => setTimeout(r, 0))
    }
  }

  // ── 云层阴影：高空覆盖面，最后绘制，压暗下方一切 ──
  // 平面要比世界大一圈：斜视相机下，画面顶部对应的云面位置比地面视野
  // 更「靠相机」约 30/tan(pitch)≈47 格，玩家贴世界边缘时也得盖满
  const cloudMat = createCloudShadowMaterial()
  const cloudGeo = new THREE.PlaneGeometry(W + 160, H + 160)
  const clouds = new THREE.Mesh(cloudGeo, cloudMat)
  clouds.rotation.x = -Math.PI / 2
  clouds.position.set(W / 2, CLOUD_Y, H / 2)
  clouds.renderOrder = 10 // 水面(1)与泡沫(2)之后
  scene.add(clouds)

  let playerX = W / 2
  let playerY = H / 2

  function layout(): void {
    // 相机从玩家的(+X,+Z) 象限退开：偏航出菱形沙盘，俯角出立面。
    // 水平退开量 = cos(pitch)·dist，垂直 = sin(pitch)·dist —— 与 yaw 无关的球坐标
    const dist = 120
    camera.position.set(
      playerX + 0.5 + Math.sin(yaw) * Math.cos(pitch) * dist,
      Math.sin(pitch) * dist,
      playerY + 0.5 + Math.cos(yaw) * Math.cos(pitch) * dist,
    )
    camera.lookAt(playerX + 0.5, 0, playerY + 0.5)
  }

  const rigs = new Set<CharacterRig>()

  function addRig(rig: CharacterRig): void {
    if (rigs.has(rig)) return
    rigs.add(rig)
    scene.add(rig.object)
  }

  function removeRig(rig: CharacterRig): void {
    if (!rigs.delete(rig)) return
    scene.remove(rig.object)
  }

  /** 角色直接立在地表顶面上 —— 地形多高人站多高，浅滩则是蹚水 */
  function placeRig(rig: CharacterRig, x: number, y: number): void {
    rig.object.position.set(x, world.heightAt(x, y), y)
  }

  /**
   * 可见半径（格）：正交相机在 43px/格 下地面视野约 30×37 格，
   * 52 格 = 视野 + 一圈余量，保证滚动到屏幕边缘也不露空。
   * 视锥剔除仍然兜底（半径只是第一道粗筛）。
   */
  const VIEW_R2 = 52 * 52

  function setPlayer(x: number, y: number): void {
    playerX = x
    playerY = y
    // 只渲染可视区域：玩家周围的 chunk 开、其余关。
    // visible=false 的对象在渲染遍历时被直接跳过,连视锥测试都不做
    for (const c of chunkMeshes) {
      const dx = c.cx - (x + 0.5)
      const dz = c.cz - (y + 0.5)
      c.m.visible = dx * dx + dz * dz < VIEW_R2
    }
    layout()
  }

  function resize(w: number, h: number): void {
    if (w <= 0 || h <= 0) return
    renderer.setSize(w, h, false)
    // 视野按「屏幕上一格多少像素」反推，于是窗口变大只是看得更多，格子不变形
    const halfH = h / 2 / TILE_SCREEN_PX
    const halfW = w / 2 / TILE_SCREEN_PX
    camera.left = -halfW
    camera.right = halfW
    camera.top = halfH
    camera.bottom = -halfH
    camera.updateProjectionMatrix()
  }

  layout()

  return {
    canvas,
    THREE,
    yaw,
    addRig,
    removeRig,
    placeRig,
    // @types/three 0.185 的 Backend 上没有 isWebGPUBackend 字段（运行时是有的），
    // 用 in 做运行时探测，别为了过类型去断言一个可能不存在的属性
    backend: renderer.backend && 'isWebGPUBackend' in renderer.backend ? 'webgpu' : 'webgl',
    setPlayer,
    resize,
    render: () => renderer.render(scene, camera),
    dispose: () => {
      for (const g of solidGeos) g.dispose()
      for (const g of waterGeos) g.dispose()
      for (const g of foamGeos) g.dispose()
      for (const g of shadowGeos) g.dispose()
      cloudGeo.dispose()
      terrainMat.dispose()
      waterMat.dispose()
      foamMat.dispose()
      shadowMat.dispose()
      cloudMat.dispose()
      renderer.dispose()
    },
  }
}
