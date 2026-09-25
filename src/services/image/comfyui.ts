/**
 * 本地 ComfyUI 后端（Qwen-Image-2.1：文生图 + 原生参考图编辑）。
 *
 * 与 OpenAI Images「一次 POST 直接返图」完全不同：ComfyUI 是
 *   POST /prompt（提交工作流图）→ 轮询 GET /history/{id}（等执行完）→ GET /view（下载产物）。
 * 图生图需先 POST /upload/image 把参考图传进 input 目录，再由 LoadImage 引用；
 * Qwen 的编辑靠 TextEncodeQwenImage21 把参考图编码进 reference_latents，人物一致性优于 SDXL。
 *
 * ⚠️ 6GB 显存下的崩溃真相与最终修法（本机 RTX 3060 Laptop 6GB 实测复现+验证，2026-09-23）：
 *  核心崩点：ComfyUI 卸载/换出模型时对量化 GGUF DiT 做「整体 GPU->CPU 搬运」(model.to('cpu'))
 *  会段错误(access violation，Python 抓不住，进程直接被杀 → 网页端=“崩溃/连接中断”)。6GB 装不下
 *  8B 编码器 + 7B DiT，二者必须换进换出，任何一次卸载都触发它：①/free ②OOM 恢复 ③下一次不同的生成
 *  加载模型为腾显存而驱逐上次驻留的 DiT。故老现象=「一次启动只稳出 1 张，第 2 张不同生成必崩」。
 *  ⚠️ 实测证伪：`ops.py GGMLTensor.to()` 那个 DisableTorchFunctionSubclass 补丁（乃至加 sync+阻塞
 *  copy）**挡不住整体卸载**；`/free` 也非但没用、自己就是触发点；关掉 aimdo/调 reserve-vram 等所有
 *  启动参数都无法「既出图又安全卸载」(w4a8 编码器还必须 aimdo)。
 *  ✅ 真正的根治 = 给 custom_nodes/ComfyUI-GGUF 打 4 处补丁，把所有「会崩的 .to('cpu')」全部绕开
 *  (实测连续 6+ 张 t2i/i2i 交替、0 段错误；最坏只剩「优雅 OOM=这张失败可重试」，不再杀进程)：
 *     1) ops.py  GGMLTensor.to()          -> DisableTorchFunctionSubclass 包裹搬运
 *     2) nodes.py GGUFModelPatcher.unpatch_model -> device_to=None，跳过致命的整体搬运，显存交给 aimdo 回收
 *     3) nodes.py pin_weight_to_device     -> 跳过“释放 mmap”的 GPU 往返
 *     4) nodes.py load()                   -> 跳过“释放 mmap”的 GPU 往返
 *  这套补丁在自定义节点里，**更新 ComfyUI-GGUF 会覆盖，需从 *.bak_qwenfix* 还原或重打**（启动 bat 头注有清单）。
 *  ✅ 本文件配合做的两件事：① i2i 用 **VAEDecodeTiled 固定小分块(256)** 消除 i2i 解码 OOM（见 buildGraph）；
 *     ② 每次生成前 POST /free（打完补丁后已安全）给编码器让出内存、避开 w4a8 读盘失败。
 *  仍用 aimdo(默认)+w4a8 编码器，不需要 GGUF 版编码器（GGUF 编码器在 aimdo 下 Q4_K 反量化另会崩）。
 *
 * 全程只经 `send()` 出网（Tauri plugin-http 绕 CORS / 安卓明文限制，故能直连
 * `http://127.0.0.1:8188`；纯 Web 需 ComfyUI 开 --enable-cors-header 或走 proxyPrefix）。
 */
import type { GeneratedImage, ImageModelService, ImageReferenceInput } from '@/types/image'
import { buildHeaders, resolveUrl, send as httpSend } from '@/services/provider/http'
import { armStall } from '@/services/provider/timeout'
import { toProviderError } from '@/services/provider/stream'
import { ProviderError } from '@/types/provider'
import { isTauri } from '@/services/platform/env'

