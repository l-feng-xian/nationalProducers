import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import basicSsl from '@vitejs/plugin-basic-ssl'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'

/**
 * ComfyUI 局域网中转（仅开发服务器）：浏览器里的网页版把 ComfyUI 请求发到同源的 `/comfyui/*`，
 * 由这里转发到请求头 `X-ComfyUI-Target` 指定的 ComfyUI（本机或局域网里另一台电脑）。
 *
 * 为什么网页版需要它（原生 App 走 plugin-http 不受这些限制，不经过这里）：
 *  1. **混合内容**：手机联调用 `npm run dev:lan`，页面是 https；浏览器禁止 https 页面去请求
 *     `http://192.168.x.x:8188`，连请求都发不出去。走同源中转就没有这个问题。
 *  2. **CORS**：ComfyUI 不开 `--enable-cors-header` 就不回 CORS 头，跨源读不到响应。
 *  3. **ComfyUI 的防 CSRF 中间件**：带 `Sec-Fetch-Site: cross-site`，或目标是回环地址而 Origin
 *     与 Host 不一致，都会直接 403。这里转发时剥掉浏览器的来源类请求头。
 *
 * ⚠️ 只许转发到**私网 / 回环**地址：`dev:lan` 会把开发服务器暴露给整个局域网，不设限就成了
 * 谁都能用的开放代理（SSRF）。
 */
function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h === '::1') return true
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

const DROP_HEADERS = new Set(['host', 'origin', 'referer', 'connection', 'x-comfyui-target'])
/**
 * 逐跳（hop-by-hop）头不能转发。`dev:lan` 是 https，Vite 用的是 **HTTP/2**：
 * 请求里带 `:method` `:path` 这类伪头（原样塞进 HTTP/1 请求会直接抛错 → 500），
 * 而 HTTP/2 响应又禁止出现 connection / transfer-encoding 这类连接级头。两头都要过滤。
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
])

function comfyuiRelay(): Plugin {
  function handle(req: IncomingMessage, res: ServerResponse) {
    const raw = req.headers['x-comfyui-target']
    let target: URL
    try {
      target = new URL(String(Array.isArray(raw) ? raw[0] : raw))
      if (!/^https?:$/.test(target.protocol)) throw new Error('protocol')
    } catch {
      res.statusCode = 400
      res.end('comfyui relay: 缺少或无效的 X-ComfyUI-Target')
      return
    }
    if (!isPrivateHost(target.hostname)) {
      res.statusCode = 403
      res.end('comfyui relay: 只允许转发到本机或局域网地址')
      return
    }
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || k.startsWith(':') || DROP_HEADERS.has(k) || HOP_BY_HOP.has(k)) continue
      if (k.startsWith('sec-fetch-')) continue
      headers[k] = v
    }
    headers['host'] = target.host
    // req.url 已被 connect 去掉了挂载前缀 /comfyui
    const url = new URL(req.url || '/', target)
    const upstream = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: req.method, headers },
      (up) => {
        const out: Record<string, string | string[]> = {}
        for (const [k, v] of Object.entries(up.headers)) {
          if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v
        }
        res.writeHead(up.statusCode ?? 502, out)
        up.pipe(res)
      },
    )
    upstream.on('error', (e) => {
      if (res.headersSent) return res.destroy()
      res.statusCode = 502
      res.end(
        `comfyui relay: 连不上 ${target.host}（${(e as NodeJS.ErrnoException).code ?? e.message}）`,
      )
    })
    req.pipe(upstream)
  }
  return {
    name: 'comfyui-lan-relay',
    configureServer(server) {
      server.middlewares.use('/comfyui', handle)
    },
  }
}

/**
 * 认出 onnxruntime-web 的 asyncify 版 wasm（这一支历史上叫过 jsep）。
 *
 * 刻意用**子串包含**而不是精确正则：产物名是 `ort-wasm-simd-threaded.asyncify-<hash>.wasm`，
 * 哈希是用**连字符**接在 asyncify 后面的，不是点号 —— 第一版我按 `\.asyncify\.` 写，
 * 结果一个都没匹配上，而构建照常成功、23.5MB 原样留在产物里。
 */
function isOrtAsyncifyWasm(file: string): boolean {
  if (!file.endsWith('.wasm') || !file.includes('ort-wasm')) return false
  return file.includes('asyncify') || file.includes('jsep')
}

