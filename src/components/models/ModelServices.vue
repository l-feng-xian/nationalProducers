<script setup lang="ts">
import { ref } from 'vue'
import { Check, Pencil, Plus, Server, Trash2 } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { confirmDialog } from '@/composables/useConfirm'
import type { ModelService } from '@/types/settings'
import ModelServiceEditor from './ModelServiceEditor.vue'

const settings = useSettingsStore()
const toast = useToast()
const editorOpen = ref(false)
const editingService = ref<ModelService | null>(null)
const busy = ref(false)

function edit(service: ModelService | null) {
  editingService.value = service
  editorOpen.value = true
}

async function select(service: ModelService) {
  if (busy.value) return
  busy.value = true
  try {
    await settings.selectModelService(service.id)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}

async function remove(service: ModelService) {
  const next = settings.settings.modelServices.find((item) => item.id !== service.id)
  const active = service.id === settings.settings.activeModelServiceId
  if (
    !(await confirmDialog({
      title: '删除模型服务',
      text: `删除「${service.name}」及其本机密钥？${active ? (next ? `当前服务将切换为「${next.name}」。` : '删除后暂无可用的模型服务。') : ''}`,
      confirmText: '删除服务',
    }))
  )
    return
  busy.value = true
  try {
    await settings.removeModelService(service.id)
    toast.success('模型服务已删除')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="services" aria-labelledby="model-services-title">
    <header class="services-head">
      <h3 id="model-services-title">
        模型服务 <span class="service-count">{{ settings.settings.modelServices.length }}</span>
      </h3>
      <button class="cbx-btn cbx-btn--primary" :disabled="busy" @click="edit(null)">
        <Plus :size="16" />添加服务
      </button>
    </header>
    <div v-if="!settings.settings.modelServices.length" class="services-empty">
      <Server :size="28" aria-hidden="true" />
      <span>暂无模型服务</span>
    </div>
    <div v-else class="services-grid">
      <article
        v-for="service in settings.settings.modelServices"
        :key="service.id"
        class="service-card"
        :class="{ 'service-card--active': service.id === settings.settings.activeModelServiceId }"
      >
        <header class="service-card-head">
          <span class="service-icon"><Server :size="20" aria-hidden="true" /></span>
          <div class="service-identity">
            <h4>{{ service.name }}</h4>
            <span class="service-kind">OpenAI 兼容</span>
          </div>
          <label class="service-choice" :title="`使用 ${service.name}`">
            <input
              type="radio"
              name="model-service"
              :aria-label="`使用 ${service.name}`"
              :checked="service.id === settings.settings.activeModelServiceId"
              :disabled="busy"
              @change="select(service)"
            />
          </label>
        </header>
        <div class="service-details">
          <strong :title="service.provider.model">{{
            service.provider.model || '未设置模型'
          }}</strong>
          <span :title="service.provider.baseUrl">{{
            service.provider.baseUrl || '未设置接口地址'
          }}</span>
        </div>
        <dl class="service-params">
          <div>
            <dt>温度</dt>
            <dd>{{ service.provider.temperature }}</dd>
          </div>
          <div>
            <dt>回复上限</dt>
            <dd>{{ service.provider.maxTokens.toLocaleString() }}</dd>
          </div>
          <div>
            <dt>上下文</dt>
            <dd>{{ service.provider.contextWindow.toLocaleString() }}</dd>
          </div>
        </dl>
        <footer class="service-footer">
          <span v-if="service.id === settings.settings.activeModelServiceId" class="service-active"
            ><Check :size="14" />当前服务</span
          >
          <span v-else class="service-kind">{{
            service.provider.stream ? '流式输出' : '非流式输出'
          }}</span>
          <div class="service-actions">
            <button
              class="cbx-icon-btn"
              :disabled="busy"
              :title="`编辑 ${service.name}`"
              :aria-label="`编辑 ${service.name}`"
              @click="edit(service)"
            >
              <Pencil :size="17" />
            </button>
            <button
              class="cbx-icon-btn service-delete"
              :disabled="busy"
              :title="`删除 ${service.name}`"
              :aria-label="`删除 ${service.name}`"
              @click="remove(service)"
            >
              <Trash2 :size="17" />
            </button>
          </div>
        </footer>
      </article>
    </div>
    <ModelServiceEditor v-if="editorOpen" :service="editingService" @close="editorOpen = false" />
  </section>
</template>

<style scoped>
.services {
  padding-bottom: 24px;
  border-bottom: 1px solid var(--cbx-border);
}
.services-head,
.service-card-head,
.service-footer,
.service-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.services-head {
  justify-content: space-between;
  margin-bottom: 16px;
}
.services-head h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--cbx-fs-md);
}
.service-count {
  color: var(--cbx-text-tertiary);
  font-size: var(--cbx-fs-sm);
  font-weight: normal;
}
.services-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 16px;
}
.service-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--cbx-border);
  border-radius: 8px;
  background: var(--cbx-bg);
}
.service-card--active {
  border-color: var(--cbx-brand);
  box-shadow: inset 0 0 0 1px var(--cbx-brand);
}
.service-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  background: var(--cbx-bg-secondary);
  color: var(--cbx-text-secondary);
}
.service-identity {
  flex: 1;
  min-width: 0;
}
.service-identity h4 {
  margin: 0 0 2px;
  font-size: var(--cbx-fs-md);
  font-weight: var(--cbx-fw-medium);
  overflow-wrap: anywhere;
}
.service-kind {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.service-choice {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  cursor: pointer;
}
.service-choice input {
  width: 20px;
  height: 20px;
  accent-color: var(--cbx-brand);
  cursor: pointer;
}
.service-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.service-details strong {
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
  overflow-wrap: anywhere;
}
.service-details > span {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-secondary);
  overflow-wrap: anywhere;
}
.service-params {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: auto 0 0;
}
.service-params dt {
  color: var(--cbx-text-tertiary);
  font-size: var(--cbx-fs-xs);
}
.service-params dd {
  margin: 4px 0 0;
  font-size: var(--cbx-fs-sm);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.service-footer {
  justify-content: space-between;
  padding-top: 12px;
  border-top: 1px solid var(--cbx-border);
}
.service-active {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--cbx-success);
  font-size: var(--cbx-fs-xs);
}
.service-actions {
  gap: 4px;
}
.service-delete {
  color: var(--cbx-error);
}
.services-empty {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 112px;
  color: var(--cbx-text-tertiary);
  font-size: var(--cbx-fs-sm);
}
@media (max-width: 767px) {
  .service-choice {
    width: 44px;
    height: 44px;
  }
}
</style>
