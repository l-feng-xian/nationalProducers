<script setup lang="ts">
/**
 * 状态快照的编辑表单：场景 + 人物逐字段编辑，列表字段是可增删的标签；
 * 另有「原始 JSON」兜底，用来加模板外的字段或整份粘贴。
 *
 * 两种用法：
 *  - 侧栏手改当前状态：带「保存 / 取消」，保存时 emit('save')；
 *  - live：角色卡 / 演绎编辑页的「初始状态」，每次改动都 emit('update')，没有底栏。
 */
import { ref, watch } from 'vue'
import { Plus, Trash2, X } from '@/components/icons'
import { parseStatusJson } from '@/services/status/parse'
import { toOutputShape } from '@/services/status/template'
import {
  fieldsFor,
  type StatusData,
  type StatusField,
  type StatusFieldKind,
  type StatusValue,
} from '@/types/status'

const props = defineProps<{
  data: StatusData | null
  fields: StatusField[]
  /** {{user}} 的名字：这个人按「仅用户」字段取，其他人按「仅角色」字段取 */
  userName: string
  /**
   * 必须出现、且名字不能改的人（角色们 + 用户）。
   * 名字对不上的条目会被 completeStatus 当成「漏写」，所以这里不给改也不给删；缺的自动补上
   */
  lockedPeople: string[]
  saving?: boolean
  live?: boolean
}>()
const emit = defineEmits<{ save: [data: StatusData]; cancel: []; update: [data: StatusData] }>()

interface Row {
  key: string
  /** number 与 text 一样是单行输入，只是换成数字键盘 */
  kind: StatusFieldKind
  text: string
  items: string[]
  pending: string
}
interface Person {
  uid: number
  name: string
  rows: Row[]
}

let uid = 0

function tplFor(name: string | null): StatusField[] {
  return name === null
    ? props.fields.filter((f) => f.scope === 'scene')
    : fieldsFor(props.fields, name === props.userName)
}

/** name = null 表示场景 */
function rowsOf(rec: Record<string, StatusValue>, name: string | null): Row[] {
  const tpl = tplFor(name)
  const keys = [
    ...tpl.map((f) => f.key),
    ...Object.keys(rec).filter((k) => !tpl.some((f) => f.key === k)),
  ]
  return keys.map((key) => {
    const v = rec[key]
    const kind: StatusFieldKind =
      tpl.find((f) => f.key === key)?.kind ?? (Array.isArray(v) ? 'list' : 'text')
    const items = Array.isArray(v) ? [...v] : kind === 'list' && v ? [v] : []
    const text = Array.isArray(v) ? v.join('、') : (v ?? '')
    return { key, kind, text: kind === 'list' ? '' : text, items, pending: '' }
  })
}

function toDraft(d: StatusData | null) {
  const src = d ?? { scene: {}, people: [] }
  const people = [...src.people]
  for (const name of props.lockedPeople) {
    if (!people.some((p) => p.name === name)) people.push({ name, fields: {} })
  }
  return {
    scene: rowsOf(src.scene, null),
    people: people.map((p) => ({ uid: ++uid, name: p.name, rows: rowsOf(p.fields, p.name) })),
  }
}

function isLocked(p: Person) {
  return props.lockedPeople.includes(p.name)
}

const draft = ref(toDraft(props.data))

function fromDraft(): StatusData {
  const pack = (rows: Row[]) => {
    const out: Record<string, StatusValue> = {}
    for (const r of rows) {
      if (r.kind === 'list') {
        const items = [...r.items, r.pending.trim()].filter(Boolean)
        if (items.length) out[r.key] = items
      } else if (r.text.trim()) out[r.key] = r.text.trim()
    }
    return out
  }
  return {
    scene: pack(draft.value.scene),
    people: draft.value.people
      .filter((p) => p.name.trim())
      .map((p) => ({ name: p.name.trim(), fields: pack(p.rows) })),
  }
}

