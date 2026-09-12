/**
 * 低多边形几何工具箱：顶点色 + 烘焙明暗，零贴图、零灯光。
 *
 * ## 为什么不用灯光
 * 相机是固定的正交低角度，太阳方向永远不变 —— 与其每帧算光照，
 * 不如在建几何时把「面法线 · 太阳方向」直接乘进顶点色。整条渲染管线
 * 保持 unlit（MeshBasicMaterial + vertexColors），和水面 TSL 材质并存。
 *
 * ## 为什么手写图元
 * 不 import three/examples 的 BufferGeometryUtils —— 它从 'three' 入口拉进
 * 整个 WebGLRenderer（约 365 kB），而本模块刻意只走 'three/webgpu'。
 * 盒/柱/锥/球冠/坡顶一共两百来行，自己写反而更可控。
 *
 * 纯 service：不 import vue/pinia。
 */

import type * as THREE_NS from 'three'
// 配色拆去了 palette.ts —— 创建向导的缩略预览也要用同一套颜色，
// 但不该为四个颜色把这 26 KB 的几何构建器拖进那个路由。这里原样 re-export，
// 既有 import 一个都不用改
import { TERRAIN, rgb, type RGB } from './palette'

export { TERRAIN, rgb }
export type { RGB }

// ── 太阳方向（指向光源）。相机带 45° 偏航，可见立面是 +X 与 +Z：
// 把光源偏向 +X，两个可见面一亮一暗，菱形视角的立体感主要靠这一档差 ──
const LIGHT = { x: 0.55, y: 0.75, z: 0.18 }
/** 背光面的保底亮度。0.58 让背光面是「柔和变暗」而不是死黑 */
const AMB = 0.58

function shadeOf(nx: number, ny: number, nz: number): number {
  const d = nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z
  return AMB + (1 - AMB) * Math.max(0, d)
}

/**
 * 三角形累加器。所有图元最终都落到 quad / tri 两个原语上；
 * 面法线由叉积得出，明暗随之烘焙 —— 调用方不用关心朝向。
 */
export class MeshBuilder {
  private readonly pos: number[] = []
  private readonly col: number[] = []

  get triangles(): number {
    return this.pos.length / 9
  }

