/**
 * Character → 角色卡 PNG。
 *
 * 载体选择（对齐 SillyTavern 的 /export：直接拿原图字节，不做格式转换）：
 *   1. 有头像且魔数是 PNG  → 原样透传（保住 APNG 动画与原画质，也不会把 PNG 越编越大）
 *   2. 有头像但不是 PNG    → createImageBitmap + canvas 重编码成 PNG
 *   3. 没头像 / 解不开     → 画一张 512×768 首字占位图
 *
 * 卡数据的写入交给 buildCardPng —— 它会剥离载体里已有的 chara/ccv3 块，
 * 所以「从 PNG 卡导入的角色再导出」不会带上两份卡数据。透传路径尤其依赖这一点。
 */

import { blobsRepo } from '@/db/repositories'
import type { Character } from '@/types/character'
import { characterToCardJson } from './characterCard'
import { buildCardPng, isPngBytes } from './pngCard'

/** ST 的标准卡面尺寸（SillyTavern/src/constants.js AVATAR_WIDTH / AVATAR_HEIGHT） */
const CARD_W = 512
const CARD_H = 768
/**
 * 重编码时的最长边上限。PNG 是无损的：不限的话一张 4000×3000 的手机照片
 * 会变成几十 MB 的「角色卡」；更硬的理由是 iOS Safari 有画布面积上限，
 * 超了**不抛异常**，直接产出一张空白图。
 */
const MAX_EDGE = 1024
/**
 * 占位图配色 —— 刻意硬编码亮色，不读 CSS 变量。
 * 一是 services 层不该碰 getComputedStyle，二是导出的卡是给别人看的文件，
 * 暗色主题用户不该导出一块近黑的方块让对方以为图裂了。
 */
const PLACEHOLDER_BG = '#e9ecef'
const PLACEHOLDER_FG = '#495057'
/** 能显示中文的字体排前面，否则 Windows Chrome 会挑西文字体再回退，字重和基线都不对 */
const PLACEHOLDER_FONT = "'PingFang SC','Microsoft YaHei','Segoe UI',system-ui,sans-serif"

export interface CardPngResult {
  blob: Blob
  /** 发生降级时给 UI 的提示语（用了占位图、动图掉帧等）。正常导出为 undefined */
  notice?: string
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  return cv
}

/** Safari 不主动释放画布 backing store，连续导出几张会累积到标签页被杀 */
function disposeCanvas(cv: HTMLCanvasElement): void {
  cv.width = 0
  cv.height = 0
}

/** toBlob 是回调式且**可能给 null**（内存不足、画布超尺寸），不是 reject —— 必须显式处理 */
function canvasToPngBytes(cv: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    cv.toBlob((b) => {
      if (!b) {
        reject(new Error('浏览器无法把这张图编码成 PNG（可能是内存不足或图片过大）'))
        return
      }
      b.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject)
    }, 'image/png')
  })
}

/** slice(0,1) 会劈开 UTF-16 代理对，emoji / 扩展 B 区汉字开头的名字会画成豆腐 */
function firstGrapheme(name: string): string {
  return Array.from(name.trim())[0] ?? '?'
}

