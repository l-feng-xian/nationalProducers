<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import { useInfiniteWorldStore } from '@/stores/infiniteWorld'
import { confirmDialog } from '@/composables/useConfirm'
import { useToast } from '@/composables/useToast'

const router = useRouter()
const worlds = useInfiniteWorldStore()
const loading = ref(true), error = ref('')
const toast = useToast()

onMounted(async () => {
  try { await worlds.load() } catch (e) { error.value = String(e) }
  finally { loading.value = false }
})

async function remove(id: string, name: string) {
  if (!await confirmDialog({ text: `删除世界「${name}」及全部存档？此操作不可撤销。` })) return
  try { await worlds.remove(id); toast.success('世界已删除') }
  catch (e) { toast.error(String(e)) }
}
</script>

<template>
  <AppTopbar title="无限世界">
    <template #actions>
      <button class="cbx-btn cbx-btn--primary" @click="router.push('/game-worlds/new')">
        <AppIcon name="Plus" /> 创建世界
      </button>
    </template>
  </AppTopbar>
  <div class="cbx-scroll body">
    <p v-if="loading">正在读取世界…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <div v-else-if="!worlds.items.length" class="cbx-empty">
      <span class="cbx-empty__icon"><AppIcon name="Sprout" tone="brand" /></span>
      <span class="cbx-empty__title">还没有无限世界</span>
      <span class="cbx-empty__desc">配置世界观、玩家身份和居民后，开始一段可持续探索的田园生活。</span>
      <button class="cbx-btn cbx-btn--soft" @click="router.push('/game-worlds/new')">创建第一个世界</button>
    </div>
    <div v-else class="grid">
      <article v-for="world in worlds.items" :key="world.id" class="cbx-card card">
        <div class="card__head"><h3>{{ world.name }}</h3><span class="seed">种子 {{ world.seed }}</span></div>
        <p>{{ world.lore.premise || '一片等待被发现的土地。' }}</p>
        <div class="meta"><span>{{ world.npcs.length }} 位居民</span><span>{{ world.settings.dayMinutes }} 分钟/天</span></div>
        <div class="ops">
          <button class="cbx-btn cbx-btn--primary sm" @click="router.push(`/game-worlds/${world.id}`)">进入世界</button>
          <button class="cbx-btn cbx-btn--ghost sm" @click="router.push(`/game-worlds/${world.id}/edit`)">编辑设定</button>
          <button class="cbx-btn cbx-btn--ghost sm" @click="remove(world.id, world.name)">删除</button>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.body { flex: 1; padding: var(--cbx-space-5); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--cbx-space-4); }
.card { display: flex; flex-direction: column; gap: var(--cbx-space-3); }
.card__head, .meta, .ops { display: flex; align-items: center; gap: var(--cbx-space-2); }
.card__head { justify-content: space-between; }
.card p { color: var(--cbx-text-secondary); min-height: 48px; }
.seed { color: var(--cbx-text-tertiary); font-size: var(--cbx-fs-xs); }
.meta { color: var(--cbx-text-tertiary); font-size: var(--cbx-fs-sm); }
.ops { margin-top: auto; }
.sm { height: 32px; }
</style>
