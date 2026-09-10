<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { listModels, chatOnce } from '@/services/provider/openaiCompatible'
import { ProviderError } from '@/types/provider'

const settings = useSettingsStore()
const toast = useToast()

/** 模板里要显示字面的 {{user}}，不能直接写 —— Vue 会在内层 }} 提前闭合插值 */
const USER_MACRO = '{{user}}'

const apiKey = ref('')
const showKey = ref(false)
const testing = ref(false)
const models = ref<string[]>([])
const loadingModels = ref(false)

onMounted(async () => {
  if (!settings.loaded) await settings.load()
  apiKey.value = await settings.getApiKey()
})

async function saveKey() {
  await settings.setApiKey(apiKey.value.trim())
  toast.success('API Key 已保存到本机')
}

async function cfg() {
  const p = settings.settings.provider
  const c: { baseUrl: string; apiKey?: string; proxyPrefix?: string } = { baseUrl: p.baseUrl }
  const k = await settings.getApiKey()
  if (k) c.apiKey = k
  if (p.proxyPrefix) c.proxyPrefix = p.proxyPrefix
  return c
}

async function fetchModels() {
  loadingModels.value = true
  try {
    const list = await listModels(await cfg())
    models.value = list.map((m) => m.id)
    toast.success(`拉到 ${list.length} 个模型`)
  } catch (e) {
    toast.error(e instanceof ProviderError ? e.message : String(e))
  } finally {
    loadingModels.value = false
  }
}