async function placeholderPng(name: string): Promise<Uint8Array> {
  const cv = makeCanvas(CARD_W, CARD_H)
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 canvas 2d，无法生成占位图')
  ctx.fillStyle = PLACEHOLDER_BG
  ctx.fillRect(0, 0, CARD_W, CARD_H)
  ctx.fillStyle = PLACEHOLDER_FG
  // ctx.font 必须是合法的 CSS font 简写，非法字符串会被**静默忽略**并退回 10px sans-serif
  ctx.font = `700 ${Math.round(CARD_W * 0.45)}px ${PLACEHOLDER_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  const ch = firstGrapheme(name)
  const m = ctx.measureText(ch)
  const asc = m.actualBoundingBoxAscent
  const desc = m.actualBoundingBoxDescent
  // 按墨迹盒居中，比 textBaseline='middle' 更贴近 UI 里 place-items:center 的观感
  const baseline =
    Number.isFinite(asc) && Number.isFinite(desc) && asc + desc > 0
      ? CARD_H / 2 + (asc - desc) / 2
      : CARD_H / 2
  ctx.fillText(ch, CARD_W / 2, baseline)
  const bytes = await canvasToPngBytes(cv)
  disposeCanvas(cv)
  return bytes
}

async function decodeImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    // imageOrientation 必须显式传：规范默认值各引擎切换时间不同，
    // 靠默认值意味着手机竖拍的 JPEG 在旧 Safari 上会躺倒 90° 且宽高互换
    return await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    // SVG / HEIC 等 createImageBitmap 解不了的，退回 <img>
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('图片解码失败'))
        img.src = url
      })
      // 没写 width/height 的 SVG naturalWidth 是 0，画出来是空白，不如直接降级
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片没有固有尺寸')
      return img
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

async function transcodeToPng(blob: Blob): Promise<Uint8Array> {
  const src = await decodeImage(blob)
  const isEl = 'naturalWidth' in src
  const sw = isEl ? src.naturalWidth : src.width
  const sh = isEl ? src.naturalHeight : src.height
  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))
  const cv = makeCanvas(w, h)
  // 千万不要传 { alpha: false }：透明 WebP/GIF 的透明区会变成纯黑而不是透明
  const ctx = cv.getContext('2d')
  if (!ctx) {
    if (!isEl) src.close()
    disposeCanvas(cv)
    throw new Error('浏览器不支持 canvas 2d，无法转换头像格式')
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, w, h)
  if (!isEl) src.close()
  const bytes = await canvasToPngBytes(cv)
  disposeCanvas(cv)
  return bytes
}

/**
 * 导出角色卡 PNG。任何降级都会返回 notice，UI 应当把它 toast 出来。
 * 只有「连占位图都画不出来」才会抛错。
 */
export async function exportCharacterPng(c: Character): Promise<CardPngResult> {
  const cardJson = characterToCardJson(c, false)
  const avatar = c.avatarBlobId ? await blobsRepo.get(c.avatarBlobId) : undefined

  let carrier: Uint8Array | undefined
  let notice: string | undefined

  // size 为 0 的 File 真的存在（Android 云盘 provider、iOS 未下载的 iCloud 照片）
  if (avatar && avatar.size > 0) {
    // 只读前 8 字节判魔数：Blob.type 是浏览器按扩展名猜的，blobsRepo 还有
    // 'application/octet-stream' 兜底，都不可信。整包读进内存只为看 8 个字节在手机上很蠢。
    const head = new Uint8Array(await avatar.slice(0, 8).arrayBuffer())
    if (isPngBytes(head)) {
      carrier = new Uint8Array(await avatar.arrayBuffer())
    } else {
      try {
        carrier = await transcodeToPng(avatar)
        notice = '头像不是 PNG，已重新编码为 PNG；如果原图是动图，导出的卡只保留第一帧'
      } catch {
        notice = '头像这个格式浏览器解不开，已用占位图导出（建议换成 PNG 或 JPG）'
      }
    }
  }

  if (!carrier) carrier = await placeholderPng(c.data.name)

  let out: Uint8Array
  try {
    out = buildCardPng(carrier, cardJson)
  } catch (e) {
    // 走到这里只可能是「透传的 PNG 结构损坏」（截断 / 块长越界）。
    // 占位图是我们自己 canvas 生成的，不可能不合法；它再失败就是真的没救了。
    if (!avatar) throw e
    out = buildCardPng(await placeholderPng(c.data.name), cardJson)
    notice = '头像文件结构已损坏，已用占位图导出'
  }

  return { blob: new Blob([out as BlobPart], { type: 'image/png' }), notice }
}
