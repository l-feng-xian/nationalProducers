<script setup lang="ts" generic="T extends string | number">
/**
 * 通用下拉。取代各处的原生 `<select>`，PC 与手机行为、观感统一：
 *  - 桌面：点开一个贴着触发器的浮层，自动上下翻转、贴边收窄，键盘可全程操作
 *  - 手机（≤767px）：从底部升起的选择面板，行高满足触控，返回键可关
 *  - 浮层就地渲染（不 Teleport）：像原生 select 一样，在 `<dialog>` 弹框里也能压住内容并收到点击
 *  - `free`：触发区是可输入的文本框（组合框），既能从列表里选，也能填列表之外的值
 *
 * 无障碍：触发器是 combobox，列表是 listbox / option，带 aria-expanded / aria-selected，
 * 焦点打开时移入列表、关闭时还给触发器。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from '@/components/icons/AppIcon.vue'
import { useBackClose } from '@/composables/useBackClose'
import { DRAWER_MQ, useMediaQuery } from '@/composables/useDrawerSwipe'

export interface SelectOption<V> {
  value: V
  label: string
  /** 次要说明，只在浮层 / 面板里显示 */
  hint?: string
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: T | null
    options: readonly SelectOption<T>[]
    /** 无障碍名，也是手机面板的标题（除非另给 title） */
    label?: string
    /** 没有选中项时触发器显示的占位文字 */
    placeholder?: string
    title?: string
    disabled?: boolean
    /** 更矮的触发器，用在紧凑行内 */
    compact?: boolean
    /**
     * 可自由输入（组合框）：触发区是文本框，输入时过滤列表，也允许填列表里没有的值。
     * 用在「字段名」这类既常选、又允许自定义的地方。
     */
    free?: boolean
  }>(),
  { modelValue: null, compact: false, disabled: false, free: false },
)
const emit = defineEmits<{ 'update:modelValue': [v: T]; change: [v: T] }>()

const isMobile = useMediaQuery(DRAWER_MQ)
const open = ref(false)
const trigger = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
/** 手机底部面板：Teleport 到 body，不在 list 里，单独拿着引用做「点在面板内」判断 */
const sheet = ref<HTMLElement | null>(null)
/** 浮层位置（桌面）：贴着触发器，空间不够就翻到上方 */
const pop = ref({ top: 0, left: 0, width: 0, maxHeight: 280, up: false })

const current = computed(() => props.options.find((o) => o.value === props.modelValue))
/** free 模式输入框里的文字（= 当前值，除非用户正在改） */
const query = ref('')
watch(
  () => props.modelValue,
  (v) => {
    query.value = v == null ? '' : String(v)
  },
  { immediate: true },
)
/**
 * 列表显示哪些项。free 模式按输入过滤；输入为空、或正好等于当前值时显示全部 ——
 * 否则重新打开浮层只会剩一条，看起来像列表被吞了。
 */
const filtered = computed(() => {
  if (!props.free) return props.options
  const q = query.value.trim().toLowerCase()
  if (!q || q === String(props.modelValue ?? '').toLowerCase()) return props.options
  return props.options.filter((o) => o.label.toLowerCase().includes(q))
})
/** 键盘高亮的下标（-1 = 无）。free 模式下 ↓↑ 只挪高亮，回车才选中 */
const active = ref(-1)
watch([open, filtered], () => {
  active.value = -1
})

watch(open, async (v) => {
  if (!v) return
  await nextTick()
  // 打开后把焦点放进列表，键盘立刻可用；滚动到当前项
  list.value?.focus({ preventScroll: true })
  const el = list.value?.querySelector<HTMLElement>('[aria-selected="true"]')
  el?.scrollIntoView({ block: 'nearest' })
})

function place() {
  const el = trigger.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const GAP = 6
  const MARGIN = 8
  const below = window.innerHeight - r.bottom - GAP - MARGIN
  const above = r.top - GAP - MARGIN
  const up = below < 200 && above > below
  const maxHeight = Math.max(160, Math.min(320, up ? above : below))
  const width = Math.max(r.width, 180)
  const left = Math.min(Math.max(MARGIN, r.left), window.innerWidth - width - MARGIN)
  pop.value = {
    top: up ? r.top - GAP - maxHeight : r.bottom + GAP,
    left,
    width,
    maxHeight,
    up,
  }
}

