/**
 * 渲染场景：WebGPU 渲染器、固定 2.5D 相机、地面、装饰物层。
 *
 * ## 与视差那个全局单例的关系
 * `services/depth/parallax.ts` 也持有一个 WebGL 渲染器，且**刻意常驻**
 * （卡片 hover 频繁，反复建销上下文会丢 context）。游戏这个不一样：
 * 它只在游戏页存在，离开必须 `dispose()` 彻底还回去 —— 两个渲染器同时活着
 * 是可以的（浏览器上限 8~16 个上下文），但留着一个不用的没有任何好处。
 *
 * ## 为什么是正交相机
 * HD-2D 的取景就是「固定俯角 + 正交」：透视会让远处的图块变形、像素画立刻糊掉，
 * 而正交下整张地图的格子大小完全一致，四方格读起来是规整的菱形。
 *
 * 纯 service：不 import vue/pinia。three 与 spine 都是**动态 import**，
 * 不进游戏页一个字节都不下载。
 */

import type * as THREE_NS from 'three'
import type { World } from './world'
import { TILE_PX, buildProp, buildTileAtlas, PROP_SIZE, type PropKind } from './tiles'
import type { CharacterRig } from './rig'

/**
 * 视窗边长（格）。
 *
 * 必须盖住斜视下的**梯形**可见区域：正交 + 俯角 p 时，地面在 Z 方向的跨度
 * 约为屏幕高度 / sin(p)，55° 下是 1.22 倍。80 格在 1707px 宽的屏上仍有富余，
 * 而索引贴图才 80×80 = 6400 个纹素，重建成本可以忽略。
 */
export const VIEW_TILES = 80
/** 相机俯角。55° 是 HD-2D 常见档位：能看见立绘正面，又有明确的地面纵深 */
const PITCH_DEG = 55
/** 一格在屏幕上的目标像素高。决定整体缩放 —— 越小看得越远 */
const TILE_SCREEN_PX = 32

type WebGPURendererCtor = typeof import('three/webgpu').WebGPURenderer

export interface SceneHandle {
  readonly canvas: HTMLCanvasElement
  /** 当前后端，'webgpu' | 'webgl' —— UI 上要显示，也是回退验证的观测点 */
  readonly backend: string
  /** 相机俯角（弧度）。角色 rig 要按它把 billboard 回正 */
  readonly pitch: number
  /** three 名字空间。three 是动态 import 的，外面建 rig 时拿不到，从这里取 */
  readonly THREE: typeof THREE_NS
  setPlayer(x: number, y: number): void
  /** 挂一个角色（玩家或 NPC）。重复挂是空操作 */
  addRig(rig: CharacterRig): void
  removeRig(rig: CharacterRig): void
  /** 把某个 rig 摆到格坐标 (x,y)，内部按俯角做 billboard 落地 */
  placeRig(rig: CharacterRig, x: number, y: number): void
  resize(w: number, h: number): void
  render(): void
  dispose(): void
}

/** 把 canvas 画成纹理，统一按像素画的方式设置采样 */
function pixelTexture(THREE: typeof THREE_NS, cv: HTMLCanvasElement): THREE_NS.Texture {
  const t = new THREE.CanvasTexture(cv)
  t.magFilter = THREE.NearestFilter
  t.minFilter = THREE.NearestFilter
  t.generateMipmaps = false
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  // 图集是直接画好的最终颜色，不要再做一次色彩空间解码（与 parallax.ts 同理）
  t.colorSpace = THREE.NoColorSpace
  return t
}

export interface CreateSceneArgs {
  world: World
  /** 是否强制走 WebGL 后端。用于验证移动端回退路径 */
  forceWebGL?: boolean
}