/** 开发期网页版的同源中转前缀，见 vite.config.ts 的 comfyuiRelay */
const DEV_RELAY = '/comfyui'

/**
 * 某个 ComfyUI 接口的实际请求地址与附加请求头。**所有请求都必须经过这里**。
 *
 * - 原生 App（exe / 安卓）：plugin-http 直连填写的地址，本机 127.0.0.1 与局域网 IP 都行；
 * - 网页版开发期（未手填代理）：改走同源 `/comfyui` 中转，由开发服务器转发到目标 ComfyUI ——
 *   手机用 `npm run dev:lan` 打开的是 https 页面，直连 http 的局域网 ComfyUI 会被浏览器当作
 *   混合内容拦下；走中转也免去 CORS 与 ComfyUI 防 CSRF 的 403；
 * - 手填了代理地址：沿用旧逻辑（用代理前缀替换源）。
 */
function endpoint(
  service: Pick<ImageModelService, 'baseUrl' | 'proxyPrefix'>,
  path: string,
): { url: string; headers: Record<string, string> } {
  const base = service.baseUrl.trim()
  const proxy = service.proxyPrefix.trim()
  if (!proxy && !isTauri && import.meta.env.DEV) {
    try {
      return { url: DEV_RELAY + path, headers: { 'X-ComfyUI-Target': new URL(base).origin } }
    } catch {
      // 地址本身不合法：交给下面的直连，报出正常的地址错误
    }
  }
  return { url: resolveUrl(base, path, proxy), headers: {} }
}

function hostKind(baseUrl: string): 'loopback' | 'lan' | 'other' {
  try {
    const h = new URL(baseUrl).hostname
    if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return 'loopback'
    if (/^(10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254)\./.test(h) || h.endsWith('.local'))
      return 'lan'
  } catch {
    /* 非法地址 */
  }
  return 'other'
}

/** 是不是「根本没连上」这一类错误：浏览器 fetch 的 TypeError，或原生 plugin-http 的连接错误 */
function isConnectFailure(error: unknown): boolean {
  if (error instanceof TypeError) return !/ByteString|Headers|header/i.test(error.message)
  const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /error sending request|connect|timed out|refused|unreachable|dns|relay: 连不上/i.test(msg)
}

/**
 * 连不上时给出**按场景**的原因，而不是一句笼统的「无法连接」。
 * 局域网调用最常见的三种错法：安卓上填了 127.0.0.1、ComfyUI 没监听局域网、https 网页直连 http。
 */
export function comfyConnectHint(baseUrl: string): string {
  const kind = hostKind(baseUrl)
  const onAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
  if (kind === 'loopback' && onAndroid)
    return '无法连接 ComfyUI：在手机上 127.0.0.1 指的是手机自己。请改填运行 ComfyUI 的电脑的局域网地址，例如 http://192.168.1.10:8188。'
  if (
    !isTauri &&
    typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    baseUrl.trim().startsWith('http:') &&
    !import.meta.env.DEV
  )
    return '无法连接 ComfyUI：当前网页是 https，浏览器禁止它访问 http 地址（混合内容）。请改用 App，或通过 https 反向代理访问 ComfyUI。'
  if (kind === 'lan')
    return '无法连接局域网里的 ComfyUI：请确认那台电脑上 ComfyUI 已用「--listen 0.0.0.0」启动（可用「启动Qwen-Image-局域网.bat」）、Windows 防火墙放行了 8188 端口，且本设备与它在同一个局域网。'
  return '无法连接 ComfyUI，请检查服务器地址、ComfyUI 是否已启动；纯网页（非开发模式）还需给 ComfyUI 加 --enable-cors-header。'
}
import { imageBlob } from './generate'

/** 生成的每张图最长等待（6GB 上 Qwen-2.1 一张约 70–120s，含每次 /free 后的重载，留足余量）。 */
const GENERATE_IDLE_MS = 6 * 60_000

