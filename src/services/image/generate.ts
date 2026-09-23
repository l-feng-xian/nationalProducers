import type { GeneratedImage, ImageModelService, ImageReferenceInput } from '@/types/image'
import { buildHeaders, resolveUrl, send as httpSend } from '@/services/provider/http'
import { armStall } from '@/services/provider/timeout'
import { toProviderError } from '@/services/provider/stream'
import { ProviderError } from '@/types/provider'
import { generateViaComfyUI } from './comfyui'

const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * 参考图被拒后自动降级重试的状态码（与「不支持参考图」的判定同集合）。
 * 4xx 表示请求被服务端拒绝、未产生生成结果，重试不会重复计费。
 */
const FORMAT_FALLBACK_STATUSES = [400, 404, 405, 415, 422]

/** Blob 转 base64 data URI。分块拼接，避开 String.fromCharCode 的参数上限。 */
async function toDataUri(source: Blob): Promise<string> {
  const bytes = new Uint8Array(await source.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${source.type};base64,${btoa(binary)}`
}

export function validateImageService(service: ImageModelService) {
  let url: URL
  try {
    url = new URL(service.baseUrl.trim())
  } catch {
    throw new Error('请填写有效的接口地址')
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('接口地址必须是 HTTP 或 HTTPS 地址，密钥请填写在 API Key 中')
  }
  if (!service.model.trim()) throw new Error('请填写文生图模型名')
  if (service.size.trim() && !/^(auto|\d{2,5}x\d{2,5})$/.test(service.size.trim())) {
    throw new Error('图片尺寸请填写为宽x高（例如 1024x1536），或 auto；留空使用模型默认值')
  }
  const proxy = service.proxyPrefix.trim()
  if (proxy && !/^\/(?!\/)/.test(proxy) && !/^https?:\/\//.test(proxy)) {
    throw new Error('代理地址应为 / 开头的路径或 HTTP / HTTPS 地址')
  }
}

/** 根据文件签名识别图片，避免将错误页或不可信的 SVG 当作图片保存。 */
export async function imageBlob(blob: Blob): Promise<Blob> {
  if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 25 MB')
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  const ascii = new TextDecoder().decode(bytes)
  const mime =
    bytes[0] === 137 && ascii.slice(1, 4) === 'PNG'
      ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? 'image/jpeg'
        : ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP'
          ? 'image/webp'
          : ascii.startsWith('GIF8')
            ? 'image/gif'
            : ascii.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii.slice(8, 12))
              ? 'image/avif'
              : ''
  if (!mime) throw new Error('服务返回的内容不是支持的图片（PNG / JPEG / WebP / GIF / AVIF）')
  return blob.slice(0, blob.size, mime)
}

export async function generateImage(args: {
  service: ImageModelService
  apiKey: string
  prompt: string
  references?: ImageReferenceInput[]
  signal: AbortSignal
}): Promise<GeneratedImage> {
  const { service, signal } = args
  // 本地 ComfyUI 与 OpenAI Images 的请求形态完全不同，分流到专用后端。
  if (service.backend === 'comfyui')
    return generateViaComfyUI({ service, prompt: args.prompt, references: args.references, signal })
  validateImageService(service)
  const prompt = args.prompt.trim()
  if (!prompt) throw new Error('请填写画面描述')
  const guard = armStall({ idleMs: 180_000, signal })
  try {
    guard.signal.throwIfAborted()
    const body: Record<string, unknown> = { model: service.model.trim(), prompt, n: 1 }
    if (service.size.trim()) body.size = service.size.trim()
    if (service.quality.trim()) body.quality = service.quality.trim()
    if (service.responseFormat) body.response_format = service.responseFormat
    const references = args.references ?? []
    const sources: { source: Blob; extension: string }[] = []
    for (const reference of references) {
      const source = await imageBlob(reference.blob)
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[
        source.type
      ]
      if (!extension)
        throw new Error(
          `「${reference.name}」的参考图需为 PNG、JPEG 或 WebP 格式，请先更换角色封面`,
        )
      sources.push({ source, extension })
    }
    const target = resolveUrl(
      service.baseUrl.trim(),
      references.length ? '/images/edits' : '/images/generations',
      service.proxyPrefix.trim(),
    )
    /**
     * 参考图有两种互不兼容的请求格式：
     *   - multipart（OpenAI 标准，gpt-image 系）：文件字段 image / image[]；
     *   - JSON + image_urls（xAI grok-imagine 系）：只收 base64 data URI，multipart 会被 415 拒绝。
     * 优先使用 referenceMode 缓存的已验证格式（只发一次请求）；未缓存先按 multipart 发送，
     * 被拒后自动换另一种重试一次（先例：listModels 裸域名自动补 /v1），实际成功的格式随返回值
     * 报给调用方回写缓存。
     */
    const send = async (jsonReferences: boolean): Promise<Response> => {
      const headers = buildHeaders(args.apiKey.trim())
      let requestBody: BodyInit
      if (jsonReferences && sources.length) {
        const jsonBody: Record<string, unknown> = {
          ...body,
          image_urls: await Promise.all(sources.map(({ source }) => toDataUri(source))),
        }
        // xAI 系默认返回境外 CDN 的图片链接，常无法直连下载；未显式配置返回格式时请求 base64。
        if (!service.responseFormat) jsonBody.response_format = 'b64_json'
        requestBody = JSON.stringify(jsonBody)
      } else if (jsonReferences) {
        requestBody = JSON.stringify(body)
      } else {
        const form = new FormData()
        for (const [key, value] of Object.entries(body)) form.append(key, String(value))
        sources.forEach(({ source, extension }, index) =>
          form.append(
            sources.length === 1 ? 'image' : 'image[]',
            source,
            `reference-${index + 1}.${extension}`,
          ),
        )
        // multipart 边界由浏览器生成；JSON 的 Content-Type 会使服务无法读取参考图。
        delete headers['Content-Type']
        requestBody = form
      }
      guard.signal.throwIfAborted()
      return httpSend({
        url: target,
        method: 'POST',
        headers,
        body: requestBody,
        signal: guard.signal,
      })
    }
    let response: Response
    let usedMode: 'multipart' | 'json' | undefined
    if (!sources.length) response = await send(true)
    else {
      // 缓存了已验证可用的格式就直接使用，避免每次生成都先白跑一趟被拒的请求。
      const first: 'multipart' | 'json' =
        service.referenceMode === 'json' || service.referenceMode === 'multipart'
          ? service.referenceMode
          : 'multipart'
      response = await send(first === 'json')
      usedMode = first
      if (!response.ok && FORMAT_FALLBACK_STATUSES.includes(response.status)) {
        const firstError = await toProviderError(response)
        guard.kick()
        guard.signal.throwIfAborted()
        response = await send(first !== 'json')
        usedMode = first === 'json' ? 'multipart' : 'json'
        if (!response.ok) {
          const secondError = await toProviderError(response)
          throw new ProviderError(
            secondError.kind,
            `${secondError.message}。已尝试 multipart 与 JSON 两种参考图格式，请确认所选模型支持参考图生成（/images/edits）`,
            secondError.status,
            secondError.detail || firstError.detail,
          )
        }
      }
    }
    if (!response.ok) throw await toProviderError(response)
    const payload = await response.json()
    if (payload?.error) throw new Error(payload.error.message || '文生图服务返回错误')
    const item = payload?.data?.[0] ?? payload?.images?.[0]
    let blob: Blob
    if (typeof item?.b64_json === 'string' && item.b64_json) {
      if (item.b64_json.length > MAX_IMAGE_BYTES * 1.4) throw new Error('图片超过 25 MB')
      let binary: string
      try {
        binary = atob(item.b64_json)
      } catch {
        throw new Error('服务返回的图片编码无效')
      }
      blob = new Blob([Uint8Array.from(binary, (c) => c.charCodeAt(0))])
    } else if (typeof item?.url === 'string' && item.url) {
      const url = new URL(item.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('服务返回的图片地址无效')
      }
      guard.kick()
      // 图片通常来自另一 CDN，绝不向其转发服务密钥。
      let image: Response
      try {
        image = await httpSend({
          url: url.href,
          signal: guard.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        })
      } catch (error) {
        if (guard.signal.aborted) throw error
        throw new Error('下载生成图片失败，请检查图片地址的跨域权限，或将返回格式设为 Base64')
      }
      if (!image.ok) throw new Error(`下载生成图片失败（${image.status}）`)
      if (Number(image.headers.get('content-length')) > MAX_IMAGE_BYTES)
        throw new Error('图片超过 25 MB')
      blob = await image.blob()
    } else throw new Error('服务没有返回图片，请检查模型是否支持文生图接口')
    blob = await imageBlob(blob)
    guard.signal.throwIfAborted()
    return {
      blob,
      prompt,
      model: service.model,
      serviceName: service.name,
      referenceMode: usedMode,
    }
  } catch (error) {
    if (guard.stalled) throw new ProviderError('timeout', '图片生成超时，请稍后重试')
    if (signal.aborted) throw new ProviderError('aborted', '已取消生成')
    if (error instanceof TypeError)
      throw new Error('文生图请求失败，请检查接口地址、网络或跨域代理设置')
    if (error instanceof SyntaxError) throw new Error('文生图服务返回了无效的数据')
    throw error
  } finally {
    guard.dispose()
  }
}
