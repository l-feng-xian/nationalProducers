<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import RelationGraph from '@/components/group/RelationGraph.vue'
import { useGroupsStore } from '@/stores/groups'
import { useCharactersStore } from '@/stores/characters'
import { useChatsStore } from '@/stores/chats'
import { useToast } from '@/composables/useToast'
import { toPlain } from '@/utils/plain'
import {
  group_activation_strategy,
  group_generation_mode,
  resolvePersona,
  USER_NODE_ID,
  type Group,
  type GroupRelation,
} from '@/types/group'
import { useSettingsStore } from '@/stores/settings'

const route = useRoute()
const router = useRouter()
const groups = useGroupsStore()
const chars = useCharactersStore()
const chats = useChatsStore()
const toast = useToast()

const model = ref<Group | null>(null)
const tab = ref<'members' | 'relations' | 'strategy'>('members')
const relView = ref<'list' | 'graph'>('list')

const STRATEGIES = [
  {
    v: group_activation_strategy.NATURAL,
    label: '自然顺序',
    desc: '按发言意愿掷骰，被点名优先，可能多人同时发言',
  },
  { v: group_activation_strategy.LIST, label: '列表顺序', desc: '每个成员依次各发言一次' },
  { v: group_activation_strategy.POOLED, label: '轮流', desc: '每轮一人，优先挑还没说过话的' },
  { v: group_activation_strategy.MANUAL, label: '手动', desc: '不自动回复，你点名谁谁才说话' },
]

const MODES = [
  { v: group_generation_mode.SWAP, label: '只用当前发言者的卡', desc: '最省 token，推荐' },
  {
    v: group_generation_mode.APPEND,
    label: '拼接所有未静音成员的卡',
    desc: '角色更了解彼此，但更费 token',
  },
  { v: group_generation_mode.APPEND_DISABLED, label: '拼接全部成员的卡（含静音）', desc: '' },
]

const memberChars = computed(() =>
  (model.value?.members ?? [])
    .map((id) => chars.byId(id))
    .filter((c): c is NonNullable<typeof c> => !!c),
)

const settings = useSettingsStore()

/** 模板里要显示字面的 {{user}}，不能直接写 —— Vue 会在内层 }} 提前闭合插值 */
const USER_MACRO = '{{user}}'

/** 本群聊实际生效的「我」—— 群聊留空就显示全局人设的值，让用户看得见回落结果 */
const effectivePersona = computed(() =>
  resolvePersona(model.value ?? undefined, settings.settings.persona),
)

/**
 * 关系图谱的节点集合 = 用户自己 + 全体成员。
 *
 * 用户排在最前：他是玩家视角的锚点，画布初始布局按顺序排圆周，放第一个
 * 位置最稳定。列表视图的下拉也跟着这个顺序，「我」永远是第一项。
 */
const relationNodes = computed(() => [
  { id: USER_NODE_ID, name: effectivePersona.value.name, isUser: true },
  ...memberChars.value.map((c) => ({ id: c.id, name: c.data.name, isUser: false })),
])
const candidates = computed(() =>
  chars.items.filter((c) => !(model.value?.members ?? []).includes(c.id)),
)

onMounted(async () => {
  if (!chars.loaded) await chars.load()
  if (!groups.loaded) await groups.load()
  const id = route.params['id']
  const gid = Array.isArray(id) ? id[0] : id

  if (gid === 'new') {
    const g = await groups.create()
    await router.replace(`/groups/${g.id}`)
    model.value = toPlain(g)
    return
  }
  const found = gid ? groups.byId(gid) : undefined
  if (!found) {
    toast.error('群聊不存在')
    // 群聊已经有独立的 tab 页了，找不到时回群聊列表，别再甩到角色页
    await router.push('/groups')
    return
  }
  model.value = toPlain(found)
})

async function save() {
  if (!model.value) return
  await groups.save(model.value)
  toast.success('已保存')
}

function addMember(id: string) {
  const m = model.value
  if (!m || m.members.includes(id)) return
  m.members.push(id)
  void save()
}
function removeMember(id: string) {
  const m = model.value
  if (!m) return
  m.members = m.members.filter((x) => x !== id)
  m.disabled_members = m.disabled_members.filter((x) => x !== id)
  // 成员移除时同时清掉它的关系边与坐标，否则图谱会渲染悬空节点
  m.relations = m.relations.filter((r) => r.from !== id && r.to !== id)
  delete m.layout[id]
  void save()
}
function toggleMute(id: string) {
  const m = model.value
  if (!m) return
  const i = m.disabled_members.indexOf(id)
  if (i >= 0) m.disabled_members.splice(i, 1)
  else m.disabled_members.push(id)
  void save()
}
function move(id: string, dir: -1 | 1) {
  const m = model.value
  if (!m) return
  const i = m.members.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= m.members.length) return
  const a = m.members[i]
  const b = m.members[j]
  if (a === undefined || b === undefined) return
  m.members[i] = b
  m.members[j] = a
  void save()
}