export function validateComfyService(service: ImageModelService) {
  let url: URL
  try {
    url = new URL(service.baseUrl.trim())
  } catch {
    throw new Error('请填写有效的 ComfyUI 服务器地址，例如 http://127.0.0.1:8188')
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('服务器地址必须是 HTTP 或 HTTPS 地址')
  }
  if (!service.model.trim()) throw new Error('请填写 DiT（扩散主干）GGUF 文件名')
  if (!service.clipName.trim()) throw new Error('请填写文本编码器文件名')
  if (!service.vaeName.trim()) throw new Error('请填写 VAE 文件名')
  const resolution = Number(service.resolution)
  if (
    !Number.isFinite(resolution) ||
    resolution < 256 ||
    resolution > 2048 ||
    resolution % 32 !== 0
  )
    throw new Error('分辨率需为 256–2048 之间、32 的倍数')
  const steps = Number(service.steps)
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error('步数需为 1–100')
  const cfg = Number(service.cfg)
  if (!Number.isFinite(cfg) || cfg < 0 || cfg > 30) throw new Error('CFG 需为 0–30')
  const denoise = Number(service.denoise)
  if (!Number.isFinite(denoise) || denoise <= 0 || denoise > 1)
    throw new Error('图生图去噪强度需为 0–1 之间')
  const proxy = service.proxyPrefix.trim()
  if (proxy && !/^\/(?!\/)/.test(proxy) && !/^https?:\/\//.test(proxy))
    throw new Error('代理地址应为 / 开头的路径或 HTTP / HTTPS 地址')
}

type ComfyNode = { class_type: string; inputs: Record<string, unknown> }
type ComfyGraph = Record<string, ComfyNode>

/** 把参考图上传到 ComfyUI 的 input 目录，返回 LoadImage 可用的文件名。 */
async function uploadImage(
  service: ImageModelService,
  reference: ImageReferenceInput,
  index: number,
  signal: AbortSignal,
): Promise<string> {
  const source = await imageBlob(reference.blob)
  const ext =
    { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[source.type] ?? 'png'
  const form = new FormData()
  form.append('image', source, `ref-${Date.now()}-${index + 1}.${ext}`)
  form.append('overwrite', 'true')
  form.append('type', 'input')
  const ep = endpoint(service, '/upload/image')
  const headers = { ...buildHeaders(''), ...ep.headers }
  // multipart 边界由运行时生成，带上 JSON 的 Content-Type 会让服务无法解析。
  delete headers['Content-Type']
  const res = await httpSend({ url: ep.url, method: 'POST', headers, body: form, signal })
  if (!res.ok) throw await toProviderError(res)
  const payload = (await res.json()) as { name?: string; subfolder?: string }
  if (!payload?.name) throw new Error('参考图上传失败，ComfyUI 未返回文件名')
  return payload.subfolder ? `${payload.subfolder}/${payload.name}` : payload.name
}

/**
 * 构造 Qwen-Image-2.1 API 格式工作流（文生图 / 参考图编辑）。
 *
 * 关键点：KSampler 的 latent_image 必须接 TextEncodeQwenImage21 的第 3 个输出(index 2, 空 latent)——
 * Qwen 的 latent 通道数与普通 EmptyLatentImage/EmptySD3LatentImage 不同，接错会让每步慢 10 倍。
 * 参考图通过编码器的 Autogrow 输入注入（API 键名是平铺的 `images.image_N`，见下方注释），并把 vae 接进编码器；
 * 编辑用 denoise=1（靠 reference_latents 而非部分去噪）。CFG 固定 1（引导蒸馏），负面提示词此时不生效。
 */
function buildGraph(
  service: ImageModelService,
  prompt: string,
  uploadedNames: string[],
  seed: number,
): ComfyGraph {
  const resolution = Number(service.resolution) || 1024
  const encoderInputs: Record<string, unknown> = {
    clip: ['2', 0],
    prompt,
    negative_prompt: service.negativePrompt ?? '',
    resolution,
  }
  const graph: ComfyGraph = {
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: service.model.trim() } },
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: service.clipName.trim(), type: 'qwen_image', device: 'default' },
    },
    '3': { class_type: 'VAELoader', inputs: { vae_name: service.vaeName.trim() } },
    '5': { class_type: 'TextEncodeQwenImage21', inputs: encoderInputs },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['5', 0],
        negative: ['5', 1],
        latent_image: ['5', 2], // ⚠️ 必须是编码器的 latent 输出，别换 EmptyLatentImage
        seed,
        steps: Number(service.steps) || 12,
        cfg: Number(service.cfg) || 1,
        sampler_name: service.sampler.trim() || 'euler',
        scheduler: service.scheduler.trim() || 'simple',
        denoise: 1,
      },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    // ⚠️ 前缀必须是纯 ASCII：ComfyUI 的 /view 会把文件名原样写进 Content-Disposition 响应头，
    // 打包后的 App 走 plugin-http，它用 `new Headers()` 重建响应头，而 Headers 只收 ≤U+00FF 的
    // ByteString —— 「幕间_生成」会让它抛 TypeError，图其实已经生成、却下载不回来
    // （实测：exe 里报「无法连接 ComfyUI」，ComfyUI 输出目录里却有图）。浏览器原生 fetch 不受影响。
    '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'mujian_gen' } },
  }
  if (uploadedNames.length > 0) {
    // 参考图编辑：每张参考图一个 LoadImage，接进编码器的 Autogrow 输入；vae 也接进去编码 reference_latents。
    //
    // ⚠️ API 格式里 Autogrow 的每个槽位是**平铺的点号键** `images.image_1`、`images.image_2`……
    // （ComfyUI 的 finalize_prefix 按 `输入id.槽名` 登记，执行前 build_nested_inputs 再还原成
    //  节点收到的 `images = {image_1: …}`）。**不能**写成嵌套对象 `images: { image_1: … }`：
    // 键 `images` 不是已登记的输入 id，会被执行器静默丢弃，节点拿到空的 images ——
    // 没有 reference_latents、视觉塔也看不到参考图，实际跑成纯文生图；LoadImage 也因不再被
    // 任何节点引用而根本不执行。症状就是「图生图出来的图和参考图完全不一样」且不报任何错。
    // （已用 ComfyUI v0.37.0 自身的 get_finalized_class_inputs / build_nested_inputs 对两种写法实测核对。）
    uploadedNames.forEach((name, i) => {
      const nodeId = String(20 + i)
      graph[nodeId] = { class_type: 'LoadImage', inputs: { image: name } }
      encoderInputs[`images.image_${i + 1}`] = [nodeId, 0]
    })
    encoderInputs.vae = ['3', 0]
    const denoise = Number(service.denoise)
    ;(graph['8'] as ComfyNode).inputs.denoise =
      Number.isFinite(denoise) && denoise > 0 ? denoise : 1
    // ⚠️ 6GB 上图生图必须用「分块」VAE 解码，否则会崩溃（本机实测，见文件头注释 3）：
    // 图生图把参考图编码进 reference_latents，采样阶段驻留显存远大于文生图，解码时 DiT 仍占用
    // ~2.8GB，普通 VAEDecode 连 ComfyUI 自带的 tiled 回退都会 OOM。一旦 OOM，ComfyUI 的
    // unload_all_models 恢复会把量化 DiT `.to('cpu')` 触发段错误（access violation）直接杀掉进程，
    // 网页端表现为“连接中断/崩溃”。固定小分块（256）把解码显存钉在预算内，从源头避免 OOM。
    graph['9'] = {
      class_type: 'VAEDecodeTiled',
      inputs: {
        samples: ['8', 0],
        vae: ['3', 0],
        tile_size: 256,
        overlap: 64,
        temporal_size: 64,
        temporal_overlap: 8,
      },
    }
  }
  return graph
}

