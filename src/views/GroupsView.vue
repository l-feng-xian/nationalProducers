<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import { useGroupsStore } from '@/stores/groups'
import { useCharactersStore } from '@/stores/characters'
import { useChatsStore } from '@/stores/chats'
import { useToast } from '@/composables/useToast'
import type { Group } from '@/types/group'
import { confirmDialog } from '@/composables/useConfirm'

const router = useRouter()
const groups = useGroupsStore()
const chars = useCharactersStore()
const chats = useChatsStore()
const toast = useToast()

onMounted(() => {
  if (!groups.loaded) void groups.load()
  // 成员头像要靠 characterId 反查，这页也得把角色载进来
  if (!chars.loaded) void chars.load()
})

/** 最多叠 4 个头像，再多用「+N」收口，否则成员一多卡片就被撑破 */
const MAX_FACES = 4

function faces(g: Group) {
  return g.members.slice(0, MAX_FACES).map((id) => {
    const c = chars.byId(id)
    return { id, name: c?.data.name ?? '?', blobId: c?.avatarBlobId }
  })
}

function overflow(g: Group): number {
  return Math.max(0, g.members.length - MAX_FACES)
}

/** 成员名连成一行做副标题。查不到的角色（被删了）显示为「?」而不是整行消失 */
function memberLine(g: Group): string {
  if (!g.members.length) return '还没有成员'
  return g.members.map((id) => chars.byId(id)?.data.name ?? '?').join('、')
}

async function create() {
  await router.push('/groups/new')
}

/**
 * 就地删除。文案与 GroupEditView 里那个删除保持一致 ——
 * 删群聊会连带删掉它的全部对话，这一点必须在确认框里讲明。
 */
async function remove(g: Group) {
  if (!(await confirmDialog({ text: `确定删除群聊「${g.name}」？其全部对话也会一并删除。` })))
    return
  await groups.remove(g.id)
  toast.success(`已删除「${g.name}」`)
}

/**
 * 与 GroupEditView 用同一条门槛：少于 2 个成员的群聊没有意义，
 * 发言人轮转逻辑也没法工作。在这里先拦住，比进了聊天页才报错好。
 */
async function startChat(g: Group) {
  if (g.members.length < 2) {
    toast.error('至少需要 2 个成员，先去编辑里添加')
    return
  }
  const meta = await chats.createGroup(g.id, g.name)
  await router.push(`/chat/${meta.id}`)
}
</script>

<template>
  <AppTopbar title="群聊">
    <template #actions>
      <button class="cbx-btn cbx-btn--primary" @click="create">
        <AppIcon name="Plus" /> 新建群聊
      </button>
    </template>
  </AppTopbar>

  <div class="cbx-scroll body">
    <div v-if="!groups.items.length" class="cbx-empty">
      <span class="cbx-empty__icon"><AppIcon name="UsersRound" tone="brand" /></span>
      <span class="cbx-empty__title">还没有群聊</span>
      <span class="cbx-empty__desc">
        群聊是 1vN 的多角色对话：把两个以上角色放进同一个场景，还能配置他们之间的关系
      </span>
    </div>

    <div v-else class="grid">
      <article v-for="g in groups.items" :key="g.id" class="card">
        <div class="card__top">
          <div class="faces">
            <!-- 没成员时给个占位，否则这一行只剩右侧一个 ✕ 悬着，是条空白 -->
            <span v-if="!g.members.length" class="faces__none" aria-hidden="true"
              ><AppIcon name="UsersRound" tone="brand"
            /></span>
            <CbxAvatar
              v-for="f in faces(g)"
              :key="f.id"
              class="faces__one"
              size="sm"
              :blob-id="f.blobId"
              :name="f.name"
            />
            <span v-if="overflow(g)" class="faces__more">+{{ overflow(g) }}</span>
          </div>
          <span v-if="g.fav" class="fav" title="已收藏"><AppIcon name="Star" /></span>
          <button class="cbx-icon-btn del" title="删除群聊" @click="remove(g)">
            <AppIcon name="X" tone="danger" />
          </button>
        </div>

        <h4 class="card__name">{{ g.name }}</h4>
        <p class="card__members">{{ memberLine(g) }}</p>

        <div class="chips">
          <span class="chip">{{ g.members.length }} 位成员</span>
          <span v-if="g.relations.length" class="chip">{{ g.relations.length }} 条关系</span>
          <span v-if="g.disabled_members.length" class="chip">
            {{ g.disabled_members.length }} 位静音
          </span>
        </div>

        <!-- margin-top:auto 把按钮钉在卡底，同一行卡片才会对齐 -->
        <div class="card__ops">
          <button class="cbx-btn cbx-btn--soft sm" @click="startChat(g)">开始聊天</button>
          <button class="cbx-btn cbx-btn--ghost sm" @click="router.push(`/groups/${g.id}`)">
            编辑
          </button>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--cbx-space-4);
}
.card {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-4);
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius);
  transition:
    box-shadow var(--cbx-transition),
    transform var(--cbx-transition);
}
@media (hover: hover) {
  .card:hover {
    box-shadow: var(--cbx-shadow-md);
    transform: translateY(-2px);
  }
}

.card__top {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
/* 头像互相压盖一部分，视觉上是「一群人」而不是「四个并排的头」 */
.faces {
  display: flex;
  align-items: center;
}
.faces__one {
  margin-right: -8px;
  border: 2px solid var(--cbx-bg);
  border-radius: var(--cbx-radius-pill);
}
.faces__none {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg-secondary);
  opacity: 0.6;
}
.faces__more {
  margin-left: calc(8px + var(--cbx-space-2));
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.fav {
  margin-left: auto;
  color: var(--cbx-warning);
}
/* 与侧栏会话项同一套手法：桌面 hover 才露出，触屏没有 hover 所以常驻半透明 */
.del {
  margin-left: auto;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  opacity: 0;
}
.fav + .del {
  margin-left: var(--cbx-space-1);
}
.card:hover .del {
  opacity: 1;
}
.del:hover {
  color: var(--cbx-error);
}
@media (hover: none) {
  .del {
    opacity: 0.5;
    width: var(--cbx-tap-min);
    height: var(--cbx-tap-min);
  }
}

.card__name {
  margin: 0;
  font-size: var(--cbx-fs-md);
  font-weight: var(--cbx-fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card__members {
  margin: 0;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  /* 成员多时截两行，别让卡片被一长串名字拉高 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.4em;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
.chip {
  padding: 2px var(--cbx-space-2);
  border-radius: var(--cbx-radius-sm);
  background: var(--cbx-bg-secondary);
  color: var(--cbx-text-secondary);
  font-size: var(--cbx-fs-xs);
  white-space: nowrap;
}

.card__ops {
  display: flex;
  gap: var(--cbx-space-2);
  margin-top: auto;
  padding-top: var(--cbx-space-2);
}
.sm {
  flex: 1;
  height: 32px;
  padding: 0 var(--cbx-space-2);
  font-size: var(--cbx-fs-xs);
}

@media (max-width: 767px) {
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
  .grid {
    grid-template-columns: 1fr;
  }
  .sm {
    height: var(--cbx-tap-min);
  }
}
</style>