function addRelation(from?: string, to?: string) {
  const m = model.value
  // 节点集合含「我」，所以 1 个成员就够凑出一条边
  if (!m || relationNodes.value.length < 2) return
  // 默认取「我 → 第一个成员」：沉浸式群聊里用户最想先定的就是自己跟谁什么关系
  const f = from ?? relationNodes.value[0]?.id
  const t = to ?? relationNodes.value[1]?.id
  if (!f || !t) return
  const r: GroupRelation = { id: crypto.randomUUID(), from: f, to: t, label: '' }
  m.relations.push(r)
  // ⚠️ 必须落盘。model 是 toPlain() 出来的**编辑草稿**，不是 store 里的对象 ——
  // 只 push 不 save 的话，画布上确实会多一条边、编辑框也会弹出，
  // 但一离开本页草稿就没了，用户体感就是「按钮点了没用」。
  // 同目录的 removeRelation / addMember / toggleMove 都有 save()，唯独这里漏了。
  void save()
}
/** 画布拖完节点后回传坐标 */
function onLayout(layout: Group['layout']) {
  const m = model.value
  if (!m) return
  m.layout = layout
  void save()
}
function removeRelation(id: string) {
  const m = model.value
  if (!m) return
  m.relations = m.relations.filter((r) => r.id !== id)
  void save()
}
function swapDirection(r: GroupRelation) {
  const from = r.from
  r.from = r.to
  r.to = from
  void save()
}

async function startChat() {
  const m = model.value
  if (!m) return
  if (m.members.length < 2) {
    toast.error('至少需要 2 个成员')
    return
  }
  await save()
  const meta = await chats.createGroup(m.id, m.name)
  await router.push(`/chat/${meta.id}`)
}

async function removeGroup() {
  const m = model.value
  if (!m) return
  if (!confirm(`确定删除群聊「${m.name}」？其全部对话也会一并删除。`)) return
  await groups.remove(m.id)
  toast.success('已删除')
  await router.push('/groups')
}
</script>

