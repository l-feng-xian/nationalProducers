/**
 * Spine 3.6 → three.js 的渲染层。
 *
 * 官方 3.6 只提供 WebGL / canvas 两个后端，没有 three 的。所以骨骼解算全交给
 * vendored 的官方运行时（久经验证），这里只负责把每帧的结果搬成 BufferGeometry。
 *
 * ## 3.6 与 4.x 的几处致命差异（都踩过验证）
 * - `RegionAttachment.computeWorldVertices(**bone**, …)`，而
 *   `MeshAttachment.computeWorldVertices(**slot**, …)` —— 第一个参数不是一回事。
 *   传错不报错，读到 undefined 的 a/b/c/d 产出 NaN 顶点，表现是整块消失。
 * - `skeleton.updateWorldTransform()` **不接参数**（4.2 要传 Physics.update）。
 * - 水平翻转是 `skeleton.flipX = true`；写 `scaleX = -1` 是 4.x 写法，这里静默无效。
 * - 遍历 `skeleton.drawOrder` 而不是 `slots`；附件用 `slot.getAttachment()`；
 *   混合模式在 `slot.data.blendMode`。
 *
 * 纯 service：不 import vue/pinia。spine 与 three 都是动态 import。
 *
 * ⚠️ 许可：vendored 的 Spine Runtimes 要求每个使用者自备 Spine Editor 授权。
 */

import type * as THREE_NS from 'three'
import type { CharacterRig, RigState } from './rig'

/** 一个 slot 的每帧最大顶点数。本资源最大的网格 65 顶点，留足余量 */
const MAX_VERTS = 256

export interface SpineAssetPaths {
  /** 资源目录，例如 /1_1001 */
  dir: string
  /** 图集文件名 */
  atlas: string
  /** 骨架 JSON 文件名 */
  json: string
}

type SpineNS = typeof import('@/vendor/spine-3.6/spine-core.js').default

export interface SpineLoadResult {
  /** 运行时命名空间。动态 import 过的模块没法从数据反查构造函数，随结果一起带出来 */
  spine: SpineNS
  data: InstanceType<SpineNS['SkeletonData']>
  atlas: InstanceType<SpineNS['TextureAtlas']>
  /** 供 dispose 用 */
  textures: THREE_NS.Texture[]
}

/** 动作名映射：本资源是横向战斗单位，只有这两个能当行走/待机用 */
const ANIM = { idle: 'standby', walk: 'move' } as const

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`图片加载失败：${url}`))
    img.src = url
  })
}

/**
 * 补上 region 附件缺失的 width/height。
 *
 * ## 为什么需要这一步
 * 本项目这份骨架是**从 DragonBones 转换过来的**（skeleton 块里写着
 * `"name":"armatureName"`，那是 DragonBones 的术语）。转换工具没有写出 region
 * 附件的 `width`/`height` —— 实测 24 个 region 附件**全部**只有 name/x/y。
 *
 * 而 3.6 的 SkeletonJson 是直接 `region.width = map.width * scale`，没有默认值，
 * 于是 `undefined * 1 = NaN`；NaN 再流进 `updateOffset()` 的
 * `this.width / region.originalWidth`，四个角点全变 NaN。
 *
 * 症状极具迷惑性：**网格部件（身体、手脚）完全正常，只有 region 部件（头、
 * 头发、耳朵、武器）整块消失**，而且控制台一声不吭 —— 因为 typed array 写入
 * NaN 不报错，three 只会在算包围球时抱怨一句。
 *
 * 修法就是把它该有的值补回去：region 附件不显式给尺寸时，本来就该按图集里
 * 那块图的原始尺寸绘制，`originalWidth/originalHeight` 正是这个值。补完必须
 * 重新 `updateOffset()`，否则 offset 里还留着上一轮算出来的 NaN。
 */
