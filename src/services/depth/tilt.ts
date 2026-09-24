/**
 * 手机倾斜 → 视差输入（-1..1），给触屏设备代替桌面的鼠标位置。
 *
 * 用 `deviceorientation`（beta 前后倾、gamma 左右倾，单位度）而不是 Generic Sensor 的
 * Gyroscope：后者只有 Chromium、还要 Permissions Policy；前者安卓 Chrome / WebView 与
 * iOS Safari 都有，安卓上不需要任何权限（只要求安全上下文，tauri.localhost 满足）。
 *
 * ## 相对倾角 + 缓慢回中
 * 没人会端端正正竖着拿手机，绝对角度没有意义。取「相对基准的偏转」，
 * 基准以几秒的时间常数追随当前姿态 —— 换个姿势拿着，画面会慢慢回到正中，
 * 只有**晃动**才产生视差，和 iOS 的视差壁纸一个手感。
 *
 * ## 方向（「透过窗口看进去」）
 * 手机右边缘向远处转（gamma 增大）时，眼睛相对屏幕跑到了右侧 = 桌面上鼠标在右，
 * 所以 x 取 +Δgamma；顶边朝自己倾（beta 增大）时眼睛相对屏幕在上方 = 鼠标在上（y 为负）。
 * 横屏时按 screen.orientation.angle 把设备坐标轴转到屏幕坐标轴。
 *
 * 纯 service：不 import vue。
 */

/** 偏转多少度算「推到头」 */
const RANGE_DEG = 22
/** 基准追随当前姿态的时间常数（毫秒）：越大越不容易「回中」 */
const RECENTER_MS = 4000
/** 归一化输出的最小变化量（约 0.2°），低于它视为传感器噪声 */
const DEAD_ZONE = 0.01

type IOSOrientationEvent = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>
}

let granted = false

/** 环境是否提供方向事件 */
export function tiltSupported(): boolean {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window
}

/**
 * 申请方向传感器权限，返回能否使用。
 *
 * ⚠️ 不能拿「`requestPermission` 存在」当成「需要用户点一下」：新版 Chrome（实测 153）
 * 也实现了这个方法，只是无需手势、直接 resolve 'granted'。按存在与否判断的话，
 * 安卓上会平白多出一个「开启重力视差」按钮、不点就没有视差。
 * 所以一律先**静默**调一次：Chrome / 安卓直接拿到授权；只有 iOS 会因为不在用户手势里
 * 而拒绝 —— 那时界面才显示按钮，按钮的点击回调里再调一次本函数（iOS 弹系统授权框）。
 */
export async function requestTiltPermission(): Promise<boolean> {
  if (granted) return true
  const req = (DeviceOrientationEvent as IOSOrientationEvent).requestPermission
  if (typeof req !== 'function') return (granted = true)
  try {
    granted = (await req.call(DeviceOrientationEvent)) === 'granted'
  } catch {
    granted = false
  }
  return granted
}

/** 角度差规整到 -180..180，避免 beta 在 ±180 处翻转时算出 359° 的假偏转 */
function wrap(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180
}

function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v))
}

function screenAngle(): number {
  const a = screen.orientation?.angle
  if (typeof a === 'number') return a
  const legacy = (window as Window & { orientation?: number }).orientation
  return typeof legacy === 'number' ? (legacy + 360) % 360 : 0
}

/**
 * 开始监听。回调收到 (nx, ny)，语义与桌面指针一致：左上 (-1,-1)、右下 (1,1)、中心 (0,0)。
 * 返回停止函数。设备没有传感器时事件的 beta/gamma 为 null，回调永远不会触发（静态图兜底）。
 */
export function startTilt(onTilt: (nx: number, ny: number) => void): () => void {
  let base: { beta: number; gamma: number } | null = null
  let lastT = 0
  /** 上次下发的值，死区比较用 */
  let sent = { x: 0, y: 0 }

  function onOrientation(e: DeviceOrientationEvent) {
    if (e.beta == null || e.gamma == null) return
    const now = e.timeStamp || performance.now()
    if (!base) {
      // 第一帧就是基准：进页面那一刻画面在正中
      base = { beta: e.beta, gamma: e.gamma }
      lastT = now
      sent = { x: 0, y: 0 }
      onTilt(0, 0)
      return
    }
    // 基准按指数衰减追随当前姿态（与事件频率无关）
    const k = 1 - Math.exp(-Math.max(0, now - lastT) / RECENTER_MS)
    lastT = now
    base.beta += wrap(e.beta - base.beta) * k
    base.gamma += wrap(e.gamma - base.gamma) * k

    const db = wrap(e.beta - base.beta)
    const dg = wrap(e.gamma - base.gamma)
    // 设备坐标 → 屏幕坐标
    let sx = dg
    let sy = db
    switch (screenAngle()) {
      case 90:
        sx = db
        sy = -dg
        break
      case 180:
        sx = -dg
        sy = -db
        break
      case 270:
        sx = -db
        sy = dg
        break
    }
    const nx = clamp1(sx / RANGE_DEG)
    const ny = clamp1(-sy / RANGE_DEG)
    // 死区：手机静置时传感器仍有 ±0.1° 级的噪声，照单全收的话视差渲染循环永远收敛不了 ——
    // 列表页一屏六七张卡每帧都要重画，白白耗电。变化小于 DEAD_ZONE 不下发。
    if (Math.abs(nx - sent.x) < DEAD_ZONE && Math.abs(ny - sent.y) < DEAD_ZONE) return
    sent = { x: nx, y: ny }
    onTilt(nx, ny)
  }

  /** 切回前台 / 转屏后重新取基准，否则会带着一次巨大的「偏转」跳一下 */
  function rebase() {
    base = null
  }
  function onVisibility() {
    if (document.visibilityState === 'visible') rebase()
  }

  window.addEventListener('deviceorientation', onOrientation)
  document.addEventListener('visibilitychange', onVisibility)
  screen.orientation?.addEventListener?.('change', rebase)
  return () => {
    window.removeEventListener('deviceorientation', onOrientation)
    document.removeEventListener('visibilitychange', onVisibility)
    screen.orientation?.removeEventListener?.('change', rebase)
  }
}