<template>
  <AppTopbar :title="model?.name || '群聊'">
    <template #actions>
      <button class="cbx-btn cbx-btn--ghost" @click="router.push('/groups')">返回</button>
      <button class="cbx-btn cbx-btn--soft" @click="startChat">开始群聊</button>
      <button class="cbx-btn cbx-btn--primary" @click="save">保存</button>
    </template>
  </AppTopbar>

  <div v-if="model" class="cbx-scroll body">
    <div class="cbx-form-col">
      <label class="cbx-field cbx-field--md">
        <span class="cbx-field__label">群聊名</span>
        <input v-model="model.name" class="cbx-input" @change="save" />
      </label>

      <div class="cbx-tabs">
        <button
          class="cbx-tab"
          :class="{ 'cbx-tab--active': tab === 'members' }"
          @click="tab = 'members'"
        >
          成员
          <span v-if="model.members.length" class="cbx-badge cbx-badge--brand">{{
            model.members.length
          }}</span>
        </button>
        <button
          class="cbx-tab"
          :class="{ 'cbx-tab--active': tab === 'relations' }"
          @click="tab = 'relations'"
        >
          关系图谱
          <span v-if="model.relations.length" class="cbx-badge cbx-badge--brand">{{
            model.relations.length
          }}</span>
        </button>
        <button
          class="cbx-tab"
          :class="{ 'cbx-tab--active': tab === 'strategy' }"
          @click="tab = 'strategy'"
        >
          发言策略
        </button>
      </div>

      <!-- 成员 -->
      <section v-show="tab === 'members'" class="pane">
        <!-- 「我」也是这场戏里的一个参与者，所以放在成员列表最上面而不是塞进设置页：
             全局人设是跨所有对话的默认值，这里配的是**只在这个群聊里**的身份 -->
        <div class="me">
          <div class="me__head">
            <span class="me__icon">🙋</span>
            <span class="cbx-field__label">我扮演的角色</span>
            <span v-if="!model.persona.name && !model.persona.description" class="cbx-badge">
              沿用全局人设
            </span>
          </div>
          <p class="cbx-field__hint">
            只作用于本群聊。留空则沿用设置里的全局人设（当前为「{{
              settings.settings.persona.name
            }}」）。这里填的名字就是提示词里的
            {{ USER_MACRO }}，也会作为关系图谱里「我」这个节点的名字。
          </p>
          <input
            v-model="model.persona.name"
            class="cbx-input"
            :placeholder="settings.settings.persona.name || '我'"
            @change="save"
          />
          <textarea
            v-model="model.persona.description"
            class="cbx-textarea me__desc"
            rows="3"
            :placeholder="
              settings.settings.persona.description ||
              '你在这个场景里是谁、什么身份、和大家什么渊源'
            "
            @change="save"
          />
        </div>

        <div class="cbx-divider" />

        <div v-if="!memberChars.length" class="cbx-empty">
          <span class="cbx-empty__desc">还没有成员，从下面添加</span>
        </div>
        <div v-for="(c, i) in memberChars" :key="c.id" class="member">
          <CbxAvatar :blob-id="c.avatarBlobId" :name="c.data.name" size="sm" />
          <span class="member__name" :class="{ muted: model.disabled_members.includes(c.id) }">
            {{ c.data.name }}
          </span>
          <span v-if="model.disabled_members.includes(c.id)" class="cbx-badge cbx-badge--warning">
            静音
          </span>
          <div class="member__ops">
            <button
              class="cbx-icon-btn tiny"
              title="上移"
              :disabled="i === 0"
              @click="move(c.id, -1)"
            >
              ↑
            </button>
            <button
              class="cbx-icon-btn tiny"
              title="下移"
              :disabled="i === memberChars.length - 1"
              @click="move(c.id, 1)"
            >
              ↓
            </button>
            <button class="cbx-icon-btn tiny" title="静音/取消" @click="toggleMute(c.id)">
              🔇
            </button>
            <button class="cbx-icon-btn tiny" title="移除" @click="removeMember(c.id)">✕</button>
          </div>
        </div>

        <div class="cbx-divider" />
        <div class="cbx-field__label">添加成员</div>
        <div v-if="!candidates.length" class="cbx-field__hint">没有可添加的角色了</div>
        <div class="chips">
          <button v-for="c in candidates" :key="c.id" class="cbx-chip" @click="addMember(c.id)">
            ＋ {{ c.data.name }}
          </button>
        </div>
      </section>

      <!-- 关系图谱 -->
      <section v-show="tab === 'relations'" class="pane">
        <p class="tip">
          关系是<strong>有向</strong>的：「A 对 B」与「B 对 A」是两条独立的关系，可以完全不同 （比如
          A 暗恋 B，而 B 只把 A 当妹妹）。这些关系会拼进 1vN 的约束提示词。
        </p>

        <!-- 「添加关系」与视图切换同排、放在内容**上方**：
             原来它在画布/列表之后，420px 的画布把它顶到屏幕外，
             用户经常找不到，看起来就像没有这个功能 -->
        <div class="relbar">
          <div class="cbx-seg viewseg">
            <button
              class="cbx-seg__btn"
              :class="{ 'cbx-seg__btn--active': relView === 'list' }"
              @click="relView = 'list'"
            >
              列表
            </button>
            <button
              class="cbx-seg__btn"
              :class="{ 'cbx-seg__btn--active': relView === 'graph' }"
              @click="relView = 'graph'"
            >
              画布
            </button>
          </div>
          <!-- 画布视图不放这个按钮：在画布上从节点的 ＋ 拉一条线到另一个节点
               就是添加关系，再摆个按钮反而多余。
               列表视图没有连线这个动作，必须保留，否则列表用户根本没法新增。 -->
          <button
            v-if="relView === 'list' && relationNodes.length >= 2"
            class="cbx-btn cbx-btn--soft"
            @click="addRelation()"
          >
            ＋ 添加关系
          </button>
        </div>

        <!-- 门槛按**节点数**算而不是成员数：加进「我」之后，1 个角色就能配
             「我 对 她：师徒」，不必等到凑够两个角色 -->
        <div v-if="relationNodes.length < 2" class="cbx-empty">
          <span class="cbx-empty__desc">至少添加 1 个成员才能配置关系</span>
        </div>

        <template v-else>
          <RelationGraph
            v-if="relView === 'graph'"
            :members="relationNodes"
            :relations="model.relations"
            :layout="model.layout"
            @update:layout="onLayout"
            @create-relation="addRelation"
            @change="save"
            @remove-relation="removeRelation"
            @swap-relation="swapDirection"
          />

          <div v-else class="rel-list">
            <div v-if="!model.relations.length" class="cbx-empty">
              <span class="cbx-empty__desc">还没有关系</span>
            </div>
            <div v-for="r in model.relations" :key="r.id" class="rel">
              <select v-model="r.from" class="cbx-input rel__who" @change="save">
                <option v-for="n in relationNodes" :key="n.id" :value="n.id">
                  {{ n.isUser ? `${n.name}（我）` : n.name }}
                </option>
              </select>
              <button class="cbx-icon-btn tiny" title="交换方向" @click="swapDirection(r)">
                ⇄
              </button>
              <select v-model="r.to" class="cbx-input rel__who" @change="save">
                <option v-for="n in relationNodes" :key="n.id" :value="n.id">
                  {{ n.isUser ? `${n.name}（我）` : n.name }}
                </option>
              </select>
              <input
                v-model="r.label"
                class="cbx-input rel__label"
                placeholder="关系，如：青梅竹马"
                @change="save"
              />
              <button class="cbx-icon-btn tiny" title="删除" @click="removeRelation(r.id)">
                ✕
              </button>
            </div>
          </div>
        </template>
      </section>

      <!-- 发言策略 -->
      <section v-show="tab === 'strategy'" class="pane">
        <div class="cbx-field__label">谁来发言</div>
        <label v-for="s in STRATEGIES" :key="s.v" class="opt">
          <input
            v-model.number="model.activation_strategy"
            type="radio"
            :value="s.v"
            @change="save"
          />
          <span>
            <strong>{{ s.label }}</strong>
            <em>{{ s.desc }}</em>
          </span>
        </label>

        <div class="cbx-divider" />
        <div class="cbx-field__label">角色卡怎么给模型</div>
        <label v-for="m in MODES" :key="m.v" class="opt">
          <input v-model.number="model.generation_mode" type="radio" :value="m.v" @change="save" />
          <span>
            <strong>{{ m.label }}</strong>
            <em>{{ m.desc }}</em>
          </span>
        </label>

        <div class="cbx-divider" />
        <label class="opt">
          <input v-model="model.allow_self_responses" type="checkbox" @change="save" />
          <span><strong>允许连续发言</strong><em>同一角色可以连着说两次</em></span>
        </label>
        <label class="opt">
          <input v-model="model.mergeMemberBooks" type="checkbox" @change="save" />
          <span>
            <strong>合并成员世界书</strong>
            <em>默认只用当前发言者的世界书（同 SillyTavern）；勾选后取全体并集</em>
          </span>
        </label>

        <div class="danger">
          <button class="cbx-btn cbx-btn--ghost del" @click="removeGroup">删除群聊</button>
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
/* 与设置页统一：模板里 class="wrap" → class="cbx-form-col"，本规则整条删除。
   「群聊名」原本是全项目最宽的短字段（满 820px），标 --md 后收到 400px。 */