  tri(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    c: RGB,
  ): void {
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az
    const vx = cx - ax,
      vy = cy - ay,
      vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    ny /= len
    nz /= len
    const s = shadeOf(nx, ny, nz)
    const r = c.r * s,
      g = c.g * s,
      b = c.b * s
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz)
    this.col.push(r, g, b, r, g, b, r, g, b)
  }

  /** 四边形（顶点序为从外侧看逆时针），拆成两个三角形 */
  quad(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
    c: RGB,
  ): void {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, c)
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz, c)
  }

  /**
   * 轴对齐的朝上四边形（地形顶面 / 水面专用）。
   * 法线固定 +Y，不走叉积 —— 高度相同的格子明暗必须一致，否则拼出来闪烁。
   */
  topQuad(x0: number, y0: number, z0: number, x1: number, z1: number, c: RGB): void {
    const s = shadeOf(0, 1, 0)
    const r = c.r * s,
      g = c.g * s,
      b = c.b * s
    this.pos.push(x0, y0, z1, x1, y0, z1, x1, y0, z0, x0, y0, z1, x1, y0, z0, x0, y0, z0)
    for (let i = 0; i < 6; i++) this.col.push(r, g, b)
  }

  /** 轴对齐的竖直立面（地形侧面专用） */
  sideQuad(
    x0: number,
    yTop: number,
    z0: number,
    x1: number,
    z1: number,
    yBottom: number,
    c: RGB,
  ): void {
    // 法线 = 上棱方向 (dx,0,dz) 绕 Y 转 -90°：(dz, 0, -dx)，四向立面通吃
    let nx = z1 - z0
    let nz = -(x1 - x0)
    const len = Math.hypot(nx, nz) || 1
    nx /= len
    nz /= len
    const s = shadeOf(nx, 0, nz)
    const r = c.r * s,
      g = c.g * s,
      b = c.b * s
    this.pos.push(
      x0,
      yTop,
      z0,
      x1,
      yTop,
      z1,
      x1,
      yBottom,
      z1,
      x0,
      yTop,
      z0,
      x1,
      yBottom,
      z1,
      x0,
      yBottom,
      z0,
    )
    for (let i = 0; i < 6; i++) this.col.push(r, g, b)
  }

  // ── 图元。局部坐标 → 绕自身 Y 轴旋转 → 平移到 (x, y, z) ──

  /** 盒子。(x,y,z) 是中心。六个面按「从外侧看逆时针」的顶点序展开 */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, c: RGB, rotY = 0): void {
    const hx = sx / 2,
      hy = sy / 2,
      hz = sz / 2
    const cs = Math.cos(rotY),
      sn = Math.sin(rotY)
    const p = (lx: number, ly: number, lz: number): [number, number, number] => [
      x + lx * cs + lz * sn,
      y + ly,
      z - lx * sn + lz * cs,
    ]
    const face = (
      l0: [number, number, number],
      l1: [number, number, number],
      l2: [number, number, number],
      l3: [number, number, number],
    ): void => {
      const a = p(...l0),
        b = p(...l1),
        cc = p(...l2),
        d = p(...l3)
      this.quad(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], d[0], d[1], d[2], c)
    }
    face([-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]) // 顶
    face([-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]) // 底
    face([hx, hy, hz], [-hx, hy, hz], [-hx, -hy, hz], [hx, -hy, hz]) // +Z
    face([-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz], [-hx, -hy, -hz]) // -Z
    face([hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz], [hx, -hy, -hz]) // +X
    face([-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz], [-hx, -hy, hz]) // -X
  }

  /** 圆柱。(x,y,z) 是底面圆心，只出侧面 + 顶盖（底面几乎看不见，省掉） */
  cylinder(
    x: number,
    y: number,
    z: number,
    rTop: number,
    rBottom: number,
    h: number,
    seg: number,
    c: RGB,
    rotY = 0,
  ): void {
    const cs = Math.cos(rotY),
      sn = Math.sin(rotY)
    const ring = (r: number, yy: number, i: number): [number, number, number] => {
      const a = (i / seg) * Math.PI * 2
      const lx = Math.cos(a) * r,
        lz = Math.sin(a) * r
      return [x + lx * cs + lz * sn, y + yy, z - lx * sn + lz * cs]
    }
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg
      const b0 = ring(rBottom, 0, i)
      const b1 = ring(rBottom, 0, j)
      const t0 = ring(rTop, h, i)
      const t1 = ring(rTop, h, j)
      this.quad(
        b0[0],
        b0[1],
        b0[2],
        t0[0],
        t0[1],
        t0[2],
        t1[0],
        t1[1],
        t1[2],
        b1[0],
        b1[1],
        b1[2],
        c,
      )
    }
    // 顶盖：三角扇
    const cx = x,
      cyy = y + h
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg
      const p0 = ring(rTop, h, j)
      const p1 = ring(rTop, h, i)
      this.tri(cx, cyy, z, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], c)
    }
  }

  /** 圆锥。(x,y,z) 是底面圆心 */
  cone(x: number, y: number, z: number, r: number, h: number, seg: number, c: RGB, rotY = 0): void {
    const cs = Math.cos(rotY),
      sn = Math.sin(rotY)
    const ring = (i: number): [number, number, number] => {
      const a = (i / seg) * Math.PI * 2
      const lx = Math.cos(a) * r,
        lz = Math.sin(a) * r
      return [x + lx * cs + lz * sn, y, z - lx * sn + lz * cs]
    }
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg
      const p0 = ring(i)
      const p1 = ring(j)
      this.tri(x, y + h, z, p1[0], p1[1], p1[2], p0[0], p0[1], p0[2], c)
    }
  }

  /**
   * 低模球（UV 球，默认 6×4 段）。(x,y,z) 是球心。
   * squash<1 压扁成「树冠墩子」，比真球更像手捏的低模。
   */
  sphere(
    x: number,
    y: number,
    z: number,
    r: number,
    c: RGB,
    squash = 1,
    seg = 6,
    rings = 4,
    rotY = 0,
  ): void {
    const cs = Math.cos(rotY),
      sn = Math.sin(rotY)
    const pt = (phi: number, thi: number): [number, number, number] => {
      const a = (thi / seg) * Math.PI * 2
      const lx = Math.sin(phi) * Math.cos(a) * r
      const ly = Math.cos(phi) * r * squash
      const lz = Math.sin(phi) * Math.sin(a) * r
      return [x + lx * cs + lz * sn, y + ly, z - lx * sn + lz * cs]
    }
    const top: [number, number, number] = [x, y + r * squash, z]
    const bottom: [number, number, number] = [x, y - r * squash, z]
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg
      // 北极扇
      {
        const p0 = pt(Math.PI / rings, j)
        const p1 = pt(Math.PI / rings, i)
        this.tri(top[0], top[1], top[2], p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], c)
      }
      // 南极扇
      {
        const p0 = pt(Math.PI - Math.PI / rings, i)
        const p1 = pt(Math.PI - Math.PI / rings, j)
        this.tri(bottom[0], bottom[1], bottom[2], p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], c)
      }
      // 中间环带
      for (let ri = 1; ri < rings - 1; ri++) {
        const phi0 = (ri / rings) * Math.PI
        const phi1 = ((ri + 1) / rings) * Math.PI
        const a0 = pt(phi0, i),
          a1 = pt(phi0, j)
        const b0 = pt(phi1, i),
          b1 = pt(phi1, j)
        this.quad(
          a0[0],
          a0[1],
          a0[2],
          b0[0],
          b0[1],
          b0[2],
          b1[0],
          b1[1],
          b1[2],
          a1[0],
          a1[1],
          a1[2],
          c,
        )
      }
    }
  }

  /**
   * 双坡屋顶（三棱柱）。脊线沿局部 Z，(x,y,z) 是檐口底面中心。
   * sx 是檐宽（含出檐）、sy 是脊高、sz 是进深（含出檐）。
   */
  roof(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    c: RGB,
    rotY = 0,
  ): void {
    const cs = Math.cos(rotY),
      sn = Math.sin(rotY)
    const p = (lx: number, ly: number, lz: number): [number, number, number] => [
      x + lx * cs + lz * sn,
      y + ly,
      z - lx * sn + lz * cs,
    ]
    const hx = sx / 2,
      hz = sz / 2
    // 东坡
    {
      const a = p(hx, 0, hz),
        b = p(hx, 0, -hz),
        cc = p(0, sy, -hz),
        d = p(0, sy, hz)
      this.quad(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], d[0], d[1], d[2], c)
    }
    // 西坡
    {
      const a = p(-hx, 0, -hz),
        b = p(-hx, 0, hz),
        cc = p(0, sy, hz),
        d = p(0, sy, -hz)
      this.quad(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], d[0], d[1], d[2], c)
    }
    // 前后山墙三角
    for (const s of [1, -1]) {
      const a = p(-hx, 0, s * hz),
        b = p(hx, 0, s * hz),
        cc = p(0, sy, s * hz)
      if (s > 0) this.tri(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], c)
      else this.tri(b[0], b[1], b[2], a[0], a[1], a[2], cc[0], cc[1], cc[2], c)
    }
  }

  toGeometry(THREE: typeof THREE_NS): THREE_NS.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.computeBoundingSphere()
    return g
  }
}

