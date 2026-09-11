import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

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

  return {
    plugins: [vue(), vueDevTools()],
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
