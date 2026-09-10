<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import GreetingsEditor from '@/components/character/GreetingsEditor.vue'
import ExampleDialogueEditor from '@/components/character/ExampleDialogueEditor.vue'
import { useCharactersStore } from '@/stores/characters'
import { useChatsStore } from '@/stores/chats'
import { useWorldsStore } from '@/stores/worlds'
import { useToast } from '@/composables/useToast'
import { blobsRepo } from '@/db/repositories'
import { invalidateObjectUrl } from '@/composables/useObjectUrl'
import { exportCharacterJson } from '@/services/io/characterCard'
import { exportCharacterPng } from '@/services/io/characterPng'
import { downloadBlob, safeFileName } from '@/utils/download'
import { toPlain } from '@/utils/plain'
import { DEPTH_PROMPT_DEPTH_DEFAULT, type Character } from '@/types/character'

const route = useRoute()
const router = useRouter()
const chars = useCharactersStore()
const chats = useChatsStore()
const worlds = useWorldsStore()
const toast = useToast()

/** 模板里要显示字面的宏，不能直接写 —— Vue 会在内层 }} 提前闭合插值 */
const CHAR_MACRO = '{{char}}'

const model = ref<Character | null>(null)
const tab = ref<'basic' | 'greetings' | 'examples' | 'advanced'>('basic')
const avatarInput = ref<HTMLInputElement | null>(null)
const saving = ref(false)
/** PNG 导出要转码 + 编码，可能几百毫秒；连点会并发跑两遍、下两个文件、内存峰值翻倍 */
const exporting = ref(false)
let dirty = false

const TABS = [
  { key: 'basic', label: '基本' },
  { key: 'greetings', label: '开场白' },
  { key: 'examples', label: '对话示例' },
  { key: 'advanced', label: '高级' },
] as const

const title = computed(() => model.value?.data.name || '编辑角色')
const greetingCount = computed(() => {
  const m = model.value
  if (!m) return 0
  return [m.data.first_mes, ...m.data.alternate_greetings].filter((g) => g && g.trim()).length
})

onMounted(async () => {
  if (!chars.loaded) await chars.load()
  if (!worlds.loaded) await worlds.load()
  const id = route.params['id']
  const cid = Array.isArray(id) ? id[0] : id
  const found = cid ? chars.byId(cid) : undefined
  if (!found) {
    toast.error('角色不存在')
    await router.push('/characters')
    return
  }
  // 深拷贝一份编辑草稿，避免未保存的改动直接污染列表。
  // 必须用 toPlain 而非 structuredClone —— found 是 Vue reactive 代理，克隆会抛异常。
  const draft = toPlain(found)
  // 导入的卡片可能没有 depth_prompt，补齐后模板才能安全双向绑定
  draft.data.extensions.depth_prompt ??= {
    prompt: '',
    depth: DEPTH_PROMPT_DEPTH_DEFAULT,
    role: 'system',
  }
  model.value = draft
})

watch(
  model,
  () => {
    dirty = true
  },
  { deep: true },
)

async function save() {
  if (!model.value) return
  saving.value = true
  try {
    await chars.save(model.value)
    dirty = false
    toast.success('已保存')
  } finally {
    saving.value = false
  }
}

async function onAvatar(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f || !model.value) return
  const old = model.value.avatarBlobId
  const id = await blobsRepo.put(f)
  model.value.avatarBlobId = id
  if (old) {
    invalidateObjectUrl(old)
    await blobsRepo.remove(old)
  }
  await save()
  ;(e.target as HTMLInputElement).value = ''
}

async function startChat() {
  if (!model.value) return
  if (dirty) await save()
  const meta = await chats.createSolo(model.value.id, model.value.data.name)
  await router.push(`/chat/${meta.id}`)
}

async function exportJson() {
  const m = model.value
  if (!m) return
  downloadBlob(await exportCharacterJson(m), safeFileName(m.data.name, 'json'))
}

async function exportPng() {
  const m = model.value
  if (!m || exporting.value) return
  exporting.value = true
  try {
    // 导出的是库里的角色，未保存的改动不会进卡里 —— 先落盘再导
    if (dirty) await save()
    const { blob, notice } = await exportCharacterPng(m)
    downloadBlob(blob, safeFileName(m.data.name, 'png'))
    if (notice) toast.warning(notice)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    exporting.value = false
  }
}