.pane {
  padding-top: var(--cbx-space-5);
}
.tip {
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  line-height: 1.6;
  margin-bottom: var(--cbx-space-4);
}
.member {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-3);
  padding: var(--cbx-space-2);
  border-radius: var(--cbx-radius-md);
}
.member:hover {
  background: var(--cbx-bg-hover);
}
.member__name {
  flex: 1;
  font-size: var(--cbx-fs-sm);
}
.member__name.muted {
  color: var(--cbx-text-tertiary);
  text-decoration: line-through;
}
.member__ops {
  display: flex;
  gap: 2px;
}
.tiny {
  width: 28px;
  height: 28px;
  font-size: var(--cbx-fs-xs);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
/* 视图切换 + 添加关系 同排，贴在内容上方 */
.relbar {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-3);
  flex-wrap: wrap;
  margin-bottom: var(--cbx-space-3);
}
.relbar .cbx-btn {
  margin-left: auto;
}
.viewseg {
  margin-bottom: 0;
}
.rel {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  margin-bottom: var(--cbx-space-2);
}
.rel__who {
  /* 加进「我」之后选项里会出现「名字（我）」，110px 装不下，放宽一档 */
  width: 132px;
  flex-shrink: 0;
}
.rel__label {
  flex: 1;
}

.me {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
}
.me__head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
.me__icon {
  font-size: var(--cbx-fs-lg);
}
.me__desc {
  resize: vertical;
}
.mt {
  margin-top: var(--cbx-space-3);
}
.sm {
  height: 30px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
.opt {
  display: flex;
  align-items: flex-start;
  gap: var(--cbx-space-3);
  padding: var(--cbx-space-2) 0;
  cursor: pointer;
}
.opt strong {
  display: block;
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
}
.opt em {
  display: block;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  font-style: normal;
}
.danger {
  margin-top: var(--cbx-space-6);
  padding-top: var(--cbx-space-4);
  border-top: 1px solid var(--cbx-border);
}
.del {
  color: var(--cbx-error);
}

@media (max-width: 767px) {
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
  .rel {
    flex-wrap: wrap;
  }
  .rel__who {
    width: calc(50% - 20px);
  }
  .rel__label {
    width: 100%;
    flex: none;
  }
  .tiny {
    width: var(--cbx-tap-min);
    height: var(--cbx-tap-min);
  }
}
</style>