/** 轮询 /history/{id} 直到成功或报错，返回第一张产物的定位信息。 */
async function pollResult(
  service: ImageModelService,
  promptId: string,
  guard: ReturnType<typeof armStall>,
): Promise<{ filename: string; subfolder: string; type: string }> {
  for (;;) {
    guard.signal.throwIfAborted()
    await new Promise((r) => setTimeout(r, 1500))
    guard.signal.throwIfAborted()
    const ep = endpoint(service, `/history/${encodeURIComponent(promptId)}`)
    const res = await httpSend({
      url: ep.url,
      method: 'GET',
      headers: { ...buildHeaders(''), ...ep.headers },
      signal: guard.signal,
    })
    if (!res.ok) throw await toProviderError(res)
    guard.kick()
    const hist = (await res.json()) as Record<
      string,
      {
        status?: { status_str?: string; messages?: unknown[] }
        outputs?: Record<
          string,
          { images?: { filename: string; subfolder: string; type: string }[] }
        >
      }
    >
    const entry = hist[promptId]
    if (!entry) continue // 还没进历史，继续等
    if (entry.status?.status_str === 'error') {
      const detail = JSON.stringify(entry.status.messages ?? []).slice(0, 800)
      throw new Error(`ComfyUI 生成失败：${detail}`)
    }
    for (const out of Object.values(entry.outputs ?? {})) {
      const image = out.images?.find((im) => im.type !== 'temp') ?? out.images?.[0]
      if (image) return image
    }
    // 有 entry 但暂无 images：仍在执行，继续轮询
  }
}

