/**
 * 基于深度图的真视差渲染器（three.js）。
 *
 * ## 一个离屏渲染器 + 每张卡一块 2D canvas（多视图）
 * 浏览器的 WebGL 上下文上限在 8~16 个。一张卡一个 WebGL canvas，角色一多就会开始
 * 丢上下文，表现是**卡片随机变黑**且不报错。所以全局只建**一个**渲染器，它的 canvas 离屏不进 DOM。
 *
 * 手机上要求「可视区内的卡全都跟着倾斜动」，于是每个视图（画框）里放一块**普通 2D canvas**，
 * 每帧对每个视图：写该卡的纹理 / 取景 uniform → 在离屏 canvas 上渲染 → `drawImage` 拷进该卡的
 * 2D canvas（three.js 手册「多 canvas 共用一个渲染器」的做法）。2D canvas 不占 WebGL 上下文额度；
 * 拷贝紧跟渲染、在同一任务内完成，所以不需要 preserveDrawingBuffer。
 *
 * 2D canvas 是**挂进画框元素内部**（absolute inset:0）而不是 fixed 定位：
 * 这样滚动、裁切、圆角都由浏览器自己管，不需要同步坐标。
 * 桌面（鼠标悬停单卡）与编辑页（单个大立绘）只是「视图数 = 1」的特例。
 *
 * ## 为什么是顶点位移而不是 UV 偏移
 * UV 偏移（`uv += (depth-0.5)*k`）便宜、无需几何，但深度突变处会拉出涂抹感，
 * 人像的头发边缘尤其明显。细分平面按深度**位移顶点**才是真视差：近景与远景
 * 走不同的量、方向相反，重叠时还能靠深度缓冲正确遮挡。
 *
 * ⚠️ 代价：没有背景修补，深度断崖处会被**拉伸**（被遮挡的背景像素本就不存在）。
 * 靠两件事压住：位移幅度小，以及顶点着色器里对深度做 9 点模糊把断崖抹成斜坡 ——
 * 拉伸比撕裂好看得多。想彻底解决要做 inpainting，那是另一个量级。
 *
 * 纯 service：不 import vue/pinia。three.js 是**动态 import** 的，
 * 不开视差就一个字节都不下载。
 */

import type * as THREE_NS from 'three'

/** 细分密度。2:3 的卡，横向 96 段就足够让断崖过渡平滑，再高只是白烧顶点 */
const SEG_X = 96
const SEG_Y = 144
/**
 * 平面比视口略大，位移时四边才不会露出底色。
 *
 * 只需盖住「最大位移量」那一圈：单侧最大位移 = STRENGTH/2，两侧共 STRENGTH。
 * 放太大会让画面在 hover 时明显跳一下 —— 这个放大**必须在 uv 里补偿掉**
 * （见 uUvScale），否则静态图与 canvas 的取景对不上，观感就是「图片一碰就变」。
 */
const OVERSCAN = 1.05
/**
 * 视差强度，单位是**世界单位**（视口高度固定为 2）。
 *
 * 顶点位移量 = STRENGTH × 指针(-1..1) × (深度-0.5)。视口高度恒为 2，
 * 所以**单侧最大位移占画面高度的比例 = STRENGTH / 4**。
 * （这里刻意不写死某个具体数值 —— 这是个要凭手感反复调的参数，
 *   写了乘积结果，改一次值注释就过期一次。）
 *
 * ⚠️ 别往大调。没有背景修补，位移越大深度断崖处的拉伸（拖影）越明显，
 * 0.18 那一档实测已经糊得没法看。视差靠的是「近远不同步」这个**关系**，
 * 不是绝对位移量 —— 小幅度照样成立，而且干净。
 *
 * ⚠️ 别回头改成「透视相机 + 相机位移」那套：实测过，视差量
 * ≈ 相机位移 × z / 相机距离，相机在 3 个单位外时算出来**不到 1 个像素**，
 * 两帧互相关的位移是 0。想靠加大相机位移补回来就得把相机甩出画面。
 * 正交 + 显式位移的幅度是直接可控的，不受相机距离摆布。
 */