async function testConnection() {
  const p = settings.settings.provider
  if (!p.baseUrl || !p.model) {
    toast.error('请先填写 baseURL 与模型名')
    return
  }
  testing.value = true
  try {
    const out = await chatOnce(await cfg(), {
      model: p.model,
      messages: [{ role: 'user', content: '说"连接成功"四个字' }],
      stream: false,
      maxTokens: 32,
    })
    toast.success(`连接成功：${out.slice(0, 40)}`)
  } catch (e) {
    toast.error(e instanceof ProviderError ? e.message : String(e))
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <AppTopbar title="设置" />
  <div class="cbx-scroll body">
    <div class="wrap">
      <!-- ① 模型服务 -->
      <section class="cbx-card sec">
        <h3>模型服务</h3>
        <p class="note">
          任何 OpenAI 兼容接口均可。浏览器直连会受 CORS 限制：DeepSeek、硅基流动等允许跨域； OpenAI
          官方、Ollama 等需填写代理地址（开发期可填 <code>/llm</code>）。
        </p>

        <label class="cbx-field">
          <span class="cbx-field__label">baseURL</span>
          <input
            v-model="settings.settings.provider.baseUrl"
            class="cbx-input"
            placeholder="https://api.deepseek.com/v1"
            @change="settings.touch()"
          />
        </label>

        <label class="cbx-field">
          <span class="cbx-field__label">API Key</span>
          <div class="rowline">
            <input
              v-model="apiKey"
              class="cbx-input"
              :type="showKey ? 'text' : 'password'"
              placeholder="sk-..."
              @blur="saveKey"
            />
            <button class="cbx-icon-btn" @click="showKey = !showKey">
              {{ showKey ? '🙈' : '👁' }}
            </button>
          </div>
          <span class="cbx-field__hint">仅保存在本机 IndexedDB，不会随配置导出</span>
        </label>

        <label class="cbx-field">
          <span class="cbx-field__label">模型</span>
          <div class="rowline">
            <input
              v-model="settings.settings.provider.model"
              class="cbx-input"
              placeholder="deepseek-chat"
              list="model-list"
              @change="settings.touch()"
            />
            <button class="cbx-btn cbx-btn--ghost" :disabled="loadingModels" @click="fetchModels">
              {{ loadingModels ? '拉取中…' : '拉取列表' }}
            </button>
          </div>
          <datalist id="model-list">
            <option v-for="m in models" :key="m" :value="m" />
          </datalist>
        </label>

        <label class="cbx-field">
          <span class="cbx-field__label">代理地址（可选）</span>
          <input
            v-model="settings.settings.provider.proxyPrefix"
            class="cbx-input"
            placeholder="留空 = 直连；开发期可填 /llm"
            @change="settings.touch()"
          />
          <span class="cbx-field__hint">
            填 <code>/llm</code> 会走 vite.config.ts 的 dev proxy，目标由 .env.local 的
            VITE_LLM_ORIGIN 决定
          </span>
        </label>

        <div class="grid2">
          <label class="cbx-field">
            <span class="cbx-field__label">温度 {{ settings.settings.provider.temperature }}</span>
            <input
              v-model.number="settings.settings.provider.temperature"
              class="cbx-input"
              type="number"
              step="0.1"
              min="0"
              max="2"
              @change="settings.touch()"
            />
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">最大回复 token</span>
            <input
              v-model.number="settings.settings.provider.maxTokens"
              class="cbx-input"
              type="number"
              @change="settings.touch()"
            />
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">上下文窗口</span>
            <input
              v-model.number="settings.settings.provider.contextWindow"
              class="cbx-input"
              type="number"
              @change="settings.touch()"
            />
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">流式输出</span>
            <label class="cbx-switch">
              <input
                v-model="settings.settings.provider.stream"
                type="checkbox"
                @change="settings.touch()"
              />
              <span class="cbx-switch__track" />
            </label>
          </label>
        </div>

        <button class="cbx-btn cbx-btn--primary" :disabled="testing" @click="testConnection">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
      </section>

      <!-- ② 提示词与深度（需求 4） -->
      <section class="cbx-card sec">
        <h3>提示词与插入深度</h3>
        <p class="note">
          <strong>深度语义</strong>：depth N = 注入之后仍有 N 条真实消息；
          <strong>depth 0 = 追加到历史最末，作为独立的一条消息</strong
          >（离模型生成最近，约束力最强）。
        </p>

        <label class="cbx-field">
          <span class="cbx-field__label">主系统提示词</span>
          <textarea
            v-model="settings.settings.prompt.mainPrompt"
            class="cbx-textarea"
            rows="3"
            @change="settings.touch()"
          />
        </label>

        <div v-for="mode in ['solo', 'group'] as const" :key="mode" class="cbx-collapse cons">
          <div class="cbx-collapse__head">
            {{ mode === 'solo' ? '1v1 约束提示词' : '1vN 约束提示词' }}
            <label class="cbx-switch">
              <input
                v-model="settings.settings.constraint[mode].enabled"
                type="checkbox"
                @change="settings.touch()"
              />
              <span class="cbx-switch__track" />
            </label>
          </div>
          <div class="cbx-collapse__body">
            <textarea
              v-model="settings.settings.constraint[mode].text"
              class="cbx-textarea"
              rows="4"
              @change="settings.touch()"
            />
            <div class="grid2 mt">
              <label class="cbx-field">
                <span class="cbx-field__label">插入深度</span>
                <input
                  v-model.number="settings.settings.constraint[mode].depth"
                  class="cbx-input"
                  type="number"
                  min="0"
                  @change="settings.touch()"
                />
              </label>
              <label class="cbx-field">
                <span class="cbx-field__label">角色</span>
                <select
                  v-model.number="settings.settings.constraint[mode].role"
                  class="cbx-input"
                  @change="settings.touch()"
                >
                  <option :value="0">system</option>
                  <option :value="1">user</option>
                  <option :value="2">assistant</option>
                </select>
              </label>
            </div>
          </div>
        </div>
      </section>

      <!-- ③ 用户身份 -->
      <section class="cbx-card sec">
        <h3>用户身份</h3>
        <label class="cbx-field">
          <span class="cbx-field__label">你的名字（即 {{ USER_MACRO }} 的值）</span>
          <input
            v-model="settings.settings.persona.name"
            class="cbx-input"
            @change="settings.touch()"
          />
        </label>
        <label class="cbx-field">
          <span class="cbx-field__label">人设描述</span>
          <textarea
            v-model="settings.settings.persona.description"
            class="cbx-textarea"
            rows="3"
            @change="settings.touch()"
          />
        </label>
      </section>

      <!-- ④ 外观 -->
      <section class="cbx-card sec">
        <h3>外观与聊天</h3>
        <label class="cbx-field">
          <span class="cbx-field__label">回车发送（移动端始终换行）</span>
          <label class="cbx-switch">
            <input
              v-model="settings.settings.chat.sendOnEnter"
              type="checkbox"
              @change="settings.touch()"
            />
            <span class="cbx-switch__track" />
          </label>
        </label>
        <label class="cbx-field">
          <span class="cbx-field__label">顶栏显示 token 计数</span>
          <label class="cbx-switch">
            <input
              v-model="settings.settings.chat.showTokens"
              type="checkbox"
              @change="settings.touch()"
            />
            <span class="cbx-switch__track" />
          </label>
        </label>
      </section>
    </div>
  </div>
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
.wrap {
  max-width: var(--cbx-read-w);
  margin: 0 auto;
}
.sec {
  margin-bottom: var(--cbx-space-4);
}
.sec h3 {
  margin-bottom: var(--cbx-space-3);
}
.note {
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  margin-bottom: var(--cbx-space-4);
  line-height: 1.6;
}
.note code {
  font-family: var(--cbx-font-mono);
  font-size: 0.9em;
  padding: 1px 4px;
  border-radius: var(--cbx-radius-sm);
  background: var(--cbx-code-bg);
}
.rowline {
  display: flex;
  gap: var(--cbx-space-2);
  align-items: center;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--cbx-space-3);
}
.mt {
  margin-top: var(--cbx-space-3);
}
.cons {
  margin-top: var(--cbx-space-4);
}
.cons .cbx-collapse__head {
  cursor: default;
}

@media (max-width: 767px) {
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
  .grid2 {
    grid-template-columns: 1fr;
  }
}
</style>
