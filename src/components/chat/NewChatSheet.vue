<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import { useCharactersStore } from '@/stores/characters'
import { useChatsStore } from '@/stores/chats'
import { useUiStore } from '@/stores/ui'

const router = useRouter()
const chars = useCharactersStore()
const chats = useChatsStore()
const ui = useUiStore()

onMounted(() => {
  if (!chars.loaded) void chars.load()
})

function close() {
  ui.newChatOpen = false
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
            <button
              class="cbx-btn cbx-btn--soft"
              @click="
                close()
                router.push('/characters')
              "
            >
              去创建角色
            </button>
          </div>

          <div v-for="c in chars.items" :key="c.id" class="row" @click="pick(c.id, c.data.name)">
            <CbxAvatar :blob-id="c.avatarBlobId" :name="c.data.name" size="sm" />
            <div class="row__text">
              <div class="row__name">{{ c.data.name }}</div>
              <div class="row__desc">{{ c.data.description || '（暂无简介）' }}</div>
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
