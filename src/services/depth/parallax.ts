/**
 * 基于深度图的真视差渲染器（three.js）。
 *
 * ## 为什么是**一个**全局渲染器
 * 浏览器的 WebGL 上下文上限在 8~16 个。一张卡一个 canvas，角色一多就会开始
 * 丢上下文，表现是**卡片随机变黑**且不报错。而同一时刻只有一张卡被 hover ——
 * 所以全局只建一个渲染器，用 attach() 把它的 canvas 挪到当前那张卡里去。
 *
 * canvas 是**挂进画框元素内部**（absolute inset:0）而不是 fixed 定位：
 * 这样滚动、布局变化都由浏览器自己管，不需要同步坐标。
 *
 * ## 为什么是顶点位移而不是 UV 偏移
 * UV 偏移（`uv += (depth-0.5)*k`）便宜、无需几何，但深度突变处会拉出涂抹感，
 * 人像的头发边缘尤其明显。细分平面按深度**位移顶点**才是真视差：近景与远景
 * 走不同的量、方向相反，重叠时还能靠深度缓冲正确遮挡。
 *
 * ⚠️ 代价：没有背景修补，深度断崖处会被**拉伸**（被遮挡的背景像素本就不存在）。
 * 靠两件事压住：位移幅度小，以及顶点着色器里对深度做 5 点模糊把断崖抹成斜坡 ——
 * 拉伸比撕裂好看得多。想彻底解决要做 inpainting，那是另一个量级。
 *
 * 纯 service：不 import vue/pinia。three.js 是**动态 import** 的，
 * 不开视差就一个字节都不下载。
 */

import type * as THREE_NS from 'three'

/** 细分密度。2:3 的卡，横向 96 段就足够让断崖过渡平滑，再高只是白烧顶点 */
const SEG_X = 96
const SEG_Y = 144
/** 平面比视口略大，位移时四边才不会露出底色 */
const OVERSCAN = 1.12
/**
 * 视差强度，单位是**世界单位**（视口高度固定为 2）。
 *
 * 顶点位移量 = STRENGTH × 指针(-1..1) × (深度-0.5)，所以单侧最大位移是
 * STRENGTH/2 = 0.09，约等于画面高度的 4.5% —— 明显看得见，又不至于把
 * 深度断崖处拉得太夸张。
 *
 * ⚠️ 别回头改成「透视相机 + 相机位移」那套：实测过，视差量
 * ≈ 相机位移 × z / 相机距离，相机在 3 个单位外时算出来**不到 1 个像素**，
 * 两帧互相关的位移是 0。想靠加大相机位移补回来就得把相机甩出画面。
 * 正交 + 显式位移的幅度是直接可控的，不受相机距离摆布。
 */
const STRENGTH = 0.18
/** 指数平滑系数：越小越黏手。0.12 在 60Hz 下约 120ms 跟手时间 */
const LERP = 0.12

