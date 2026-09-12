/**
 * 云层阴影材质（TSL 节点着色器）。
 *
 * 做法：世界上空盖一张大平面（不写深度、最后绘制），片元里用**大尺度分形
 * 噪声**沿风向漂移，噪声高于阈值的区域输出一层半透明的冷色 —— 投在画面上
 * 就是一团团移动的云影，压暗底下的地形、水面、建筑与角色。
 *
 * 为什么用「高空覆盖面」而不是改地形材质：云影应该同时盖住树、房、水和
 * 地面才自然；逐材质改容易漏。覆盖面跟着正交相机一次性罩住全屏，一个
 * draw call 搞定。噪声是**世界坐标的场**，云影在世界上位置稳定，玩家走动
 * 时不会跟着人跑。
 *
 * 纯 service：不 import vue/pinia。
 */

import { Fn, mx_fractal_noise_float, positionWorld, smoothstep, time, vec3, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'

export function createCloudShadowMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.transparent = true
  material.depthWrite = false

  // 云影的基色：偏冷的暗蓝灰。阴影不是纯黑，是被云滤过的天光
  const shadowColor = vec3(0.13, 0.18, 0.26)

  material.colorNode = Fn(() => {
    // 风向（东偏北）推动噪声场；时间作第三维让云形自己缓缓演化。
    // 尺度 0.06 → 云团约 17 格，一屏能同时看见云影与云缝
    const wx = positionWorld.x.add(time.mul(1.4))
    const wz = positionWorld.z.add(time.mul(0.85))
    const n = mx_fractal_noise_float(vec3(wx, wz, time.mul(0.1)).mul(0.06), 4)
    // 过半的天空有云：阈值贴着 0 取，宽平滑区间出松软的云边
    const cover = smoothstep(-0.05, 0.4, n)
    // 云下最深处压到 ~60% 亮度
    const a = cover.mul(0.4)
    return vec4(shadowColor, a)
  })()

  return material
}