function onScrollOrResize() {
  if (open.value) place()
}

/**
 * 点空白关闭。
 *
 * ⚠️ 不能用「铺一层透明遮罩」的办法：这些下拉大多开在模态 `<dialog>` 里，
 * 而模态 dialog 渲染在浏览器的 **top layer** —— 那一层压过文档里所有 z-index，
 * 所以遮罩无论给多高都收不到点击，点空白处浮层不会关（实测就是这样）。
 * 改成监听 document 的 pointerdown：只判断点在哪，不受层叠上下文与 top layer 影响。
 */
function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return
  const t = e.target as Node | null
  if (!t) return
  if (trigger.value?.contains(t) || list.value?.contains(t) || sheet.value?.contains(t)) return
  // 点在别处：不把焦点抢回触发器（用户可能正点在某个输入框上）
  close(false)
}

function openList() {
  if (props.disabled) return
  place()
  open.value = true
  // 滚动 / 转屏时跟着走，别让浮层飘在空处
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize)
  // capture：先于其它处理跑，点在按钮上时也能先关掉浮层
  document.addEventListener('pointerdown', onDocPointerDown, true)
}
function close(restore = true) {
  if (!open.value) return
  open.value = false
  window.removeEventListener('scroll', onScrollOrResize, true)
  window.removeEventListener('resize', onScrollOrResize)
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  if (restore) trigger.value?.focus({ preventScroll: true })
}
function pick(o: SelectOption<T>) {
  if (o.disabled) return
  close()
  if (o.value !== props.modelValue) {
    emit('update:modelValue', o.value)
    emit('change', o.value)
  }
}
/** 可选项下标（跳过 disabled），用于方向键移动 */
function enabledIndexes(list: readonly SelectOption<T>[]) {
  return list.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0)
}
function move(step: 1 | -1) {
  const list = filtered.value
  const ids = enabledIndexes(list)
  if (!ids.length) return
  const cur = active.value >= 0 ? active.value : list.findIndex((o) => o.value === props.modelValue)
  const at = ids.indexOf(cur)
  const next =
    at < 0
      ? step > 0
        ? ids[0]!
        : ids[ids.length - 1]!
      : ids[(at + step + ids.length) % ids.length]!
  // 可输入模式：方向键只挪高亮，别把用户刚敲的字覆盖掉
  if (props.free) {
    active.value = next
    return
  }
  pick(list[next]!)
}
/** free 模式：把输入框里的文字提交成值 */
function commitFree() {
  if (!props.free) return
  const v = query.value.trim()
  close(false)
  if (v === String(props.modelValue ?? '')) return
  emit('update:modelValue', v as T)
  emit('change', v as T)
}
function onFreeInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value
  if (!open.value) openList()
  else place()
}
/**
 * free 模式失焦即提交。
 *
 * ⚠️ 焦点移进列表里（用户正去点某个选项）时**不提交**：那种情况由 pick 决定值。
 * 用 @change 代替这个判断会踩坑 —— blur 先于 click 触发，change 会把用户敲的字
 * 当成最终值提交，把刚点中的选项覆盖掉。
 */