function addItem(r: Row) {
  const v = r.pending.trim()
  if (v) r.items.push(v)
  r.pending = ''
}
function removeItem(r: Row, i: number) {
  r.items.splice(i, 1)
}
function addPerson() {
  draft.value.people.push({ uid: ++uid, name: '', rows: rowsOf({}, '') })
}
function removePerson(p: Person) {
  draft.value.people = draft.value.people.filter((x) => x.uid !== p.uid)
}

// ── 原始 JSON ──
const rawOpen = ref(false)
const raw = ref('')
const rawError = ref('')
function toggleRaw() {
  rawOpen.value = !rawOpen.value
  if (rawOpen.value) {
    raw.value = JSON.stringify(toOutputShape(fromDraft()), null, 2)
    rawError.value = ''
  }
}
function applyRaw() {
  const parsed = parseStatusJson(raw.value)
  if (!parsed) {
    rawError.value = '不是合法的状态 JSON（需要「场景」对象或「人物」数组）'
    return
  }
  draft.value = toDraft(parsed)
  rawError.value = ''
  rawOpen.value = false
}

if (props.live) {
  watch(draft, () => emit('update', fromDraft()), { deep: true })
}

function onSave() {
  // live 模式没有保存动作：输入框里回车触发的 submit 直接忽略
  if (props.live) return
  emit('save', fromDraft())
}
function onCancel() {
  emit('cancel')
}
</script>

<template>
  <form class="ed" @submit.prevent="onSave">
    <fieldset class="ed-group">
      <legend>场景</legend>
      <div v-for="r in draft.scene" :key="r.key" class="ed-row">
        <label class="ed-row__k" :for="`sc-${r.key}`">{{ r.key }}</label>
        <input
          v-if="r.kind !== 'list'"
          :id="`sc-${r.key}`"
          v-model="r.text"
          class="cbx-input"
          :type="r.kind === 'number' ? 'number' : 'text'"
          :inputmode="r.kind === 'number' ? 'decimal' : undefined"
          autocomplete="off"
        />
        <div v-else class="ed-list">
          <span v-for="(item, i) in r.items" :key="i" class="ed-item">
            {{ item
            }}<button
              type="button"
              class="ed-item__x"
              :aria-label="`移除 ${item}`"
              @click="removeItem(r, i)"
            >
              <X :size="12" aria-hidden="true" />
            </button>
          </span>
          <input
            :id="`sc-${r.key}`"
            v-model="r.pending"
            class="cbx-input ed-list__add"
            placeholder="添加后回车"
            autocomplete="off"
            @keydown.enter.prevent="addItem(r)"
            @blur="addItem(r)"
          />
        </div>
      </div>
    </fieldset>

    <fieldset v-for="p in draft.people" :key="p.uid" class="ed-group">
      <legend class="ed-person">
        <span v-if="isLocked(p)" class="ed-person__fixed">
          {{ p.name }}<span v-if="p.name === userName" class="cbx-badge cbx-badge--brand">你</span>
        </span>
        <input
          v-else
          v-model="p.name"
          class="cbx-input ed-person__name"
          placeholder="名字"
          aria-label="人物名字"
        />
        <button
          v-if="!isLocked(p)"
          type="button"
          class="cbx-btn cbx-btn--ghost ed-icon"
          :aria-label="`移除人物 ${p.name}`"
          title="移除这个人物"
          @click="removePerson(p)"
        >
          <Trash2 :size="16" aria-hidden="true" />
        </button>
      </legend>
      <div v-for="r in p.rows" :key="r.key" class="ed-row">
        <label class="ed-row__k" :for="`p${p.uid}-${r.key}`">{{ r.key }}</label>
        <input
          v-if="r.kind !== 'list'"
          :id="`p${p.uid}-${r.key}`"
          v-model="r.text"
          class="cbx-input"
          :type="r.kind === 'number' ? 'number' : 'text'"
          :inputmode="r.kind === 'number' ? 'decimal' : undefined"
          autocomplete="off"
        />
        <div v-else class="ed-list">
          <span v-for="(item, i) in r.items" :key="i" class="ed-item">
            {{ item
            }}<button
              type="button"
              class="ed-item__x"
              :aria-label="`移除 ${item}`"
              @click="removeItem(r, i)"
            >
              <X :size="12" aria-hidden="true" />
            </button>
          </span>
          <input
            :id="`p${p.uid}-${r.key}`"
            v-model="r.pending"
            class="cbx-input ed-list__add"
            placeholder="添加后回车"
            autocomplete="off"
            @keydown.enter.prevent="addItem(r)"
            @blur="addItem(r)"
          />
        </div>
      </div>
    </fieldset>

    <button type="button" class="cbx-btn cbx-btn--soft ed-add" @click="addPerson">
      <Plus :size="16" aria-hidden="true" />添加人物
    </button>

    <div class="cbx-collapse ed-raw">
      <button type="button" class="cbx-collapse__head" :aria-expanded="rawOpen" @click="toggleRaw">
        原始 JSON<span class="ed-raw__hint">加模板外的字段、整份粘贴</span>
      </button>
      <div v-if="rawOpen" class="cbx-collapse__body">
        <textarea
          v-model="raw"
          class="cbx-textarea ed-raw__ta"
          rows="10"
          spellcheck="false"
        ></textarea>
        <p v-if="rawError" class="ed-err">{{ rawError }}</p>
        <button type="button" class="cbx-btn cbx-btn--soft" @click="applyRaw">应用到表单</button>
      </div>
    </div>

    <div v-if="!live" class="ed-foot">
      <button type="button" class="cbx-btn cbx-btn--ghost" @click="onCancel">取消</button>
      <button type="submit" class="cbx-btn cbx-btn--primary" :disabled="saving">保存</button>
    </div>
  </form>
