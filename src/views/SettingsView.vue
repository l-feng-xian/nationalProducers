<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import DepthPreview from '@/components/settings/DepthPreview.vue'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { listModels, chatOnce } from '@/services/provider/openaiCompatible'
import { ProviderError } from '@/types/provider'
import { exportAll, importAll, storageEstimate, formatBytes } from '@/services/io/backup'
import { downloadBlob, safeFileName } from '@/utils/download'
import { APP_NAME } from '@/constants/app'

const settings = useSettingsStore()
const toast = useToast()

/** 模板里要显示字面的 {{user}}，不能直接写 —— Vue 会在内层 }} 提前闭合插值 */
const USER_MACRO = '{{user}}'

const wi = computed(() => settings.settings.worldInfo)
const budgetTokens = computed(() => {
  const cap = wi.value.world_info_budget_cap
  const raw = Math.round(
    (wi.value.world_info_budget * settings.settings.provider.contextWindow) / 100,
  )
  return cap > 0 ? Math.min(raw, cap) : raw
})

const usage = ref<{ usage: number; quota: number } | null>(null)
const backupInput = ref<HTMLInputElement | null>(null)

async function doExport() {
  const blob = await exportAll()
  // 文件名跟着应用名走；备份**内部**的 format 标识不会变（见 backup.ts 的说明）
  downloadBlob(
    blob,
    safeFileName(`${APP_NAME}备份-${new Date().toISOString().slice(0, 10)}`, 'json'),
  )
  toast.success('已导出（不含 API Key）')
}

async function doImport(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const r = await importAll(await file.text())
    toast.success(
      `导入完成：角色 ${r.characters} · 世界书 ${r.worldbooks} · 会话 ${r.chats} · 消息 ${r.messages}`,
    )
    // 内存里的 store 已与库不一致，直接重载最省事
    setTimeout(() => location.reload(), 800)
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  }
  ;(e.target as HTMLInputElement).value = ''
}

function openBackup() {
  backupInput.value?.click()
}

const apiKey = ref('')
const showKey = ref(false)
const testing = ref(false)
const models = ref<string[]>([])
const loadingModels = ref(false)

onMounted(async () => {
  if (!settings.loaded) await settings.load()
  apiKey.value = await settings.getApiKey()
  usage.value = await storageEstimate()
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
    if (list.length) {
      // 拉完直接展开全部，省得用户还要再点一下才知道拉到了什么
      typing.value = false
      pickerOpen.value = true
      toast.success(`拉到 ${list.length} 个模型`)
    } else {
      toast.warning('接口没有返回任何模型')
    }
  } catch (e) {
    toast.error(e instanceof ProviderError ? e.message : String(e))
  } finally {
    loadingModels.value = false
  }
}

// ── 模型下拉 ──
const pickerOpen = ref(false)
const pickerEl = ref<HTMLElement | null>(null)

/**
 * 只在用户**正在输入**时才按文本筛选。
 * 点 ▾ 展开时一律显示全部 —— 否则选定某个模型后再点开，
 * 就只剩它自己一条，反而没法换成别的。
 */
const typing = ref(false)

const filteredModels = computed(() => {
  if (!typing.value) return models.value
  const q = settings.settings.provider.model.trim().toLowerCase()
  if (!q) return models.value
  return models.value.filter((m) => m.toLowerCase().includes(q))
})

function togglePicker() {
  typing.value = false
  pickerOpen.value = !pickerOpen.value
}
function onModelFocus() {
  if (models.value.length) pickerOpen.value = true
}
function onModelInput() {
  typing.value = true
  if (models.value.length) pickerOpen.value = true
}
function pickModel(m: string) {
  settings.settings.provider.model = m
  typing.value = false
  pickerOpen.value = false
  settings.touch()
}
/** 放弃筛选，显示全部候选 */
function clearModelFilter() {
  typing.value = false
}