// ── 调色板：参考图那套低饱和「温馨农场」色 ──

/** 草地顶色按台阶等级渐变：山上更亮更黄，梯田的层次感就出来了 */
const WOOD = rgb('#8a5a33')
const WOOD_LIGHT = rgb('#a97e4f')
/** 树干用浅木色方柱 —— 参考图的特征：短粗、奶黄 */
const TRUNK = rgb('#9a7246')
/** 阔叶树冠。比原先的抹茶色饱和不少 —— 参考图里的树是画面的主色，不是背景 */
const LEAF = [rgb('#4f9b3f'), rgb('#5aa848'), rgb('#469238'), rgb('#63b150')]
/**
 * 树冠色族。`variant` 0..7 直接索引（见 world.ts 的 `h & 7`）。
 *
 * 六绿 + 一株樱、一株金：参考图里满屏的粉樱与金秋是**点缀**，密度决定了它是
 * 「有季节感」还是「花里胡哨」。2/8 实测下来在成片森林里刚好 —— 远看仍是绿林，
 * 走近才发现夹着几株开花的。
 */
const CANOPY = [
  rgb('#4f9b3f'),
  rgb('#5aa848'),
  rgb('#469238'),
  rgb('#63b150'),
  rgb('#3f8a44'),
  rgb('#6cb85a'),
  /** 樱 */
  rgb('#f0a6c4'),
  /** 金秋 */
  rgb('#efa73f'),
]
const PINE_LEAF = [rgb('#2f6b4a'), rgb('#276043'), rgb('#3a7b55')]
/** 果树上的白点(花/果) */
const FRUIT = rgb('#f5f2e8')

const WALLS = [rgb('#e8dbc0'), rgb('#efe6d0'), rgb('#d9c8a8')]
const ROOFS = [rgb('#e08850'), rgb('#5f9ea0'), rgb('#c05a3e'), rgb('#4f8f92')]
/**
 * 花色。参考图里花田是**大片紫蓝**打底，黄/粉/红作为跳色 ——
 * 所以紫与蓝各占两格，出现频率天然更高
 */
const FLOWERS = [
  rgb('#8f7fd6'),
  rgb('#f2c53d'),
  rgb('#6f8fd9'),
  rgb('#ef6b6b'),
  rgb('#9b7fe0'),
  rgb('#f4f0e6'),
  rgb('#7e9ee4'),
  rgb('#ef8fc4'),
]
const CREAM = rgb('#efe6d0')
const STONE_LIGHT = rgb('#cfc8b8')
const GLOW = rgb('#ffd98a')

/** 颜色等比调亮/调暗（结果夹在 0..1） */
function tint(c: RGB, k: number): RGB {
  return { r: Math.min(1, c.r * k), g: Math.min(1, c.g * k), b: Math.min(1, c.b * k) }
}

/**
 * 把局部偏移绕 Y 旋转 yaw 后叠加到 (x,z)。摆「随建筑一起转向的附件」
 * （门窗、烟囱、花箱）必须用它 —— box() 只绕自身中心转，附件的中心
 * 得先转到正确的世界位置。
 */
function rotOff(x: number, z: number, lx: number, lz: number, yaw: number): [number, number] {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [x + lx * c + lz * s, z - lx * s + lz * c]
}