function toggleBook(id: string) {
  const m = model.value
  if (!m) return
  const i = m.worldBookIds.indexOf(id)
  if (i >= 0) m.worldBookIds.splice(i, 1)
  else m.worldBookIds.push(id)
}

async function remove() {
  if (!model.value) return
  if (!confirm(`确定删除角色「${model.value.data.name}」？其全部对话也会一并删除。`)) return
  await chars.remove(model.value.id)
  toast.success('已删除')
  await router.push('/characters')
}
</script>

<template>
  <AppTopbar :title="title">
    <template #actions>
      <button class="cbx-btn cbx-btn--ghost" @click="router.push('/characters')">返回</button>
      <button class="cbx-btn cbx-btn--soft" @click="startChat">开始聊天</button>
      <button class="cbx-btn cbx-btn--primary" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </AppTopbar>

  <div v-if="model" class="cbx-scroll body">
    <div class="cbx-form-col">
      <div class="cbx-tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="cbx-tab"
          :class="{ 'cbx-tab--active': tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
          <span
            v-if="t.key === 'greetings' && greetingCount > 1"
            class="cbx-badge cbx-badge--brand"
          >
            {{ greetingCount }}
          </span>
        </button>
      </div>

      <!-- 基本 -->
      <section v-show="tab === 'basic'" class="pane">
        <div class="head">
          <div class="avatar-col">
            <CbxAvatar :blob-id="model.avatarBlobId" :name="model.data.name" card />
            <button class="cbx-btn cbx-btn--ghost full" @click="avatarInput?.click()">
              更换图片
            </button>
            <input ref="avatarInput" type="file" accept="image/*" hidden @change="onAvatar" />
          </div>
          <div class="fields">
            <label class="cbx-field cbx-field--md">
              <span class="cbx-field__label">角色名</span>
              <input v-model="model.data.name" class="cbx-input" placeholder="例：铃" />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">角色简介</span>
              <textarea
                v-model="model.data.description"
                class="cbx-textarea"
                rows="6"
                placeholder="外貌、身份、背景……这是最重要的字段，模型主要靠它理解角色。"
              />
            </label>
          </div>
        </div>

        <label class="cbx-field">
          <span class="cbx-field__label">性格</span>
          <textarea
            v-model="model.data.personality"
            class="cbx-textarea"
            rows="3"
            placeholder="例：沉默寡言，嘴硬心软，讨厌被人看穿。"
          />
        </label>

        <label class="cbx-field">
          <span class="cbx-field__label">场景</span>
          <textarea
            v-model="model.data.scenario"
            class="cbx-textarea"
            rows="3"
            placeholder="故事发生的时间、地点与处境。"
          />
        </label>
      </section>

      <!-- 开场白 -->
      <section v-show="tab === 'greetings'" class="pane">
        <GreetingsEditor
          :first-mes="model.data.first_mes"
          :alternates="model.data.alternate_greetings"
          @update:first-mes="model.data.first_mes = $event"
          @update:alternates="model.data.alternate_greetings = $event"
        />
      </section>

      <!-- 对话示例 -->
      <section v-show="tab === 'examples'" class="pane">
        <ExampleDialogueEditor v-model="model.data.mes_example" />
      </section>

      <!-- 高级 -->
      <section v-show="tab === 'advanced'" class="pane">
        <label class="cbx-field">
          <span class="cbx-field__label">角色专属主提示词（覆盖全局）</span>
          <textarea v-model="model.data.system_prompt" class="cbx-textarea" rows="3" />
        </label>

        <label class="cbx-field">
          <span class="cbx-field__label">后置指令（放在全部历史之后）</span>
          <textarea v-model="model.data.post_history_instructions" class="cbx-textarea" rows="3" />
        </label>

        <div class="grid2">
          <label class="cbx-field">
            <span class="cbx-field__label">
              发言意愿 {{ model.data.extensions.talkativeness }}
            </span>
            <input
              v-model.number="model.data.extensions.talkativeness"
              class="cbx-input"
              type="number"
              step="0.05"
              min="0"
              max="1"
            />
            <span class="cbx-field__hint">1vN「自然顺序」策略下的发言概率，0~1</span>
          </label>
          <label class="cbx-field cbx-field--sm">
            <span class="cbx-field__label">角色版本</span>
            <input v-model="model.data.character_version" class="cbx-input" />
          </label>
        </div>

        <div class="cbx-collapse">
          <div class="cbx-collapse__head">深度提示词（每轮插入到历史指定深度）</div>
          <div class="cbx-collapse__body">
            <textarea
              v-model="model.data.extensions.depth_prompt!.prompt"
              class="cbx-textarea"
              rows="3"
              :placeholder="`例：[记住：${CHAR_MACRO} 此刻正在发烧，说话有气无力。]`"
            />
            <div class="grid2 mt">
              <label class="cbx-field">
                <span class="cbx-field__label">深度</span>
                <input
                  v-model.number="model.data.extensions.depth_prompt!.depth"
                  class="cbx-input"
                  type="number"
                  min="0"
                  :placeholder="String(DEPTH_PROMPT_DEPTH_DEFAULT)"
                />
              </label>
              <label class="cbx-field">
                <span class="cbx-field__label">角色</span>
                <select v-model="model.data.extensions.depth_prompt!.role" class="cbx-input">
                  <option value="system">system</option>
                  <option value="user">user</option>
                  <option value="assistant">assistant</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <div class="cbx-field">
          <span class="cbx-field__label">角色世界书（需求 5：与角色关联）</span>
          <div v-if="!worlds.items.length" class="cbx-field__hint">
            还没有世界书，先到「世界书」页创建
          </div>
          <div class="chips">
            <button
              v-for="b in worlds.items"
              :key="b.id"
              class="cbx-chip"
              :class="{ 'cbx-chip--active': model.worldBookIds.includes(b.id) }"
              @click="toggleBook(b.id)"
            >
              {{ b.name }}
            </button>
          </div>
        </div>

        <label class="cbx-field">
          <span class="cbx-field__label">创作者备注（不发给模型）</span>
          <textarea v-model="model.data.creator_notes" class="cbx-textarea" rows="2" />
        </label>

        <div class="ops">
          <!-- PNG 在先：社区（SillyTavern / 各卡站）互相分享角色卡用的都是 PNG，
               JSON 主要用于自己排查或程序处理 -->
          <button class="cbx-btn cbx-btn--soft" :disabled="exporting" @click="exportPng">
            {{ exporting ? '导出中…' : '导出角色卡 PNG' }}
          </button>
          <button class="cbx-btn cbx-btn--ghost" :disabled="exporting" @click="exportJson">
            导出 JSON
          </button>
          <button class="cbx-btn cbx-btn--ghost del" @click="remove">删除角色</button>
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
/* 与设置页统一：宽度/对齐/字段上限由 base.css 的 .cbx-form-col 提供
   （模板里 class="wrap" → class="cbx-form-col"，本规则整条删除）。
   本页 .pane 没有 .cbx-card 底色，820 的边界本来就不可见，
   左对齐 + 字段收窄后视觉锚点反而更清楚。 */
