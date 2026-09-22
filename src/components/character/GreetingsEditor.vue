<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import { computed } from 'vue'
import { confirmDialog } from '@/composables/useConfirm'

/**
 * 多条开场白（需求 2）。
 *
 * 存储上第 1 条是 `first_mes`，其余是 `alternate_greetings`（对齐 ST 角色卡格式）；
 * 这里对用户呈现为一个统一的列表，避免暴露这个历史包袱。
 */
/** 模板里要显示字面的宏，不能直接写 —— Vue 会在内层 }} 提前闭合插值 */
const CHAR_MACRO = '{{char}}'
const USER_MACRO = '{{user}}'

const props = defineProps<{ firstMes: string; alternates: string[] }>()
const emit = defineEmits<{
  'update:firstMes': [v: string]
  'update:alternates': [v: string[]]
}>()

const all = computed<string[]>(() => [props.firstMes, ...props.alternates])

function commit(list: string[]) {
  emit('update:firstMes', list[0] ?? '')
  emit('update:alternates', list.slice(1))
}

function setAt(i: number, v: string) {
  const next = [...all.value]
  next[i] = v
  commit(next)
}
function add() {
  commit([...all.value, ''])
}
async function removeAt(i: number) {
  if (!(await confirmDialog({ text: '删除这条开场白？' }))) return
  const next = [...all.value]
  next.splice(i, 1)
  commit(next.length ? next : [''])
}
function move(i: number, dir: -1 | 1) {
  const next = [...all.value]
  const j = i + dir
  if (j < 0 || j >= next.length) return
  const a = next[i]
  const b = next[j]
  if (a === undefined || b === undefined) return
  next[i] = b
  next[j] = a
  commit(next)
}
</script>

<template>
  <div>
    <p class="hint">
      新对话开始时会从这些开场白里**随机**挑一条插入；1v1 模式下还能在首条消息上左右切换全部开场白。
      支持宏，例如 <code>{{ CHAR_MACRO }}</code
      >、<code>{{ USER_MACRO }}</code
      >。
    </p>

    <div v-for="(g, i) in all" :key="i" class="item">
      <div class="item__head">
        <span class="item__idx">开场白 {{ i + 1 }}</span>
        <div class="item__ops">
          <button class="cbx-icon-btn" title="上移" :disabled="i === 0" @click="move(i, -1)">
            <AppIcon name="ArrowUp" />
          </button>
          <button
            class="cbx-icon-btn"
            title="下移"
            :disabled="i === all.length - 1"
            @click="move(i, 1)"
          >
            <AppIcon name="ArrowDown" />
          </button>
          <button
            class="cbx-icon-btn"
            title="删除"
            :disabled="all.length === 1"
            @click="removeAt(i)"
          >
            <AppIcon name="X" tone="danger" />
          </button>
        </div>
      </div>
      <textarea
        class="cbx-textarea"
        rows="3"
        placeholder="例：*她抬起头，目光落在你身上* 又是你啊。"
        :value="g"
        @input="setAt(i, ($event.target as HTMLTextAreaElement).value)"
      />
    </div>

    <button class="cbx-btn cbx-btn--soft" @click="add"><AppIcon name="Plus" /> 添加开场白</button>
  </div>
</template>

<style scoped>
.hint {
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  margin-bottom: var(--cbx-space-4);
  line-height: 1.6;
}
.hint code {
  font-family: var(--cbx-font-mono);
  font-size: 0.9em;
  padding: 1px 4px;
  border-radius: var(--cbx-radius-sm);
  background: var(--cbx-code-bg);
}
.item {
  margin-bottom: var(--cbx-space-4);
}
.item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--cbx-space-2);
}
.item__idx {
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
  color: var(--cbx-text-secondary);
}
.item__ops {
  display: flex;
  gap: 2px;
}
.item__ops .cbx-icon-btn {
  width: 28px;
  height: 28px;
  font-size: var(--cbx-fs-sm);
}
@media (max-width: 767px) {
  .item__ops .cbx-icon-btn {
    width: var(--cbx-tap-min);
    height: var(--cbx-tap-min);
  }
}
</style>
