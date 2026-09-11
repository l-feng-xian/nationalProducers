<script setup lang="ts">
import { computed, onMounted } from 'vue'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import { useModelsStore } from '@/stores/models'
import { formatBytes } from '@/services/io/backup'

const models = useModelsStore()

onMounted(() => {
  void models.refresh()
})

const pct = computed(() => {
  const p = models.progress
  if (!p || !p.total) return 0
  return Math.min(100, Math.round((p.loaded / p.total) * 100))
})

function statusOf(id: string): 'unknown' | 'ready' | 'missing' {
  const c = models.cached[id]
  if (c === undefined) return 'unknown'
  return c ? 'ready' : 'missing'
}
</script>

<template>
  <div class="page">
    <AppTopbar title="模型管理" />

    <div class="cbx-scroll body">
      <div class="cbx-form-col col">
        <section class="cbx-card sec">
          <h3>嵌入模型</h3>
          <p class="note">
            会话记忆的「向量召回」需要一个嵌入模型。模型不随应用发布，要在这里
            <strong>手动下载一次</strong>，下载完再勾选启用才会真正生效 ——
            没有勾选的模型不会产生任何流量。 下载来自
            HuggingFace；<strong>下载之后推理全程离线</strong>， 对话内容不会离开这台设备。
          </p>
          <p v-if="models.persisted === false" class="note note--warn">
            浏览器没有授予持久化存储许可。模型仍然可用，但磁盘空间紧张时可能被系统清掉，
            届时需要重新下载。多用几次本站通常就会自动授予。
          </p>
          <p v-if="models.errors['__check']" class="note note--warn">
            检查下载状态失败：{{ models.errors['__check'] }}
          </p>

          <div class="list">
            <article
              v-for="p in models.presets"
              :key="p.id"
              class="row"
              :class="{ 'row--active': models.activeId === p.id }"
            >
              <div class="row__head">
                <!-- 不要套 .cbx-switch：那个类把原生 input 设成 opacity:0/width:0，
                     是给带 __track 的开关用的。直接套在单选上会变成「没有任何可见控件」 -->
                <label class="pick">
                  <!-- 没下载就不给勾：勾上也只会得到一个静默不工作的状态 -->
                  <input
                    class="pick__radio"
                    type="radio"
                    name="embed-model"
                    :value="p.id"
                    :checked="models.activeId === p.id"
                    :disabled="statusOf(p.id) !== 'ready'"
                    @change="models.select(p.id)"
                  />
                  <span class="pick__name">{{ p.name }}</span>
                </label>

                <span v-if="models.activeId === p.id" class="cbx-badge cbx-badge--success">
                  已启用
                </span>
                <span v-else-if="statusOf(p.id) === 'ready'" class="cbx-badge">已下载</span>
                <span v-else-if="statusOf(p.id) === 'unknown'" class="cbx-badge">检查中…</span>
                <span v-else class="cbx-badge cbx-badge--warning">未下载</span>
              </div>

              <p class="row__blurb">{{ p.blurb }}</p>

              <div class="row__meta">
                <span>{{ formatBytes(p.bytes) }}</span>
                <span>{{ p.dim }} 维</span>
                <span>{{ p.mobileFriendly ? '✅ 手机可用' : '⚠️ 建议桌面' }}</span>
              </div>

              <!-- 进度条只在下载这一个模型时出现 -->
              <div v-if="models.downloadingId === p.id" class="prog">
                <div class="prog__bar">
                  <div class="prog__fill" :style="{ width: pct + '%' }" />
                </div>
                <span class="prog__txt">
                  {{ pct }}%
                  <template v-if="models.progress?.file">· {{ models.progress.file }}</template>
                </span>
              </div>

              <p v-if="models.errors[p.id]" class="note note--warn">{{ models.errors[p.id] }}</p>

              <div class="row__acts">
                <button
                  v-if="models.downloadingId === p.id"
                  class="cbx-btn cbx-btn--soft"
                  @click="models.cancel()"
                >
                  取消
                </button>
                <button
                  v-else-if="statusOf(p.id) !== 'ready'"
                  class="cbx-btn cbx-btn--primary"
                  :disabled="!!models.downloadingId || statusOf(p.id) === 'unknown'"
                  @click="models.download(p.id)"
                >
                  下载（{{ formatBytes(p.bytes) }}）
                </button>
                <template v-else>
                  <button
                    v-if="models.activeId === p.id"
                    class="cbx-btn cbx-btn--soft"
                    @click="models.select('')"
                  >
                    停用
                  </button>
                  <button
                    class="cbx-btn cbx-btn--soft danger"
                    :disabled="!!models.downloadingId"
                    @click="models.remove(p.id)"
                  >
                    删除
                  </button>
                </template>
              </div>
            </article>
          </div>

          <p class="note">
            换模型会让已建立的记忆索引全部作废并在后续对话里自动重建 ——
            维度和向量分布都不一样，旧索引无法复用。已有的对话内容不受影响。
          </p>
        </section>
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
  padding: var(--cbx-space-4);
}
.col {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-4);
}
.sec {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
}
.row {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
}
.row--active {
  border-color: var(--cbx-brand);
}
.row__head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  flex-wrap: wrap;
}
.pick {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  cursor: pointer;
}
.pick__radio {
  /* 原生单选默认 13px，手指点不中。accent-color 让它跟随品牌色而不用自绘 */
  width: 18px;
  height: 18px;
  margin: 0;
  accent-color: var(--cbx-brand);
  cursor: pointer;
  flex-shrink: 0;
}
.pick__radio:disabled {
  cursor: not-allowed;
}
.pick:has(.pick__radio:disabled) {
  cursor: not-allowed;
  opacity: 0.55;
}
.pick__name {
  font-weight: var(--cbx-fw-medium);
}
.row__blurb {
  margin: 0;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  line-height: 1.6;
}
.row__meta {
  display: flex;
  gap: var(--cbx-space-3);
  flex-wrap: wrap;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.row__acts {
  display: flex;
  gap: var(--cbx-space-2);
  flex-wrap: wrap;
}
.danger {
  color: var(--cbx-error);
}

.prog {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
.prog__bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--cbx-bg-tertiary);
  overflow: hidden;
}
.prog__fill {
  height: 100%;
  background: var(--cbx-brand);
  transition: width 0.2s linear;
}
.prog__txt {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  /* 文件名长短不一，固定最小宽度免得进度条随文字跳动 */
  min-width: 12ch;
  text-align: right;
}

.note {
  margin: 0;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  line-height: 1.7;
}
.note--warn {
  color: var(--cbx-warning);
}

@media (max-width: 767px) {
  .row__acts .cbx-btn {
    flex: 1;
    min-height: var(--cbx-tap-min);
  }
}
</style>
