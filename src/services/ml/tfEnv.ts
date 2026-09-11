/**
 * transformers.js 的环境配置，**嵌入 Worker 与深度 Worker 共用**。
 *
 * 抽出来不是为了省那十几行代码，是为了别让下面这段教训存在两份然后各自漂移。
 *
 * ⚠️ 只能在 Worker 里 import 这个模块。它会把 transformers（约 1MB）拉进依赖图，
 * 主线程碰一下就毁掉「不开就零字节」的承诺。**类型 import 安全（会被擦除），值 import 不安全。**
 */

import wasmPaths from '../vector/wasm'

export type Tf = typeof import('@huggingface/transformers')

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
export async function setupTf(mode: 'cache' | 'download'): Promise<Tf> {
  const tf = await import('@huggingface/transformers')
  const env = tf.env

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