const VERT = /* glsl */ `
uniform sampler2D uDepth;
uniform float uStrength;
uniform vec2 uMouse;
uniform vec2 uTexel;
varying vec2 vUv;

// 5 点十字模糊：把深度断崖抹成斜坡，撕裂变拉伸
float depthAt(vec2 uv) {
  float c = texture2D(uDepth, uv).r;
  float l = texture2D(uDepth, uv - vec2(uTexel.x, 0.0)).r;
  float r = texture2D(uDepth, uv + vec2(uTexel.x, 0.0)).r;
  float u = texture2D(uDepth, uv - vec2(0.0, uTexel.y)).r;
  float d = texture2D(uDepth, uv + vec2(0.0, uTexel.y)).r;
  return (c * 2.0 + l + r + u + d) / 6.0;
}

void main() {
  vUv = uv;
  // Depth Anything 的约定：值越大越近。减 0.5 让中景成为不动的支点，
  // 近景朝一边走、远景朝另一边走 —— 这个反向才是「视差」，
  // 全部同向只会读成整张图在平移。
  float d = depthAt(uv) - 0.5;
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
  canvas: HTMLCanvasElement
}

let state: State | null = null
let booting: Promise<State> | null = null

/** 当前附着的宿主元素。为空表示渲染器空闲 */
let host: HTMLElement | null = null
let raf = 0
/** 目标与当前的归一化指针位置，各分量 -1..1 */
let target = { x: 0, y: 0 }
let current = { x: 0, y: 0 }
/** attach 是异步的，用世代号作废掉过期的那次 */
let generation = 0

async function boot(): Promise<State> {
  if (state) return state
  if (booting) return booting
  booting = (async () => {
    const THREE = await import('three')
    const canvas = document.createElement('canvas')
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none'
    // preserveDrawingBuffer 刻意不开：它有真实的性能代价，而唯一的用处是让
    // drawImage/readPixels 能读回画面 —— 那只在调参测量时需要，临时开一下即可
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    // DPR 封到 2：立绘卡最大也就 300px 宽，3x 屏上再往上加纯属浪费显存
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

    const scene = new THREE.Scene()
    // 正交：视口高度恒为 2，位移幅度就等于「占画面高度的比例」，
    // 不受相机距离影响。left/right 在 attach 时按图片比例设定。
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
        uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      },
    })
    const geo = new THREE.PlaneGeometry(1, 1, SEG_X, SEG_Y)
    const mesh = new THREE.Mesh(geo, material)
    scene.add(mesh)

    state = { THREE, renderer, scene, camera, mesh, material, canvas }
    return state
  })()
  return booting
}

function loadTexture(THREE: typeof THREE_NS, url: string): Promise<THREE_NS.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, () => reject(new Error('纹理加载失败')))
  })
}

function tick(): void {
  raf = 0
  if (!state || !host) return
  current.x += (target.x - current.x) * LERP
  current.y += (target.y - current.y) * LERP

  const { camera, renderer, scene, material } = state
  // 反向：指针右移时近景往左走，才是「透过窗口看进去」的方向感
  ;(material.uniforms['uMouse']!.value as THREE_NS.Vector2).set(-current.x, current.y)
  renderer.render(scene, camera)

  // 还没收敛就继续跑；收敛了就停，空闲时零开销
  if (Math.abs(target.x - current.x) > 0.001 || Math.abs(target.y - current.y) > 0.001) {
    raf = requestAnimationFrame(tick)
  }
}

function schedule(): void {
  if (!raf) raf = requestAnimationFrame(tick)
}

export interface AttachArgs {
  /** 画框元素，canvas 会挂进它内部 */
  el: HTMLElement
  colorUrl: string
  depthUrl: string
  /** 图片宽高比（宽/高），用来把平面摆正 */
  aspect: number
}

/**
 * 把渲染器附着到某张卡上。重复调用会先摘掉上一张。
 * 任何失败都静默返回 false —— 视差是纯装饰，绝不能让它把列表搞崩。
 */
export async function attach(args: AttachArgs): Promise<boolean> {
  const gen = ++generation
  try {
    const s = await boot()
    if (gen !== generation) return false // 等待期间鼠标已经移走或换了卡

    const [color, depth] = await Promise.all([
      loadTexture(s.THREE, args.colorUrl),
      loadTexture(s.THREE, args.depthUrl),
    ])
    if (gen !== generation) {
      color.dispose()
      depth.dispose()
      return false
    }
    color.colorSpace = s.THREE.SRGBColorSpace
    // 深度是数据不是颜色，走线性空间；夹边避免采样到对侧像素
    depth.colorSpace = s.THREE.NoColorSpace
    for (const t of [color, depth]) {
      t.wrapS = s.THREE.ClampToEdgeWrapping
      t.wrapT = s.THREE.ClampToEdgeWrapping
      t.minFilter = s.THREE.LinearFilter
    }

    disposeTextures()
    s.material.uniforms['uColor']!.value = color
    s.material.uniforms['uDepth']!.value = depth
    // TextureLoader 的 image 类型是 {}，实际是 HTMLImageElement
    const dImg = depth.image as { width?: number; height?: number } | undefined
    const dw = dImg?.width || 512
    const dh = dImg?.height || 512
    ;(s.material.uniforms['uTexel']!.value as THREE_NS.Vector2).set(1 / dw, 1 / dh)

    // 平面按图片比例摆正，并略大于视口，相机偏移时不会露边
    s.mesh.scale.set(2 * args.aspect * OVERSCAN, 2 * OVERSCAN, 1)
    s.camera.left = -args.aspect
    s.camera.right = args.aspect
    s.camera.updateProjectionMatrix()

    const w = args.el.clientWidth
    const h = args.el.clientHeight
    s.renderer.setSize(w, h, false)

    host = args.el
    args.el.appendChild(s.canvas)
    current = { ...target }
    schedule()
    return true
  } catch {
    return false
  }
}

/** 指针位置，两个分量都是 -1..1（左上为 -1,-1） */
export function move(nx: number, ny: number): void {
  target = { x: nx, y: ny }
  schedule()
}

function disposeTextures(): void {
  if (!state) return
  for (const k of ['uColor', 'uDepth'] as const) {
    const t = state.material.uniforms[k]?.value as THREE_NS.Texture | null
    t?.dispose()
    if (state.material.uniforms[k]) state.material.uniforms[k]!.value = null
  }
}

/** 摘下渲染器。canvas 留着复用，只把纹理还回去 */
export function detach(): void {
  generation++
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
  if (state && host && state.canvas.parentNode === host) host.removeChild(state.canvas)
  host = null
  target = { x: 0, y: 0 }
  current = { x: 0, y: 0 }
  disposeTextures()
}