function repairRegionSizes(spine: SpineNS, data: InstanceType<SpineNS['SkeletonData']>): number {
  let fixed = 0
  const skins = (data as unknown as { skins?: { attachments?: Record<string, unknown>[] }[] }).skins
  for (const skin of skins ?? []) {
    for (const bySlot of skin.attachments ?? []) {
      if (!bySlot) continue
      for (const att of Object.values(bySlot)) {
        if (!(att instanceof spine.RegionAttachment)) continue
        const a = att as unknown as {
          width: number
          height: number
          region: { originalWidth: number; originalHeight: number }
          updateOffset(): void
        }
        if (Number.isFinite(a.width) && Number.isFinite(a.height)) continue
        a.width = a.region.originalWidth
        a.height = a.region.originalHeight
        a.updateOffset()
        fixed++
      }
    }
  }
  if (fixed && import.meta.env.DEV) {
    console.info(
      `[rpg] 已为 ${fixed} 个 region 附件补齐缺失的 width/height（资源由 DragonBones 转换而来）`,
    )
  }
  return fixed
}

/**
 * 载入 Spine 资源。
 *
 * **任何失败都返回 null 而不是抛**：角色渲染不起来时应当降级成占位小人，
 * 绝不能把整个游戏场景带崩（与 parallax.ts 的静默降级同一套原则）。
 * 版本不符正是最常见的失败——3.6 运行时读 4.x 数据、或反过来，都会在这里失败。
 */
export async function loadSpine(
  paths: SpineAssetPaths,
  THREE: typeof THREE_NS,
): Promise<SpineLoadResult | null> {
  try {
    const { default: spine } = await import('@/vendor/spine-3.6/spine-core.js')
    const base = paths.dir.replace(/\/$/, '')
    const [atlasText, jsonText] = await Promise.all([
      fetch(`${base}/${paths.atlas}`).then((r) => r.text()),
      fetch(`${base}/${paths.json}`).then((r) => r.text()),
    ])

    // 图集里引用的图片名可能不止一张，先全部解码好再建 TextureAtlas ——
    // ⚠️ TextureAtlas 在构造期间就会读 getImage().width，图片没 decode 完
    // 会让 page.width = 0，所有 UV 变成 Infinity/NaN，整个骨架不可见。
    const pageNames = atlasText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /\.(png|jpg|jpeg|webp)$/i.test(l))
    const images = new Map<string, HTMLImageElement>()
    await Promise.all(
      pageNames.map(async (n) => {
        const img = await loadImage(`${base}/${n}`)
        if (img.decode) await img.decode().catch(() => undefined)
        images.set(n, img)
      }),
    )

    const textures: THREE_NS.Texture[] = []
    class ThreeTex extends spine.Texture {
      readonly tex: THREE_NS.Texture
      constructor(image: HTMLImageElement) {
        super(image)
        const t = new THREE.Texture(image)
        // ⚠️ Spine 的 v 以图片**顶部**为 0，而 three 默认 flipY=true。
        // 不关掉的话每个 region 各自上下镜像 —— 表现像「五官错位」，
        // 很容易被误判成 uv 顺序写错而去改别的地方。
        t.flipY = false
        t.colorSpace = THREE.SRGBColorSpace
        t.generateMipmaps = false
        t.minFilter = THREE.LinearFilter
        t.magFilter = THREE.LinearFilter
        t.needsUpdate = true
        this.tex = t
        textures.push(t)
      }
      // 3.6 传进来的是 WebGL 数字常量，与 three 的枚举不是一套，直接忽略
      setFilters(): void {}
      setWraps(): void {}
      dispose(): void {
        this.tex.dispose()
      }
    }

    const atlas = new spine.TextureAtlas(atlasText, (p: string) => {
      const img = images.get(p) ?? [...images.values()][0]
      if (!img) throw new Error(`图集引用的图片不存在：${p}`)
      return new ThreeTex(img)
    })
    const loader = new spine.AtlasAttachmentLoader(atlas)
    const json = new spine.SkeletonJson(loader)
    const data = json.readSkeletonData(JSON.parse(jsonText))
    repairRegionSizes(spine, data)
    return { spine, data, atlas, textures }
  } catch (e) {
    if (import.meta.env.DEV) {
      console.warn(
        '[rpg] Spine 资源加载失败，已降级为占位角色。' +
          '最常见原因是**运行时与导出版本不符**（本项目 vendored 的是 3.6）：',
        e,
      )
    }
    return null
  }
}

export interface SpineRigOptions {
  THREE: typeof THREE_NS
  /** 相机俯角（弧度），billboard 要按它回正 */
  pitch: number
  /** 目标高度（格）。骨架会整体缩放到这个高度 */
  height: number
}

