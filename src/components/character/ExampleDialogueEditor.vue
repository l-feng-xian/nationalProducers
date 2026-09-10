<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  emptyExampleBlock,
  parseExampleBlocks,
  serializeExampleBlocks,
  type ExampleBlock,
} from '@/utils/mesExample'

/**
 * 对话示例可视化编辑（需求 2：可多条）。
 *
 * 底层存储仍是 ST 的 `<START>` 分块文本，但用户看到的是「第 N 组 · 谁说了什么」，
 * 不必手写 `<START>` 与 `{{user}}:` 前缀。无法解析的块降级为源码框，内容不丢。
 */
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [v: string] }>()

const blocks = ref<ExampleBlock[]>(parseExampleBlocks(props.modelValue))
const sourceMode = ref(false)
const source = ref(props.modelValue)

// 外部（如导入角色卡）改了值时重新解析
watch(
  () => props.modelValue,
  (v) => {
    if (v === serializeExampleBlocks(blocks.value)) return
    blocks.value = parseExampleBlocks(v)
    source.value = v
  },
)

function flush() {
  emit('update:modelValue', serializeExampleBlocks(blocks.value))
}

const hasRaw = computed(() => blocks.value.some((b) => b.raw !== undefined))

function addBlock() {
  blocks.value.push(emptyExampleBlock())
  flush()
}
function removeBlock(i: number) {
  blocks.value.splice(i, 1)
  flush()
}
function addTurn(bi: number, who: 'user' | 'char') {
  blocks.value[bi]?.turns.push({ who, text: '' })
  flush()
}
function removeTurn(bi: number, ti: number) {
  blocks.value[bi]?.turns.splice(ti, 1)
  flush()
}
function setTurn(bi: number, ti: number, text: string) {
  const t = blocks.value[bi]?.turns[ti]
  if (!t) return
  t.text = text
  flush()
}
function toggleWho(bi: number, ti: number) {
  const t = blocks.value[bi]?.turns[ti]
  if (!t) return
  t.who = t.who === 'user' ? 'char' : 'user'
  flush()
}
function setRaw(bi: number, text: string) {
  const b = blocks.value[bi]
  if (!b) return
  b.raw = text
  flush()
}

function enterSource() {
  source.value = serializeExampleBlocks(blocks.value)
  sourceMode.value = true
}
function applySource() {
  blocks.value = parseExampleBlocks(source.value)
  sourceMode.value = false
  flush()
}
</script>

<template>
  <div>
    <div class="bar">
      <p class="hint">
        每一组示例告诉模型「这个角色平时怎么说话」。可以放多组。
        <span v-if="hasRaw" class="cbx-badge cbx-badge--warning">有无法解析的组，已保留源码</span>
      </p>
      <button class="cbx-btn cbx-btn--ghost" @click="sourceMode ? applySource() : enterSource()">
        {{ sourceMode ? '✓ 应用源码' : '源码模式' }}
      </button>
    </div>

    <textarea
      v-if="sourceMode"
      v-model="source"
      class="cbx-textarea"
      rows="14"
      spellcheck="false"
    />

    <template v-else>
      <div v-for="(b, bi) in blocks" :key="bi" class="block">
        <div class="block__head">
          <span class="block__idx">第 {{ bi + 1 }} 组</span>
          <button class="cbx-icon-btn" title="删除这组" @click="removeBlock(bi)">✕</button>
        </div>

        <textarea
          v-if="b.raw !== undefined"
          class="cbx-textarea"
          rows="4"
          :value="b.raw"
          @input="setRaw(bi, ($event.target as HTMLTextAreaElement).value)"
        />

        <template v-else>
          <div v-for="(t, ti) in b.turns" :key="ti" class="turn">
            <button
              class="cbx-chip who"
              :class="{ 'cbx-chip--active': t.who === 'char' }"
              :title="'点击切换为' + (t.who === 'user' ? '角色' : '用户')"
              @click="toggleWho(bi, ti)"
            >
              {{ t.who === 'user' ? '用户' : '角色' }}
            </button>
            <textarea
              class="cbx-textarea turn__text"
              rows="2"
              :value="t.text"
              @input="setTurn(bi, ti, ($event.target as HTMLTextAreaElement).value)"
            />
            <button class="cbx-icon-btn" title="删除这句" @click="removeTurn(bi, ti)">✕</button>
          </div>
          <div class="block__ops">
            <button class="cbx-btn cbx-btn--ghost sm" @click="addTurn(bi, 'user')">＋ 用户</button>
            <button class="cbx-btn cbx-btn--ghost sm" @click="addTurn(bi, 'char')">＋ 角色</button>
          </div>
        </template>
      </div>

      <button class="cbx-btn cbx-btn--soft" @click="addBlock">＋ 添加一组示例</button>
    </template>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: flex-start;
  gap: var(--cbx-space-3);
  margin-bottom: var(--cbx-space-4);
}
.hint {
  flex: 1;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  line-height: 1.6;
}
.block {
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  padding: var(--cbx-space-3);
  margin-bottom: var(--cbx-space-3);
}
.block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--cbx-space-2);
}
.block__idx {
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
  color: var(--cbx-text-secondary);
}
.block__ops {
  display: flex;
  gap: var(--cbx-space-2);
  margin-top: var(--cbx-space-2);
}
.sm {
  height: 30px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
.turn {
  display: flex;
  align-items: flex-start;
  gap: var(--cbx-space-2);
  margin-bottom: var(--cbx-space-2);
}
.who {
  flex-shrink: 0;
  margin-top: 6px;
  min-width: 48px;
  justify-content: center;
}
.turn__text {
  flex: 1;
  min-height: 0;
}

@media (max-width: 767px) {
  .bar {
    flex-direction: column;
  }
  .sm {
    height: var(--cbx-tap-min);
  }
}
</style>