/**
 * 把 onnxruntime-web 的 asyncify 版 wasm 踢出产物 —— 23.5MB，我们一个字节都用不到。
 *
 * 它为什么会进来：transformers.js 把 ORT 的 asyncify 胶水 .mjs **静态**打进了自己的
 * bundle，那段 Emscripten 胶水里有一句 `new URL('...asyncify.wasm', import.meta.url)`，
 * 打包器一看见就 emit 资产 —— 哪怕这段代码永远不会执行。
 *
 * 为什么永远不会执行：所有指向 asyncify 的分支都以「wasmPaths 未设置」为前提
 * （transformers.js 自己的兜底是 `if (!env.wasm.wasmPaths)`，落到 jsDelivr CDN；
 * ORT 的 proxy 初始化同理）。而 embedder.worker.ts 在 `tf.pipeline()` 之前就
 * 无条件把 wasmPaths 设成了本地那对非 asyncify 文件。
 *
 * 不是推断，是实测：把这个文件从 dist 里删掉、起 vite preview、在生产产物里
 * 完整跑一次 init + embed —— 1293ms、512 维、L2 = 1.0000，无任何 404。
 *
 * ⚠️ 只删产物、不改引用：那句 `new URL(...)` 仍留在 JS 里，指向一个不存在的文件。
 * 这是刻意的取舍 —— 去改压缩后的字符串风险远大于收益，而那行代码跑不到。
 * 真要有一天跑到了，表现是干净的 404 而不是静默错误。
 */