interface SlotMesh {
  mesh: THREE_NS.Mesh
  geo: THREE_NS.BufferGeometry
  mat: THREE_NS.MeshBasicMaterial
  pos: Float32Array
  uv: Float32Array
}

/**
 * 用已载入的骨架数据建一个可播放的角色。
 *
 * ⚠️ SkeletonData 可以多个角色共用，但 **Skeleton 与 AnimationState 必须每个角色各建一份**，
 * 否则所有 NPC 会同步做一模一样的动作。
 */
export function createSpineRig(load: SpineLoadResult, opts: SpineRigOptions): CharacterRig {
  const { THREE, pitch } = opts
  const { spine, data } = load
  const skeleton = new spine.Skeleton(data)
  // ⚠️ Skeleton 构造只调了 updateCache()，没有算世界变换：
  // 所有 bone 的 a/b/c/d 初值是 0，此时求顶点会全塌到原点（表现为「角色不见了」）。
  skeleton.setToSetupPose()
  skeleton.updateWorldTransform()

  const stateData = new spine.AnimationStateData(data)
  stateData.defaultMix = 0.15
  const state = new spine.AnimationState(stateData)

  const root = new THREE.Group()
  // 与装饰物同一套「立在地面且正对相机」的姿态
  root.rotation.set(-pitch, 0, 0)
  const inner = new THREE.Group()
  root.add(inner)

  // 骨架单位 → 世界单位。用 setup pose 的包围盒高度换算，做到不同资源都能对齐目标高度
  let minY = Infinity
  let maxY = -Infinity
  const probe = new Float32Array(MAX_VERTS * 2)
  for (const slot of skeleton.drawOrder) {
    const att = slot.getAttachment()
    if (!att) continue
    const n = readVertices(slot, att, probe)
    for (let i = 0; i < n; i += 2) {
      const y = probe[i + 1] ?? 0
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const span = maxY - minY
  const scale = span > 0 ? opts.height / span : 0.006
  inner.scale.setScalar(scale)
  // 把脚底挪到原点，rig 的落地公式才对得上
  inner.position.y = -minY * scale

  /** 求一个 slot 当前的世界顶点，写进 out，返回写入的分量数 */
  function readVertices(
    slot: InstanceType<SpineNS['Slot']>,
    att: InstanceType<SpineNS['Attachment']>,
    out: Float32Array,
  ): number {
    if (att instanceof spine.RegionAttachment) {
      // ⚠️ region 传的是 **bone**
      att.computeWorldVertices(slot.bone, out, 0, 2)
      return 8
    }
    if (att instanceof spine.MeshAttachment) {
      const n = att.worldVerticesLength
      if (n > out.length) return 0
      // ⚠️ mesh 传的是 **slot**；count 是分量数不是顶点数
      att.computeWorldVertices(slot, 0, n, out, 0, 2)
      return n
    }
    return 0
  }

  const QUAD = [0, 1, 2, 2, 3, 0]
  const meshes = new Map<InstanceType<SpineNS['Slot']>, SlotMesh>()

  function ensureMesh(slot: InstanceType<SpineNS['Slot']>, order: number): SlotMesh {
    let m = meshes.get(slot)
    if (m) return m
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(MAX_VERTS * 3)
    const uv = new Float32Array(MAX_VERTS * 2)
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      // 角色内部靠 renderOrder 分层、不写深度；整体仍与地形/树木做深度测试。
      // 写深度的话自己的各个部件会互相遮挡，脸会被头发的透明区切掉。
      depthWrite: false,
      depthTest: true,
      // Spine 的三角形绕向在 Y-up 下是顺时针，而 three 默认认 CCW 为正面；
      // 加上骨骼可能带负缩放，逐 slot 绕向还会翻转 —— 双面是唯一稳妥选择
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = order
    mesh.frustumCulled = false // 顶点每帧在 CPU 侧改，包围盒不可靠
    inner.add(mesh)
    m = { mesh, geo, mat, pos, uv }
    meshes.set(slot, m)
    return m
  }

  const work = new Float32Array(MAX_VERTS * 2)
  let current: RigState = 'idle'
  let facing = 1

  function rebuild(): void {
    const order = skeleton.drawOrder
    for (const m of meshes.values()) m.mesh.visible = false

    for (let i = 0; i < order.length; i++) {
      const slot = order[i]
      if (!slot) continue
      const att = slot.getAttachment()
      if (!att) continue
      const n = readVertices(slot, att, work)
      if (n === 0) continue

      const sm = ensureMesh(slot, i)
      sm.mesh.renderOrder = i
      const verts = n / 2

      // xy → xyz（z 恒 0，分层交给 renderOrder）
      for (let v = 0; v < verts; v++) {
        sm.pos[v * 3] = work[v * 2] ?? 0
        sm.pos[v * 3 + 1] = work[v * 2 + 1] ?? 0
        sm.pos[v * 3 + 2] = 0
      }

      let uvs: Float32Array
      let index: number[]
      let tex: THREE_NS.Texture | null = null
      if (att instanceof spine.RegionAttachment) {
        uvs = att.uvs
        index = QUAD
        tex = (att.region.texture as unknown as { tex: THREE_NS.Texture }).tex
      } else if (att instanceof spine.MeshAttachment) {
        uvs = att.uvs
        index = att.triangles
        const region = (att as unknown as { region?: { texture?: { tex?: THREE_NS.Texture } } })
          .region
        tex = region?.texture?.tex ?? null
      } else {
        continue
      }
      for (let v = 0; v < verts * 2; v++) sm.uv[v] = uvs[v] ?? 0

      const posAttr = sm.geo.getAttribute('position') as THREE_NS.BufferAttribute
      const uvAttr = sm.geo.getAttribute('uv') as THREE_NS.BufferAttribute
      posAttr.needsUpdate = true
      uvAttr.needsUpdate = true
      sm.geo.setDrawRange(0, index.length)
      const idx = sm.geo.getIndex()
      if (!idx || idx.count !== index.length) sm.geo.setIndex(index)
      else {
        for (let k = 0; k < index.length; k++) idx.setX(k, index[k] ?? 0)
        idx.needsUpdate = true
      }

      if (tex && sm.mat.map !== tex) {
        sm.mat.map = tex
        sm.mat.needsUpdate = true
      }
      // 最终色 = 骨架色 × 槽位色 × 附件色
      const ac = (att as unknown as { color: InstanceType<SpineNS['Color']> }).color
      sm.mat.color.setRGB(
        skeleton.color.r * slot.color.r * ac.r,
        skeleton.color.g * slot.color.g * ac.g,
        skeleton.color.b * slot.color.b * ac.b,
      )
      sm.mat.opacity = skeleton.color.a * slot.color.a * ac.a
      // blendMode 是数字枚举：1 = additive
      const additive = slot.data.blendMode === 1
      const want = additive ? THREE.AdditiveBlending : THREE.NormalBlending
      if (sm.mat.blending !== want) {
        sm.mat.blending = want
        sm.mat.needsUpdate = true
      }
      sm.mesh.visible = true
    }
  }

  function setAnim(s: RigState): void {
    const name = ANIM[s]
    // ⚠️ 动画名不存在时 setAnimation 会**抛错**，抛在 rAF 里会把整个渲染循环打断
    if (!data.findAnimation(name)) return
    state.setAnimation(0, name, true)
  }
  setAnim('idle')
  state.apply(skeleton)
  skeleton.updateWorldTransform()
  rebuild()

  return {
    object: root,
    height: opts.height,
    setFacing(dx) {
      if (dx > 0.01) facing = 1
      else if (dx < -0.01) facing = -1
      // ⚠️ 3.6 用 flipX；写 skeleton.scaleX = -1 是 4.x 写法，这里静默无效
      skeleton.flipX = facing < 0
    },
    play(s) {
      if (s === current) return
      current = s
      setAnim(s)
    },
    update(dt) {
      // 顺序是固定的：update → apply → updateWorldTransform → 取顶点
      state.update(dt)
      state.apply(skeleton)
      skeleton.updateWorldTransform()
      rebuild()
    },
    dispose() {
      for (const m of meshes.values()) {
        m.geo.dispose()
        m.mat.dispose()
      }
      meshes.clear()
    },
  }
}