// ── 道具几何。坐标均为世界单位，groundY 是所在格的地表高度 ──

/** 太阳水平分量的反向 = 地面阴影方向（归一化）。与 LIGHT 保持同源 */
const SHADOW_DIR = { x: -0.951, z: -0.309 }
const SHADOW_ANGLE = Math.atan2(SHADOW_DIR.z, SHADOW_DIR.x)
const SHADOW_BLACK = rgb('#242e28')

/**
 * 地面上的椭圆阴影扇（贴地一圈三角形）。
 * 颜色由材质统一给（顶点色只是占位），场景与角色脚下的接触阴影共用。
 */
export function addShadowFan(
  b: MeshBuilder,
  cx: number,
  cz: number,
  y: number,
  rx: number,
  rz: number,
  angle: number,
): void {
  const ca = Math.cos(angle)
  const sa = Math.sin(angle)
  const SEG = 10
  const px = (a: number): number => cx + Math.cos(a) * rx * ca + Math.sin(a) * rz * sa
  const pz = (a: number): number => cz - Math.cos(a) * rx * sa + Math.sin(a) * rz * ca
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * Math.PI * 2
    const a1 = ((i + 1) / SEG) * Math.PI * 2
    b.tri(cx, y, cz, px(a1), y, pz(a1), px(a0), y, pz(a0), SHADOW_BLACK)
  }
}

/**
 * 道具的椭圆投影：沿阴影方向偏移并拉长，长度随道具高度。
 * 贴在 prop 所在格的地表上方一点点，避免与地块顶面深度冲突。
 */
export function addPropShadow(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  radius: number,
  height: number,
): void {
  const len = Math.min(1.0, height * 0.55)
  const cx = x + SHADOW_DIR.x * len * 0.5
  const cz = z + SHADOW_DIR.z * len * 0.5
  addShadowFan(b, cx, cz, groundY + 0.015, radius + len * 0.4, radius * 0.85, SHADOW_ANGLE)
}

/**
 * 阔叶树（参考图的「宝塔式圆冠」）：短粗方柱树干 + 三层下大上小的圆冠，
 * 下层压暗、顶层提亮出同棵双色；variant 偶数是果树 —— 冠面点几颗白点。
 */
export function addTree(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  variant: number,
): void {
  const s = 0.95 + (variant % 3) * 0.14
  // 干比原先高一截：原来树顶才 1.3，和 1.55 高的小人差不多，读起来像灌木。
  // 参考图里树是**盖过人**的，抬到 ~2.0 之后才有「树荫下」的感觉
  // 干要细、要**大半藏在冠里**。粗干 + 高冠会露出一截光秃秃的棕色柱子，
  // 参考图里的树几乎看不到主干
  b.box(x, groundY + 0.3 * s, z, 0.15 * s, 0.6 * s, 0.15 * s, TRUNK)
  const leaf = CANOPY[variant % CANOPY.length]!

  /**
   * 树冠：一圈矮多边形「瓣」拼成的疙瘩状轮廓。
   *
   * ⚠️ 每瓣都刻意降到 `seg=5, rings=3`（20 个三角）而不是默认的 6×4（36 个）。
   * 原来三颗默认球是 108 个三角，现在五瓣只要 100 —— **轮廓更碎更手作，
   * 三角反而更少**。低模风格里瓣数比单瓣精度重要得多，而整张世界是一次性
   * 预生成 64 个 chunk 的，这里每多一个三角都要乘以全图的树。
   */
  const lobe = (dx: number, dy: number, dz: number, r: number, k: number, sq = 0.9): void => {
    b.sphere(x + dx * s, groundY + dy * s, z + dz * s, r * s, tint(leaf, k), sq, 6, 3)
  }
  // 一大团压扁的主冠 + 沿冠沿几个凸起。
  // ⚠️ 关键是几瓣**高度相近**、只在水平方向错开：把它们竖着垒起来会变成宝塔，
  // 而参考图里的树冠是一朵横向铺开的「西兰花」。squash 也从 0.8 收到 0.9 ——
  // 0.8 配 rings=3 出来是一摞盘子，没有体积
  lobe(0, 0.82, 0, 0.62, 0.9, 0.8)
  lobe(-0.36, 0.96, 0.14, 0.33, 1.02)
  lobe(0.34, 0.93, -0.16, 0.31, 0.95)
  lobe(0.08, 1.0, 0.34, 0.29, 1.06)
  lobe(-0.1, 1.16, -0.06, 0.3, 1.12)

  // 花/果白点。樱与金秋不挂白点 —— 它们自己就是画面的亮色，再点就脏了
  if ((variant & 1) === 0 && variant < 6) {
    b.box(x - 0.3 * s, groundY + 0.96 * s, z + 0.32 * s, 0.07, 0.07, 0.07, FRUIT)
    b.box(x + 0.34 * s, groundY + 1.16 * s, z - 0.2 * s, 0.07, 0.07, 0.07, FRUIT)
    b.box(x + 0.04 * s, groundY + 1.3 * s, z + 0.2 * s, 0.06, 0.06, 0.06, FRUIT)
  }
}

