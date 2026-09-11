/**
 * ORT 的 wasm 运行时路径。
 *
 * 用 `?url` 从 node_modules 里取，而不是把二进制复制进 public/，三个理由：
 *  - 版本**永远不会**和 transformers.js 引用的那个 ORT 漂移
 *    （JS 与 .wasm 必须来自同一 build，否则最小化函数名对不上，
 *     报 "no available backend found"）；
 *  - 没有二进制进 git；
 *  - Vite 会给它加 content-hash，可以永久缓存。
 *
 * 走**纯 CPU 版**而不是 asyncify / jsep：
 *  - transformers.js 的 Safari 分支本来就走它，是官方已验证路径；
 *  - 省 1.9MB 下载、约 10MB 编译、以及几十 MB 常驻内存；
 *  - 对 4 层的浅编码器，WebGPU 是净负债不是加速（没有自回归循环来摊薄
 *    dispatch / 上传回读 / shader 编译的固定开销）。
 */

// ⚠️ 路径不带 `dist/` —— onnxruntime-web 的 package.json exports 里为这两个文件
// 声明了专门的入口（`./ort-wasm-simd-threaded.wasm` / `.mjs`）。写成 `dist/...`
// 会被 exports 映射挡下，构建时才报错。
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'

/** 必须是同时含 wasm 与 mjs 两个键的对象，见 embedder.worker.ts 的说明 */
export default { wasm: wasmUrl, mjs: mjsUrl } as { wasm: string; mjs: string }
