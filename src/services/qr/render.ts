/**
 * 二维码绘制。
 *
 * 只从 qrcode-generator 取模块矩阵，自己画到 canvas —— 它自带的 createImgTag /
 * createTableTag 产出的是 img 或 table，缩放会糊、颜色也不好控。
 *
 * 纯 service：不 import vue/pinia。
 */

import qrcode from 'qrcode-generator'

export interface QrOptions {
  /** CSS 像素边长 */
  size: number
  /** 安静区宽度，单位是模块数。规范要求 ≥4，少了识别率明显下降 */
  margin?: number
  /** 纠错级别。配对码本身有版本校验，用 M 在体积与容错间取平衡 */
  ecc?: 'L' | 'M' | 'Q' | 'H'
}

/**
 * 把 text 画进 canvas。
 *
 * 固定黑底白码、不跟随主题：二维码的识别依赖明暗对比，暗色模式下若跟着反色，
 * 很多手机相机会直接扫不出来。所以这里永远给它一块白板。
 */
export function renderQr(canvas: HTMLCanvasElement, text: string, opts: QrOptions): void {
  const margin = opts.margin ?? 4
  // typeNumber 0 = 按内容自动选版本
  const qr = qrcode(0, opts.ecc ?? 'M')
  qr.addData(text)
  qr.make()

  const count = qr.getModuleCount()
  const total = count + margin * 2
  // 按设备像素比放大，否则高 DPI 屏上码眼会发虚
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  const px = Math.floor((opts.size * dpr) / total)
  const side = px * total

  canvas.width = side
  canvas.height = side
  canvas.style.width = `${opts.size}px`
  canvas.style.height = `${opts.size}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法获取 canvas 绘图上下文')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, side, side)
  ctx.fillStyle = '#000000'
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.isDark(r, c)) continue
      // 用整数像素画，避免相邻模块之间出现半像素缝
      ctx.fillRect((c + margin) * px, (r + margin) * px, px, px)
    }
  }
}
