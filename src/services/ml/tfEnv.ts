/**
 * transformers.js 的环境配置，**嵌入 Worker 与深度 Worker 共用**。
 *
 * 抽出来不是为了省那十几行代码，是为了别让下面这段教训存在两份然后各自漂移。
 *
 * ⚠️ 只能在 Worker 里 import 这个模块。它会把 transformers（约 1MB）拉进依赖图，
 * 主线程碰一下就毁掉「不开就零字节」的承诺。**类型 import 安全（会被擦除），值 import 不安全。**
 */

import wasmPaths from '../vector/wasm'
import { RELAY_HANDSHAKE, type RelayReply, type RelayRequest } from './fetchRelay'

export type Tf = typeof import('@huggingface/transformers')

// ── 原生壳里的下载代发通道（见 fetchRelay.ts）──
// 主线程建完 Worker 立刻发来端口，早于任何业务消息；Web 端不会发，relayPort 保持 null。
// 在模块求值时注册，先于各 Worker 自己的 self.onmessage，收到握手后截住不往下传。
let relayPort: MessagePort | null = null
let relaySeq = 0
const relayPending = new Map<
  number,
  { resolve: (r: Response) => void; reject: (e: Error) => void }
>()

/** 这些状态码的 Response 不许带 body，构造时传流会直接抛 TypeError */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

function onRelayReply(ev: MessageEvent<RelayReply>) {
  const r = ev.data
  const p = relayPending.get(r.id)
  if (!p) return
  relayPending.delete(r.id)
  if (!r.ok) {
    p.reject(new Error(`下载失败：${r.message}`))
    return
  }
  const body = NULL_BODY_STATUS.has(r.status) ? null : (r.body ?? r.buf ?? null)
  p.resolve(new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers }))
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as { type?: string; port?: MessagePort } | null
    if (d?.type !== RELAY_HANDSHAKE || !d.port) return
    ev.stopImmediatePropagation()
    relayPort = d.port
    relayPort.onmessage = onRelayReply
  })
}

/** 与 fetch 同签名的代发版。只取 url / method / headers —— signal 等不可克隆的字段不过线 */
function relayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const port = relayPort
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(raw, self.location.href)
  // ⚠️ 只代发**跨源**请求。onnxruntime 的 .wasm 等应用自身资源走的也是 env.fetch，
  // 在安卓壳里它们在 `http://tauri.localhost/...` —— 那是 WebView 拦截出来的虚拟主机，
  // Rust 的 reqwest 根本连不上。实测：不加这道判断，代发清单里会混进 ort-wasm-simd-threaded.wasm。
  if (!port || url.origin === self.location.origin) return fetch(input, init)
  const headers: Record<string, string> = {}
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
    (v, k) => (headers[k] = v),
  )
  const id = ++relaySeq
  return new Promise((resolve, reject) => {
    relayPending.set(id, { resolve, reject })
    const req: RelayRequest = { id, url: url.href, method: init?.method ?? 'GET', headers }
    port.postMessage(req)
  })
}

/** transformers 原始的 env.fetch。setupTf 每条消息都会调，只能包一次，否则守卫一层层套上去 */
let baseFetch: Tf['env']['fetch'] | null = null

/**
 * 配好 env 并返回 transformers 模块。
 *
 * ⚠️ `allowLocalModels` 必须**恒为 false**，这条是踩出来的，代价很大：
 *
 * 模型不随应用发布，`/models/...` 并不存在。而 SPA 托管（vite dev、preview、
 * Netlify、Vercel…）对未知路径的回落是 **200 + index.html**，不是 404。
 * allowLocalModels 为 true 时，未命中缓存的文件会先去那里探一次、拿回一份 HTML；
 * `loadResourceFile` 只看状态码是不是 200 就把它**写进 Cache Storage**，键是本地路径。
 *
 * 于是缓存被永久毒化：此后每次加载都先命中这条 HTML 条目，而**缓存命中会短路掉
 * 所有 allow 开关**，重试、换配置、改 env 全都没用，报错永远是
 * 「Unexpected token '<'」，看不出跟本地路径有任何关系。只有手动清掉整个
 * Cache Storage 才能恢复。
 *
 * 连带的代价：不能用 `local_files_only` 表达「只用缓存、绝不联网」——
 * 它有一道守卫要求 allowLocalModels 为 true（两者矛盾时直接抛错）。
 * 所以「不许联网」改由调用方在 pipeline **之前**用 is_pipeline_cached 把关，
 * 见各 Worker 的 init/estimate。
 *
 * `mode` 目前只影响语义表达，两条路径的 env 是一样的 —— 保留这个参数是为了
 * 让调用点自己说清楚「我这次允不允许产生流量」，别再让人去猜。
 */
