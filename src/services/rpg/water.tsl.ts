/**
 * 水面材质（TSL 节点着色器）—— 三层动态效果，全部由 MaterialX 噪声驱动：
 *
 * 正弦波之所以被换掉：它太规律，屏幕上就是一排排匀速平移的椭圆色块。
 * 噪声出的是**不规则的碎斑块**，更像真实水面的波纹。
 *
 * 1. **顶点起伏**（applyWave）：低频正弦给出大缓浪的底子，叠加
 *    mx_noise（时间作第三维）出高低不齐的碎浪。波高是「世界坐标+时间」的
 *    纯函数，逐格独立的水面四边形在共享角上位移一致，永不开缝；
 *    泡沫条带共用同一函数，永远骑在波面上。
 * 2. **波纹与闪光**：mx_fractal_noise 以时间为第三维 → 斑块原地生长消散；
 *    再叠一层高频噪声沿斜向漂移出细碎涟漪。两者加权和的高位区间
 *    smoothstep 出稀疏闪光点，像阳光碎在水面。
 * 3. **岸线泡沫**（createFoamMaterial）：贴陆地的窄条带，alpha 由噪声驱动
 *    不规则地涨落 —— 浪拍岸没有节奏，才是真的浪。
 *
 * 水面与泡沫都是**静态几何**（世界构建时一次生成，永不挪动），片元里的
 * 世界坐标直接可用（positionWorld），不需要 origin 补位。
 *
 * 纯 service：不 import vue/pinia。
 */

import {
  Fn,
  float,
  mx_fractal_noise_float,
  mx_noise_float,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  time,
  vec3,
  vec4,
} from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

/**
 * 波面位移 —— 世界坐标 + 时间的纯函数。
 * 正弦两层做大缓浪（±0.04），噪声出碎浪（±0.09），合计 ±0.13。
 */
function waveY(p: typeof positionLocal) {
  const swell = sin(p.x.mul(0.5).add(p.z.mul(0.33)).add(time.mul(1.0)))
    .add(sin(p.x.mul(-0.27).add(p.z.mul(0.55)).sub(time.mul(0.8))))
    .mul(0.02)
  const chop = mx_noise_float(vec3(p.x, p.z, time.mul(0.3)).mul(0.45)).mul(0.09)
  return swell.add(chop)
}

/** 给材质挂上共用的波面顶点位移 */
function applyWave(material: MeshBasicNodeMaterial): void {
  material.positionNode = vec3(
    positionLocal.x,
    positionLocal.y.add(waveY(positionLocal)),
    positionLocal.z,
  )
}

export interface WaterMaterialArgs {
  /** 水面基色（0..1 分量） */
  color: { r: number; g: number; b: number }
  /** 基础不透明度。0.6 左右：能看见海床，又不至于发灰 */
  alpha: number
}

export function createWaterMaterial(args: WaterMaterialArgs): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.transparent = true
  // 水面不写深度：不然水下海床的半透明排序会跟地形打起来
  material.depthWrite = false
  applyWave(material)

  const base = vec3(args.color.r, args.color.g, args.color.b)
  const alpha = float(args.alpha)

  material.colorNode = Fn(() => {
    const wx = positionWorld.x
    const wz = positionWorld.z
    // 骨干：分形噪声以时间为第三维，斑块原地生长消散、形状一直在变
    const n1 = mx_fractal_noise_float(vec3(wx, wz, time.mul(0.45)).mul(0.75), 4)
    // 细碎：高频噪声沿斜向漂移，出小涟漪
    const n2 = mx_noise_float(
      vec3(wx.add(time.mul(0.65)), wz.add(time.mul(0.4)), float(7.7)).mul(2.0),
    )
    const ripple = n1.mul(0.55).add(n2.mul(0.45)).mul(0.5).add(0.5)
    // 闪光点：波纹加权和的高位窄区间才点亮，随波生灭
    const glint = smoothstep(0.72, 0.9, ripple)
    const br = ripple.mul(0.22).add(0.87)
    const col = base.mul(br).add(glint.mul(0.3))
    return vec4(col, alpha.add(glint.mul(0.08)))
  })()

  return material
}

/**
 * 岸线泡沫。几何是「贴陆地的窄条带」（见 scene.ts buildChunk），
 * 这里用噪声驱动 alpha 与亮度的涨落 —— 没有节奏的不规则拍岸。
 */
export function createFoamMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.transparent = true
  material.depthWrite = false
  applyWave(material)

  material.colorNode = Fn(() => {
    const f = mx_noise_float(
      vec3(positionWorld.x.mul(0.8), positionWorld.z.mul(0.8), time.mul(0.6)),
    )
    const pulse = f.mul(0.5).add(0.5)
    const a = pulse.mul(pulse).mul(0.55).add(0.12)
    const tint = pulse.mul(0.1).add(0.9)
    return vec4(vec3(0.97, 0.99, 1).mul(tint), a)
  })()

  return material
}
