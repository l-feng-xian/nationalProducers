<script setup lang="ts">
/**
 * 一份状态快照的只读展示：场景一组、人物一人一张卡。
 * 字段按模板顺序排，模板里没有但模型多给的键排在后面照样显示。
 */
import { computed } from 'vue'
import { changeKey } from '@/services/status/diff'
import { fieldsFor, type StatusData, type StatusField, type StatusValue } from '@/types/status'

const props = defineProps<{
  data: StatusData
  fields: StatusField[]
  /** {{user}} 的名字：这张卡置顶并标「你」 */
  userName: string
  /** 相比上一份有变化的字段（diff.changedKeys），打点提示 */
  changed?: Set<string>
}>()

/** tpl：这一组适用的模板字段（场景 / 某人按 fieldsFor 取），决定排序 */
function ordered(rec: Record<string, StatusValue>, tpl: StatusField[]) {
  const keys = tpl.map((f) => f.key)
  const rest = Object.keys(rec).filter((k) => !keys.includes(k))
  return [...keys, ...rest]
    .filter((k) => rec[k] !== undefined && rec[k] !== '' && !isEmptyList(rec[k]))
    .map((k) => ({ key: k, value: rec[k]! }))
}
function isEmptyList(v: StatusValue | undefined) {
  return Array.isArray(v) && !v.length
}

const scene = computed(() =>
  ordered(
    props.data.scene,
    props.fields.filter((f) => f.scope === 'scene'),
  ),
)
const people = computed(() => {
  const list = props.data.people.map((p) => {
    const isUser = p.name === props.userName
    return {
      name: p.name,
      isUser,
      carried: !!p.carried,
      rows: ordered(p.fields, fieldsFor(props.fields, isUser)),
    }
  })
  // 用户自己的卡放最前：侧栏里最常看的是「我身上带着什么」
  return [...list.filter((p) => p.isUser), ...list.filter((p) => !p.isUser)]
})

function isChanged(person: string | undefined, key: string) {
  return !!props.changed?.has(changeKey(person, key))
}
</script>

<template>
  <div class="snap">
    <section v-if="scene.length" class="snap-scene" aria-label="场景">
      <div v-for="r in scene" :key="r.key" class="row">
        <span class="row__k">
          {{ r.key
          }}<i
            v-if="isChanged(undefined, r.key)"
            class="dot"
            title="本轮有变化"
            aria-label="本轮有变化"
          ></i>
        </span>
        <span v-if="Array.isArray(r.value)" class="row__chips">
          <span v-for="(item, i) in r.value" :key="i" class="item">{{ item }}</span>
        </span>
        <span v-else class="row__v">{{ r.value }}</span>
      </div>
    </section>

    <article
      v-for="p in people"
      :key="p.name"
      class="snap-person"
      :class="{ 'snap-person--user': p.isUser, 'snap-person--carried': p.carried }"
    >
      <header class="snap-person__head">
        <span class="snap-person__name">{{ p.name }}</span>
        <span v-if="p.isUser" class="cbx-badge cbx-badge--brand">你</span>
        <span
          v-if="p.carried"
          class="cbx-badge snap-carried"
          title="本轮 AI 没有写这个人的状态，沿用上一份"
          >沿用</span
        >
      </header>
      <div v-for="r in p.rows" :key="r.key" class="row">
        <span class="row__k">
          {{ r.key
          }}<i
            v-if="isChanged(p.name, r.key)"
            class="dot"
            title="本轮有变化"
            aria-label="本轮有变化"
          ></i>
        </span>
        <span v-if="Array.isArray(r.value)" class="row__chips">
          <span v-for="(item, i) in r.value" :key="i" class="item">{{ item }}</span>
        </span>
        <span v-else class="row__v">{{ r.value }}</span>
      </div>
      <p v-if="!p.rows.length" class="snap-empty">（暂无记录）</p>
    </article>
  </div>
</template>

<style scoped>
.snap {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
}
.snap-scene,
.snap-person {
  padding: var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-bg);
}
.snap-scene {
  background: var(--cbx-brand-subtle);
  border-color: var(--cbx-brand-light-hover);
}
.snap-person--carried > :not(.snap-person__head) {
  opacity: 0.72;
}
.snap-carried {
  color: var(--cbx-text-tertiary);
}
.snap-person--user {
  border-color: var(--cbx-brand-light-hover);
}
.snap-person__head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  margin-bottom: var(--cbx-space-2);
}
.snap-person__name {
  font-weight: var(--cbx-fw-medium);
  color: var(--cbx-text);
  min-width: 0;
  overflow-wrap: anywhere;
}
.row {
  display: grid;
  grid-template-columns: 5.5em minmax(0, 1fr);
  gap: var(--cbx-space-2);
  padding: 3px 0;
  font-size: var(--cbx-fs-sm);
  line-height: 1.6;
}
.row__k {
  position: relative;
  color: var(--cbx-text-tertiary);
  overflow-wrap: anywhere;
}
.row__v {
  color: var(--cbx-text);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.row__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-1);
}
.item {
  padding: 0 var(--cbx-space-2);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg-secondary);
  color: var(--cbx-text-secondary);
  font-size: var(--cbx-fs-xs);
  line-height: 22px;
  overflow-wrap: anywhere;
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 4px;
  vertical-align: middle;
  border-radius: 50%;
  background: var(--cbx-brand);
}
.snap-empty {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
</style>
