/**
 * 噪声取样原点 —— 一个被水面、泡沫、云影共享的 vec2 uniform。
 *
 * ## 这东西是干嘛的
 * 世界是环面，地块按「离玩家最近的那个镜像」摆放（见 scene.ts 的 setPlayer）。
 * 于是玩家从 255.99 走到 0.004 时，逻辑上只挪了 0.014 格，**整幅画面的渲染
 * 世界坐标却同时减了 256**。
 *
 * 几何上这一步看不出来：相机、地块、角色同步平移，画面逐像素相同。
 * 但水面与云影的噪声是按**渲染世界坐标**取样的 —— 不补这一下，一整屏的波纹
 * 与云影会在这一帧全部重掷，过接缝时「闪一下」，而那恰好就是绕行一周必经的
 * 那条子午线。
 *
 * 把这次瞬移累加进本 uniform，噪声坐标 = 渲染坐标 + 原点，噪声场眼里玩家就是
 * 在连续地走。跨缝之外它恒定不变，平时一分钱不花。
 *
 * ## 为什么不干脆让渲染坐标本身连续（不回绕的里程表）
 * 概念确实更少，但 three 默认的 modelViewMatrix 是**在着色器里用 f32 乘**出来的
 * （mediumpModelViewMatrix），坐标一大就会灾难性抵消，抖动约
 * `|锚点| × 2.6e-6` 像素 —— 走上百来圈就肉眼可见。
 * 拆成三层坐标后，顶点坐标永远锁在 ±300 以内，**精度相对今天零退化**；增长只
 * 落在噪声参数上，而那里的尺度因子 ≤ 2，跟已有的 time 项是同一量级的误差。
 *
 * ## 为什么不按逻辑坐标取噪声
 * 那样花纹会锁在地形上（听着更对），但会在渲染接缝处留下一条**永久硬线** ——
 * 比每绕一圈闪一次严格更糟，而闪一下正是这里要消掉的东西。
 *
 * ⚠️ 只加在**噪声参数**上，绝不要加进顶点位置，否则上面那条精度论证就没了。
 *
 * 纯 service：不 import vue/pinia。
 */

import { uniform } from 'three/tsl'
import { Color, Vector2 } from 'three/webgpu'

export function createNoiseOrigin() {
  return uniform(new Vector2())
}

export type NoiseOrigin = ReturnType<typeof createNoiseOrigin>

/**
 * 昼夜色调乘子 —— 水面与泡沫共享的 vec3 uniform。
 *
 * 地形、道具、小人都是 basic 材质，片元就是 `diffuse × vColor`，改一个
 * `material.color` 就整体调色了。水面不是：它的颜色由 TSL 图算出来，
 * 那条路径上没有 `diffuse` 可改 —— 不额外接一个 uniform 的话，
 * **入夜后整片湖仍然惨白发亮**，成为画面里最刺眼的东西，
 * 昼夜这件事当场穿帮（22:30 的截图就是这么发现的）。
 *
 * 与 time.ts 的硬约束一致：08:00 恒为纯白，白天与做这个特性之前像素级一致。
 */
export function createDayTint() {
  return uniform(new Color(1, 1, 1))
}

export type DayTint = ReturnType<typeof createDayTint>

/**
 * 有多少「太阳」(0..1) —— 云影按它淡出的 float uniform。
 *
 * 云影是**日光**被云挡住留下的暗斑。夜里没有日光，却仍画着一层压暗 40% 的
 * 冷色斑块，看上去就是一团团无缘无故的黑雾在夜色里爬。
 * 贴地投影（shadowMat.opacity）走的是同一个数，两者必须一起淡出。
 */
export function createSunAmount() {
  return uniform(1)
}

export type SunAmount = ReturnType<typeof createSunAmount>