/**
 * 每次生成前卸载 ComfyUI 已驻留的模型。6GB 上这是硬性步骤：不 /free 的话，第二次生成
 * 加载 w4a8 编码器时会因 RAM 压力触发 Windows overlapped I/O error 1450 而失败
 * （详见文件头注释）。/free 返回空 body、成功与否都不应阻断生成，故吞掉异常。
 */
async function freeComfyMemory(service: ImageModelService, signal: AbortSignal): Promise<void> {
  try {
    const ep = endpoint(service, '/free')
    await httpSend({
      url: ep.url,
      method: 'POST',
      headers: { ...buildHeaders(''), ...ep.headers },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal,
    })
  } catch {
    // /free 失败不致命（端点缺失或服务忙）；继续尝试生成
  }
}

export async function generateViaComfyUI(args: {
  service: ImageModelService
  prompt: string
  references?: ImageReferenceInput[]
  signal: AbortSignal
}): Promise<GeneratedImage> {
  const { service, signal } = args
  validateComfyService(service)
  const prompt = args.prompt.trim()
  if (!prompt) throw new Error('请填写画面描述')
  const references = args.references ?? []
  const guard = armStall({ idleMs: GENERATE_IDLE_MS, signal })
  try {
    guard.signal.throwIfAborted()
    // 先卸载驻留模型，给编码器读盘让出内存（6GB 上不做会崩，见 freeComfyMemory）
    await freeComfyMemory(service, guard.signal)
    guard.kick()
    const uploaded: string[] = []
    for (const [i, reference] of references.entries()) {
      uploaded.push(await uploadImage(service, reference, i, guard.signal))
      guard.kick()
    }
    const seed = Math.floor(Math.random() * 2 ** 48)
    const graph = buildGraph(service, prompt, uploaded, seed)
    const clientId = crypto.randomUUID()
    const promptEp = endpoint(service, '/prompt')
    const submit = await httpSend({
      url: promptEp.url,
      method: 'POST',
      headers: { ...buildHeaders(''), ...promptEp.headers },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
      signal: guard.signal,
    })
    if (!submit.ok) {
      // /prompt 校验失败会带 node_errors，尽量把它带出来便于排查
      let extra = ''
      try {
        const j = (await submit.clone().json()) as {
          error?: { message?: string }
          node_errors?: unknown
        }
        extra =
          j?.error?.message || (j?.node_errors ? JSON.stringify(j.node_errors).slice(0, 500) : '')
      } catch {
        /* 非 JSON，走通用错误 */
      }
      const err = await toProviderError(submit)
      throw new ProviderError(
        err.kind,
        extra ? `${err.message}：${extra}` : err.message,
        err.status,
      )
    }
    const { prompt_id: promptId } = (await submit.json()) as { prompt_id?: string }
    if (!promptId) throw new Error('ComfyUI 未返回任务 ID，请确认服务器地址正确')
    const image = await pollResult(service, promptId, guard)
    guard.kick()
    const params = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    })
    const viewEp = endpoint(service, `/view?${params.toString()}`)
    const view = await httpSend({
      url: viewEp.url,
      method: 'GET',
      headers: viewEp.headers,
      signal: guard.signal,
    })
    if (!view.ok) throw new Error(`下载生成图片失败（${view.status}）`)
    const blob = await imageBlob(await view.blob())
    guard.signal.throwIfAborted()
    return { blob, prompt, model: service.model, serviceName: service.name }
  } catch (error) {
    if (guard.stalled)
      throw new ProviderError('timeout', '图片生成超时，请确认 ComfyUI 正在运行且未卡住')
    if (signal.aborted) throw new ProviderError('aborted', '已取消生成')
    // 连不上（浏览器 TypeError / 原生连接错误 / 中转 502）：按场景给出原因。
    // 其它 TypeError 不能一概翻译成「无法连接」—— 曾把响应头 ByteString 错误误报成连不上
    if (isConnectFailure(error)) throw new Error(comfyConnectHint(service.baseUrl))
    if (error instanceof SyntaxError) throw new Error('ComfyUI 返回了无效的数据')
    throw error
  } finally {
    guard.dispose()
  }
}

