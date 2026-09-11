/**
 * 二维码识别：摄像头实时扫 + 从图片识别。
 *
 * 优先用原生 `BarcodeDetector`（Android / macOS 的 Chrome、Safari 17+ 有），
 * 没有就动态 import jsQR —— 实测 Windows 版 Chrome 就没有这个 API，所以
 * **兜底库是必需品而不是保险**。jsQR 只在真的用得上时才下载。
 *
 * 纯 service：不 import vue/pinia。
 */

/** 解码时把画面缩到这个宽度。原分辨率逐帧跑 jsQR 在手机上会明显掉帧 */
const DECODE_WIDTH = 640

type Decoder = (img: ImageData) => Promise<string | null>

/** BarcodeDetector 还没进 TS 的 lib.dom，按 WICG 规范声明用得到的那一小块 */
interface BarcodeDetectorLike {
  detect(src: ImageBitmapSource): Promise<{ rawValue: string }[]>
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats(): Promise<string[]>
}

let decoderPromise: Promise<Decoder> | null = null

async function getDecoder(): Promise<Decoder> {
  if (decoderPromise) return decoderPromise
  decoderPromise = (async (): Promise<Decoder> => {
    const Native = (window as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
    if (Native) {
      try {
        const formats = await Native.getSupportedFormats()
        if (formats.includes('qr_code')) {
          const det = new Native({ formats: ['qr_code'] })
          return async (img) => {
            const found = await det.detect(img)
            return found[0]?.rawValue ?? null
          }
        }
      } catch {
        // 有这个 API 不代表能用（部分平台构造就抛），落到 jsQR
      }
    }
    const { default: jsQR } = await import('jsqr')
    return async (img) => jsQR(img.data, img.width, img.height)?.data ?? null
  })()
  return decoderPromise
}

function toImageData(src: CanvasImageSource, w: number, h: number): ImageData {
  const scale = Math.min(1, DECODE_WIDTH / w)
  const dw = Math.max(1, Math.round(w * scale))
  const dh = Math.max(1, Math.round(h * scale))
  const cv = document.createElement('canvas')
  cv.width = dw
  cv.height = dh
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法获取 canvas 绘图上下文')
  ctx.drawImage(src, 0, 0, dw, dh)
  return ctx.getImageData(0, 0, dw, dh)
}

export interface ScanHandle {
  stop: () => void
}

/**
 * 打开摄像头并持续识别，认出第一个码就回调（随后仍会继续扫，由调用方决定何时 stop）。
 *
 * 摄像头要求安全上下文，调用前先判 `isSecureContext` 给出人话提示，
 * 别让用户面对一个裸的 NotAllowedError。
 */
export async function startCameraScan(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
  onError?: (e: Error) => void,
): Promise<ScanHandle> {
  if (!isSecureContext) {
    throw new Error('摄像头需要 https 或 localhost，请用 npm run dev:lan 或部署到 https 站点后再试')
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('这个浏览器不支持调用摄像头')
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // 手机优先后置；桌面没有后置摄像头时会自动退回默认那颗
      video: { facingMode: 'environment', width: { ideal: 1280 } },
      audio: false,
    })
  } catch (e) {
    const name = e instanceof DOMException ? e.name : ''
    if (name === 'NotAllowedError') throw new Error('摄像头权限被拒绝，请在地址栏的权限设置里允许')
    if (name === 'NotFoundError') throw new Error('这台设备没有可用的摄像头，请改用「从图片识别」')
    throw e instanceof Error ? e : new Error(String(e))
  }

  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  await video.play()

  let stopped = false
  const decoder = await getDecoder()
  let busy = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    if (!busy && video.videoWidth > 0) {
      busy = true
      try {
        const text = await decoder(toImageData(video, video.videoWidth, video.videoHeight))
        if (text && !stopped) onResult(text)
      } catch (e) {
        onError?.(e instanceof Error ? e : new Error(String(e)))
      } finally {
        busy = false
      }
    }
    schedule()
  }

  // rVFC 只在有新帧时才回调，比 rAF 省电；Firefox 还没有，退回 rAF
  type WithRvfc = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number
  }
  const v = video as WithRvfc
  const schedule = (): void => {
    if (stopped) return
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => void tick())
    else requestAnimationFrame(() => void tick())
  }
  schedule()

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      // 必须逐条 stop，否则摄像头指示灯会一直亮着
      for (const t of stream.getTracks()) t.stop()
      video.srcObject = null
    },
  }
}

/** 从一张图片里识别二维码。没有摄像头的电脑端靠它扫手机屏幕的截图/照片 */
export async function decodeImageFile(file: File): Promise<string | null> {
  const bmp = await createImageBitmap(file)
  // ⚠️ 宽高必须在 close() 之前取：已关闭的 ImageBitmap 宽高都是 0
  const w = bmp.width
  const h = bmp.height
  try {
    const decoder = await getDecoder()
    return await decoder(toImageData(bmp, w, h))
  } finally {
    bmp.close()
  }
}