/** 松树：短方柱干 + 四层锥，越往上越亮，高海拔与湿冷区森林的主角 */
export function addPine(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  variant: number,
): void {
  const s = 0.95 + (variant % 3) * 0.1
  b.box(x, groundY + 0.13, z, 0.2, 0.26, 0.2, TRUNK)
  const leaf = PINE_LEAF[variant % PINE_LEAF.length]!
  b.cone(x, groundY + 0.18, z, 0.46 * s, 0.5, 6, tint(leaf, 0.9))
  b.cone(x, groundY + 0.52, z, 0.36 * s, 0.48, 6, leaf)
  b.cone(x, groundY + 0.86, z, 0.26 * s, 0.42, 6, tint(leaf, 1.08))
  b.cone(x, groundY + 1.14, z, 0.15 * s, 0.3, 6, tint(leaf, 1.15))
}

/**
 * 灌木：三瓣一丛。
 *
 * 原先是孤零零一颗球，远看就是地上一个绿点。参考图里的灌木都是**几坨挤在一起**
 * 的，边缘毛糙。同样用 `seg=5, rings=3` 的矮多边形球，三瓣 60 个三角，
 * 比原来一颗默认球（36）只多一点，轮廓却完全不同。
 */
export function addBush(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  variant: number,
): void {
  const leaf = LEAF[variant % LEAF.length]!
  const s = 1 + (variant % 2) * 0.18
  b.sphere(x, groundY + 0.15 * s, z, 0.23 * s, leaf, 0.74, 5, 3)
  b.sphere(x - 0.16 * s, groundY + 0.11 * s, z + 0.1 * s, 0.16 * s, tint(leaf, 0.9), 0.76, 5, 3)
  b.sphere(x + 0.15 * s, groundY + 0.12 * s, z - 0.09 * s, 0.15 * s, tint(leaf, 1.08), 0.76, 5, 3)
}

/**
 * 花：一丛三朵，高低错开。
 *
 * ⚠️ 原先是「一根茎 + 一个小方块」，一格一朵 —— 在 2.5D 俯视下那就是地上
 * 一个像素点，成片的花田看着跟空地没区别。参考图里花是**铺开的一片**，
 * 有明确的色块面积。三朵各自偏移、高度不同，一格就有了体积。
 *
 * 成本：6 个 box（72 三角）对 2 个（24）。只长在有花的格上，而花本来就是
 * 稀疏道具；换来的是整片花田真的能看出是花田。
 */
export function addFlower(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  variant: number,
): void {
  const stem = rgb('#3f8a3a')
  const c = FLOWERS[variant % FLOWERS.length]!
  // 同一丛里掺一朵邻色，避免整片花田是一个死板的纯色
  const c2 = FLOWERS[(variant + 1) % FLOWERS.length]!
  const one = (dx: number, dz: number, h: number, col: RGB, w: number): void => {
    b.box(x + dx, groundY + h * 0.5, z + dz, 0.035, h, 0.035, stem)
    b.box(x + dx, groundY + h + 0.03, z + dz, w, 0.08, w, col)
  }
  one(0, 0, 0.26, c, 0.15)
  one(-0.2, 0.14, 0.19, c2, 0.13)
  one(0.18, -0.16, 0.22, c, 0.12)
}

/**
 * 房子（参考图的温馨小屋）。variant 0-2 是三种配色的村屋，3 是谷仓。
 * 门朝局部 +Z（rot 旋转后即朝向 rot 方向）；门窗烟囱等附件用 rotOff
 * 摆到随转向的正确位置。
 */
