<script setup lang="ts">
/**
 * 创建世界向导 —— 先把世界定下来，再生成地图。
 *
 * 为什么是**路由**而不是弹窗：四步表单加一张 canvas，在软键盘弹起时塞不进
 * `cbx-modal` 的 88vh；而且手机上的系统返回手势应该退出向导，而不是退出应用。
 *
 * 步骤是可点的分段控件而非强制线性流程 —— 每一步都有合理默认值，所以跳着填、
 * 直接点「创建」都必须能用。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import WorldPreview from '@/components/rpg/WorldPreview.vue'
import { useRpgStore } from '@/stores/rpg'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { emptyWorld, DEFAULT_GEN, RPG_WORLD_SIZE, type RpgWorld } from '@/types/rpg'

defineOptions({ name: 'RpgCreateView' })

const router = useRouter()
const rpg = useRpgStore()
const settings = useSettingsStore()
const toast = useToast()

const STEPS = [
  { key: 'basic', label: '基本' },
  { key: 'terrain', label: '地形' },
  { key: 'me', label: '我是谁' },
] as const
const step = ref<(typeof STEPS)[number]['key']>('basic')

/** 草稿就是一个完整的 RpgWorld —— 创建时原样落库，没有第二套形状要维护 */
const draft = ref<RpgWorld>(emptyWorld(crypto.randomUUID(), ''))
const busy = ref(false)

/**
 * 尺寸只给三档：192 与 288 都是 chunk(32) 与区域(24) 的公倍数；
 * 256 是历史默认值，它本身带一个不完整的末区域，属于既有行为，不去动它。
 * ⚠️ 尺寸创建后不可改 —— 噪声按 x/width 映射到环面，改尺寸等于换一个世界。
 */
const SIZES = [192, RPG_WORLD_SIZE, 288]

/** 地貌预设。直接写成 gen 的覆盖值，避免用户面对五个滑块无从下手 */
const PRESETS = [
  { key: 'balanced', label: '均衡', over: {} },
  { key: 'isles', label: '群岛', over: { seaLevel: 0.06, radius: 2.4 } },
  { key: 'forest', label: '林野', over: { moistureBias: 0.22 } },
  { key: 'arid', label: '荒原', over: { moistureBias: -0.22, villageChance: 0.4 } },
  { key: 'busy', label: '人烟稠密', over: { districtGate: -0.15, villageChance: 0.9 } },
] as const
const preset = ref<string>('balanced')

function applyPreset(key: string): void {
  const p = PRESETS.find((x) => x.key === key)
  if (!p) return
  preset.value = key
  draft.value.gen = { ...DEFAULT_GEN, ...p.over }
}

function reroll(): void {
  draft.value.seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1
}

/** 手填种子：非数字就忽略，别把 NaN 灌进采样器 */
function onSeedInput(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(v) && v >= 0) draft.value.seed = Math.floor(v)
}

const effectiveMe = computed(() => ({
  name: draft.value.persona.name.trim() || settings.settings.persona.name || '我',
}))

