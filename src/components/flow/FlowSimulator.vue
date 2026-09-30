<script setup lang="ts">
/**
 * 流程模拟器：手填一份假状态 / 变量 / 回复正文，点「模拟一轮」就跑一次 evaluateFlow，
 * 看哪些规则触发、阶段怎么走、会注入什么引导。只在本地，不写任何数据、不调用模型。
 */
import { computed, reactive, ref } from 'vue'
import { currentStage, evaluateFlow, guideBlock, sanitizeFlow } from '@/services/flow/engine'
import type { FlowConfig, FlowState } from '@/types/flow'
import type { StatusData, StatusField } from '@/types/status'

const props = defineProps<{
  config: FlowConfig | undefined
  fields: StatusField[]
  charName: string
  userName: string
}>()

const OWNER = 'sim'
const charVals = reactive<Record<string, string>>({})
const userVals = reactive<Record<string, string>>({})
const sceneVals = reactive<Record<string, string>>({})
const varsText = ref('')
const reply = ref('')
const turn = ref(1)
const state = ref<FlowState | null>(null)
const vars = ref<Record<string, string>>({})
const last = ref<{ fired: string[]; moves: string[]; says: string[] } | null>(null)

const charFields = computed(() =>
  props.fields.filter((f) => f.scope === 'person' || f.scope === 'char'),
)
const userFields = computed(() =>
  props.fields.filter((f) => f.scope === 'person' || f.scope === 'user'),
)
const sceneFields = computed(() => props.fields.filter((f) => f.scope === 'scene'))
const sources = computed(() => [{ ownerId: OWNER, config: props.config, charName: props.charName }])
const stageName = computed(
  () => currentStage(sanitizeFlow(props.config).stages ?? [], state.value, OWNER)?.name ?? '',
)
const guide = computed(() => guideBlock(state.value, sources.value))

function pack(rec: Record<string, string>, list: StatusField[]) {
  const out: Record<string, string | string[]> = {}
  for (const f of list) {
    const v = (rec[f.key] ?? '').trim()
    if (!v) continue
    out[f.key] =
      f.kind === 'list'
        ? v
            .split(/[,，、]/)
            .map((x) => x.trim())
            .filter(Boolean)
        : v
  }
  return out
}
function parseVars(): Record<string, string> {
  const out: Record<string, string> = { ...vars.value }
  for (const line of varsText.value.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
/** 把引擎改过的状态写回表单，下一轮在它的基础上继续 */
function absorb(s: StatusData | null) {
  if (!s) return
  const text = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join('、') : (v ?? ''))
  for (const [k, v] of Object.entries(s.scene)) sceneVals[k] = text(v)
  for (const p of s.people) {
    const into = p.name === props.userName ? userVals : p.name === props.charName ? charVals : null
    if (into) for (const [k, v] of Object.entries(p.fields)) into[k] = text(v)
  }
}

function step() {
  const status: StatusData = {
    scene: pack(sceneVals, sceneFields.value),
    people: [
      { name: props.charName, fields: pack(charVals, charFields.value) },
      { name: props.userName, fields: pack(userVals, userFields.value) },
    ],
  }
  const out = evaluateFlow({
    sources: sources.value,
    prev: state.value,
    turn: turn.value,
    status,
    fields: props.fields,
    vars: parseVars(),
    reply: reply.value,
    userName: props.userName,
  })
  state.value = out.state
  vars.value = out.vars
  varsText.value = Object.entries(out.vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  if (out.statusChanged) absorb(out.status)
  last.value = {
    fired: out.fired,
    moves: out.stageMoves,
    says: out.says.map((s) => `${s.speaker}：${s.text}`),
  }
  turn.value++
}
function reset() {
  state.value = null
  vars.value = {}
  varsText.value = ''
  last.value = null
  turn.value = 1
}
</script>
<template>
  <div class="sim">
    <p class="note">
      手填一份假状态，点「模拟一轮」相当于收到一条 AI
      回复。只在本页计算，不写入任何数据，也不调用模型。
    </p>
    <div class="grid">
      <fieldset v-if="charFields.length" class="box">
        <legend>{{ charName }}</legend>
        <label v-for="f in charFields" :key="f.key" class="cbx-field">
          <span class="cbx-field__label">{{ f.key }}</span>
          <input
            v-model="charVals[f.key]"
            class="cbx-input"
            :inputmode="f.kind === 'number' ? 'decimal' : undefined"
            :aria-label="`${charName} ${f.key}`"
          />
        </label>
      </fieldset>
      <fieldset v-if="userFields.length" class="box">
        <legend>{{ userName }}</legend>
        <label v-for="f in userFields" :key="f.key" class="cbx-field">
          <span class="cbx-field__label">{{ f.key }}</span>
          <input
            v-model="userVals[f.key]"
            class="cbx-input"
            :inputmode="f.kind === 'number' ? 'decimal' : undefined"
            :aria-label="`${userName} ${f.key}`"
          />
        </label>
      </fieldset>
      <fieldset v-if="sceneFields.length" class="box">
        <legend>场景</legend>
        <label v-for="f in sceneFields" :key="f.key" class="cbx-field">
          <span class="cbx-field__label">{{ f.key }}</span>
          <input v-model="sceneVals[f.key]" class="cbx-input" :aria-label="`场景 ${f.key}`" />
        </label>
      </fieldset>
    </div>
    <label class="cbx-field">
      <span class="cbx-field__label">会话变量（每行 名称=值）</span>
      <textarea v-model="varsText" class="cbx-textarea" rows="2" aria-label="会话变量" />
    </label>
    <label class="cbx-field">
      <span class="cbx-field__label">本轮回复正文（可选）</span>
      <textarea v-model="reply" class="cbx-textarea" rows="2" aria-label="本轮回复正文" />
    </label>

    <div class="ops">
      <button type="button" class="cbx-btn cbx-btn--primary" @click="step">
        模拟第 {{ turn }} 轮
      </button>
      <button type="button" class="cbx-btn cbx-btn--ghost" @click="reset">重置</button>
      <span v-if="stageName" class="cbx-badge cbx-badge--brand">当前阶段：{{ stageName }}</span>
    </div>

    <div v-if="last" class="result" role="status">
      <p v-if="!last.fired.length && !last.moves.length" class="muted">这一轮没有规则触发。</p>
      <p v-for="n in last.fired" :key="`f-${n}`">✓ 触发规则：{{ n }}</p>
      <p v-for="m in last.moves" :key="`m-${m}`">→ 阶段切换：{{ m }}</p>
      <p v-for="(s, i) in last.says" :key="`s-${i}`">💬 插入台词：{{ s }}</p>
    </div>
    <details v-if="guide" class="guide">
      <summary>下一轮会注入的剧情引导</summary>
      <pre>{{ guide }}</pre>
    </details>
  </div>
</template>

<style scoped>
.sim {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
}
.note,
.muted {
  margin: 0;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--cbx-space-3);
}
.box {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  min-width: 0;
  margin: 0;
  padding: var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
}
.box legend {
  padding: 0 4px;
  font-size: var(--cbx-fs-sm);
}
.ops {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
.result {
  padding: var(--cbx-space-3);
  background: var(--cbx-bg-hover);
  border-radius: var(--cbx-radius-md);
  font-size: var(--cbx-fs-sm);
  overflow-wrap: anywhere;
}
.result p {
  margin: 0 0 4px;
}
.guide pre {
  margin: var(--cbx-space-2) 0 0;
  padding: var(--cbx-space-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--cbx-fs-xs);
  background: var(--cbx-bg-hover);
  border-radius: var(--cbx-radius-md);
}
</style>