function onFreeBlur(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (next && (list.value?.contains(next) || sheet.value?.contains(next))) return
  commitFree()
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // ⚠️ preventDefault 不能少：浮层常常开在 <dialog> 里，Esc 的默认动作是
    // 触发 dialog 的 cancel（连外层弹框一起关），stopPropagation 拦不住默认动作。
    e.preventDefault()
    e.stopPropagation()
    // 没提交的输入还原成当前值，别让输入框和实际值对不上
    if (props.free) query.value = String(props.modelValue ?? '')
    close()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    move(e.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (e.key === 'Home' || e.key === 'End') {
    const list = filtered.value
    const ids = enabledIndexes(list)
    e.preventDefault()
    if (!ids.length) return
    const i = e.key === 'Home' ? ids[0]! : ids[ids.length - 1]!
    if (props.free) active.value = i
    else pick(list[i]!)
    return
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    if (!open.value) {
      openList()
      return
    }
    const picked = active.value >= 0 ? filtered.value[active.value] : undefined
    if (picked) pick(picked)
    else if (props.free) commitFree()
    else if (props.modelValue != null) pick(current.value ?? props.options[0]!)
  }
}

// 手机上是底部面板：返回键 = 关面板
useBackClose(() => close(false), open)
onBeforeUnmount(() => close(false))
</script>

<template>
  <div class="cs">
    <input
      v-if="free"
      ref="trigger"
      class="cbx-input cs__input"
      :value="query"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="label"
      :placeholder="placeholder"
      :disabled="disabled"
      autocomplete="off"
      @input="onFreeInput"
      @click="openList"
      @blur="onFreeBlur"
      @keydown="onKeydown"
    />
    <button
      v-else
      ref="trigger"
      type="button"
      class="cs__trigger"
      :class="{
        'cs__trigger--compact': compact,
        'cs__trigger--open': open,
        'cs__trigger--ph': !current,
      }"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="label"
      :disabled="disabled"
      @click="open ? close() : openList()"
      @keydown="onKeydown"
    >
      <span class="cs__value">{{ current?.label ?? (placeholder || '请选择') }}</span>
      <AppIcon name="ChevronDown" class="cs__caret" aria-hidden="true" />
    </button>

    <!-- 桌面：贴触发器的浮层。点空白关闭由 document 的 pointerdown 负责，见 onDocPointerDown -->
    <template v-if="open && !isMobile">
      <div
        ref="list"
        class="cs__list"
        role="listbox"
        tabindex="-1"
        :aria-label="label"
        :style="{
          top: `${pop.top}px`,
          left: `${pop.left}px`,
          width: `${pop.width}px`,
          maxHeight: `${pop.maxHeight}px`,
        }"
        @keydown="onKeydown"
      >
        <p v-if="!filtered.length" class="cs__none">没有匹配项</p>
        <button
          v-for="(o, i) in filtered"
          :key="String(o.value)"
          type="button"
          class="cs__opt"
          :class="{ 'cs__opt--active': i === active }"
          role="option"
          :data-value="String(o.value)"
          :aria-selected="o.value === modelValue"
          :disabled="o.disabled"
          @mouseenter="active = i"
          @click="pick(o)"
        >
          <span class="cs__opt-main">
            <span class="cs__opt-label">{{ o.label }}</span>
            <span v-if="o.hint" class="cs__opt-hint">{{ o.hint }}</span>
          </span>
          <AppIcon v-if="o.value === modelValue" name="Check" class="cs__tick" aria-hidden="true" />
        </button>
      </div>
    </template>

    <!-- 手机：底部升起的选择面板。
         ⚠️ 必须**就地渲染**，不能 Teleport 到 body：模态 <dialog> 在浏览器的 top layer，
         那一层压过文档里所有 z-index，Teleport 出去的面板会落到弹框底下（点不到）。
         就地渲染就跟着弹框一起进 top layer。 -->
    <template v-else-if="open">
      <div class="cs-sheet__scrim">
        <div ref="sheet" class="cs-sheet" role="listbox" :aria-label="label">
          <span class="cs-sheet__grip" aria-hidden="true" />
          <p v-if="title || label" class="cs-sheet__title">{{ title || label }}</p>
          <p v-if="!filtered.length" class="cs__none">没有匹配项</p>
          <button
            v-for="o in filtered"
            :key="String(o.value)"
            type="button"
            class="cs-sheet__opt"
            role="option"
            :data-value="String(o.value)"
            :aria-selected="o.value === modelValue"
            :class="{ 'cs-sheet__opt--on': o.value === modelValue }"
            :disabled="o.disabled"
            @click="pick(o)"
          >
            <span class="cs__opt-main">
              <span class="cs__opt-label">{{ o.label }}</span>
              <span v-if="o.hint" class="cs__opt-hint">{{ o.hint }}</span>
            </span>
            <AppIcon
              v-if="o.value === modelValue"
              name="Check"
              class="cs__tick"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cs {
  position: relative;
  min-width: 0;
}
.cs__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cbx-space-2);
  width: 100%;
  min-height: 40px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text);
  text-align: left;
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  cursor: pointer;
}
/* free 模式的输入框触发器：和按钮触发器同一副外观，只是能打字 */
.cs__input {
  width: 100%;
  min-height: 40px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-sm);
}
.cs__trigger--compact {
  min-height: 30px;
  padding: 0 var(--cbx-space-2);
  font-size: var(--cbx-fs-xs);
}
.cs__trigger:hover:not(:disabled),
.cs__trigger--open {
  border-color: var(--cbx-brand);
}
.cs__trigger:disabled {
  color: var(--cbx-text-disabled);
  cursor: not-allowed;
}
.cs__trigger--ph .cs__value {
  color: var(--cbx-text-tertiary);
}
.cs__value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs__caret {
  flex-shrink: 0;
  color: var(--cbx-text-tertiary);
  transition: transform var(--cbx-transition);
}
.cs__trigger--open .cs__caret {
  transform: rotate(180deg);
}
/* 点空白关浮层：透明遮罩比监听 document 可靠，弹框里也不会漏 */
.cs__list {
  position: fixed;
  z-index: 31;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px;
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  box-shadow: var(--cbx-shadow-md);
  outline: none;
}
.cs__opt,
.cs-sheet__opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cbx-space-2);
  width: 100%;
  min-height: 36px;
  padding: 6px 10px;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text);
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: var(--cbx-radius-sm, 4px);
  cursor: pointer;
}
.cs__opt:hover,
.cs__opt:focus-visible {
  background: var(--cbx-bg-hover);
}
.cs__opt[aria-selected='true'] {
  color: var(--cbx-brand);
  background: var(--cbx-brand-light);
}
.cs__opt--active {
  background: var(--cbx-bg-hover);
}
.cs__none {
  margin: 0;
  padding: 8px 10px;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.cs__opt:disabled,
.cs-sheet__opt:disabled {
  color: var(--cbx-text-disabled);
  cursor: not-allowed;
}
.cs__opt-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.cs__opt-label {
  overflow-wrap: anywhere;
}
.cs__opt-hint {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  overflow-wrap: anywhere;
}
.cs__tick {
  flex-shrink: 0;
  color: var(--cbx-brand);
}
@media (max-width: 767px) {
  .cs__trigger,
  .cs__trigger--compact,
  .cs__input {
    min-height: var(--cbx-tap-min, 44px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .cs__caret {
    transition: none;
  }
}
</style>

<style>
/* 手机底部面板：跟其他底部动作面板同一套观感。
   非 scoped：它 Teleport 到 body，scoped 选择器够不着。 */
.cs-sheet__scrim {
  position: fixed;
  inset: 0;
  z-index: 150;
  display: flex;
  align-items: flex-end;
  background: var(--cbx-bg-mask);
}
.cs-sheet {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  /* 平板竖屏也是 hover:none，满宽的一排选项太散 */
  max-width: 520px;
  margin: 0 auto;
  max-height: 70vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--cbx-space-2);
  padding-bottom: max(var(--cbx-space-2), var(--cbx-safe-b));
  background: var(--cbx-bg);
  border-radius: var(--cbx-radius-lg) var(--cbx-radius-lg) 0 0;
}
.cs-sheet__grip {
  align-self: center;
  width: 36px;
  height: 4px;
  margin: 2px 0 var(--cbx-space-2);
  border-radius: 2px;
  background: var(--cbx-border-strong, var(--cbx-border));
}
.cs-sheet__title {
  margin: 0 var(--cbx-space-2) var(--cbx-space-1);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-secondary);
}
/* ⚠️ 选择器要带 .cs-sheet 提权：上面 scoped 里那条共享样式带 [data-v-x]，
   单靠 .cs-sheet__opt 压不过它，手机上选项行会矮成 36px、低于触控标准。 */
.cs-sheet .cs-sheet__opt {
  min-height: var(--cbx-tap-min, 44px);
}
.cs-sheet__opt:active {
  background: var(--cbx-bg-active);
}
.cs-sheet__opt--on {
  color: var(--cbx-brand);
  background: var(--cbx-brand-light);
}
</style>
