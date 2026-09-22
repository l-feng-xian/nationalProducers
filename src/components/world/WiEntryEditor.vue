<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import { computed, ref } from 'vue'
import {
  GENERATION_TYPE_TRIGGERS,
  world_info_logic,
  world_info_position,
  type WorldInfoEntry,
} from '@/types/worldinfo'

/**
 * 世界书条目编辑器。
 *
 * 完整对齐 ST 意味着有 40+ 个字段，一次全铺开（尤其移动端）会不可用。
 * 因此分层：**基础区常驻 + 6 个折叠区**；折叠标题带「已改」圆点，
 * 否则用户会忘了自己动过某个隐藏开关，然后调试半天。
 *
 * 三态字段（null = 继承全局）一律用显式三选，绝不用 checkbox 冒充 ——
 * checkbox 无法表达 null，会把「继承」静默写成 false，破坏语义并污染导出的 ST 世界书。
 *
 * 注：所有 handler 都抽成具名函数。Vue 模板里的多语句内联 handler
 * （尤其带换行的）无法解析，会直接编译失败。
 */
const props = defineProps<{ entry: WorldInfoEntry }>()
const emit = defineEmits<{ change: [] }>()

const open = ref<Record<string, boolean>>({})
function toggle(k: string) {
  open.value[k] = !open.value[k]
}

const POSITIONS = [
  { v: world_info_position.before, label: '角色卡之前' },
  { v: world_info_position.after, label: '角色卡之后' },
  { v: world_info_position.ANTop, label: '作者注释之前' },
  { v: world_info_position.ANBottom, label: '作者注释之后' },
  { v: world_info_position.atDepth, label: '指定深度' },
  { v: world_info_position.EMTop, label: '示例对话之前' },
  { v: world_info_position.EMBottom, label: '示例对话之后' },
  { v: world_info_position.outlet, label: '出口' },
]

const LOGICS = [
  { v: world_info_logic.AND_ANY, label: '并且 任一副键命中' },
  { v: world_info_logic.AND_ALL, label: '并且 全部副键命中' },
  { v: world_info_logic.NOT_ANY, label: '并且 任一副键都不中' },
  { v: world_info_logic.NOT_ALL, label: '并且 副键未全中' },
]

const TIMED_FIELDS = [
  { f: 'sticky', label: '粘滞' },
  { f: 'cooldown', label: '冷却' },
  { f: 'delay', label: '延迟' },
] as const

const isAtDepth = computed(() => props.entry.position === world_info_position.atDepth)
const isOutlet = computed(() => props.entry.position === world_info_position.outlet)

function keysText(list: string[]): string {
  return list.join(', ')
}
function setKeys(field: 'key' | 'keysecondary', ev: Event) {
  props.entry[field] = (ev.target as HTMLInputElement).value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  emit('change')
}

/** 三态字段：'null' | 'true' | 'false' → null | true | false */
type TriField = 'caseSensitive' | 'matchWholeWords' | 'useGroupScoring'
function setTri(field: TriField, ev: Event) {
  const v = (ev.target as HTMLSelectElement).value
  props.entry[field] = v === 'null' ? null : v === 'true'
  emit('change')
}

/** 可空数字字段：空串 → null（保住「未设置」与「设为 0」的区别） */
type NumField = 'scanDepth' | 'sticky' | 'cooldown' | 'delay'
function setNullableNum(field: NumField, ev: Event) {
  const v = (ev.target as HTMLInputElement).value
  props.entry[field] = v === '' ? null : Number(v)
  emit('change')
}

function setFilterNames(ev: Event) {
  props.entry.characterFilter.names = (ev.target as HTMLInputElement).value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  emit('change')
}

function toggleTrigger(t: (typeof GENERATION_TYPE_TRIGGERS)[number]) {
  const i = props.entry.triggers.indexOf(t)
  if (i >= 0) props.entry.triggers.splice(i, 1)
  else props.entry.triggers.push(t)
  emit('change')
}