async function create(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const w = draft.value
    w.name = w.name.trim() || '新世界'
    const saved = await rpg.createFrom(w)
    await router.push(`/rpg/${saved.id}`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <AppTopbar title="新建世界">
      <template #actions>
        <button class="cbx-btn cbx-btn--ghost sm" @click="router.back()">取消</button>
        <button class="cbx-btn cbx-btn--primary sm" :disabled="busy" @click="create">创建</button>
      </template>
    </AppTopbar>

    <div class="steps">
      <button
        v-for="s in STEPS"
        :key="s.key"
        class="seg"
        :class="{ 'seg--on': step === s.key }"
        @click="step = s.key"
      >
        {{ s.label }}
      </button>
    </div>

    <div class="cbx-scroll body">
      <!-- 基本 -->
      <section v-show="step === 'basic'" class="sec">
        <label class="cbx-field">
          <span class="cbx-field__label">世界名</span>
          <input v-model="draft.name" class="cbx-input" placeholder="新世界" />
          <span class="cbx-field__hint">会出现在 NPC 会话标题里，也用于无卡 NPC 的兜底身份</span>
        </label>
        <label class="cbx-field">
          <span class="cbx-field__label">世界简介</span>
          <textarea
            v-model="draft.description"
            class="cbx-textarea"
            rows="4"
            placeholder="例：艾尔王国，战后第三年。魔法被教会垄断，边境村镇仍有游荡的残兵。"
          />
          <span class="cbx-field__hint">
            作为【场景】进入这个世界里每一段对话。它<b>不参与</b>地形生成 —— 地貌由下一步的旋钮决定
          </span>
        </label>
      </section>

      <!-- 地形 -->
      <section v-show="step === 'terrain'" class="sec">
        <div class="cbx-field">
          <span class="cbx-field__label">地貌预设</span>
          <div class="segs">
            <button
              v-for="p in PRESETS"
              :key="p.key"
              class="seg"
              :class="{ 'seg--on': preset === p.key }"
              @click="applyPreset(p.key)"
            >
              {{ p.label }}
            </button>
          </div>
        </div>

        <div class="cbx-field">
          <span class="cbx-field__label">种子</span>
          <div class="seedrow">
            <input
              class="cbx-input"
              type="number"
              min="0"
              :value="draft.seed"
              @input="onSeedInput"
            />
            <button class="cbx-btn cbx-btn--soft" @click="reroll">🎲 重掷</button>
          </div>
          <span class="cbx-field__hint">同一个种子必然长出同一个世界</span>
        </div>

        <div class="cbx-field">
          <span class="cbx-field__label">世界尺寸（创建后不可更改）</span>
          <div class="segs">
            <button
              v-for="s in SIZES"
              :key="s"
              class="seg"
              :class="{ 'seg--on': draft.width === s }"
              @click="((draft.width = s), (draft.height = s))"
            >
              {{ s }}²
            </button>
          </div>
        </div>

        <WorldPreview
          :seed="draft.seed"
          :width="draft.width"
          :height="draft.height"
          :gen="draft.gen"
        />

        <details class="adv">
          <summary>进阶：逐项微调</summary>
          <label class="cbx-field">
            <span class="cbx-field__label">海平面 {{ draft.gen.seaLevel.toFixed(2) }}</span>
            <input
              v-model.number="draft.gen.seaLevel"
              type="range"
              min="-0.3"
              max="0.25"
              step="0.01"
            />
            <span class="cbx-field__hint"
              >越高水越多。它同时是台阶的基准面，抬高会让陆地整体变平</span
            >
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">地貌尺度 {{ draft.gen.radius.toFixed(1) }}</span>
            <input v-model.number="draft.gen.radius" type="range" min="0.8" max="3.6" step="0.1" />
            <span class="cbx-field__hint">越大绕一圈经过的噪声越多，大陆碎成群岛</span>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">湿润度 {{ draft.gen.moistureBias.toFixed(2) }}</span>
            <input
              v-model.number="draft.gen.moistureBias"
              type="range"
              min="-0.4"
              max="0.4"
              step="0.02"
            />
            <span class="cbx-field__hint">&gt;0 更多森林，&lt;0 更多荒原与沙地</span>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">聚落密度 {{ draft.gen.villageChance.toFixed(2) }}</span>
            <input
              v-model.number="draft.gen.villageChance"
              type="range"
              min="0"
              max="1"
              step="0.02"
            />
            <span class="cbx-field__hint">村庄数量直接看上面的读数</span>
          </label>
        </details>
      </section>

      <!-- 我是谁 -->
      <section v-show="step === 'me'" class="sec">
        <p class="cbx-field__hint">
          只作用于这个世界。留空则回落到设置里的全局人设 —— 当前实际生效的是 「{{
            effectiveMe.name
          }}」。
        </p>
        <label class="cbx-field">
          <span class="cbx-field__label">我的名字</span>
          <input
            v-model="draft.persona.name"
            class="cbx-input"
            :placeholder="settings.settings.persona.name || '我'"
          />
        </label>
        <label class="cbx-field">
          <span class="cbx-field__label">我的身份</span>
          <textarea
            v-model="draft.persona.description"
            class="cbx-textarea"
            rows="4"
            placeholder="你在这个世界里是谁、什么身份、为什么在这里"
          />
        </label>
        <p class="cbx-field__hint">NPC 进世界之后再放 —— 走到想放的位置，点顶栏的「＋NPC」。</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.steps {
  display: flex;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-3) var(--cbx-space-5) 0;
  flex-shrink: 0;
}
.segs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
.seg {
  padding: var(--cbx-space-2) var(--cbx-space-4);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg);
  color: var(--cbx-text-secondary);
  cursor: pointer;
  font-size: var(--cbx-fs-sm);
}
.seg--on {
  background: var(--cbx-brand);
  border-color: var(--cbx-brand);
  color: #fff;
}
.body {
  flex: 1;
  min-height: 0;
  padding: var(--cbx-space-5);
}
.sec {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-4);
  max-width: 560px;
}
.seedrow {
  display: flex;
  gap: var(--cbx-space-2);
}
.seedrow .cbx-input {
  flex: 1;
  min-width: 0;
}
.adv summary {
  cursor: pointer;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  padding: var(--cbx-space-2) 0;
}
.adv {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
}
.adv .cbx-field {
  margin-top: var(--cbx-space-3);
}
input[type='range'] {
  width: 100%;
}
@media (max-width: 767px) {
  .steps {
    padding: var(--cbx-space-3) var(--cbx-space-3) 0;
  }
  .body {
    padding: var(--cbx-space-3);
  }
  .seg {
    min-height: var(--cbx-tap-min);
  }
}
</style>
