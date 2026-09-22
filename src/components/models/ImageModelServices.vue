<script setup lang="ts">
import { ref } from 'vue'
import { ImagePlus, Pencil, Plus, Trash2 } from '@/components/icons'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { confirmDialog } from '@/composables/useConfirm'
import type { ImageModelService } from '@/types/image'
import ImageModelEditor from './ImageModelEditor.vue'

const settings = useSettingsStore()
const toast = useToast()
const open = ref(false)
const editing = ref<ImageModelService | null>(null)
const busy = ref(false)
function edit(service: ImageModelService | null) {
  editing.value = service
  open.value = true
}
async function select(service: ImageModelService) {
  if (busy.value) return
  busy.value = true
  try {
    await settings.selectImageModelService(service.id)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}
async function remove(service: ImageModelService) {
  if (
    busy.value ||
    !(await confirmDialog({
      title: '删除文生图配置',
      text: `删除「${service.name}」及其本机密钥？已生成的图片会保留。`,
      confirmText: '删除配置',
    }))
  )
    return
  busy.value = true
  try {
    await settings.removeImageModelService(service.id)
    toast.success('文生图配置已删除')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="image-services" aria-labelledby="image-services-title">
    <header class="head">
      <div>
        <h3 id="image-services-title">
          文生图模型 <span>{{ settings.settings.imageModelServices.length }}</span>
        </h3>
        <p>保存多套配置，生成时可选择。选中的配置作为默认。</p>
      </div>
      <button class="cbx-btn cbx-btn--primary" :disabled="busy" @click="edit(null)">
        <Plus :size="16" />添加文生图配置
      </button>
    </header>
    <p v-if="!settings.settings.imageModelServices.length" class="empty">
      <ImagePlus :size="24" />添加文生图模型，即可为角色和对话生成图片。
    </p>
    <div v-else class="cards">
      <article
        v-for="service in settings.settings.imageModelServices"
        :key="service.id"
        class="image-service-card"
        :class="{ active: service.id === settings.settings.activeImageModelServiceId }"
      >
        <header class="card-head">
          <ImagePlus :size="20" />
          <h4>{{ service.name }}</h4>
          <input
            type="radio"
            name="image-service"
            :aria-label="`默认使用 ${service.name}`"
            :checked="service.id === settings.settings.activeImageModelServiceId"
            :disabled="busy"
            @change="select(service)"
          />
        </header>
        <strong>{{ service.model }}</strong>
        <p class="endpoint">{{ service.baseUrl }}</p>
        <footer>
          <span
            >{{ service.size || '默认尺寸' }} ·
            {{
              service.id === settings.settings.activeImageModelServiceId ? '默认配置' : '文生图'
            }}</span
          >
          <div>
            <button
              class="cbx-icon-btn"
              :aria-label="`编辑 ${service.name}`"
              :title="`编辑 ${service.name}`"
              :disabled="busy"
              @click="edit(service)"
            >
              <Pencil :size="20" />
            </button>
            <button
              class="cbx-icon-btn delete"
              :aria-label="`删除 ${service.name}`"
              :title="`删除 ${service.name}`"
              :disabled="busy"
              @click="remove(service)"
            >
              <Trash2 tone="danger" :size="20" />
            </button>
          </div>
        </footer>
      </article>
    </div>
    <ImageModelEditor v-if="open" :service="editing" @close="open = false" />
  </section>
</template>

<style scoped>
.image-services {
  padding-bottom: 24px;
  border-bottom: 1px solid var(--cbx-border);
}
.head,
.card-head,
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.head {
  flex-wrap: wrap;
  margin-bottom: 16px;
}
h3,
h4,
p {
  margin: 0;
}
h3 {
  font-size: var(--cbx-fs-md);
}
h3 span,
.head p,
.empty,
footer,
.endpoint {
  color: var(--cbx-text-tertiary);
  font-size: var(--cbx-fs-sm);
}
h3 span {
  margin-left: 8px;
  font-weight: normal;
}
.head p {
  margin-top: 6px;
}
.empty {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 100px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 16px;
}
.image-service-card {
  min-width: 0;
  padding: 16px;
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  border-radius: 8px;
}
.image-service-card.active {
  border-color: var(--cbx-brand);
  box-shadow: inset 0 0 0 1px var(--cbx-brand);
}
.card-head {
  margin-bottom: 16px;
}
.card-head svg {
  color: var(--cbx-brand);
  flex-shrink: 0;
}
h4 {
  flex: 1;
  overflow-wrap: anywhere;
  font-size: var(--cbx-fs-md);
}
input {
  width: 20px;
  height: 20px;
  accent-color: var(--cbx-brand);
}
strong {
  font-size: var(--cbx-fs-sm);
  overflow-wrap: anywhere;
}
.endpoint {
  margin-top: 4px;
  overflow-wrap: anywhere;
}
footer {
  border-top: 1px solid var(--cbx-border);
  padding-top: 12px;
  margin-top: 16px;
}
footer > div {
  display: flex;
}
.delete {
  color: var(--cbx-error);
}
</style>