/**
 * 拉取 ComfyUI 里可选的 Qwen 三件套文件名（供编辑器下拉回填）。
 * 打 /object_info 取 UnetLoaderGGUF / CLIPLoader / VAELoader 的下拉项。
 */
export async function listComfyModels(
  service: Pick<ImageModelService, 'baseUrl' | 'proxyPrefix'>,
  signal: AbortSignal,
): Promise<{ unets: string[]; clips: string[]; vaes: string[] }> {
  const ep = endpoint(service, '/object_info')
  let res: Response
  try {
    res = await httpSend({
      url: ep.url,
      method: 'GET',
      headers: { ...buildHeaders(''), ...ep.headers },
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    if (isConnectFailure(error)) throw new Error(comfyConnectHint(service.baseUrl))
    throw error
  }
  // 中转连不上目标时回 502，同样按场景解释
  if (res.status === 502 && ep.url.startsWith(DEV_RELAY))
    throw new Error(comfyConnectHint(service.baseUrl))
  if (res.status === 403)
    throw new Error(
      'ComfyUI 拒绝了请求（403，来源校验）。请给 ComfyUI 启动参数加上 --enable-cors-header "*"。',
    )
  if (!res.ok) throw await toProviderError(res)
  const info = (await res.json()) as Record<
    string,
    { input?: { required?: Record<string, unknown> } }
  >
  /** 取某节点某必填项的下拉候选（值为 [enumArray, ...] 的那种）。 */
  const combo = (node: string, field: string): string[] => {
    const v = info[node]?.input?.required?.[field]
    if (Array.isArray(v) && Array.isArray(v[0]))
      return (v[0] as unknown[]).filter((x): x is string => typeof x === 'string')
    return []
  }
  return {
    unets: combo('UnetLoaderGGUF', 'unet_name'),
    clips: combo('CLIPLoader', 'clip_name'),
    vaes: combo('VAELoader', 'vae_name'),
  }
}
