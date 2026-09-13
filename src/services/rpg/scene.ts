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
import { hashTile, wrapDelta } from './world'
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
import { REGION_TINT, tintOf } from './palette'
import { BIOME, WATER_SURFACE_Y } from './noise'
import { skyAt } from './time'

/**
 * 每种道具的投影参数 [椭圆半径, 参考高度]。null = 太小不投影。
 * 高度只用来算阴影拉长量，不必精确。
 */
/**
 * ⚠️ 这张表必须跟着 blocks.ts 里的道具尺寸一起改。
 *
 * 高度只用来算阴影被拉长多少 —— 道具放大了而这里没跟上的话，影子会短得
 * 像贴在脚底的一小块，2.5D 俯视下那是「物体浮在地上」最明显的破绽。
 * 半径同理，不跟上就会出现「影子比树冠小一圈」。
 */
const PROP_SHADOW: Record<PropKind, [number, number] | null> = {
  tree: [0.72, 2.0],
  pine: [0.5, 1.55],
  bush: [0.3, 0.55],
  flower: null,
  house: [1.05, 2.0],
  well: [0.5, 1.45],
  haystack: [0.6, 1.0],
  haybale: [0.42, 0.72],
  fence: [0.4, 0.85],
  crop: null,
  scarecrow: [0.26, 1.5],
  rock: [0.26, 0.25],
  bench: [0.5, 0.72],
  lantern: [0.18, 1.8],
  signpost: [0.16, 1.6],
}

