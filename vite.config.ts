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
