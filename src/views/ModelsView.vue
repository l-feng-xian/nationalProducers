<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import { computed, onMounted, ref } from 'vue'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import ModelServices from '@/components/models/ModelServices.vue'
import ImageModelServices from '@/components/models/ImageModelServices.vue'
import { useModelsStore } from '@/stores/models'
import { formatBytes, storageEstimate } from '@/services/io/backup'
import { confirmDialog } from '@/composables/useConfirm'

const models = useModelsStore()
const usage = ref<{ usage: number; quota: number } | null>(null)

async function refreshUsage() {
  usage.value = await storageEstimate()
}

onMounted(async () => {
  await models.refresh()
  await refreshUsage()
})

const pct = computed(() => {
  const p = models.progress
  if (!p || !p.total) return 0
  return Math.min(100, Math.round((p.loaded / p.total) * 100))
})

type Status = 'unknown' | 'ready' | 'missing'
function statusOf(id: string): Status {
  const c = models.cached[id]
  if (c === undefined) return 'unknown'
  return c ? 'ready' : 'missing'
}

/** 下载/删除完都要重新算占用，否则用户看不到自己刚腾出来的空间 */
async function download(id: string) {
  await models.download(id)
  await refreshUsage()
}
async function remove(id: string) {
  if (
    !(await confirmDialog({
      text: '删除这个已下载的模型文件？下次使用时需要重新下载。',
      confirmText: '删除文件',
    }))
  )
    return
  await models.remove(id)
  await refreshUsage()
}
</script>