/** 相机俯角。用户在自由视角里定稿：32.4° 的低俯角让方块立面占屏更足 */
const PITCH_DEG = 32.4
/** 相机偏航。用户定稿 42.4°：菱形沙盘视角，同时露出 +X 与 +Z 两个方向的立面 */
const YAW_DEG = 42.4
/** 一格在屏幕上的目标像素高。决定整体缩放 —— 越小看得越远。43.2 = 定稿 zoom 1.35 × 32 */
const TILE_SCREEN_PX = 43.2
/** chunk 边长（格）。32 → 256² 的世界共 64 块，兼顾客机剔除与构建粒度 */
const CHUNK = 32
/**
 * 背景色：参考图那种米白天空。与 SKY_KEYS 的 480 分关键帧同值 ——
 * `new THREE.Color(hex)` 的 setHex 按 sRGB 解释并转成线性，与 `skyAt(480).sky`
 * 走的 hexToLinear 得到的是同一个三元组，所以第一帧不会跳。
 */
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
  /** 全部角色共用的身体材质。建 rig 时传进去，昼夜调色才能一处覆盖 */
  readonly figureMaterial: THREE_NS.MeshBasicMaterial
  setPlayer(x: number, y: number): void
  /** 挂一个角色（玩家或 NPC）。重复挂是空操作 */
  addRig(rig: CharacterRig): void
  removeRig(rig: CharacterRig): void
  /** 把某个 rig 立到格坐标 (x,y) 的地表上。rig 自己负责朝向 */
  placeRig(rig: CharacterRig, x: number, y: number): void
  /**
   * 重建 (x,y) 所在那一块 chunk 的网格。
   *
   * ⚠️ 采集掉一棵树、或树刷新长回来之后**必须**调它：chunk 网格是启动时一次性
   * 烘焙好的静态几何，不重建的话砍掉的树会一直留在画面上（而碰撞已经没了），
   * 或者长回来的树看不见（而碰撞已经有了）—— 两种都是「看到的和能走的不一致」。
   */
  rebuildAt(x: number, y: number): void
  resize(w: number, h: number): void
  /**
   * 按当天分钟调整天色。
   *
   * ⚠️ 做法是给材质的 `color` 乘子赋值 —— basic 材质的片元就是
   * `diffuse × vColor`，一行 setRGB 就给**烘焙进顶点色**的整张地图整体调色，
   * **零几何改动、零重建**，WebGPU 与 WebGL 两个后端语义一致。
   * 不用雾（正交相机下会把地图前后切成一条带）、不用全屏覆盖面（多一次全屏
   * draw 且要和云影排队）、不换 NodeMaterial（地形材质本来就会被内部转成
   * NodeMaterial，自己写一份只是把一行赋值换成一套节点图）。
   */
  setTimeOfDay(minuteOfDay: number): void
  render(): void
  dispose(): void
  /**
   * 只读快照 —— 给自动化验收脚本断言「接缝不漏、不重影、游玩期零重建」。
   * 生产路径一行都不调用。
   *
   * ⚠️ ox/oz 刻意从 matrixWorld 读、不从 position 读：这样「改了 position 却
   * 忘了 updateMatrix」这个静默失败也会被同一条断言抓住。
   */
  debugSnapshot(): {
    originX: number
    originZ: number
    viewR: number
    geometries: number
    drawCalls: number
    chunks: ReadonlyArray<{ ox: number; oz: number; cx: number; cz: number; visible: boolean }>
  }
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
  const { createNoiseOrigin, createDayTint, createSunAmount } = await import('./frame.tsl')
  // 水面、泡沫、云影共用一个噪声原点：跨接缝那一帧三者必须同步补偿，
  // 否则补了的那层和没补的那层在同一帧里对不上，比不补还刺眼
  const noiseOrigin = createNoiseOrigin()
  // 昼夜乘子。地形/道具/小人是 basic 材质，改 material.color 就够了；
  // 水面与泡沫是 TSL 图，没有 diffuse 可改，只能靠这个 uniform 一起压暗
  const dayTint = createDayTint()
  /** 日光强度 0..1。云影与贴地投影一起按它淡出 */
  const sunAmount = createSunAmount()

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
  const bg = new THREE.Color(BACKGROUND)
  scene.background = bg
  /**
   * 所有小人共用的身体材质。颜色全在顶点里，材质之间本来就没差别 ——
   * 共用一份，昼夜色调改这一处就覆盖全部角色，顺带省掉每个 NPC 一次材质编译。
   */
  const figureMat = new THREE.MeshBasicMaterial({ vertexColors: true })

  // 正交相机：视野以「格」为单位，resize 时按像素比例重算
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400)
  const pitch = (PITCH_DEG * Math.PI) / 180
  const yaw = (YAW_DEG * Math.PI) / 180

  // ── 地形：整张世界一次预生成 ──
  const terrainMat = new THREE.MeshBasicMaterial({ vertexColors: true })
  const waterMat = createWaterMaterial({
    color: TERRAIN.waterDeep,
    alpha: WATER_ALPHA,
    origin: noiseOrigin,
    tint: dayTint,
  })
  const foamMat = createFoamMaterial(noiseOrigin, dayTint)
  // 道具/角色的贴地投影：统一半透明暗色,不写深度
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x243038,
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
  })
  /**
   * 一块 chunk 的全部层网格 + 它的中心 + 当前生效的平移量。
   *
   * 按 chunk 分组而不是按 mesh 平铺：平移量是**整块共用**的，分组后每帧算 64 次
   * 而不是 256 次，而且「同一块的四层必须挪到同一个镜像」成了结构上的保证。
   */
  interface ChunkEntry {
    meshes: THREE_NS.Mesh[]
    /**
     * 这一块自己的几何体。
     *
     * ⚠️ 必须**按块**记，不能像原先那样堆进四个全局数组：采集要重建单块，
     * 重建时得精确释放**这一块**的旧几何。堆在全局数组里的话，重建只会让数组
     * 无限增长，旧几何永远不释放 —— 砍几十棵树就是几十份泄漏的顶点缓冲。
     */
    geos: THREE_NS.BufferGeometry[]
    cx: number
    cz: number
    /** 当前平移量（0 或 ±W/±H）。只在变化时才写矩阵 */
    ox: number
    oz: number
  }
  const chunks: ChunkEntry[] = []
  /** chunk 左上角格键 → 该块。重建时要按坐标找到旧块 */
  const chunkAt = new Map<number, ChunkEntry>()
  const chunkKey = (cx0: number, cz0: number): number => cz0 * W + cx0
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
          // 生态染色：森林偏冷深、草甸偏亮暖、干草原偏橄榄 —— 让分区一眼可辨。
          // 草格的 regionAt 只会是 forest/meadow/wilds（beach/water 是沙/水，不到这支）
          const region = world.regionAt(x, z)
          const tint = REGION_TINT[region as 'forest' | 'meadow' | 'wilds']
          if (tint) top = tintOf(top, tint)
        }
        if (world.pathAt(x, z) || world.roadAt(x, z)) top = TERRAIN.path
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
    // 重建：先把这一块的旧网格从场景摘掉并释放几何，再挂新的。
    // 不摘的话旧树会和新空地**同时**画出来（深度相同，闪烁），而且几何泄漏
    const prev = chunkAt.get(chunkKey(cx0, cz0))
    if (prev) {
      for (const m of prev.meshes) scene.remove(m)
      for (const g of prev.geos) g.dispose()
      const i = chunks.indexOf(prev)
      if (i >= 0) chunks.splice(i, 1)
      chunkAt.delete(chunkKey(cx0, cz0))
    }
    const entry: ChunkEntry = {
      meshes: [],
      geos: [],
      cx: cx0 + cw / 2,
      cz: cz0 + ch / 2,
      ox: 0,
      oz: 0,
    }
    /** 挂一块 chunk 层网格：几何固定，位置由 setPlayer 按最近环面镜像改写 */
    const addChunkMesh = (
      g: THREE_NS.BufferGeometry,
      material: THREE_NS.Material,
      order: number,
    ): void => {
      const m = new THREE.Mesh(g, material)
      m.renderOrder = order
      // 矩阵不自更新：位置一年也变不了几次（只在玩家跨越半个世界时），
      // 每帧 compose 纯属浪费。⚠️ 代价是改了 position 必须自己 updateMatrix()
      m.matrixAutoUpdate = false
      m.updateMatrix()
      scene.add(m)
      entry.meshes.push(m)
    }
    if (land.triangles > 0) {
      const g = land.toGeometry(THREE)
      entry.geos.push(g)
      addChunkMesh(g, terrainMat, 0)
    }
    if (shadow.triangles > 0) {
      const g = shadow.toGeometry(THREE)
      entry.geos.push(g)
      addChunkMesh(g, shadowMat, 1) // 贴地阴影最先画,水面泡沫盖在其上
    }
    if (water.triangles > 0) {
      const g = water.toGeometry(THREE)
      entry.geos.push(g)
      addChunkMesh(g, waterMat, 2)
    }
    if (foam.triangles > 0) {
      const g = foam.toGeometry(THREE)
      entry.geos.push(g)
      addChunkMesh(g, foamMat, 3)
    }
    if (entry.meshes.length) {
      chunks.push(entry)
      chunkAt.set(chunkKey(cx0, cz0), entry)
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
  const cloudMat = createCloudShadowMaterial(noiseOrigin, sunAmount)
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

  /**
   * 角色直接立在地表顶面上 —— 地形多高人站多高，浅滩则是蹚水。
   *
   * 传进来的是**逻辑**格坐标；摆到哪里由渲染侧决定 —— 取离玩家最近的那个环面
   * 镜像，于是「屏幕上的距离」恒等于 nearestNpc 算的环面距离。不这么做的话，
   * 玩家在 x=254、NPC 在 x=1 时逻辑上贴着脸，渲染却差 253 格：人在屏幕外，
   * 而「按 E 交谈」的提示照样亮着。
   */
  function placeRig(rig: CharacterRig, x: number, y: number): void {
    rig.object.position.set(
      playerX - wrapDelta(playerX - x, W),
      world.heightAt(x, y),
      playerY - wrapDelta(playerY - y, H),
    )
  }

  /**
   * 可见半径（格）的平方，由视口在 resize 里推导。
   *
   * 之前写死 52 是**不够的**：正交相机横向 1:1 落在地面，纵向被俯角拉长
   * 1/sin(32.4°)≈1.87 倍，1080p 就要 ≈55，4K 要 ≈87 —— 也就是说以前在普通桌面上
   * 角落的 chunk 已经会闪。给个安全的初值，resize 一到就被改写。
   */
  let viewR2 = 64 * 64

  function setPlayer(x: number, y: number): void {
    // 入参按逻辑坐标回绕 —— 调用方传 256 与传 0 必须完全等价，否则噪声原点会错位
    const px = ((x % W) + W) % W
    const py = ((y % H) + H) % H

    // 跨接缝那一帧，「逻辑坐标之差」比玩家真实走的距离整整少一个世界宽。
    // 把这个差额记进噪声原点，水面与云影就感觉不到这次整体瞬移（见 frame.tsl.ts）
    const rawX = px - playerX
    const rawY = py - playerY
    noiseOrigin.value.x += wrapDelta(rawX, W) - rawX
    noiseOrigin.value.y += wrapDelta(rawY, H) - rawY

    playerX = px
    playerY = py

    for (const c of chunks) {
      // 一次 wrapDelta 同时给出两样东西：剔除用的环面距离，和该块要挪多远
      const dx = wrapDelta(playerX + 0.5 - c.cx, W)
      const dz = wrapDelta(playerY + 0.5 - c.cz, H)
      const ox = playerX + 0.5 - dx - c.cx
      const oz = playerY + 0.5 - dz - c.cz
      if (ox !== c.ox || oz !== c.oz) {
        c.ox = ox
        c.oz = oz
        for (const m of c.meshes) {
          m.position.set(ox, 0, oz)
          // ⚠️ matrixAutoUpdate=false：改了 position 必须自己 compose。
          // 漏掉的话 matrix 停在旧值，而 Scene.matrixAutoUpdate 为 true 会强制
          // 每帧从这个**陈旧的 matrix** 重算 matrixWorld —— 物体静默画在老地方，
          // 连视锥剔除都拿旧包围球去测，症状是 chunk 莫名其妙闪进闪出
          m.updateMatrix()
        }
      }
      // 只渲染可视区域：visible=false 的对象在渲染遍历时被直接跳过
      const visible = dx * dx + dz * dz < viewR2
      for (const m of c.meshes) m.visible = visible
    }

    // 云影面跟着玩家走 —— 钉在世界中心的话，玩家走到接缝另一侧就盖不住了
    // （4K 下本来就已经盖不住）。噪声按渲染世界坐标取样，平面滑动不改变采样点，
    // 云影在画面上依然是不动的
    clouds.position.set(playerX + 0.5, CLOUD_Y, playerY + 0.5)
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
    // 可见半径要罩住相机在地面的取景框（纵向被俯角拉长），再加 chunk 半对角
    // （判定用的是 chunk 中心）与树高的屏幕外扩。
    // ⚠️ 上限 (W-CHUNK)/2：越过它，同一块 chunk 的两个镜像就可能同时入画，
    // 「每块只画离玩家最近的那个镜像」这个前提会塌掉。5K 以内都够不着。
    const r = Math.hypot(halfW, halfH / Math.sin(pitch)) + CHUNK * 0.71 + 6
    viewR2 = Math.min(r, (W - CHUNK) / 2) ** 2
  }

  layout()

  return {
    canvas,
    THREE,
    figureMaterial: figureMat,
    yaw,
    addRig,
    removeRig,
    placeRig,
    // @types/three 0.185 的 Backend 上没有 isWebGPUBackend 字段（运行时是有的），
    // 用 in 做运行时探测，别为了过类型去断言一个可能不存在的属性
    backend: renderer.backend && 'isWebGPUBackend' in renderer.backend ? 'webgpu' : 'webgl',
    setPlayer,
    rebuildAt(x: number, y: number) {
      const gx = ((Math.floor(x) % W) + W) % W
      const gy = ((Math.floor(y) % H) + H) % H
      buildChunk(Math.floor(gx / CHUNK) * CHUNK, Math.floor(gy / CHUNK) * CHUNK)
      // 新挂的网格平移量还是 0；不重跑一次镜像定位，这一块会闪到世界原点一帧
      setPlayer(playerX, playerY)
    },
    resize,
    setTimeOfDay(minuteOfDay: number) {
      const s = skyAt(minuteOfDay)
      // 地形、道具与所有小人共用同一档乘子 —— 分开调会出现「地暗了人还亮着」
      terrainMat.color.setRGB(s.tint.r, s.tint.g, s.tint.b)
      figureMat.color.setRGB(s.tint.r, s.tint.g, s.tint.b)
      // 水面与泡沫走 uniform（TSL 图里没有 diffuse 可乘）。
      // ⚠️ 必须与上面两行同值：分开调会出现「地暗了湖还亮着」
      dayTint.value.setRGB(s.tint.r, s.tint.g, s.tint.b)
      // 没有太阳就没有影子 —— 贴地投影与云影走同一个数
      shadowMat.opacity = 0.25 * s.sun
      sunAmount.value = s.sun
      bg.setRGB(s.sky.r, s.sky.g, s.sky.b)
    },
    render: () => renderer.render(scene, camera),
    debugSnapshot: () => ({
      originX: noiseOrigin.value.x,
      originZ: noiseOrigin.value.y,
      viewR: Math.sqrt(viewR2),
      geometries: renderer.info.memory.geometries,
      drawCalls: renderer.info.render.drawCalls,
      chunks: chunks.map((c) => {
        const m = c.meshes[0]
        // 从 matrixWorld 读，见 SceneHandle 上的说明
        return {
          ox: m?.matrixWorld.elements[12] ?? 0,
          oz: m?.matrixWorld.elements[14] ?? 0,
          cx: c.cx,
          cz: c.cz,
          visible: m?.visible === true,
        }
      }),
    }),
    dispose: () => {
      for (const c of chunks) for (const g of c.geos) g.dispose()
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