.pane {
  padding-top: var(--cbx-space-5);
}
.head {
  display: flex;
  gap: var(--cbx-space-5);
  margin-bottom: var(--cbx-space-4);
}
.avatar-col {
  width: 160px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
}
.full {
  width: 100%;
}
.fields {
  flex: 1;
  min-width: 0;
}
.grid2 {
  display: grid;
  /* auto-fill 而非 auto-fit：auto-fit 会折叠空轨道，把 2 项的网格各拉到约 400px */
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--cbx-space-3);
}
.mt {
  margin-top: var(--cbx-space-3);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
.ops {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
  margin-top: var(--cbx-space-6);
  padding-top: var(--cbx-space-4);
  border-top: 1px solid var(--cbx-border);
}
/* 删除推到最右，跟两个导出按钮拉开距离，避免误点 */
.ops .del {
  margin-left: auto;
}
.del {
  color: var(--cbx-error);
}

@media (max-width: 767px) {
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
  .head {
    flex-direction: column;
  }
  .avatar-col {
    width: 140px;
    align-self: center;
  }
  /* 三个按钮在 375px 下并排会被压成两三个字，各占一整行更好点 */
  .ops .cbx-btn {
    width: 100%;
  }
  .ops .del {
    margin-left: 0;
  }
  .grid2 {
    grid-template-columns: 1fr;
  }
}
</style>