<template>
  <div class="page">
    <AppTopbar title="模型管理">
      <template #actions>
        <!-- 插槽内容在父组件作用域编译，所以本文件的 scoped 样式对它有效 -->
        <span
          v-if="usage"
          class="usage"
          :title="`本站已占用 ${formatBytes(usage.usage)}${usage.quota ? `，可用配额约 ${formatBytes(usage.quota)}` : ''}`"
        >
          <span class="usage__label">已占用</span>
          <strong class="usage__val">{{ formatBytes(usage.usage) }}</strong>
          <span v-if="usage.quota" class="usage__quota">/ {{ formatBytes(usage.quota) }}</span>
        </span>
      </template>
    </AppTopbar>

    <div class="cbx-scroll body">
      <div class="cbx-form-col col">
        <ModelServices />
        <ImageModelServices />
        <section class="cbx-card intro">
          <h3>嵌入模型</h3>
          <p class="note">
            会话记忆的「向量召回」需要一个嵌入模型。模型不随应用发布，要在这里
            <strong>手动下载一次</strong>，下载完再勾选启用才会真正生效 ——
            没有勾选的模型不会产生任何流量。 下载来自
            HuggingFace；<strong>下载之后推理全程离线</strong>， 对话内容不会离开这台设备。
          </p>
          <p class="note">
            换模型会让已建立的记忆索引全部作废，并在后续对话里自动重建 ——
            维度和向量分布都不一样，旧索引无法复用。已有的对话内容不受影响。
          </p>
          <p v-if="models.persisted === false" class="note note--warn">
            <AppIcon name="TriangleAlert" tone="warning" />
            浏览器没有授予持久化存储许可。模型仍然可用，但磁盘空间紧张时可能被系统清掉，
            届时需要重新下载。多用几次本站通常就会自动授予。
          </p>
          <p v-if="models.errors['__check']" class="note note--warn">
            <AppIcon name="TriangleAlert" tone="warning" /> 检查下载状态失败：{{ models.errors['__check'] }}
          </p>
        </section>

        <div class="grid">
          <article
            v-for="p in models.presets"
            :key="p.id"
            class="card"
            :class="{
              'card--active': models.activeId === p.id,
              'card--busy': models.downloadingId === p.id,
              'card--missing': statusOf(p.id) === 'missing',
            }"
          >
            <header class="card__top">
              <!-- 标识块放**维度**而不是名字首字母：两个 BGE 的首字母都是 B，
                   等于没区分；维度 512/768/384 天然各不相同，还顺带是真信息 -->
              <span class="card__mark" :title="`向量维度 ${p.dim}`">
                <b>{{ p.dim }}</b>
                <i>维</i>
              </span>
              <div class="card__id">
                <h4 class="card__name">{{ p.name }}</h4>
                <code class="card__repo">{{ p.id }}</code>
              </div>
              <!-- 真单选而非按钮：同一时刻只能启用一个模型，单选把这条语义
                   直接交给浏览器，键盘与读屏也免费拿到。样式是 appearance:none
                   自绘的，所有颜色走 token，暗色模式自动跟随 -->
              <label class="tick" :title="statusOf(p.id) === 'ready' ? '启用此模型' : '需先下载'">
                <input
                  class="tick__input"
                  type="radio"
                  name="embed-model"
                  :value="p.id"
                  :checked="models.activeId === p.id"
                  :disabled="statusOf(p.id) !== 'ready'"
                  :aria-label="`启用 ${p.name}`"
                  @change="models.select(p.id)"
                />
                <span class="tick__box" aria-hidden="true" />
              </label>
            </header>

            <div class="chips">
              <span v-if="models.activeId === p.id" class="chip chip--ok"
                ><AppIcon name="Check" /> 已启用</span
              >
              <span v-else-if="statusOf(p.id) === 'ready'" class="chip chip--ready">已下载</span>
              <span v-else-if="statusOf(p.id) === 'unknown'" class="chip">检查中…</span>
              <span v-else class="chip chip--warn">未下载</span>
              <span class="chip">{{ formatBytes(p.bytes) }}</span>
              <span class="chip"
                ><AppIcon :name="p.mobileFriendly ? 'Smartphone' : 'Monitor'" />{{
                  p.mobileFriendly ? '手机可用' : '建议桌面'
                }}</span
              >
            </div>

            <p class="card__blurb">{{ p.blurb }}</p>

            <p v-if="models.errors[p.id]" class="card__err">{{ models.errors[p.id] }}</p>

            <!-- 进度条与按钮一起钉在卡片底部，同一行的卡片才会对齐 -->
            <div class="card__foot">
              <div v-if="models.downloadingId === p.id" class="prog">
                <div class="prog__bar">
                  <div class="prog__fill" :style="{ width: pct + '%' }" />
                </div>
                <span class="prog__txt">{{ pct }}%</span>
                <span v-if="models.progress?.file" class="prog__file">
                  {{ models.progress.file }}
                </span>
              </div>

              <div class="acts">
                <button
                  v-if="models.downloadingId === p.id"
                  class="cbx-btn cbx-btn--soft"
                  @click="models.cancel()"
                >
                  取消下载
                </button>
                <button
                  v-else-if="statusOf(p.id) !== 'ready'"
                  class="cbx-btn cbx-btn--primary grow"
                  :disabled="!!models.downloadingId || statusOf(p.id) === 'unknown'"
                  @click="download(p.id)"
                >
                  下载 {{ formatBytes(p.bytes) }}
                </button>
                <template v-else>
                  <button
                    v-if="models.activeId === p.id"
                    class="cbx-btn cbx-btn--soft grow"
                    @click="models.select('')"
                  >
                    停用
                  </button>
                  <button v-else class="cbx-btn cbx-btn--primary grow" @click="models.select(p.id)">
                    启用
                  </button>
                  <button
                    class="cbx-btn cbx-btn--soft danger"
                    :disabled="!!models.downloadingId"
                    @click="remove(p.id)"
                  >
                    删除
                  </button>
                </template>
              </div>
            </div>
          </article>
        </div>

        <section class="cbx-card intro">
          <h3>深度模型 · 立绘视差</h3>
          <p class="note">
            给角色立绘估算深度，让卡片在鼠标移动时产生<strong>真正的视差</strong>——
            人物会真的从背景里浮出来，而不是整张图一起平移。
            启用后，<strong>上传角色图片时</strong>会顺带算一次深度图并永久缓存（实测约 3 秒）；
            没启用就一个字节都不下载，也不会产生任何额外耗时。
          </p>
          <p class="note">
            已有的立绘不会被追溯生成 —— 那会是一次几十秒的批量 CPU 占用。
            需要的话去角色编辑页单独点「生成深度图」。触屏设备与开启了「减少动效」的系统不会启用视差。
          </p>
        </section>

        <div class="grid">
          <article
            v-for="p in models.depthPresets"
            :key="p.id"
            class="card"
            :class="{
              'card--active': models.activeDepthId === p.id,
              'card--busy': models.downloadingId === p.id,
              'card--missing': statusOf(p.id) === 'missing',
            }"
          >
            <header class="card__top">
              <span class="card__mark" title="深度估计模型">
                <b>3D</b>
                <i>深度</i>
              </span>
              <div class="card__id">
                <h4 class="card__name">{{ p.name }}</h4>
                <code class="card__repo">{{ p.id }}</code>
              </div>
              <label class="tick" :title="statusOf(p.id) === 'ready' ? '启用此模型' : '需先下载'">
                <input
                  class="tick__input"
                  type="radio"
                  name="depth-model"
                  :value="p.id"
                  :checked="models.activeDepthId === p.id"
                  :disabled="statusOf(p.id) !== 'ready'"
                  :aria-label="`启用 ${p.name}`"
                  @change="models.selectDepth(p.id)"
                />
                <span class="tick__box" aria-hidden="true" />
              </label>
            </header>

            <div class="chips">
              <span v-if="models.activeDepthId === p.id" class="chip chip--ok"
                ><AppIcon name="Check" /> 已启用</span
              >
              <span v-else-if="statusOf(p.id) === 'ready'" class="chip chip--ready">已下载</span>
              <span v-else-if="statusOf(p.id) === 'unknown'" class="chip">检查中…</span>
              <span v-else class="chip chip--warn">未下载</span>
              <span class="chip">{{ formatBytes(p.bytes) }}</span>
              <span class="chip">约 {{ (p.approxMs / 1000).toFixed(0) }} 秒/张</span>
              <span class="chip"
                ><AppIcon :name="p.mobileFriendly ? 'Smartphone' : 'Monitor'" />{{
                  p.mobileFriendly ? '手机可用' : '建议桌面'
                }}</span
              >
            </div>

            <p class="card__blurb">{{ p.blurb }}</p>
            <p v-if="models.errors[p.id]" class="card__err">{{ models.errors[p.id] }}</p>

            <div class="card__foot">
              <div v-if="models.downloadingId === p.id" class="prog">
                <div class="prog__bar">
                  <div class="prog__fill" :style="{ width: pct + '%' }" />
                </div>
                <span class="prog__txt">{{ pct }}%</span>
                <span v-if="models.progress?.file" class="prog__file">
                  {{ models.progress.file }}
                </span>
              </div>

              <div class="acts">
                <button
                  v-if="models.downloadingId === p.id"
                  class="cbx-btn cbx-btn--soft"
                  @click="models.cancel()"
                >
                  取消下载
                </button>
                <button
                  v-else-if="statusOf(p.id) !== 'ready'"
                  class="cbx-btn cbx-btn--primary grow"
                  :disabled="!!models.downloadingId || statusOf(p.id) === 'unknown'"
                  @click="download(p.id)"
                >
                  下载 {{ formatBytes(p.bytes) }}
                </button>
                <template v-else>
                  <button
                    v-if="models.activeDepthId === p.id"
                    class="cbx-btn cbx-btn--soft grow"
                    @click="models.selectDepth('')"
                  >
                    停用
                  </button>
                  <button
                    v-else
                    class="cbx-btn cbx-btn--primary grow"
                    @click="models.selectDepth(p.id)"
                  >
                    启用
                  </button>
                  <button
                    class="cbx-btn cbx-btn--soft danger"
                    :disabled="!!models.downloadingId"
                    @click="remove(p.id)"
                  >
                    删除
                  </button>
                </template>
              </div>
            </div>
          </article>
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
  padding: var(--cbx-space-4);
}
.col {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-4);
}
.intro {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
}