function onDocPointerDown(e: PointerEvent) {
  if (!pickerOpen.value) return
  const el = pickerEl.value
  if (el && !el.contains(e.target as Node)) pickerOpen.value = false
}
function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') pickerOpen.value = false
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown)
  document.addEventListener('keydown', onDocKeydown)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  document.removeEventListener('keydown', onDocKeydown)
})

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
    <div class="cbx-form-col">
      <!-- ① 模型服务 -->
      <section class="cbx-card sec">
        <h3>模型服务</h3>
        <p class="note">
          任何 OpenAI 兼容接口均可。浏览器直连会受 CORS 限制：DeepSeek、硅基流动等允许跨域； OpenAI
          官方、Ollama 等需填写代理地址（开发期可填 <code>/llm</code>）。
        </p>

        <label class="cbx-field cbx-field--lg">
          <span class="cbx-field__label">baseURL</span>
          <input
            v-model="settings.settings.provider.baseUrl"
            class="cbx-input"
            placeholder="https://api.deepseek.com/v1"
            @change="settings.touch()"
          />
        </label>

        <label class="cbx-field cbx-field--lg">
          <span class="cbx-field__label">API Key</span>
          <!-- .cbx-ctl（不是 .rowline）：输入框 + 图标按钮作为一个整体受档位约束 -->
          <div class="cbx-ctl">
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

        <div class="cbx-field">
          <span class="cbx-field__label">模型</span>
          <div class="rowline">
            <!--
              这里刻意不用 <datalist>：浏览器会拿输入框现值去过滤候选，
              现值与拉回来的模型名不匹配时下拉就一片空白，且没有可见的下拉入口。
            -->
            <div ref="pickerEl" class="picker">
              <input
                v-model="settings.settings.provider.model"
                class="cbx-input"
                placeholder="deepseek-chat"
                @change="settings.touch()"
                @focus="onModelFocus"
                @input="onModelInput"
              />
              <button
                v-if="models.length"
                class="picker__toggle"
                type="button"
                :title="`共 ${models.length} 个模型`"
                @click="togglePicker"
              >
                ▾
              </button>

              <div v-if="pickerOpen" class="picker__panel cbx-scroll">
                <div v-if="!filteredModels.length" class="picker__empty">
                  没有匹配「{{ settings.settings.provider.model }}」的模型
                  <button class="cbx-btn cbx-btn--ghost xs" type="button" @click="clearModelFilter">
                    显示全部 {{ models.length }} 个
                  </button>
                </div>
                <button
                  v-for="m in filteredModels"
                  :key="m"
                  class="picker__item"
                  type="button"
                  :class="{ 'picker__item--on': m === settings.settings.provider.model }"
                  @click="pickModel(m)"
                >
                  {{ m }}
                </button>
              </div>
            </div>

            <button class="cbx-btn cbx-btn--ghost" :disabled="loadingModels" @click="fetchModels">
              {{ loadingModels ? '拉取中…' : '拉取列表' }}
            </button>
          </div>
          <span v-if="models.length" class="cbx-field__hint">
            已拉到 {{ models.length }} 个模型，点输入框右侧 ▾ 选择；也可以直接手输。
          </span>
        </div>

        <label class="cbx-field cbx-field--lg">
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
        </div>

        <!-- 布尔值不占网格轨道；同时这里是单层 <label>，
             修掉了原来 label 套 label 的非法结构 -->
        <div class="switchrow">
          <label class="cbx-switch swopt">
            <input
              v-model="settings.settings.provider.stream"
              type="checkbox"
              @change="settings.touch()"
            />
            <span class="cbx-switch__track" />
            <span>流式输出</span>
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
            <!-- 深度可视化是「图示」不是控件：移出 <label> 后不再误触发聚焦，
                 也不再把左格撑高、让右格下半空一片 -->
            <DepthPreview class="depth-preview" :depth="settings.settings.constraint[mode].depth" />
          </div>
        </div>
      </section>

      <!-- ③ 用户身份 -->
      <section class="cbx-card sec">
        <h3>用户身份</h3>
        <label class="cbx-field cbx-field--sm">
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

      <!-- ④ 世界书全局参数 -->
      <section class="cbx-card sec">
        <h3>世界书</h3>
        <p class="note">
          这些是**全局**扫描参数，对所有世界书生效；单条条目里留「继承全局」的字段就用这里的值。
          具体哪几本书全局启用，在「世界书」页面用书名右侧的徽标切换。
        </p>
        <div class="grid2">
          <label class="cbx-field">
            <span class="cbx-field__label">扫描深度（往回看几条消息）</span>
            <input
              v-model.number="wi.world_info_depth"
              class="cbx-input"
              type="number"
              min="0"
              @change="settings.touch()"
            />
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">预算（占上下文 %）</span>
            <input
              v-model.number="wi.world_info_budget"
              class="cbx-input"
              type="number"
              min="1"
              max="100"
              @change="settings.touch()"
            />
            <span class="cbx-field__hint">约 {{ budgetTokens }} tok</span>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">预算硬上限（0 = 不限）</span>
            <input
              v-model.number="wi.world_info_budget_cap"
              class="cbx-input"
              type="number"
              min="0"
              @change="settings.touch()"
            />
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">插入策略</span>
            <select
              v-model.number="wi.world_info_character_strategy"
              class="cbx-input"
              @change="settings.touch()"
            >
              <option :value="0">均匀混排</option>
              <option :value="1">角色书优先</option>
              <option :value="2">全局书优先</option>
            </select>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">最少激活条数（0 = 不强制）</span>
            <input
              v-model.number="wi.world_info_min_activations"
              class="cbx-input"
              type="number"
              min="0"
              @change="settings.touch()"
            />
            <span class="cbx-field__hint">不足时自动扩大扫描窗口</span>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">最大递归轮数（0 = 不限）</span>
            <input
              v-model.number="wi.world_info_max_recursion_steps"
              class="cbx-input"
              type="number"
              min="0"
              @change="settings.touch()"
            />
          </label>
        </div>

        <div class="switches">
          <label class="sw">
            <input v-model="wi.world_info_recursive" type="checkbox" @change="settings.touch()" />
            <span>递归激活（条目内容可再触发别的条目）</span>
          </label>
          <label class="sw">
            <input
              v-model="wi.world_info_include_names"
              type="checkbox"
              @change="settings.touch()"
            />
            <span>扫描时带上发言者名字</span>
          </label>
          <label class="sw">
            <input
              v-model="wi.world_info_case_sensitive"
              type="checkbox"
              @change="settings.touch()"
            />
            <span>区分大小写</span>
          </label>
          <label class="sw">
            <input
              v-model="wi.world_info_match_whole_words"
              type="checkbox"
              @change="settings.touch()"
            />
            <span>整词匹配</span>
          </label>
          <label class="sw">
            <input
              v-model="wi.world_info_use_group_scoring"
              type="checkbox"
              @change="settings.touch()"
            />
            <span>包含组内按命中数评分</span>
          </label>
        </div>
      </section>

      <!-- ⑤ 外观 -->
      <section class="cbx-card sec">
        <h3>外观与聊天</h3>
        <div class="switchrow">
          <label class="cbx-switch swopt">
            <input
              v-model="settings.settings.chat.sendOnEnter"
              type="checkbox"
              @change="settings.touch()"
            />
            <span class="cbx-switch__track" />
            <span>回车发送（移动端始终换行）</span>
          </label>
          <label class="cbx-switch swopt">
            <input
              v-model="settings.settings.chat.showTokens"
              type="checkbox"
              @change="settings.touch()"
            />
            <span class="cbx-switch__track" />
            <span>顶栏显示 token 计数</span>
          </label>
        </div>
      </section>

      <!-- ⑥ 数据 -->
      <section class="cbx-card sec">
        <h3>数据</h3>
        <p v-if="usage" class="note">
          已占用 {{ formatBytes(usage.usage) }} / 可用约 {{ formatBytes(usage.quota) }}
        </p>
        <p class="note">
          所有数据都存在这台设备的浏览器里。清除站点数据或换浏览器都会丢，重要内容请导出备份。
          <strong>备份不含 API Key</strong>，可以放心分享。
        </p>
        <div class="rowline">
          <button class="cbx-btn cbx-btn--ghost" @click="doExport">导出全部数据</button>
          <button class="cbx-btn cbx-btn--ghost" @click="openBackup">导入备份</button>
          <input ref="backupInput" type="file" accept=".json" hidden @change="doImport" />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