export async function createScene(args: CreateSceneArgs): Promise<SceneHandle> {
  const { world } = args
  const THREE = await import('three')
  const { WebGPURenderer } = (await import('three/webgpu')) as {
    WebGPURenderer: WebGPURendererCtor
  }
  const { createTerrainMaterial } = await import('./terrain.tsl')

  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'

  const renderer = new WebGPURenderer({
    canvas,
    antialias: false, // 像素画开抗锯齿等于自毁，边缘必须是硬的
    alpha: false,
    forceWebGL: args.forceWebGL === true,
  })
  // DPR 封到 2：像素画本来就不吃高分辨率，3x 屏上翻倍渲染毫无收益
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  await renderer.init()

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0d1b2a)

  // 正交相机：视野以「格」为单位，resize 时按像素比例重算
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400)
  const pitch = (PITCH_DEG * Math.PI) / 180

  // ── 地面 ──
  const atlasTex = pixelTexture(THREE, buildTileAtlas())
  // 图块 id 贴图：R8 单通道，view×view
  const idxData = new Uint8Array(VIEW_TILES * VIEW_TILES * 4)
  const idxTex = new THREE.DataTexture(idxData, VIEW_TILES, VIEW_TILES)
  idxTex.magFilter = THREE.NearestFilter
  idxTex.minFilter = THREE.NearestFilter
  idxTex.generateMipmaps = false
  idxTex.needsUpdate = true

  // 视窗原点由这里持有，材质里的 uniform 跟着同一个对象走
  const origin = new THREE.Vector2(0, 0)
  const terrainMat = createTerrainMaterial({
    atlas: atlasTex,
    index: idxTex,
    view: VIEW_TILES,
    origin,
  })
  const groundGeo = new THREE.PlaneGeometry(VIEW_TILES, VIEW_TILES)
  const ground = new THREE.Mesh(groundGeo, terrainMat)
  // 平面默认立在 XY，转到 XZ 当地面
  ground.rotation.x = -Math.PI / 2
  scene.add(ground)

  // ── 装饰物层 ──
  const propTextures = new Map<PropKind, THREE_NS.Texture>()
  for (const k of ['tree', 'house', 'bush'] as PropKind[]) {
    propTextures.set(k, pixelTexture(THREE, buildProp(k)))
  }
  const propGroup = new THREE.Group()
  scene.add(propGroup)
  const propPool: THREE_NS.Mesh[] = []
  const propGeo = new THREE.PlaneGeometry(1, 1)

  /** 当前视窗左下角的世界格坐标 */
  let originX = 0
  let originY = 0
  let playerX = world.params.width / 2
  let playerY = world.params.height / 2
  /** 上一次重建索引贴图时的格坐标，用来判断要不要重建 */
  let builtX = Number.NaN
  let builtY = Number.NaN

  function rebuildIndex(): void {
    const half = Math.floor(VIEW_TILES / 2)
    originX = Math.floor(playerX) - half
    originY = Math.floor(playerY) - half
    for (let j = 0; j < VIEW_TILES; j++) {
      for (let i = 0; i < VIEW_TILES; i++) {
        const b = world.biomeAt(originX + i, originY + j)
        const o = (j * VIEW_TILES + i) * 4
        // id 写进 R 通道。DataTexture 是 0..255 的字节，着色器里乘回去
        idxData[o] = b
        idxData[o + 1] = 0
        idxData[o + 2] = 0
        idxData[o + 3] = 255
      }
    }
    idxTex.needsUpdate = true
    origin.set(originX, originY)
    builtX = Math.floor(playerX)
    builtY = Math.floor(playerY)
  }

  function rebuildProps(): void {
    const list = world.propsAround(playerX, playerY, VIEW_TILES)
    // 池化：复用已有 mesh，只在不够时才新建
    while (propPool.length < list.length) {
      const m = new THREE.Mesh(
        propGeo,
        // ⚠️ 刻意 transparent:false + alphaTest：像素精灵走**不透明通道**，
        // 深度既测也写，于是「走到树后被挡、走到树前挡住树」完全由深度缓冲决定，
        // 与绘制顺序无关。改成 transparent:true 会进半透明通道按距离排序，
        // 精灵互相穿插时顺序会错，而且排序本身还有开销。
        new THREE.MeshBasicMaterial({ transparent: false, alphaTest: 0.5 }),
      )
      propPool.push(m)
      propGroup.add(m)
    }
    for (let i = 0; i < propPool.length; i++) {
      const mesh = propPool[i]
      if (!mesh) continue
      const p = list[i]
      if (!p) {
        mesh.visible = false
        continue
      }
      const tex = propTextures.get(p.kind)
      const mat = mesh.material as THREE_NS.MeshBasicMaterial
      if (mat.map !== tex) {
        mat.map = tex ?? null
        mat.needsUpdate = true
      }
      const [pw, ph] = PROP_SIZE[p.kind]
      // 立绘按「一格 = TILE_PX 像素」换算成世界单位，保证与地面同一比例尺
      const w = pw / TILE_PX
      const h = ph / TILE_PX
      mesh.scale.set(w, h, 1)
      placeBillboard(mesh, p.x + 0.5 + p.ox, p.y + 0.5 + p.oy, h)
      mesh.visible = true
    }
  }

  /**
   * 把一张 quad 立在地面上并正对相机。
   *
   * 朝向：相机视线方向是 (0, -sin p, -cos p)，quad 初始法线是 +Z，
   * 绕 X 转 θ 后法线变成 (0, -sinθ, cosθ)。要它等于 -视线 = (0, sin p, cos p)，
   * 解得 **θ = -p**。
   * ⚠️ 别写成 `-π/2 + p`：那是「把平面放平」再抬起来的直觉，差了 90°-2p，
   * 55° 下偏 20°，表现是立绘被压扁、越远越明显。
   *
   * 落地：转完之后 quad 的局部上方向是 (0, cos p, -sin p)，底边中点
   * = 中心 - (h/2)·上方向。要让底边正好落在 (x, 0, z)，中心就得抬到
   * (x, (h/2)cos p, z - (h/2)sin p)。
   */
  function placeBillboard(mesh: THREE_NS.Mesh, x: number, z: number, h: number): void {
    mesh.rotation.set(-pitch, 0, 0)
    mesh.position.set(x, (h / 2) * Math.cos(pitch), z - (h / 2) * Math.sin(pitch))
  }

  function layout(): void {
    // 地面跟着玩家整体平移，并留出亚格偏移让滚动连续
    ground.position.set(originX + VIEW_TILES / 2, 0, originY + VIEW_TILES / 2)
    // 相机在玩家上方沿 -Z 退开，形成固定俯角
    const dist = 120
    camera.position.set(
      playerX + 0.5,
      Math.sin(pitch) * dist,
      playerY + 0.5 + Math.cos(pitch) * dist,
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

  /** 与装饰物同一套落地公式，保证角色和树站在同一个平面上 */
  function placeRig(rig: CharacterRig, x: number, y: number): void {
    const h = rig.height
    rig.object.position.set(x, (h / 2) * Math.cos(pitch), y - (h / 2) * Math.sin(pitch))
  }

  function setPlayer(x: number, y: number): void {
    playerX = x
    playerY = y
    if (Math.floor(x) !== builtX || Math.floor(y) !== builtY) {
      rebuildIndex()
      rebuildProps()
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

  rebuildIndex()
  rebuildProps()
  layout()

  return {
    canvas,
    pitch,
    THREE,
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
      groundGeo.dispose()
      propGeo.dispose()
      atlasTex.dispose()
      idxTex.dispose()
      for (const t of propTextures.values()) t.dispose()
      for (const m of propPool) (m.material as THREE_NS.Material).dispose()
      terrainMat.dispose()
      renderer.dispose()
    },
  }
}