/* auto-fill + minmax：宽屏自动排成 2~3 列，窄屏退回单列，不用写断点 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--cbx-space-4);
}

.card {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
  padding: var(--cbx-space-4);
  /* 网格项默认 min-width:auto(=min-content)，会把 1fr 轨道顶宽、超出容器。
     显式压到 0，卡片才肯缩进单列容器里（配合 grid 的 minmax(0,1fr)）。 */
  min-width: 0;
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius);
  transition:
    box-shadow var(--cbx-transition),
    transform var(--cbx-transition),
    border-color var(--cbx-transition);
}
/* 选中态用 inset ring 而不是加粗 border —— 后者会让卡片尺寸跳一下 */
.card--active {
  border-color: var(--cbx-brand);
  box-shadow: inset 0 0 0 1px var(--cbx-brand);
  background: var(--cbx-brand-subtle);
}
.card--missing .card__mark {
  background: var(--cbx-bg-active);
  color: var(--cbx-text-tertiary);
}
.card--busy {
  border-color: var(--cbx-brand);
}
@media (hover: hover) {
  .card:hover {
    box-shadow: var(--cbx-shadow-md);
    transform: translateY(-2px);
  }
  .card--active:hover {
    box-shadow:
      inset 0 0 0 1px var(--cbx-brand),
      var(--cbx-shadow-md);
  }
}

