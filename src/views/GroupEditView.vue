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
  type Group,
  type GroupRelation,
} from '@/types/group'

const route = useRoute()
const router = useRouter()
const groups = useGroupsStore()
const chars = useCharactersStore()
const chats = useChatsStore()
const toast = useToast()

const model = ref<Group | null>(null)
const tab = ref<'members' | 'relations' | 'strategy'>('members')
const relView = ref<'list' | 'graph'>('list')
const editing = ref<GroupRelation | null>(null)

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
const candidates = computed(() =>
  chars.items.filter((c) => !(model.value?.members ?? []).includes(c.id)),
)
const nameOf = computed(() => new Map(memberChars.value.map((c) => [c.id, c.data.name])))

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
    await router.push('/characters')
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
  if (!m || memberChars.value.length < 2) return
  const f = from ?? memberChars.value[0]?.id
  const t = to ?? memberChars.value[1]?.id
  if (!f || !t) return
  const r: GroupRelation = { id: crypto.randomUUID(), from: f, to: t, label: '' }
  m.relations.push(r)
  editing.value = r
  // ⚠️ 必须落盘。model 是 toPlain() 出来的**编辑草稿**，不是 store 里的对象 ——
  // 只 push 不 save 的话，画布上确实会多一条边、编辑框也会弹出，
  // 但一离开本页草稿就没了，用户体感就是「按钮点了没用」。
  // 同目录的 removeRelation / addMember / toggleMove 都有 save()，唯独这里漏了。
  void save()
}
function removeRelation(id: string) {
  const m = model.value
  if (!m) return
  m.relations = m.relations.filter((r) => r.id !== id)
  if (editing.value?.id === id) editing.value = null
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
  await router.push('/characters')
}
</script>

<template>
  <AppTopbar :title="model?.name || '群聊'">
    <template #actions>
      <button class="cbx-btn cbx-btn--ghost" @click="router.push('/characters')">返回</button>
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
          <button
            v-if="memberChars.length >= 2"
            class="cbx-btn cbx-btn--soft"
            @click="addRelation()"
          >
            ＋ 添加关系
          </button>
        </div>

        <div v-if="memberChars.length < 2" class="cbx-empty">
          <span class="cbx-empty__desc">至少需要 2 个成员才能配置关系</span>
        </div>

        <template v-else>
          <RelationGraph
            v-if="relView === 'graph'"
            :members="memberChars.map((c) => ({ id: c.id, name: c.data.name }))"
            :relations="model.relations"
            :layout="model.layout"
            @update:layout="((model.layout = $event), save())"
            @edit-relation="editing = $event"
            @create-relation="addRelation"
          />

          <div v-else class="rel-list">
            <div v-if="!model.relations.length" class="cbx-empty">
              <span class="cbx-empty__desc">还没有关系</span>
            </div>
            <div v-for="r in model.relations" :key="r.id" class="rel">
              <select v-model="r.from" class="cbx-input rel__who" @change="save">
                <option v-for="c in memberChars" :key="c.id" :value="c.id">
                  {{ c.data.name }}
                </option>
              </select>
              <button class="cbx-icon-btn tiny" title="交换方向" @click="swapDirection(r)">
                ⇄
              </button>
              <select v-model="r.to" class="cbx-input rel__who" @change="save">
                <option v-for="c in memberChars" :key="c.id" :value="c.id">
                  {{ c.data.name }}
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

          <!-- 画布点边后的编辑框 -->
          <div v-if="editing" class="cbx-card editbox">
            <div class="editbox__head">
              {{ nameOf.get(editing.from) }} → {{ nameOf.get(editing.to) }}
              <button class="cbx-icon-btn tiny" @click="editing = null">✕</button>
            </div>
            <input
              v-model="editing.label"
              class="cbx-input"
              placeholder="关系，如：宿敌"
              @change="save"
            />
            <textarea
              v-model="editing.desc"
              class="cbx-textarea mt"
              rows="2"
              placeholder="补充描述（可选）"
              @change="save"
            />
            <div class="editbox__ops">
              <button class="cbx-btn cbx-btn--ghost sm" @click="swapDirection(editing)">
                ⇄ 交换方向
              </button>
              <button class="cbx-btn cbx-btn--ghost sm del" @click="removeRelation(editing.id)">
                删除
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
  width: 110px;
  flex-shrink: 0;
}
.rel__label {
  flex: 1;
}
.mt {
  margin-top: var(--cbx-space-3);
}
.editbox {
  margin-top: var(--cbx-space-4);
}
.editbox__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: var(--cbx-fw-medium);
  margin-bottom: var(--cbx-space-3);
}
.editbox__ops {
  display: flex;
  gap: var(--cbx-space-2);
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