/* 原 .wrap 规则已整条删除：宽度/对齐/字段上限统一由 base.css 的
   .cbx-form-col 提供（max-width: var(--cbx-form-w) + 左对齐）。
   关键一步是去掉 margin: 0 auto —— 居中时卡片左缘 506 与 AppTopbar
   标题左缘 260 差 246px；左对齐后两者都等于 240(sidebar) + 20(.body padding) = 260。
   移动端两边同为 space-3(12px)，同样严格对齐。 */
.sec {
  margin-bottom: var(--cbx-space-4);
}
.sec h3 {
  margin-bottom: var(--cbx-space-3);
}
.note {
  /* 说明性散文是全页唯一真正需要「阅读宽」的内容 —— 卡片加宽到 1280 后
     必须显式封顶，否则 1238px 的行长完全不可读。 */
  max-width: var(--cbx-read-w);
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
.switches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-3) var(--cbx-space-5);
  margin-top: var(--cbx-space-3);
}
.sw {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  cursor: pointer;
}
/* 模型名属于中等长度字段。档位下放到 .picker 本身而不是 .cbx-field：
   同一行还有「拉取列表」按钮，标在字段上会把按钮一起收窄。 */
.picker {
  position: relative;
  flex: 1;
  min-width: 0;
  max-width: var(--cbx-fieldw-md);
}
.picker__toggle {
  position: absolute;
  right: 1px;
  top: 1px;
  bottom: 1px;
  width: 32px;
  border: none;
  background: transparent;
  color: var(--cbx-text-tertiary);
  cursor: pointer;
  border-radius: 0 var(--cbx-radius-md) var(--cbx-radius-md) 0;
}
.picker__toggle:hover {
  background: var(--cbx-bg-hover);
  color: var(--cbx-text);
}
.picker input {
  padding-right: 36px;
}
/* 输入框收窄到 400 了，候选面板不能跟着收窄（模型 ID 很长且是 mono 字体）：
   以输入框左缘为基准按内容向右生长，lg 封顶。
   .cbx-card 无 overflow:hidden，面板右缘 ≈900 < 卡片右缘 1540，不会溢出；
   100vw 那一项是移动端兜底。 */