function dropUnusedOrtAsyncifyWasm(): Plugin {
  return {
    name: 'drop-unused-ort-asyncify-wasm',
    apply: 'build',
    generateBundle(_options, bundle) {
      const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`
      const kept: string[] = []
      let droppedBytes = 0
      for (const [file, out] of Object.entries(bundle)) {
        if (!file.endsWith('.wasm')) continue
        const src = out.type === 'asset' ? out.source : ''
        const bytes = typeof src === 'string' ? Buffer.byteLength(src) : src.byteLength
        if (isOrtAsyncifyWasm(file)) {
          delete bundle[file]
          droppedBytes += bytes
        } else {
          kept.push(`${file} ${mb(bytes)}`)
        }
      }
      // 直接走 console：rolldown 不保证把插件的 this.warn 透到构建输出里，
      // 而「悄悄失效」正是这个插件最需要避免的失败方式。
      if (droppedBytes) {
        console.log(
          `[ort] 已剔除未使用的 asyncify wasm ${mb(droppedBytes)}；保留 ${kept.join('、')}`,
        )
      } else {
        console.warn(
          `[ort] ⚠️ 没有匹配到 asyncify wasm。若 onnxruntime-web 升级后改了命名，` +
            `请更新 isOrtAsyncifyWasm。当前产物里的 wasm：${kept.join('、') || '无'}`,
        )
      }
    },
  }
}

/**
 * 开发期 CORS 代理。
 *
 * 浏览器直连 OpenAI 官方、Ollama 等会被 CORS 挡住。设置页把「代理地址」
 * 填成 `/llm`，请求就会走到这里再转发出去。
 *
 * 目标地址来自环境变量 VITE_LLM_ORIGIN（放在 .env.local，不入库），
 * 例如： VITE_LLM_ORIGIN=https://api.openai.com
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const llmOrigin = env['VITE_LLM_ORIGIN'] || 'https://api.openai.com'
  const hfOrigin = env['VITE_HF_ORIGIN'] || 'https://hf-mirror.com'

  /**
   * `npm run dev:lan` 专用：自签证书 + 监听 0.0.0.0，好让手机能连过来联调扫码同步。
   *
   * 为什么非要 https：摄像头（getUserMedia）和 WebRTC 都只在**安全上下文**里可用，
   * 而手机访问 http://192.168.x.x:5173 不算 —— localhost 才算，那只对开发机自己成立。
   * 手机上会表现为「点了扫码毫无反应」，且控制台在手机上还不好看。
   *
   * 刻意只在 lan 模式挂：默认的 npm run dev 一点都不受影响，也不会天天弹证书警告。
   * 手机首次访问要点一次「继续前往（不安全）」，自签证书就这样。
   */
  const lanPlugins = mode === 'lan' ? [basicSsl()] : []

  return {
    plugins: [vue(), vueDevTools(), dropUnusedOrtAsyncifyWasm(), comfyuiRelay(), ...lanPlugins],
    // esnext 是唯一的非协商项：transformers.js v4 用了顶层 await。
    // 官方所有 embedding 示例的 vite.config 也就只有这一行。
    build: { target: 'esnext' },
    // 嵌入管线跑在 Worker 里（见 services/vector/embedder.worker.ts 的说明）
    worker: { format: 'es' },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      proxy: {
        '/llm': {
          target: llmOrigin,
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/llm/, ''),
        },
        /**
         * 本地模型下载代理：绕开镜像站缺失的 CORS 头。
         *
         * transformers.js 在浏览器里逐文件 fetch 权重（嵌入模型 / 深度模型都走它），
         * 默认下载源 hf-mirror.com **不返回 Access-Control-Allow-Origin**，于是
         * localhost:5173 直连被 CORS 拦死（huggingface.co 反而带 CORS，只是国内基本
         * 连不上才要用镜像）。让下载走同源的 /hf、由 vite 在服务端转发到镜像，跨源那一
         * 跳就发生在浏览器看不见的地方。
         *
         * 与之配对的是 services/ml/downloadHost.ts：开发期它把 hf-mirror 下载源改写成
         * `location.origin + /hf/`，正好落到这条代理上。目标可用 VITE_HF_ORIGIN 覆盖。
         *
         * followRedirects：镜像对大权重文件可能 302 到别处，让代理在服务端跟完重定向，
         * 浏览器始终只见同源响应，不会又被甩回一个跨源 URL 触发 CORS。
         */
        '/hf': {
          target: hfOrigin,
          changeOrigin: true,
          followRedirects: true,
          /**
           * ⚠️ **必须覆盖 Referer/Origin，否则这条代理形同虚设**。
           *
           * hf-mirror 有**防盗链**：带着外站 Referer 请求权重，它不返回文件，而是回一个
           * 「警告：未授权访问」的 HTML 页 —— 且状态码是 **200**。浏览器 fetch 一律带
           * Referer，curl 默认不带 —— 所以命令行测一切正常、页面里必炸，两边对不上，
           * 这条极难靠猜想复现（是 curl 逐个加 -H 二分头部才抓到的）。
           *
           * 而 transformers.js 写缓存只认状态码（见 services/ml/tfEnv.ts 的 guardHtml），
           * 于是这页 HTML 会被当成权重存进 Cache Storage，此后缓存命中短路网络，
           * 报错永远是 `Unexpected token '<', "<!DOCTYPE "`，且修好代理也不会自行恢复。
           *
           * ⚠️ 只能用 headers 覆盖，**不能**在 configure 里 proxyReq.removeHeader()：
           * followRedirects 下 proxyReq 是 follow-redirects 的 RedirectableRequest，
           * 事件触发时请求头**已经发出**，removeHeader 抛 ERR_HTTP_HEADERS_SENT —— 且是在
           * 事件回调里抛，**整个 dev server 当场崩掉**（实测踩过，不是推断）。
           *
           * 伪装成镜像站自引用：同站 Referer 天然通过防盗链，比留空更稳。
           */
          headers: { referer: hfOrigin + '/', origin: hfOrigin },
          rewrite: (p: string) => p.replace(/^\/hf/, ''),
        },
        /**
         * 扫码同步的信令服务器（默认 ws://149.30.222.97/ws，那台机器上由
         * nginx 把 /ws 反代到本地跑的 signal-server.js）。
         *
         * 这条代理**不只是图方便，是必需的**：信令服务器只有 http，没有 TLS；
         * 而 npm run dev:lan 为了让手机能用摄像头必须走 https，https 页面又
         * 禁止打开 ws:// 连接（混合内容，浏览器直接拦死）。让客户端连同源的
         * `wss://<vite>/ws`、由 vite 在服务端再转成 ws://，不安全的那一跳就
         * 发生在浏览器看不见的地方，两个要求才能同时满足。
         *
         * 目标可用 VITE_SIGNAL_TARGET 覆盖（比如改回本机的 ws://127.0.0.1:8080）。
         */
        '/ws': {
          target: env['VITE_SIGNAL_TARGET'] || 'ws://149.30.222.97',
          ws: true,
          changeOrigin: true,
          // 信令服务器不看路径（任何路径都 upgrade），所以不做 rewrite
        },
      },
    },
  }
})