export function addHouse(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  variant: number,
  rot: number,
): void {
  const yaw = (rot * Math.PI) / 2
  /**
   * ⚠️ 整体放大系数。原先这套房子是照着 1.0 高的小人捏的 —— 屋脊 1.16、门高 0.40，
   * 而玩家立绘是 **1.55**：人比房子高，门只到人膝盖，整座村子看上去是摆件。
   *
   * ⚠️ 上限由摆放规则钉死：房屋用 3×3 哈希极大值法保证彼此**至少隔 2 格**，
   * 所以整栋最宽处的半宽不能超过 1.0 格。最宽的不是墙而是**屋顶出檐**（原 1.3）——
   * 我第一版按墙宽 1.12 算，取了 1.72，结果墙不挤、屋顶却互相插进去了，
   * 一片村子看上去像几个屋顶焊在一起。按出檐算：1.3 × K ≤ 2.0 → K ≤ 1.54，取 1.5。
   * 谷仓出檐原本就有 1.68，另给一个更小的 KB。
   */
  const KH = 1.5
  const KB = 1.15
  if (variant === 3) {
    // 谷仓：橙棕木板墙 + 青灰绿大屋顶 + 深棕大门 + 奶白门框与檐梁
    b.box(x, groundY + KB * 0.44, z, KB * 1.5, KB * 0.88, KB * 1.2, rgb('#c08a5e'), yaw)
    b.box(x, groundY + KB * 0.9, z, KB * 1.56, KB * 0.07, KB * 1.26, CREAM, yaw)
    b.roof(x, groundY + KB * 0.94, z, KB * 1.68, KB * 0.52, KB * 1.38, rgb('#5f9a92'), yaw)
    const [dx1, dz1] = rotOff(x, z, 0, KB * 0.615, yaw)
    b.box(dx1, groundY + KB * 0.36, dz1, KB * 0.62, KB * 0.7, KB * 0.05, rgb('#5e4530'), yaw)
    b.box(dx1, groundY + KB * 0.73, dz1, KB * 0.7, KB * 0.06, KB * 0.05, CREAM, yaw)
    const [dx2, dz2] = rotOff(x, z, -KB * 0.34, KB * 0.615, yaw)
    b.box(dx2, groundY + KB * 0.36, dz2, KB * 0.05, KB * 0.7, KB * 0.05, CREAM, yaw)
    const [dx3, dz3] = rotOff(x, z, KB * 0.34, KB * 0.615, yaw)
    b.box(dx3, groundY + KB * 0.36, dz3, KB * 0.05, KB * 0.7, KB * 0.05, CREAM, yaw)
    return
  }
  const wall = WALLS[variant % WALLS.length]!
  const roofC = ROOFS[variant % ROOFS.length]!
  b.box(x, groundY + KH * 0.33, z, KH * 1.12, KH * 0.66, KH * 1.0, wall, yaw)
  // 浅色檐口条：屋檐下的一圈奶油边
  b.box(x, groundY + KH * 0.67, z, KH * 1.17, KH * 0.06, KH * 1.05, CREAM, yaw)
  b.roof(x, groundY + KH * 0.7, z, KH * 1.3, KH * 0.46, KH * 1.18, roofC, yaw)

  // ── 门：青绿门体 + 拱顶窄块 + 奶油门框 + 石阶 ──
  const doorC = rgb('#4f8f8b')
  {
    const [px0, pz0] = rotOff(x, z, 0, KH * 0.515, yaw)
    b.box(px0, groundY + KH * 0.2, pz0, KH * 0.28, KH * 0.4, KH * 0.05, doorC, yaw)
    b.box(px0, groundY + KH * 0.44, pz0, KH * 0.2, KH * 0.08, KH * 0.05, doorC, yaw)
    const [f1x, f1z] = rotOff(x, z, -KH * 0.17, KH * 0.525, yaw)
    b.box(f1x, groundY + KH * 0.26, f1z, KH * 0.05, KH * 0.52, KH * 0.04, CREAM, yaw)
    const [f2x, f2z] = rotOff(x, z, KH * 0.17, KH * 0.525, yaw)
    b.box(f2x, groundY + KH * 0.26, f2z, KH * 0.05, KH * 0.52, KH * 0.04, CREAM, yaw)
    const [f3x, f3z] = rotOff(x, z, 0, KH * 0.525, yaw)
    b.box(f3x, groundY + KH * 0.53, f3z, KH * 0.39, KH * 0.05, KH * 0.04, CREAM, yaw)
    const [sx0, sz0] = rotOff(x, z, 0, KH * 0.58, yaw)
    b.box(sx0, groundY + KH * 0.025, sz0, KH * 0.36, KH * 0.05, KH * 0.16, STONE_LIGHT, yaw)
  }

  // ── 窗 ×2：奶油框 + 蓝玻璃 + 十字棂 + 窗下花箱 ──
  for (const lx of [-0.33, 0.33] as const) {
    const [wx0, wz0] = rotOff(x, z, lx, KH * 0.505, yaw)
    b.box(wx0, groundY + KH * 0.4, wz0, KH * 0.24, KH * 0.24, KH * 0.04, CREAM, yaw)
    b.box(wx0, groundY + KH * 0.4, wz0, KH * 0.17, KH * 0.17, KH * 0.06, rgb('#a8cfe0'), yaw)
    b.box(wx0, groundY + KH * 0.4, wz0, KH * 0.03, KH * 0.18, KH * 0.065, CREAM, yaw)
    b.box(wx0, groundY + KH * 0.4, wz0, KH * 0.18, KH * 0.03, KH * 0.065, CREAM, yaw)
    const [bx0, bz0] = rotOff(x, z, lx, KH * 0.535, yaw)
    b.box(bx0, groundY + KH * 0.24, bz0, KH * 0.22, KH * 0.09, KH * 0.09, rgb('#8a6a48'), yaw)
    const [p1x, p1z] = rotOff(x, z, lx - KH * 0.06, KH * 0.545, yaw)
    b.box(
      p1x,
      groundY + KH * 0.3,
      p1z,
      KH * 0.08,
      KH * 0.07,
      KH * 0.07,
      FLOWERS[variant % FLOWERS.length]!,
      yaw,
    )
    const [p2x, p2z] = rotOff(x, z, lx + KH * 0.06, KH * 0.545, yaw)
    b.box(
      p2x,
      groundY + KH * 0.3,
      p2z,
      KH * 0.08,
      KH * 0.07,
      KH * 0.07,
      FLOWERS[(variant + 2) % FLOWERS.length]!,
      yaw,
    )
  }

  // ── 烟囱：奶白柱身 + 深色顶帽（随转向摆在屋脊旁） ──
  const [cx0, cz0] = rotOff(x, z, KH * 0.38, -KH * 0.3, yaw)
  b.box(cx0, groundY + KH * 1.06, cz0, KH * 0.15, KH * 0.36, KH * 0.15, rgb('#e8e0d0'), yaw)
  b.box(cx0, groundY + KH * 1.26, cz0, KH * 0.17, KH * 0.05, KH * 0.17, rgb('#6e6259'), yaw)
}

