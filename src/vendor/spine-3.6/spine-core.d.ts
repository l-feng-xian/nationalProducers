/**
 * vendored spine-core.js（3.6）的**最小类型声明** —— 只声明我们真正调用的那部分。
 *
 * 刻意不求完整：3.6 的完整 API 有上百个类，全声明既没必要又容易写错。
 * 这里每一条都按 3.6 源码核对过，尤其是那几处与 4.x 不同的签名 ——
 * 它们正是「按 4.x 记忆写、运行时才炸」的高发点，注释里逐条标了出来。
 */

declare namespace spine {
  class Color {
    r: number
    g: number
    b: number
    a: number
  }

  /** 图集区域。注意贴图挂在 `texture` 上，不是 `renderObject` */
  class TextureAtlasRegion {
    name: string
    texture: Texture
    rotate: boolean
    u: number
    v: number
    u2: number
    v2: number
    width: number
    height: number
    originalWidth: number
    originalHeight: number
  }

  /**
   * 自定义纹理的基类。
   * ⚠️ `setFilters`/`setWraps` 收到的是 **WebGL 数字常量**（9728/9729/33071…），
   * 不是 three 的枚举，别直接转手喂给 three。
   */
  abstract class Texture {
    constructor(image: unknown)
    getImage(): unknown
    abstract setFilters(min: number, mag: number): void
    abstract setWraps(u: number, v: number): void
    abstract dispose(): void
  }

  class TextureAtlas {
    /** loader 必须**同步**返回一个已知真实像素尺寸的纹理 —— 图片没 decode 完会让 UV 全变 NaN */
    constructor(atlasText: string, textureLoader: (path: string) => Texture)
    regions: TextureAtlasRegion[]
    findRegion(name: string): TextureAtlasRegion | null
    dispose(): void
  }

  class AtlasAttachmentLoader {
    constructor(atlas: TextureAtlas)
  }

  class Attachment {
    name: string
  }

  /** ⚠️ 3.6 的 computeWorldVertices 第一个参数是 **bone**；4.x 才是 slot */
  class RegionAttachment extends Attachment {
    color: Color
    region: TextureAtlasRegion
    /** 8 个 float = 4 组 uv，与顶点一一对应。会被 setRegion 原地改写，取用要复制 */
    uvs: Float32Array
    computeWorldVertices(
      bone: Bone,
      worldVertices: Float32Array | number[],
      offset: number,
      stride: number,
    ): void
  }

  /** ⚠️ 与 RegionAttachment 相反，网格的第一个参数是 **slot** */
  class MeshAttachment extends Attachment {
    color: Color
    /** **分量数**（= 顶点数 × 2），不是顶点数 */
    worldVerticesLength: number
    /** 已映射到图集页空间的 uv，直接可用；regionUVs 是相对单图的，别用错 */
    uvs: Float32Array
    triangles: number[]
    computeWorldVertices(
      slot: Slot,
      start: number,
      count: number,
      worldVertices: Float32Array | number[],
      offset: number,
      stride: number,
    ): void
  }

  class Bone {
    a: number
    b: number
    c: number
    d: number
    worldX: number
    worldY: number
  }

  class SlotData {
    name: string
    /** 数字枚举 0..3，不是字符串。⚠️ 在 data 上，不在 slot 上 */
    blendMode: number
  }

  class Slot {
    bone: Bone
    data: SlotData
    color: Color
    /** ⚠️ 用 getAttachment()，3.6 的 attachment 字段是 private */
    getAttachment(): Attachment | null
  }

  class Animation {
    name: string
    duration: number
  }

  class SkeletonData {
    bones: unknown[]
    slots: SlotData[]
    skins: unknown[]
    animations: Animation[]
    ikConstraints: unknown[]
    /** 找不到返回 null。setAnimation 传不存在的名字会**抛错**，必须先查 */
    findAnimation(name: string): Animation | null
  }

  class SkeletonJson {
    constructor(attachmentLoader: AtlasAttachmentLoader)
    scale: number
    /** 收**已解析的对象**或字符串都行 */
    readSkeletonData(json: unknown): SkeletonData
  }

  class Skeleton {
    constructor(data: SkeletonData)
    /** ⚠️ 3.6 用 flipX 做水平翻转；写 scaleX = -1 是 4.x 写法，在这里静默无效 */
    flipX: boolean
    flipY: boolean
    x: number
    y: number
    color: Color
    /** 绘制顺序。⚠️ 遍历这个，不是 slots */
    drawOrder: Slot[]
    slots: Slot[]
    setToSetupPose(): void
    /** ⚠️ 3.6 **不接参数**；4.2 的 updateWorldTransform(Physics.update) 在这里会 TypeError */
    updateWorldTransform(): void
  }

  class AnimationStateData {
    constructor(data: SkeletonData)
    defaultMix: number
  }

  class AnimationState {
    constructor(data: AnimationStateData)
    /** delta 单位是**秒** */
    update(delta: number): void
    apply(skeleton: Skeleton): boolean
    setAnimation(trackIndex: number, animationName: string, loop: boolean): unknown
  }
}

declare const spineDefault: typeof spine
export default spineDefault