export async function setupTf(mode: 'cache' | 'download', remoteHost?: string): Promise<Tf> {
  const tf = await import('@huggingface/transformers')
  const env = tf.env

  // 下载源（remoteHost）。transformers 用它拼所有权重 URL，默认 https://huggingface.co/。
  // 由调用方（主线程）经消息把当前设置带进来；缺省不动，保持库的默认值。
  // ⚠️ 缓存键含 host：下载/查缓存/推理三处必须传同一个 host，见 services/ml/downloadHost.ts。
  if (remoteHost) env.remoteHost = remoteHost

  // ⚠️ 必须在任何下载/查缓存之前包上：把「HTML 冒充模型文件」挡在缓存之外，见文件末尾 guardHtml。
  // 原生壳里有代发通道时改走主线程的 send()（Rust reqwest），否则镜像的防盗链 + CORS 会拦死下载。
  baseFetch ??= env.fetch
  env.fetch = guardHtml(relayPort ? (relayFetch as Tf['env']['fetch']) : baseFetch)

  const wasmEnv = env.backends.onnx.wasm
  if (!wasmEnv) throw new Error('onnxruntime-web 的 wasm 后端不可用')
  // wasmPaths 必须是**同时带 .wasm 与 .mjs 两个键的对象**：
  // v4 源码里 shouldUseWasmCache 的守卫要求如此，老文档里的字符串写法
  // 不报错，只是静默禁用 WASM 缓存。
  wasmEnv.wasmPaths = wasmPaths
  // 不追求多线程：需要 COOP/COEP 跨源隔离，而那会拦掉角色卡外链头像和外部字体，
  // 静态托管也多半配不了。
  wasmEnv.numThreads = 1
  wasmEnv.proxy = false

  env.allowLocalModels = false
  env.allowRemoteModels = true
  void mode
  return tf
}

/** env.fetch 的类型。transformers 自己声明成 `(input: string | URL, init?: any) => Promise<any>`。 */
type FetchFn = Tf['env']['fetch']

/**
 * 包一层 env.fetch，**拒绝把 HTML 当成模型文件**。
 *
 * transformers.js 写缓存**只看状态码**（hub.js 里 `response.status !== 200` 之外一律进
 * Cache Storage），**从不校验 content-type**。而 SPA 托管（vite dev / preview / Netlify…）
 * 对未知路径的回落是 **200 + index.html**，不是 404。于是下载源一时不通时
 * （最典型：同源代理 `/hf` 还没生效 —— 改完 vite.config.ts 忘了重启 dev server），
 * 那份 index.html 会被当成权重**写进缓存**。
 *
 * ⚠️ 本项目实际踩到的是**另一种**更隐蔽的来源：hf-mirror 的**防盗链** —— 带外站 Referer
 * 请求权重会返回「警告：未授权访问」的 HTML 页，**状态码同样是 200**。浏览器一律带 Referer 而
 * curl 默认不带，于是命令行测一切正常、页面里必炸。已在 vite.config.ts 的 /hf 代理里用 headers
 * 伪装成同站 Referer 根治；这里的守卫是第二道防线（也挡住任何未来的 200-HTML 来源）。
 *
 * 之后真正致命的是**缓存命中会短路掉网络**：代理修好了也没用，每次加载都先命中那条
 * HTML，报错永远是 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`，
 * 且完全看不出跟代理/下载源有关。历史上只能手动清整个 Cache Storage 才能恢复。
 *
 * 所以宁可这次下载**响亮地失败**，也绝不留下一条要手动清理才能恢复的毒条目。
 * ⚠️ 只读 header 不碰 body：body 一旦被读掉，下游就拿不到权重流了。
 * 配套的「修好已经中毒的浏览器」在 services/ml/cacheRepair.ts。
 */
function guardHtml(inner: FetchFn): FetchFn {
  return async (input, init) => {
    const res = await inner(input, init)
    const ct: string = res?.headers?.get?.('content-type') ?? ''
    if (res?.ok && /^\s*text\/html/i.test(ct)) {
      throw new Error(
        `下载源返回了 HTML 而不是模型文件：${String(input)}\n` +
          `两种常见原因：① 镜像防盗链 —— hf-mirror 见到外站 Referer 会回「未授权访问」页，状态码仍是 200（vite.config.ts 的 /hf 已用 headers 伪装成同站 Referer 规避）；② /hf 代理没生效，请求落到了 SPA 回落的 index.html 上（改完 vite.config.ts 要重启 dev server）。
` +
          `已拒绝写入缓存 —— 否则这条 HTML 会被当成权重存进 Cache Storage，之后缓存命中短路网络，报错永远是 Unexpected token '<'，修好代理也无法自行恢复。`,
      )
    }
    return res
  }
}