/** 水井：石筒 + 双柱 + 小坡顶，放在村心 */
export function addWell(b: MeshBuilder, x: number, z: number, groundY: number): void {
  /** 放大到与 1.55 高的玩家相称：水井原先井台 0.32、顶棚 0.91，人比井棚还高 */
  const KW = 1.6
  b.cylinder(x, groundY, z, KW * 0.26, KW * 0.3, KW * 0.32, 7, rgb('#9a9a92'))
  b.cylinder(x, groundY + KW * 0.32, z, KW * 0.2, KW * 0.2, KW * 0.04, 7, rgb('#3e5a66'))
  b.box(x - KW * 0.26, groundY + KW * 0.5, z, KW * 0.07, KW * 0.42, KW * 0.07, WOOD_LIGHT)
  b.box(x + KW * 0.26, groundY + KW * 0.5, z, KW * 0.07, KW * 0.42, KW * 0.07, WOOD_LIGHT)
  b.roof(x, groundY + KW * 0.71, z, KW * 0.62, KW * 0.2, KW * 0.5, ROOFS[0]!)
}

/** 干草垛：一墩圆锥，村口的丰收感 */
export function addHaystack(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  variant: number,
): void {
  const yaw = variant * 0.9
  /** 放大到与 1.55 高的玩家相称：草垛原先 0.56，比一捆干草还矮 */
  const KY = 1.8
  b.cylinder(x, groundY, z, KY * 0.3, KY * 0.34, KY * 0.08, 7, rgb('#c9a04e'))
  b.cone(x, groundY + KY * 0.06, z, KY * 0.34, KY * 0.5, 7, rgb('#dcb35c'), yaw)
}

/** 围栏：双柱双横杆，rot 决定走向 */
export function addFence(b: MeshBuilder, x: number, z: number, groundY: number, rot: number): void {
  const yaw = (rot * Math.PI) / 2
  const w = 0.8
  /** 放大到与 1.55 高的玩家相称：篱笆原先只有 0.36 高 —— 在 1.55 的人旁边是脚踝高的绊线 */
  const KF = 2.3
  b.box(x - w / 2, groundY + KF * 0.18, z, KF * 0.08, KF * 0.36, KF * 0.08, WOOD_LIGHT, yaw)
  b.box(x + w / 2, groundY + KF * 0.18, z, KF * 0.08, KF * 0.36, KF * 0.08, WOOD_LIGHT, yaw)
  b.box(x, groundY + KF * 0.14, z, w + KF * 0.1, KF * 0.05, KF * 0.05, WOOD_LIGHT, yaw)
  b.box(x, groundY + KF * 0.27, z, w + KF * 0.1, KF * 0.05, KF * 0.05, WOOD_LIGHT, yaw)
}

/** 田垄：一小方耕地 + 一排三簇作物。田里的 crop 全部 rot=0，垄线才会平行 */
export function addCrop(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  variant: number,
): void {
  b.box(x, groundY + 0.03, z, 0.88, 0.06, 0.88, rgb('#8a6a48'))
  const leaf = LEAF[(variant + 2) % LEAF.length]!
  for (let i = -1; i <= 1; i++) {
    b.sphere(x + i * 0.26, groundY + 0.16, z, 0.13, leaf, 0.8)
  }
}

// ── 以下是为「聊天 AI RPG」补的村庄/荒野小件 ──

/** 石头：一两墩压扁的灰石，荒野与水岸的散件 */
export function addRock(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  variant: number,
): void {
  const s = 0.8 + (variant % 3) * 0.2
  b.sphere(x, groundY + 0.09 * s, z, 0.2 * s, rgb('#a8a294'), 0.62)
  if (variant & 1) {
    b.sphere(x + 0.18 * s, groundY + 0.06, z - 0.08, 0.12 * s, rgb('#98928a'), 0.7)
  }
}