.card__top {
  display: flex;
  align-items: flex-start;
  gap: var(--cbx-space-3);
}
.card__mark {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-brand-light);
  color: var(--cbx-brand);
  line-height: 1;
}
.card__mark b {
  font-size: var(--cbx-fs-md);
  font-weight: var(--cbx-fw-bold);
  font-variant-numeric: tabular-nums;
}
.card__mark i {
  margin-top: 2px;
  font-size: 10px;
  font-style: normal;
  opacity: 0.75;
}
.card__id {
  flex: 1;
  min-width: 0;
}
.card__name {
  margin: 0;
  font-size: var(--cbx-fs-md);
  font-weight: var(--cbx-fw-medium);
}
.card__repo {
  display: block;
  margin-top: 2px;
  font-family: var(--cbx-font-mono);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  /* 仓库 id 比卡片窄不了多少，省略号比换行好看 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 自绘单选：原生样式在暗色下很难看，且默认 13px 点不中 ── */
.tick {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  /* 24px 的圈 + padding 凑够手指可点的面积 */
  padding: var(--cbx-space-2);
  margin: calc(var(--cbx-space-2) * -1);
  cursor: pointer;
}
.tick:has(.tick__input:disabled) {
  cursor: not-allowed;
}
.tick__input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.tick__box {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 2px solid var(--cbx-border-strong);
  border-radius: var(--cbx-radius-pill);
  transition:
    border-color var(--cbx-transition),
    background var(--cbx-transition);
}
.tick__box::after {
  content: '';
  width: 10px;
  height: 10px;
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-brand-contrast);
  transform: scale(0);
  transition: transform var(--cbx-transition);
}
.tick__input:checked + .tick__box {
  border-color: var(--cbx-brand);
  background: var(--cbx-brand);
}
.tick__input:checked + .tick__box::after {
  transform: scale(1);
}
.tick__input:disabled + .tick__box {
  border-color: var(--cbx-border);
  background: var(--cbx-bg-disabled);
}
/* 原生 outline 没了，焦点环要自己补，否则键盘用户看不出焦点在哪 */
.tick__input:focus-visible + .tick__box {
  outline: 2px solid var(--cbx-border-focus);
  outline-offset: 2px;
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
.chip--ok {
  background: var(--cbx-success-light);
  color: var(--cbx-success);
  font-weight: var(--cbx-fw-medium);
}
.chip--ready {
  background: var(--cbx-brand-light);
  color: var(--cbx-brand);
}
.chip--warn {
  background: var(--cbx-warning-light);
  color: var(--cbx-warning-hover);
}

.card__blurb {
  margin: 0;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  line-height: 1.7;
}
.card__err {
  margin: 0;
  padding: var(--cbx-space-2);
  border-radius: var(--cbx-radius-sm);
  background: var(--cbx-error-light);
  color: var(--cbx-error);
  font-size: var(--cbx-fs-xs);
  /* 报错可能很长（比如 JSON 解析失败带一大段），别把卡片撑破 */
  overflow-wrap: anywhere;
}

/* margin-top:auto 把底部区推到卡底，同一行卡片的按钮就对齐了 */
.card__foot {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  margin-top: auto;
}

.prog {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  flex-wrap: wrap;
}
.prog__bar {
  flex: 1;
  min-width: 120px;
  height: 6px;
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg-tertiary);
  overflow: hidden;
}
.prog__fill {
  height: 100%;
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-brand);
  transition: width 0.2s linear;
}
.prog__txt {
  font-size: var(--cbx-fs-xs);
  font-weight: var(--cbx-fw-medium);
  color: var(--cbx-text-secondary);
  /* 百分比在 1~3 位之间变，固定宽度免得进度条左右抖 */
  min-width: 4ch;
  text-align: right;
}
.prog__file {
  flex-basis: 100%;
  font-family: var(--cbx-font-mono);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acts {
  display: flex;
  gap: var(--cbx-space-2);
}
.grow {
  flex: 1;
}
.danger {
  color: var(--cbx-error);
}

/* 顶栏里的存储占用。不换行、不挤压标题 —— 顶栏空间有限，宁可让它先消失 */
.usage {
  display: inline-flex;
  align-items: baseline;
  gap: var(--cbx-space-1);
  flex-shrink: 0;
  padding: var(--cbx-space-1) var(--cbx-space-3);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg-secondary);
  white-space: nowrap;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.usage__label {
  color: var(--cbx-text-tertiary);
}
.usage__val {
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
  color: var(--cbx-text-secondary);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 767px) {
  /* 375px 的顶栏里已经有「☰ + 模型管理」，再塞下配额就会把标题挤成省略号。
     完整文案留在 title 属性里，长按仍看得到 */
  .usage__quota,
  .usage__label {
    display: none;
  }
}

.note {
  margin: 0;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  line-height: 1.7;
}
.note--warn {
  color: var(--cbx-warning-hover);
}

@media (max-width: 767px) {
  .grid {
    /* 手机单列。⚠️ 必须是 minmax(0, 1fr) 不能是 1fr：1fr = minmax(auto,1fr)，
       auto 的下界是 min-content，卡里那串长仓库 id（onnx-community/depth-anything-v2-small）
       会把轨道撑到 ~400px、超出 360 视口，底部冒出横向滚动条。minmax(0,…) 把下界压到 0，
       轨道锁死在容器宽度内，内容再自己换行/省略。 */
    grid-template-columns: minmax(0, 1fr);
  }
  .acts .cbx-btn {
    min-height: var(--cbx-tap-min);
  }
}
</style>