const STRENGTH = 0.04
/** 指数平滑系数：越小越黏手。0.12 在 60Hz 下约 120ms 跟手时间 */
const LERP = 0.12

const VERT = /* glsl */ `
uniform sampler2D uDepth;
uniform float uStrength;
uniform vec2 uMouse;
uniform vec2 uTexel;
uniform vec2 uUvScale;
varying vec2 vUv;

// 9 点模糊：把深度断崖抹成斜坡。断崖越陡，位移后拉伸（拖影）越明显，
// 抹平它比减小位移更能治本
float depthAt(vec2 uv) {
  float s = 0.0;
  s += texture2D(uDepth, uv).r * 4.0;
  s += texture2D(uDepth, uv + vec2( uTexel.x, 0.0)).r * 2.0;
  s += texture2D(uDepth, uv + vec2(-uTexel.x, 0.0)).r * 2.0;
  s += texture2D(uDepth, uv + vec2(0.0,  uTexel.y)).r * 2.0;
  s += texture2D(uDepth, uv + vec2(0.0, -uTexel.y)).r * 2.0;
  s += texture2D(uDepth, uv + uTexel).r;
  s += texture2D(uDepth, uv - uTexel).r;
  s += texture2D(uDepth, uv + vec2( uTexel.x, -uTexel.y)).r;
  s += texture2D(uDepth, uv + vec2(-uTexel.x,  uTexel.y)).r;
  return s / 16.0;
}

void main() {
  // uUvScale 同时干两件事：
  //  1. 抵消 OVERSCAN 带来的放大 —— 让**画面可见区域**正好对应完整的取景，
  //     静态 <img> 与 canvas 两者取景一致，hover 时不跳变
  //  2. 实现 object-fit: cover —— 图片比例与卡片比例不同时按短边铺满、长边裁切，
  //     和 CSS 里那张 <img> 的行为一致。少了这一步 9:16 的立绘会被压成 2:3
  vec2 fixedUv = (uv - 0.5) * uUvScale + 0.5;
  vUv = fixedUv;

  // Depth Anything 的约定：值越大越近。减 0.5 让中景成为不动的支点，
  // 近景朝一边走、远景朝另一边走 —— 这个反向才是「视差」，
  // 全部同向只会读成整张图在平移。
  float d = depthAt(fixedUv) - 0.5;
  vec3 p = position;
  p.xy += uMouse * uStrength * d;
  // z 不参与正交投影，只喂深度缓冲：近景写得更靠前，
  // 位移后互相重叠时才会正确遮挡，而不是按三角形顺序乱盖
  p.z = d;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

const FRAG = /* glsl */ `
uniform sampler2D uColor;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uColor, vUv);
}
`

interface State {
  THREE: typeof THREE_NS
  renderer: THREE_NS.WebGLRenderer
  scene: THREE_NS.Scene
  camera: THREE_NS.OrthographicCamera
  mesh: THREE_NS.Mesh
  material: THREE_NS.ShaderMaterial
  /** 离屏的 WebGL canvas，从不进 DOM */
  canvas: HTMLCanvasElement
  pixelRatio: number
}

/** 一对纹理（彩色 + 深度）。按「图片 + 目标尺寸档位」缓存，卡片滚出去再滚回来不用重新解码上传 */
interface TexPair {
  color: THREE_NS.Texture
  depth: THREE_NS.Texture
  /** 彩色图宽高比，用于 cover 取景 */
  imgAspect: number
  texel: [number, number]
  refs: number
}

interface View {
  el: HTMLElement
  tex: TexPair
  aspect: number
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  /** 画框的 CSS 尺寸（ResizeObserver 维护） */
  cssW: number
  cssH: number
}

let state: State | null = null
let booting: Promise<State> | null = null

const views = new Map<HTMLElement, View>()
/** 正在 mount（等纹理）的画框 → 令牌；期间 unmount 会作废它 */
const pending = new Map<HTMLElement, number>()
let pendingSeq = 0
/** 纹理缓存（LRU：Map 的插入顺序即新旧顺序） */
const texCache = new Map<string, TexPair>()
/** 缓存上限（对）。refs > 0 的在用纹理永不淘汰 */
const TEX_CACHE_MAX = 12
/** 同时活跃视图上限。网格一屏通常 6~8 张，超出的卡保持静态图 */
const MAX_VIEWS = 10
/**
 * 纹理相对显示尺寸的**超采样倍率**。
 *
 * 只把纹理降到「刚好显示尺寸」时，GPU 的双线性(近 1:1)采样比浏览器 `<img>` 的高质量直缩要软一档,
 * hover 时肉眼可见变糊。超采样到 2×，GPU 双线性缩小相当于做了一次 2×2 盒式平均 → 锐利且无摩尔纹，
 * 观感与静态 `<img>` 基本一致。桌面 hover 只有一张卡、手机可视区也就几张，2× 的显存开销可接受
 * （单卡 ~2048×1365 上限封顶）。
 */
const SUPERSAMPLE = 2

let raf = 0
/** 目标与当前的归一化指针位置，各分量 -1..1 */
let target = { x: 0, y: 0 }
let current = { x: 0, y: 0 }
let resizeObs: ResizeObserver | null = null

async function boot(): Promise<State> {
  if (state) return state
  if (booting) return booting
  booting = (async () => {
    const THREE = await import('three')
    const canvas = document.createElement('canvas')
    // 离屏：preserveDrawingBuffer 仍然不开 —— 每个视图渲染完立刻在同一任务里 drawImage 拷走，
    // 缓冲区在合成前一直有效，用不着它（开了有真实的性能代价）
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    // ⚠️ 刻意**不设 outputColorSpace**，也不给纹理标色彩空间 —— 走纯直通。
    //
    // 这里只是把一张图原样贴出来，没有光照、没有混合，根本不需要线性工作空间。
    // 而 ShaderMaterial 是裸着色器，不含 three 的 colorspace_fragment 转换块，
    // 所以输出端本来就不会做任何转换；只要输入端也不解码，就是字节进字节出，
    // 与静态 <img> 完全一致。
    //
    // 踩过的两个坑：
    //  1. 把纹理标成 SRGBColorSpace → WebGL2 用 sRGB 内部格式**自动解码成线性值**，
    //     着色器把线性值直接写进画面 = 整体压暗、严重失真。
    //  2. 想「关掉转换」而写 `outputColorSpace = NoColorSpace` → **直接抛异常**：
    //     NoColorSpace 的值是空串，three 的 setter 去查
    //     `ColorManagement.spaces[''].outputColorSpaceConfig` 拿到 undefined。
    //     而 mount() 的静默 catch 会把它吞掉，表现成「视差毫无反应」。
    // ⚠️ DPR 必须跟到设备真实像素（上限 3），不能封 2。
    // 2D canvas 的位图尺寸 = cssW × pixelRatio（sizeView），封 2 的话在 DPR3 手机
    // （或 Windows 缩放 ≥250%）上，canvas 只按 2× 出图却要铺满元素的 3× 设备像素，
    // 被浏览器放大 ~1.5× → 发糊，而旁边静态 <img> 是原生 3× 清晰，一对比就是「加视差后变模糊」。
    // 离屏缓冲只按当前最大的**一个**视图尺寸（ensureStageSize 取 max 非求和），提到 3 成本极小。
    const pixelRatio = Math.min(devicePixelRatio, 3)
    renderer.setPixelRatio(pixelRatio)

    const scene = new THREE.Scene()
    // 正交：视口高度恒为 2，位移幅度就等于「占画面高度的比例」，
    // 不受相机距离影响。left/right 按每个视图的比例设定。
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -4, 4)
    camera.position.set(0, 0, 2)

    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uColor: { value: null },
        uDepth: { value: null },
        uStrength: { value: STRENGTH },
        uMouse: { value: new THREE.Vector2(0, 0) },
        uUvScale: { value: new THREE.Vector2(1, 1) },
        uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      },
    })
    const geo = new THREE.PlaneGeometry(1, 1, SEG_X, SEG_Y)
    const mesh = new THREE.Mesh(geo, material)
    scene.add(mesh)

    // 上下文丢失（GPU 重置、后台太久被回收）：全部退回静态图，下次 mount 重新建
    canvas.addEventListener('webglcontextlost', () => {
      unmountAll()
      texCache.clear()
      state = null
      booting = null
    })

    state = { THREE, renderer, scene, camera, mesh, material, canvas, pixelRatio }
    return state
  })()
  try {
    return await booting
  } catch (e) {
    booting = null
    throw e
  }
}

/**
 * Blob → 按显示尺寸降采样、已上下翻转的 ImageBitmap。
 *
 * 立绘原图常 1024px+，而卡片只有 ~270 CSS px 高。一屏 6~8 张全尺寸 RGBA + mipmap
 * 在手机上显存吃紧；降到「显示像素 × 1.25」每张只剩 ~1MB 级，缩小采样的摩尔纹也更轻。
 * 小于目标的图不放大。
 *
 * `imageOrientation: 'flipY'` + 纹理 `flipY = false`：ImageBitmap 上传时 WebGL 不认
 * UNPACK_FLIP_Y，翻转必须在解码时做（three 文档的推荐写法）。
 */
async function bitmapOf(blob: Blob, maxH: number): Promise<ImageBitmap> {
  const src = await createImageBitmap(blob)
  try {
    const opts: ImageBitmapOptions = { imageOrientation: 'flipY' }
    if (src.height > maxH) {
      opts.resizeHeight = maxH
      opts.resizeQuality = 'high'
    }
    return await createImageBitmap(src, opts)
  } finally {
    src.close()
  }
}

async function loadPair(
  s: State,
  key: string,
  color: Blob,
  depth: Blob,
  colorH: number,
): Promise<TexPair> {
  const hit = texCache.get(key)
  if (hit) {
    // 刷新 LRU 次序
    texCache.delete(key)
    texCache.set(key, hit)
    return hit
  }
  const [cBmp, dBmp] = await Promise.all([
    bitmapOf(color, colorH),
    bitmapOf(depth, Math.min(512, colorH)),
  ])
  const { THREE } = s
  const colorTex = new THREE.Texture(cBmp)
  const depthTex = new THREE.Texture(dBmp)
  for (const t of [colorTex, depthTex]) {
    t.flipY = false
    // 两张都不转换，理由见 boot() 里 outputColorSpace 那段
    t.colorSpace = THREE.NoColorSpace
    t.wrapS = THREE.ClampToEdgeWrapping
    t.wrapT = THREE.ClampToEdgeWrapping
    t.needsUpdate = true
  }
  // ⚠️ 颜色贴图用**纯双线性、不生成 mipmap**。
  // 曾经用三线性 mipmap 是因为纹理还是 1024+ 原图、显示只有 ~300px，是重度缩小采样，
  // mipmap 能压摩尔纹。但现在纹理在 loadPair 前已按**显示设备像素**降采样（见 mount 的 colorH），
  // 纹理 ≈ 显示尺寸、几乎 1:1，此时三线性 mipmap 会在 mip0/mip1 之间混合，把画面糊掉一档 ——
  // 这正是「鼠标 hover 后明显变模糊」的直接原因（静态 <img> 是浏览器把原图高质量直缩，更锐）。
  // 近 1:1 的双线性最接近浏览器 <img> 的观感；降采样交给 createImageBitmap 的 high 质量档做。
  colorTex.minFilter = THREE.LinearFilter
  colorTex.magFilter = THREE.LinearFilter
  colorTex.generateMipmaps = false
  // 深度图：着色器里已做 9 点模糊，uTexel 按它的实际分辨率算，保持线性、不生成 mipmap
  depthTex.minFilter = THREE.LinearFilter
  depthTex.generateMipmaps = false

  const pair: TexPair = {
    color: colorTex,
    depth: depthTex,
    imgAspect: cBmp.width / cBmp.height,
    texel: [1 / dBmp.width, 1 / dBmp.height],
    refs: 0,
  }
  texCache.set(key, pair)
  return pair
}

/** 淘汰最久没用、且没有视图在用的纹理，直到回到上限 */
function trimCache(): void {
  for (const [key, pair] of texCache) {
    if (texCache.size <= TEX_CACHE_MAX) return
    if (pair.refs > 0) continue
    pair.color.dispose()
    pair.depth.dispose()
    ;(pair.color.image as ImageBitmap | undefined)?.close?.()
    ;(pair.depth.image as ImageBitmap | undefined)?.close?.()
    texCache.delete(key)
  }
}

/** 按画框当前尺寸设置 2D canvas 的像素尺寸 */
function sizeView(v: View, pr: number): void {
  v.cssW = v.el.clientWidth
  v.cssH = v.el.clientHeight
  const w = Math.max(1, Math.round(v.cssW * pr))
  const h = Math.max(1, Math.round(v.cssH * pr))
  if (v.canvas.width !== w) v.canvas.width = w
  if (v.canvas.height !== h) v.canvas.height = h
}

/** 离屏 canvas 至少要装得下最大的那个视图；只在变大时重设，避免每帧重分配 */
function ensureStageSize(s: State): void {
  let w = 1
  let h = 1
  for (const v of views.values()) {
    w = Math.max(w, v.cssW)
    h = Math.max(h, v.cssH)
  }
  const size = s.renderer.getSize(new s.THREE.Vector2())
  if (size.x < w || size.y < h) s.renderer.setSize(Math.max(size.x, w), Math.max(size.y, h), false)
}

function renderView(s: State, v: View): void {
  if (v.cssW < 1 || v.cssH < 1) return
  const { renderer, scene, camera, mesh, material } = s
  const u = material.uniforms
  u['uColor']!.value = v.tex.color
  u['uDepth']!.value = v.tex.depth
  ;(u['uTexel']!.value as THREE_NS.Vector2).set(v.tex.texel[0], v.tex.texel[1])

  // object-fit: cover —— 按短边铺满、长边居中裁切，和那张静态 <img> 的行为一致。
  // 立绘常见 9:16，卡片是 2:3，不做这一步就会被压扁。
  let coverX = 1
  let coverY = 1
  if (v.tex.imgAspect > v.aspect)
    coverX = v.aspect / v.tex.imgAspect // 图更宽 → 裁两侧
  else
    coverY = v.tex.imgAspect / v.aspect // 图更高 → 裁上下
  // 再乘 OVERSCAN 抵消平面放大：可见区域正好落回完整取景，与静态图不跳变
  ;(u['uUvScale']!.value as THREE_NS.Vector2).set(coverX * OVERSCAN, coverY * OVERSCAN)

  // 平面按比例摆正，并略大于视口，位移时四边不会露底
  mesh.scale.set(2 * v.aspect * OVERSCAN, 2 * OVERSCAN, 1)
  if (camera.left !== -v.aspect) {
    camera.left = -v.aspect
    camera.right = v.aspect
    camera.updateProjectionMatrix()
  }

  renderer.setViewport(0, 0, v.cssW, v.cssH)
  renderer.render(scene, camera)
  // WebGL 视口原点在左下，drawImage 的源坐标原点在左上：取离屏 canvas 底部那一块
  const pw = v.canvas.width
  const ph = v.canvas.height
  v.ctx.clearRect(0, 0, pw, ph)
  v.ctx.drawImage(s.canvas, 0, s.canvas.height - ph, pw, ph, 0, 0, pw, ph)
  // 第一次画好才挂进画框：挂早了会先露出一块空白 canvas 盖住静态图
  if (!v.canvas.parentNode) v.el.appendChild(v.canvas)
}

function tick(): void {
  raf = 0
  const s = state
  if (!s || !views.size) return
  current.x += (target.x - current.x) * LERP
  current.y += (target.y - current.y) * LERP
  // 反向：指针右移时近景往左走，才是「透过窗口看进去」的方向感
  ;(s.material.uniforms['uMouse']!.value as THREE_NS.Vector2).set(-current.x, current.y)
  ensureStageSize(s)
  for (const v of views.values()) renderView(s, v)

  // 还没收敛就继续跑；收敛了就停，空闲时零开销
  if (Math.abs(target.x - current.x) > 0.001 || Math.abs(target.y - current.y) > 0.001) {
    raf = requestAnimationFrame(tick)
  }
}

function schedule(): void {
  if (!raf) raf = requestAnimationFrame(tick)
}

export interface MountArgs {
  /** 画框元素，2D canvas 会挂进它内部 */
  el: HTMLElement
  /** 纹理缓存键（立绘与深度图的 blobId 组合） */
  key: string
  color: Blob
  depth: Blob
  /** 画框宽高比（宽/高），用来把平面摆正 */
  aspect: number
}

/**
 * 给一个画框挂上视差视图。重复挂同一个画框直接返回 true。
 * 任何失败都静默返回 false —— 视差是纯装饰，绝不能让它把列表搞崩，画框里仍是静态 <img>。
 */
export async function mount(args: MountArgs): Promise<boolean> {
  const { el } = args
  if (views.has(el)) return true
  if (views.size + pending.size >= MAX_VIEWS) return false
  const token = ++pendingSeq
  pending.set(el, token)
  try {
    const s = await boot()
    if (pending.get(el) !== token) return false
    // 纹理高度按**显示设备像素**取（含 OVERSCAN 的一点点余量），不再乘 1.25 再 128-向上取整 ——
    // 纹理高度 = 显示设备像素 × OVERSCAN × 2 倍超采样（见 SUPERSAMPLE），配双线性无 mipmap = 锐利无糊。
    // 仍按 64 档缓存（同尺寸卡共用一份）。上限 1280：桌面单卡 hover 约 900px 用不到，主要给手机
    // 可视区最多 10 张卡的显存兜底（手机 ~800px 显示 ×2 ≈ 1600，夹到 1280 = ~1.6× 超采样，仍锐利）。
    const colorH = Math.min(
      1280,
      Math.max(
        256,
        Math.round((el.clientHeight * s.pixelRatio * OVERSCAN * SUPERSAMPLE) / 64) * 64,
      ),
    )
    const tex = await loadPair(s, `${args.key}@${colorH}`, args.color, args.depth, colorH)
    if (pending.get(el) !== token || state !== s) return false

    const canvas = document.createElement('canvas')
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none'
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    tex.refs++
    const v: View = { el, tex, aspect: args.aspect, canvas, ctx, cssW: 0, cssH: 0 }
    sizeView(v, s.pixelRatio)
    views.set(el, v)
    resizeObs ??= new ResizeObserver((entries) => {
      const st = state
      if (!st) return
      for (const e of entries) {
        const view = views.get(e.target as HTMLElement)
        if (view) sizeView(view, st.pixelRatio)
      }
      schedule()
    })
    resizeObs.observe(el)
    // 新视图至少画一帧（即使指针 / 倾斜早已收敛）
    schedule()
    return true
  } catch (e) {
    // 对用户静默降级，但开发期必须看得见 —— 这里曾经吞掉一个 outputColorSpace 的
    // TypeError，表现只是「没反应」，查了好几轮才定位到。
    if (import.meta.env.DEV) console.warn('[parallax] mount 失败，已降级为静态图片：', e)
    return false
  } finally {
    if (pending.get(el) === token) pending.delete(el)
  }
}

/** 摘下一个画框的视图。纹理留在缓存里，滚回来直接复用 */
export function unmount(el: HTMLElement): void {
  pending.delete(el)
  const v = views.get(el)
  if (!v) return
  views.delete(el)
  resizeObs?.unobserve(el)
  v.canvas.remove()
  v.tex.refs = Math.max(0, v.tex.refs - 1)
  trimCache()
  if (!views.size) {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    target = { x: 0, y: 0 }
    current = { x: 0, y: 0 }
  }
}

export function unmountAll(): void {
  pending.clear()
  for (const el of [...views.keys()]) unmount(el)
}

/** 指针 / 倾斜位置，两个分量都是 -1..1（左上为 -1,-1）。作用于所有视图 */
export function move(nx: number, ny: number): void {
  target = { x: nx, y: ny }
  if (views.size) schedule()
}

/** 当前活跃视图数（调试 / 测试用） */
export function viewCount(): number {
  return views.size
}