.picker__panel {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  left: 0;
  right: auto;
  min-width: 100%;
  width: max-content;
  max-width: min(var(--cbx-fieldw-lg), calc(100vw - 2 * var(--cbx-space-5)));
  max-height: 260px;
  padding: var(--cbx-space-1);
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  box-shadow: var(--cbx-shadow-md);
}
.picker__item {
  display: block;
  width: 100%;
  min-height: 34px;
  padding: var(--cbx-space-2) var(--cbx-space-3);
  border: none;
  background: none;
  font-family: var(--cbx-font-mono);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text);
  text-align: left;
  border-radius: var(--cbx-radius-sm);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.picker__item:hover {
  background: var(--cbx-bg-hover);
}
.picker__item--on {
  background: var(--cbx-brand-light);
  color: var(--cbx-brand);
  font-weight: var(--cbx-fw-medium);
}
.picker__empty {
  padding: var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  text-align: center;
}
.xs {
  height: 28px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
  margin-top: var(--cbx-space-2);
}
.rowline {
  display: flex;
  gap: var(--cbx-space-2);
  align-items: center;
}
/* 字段收窄之后，多出来的横向空间要变成「更多列 / 更少行」，
   否则只是把空白从卡片外挪进卡片内。
   ⚠ 用 auto-fill 不用 auto-fit：auto-fit 会折叠空轨道，让只有 2 个字段的
     网格把两格各拉到约 400px。
   260px 下限按最长 label「扫描深度（往回看几条消息）」量的，保证不换行。 */
.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--cbx-space-3);
}
/* 开关行：布尔值的「内容宽度」就是 40×22 的 track + 一行字 */
.switchrow {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-3) var(--cbx-space-6);
  margin-bottom: var(--cbx-space-4);
}
.switchrow:last-child {
  margin-bottom: 0;
}
/* 与 .cbx-switch 同挂一个 <label>：单层 label，点文字也能切换（HTML 合法）。
   <768px 时 base.css 的 .cbx-switch{min-height:44px} 会顶起整行。 */
.swopt {
  gap: var(--cbx-space-3);
  min-height: 36px;
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
  color: var(--cbx-text-secondary);
}
/* 深度可视化是「图示」不是控件，给它内容宽度上限，
   别让它在 1238px 的卡片里被拉成一条空条 */
.depth-preview {
  max-width: var(--cbx-fieldw-md);
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
  .picker__item {
    min-height: var(--cbx-tap-min);
  }
  .picker__toggle {
    /* 桌面留 1px 不盖住输入框边框；移动端优先保证 44px 触控区 */
    width: var(--cbx-tap-min);
    top: 0;
    bottom: 0;
  }
  .picker input {
    padding-right: calc(var(--cbx-tap-min) + 4px);
  }
  /* 页面级私有规则，base.css 的解除块管不到它：漏了这条手机上模型框卡在 400px */
  .picker {
    max-width: none;
  }
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
  .grid2 {
    /* auto-fill 在 317px 卡片里本就只有 1 列，这里显式声明是为了
       符合设计规范「内容多列网格在移动端降为单列」 */
    grid-template-columns: 1fr;
  }
  /* ⚠ 必须显式写：base.css 移动端块里的 .cbx-switch{min-height:44px} 是 (0,1,0)，
     压不过本文件 scoped 后变成 (0,2,0) 的 .swopt，会把开关按在 36px。
     桌面完全正常，只有手机上触控区不达标 —— 实测抓到的。 */
  .swopt {
    min-height: var(--cbx-tap-min);
  }
  /* 世界书那 5 个裸 checkbox 从来没被放大过（约 13px），补足 44px 触控区 */
  .sw {
    min-height: var(--cbx-tap-min);
  }
  .sw input[type='checkbox'] {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }
}
</style>
