/**
 * transformers.js 模型下载源（remoteHost）。
 *
 * transformers.js 把每个权重文件的下载 URL 拼成 `remoteHost + {model}/resolve/{revision}/...`，
 * 默认 remoteHost 是 `https://huggingface.co/`。国内直连 HF 基本下不动，这里默认改指 hf-mirror。
 *
 * ⚠️ **hf-mirror.com 不返回 CORS 头**（huggingface.co 反而带 `Access-Control-Allow-Origin: *`，
 *  只是国内连不上才要用镜像）。浏览器从 localhost 直连镜像会被 CORS 拦死，报错形如
 *  `No 'Access-Control-Allow-Origin' header is present`。解法与 provider 的 /llm 同构：
 *  **开发期让下载走同源的 vite 代理 `/hf`**（见 vite.config.ts），跨源那一跳发生在服务端。
 *  这个改写在 getRemoteHost() 里做，对上层透明——设置里存的仍是镜像地址，无需改预设或迁移。
 *  生产期没有该代理：**安卓 / 桌面 App（Tauri）里改由主线程经 plugin-http 代发**（见 fetchRelay.ts，
 *  Rust reqwest 没有 CORS、也不带触发防盗链的 Referer）；纯 Web 部署仍需自备可跨源的下载源或反代。
 *
 * ⚠️ 为什么用「主线程模块 + 随消息下发」而不是让 Worker 直接读设置：
 *  - Worker 是独立 bundle，import 这个模块会拿到**另一份**实例，读不到主线程设过的值；
 *  - 而 host.ts / manager.ts / depth/generate.ts 都在主线程、与 pinia 同一 bundle，
 *    由它们读 getRemoteHost() 塞进 worker 消息，Worker 再 setupTf(host) 写 env.remoteHost。
 *  - getRemoteHost() 因此总在主线程执行，才能安全读 location.origin 做上面的代理改写。
 *
 * ⚠️ transformers.js 的浏览器缓存键 = 下载 URL（含 host）。所以**切换下载源会让已下载的模型
 *  按新 host 的键去查而查不到 → 显示未下载、需重新下载**。下载/查缓存/推理三处必须用同一个
 *  host，否则「下载用镜像、推理用 HF」会永远判定成没下载。设置页已就此给出提示。
 *  代理改写同理成为缓存键的一部分：开发期键含 `localhost:<port>/hf`，换端口或换到生产会各自
 *  重下，属预期。
 *
 * 纯 service：不 import vue/pinia，可被 Worker 宿主安全引用。
 */

/** 预置下载源。值即 transformers.js 的 remoteHost（务必带结尾斜杠）。 */
export const DOWNLOAD_HOST_PRESETS = Object.freeze([
  { host: 'https://hf-mirror.com/', label: 'hf-mirror.com（国内镜像，推荐）' },
  { host: 'https://huggingface.co/', label: 'huggingface.co（官方，需可直连）' },
])

export const DEFAULT_REMOTE_HOST = 'https://hf-mirror.com/'

/** 与 vite.config.ts 的 `/hf` 代理配对：开发期把镜像下载改走同源，绕开镜像缺失的 CORS 头。 */
const DEV_PROXY_PREFIX = '/hf/'

let remoteHost = DEFAULT_REMOTE_HOST

/** 规范化成「非空 + 结尾带斜杠」；空值回落默认镜像。 */
export function normalizeHost(h: string | undefined | null): string {
  const v = (h ?? '').trim()
  if (!v) return DEFAULT_REMOTE_HOST
  return v.endsWith('/') ? v : v + '/'
}

/**
 * 当前下载源，**已解析成可直接 fetch 的绝对地址**。
 * host.ts / manager.ts / depth 在发 worker 消息时读它。
 *
 * 开发期镜像会被改写成同源代理地址（见文件头说明与 resolveHost）；其余情况原样返回。
 */
export function getRemoteHost(): string {
  return resolveHost(remoteHost)
}

/**
 * 开发期把 hf-mirror 下载源改写成同源代理地址（`location.origin + /hf/`），交给
 * vite.config.ts 的 `/hf` 反代转发到镜像，绕开镜像缺失的 CORS 头。
 *
 * ⚠️ 为什么必须补成**绝对**地址、而不是直接返回 `/hf/`：transformers.js 查文件元数据的
 *  fetch_file_head 会先用 `new URL(str)`（isValidUrl）校验 URL，相对路径拿不到 base 会被判非法、
 *  直接返回 null → 明明能下的文件被当成「不存在」。补上 location.origin 才是合法的同源绝对地址。
 *
 * 只改写「正好等于默认镜像」的地址：huggingface.co 自带 CORS 无需代理；自填的其它源也不动
 * （代理只有镜像这一个上游）。生产期没有 `/hf` 代理，保持镜像直连。
 */
function resolveHost(h: string): string {
  if (import.meta.env.DEV && h === DEFAULT_REMOTE_HOST && typeof location !== 'undefined') {
    return location.origin + DEV_PROXY_PREFIX
  }
  return h
}

/** 由 settings store 在加载/变更时写入。 */
export function setRemoteHost(h: string | undefined | null): void {
  remoteHost = normalizeHost(h)
}
