<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import { useCharactersStore } from '@/stores/characters'
import { useChatsStore } from '@/stores/chats'
import { useToast } from '@/composables/useToast'
import { readCharaFromPng } from '@/services/io/pngCard'
import { normalizeCard } from '@/services/io/characterCard'
import { blobsRepo } from '@/db/repositories'

const router = useRouter()
const chars = useCharactersStore()
const chats = useChatsStore()
const toast = useToast()
const fileInput = ref<HTMLInputElement | null>(null)

onMounted(() => {
  if (!chars.loaded) void chars.load()
})

async function create() {
  const c = await chars.create()
  await router.push(`/characters/${c.id}`)
}

async function startChat(id: string, name: string) {
  const meta = await chats.createSolo(id, name)
  await router.push(`/chat/${meta.id}`)
}

async function onImport(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files?.length) return
  let ok = 0
  for (const f of files) {
    try {
      const id = crypto.randomUUID()
      let raw: unknown
      if (f.name.toLowerCase().endsWith('.png')) {
        raw = await readCharaFromPng(new Uint8Array(await f.arrayBuffer()))
      } else {
        raw = JSON.parse(await f.text())
      }
      const c = normalizeCard(raw, id)
      // PNG 本身就是角色立绘，顺手存成头像
      if (f.name.toLowerCase().endsWith('.png')) {
        c.avatarBlobId = await blobsRepo.put(f)
      }
      await chars.save(c)
      ok++
    } catch (err) {
      toast.error(`${f.name} 导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (ok) toast.success(`成功导入 ${ok} 个角色`)
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <AppTopbar title="角色">
    <template #actions>
      <button class="cbx-btn cbx-btn--ghost" @click="fileInput?.click()">导入角色卡</button>
      <button class="cbx-btn cbx-btn--primary" @click="create">＋ 新建角色</button>
      <input ref="fileInput" type="file" accept=".png,.json" multiple hidden @change="onImport" />
    </template>
  </AppTopbar>

  <div class="cbx-scroll body">
    <div v-if="!chars.items.length" class="cbx-empty">
      <span class="cbx-empty__icon">🎭</span>
      <span class="cbx-empty__title">还没有角色</span>
      <span class="cbx-empty__desc">点右上角新建，或导入 SillyTavern 的 PNG / JSON 角色卡</span>
    </div>

    <div v-else class="grid">
      <div v-for="c in chars.items" :key="c.id" class="card">
        <CbxAvatar
          class="card__img"
          :blob-id="c.avatarBlobId"
          :name="c.data.name"
          card
          @click="router.push(`/characters/${c.id}`)"
        />
        <div class="card__name">{{ c.data.name }}</div>
        <div class="card__desc">{{ c.data.description || '（暂无简介）' }}</div>
        <div class="card__ops">
          <button class="cbx-btn cbx-btn--soft sm" @click="startChat(c.id, c.data.name)">
            开始聊天
          </button>
          <button class="cbx-btn cbx-btn--ghost sm" @click="router.push(`/characters/${c.id}`)">
            编辑
          </button>
        </div>
      </div>
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
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--cbx-space-4);
}
.card {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-1);
}
.card__img {
  cursor: pointer;
  margin-bottom: var(--cbx-space-2);
}
.card__name {
  font-weight: var(--cbx-fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card__desc {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.4em;
}
.card__ops {
  display: flex;
  gap: var(--cbx-space-2);
  margin-top: var(--cbx-space-1);
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
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: var(--cbx-space-3);
  }
  .sm {
    height: var(--cbx-tap-min);
  }
}
</style>