</template>

<style scoped>
.ed {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
}
.ed-group {
  margin: 0;
  padding: var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-bg);
  min-width: 0;
}
.ed-group legend {
  padding: 0 var(--cbx-space-1);
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
  color: var(--cbx-text-secondary);
}
.ed-person {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-1);
}
.ed-person__fixed {
  display: inline-flex;
  align-items: center;
  gap: var(--cbx-space-1);
  color: var(--cbx-text);
}
.ed-person__name {
  width: 10em;
}
.ed-row {
  display: grid;
  grid-template-columns: 5.5em minmax(0, 1fr);
  align-items: start;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-1) 0;
}
.ed-row__k {
  padding-top: 8px;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-tertiary);
  overflow-wrap: anywhere;
}
.ed-row .cbx-input {
  width: 100%;
  min-width: 0;
}
.ed-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-1);
  min-width: 0;
}
.ed-item {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding-left: var(--cbx-space-2);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg-secondary);
  font-size: var(--cbx-fs-xs);
  line-height: 24px;
  color: var(--cbx-text-secondary);
  overflow-wrap: anywhere;
}
.ed-item__x {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: none;
  color: var(--cbx-text-tertiary);
  cursor: pointer;
}
.ed-item__x:hover {
  color: var(--cbx-error);
}
.ed-list__add {
  flex: 1 1 100%;
}
.ed-icon {
  width: 36px;
  padding: 0;
  flex-shrink: 0;
}
.ed-add {
  align-self: flex-start;
  gap: var(--cbx-space-1);
}
.ed-raw {
  margin-bottom: 0;
}
.ed-raw__hint {
  margin-left: auto;
  font-size: var(--cbx-fs-xs);
  font-weight: var(--cbx-fw-normal);
  color: var(--cbx-text-tertiary);
}
.ed-raw__ta {
  width: 100%;
  font-family: var(--cbx-font-mono);
  font-size: var(--cbx-fs-xs);
  margin-bottom: var(--cbx-space-2);
}
.ed-err {
  margin-bottom: var(--cbx-space-2);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-error);
}
.ed-foot {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: flex-end;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-2) 0;
  background: var(--cbx-bg-secondary);
}
@media (max-width: 767px) {
  .ed-icon {
    width: var(--cbx-tap-min);
    height: var(--cbx-tap-min);
  }
  .ed-item__x {
    width: 32px;
    height: 32px;
  }
}
</style>
