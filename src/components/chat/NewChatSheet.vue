<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import { useCharactersStore } from '@/stores/characters'
import { useChatsStore } from '@/stores/chats'
import { useGroupsStore } from '@/stores/groups'
import { useUiStore } from '@/stores/ui'

const router = useRouter()
const chars = useCharactersStore()
const chats = useChatsStore()
const groups = useGroupsStore()
const ui = useUiStore()

onMounted(() => {
  if (!chars.loaded) void chars.load()
  if (!groups.loaded) void groups.load()
})

async function pickGroup(groupId: string, title: string) {
  close()
  const meta = await chats.createGroup(groupId, title)
  await router.push(`/chat/${meta.id}`)
}

function goNewGroup() {
  close()
  void router.push('/groups/new')
}

function close() {
  ui.newChatOpen = false
}

/**
 * 注意：不要在模板里写多语句内联 handler。
 * oxfmt 会把分号去掉并折行，Vue 的表达式解析器随即失败 —— 而 vue-tsc 不报。
 */
function goCreate() {
  close()
  void router.push('/characters')
}

async function pick(characterId: string | undefined, title: string) {
  close()
  const meta = await chats.createSolo(characterId, title)
  await router.push(`/chat/${meta.id}`)
}
</script>

<template>
  <Teleport to="body">
    <div class="cbx-modal__scrim" @click.self="close">
      <div class="cbx-modal" role="dialog" aria-modal="true">
        <header class="cbx-modal__head">
          <h3>新建对话</h3>
          <button class="cbx-icon-btn" aria-label="关闭" @click="close">✕</button>
        </header>

        <div class="cbx-modal__body cbx-scroll">
          <div class="cbx-group-label">选择角色</div>

          <div v-if="!chars.items.length" class="cbx-empty">
            <span class="cbx-empty__icon">🎭</span>
            <span class="cbx-empty__desc">还没有角色</span>
            <button class="cbx-btn cbx-btn--soft" @click="goCreate">去创建角色</button>
          </div>

          <div v-for="c in chars.items" :key="c.id" class="row" @click="pick(c.id, c.data.name)">
            <CbxAvatar :blob-id="c.avatarBlobId" :name="c.data.name" size="sm" />
            <div class="row__text">
              <div class="row__name">{{ c.data.name }}</div>
              <div class="row__desc">{{ c.data.description || '（暂无简介）' }}</div>
            </div>
          </div>

          <hr class="cbx-divider" />
          <div class="cbx-group-label">群聊（1vN）</div>
          <div v-for="g in groups.items" :key="g.id" class="row" @click="pickGroup(g.id, g.name)">
            <div class="cbx-avatar cbx-avatar--sm cbx-avatar__fallback">👥</div>
            <div class="row__text">
              <div class="row__name">{{ g.name }}</div>
              <div class="row__desc">{{ g.members.length }} 位成员</div>
            </div>
          </div>
          <div class="row row--plain" @click="goNewGroup">
            <div class="cbx-avatar cbx-avatar--sm cbx-avatar__fallback">＋</div>
            <div class="row__text">
              <div class="row__name">新建群聊</div>
              <div class="row__desc">选多个角色，配置他们之间的关系</div>
            </div>
          </div>

          <hr class="cbx-divider" />
          <div class="row row--plain" @click="pick(undefined, '新对话')">
            <div class="cbx-avatar cbx-avatar--sm cbx-avatar__fallback">💬</div>
            <div class="row__text">
              <div class="row__name">不选角色</div>
              <div class="row__desc">用内置的通用助手直接聊</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-3);
  padding: var(--cbx-space-2) var(--cbx-space-3);
  border-radius: var(--cbx-radius-md);
  cursor: pointer;
  transition: background var(--cbx-transition);
}
.row:hover {
  background: var(--cbx-bg-hover);
}
.row__text {
  min-width: 0;
}
.row__name {
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
}
.row__desc {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cbx-empty .cbx-btn {
  margin-top: var(--cbx-space-2);
}
@media (max-width: 767px) {
  .row {
    min-height: var(--cbx-tap-min);
  }
}
</style>