/** 长椅：路边的歇脚处，NPC 交互的天然场景道具 */
export function addBench(b: MeshBuilder, x: number, z: number, groundY: number, rot: number): void {
  const yaw = (rot * Math.PI) / 2
  /** 放大到与 1.55 高的玩家相称：长椅座面原先 0.27，人坐上去等于蹲在地上 */
  const KE = 1.7
  b.box(x - KE * 0.26, groundY + KE * 0.13, z, KE * 0.07, KE * 0.26, KE * 0.24, WOOD_LIGHT, yaw)
  b.box(x + KE * 0.26, groundY + KE * 0.13, z, KE * 0.07, KE * 0.26, KE * 0.24, WOOD_LIGHT, yaw)
  b.box(x, groundY + KE * 0.27, z, KE * 0.64, KE * 0.05, KE * 0.26, WOOD_LIGHT, yaw)
  const [bx, bz] = rotOff(x, z, 0, -0.11, yaw)
  b.box(bx, groundY + KE * 0.4, bz, KE * 0.64, KE * 0.2, KE * 0.05, WOOD_LIGHT, yaw)
}

/** 路灯：石座 + 木柱 + 暖光灯箱 + 小顶。unlit 管线里靠亮色读作「亮着」 */
export function addLantern(b: MeshBuilder, x: number, z: number, groundY: number): void {
  /** 放大到与 1.55 高的玩家相称：路灯原先 1.14，比人还矮，灯头正好怼在脸上 */
  const KL = 1.62
  b.box(x, groundY + KL * 0.04, z, KL * 0.18, KL * 0.08, KL * 0.18, rgb('#9a9a92'))
  b.box(x, groundY + KL * 0.47, z, KL * 0.07, KL * 0.86, KL * 0.07, rgb('#5e4a35'))
  b.box(x, groundY + KL * 0.96, z, KL * 0.16, KL * 0.16, KL * 0.16, GLOW)
  b.cone(x, groundY + KL * 1.04, z, KL * 0.14, KL * 0.1, 4, rgb('#5f6b5a'))
}

/** 指示牌：双板小牌，AI RPG 里给「去哪儿找谁」的方位感 */
export function addSignpost(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  variant: number,
): void {
  /** 放大到与 1.55 高的玩家相称：指示牌原先 1.0，牌面在人胸口以下 */
  const KS = 1.6
  b.box(x, groundY + KS * 0.5, z, KS * 0.07, KS * 1.0, KS * 0.07, WOOD_LIGHT)
  b.box(x, groundY + KS * 0.82, z, KS * 0.44, KS * 0.13, KS * 0.05, rgb('#c9a877'), variant * 0.45)
  b.box(
    x,
    groundY + KS * 0.6,
    z,
    KS * 0.34,
    KS * 0.11,
    KS * 0.05,
    rgb('#b8977a'),
    // ⚠️ 这个 0.6 是**弧度**（第二块牌相对第一块转开的角度），不是尺寸，别乘 KS
    variant * 0.45 + 0.6,
  )
}

/** 草捆：方草垛两叠，谷仓与干草垛的搭档 */
export function addHaybale(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  variant: number,
): void {
  const yaw = variant * 0.8
  /** 放大到与 1.55 高的玩家相称：干草捆原先 0.47 */
  const KZ = 1.6
  b.box(x, groundY + KZ * 0.14, z, KZ * 0.42, KZ * 0.28, KZ * 0.3, rgb('#e3c26e'), yaw)
  b.box(x, groundY + KZ * 0.37, z, KZ * 0.3, KZ * 0.2, KZ * 0.22, rgb('#d8b65e'), yaw + 0.35)
}

/** 稻草人：立在田中央的小小地标 */
export function addScarecrow(
  b: MeshBuilder,
  x: number,
  z: number,
  groundY: number,
  variant: number,
): void {
  const shirts = [rgb('#c94f4f'), rgb('#5f8fb0'), rgb('#c9a04e')]
  /** 放大到与 1.55 高的玩家相称：稻草人是**人形**，原先 1.0 只到人肩膀，一眼就不对 */
  const KC = 1.5
  b.box(x, groundY + KC * 0.5, z, KC * 0.06, KC * 1.0, KC * 0.06, rgb('#8a6a48'))
  b.box(x, groundY + KC * 0.72, z, KC * 0.56, KC * 0.05, KC * 0.05, rgb('#8a6a48'))
  b.box(x, groundY + KC * 0.56, z, KC * 0.3, KC * 0.36, KC * 0.18, shirts[variant % shirts.length]!)
  b.sphere(x, groundY + KC * 0.88, z, KC * 0.11, rgb('#e8d5a0'), KC * 0.9)
  b.cylinder(x, groundY + KC * 0.94, z, KC * 0.16, KC * 0.16, KC * 0.03, 7, rgb('#e8c968'))
  b.cylinder(x, groundY + KC * 0.97, z, KC * 0.09, KC * 0.1, KC * 0.08, 7, rgb('#e8c968'))
}
