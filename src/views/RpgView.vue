<script setup lang="ts">
/**
 * 世界列表。
 *
 * 每个世界只是「一个种子 + 一份 NPC 名单 + 玩家身份」，所以新建很轻 ——
 * 地形不占存储，同一个种子必然长出同一个世界。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import { useRpgStore } from '@/stores/rpg'
import { useToast } from '@/composables/useToast'

defineOptions({ name: 'RpgView' })

const rpg = useRpgStore()
const router = useRouter()
const toast = useToast()
const busy = ref(false)

onMounted(() => {
  if (!rpg.loaded) void rpg.load()
})

async function create() {
  if (busy.value) return
  busy.value = true
  try {
    const w = await rpg.create()
    await router.push(`/rpg/${w.id}`)
  } finally {
    busy.value = false
  }
}

async function remove(id: string, name: string) {
  if (!confirm(`删除世界「${name}」？其中的 NPC 配置会一并删除，此操作不可撤销。`)) return
  await rpg.remove(id)
  toast.success('已删除')
}

function fmt(ts: number) {
  return new Date(ts).toLocaleDateString()
}
</script>

<template>
  <div class="page">
    <AppTopbar title="世界">
      <template #actions>
        <button class="cbx-btn cbx-btn--primary" :disabled="busy" @click="create">
          ＋ 新建世界
        </button>
      </template>
    </AppTopbar>

    <div class="cbx-scroll body">
      <div v-if="!rpg.list.length" class="cbx-empty">
        <span class="cbx-empty__icon">🗺️</span>
        <span class="cbx-empty__title">还没有世界</span>
        <span class="cbx-empty__desc">
          新建一个可探索的程序化世界，把角色卡放进去当 NPC，走到它面前就能对话
        </span>
      </div>

      <div v-else class="grid">
        <div v-for="w in rpg.list" :key="w.id" class="card">
          <div class="card__top" @click="router.push(`/rpg/${w.id}`)">
            <span class="card__icon">🗺️</span>
            <div class="card__meta">
              <div class="card__name">{{ w.name }}</div>
              <div class="card__sub">
                {{ w.width }}×{{ w.height }} · {{ w.npcs.length }} 个 NPC · {{ fmt(w.updatedAt) }}
              </div>
            </div>
          </div>
          <div class="acts">
            <button class="cbx-btn cbx-btn--soft sm" @click="router.push(`/rpg/${w.id}`)">
              进入
            </button>
            <button class="cbx-btn cbx-btn--ghost sm danger" @click="remove(w.id, w.name)">
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.body {
  flex: 1;
  min-height: 0;
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
  gap: var(--cbx-space-3);
  padding: var(--cbx-space-4);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-lg);
  background: var(--cbx-bg);
}
.card__top {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-3);
  cursor: pointer;
  min-width: 0;
}
.card__icon {
  font-size: 28px;
  flex-shrink: 0;
}
.card__meta {
  min-width: 0;
}
.card__name {
  font-weight: var(--cbx-fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card__sub {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.acts {
  display: flex;
  gap: var(--cbx-space-2);
}
.danger {
  color: var(--cbx-error);
}
@media (max-width: 767px) {
  .acts .cbx-btn {
    min-height: var(--cbx-tap-min);
  }
}
</style>