// 各折叠区是否有非默认值 → 头部显示小圆点
const modified = computed(() => {
  const e = props.entry
  return {
    match:
      e.caseSensitive !== null ||
      e.matchWholeWords !== null ||
      e.scanDepth !== null ||
      e.matchPersonaDescription ||
      e.matchCharacterDescription ||
      e.matchCharacterPersonality ||
      e.matchCharacterDepthPrompt ||
      e.matchScenario ||
      e.matchCreatorNotes,
    recursion: e.excludeRecursion || e.preventRecursion || e.delayUntilRecursion > 0,
    budget: e.probability !== 100 || !e.useProbability || e.ignoreBudget,
    group: !!e.group,
    timed: e.sticky !== null || e.cooldown !== null || e.delay !== null,
    filter: e.triggers.length > 0 || e.characterFilter.names.length > 0,
  }
})
</script>

<template>
  <div class="editor">
    <!-- ═══ 基础区（常驻） ═══ -->
    <label class="cbx-field">
      <span class="cbx-field__label">条目标题</span>
      <input
        v-model="entry.comment"
        class="cbx-input"
        placeholder="仅自己看，不发给模型"
        @change="emit('change')"
      />
    </label>

    <label class="cbx-field">
      <span class="cbx-field__label">主关键词（逗号分隔，支持 /正则/）</span>
      <input
        class="cbx-input"
        :value="keysText(entry.key)"
        placeholder="龙, 巨龙, /飞龙|火龙/"
        @change="setKeys('key', $event)"
      />
    </label>

    <label class="cbx-field">
      <span class="cbx-field__label">内容（命中后注入提示词）</span>
      <textarea v-model="entry.content" class="cbx-textarea" rows="6" @change="emit('change')" />
    </label>

    <div class="grid3">
      <label class="cbx-field">
        <span class="cbx-field__label">插入位置</span>
        <select v-model.number="entry.position" class="cbx-input" @change="emit('change')">
          <option v-for="p in POSITIONS" :key="p.v" :value="p.v">{{ p.label }}</option>
        </select>
      </label>
      <label v-if="isAtDepth" class="cbx-field">
        <span class="cbx-field__label">深度</span>
        <input
          v-model.number="entry.depth"
          class="cbx-input"
          type="number"
          min="0"
          @change="emit('change')"
        />
      </label>
      <label v-if="isAtDepth" class="cbx-field">
        <span class="cbx-field__label">角色</span>
        <select v-model.number="entry.role" class="cbx-input" @change="emit('change')">
          <option :value="0">system</option>
          <option :value="1">user</option>
          <option :value="2">assistant</option>
        </select>
      </label>
      <label v-if="isOutlet" class="cbx-field">
        <span class="cbx-field__label">出口名</span>
        <input v-model="entry.outletName" class="cbx-input" @change="emit('change')" />
      </label>
      <label class="cbx-field">
        <span class="cbx-field__label">顺序 order（小的更靠前）</span>
        <input
          v-model.number="entry.order"
          class="cbx-input"
          type="number"
          @change="emit('change')"
        />
      </label>
    </div>

    <div class="switches">
      <label class="sw">
        <input v-model="entry.constant" type="checkbox" @change="emit('change')" />
        <span>常驻（无视关键词，每轮都注入）</span>
      </label>
      <label class="sw">
        <input v-model="entry.disable" type="checkbox" @change="emit('change')" />
        <span>禁用</span>
      </label>
    </div>

    <!-- ═══ 匹配与扫描 ═══ -->
    <div class="cbx-collapse">
      <button class="cbx-collapse__head" :aria-expanded="!!open['match']" @click="toggle('match')">
        <span>匹配与扫描 <i v-if="modified.match" class="dot" /></span>
        <AppIcon name="ChevronRight" :active="open['match']" />
      </button>
      <div v-show="open['match']" class="cbx-collapse__body">
        <label class="cbx-field">
          <span class="cbx-field__label">副关键词</span>
          <input
            class="cbx-input"
            :value="keysText(entry.keysecondary)"
            @change="setKeys('keysecondary', $event)"
          />
        </label>
        <label class="cbx-field">
          <span class="cbx-field__label">副键逻辑</span>
          <select v-model.number="entry.selectiveLogic" class="cbx-input" @change="emit('change')">
            <option v-for="l in LOGICS" :key="l.v" :value="l.v">{{ l.label }}</option>
          </select>
        </label>

        <div class="grid3">
          <label class="cbx-field">
            <span class="cbx-field__label">区分大小写</span>
            <select
              class="cbx-input"
              :value="String(entry.caseSensitive)"
              @change="setTri('caseSensitive', $event)"
            >
              <option value="null">继承全局</option>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">整词匹配</span>
            <select
              class="cbx-input"
              :value="String(entry.matchWholeWords)"
              @change="setTri('matchWholeWords', $event)"
            >
              <option value="null">继承全局</option>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">扫描深度</span>
            <input
              class="cbx-input"
              type="number"
              min="0"
              :value="entry.scanDepth ?? ''"
              placeholder="继承全局"
              @change="setNullableNum('scanDepth', $event)"
            />
          </label>
        </div>

        <div class="cbx-field__label">额外扫描这些内容</div>
        <div class="switches">
          <label class="sw">
            <input
              v-model="entry.matchCharacterDescription"
              type="checkbox"
              @change="emit('change')"
            />
            <span>角色简介</span>
          </label>
          <label class="sw">
            <input
              v-model="entry.matchCharacterPersonality"
              type="checkbox"
              @change="emit('change')"
            />
            <span>角色性格</span>
          </label>
          <label class="sw">
            <input v-model="entry.matchScenario" type="checkbox" @change="emit('change')" />
            <span>场景</span>
          </label>
          <label class="sw">
            <input
              v-model="entry.matchPersonaDescription"
              type="checkbox"
              @change="emit('change')"
            />
            <span>用户人设</span>
          </label>
          <label class="sw">
            <input
              v-model="entry.matchCharacterDepthPrompt"
              type="checkbox"
              @change="emit('change')"
            />
            <span>角色深度提示词</span>
          </label>
          <label class="sw">
            <input v-model="entry.matchCreatorNotes" type="checkbox" @change="emit('change')" />
            <span>创作者备注</span>
          </label>
        </div>
      </div>
    </div>

    <!-- ═══ 递归 ═══ -->
    <div class="cbx-collapse">
      <button
        class="cbx-collapse__head"
        :aria-expanded="!!open['recursion']"
        @click="toggle('recursion')"
      >
        <span>递归 <i v-if="modified.recursion" class="dot" /></span>
        <AppIcon name="ChevronRight" :active="open['recursion']" />
      </button>
      <div v-show="open['recursion']" class="cbx-collapse__body">
        <div class="switches">
          <label class="sw">
            <input v-model="entry.excludeRecursion" type="checkbox" @change="emit('change')" />
            <span>不可被递归激活</span>
          </label>
          <label class="sw">
            <input v-model="entry.preventRecursion" type="checkbox" @change="emit('change')" />
            <span>自身内容不触发别的条目</span>
          </label>
        </div>
        <label class="cbx-field">
          <span class="cbx-field__label">延迟到第 N 轮递归才可激活（0 = 不延迟）</span>
          <input
            v-model.number="entry.delayUntilRecursion"
            class="cbx-input"
            type="number"
            min="0"
            @change="emit('change')"
          />
        </label>
      </div>
    </div>

    <!-- ═══ 概率与预算 ═══ -->
    <div class="cbx-collapse">
      <button
        class="cbx-collapse__head"
        :aria-expanded="!!open['budget']"
        @click="toggle('budget')"
      >
        <span>概率与预算 <i v-if="modified.budget" class="dot" /></span>
        <AppIcon name="ChevronRight" :active="open['budget']" />
      </button>
      <div v-show="open['budget']" class="cbx-collapse__body">
        <label class="cbx-field">
          <span class="cbx-field__label">触发概率 {{ entry.probability }}%</span>
          <input
            v-model.number="entry.probability"
            class="cbx-input"
            type="number"
            min="0"
            max="100"
            @change="emit('change')"
          />
        </label>
        <div class="switches">
          <label class="sw">
            <input v-model="entry.useProbability" type="checkbox" @change="emit('change')" />
            <span>启用概率</span>
          </label>
          <label class="sw">
            <input v-model="entry.ignoreBudget" type="checkbox" @change="emit('change')" />
            <span>无视 token 预算</span>
          </label>
        </div>
      </div>
    </div>

    <!-- ═══ 包含组 ═══ -->
    <div class="cbx-collapse">
      <button class="cbx-collapse__head" :aria-expanded="!!open['group']" @click="toggle('group')">
        <span>包含组 <i v-if="modified.group" class="dot" /></span>
        <AppIcon name="ChevronRight" :active="open['group']" />
      </button>
      <div v-show="open['group']" class="cbx-collapse__body">
        <p class="tip">同组条目互相竞争，每轮只有一个胜出。可填多组，用逗号分隔。</p>
        <label class="cbx-field">
          <span class="cbx-field__label">组名</span>
          <input v-model="entry.group" class="cbx-input" @change="emit('change')" />
        </label>
        <div class="grid3">
          <label class="cbx-field">
            <span class="cbx-field__label">组内权重</span>
            <input
              v-model.number="entry.groupWeight"
              class="cbx-input"
              type="number"
              min="1"
              @change="emit('change')"
            />
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">组内评分</span>
            <select
              class="cbx-input"
              :value="String(entry.useGroupScoring)"
              @change="setTri('useGroupScoring', $event)"
            >
              <option value="null">继承全局</option>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          </label>
        </div>
        <label class="sw">
          <input v-model="entry.groupOverride" type="checkbox" @change="emit('change')" />
          <span>优先级覆盖（无视权重，本条恒定胜出）</span>
        </label>
      </div>
    </div>

    <!-- ═══ 定时效果 ═══ -->
    <div class="cbx-collapse">
      <button class="cbx-collapse__head" :aria-expanded="!!open['timed']" @click="toggle('timed')">
        <span>定时效果 <i v-if="modified.timed" class="dot" /></span>
        <AppIcon name="ChevronRight" :active="open['timed']" />
      </button>
      <div v-show="open['timed']" class="cbx-collapse__body">
        <p class="tip">
          留空 = 关闭。粘滞：触发后连续 N 条消息保持激活；冷却：失活后 N 条内不可再激活；
          延迟：会话前 N 条内不可激活。
        </p>
        <div class="grid3">
          <label v-for="t in TIMED_FIELDS" :key="t.f" class="cbx-field">
            <span class="cbx-field__label">{{ t.label }}</span>
            <input
              class="cbx-input"
              type="number"
              min="0"
              :value="entry[t.f] ?? ''"
              placeholder="关闭"
              @change="setNullableNum(t.f, $event)"
            />
          </label>
        </div>
      </div>
    </div>

    <!-- ═══ 触发条件 ═══ -->
    <div class="cbx-collapse">
      <button
        class="cbx-collapse__head"
        :aria-expanded="!!open['filter']"
        @click="toggle('filter')"
      >
        <span>触发条件 <i v-if="modified.filter" class="dot" /></span>
        <AppIcon name="ChevronRight" :active="open['filter']" />
      </button>
      <div v-show="open['filter']" class="cbx-collapse__body">
        <div class="cbx-field__label">限定生成类型（不选 = 不限）</div>
        <div class="chips">
          <button
            v-for="t in GENERATION_TYPE_TRIGGERS"
            :key="t"
            class="cbx-chip"
            :class="{ 'cbx-chip--active': entry.triggers.includes(t) }"
            @click="toggleTrigger(t)"
          >
            {{ t }}
          </button>
        </div>
        <label class="cbx-field">
          <span class="cbx-field__label">限定角色名（逗号分隔）</span>
          <input
            class="cbx-input"
            :value="entry.characterFilter.names.join(', ')"
            @change="setFilterNames($event)"
          />
        </label>
        <label class="sw">
          <input
            v-model="entry.characterFilter.isExclude"
            type="checkbox"
            @change="emit('change')"
          />
          <span>反向（改为「排除这些角色」）</span>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid3 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--cbx-space-3);
}
.switches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-3) var(--cbx-space-5);
  margin-bottom: var(--cbx-space-4);
}
.sw {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  cursor: pointer;
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: var(--cbx-space-1);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-brand);
  vertical-align: middle;
}
.tip {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  line-height: 1.6;
  margin-bottom: var(--cbx-space-3);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
  margin-bottom: var(--cbx-space-4);
}

@media (max-width: 767px) {
  .grid3 {
    grid-template-columns: 1fr;
  }
  .sw {
    min-height: var(--cbx-tap-min);
  }
}
</style>
