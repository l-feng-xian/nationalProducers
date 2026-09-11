import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import basicSsl from '@vitejs/plugin-basic-ssl'

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
        console.log(`[ort] 已剔除未使用的 asyncify wasm ${mb(droppedBytes)}；保留 ${kept.join('、')}`)
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
    plugins: [vue(), vueDevTools(), dropUnusedOrtAsyncifyWasm(), ...lanPlugins],
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
      },
    },
  }
})
