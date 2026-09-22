<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
/**
 * 局域网扫码同步。
 *
 * WebRTC 必须双向交换 SDP，所以**两个码、两次扫**是绕不过去的：
 * 发起方出码 → 加入方扫 → 加入方出码 → 发起方扫 → 连通。
 * 每一步的文案都明写「现在轮到谁做什么」，否则用户很容易卡在第二次扫描上。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSyncStore } from '@/stores/sync'
import { useChatsStore } from '@/stores/chats'
import { useCharactersStore } from '@/stores/characters'
import { useInfiniteWorldStore } from '@/stores/infiniteWorld'
import { useToast } from '@/composables/useToast'
import { formatBytes } from '@/services/io/backup'
import { describeCounts, describeScope } from '@/services/sync/protocol'
import { MAX_DEVICE_NAME } from '@/services/sync/signaling'
import { renderQr } from '@/services/qr/render'
import { decodeImageFile, startCameraScan, type ScanHandle } from '@/services/qr/scan'

const emit = defineEmits<{ close: [] }>()

const sync = useSyncStore()
const chats = useChatsStore()
const chars = useCharactersStore()
const gameworlds = useInfiniteWorldStore()
onMounted(() => {
  void gameworlds.load().catch((e) => toast.error(String(e)))
})
const toast = useToast()

const canvas = ref<HTMLCanvasElement | null>(null)
const video = ref<HTMLVideoElement | null>(null)
const imgInput = ref<HTMLInputElement | null>(null)
const pasted = ref('')
const scanErr = ref('')
let scanner: ScanHandle | null = null

/** 摄像头与 WebRTC 都要安全上下文，不满足就别让用户白走一遍流程 */
const secure = typeof isSecureContext === 'boolean' ? isSecureContext : true

const SCOPE_ITEMS = [
  { key: 'gameworlds', label: '无限世界', hint: '含世界设定、居民、存档和区块改动' },
  { key: 'characters', label: '角色', hint: '含头像与视差深度图' },
  { key: 'worldbooks', label: '世界书', hint: '' },
  { key: 'groups', label: '群聊', hint: '含成员关系与用户身份' },
  { key: 'chats', label: '会话与消息', hint: '向量索引不传，对方会自动重建' },
  { key: 'settings', label: '设置', hint: '会整包覆盖对方的接口地址、模型与人设' },
] as const

const nothingPicked = computed(() => !SCOPE_ITEMS.some((i) => sync.scope[i.key]))

/** 对方清单里有多少条会覆盖本机已有记录 —— 单向推送下唯一的冲突提示 */
const overlap = computed(() => {
  const m = sync.incoming
  if (!m) return { chats: 0, characters: 0, gameworlds: 0 }
  const localChats = new Set(chats.list.map((c) => c.id))
  const localChars = new Set(chars.items.map((c) => c.id))
  return {
    gameworlds: (m.worldIds ?? []).filter((id) => gameworlds.items.some((w) => w.id === id)).length,
    chats: m.chatIds.filter((id) => localChats.has(id)).length,
    characters: m.charIds.filter((id) => localChars.has(id)).length,
  }
})

/**
 * 覆盖警告整句在脚本里拼好。
 *
 * 模板里用几个 `<template v-if>` 片段接龙会在中文之间留下空格 ——
 * 换行在编译后变成一个空格，渲染出来就是「1 个会话 本机已存在」那种断裂感。
 */
const overlapWarning = computed(() => {
  const parts: string[] = []
  if (overlap.value.characters) parts.push(`${overlap.value.characters} 个角色`)
  if (overlap.value.gameworlds) parts.push(`${overlap.value.gameworlds} 个无限世界（含全部存档）`)
  if (overlap.value.chats) parts.push(`${overlap.value.chats} 个会话`)
  if (!parts.length) return ''
  return `其中 ${parts.join('、')}已存在于本机，将被对方的版本覆盖，此操作不可撤销。`
})

function drawCode() {
  const el = canvas.value
  if (!el || !sync.myCode) return
  try {
    renderQr(el, sync.myCode, { size: 240 })
  } catch (e) {
    scanErr.value = e instanceof Error ? e.message : String(e)
  }
}

watch(
  () => [sync.step, sync.myCode],
  async () => {
    if (sync.step === 'showCode') {
      await nextTick()
      drawCode()
    }
  },
  { immediate: true },
)

async function openCamera() {
  scanErr.value = ''
  await nextTick()
  const el = video.value
  if (!el) return
  try {
    scanner = await startCameraScan(el, (text) => {
      stopCamera()
      void sync.feedCode(text)
    })
  } catch (e) {
    scanErr.value = e instanceof Error ? e.message : String(e)
  }
}

function stopCamera() {
  scanner?.stop()
  scanner = null
}

watch(
  () => sync.step,
  (s, prev) => {
    if (s === 'scan') void openCamera()
    else if (prev === 'scan') stopCamera()
  },
  { immediate: true },
)

async function pickImage(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!f) return
  scanErr.value = ''
  try {
    const text = await decodeImageFile(f)
    if (!text) {
      scanErr.value = '这张图里没找到二维码，换一张更清晰的试试'
      return
    }
    stopCamera()
    await sync.feedCode(text)
  } catch (err) {
    scanErr.value = err instanceof Error ? err.message : String(err)
  }
}

function submitPasted() {
  const v = pasted.value.trim()
  if (!v) return
  stopCamera()
  pasted.value = ''
  void sync.feedCode(v)
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(sync.myCode)
    toast.success('已复制配对码')
  } catch {
    toast.error('复制失败，请手动选中文本')
  }
}

function finish() {
  // 只有**收**了数据才需要刷新：发送方的库压根没动，白刷一次纯属打断用户。
  // 与「导入备份」一致，各 store 没有统一的重新水合入口，只能整页刷新。
  const reload = sync.received
  close()
  if (reload) setTimeout(() => location.reload(), 800)
}

function close() {
  stopCamera()
  sync.reset()
  emit('close')
}

/**
 * 弹窗一打开就连上信令并待机。
 *
 * 这一步是**双向**的：连上之后我能看到别人，别人也能在名单里看到我。
 * 所以两台设备都得把这个弹窗打开才会互相发现 —— 文案里明说了这点，
 * 否则用户会对着空名单等。
 */
onMounted(() => {
  void sync.open()
})

function onRename(e: Event) {
  sync.setDeviceName((e.target as HTMLInputElement).value)
}

onBeforeUnmount(stopCamera)
</script>

<template>
  <Teleport to="body">
    <div class="cbx-modal__scrim" @click.self="close">
      <div class="cbx-modal" role="dialog" aria-modal="true">
        <header class="cbx-modal__head">
          <h3>二维码同步</h3>
          <button class="cbx-icon-btn" aria-label="关闭" @click="close">
            <AppIcon name="X" />
          </button>
        </header>

        <div class="cbx-modal__body cbx-scroll">
          <p v-if="!secure" class="note note--warn">
            <AppIcon name="TriangleAlert" tone="warning" /> 当前不是安全上下文，摄像头与 WebRTC 都会被浏览器禁用。
            请用 <code>npm run dev:lan</code> 启动，或把应用部署到 https 站点后再试。
          </p>

          <!-- 1 选角色 -->
          <template v-if="sync.step === 'pick'">
            <p class="note">
              两台设备连同一个 Wi-Fi，直接点对方的名字就能连。
              握手借信令服务器牵个线，<strong>数据本身点对点直接走、不经过服务器</strong>； 同样不含
              API Key 与向量索引。
            </p>

            <div class="block">
              <div class="block__head">
                <span class="cbx-field__label">发现的设备</span>
                <span v-if="sync.discovering" class="chip">搜索中…</span>
                <span v-else-if="sync.peers.length" class="chip chip--ok">
                  {{ sync.peers.length }} 台在线
                </span>
              </div>
              <div v-if="sync.peers.length" class="peers">
                <button
                  v-for="p in sync.peers"
                  :key="p.id"
                  class="peer"
                  type="button"
                  @click="sync.connectTo(p.id)"
                >
                  <span class="peer__dot" />
                  <span class="peer__name">{{ p.name }}</span>
                  <span class="peer__go">连接 <AppIcon name="ArrowRight" /></span>
                </button>
              </div>
              <p v-else-if="!sync.discovering" class="cbx-field__hint">
                没发现其它设备。请在另一台设备上也打开这个「二维码同步」弹窗 ——
                双方都打开时才会互相出现在名单里。
              </p>
            </div>

            <label class="cbx-field nameline">
              <span class="cbx-field__label">本机名称</span>
              <input
                class="cbx-input"
                :value="sync.deviceName"
                :maxlength="MAX_DEVICE_NAME"
                placeholder="给这台设备起个名"
                @change="onRename"
              />
              <span class="cbx-field__hint">别人在名单里看到的就是这个名字</span>
            </label>

            <div class="cbx-divider" />
            <p class="cbx-field__hint">找不到对方？也可以扫码连：</p>
            <div class="acts">
              <button class="cbx-btn cbx-btn--soft" :disabled="!secure" @click="sync.startHost()">
                显示二维码
              </button>
              <button class="cbx-btn cbx-btn--soft" :disabled="!secure" @click="sync.startGuest()">
                扫码加入
              </button>
            </div>
          </template>

          <!-- 1b 有人从名单里点了我 -->
          <template v-else-if="sync.step === 'invited' && sync.invite">
            <p class="note">
              <strong>「{{ sync.invite.name }}」</strong> 想和这台设备建立连接。
            </p>
            <p class="cbx-field__hint">
              允许之后只是接通通道；具体传不传数据、传哪些，还要再确认一次。
            </p>
            <div class="acts">
              <button class="cbx-btn cbx-btn--primary" @click="sync.answerInvite(true)">
                允许
              </button>
              <button class="cbx-btn cbx-btn--ghost danger" @click="sync.answerInvite(false)">
                拒绝
              </button>
            </div>
          </template>

          <!-- 2 显示自己的码 -->
          <template v-else-if="sync.step === 'showCode'">
            <p class="note">
              <template v-if="sync.relayed">
                让另一台设备点「扫码加入」，扫下面这个码 —— 扫完就自动连上，不用再扫第二次。
              </template>
              <template v-else-if="sync.role === 'host'">
                第 1 步：让另一台设备点「扫码加入」，扫下面这个码。
              </template>
              <template v-else>第 2 步：让发起方扫下面这个应答码，扫完就连上了。</template>
            </p>
            <p v-if="!sync.relayed && sync.fallbackReason" class="note note--warn">
              <AppIcon name="TriangleAlert" tone="warning" /> 没连上信令服务器，已退回手动模式（要扫两次码）：{{
                sync.fallbackReason
              }}
            </p>
            <div class="qr">
              <canvas ref="canvas" />
            </div>
            <details class="fallback">
              <summary>扫不了？用配对码</summary>
              <p class="cbx-field__hint">对方可以把这串字符手动粘贴进「扫码加入」里的输入框。</p>
              <code class="code">{{ sync.myCode }}</code>
              <button class="cbx-btn cbx-btn--ghost sm" @click="copyCode">复制配对码</button>
            </details>
            <!-- 有信令时不需要第二次扫码：对方扫完会自己把握手送上门 -->
            <div v-if="!sync.relayed && sync.role === 'host'" class="acts">
              <button class="cbx-btn cbx-btn--primary" @click="sync.toScan()">
                对方扫好了，去扫他的应答码
              </button>
            </div>
            <p v-else class="cbx-field__hint">等待对方扫描…</p>
          </template>

          <!-- 3 扫对方的码 -->
          <template v-else-if="sync.step === 'scan'">
            <p class="note">
              <template v-if="sync.role === 'guest'">对准发起方屏幕上的二维码。</template>
              <template v-else>对准对方屏幕上的应答码。</template>
            </p>
            <div class="cam">
              <video ref="video" playsinline muted />
            </div>
            <p v-if="scanErr" class="note note--warn">
              <AppIcon name="TriangleAlert" tone="warning" /> {{ scanErr }}
            </p>
            <details class="fallback">
              <summary>没有摄像头？</summary>
              <div class="acts">
                <button class="cbx-btn cbx-btn--ghost sm" @click="imgInput?.click()">
                  从图片识别
                </button>
                <input ref="imgInput" type="file" accept="image/*" hidden @change="pickImage" />
              </div>
              <p class="cbx-field__hint">或把对方的配对码粘贴到这里：</p>
              <div class="acts">
                <input v-model="pasted" class="cbx-input grow" placeholder="粘贴配对码" />
                <button
                  class="cbx-btn cbx-btn--soft sm"
                  :disabled="!pasted.trim()"
                  @click="submitPasted"
                >
                  确定
                </button>
              </div>
            </details>
          </template>

          <!-- 4 连接中 -->
          <template v-else-if="sync.step === 'connecting'">
            <p class="note">正在建立连接…</p>
            <p class="cbx-field__hint">
              如果一直停在这里，多半是两台设备不在同一局域网，或路由器开启了 AP 隔离。
            </p>
          </template>

          <!-- 5 已连通：选方向与范围 -->
          <template v-else-if="sync.step === 'ready'">
            <p class="note"><AppIcon name="Check" tone="success" /> 已连接。选择要同步的内容，然后决定方向。</p>
            <div class="opts">
              <label v-for="it in SCOPE_ITEMS" :key="it.key" class="opt">
                <input v-model="sync.scope[it.key]" type="checkbox" />
                <span>
                  <strong>{{ it.label }}</strong>
                  <em v-if="it.hint">{{ it.hint }}</em>
                </span>
              </label>
            </div>
            <p class="cbx-field__hint">
              收方按「同 id 覆盖」合并，与导入备份一致；本机已有的同 id 记录会被替换。
            </p>
            <div class="acts">
              <button
                class="cbx-btn cbx-btn--primary"
                :disabled="nothingPicked"
                @click="sync.push()"
              >
                发给对方
              </button>
              <button class="cbx-btn cbx-btn--soft" :disabled="nothingPicked" @click="sync.pull()">
                从对方拉取
              </button>
            </div>
          </template>

          <!-- 6 接收确认 -->
          <template v-else-if="sync.step === 'confirm' && sync.incoming">
            <p class="note">对方要发来这些数据：</p>
            <p class="big">{{ describeCounts(sync.incoming.counts) }}</p>
            <p class="cbx-field__hint">传输体积约 {{ formatBytes(sync.incoming.bytes) }}</p>
            <p v-if="overlapWarning" class="note note--warn">
              <AppIcon name="TriangleAlert" tone="warning" /> {{ overlapWarning }}
            </p>
            <div class="acts">
              <button class="cbx-btn cbx-btn--primary" @click="sync.answerConfirm(true)">
                接收
              </button>
              <button class="cbx-btn cbx-btn--ghost danger" @click="sync.answerConfirm(false)">
                拒绝
              </button>
            </div>
          </template>

          <!-- 6.5 对方要从我这儿拉数据，等我批准 -->
          <!--
            ⚠️ 这一步以前是没有的：pull 帧一到就直接把整库导出发走了。
            邀请页上写着「允许之后只是接通通道；具体传不传数据、传哪些，还要再确认
            一次」—— 这个页面就是让那句话在拉取方向上也成立的地方。
          -->
          <template v-else-if="sync.step === 'pullAsk' && sync.pullRequest">
            <p class="note">对方想<b>从这台设备取走</b>这些数据：</p>
            <p class="big">{{ describeScope(sync.pullRequest) }}</p>
            <p v-if="sync.pullRequest.settings" class="note note--warn">
              <AppIcon name="TriangleAlert" tone="warning" /> 含「设置」——你的接口地址、模型与人设会一并送出去。
            </p>
            <p class="cbx-field__hint">
              只会发送上面列出的类别；你在上一页没勾的项目已经排除在外。不确定就拒绝。
            </p>
            <div class="acts">
              <button class="cbx-btn cbx-btn--primary" @click="sync.answerPullRequest(true)">
                允许取走
              </button>
              <button class="cbx-btn cbx-btn--ghost danger" @click="sync.answerPullRequest(false)">
                拒绝
              </button>
            </div>
          </template>

          <!-- 7 传输中 -->
          <template v-else-if="sync.step === 'transfer'">
            <p class="note">传输中，请保持两台设备的页面都在前台。</p>
            <div class="prog">
              <div class="prog__bar">
                <div class="prog__fill" :style="{ width: sync.pct + '%' }" />
              </div>
              <span class="prog__txt">{{ sync.pct }}%</span>
            </div>
            <p class="cbx-field__hint">
              {{ formatBytes(sync.loaded) }} / {{ formatBytes(sync.total) }}
            </p>
          </template>

          <!-- 8 完成 -->
          <template v-else-if="sync.step === 'done'">
            <p class="note"><AppIcon name="Check" tone="success" /> 同步完成。</p>
            <p v-if="sync.result" class="big">{{ describeCounts(sync.result) }}</p>
            <div class="acts">
              <button class="cbx-btn cbx-btn--primary" @click="finish">完成</button>
            </div>
          </template>

          <!-- 9 出错 -->
          <template v-else-if="sync.step === 'error'">
            <p class="note note--warn"><AppIcon name="TriangleAlert" tone="warning" /> {{ sync.error }}</p>
            <div class="acts">
              <button class="cbx-btn cbx-btn--soft" @click="sync.reset()">重新开始</button>
              <button class="cbx-btn cbx-btn--ghost" @click="close">关闭</button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cbx-modal__body {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
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
.big {
  margin: 0;
  font-size: var(--cbx-fs-md);
  font-weight: var(--cbx-fw-medium);
}
.acts {
  display: flex;
  gap: var(--cbx-space-2);
  flex-wrap: wrap;
}
.grow {
  flex: 1;
  min-width: 0;
}

/* 二维码永远白底黑码，不跟随主题 —— 反色后很多手机相机直接扫不出来 */
.qr {
  align-self: center;
  padding: var(--cbx-space-2);
  border-radius: var(--cbx-radius-md);
  background: #fff;
  line-height: 0;
}

.cam {
  align-self: center;
  width: 100%;
  max-width: 320px;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-bg-tertiary);
}
.cam video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.fallback summary {
  cursor: pointer;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
}
.fallback > * {
  margin-top: var(--cbx-space-2);
}
.code {
  display: block;
  padding: var(--cbx-space-2);
  border-radius: var(--cbx-radius-sm);
  background: var(--cbx-bg-secondary);
  font-family: var(--cbx-font-mono);
  font-size: var(--cbx-fs-xs);
  /* 配对码是一长串无空格字符，不强制断行会把弹窗撑破 */
  overflow-wrap: anywhere;
}

.opts {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
}
.opt {
  display: flex;
  align-items: flex-start;
  gap: var(--cbx-space-2);
  cursor: pointer;
}
.opt span {
  display: flex;
  flex-direction: column;
}
.opt strong {
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
}
.opt em {
  font-style: normal;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}

.prog {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
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
  /* 百分比 1~3 位变化，固定宽度免得进度条左右抖 */
  min-width: 4ch;
  text-align: right;
}

.danger {
  color: var(--cbx-error);
}

.block__head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  margin-bottom: var(--cbx-space-2);
}
.peers {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-1);
}
.peer {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  width: 100%;
  padding: var(--cbx-space-2) var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-bg);
  color: inherit;
  font-size: var(--cbx-fs-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--cbx-transition);
}
@media (hover: hover) {
  .peer:hover {
    background: var(--cbx-bg-hover);
  }
}
.peer__dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--cbx-success);
}
.peer__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.peer__go {
  flex-shrink: 0;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-brand);
}
.nameline .cbx-input {
  max-width: var(--cbx-fieldw-sm);
}
/* .cbx-field__hint 是 span（inline），只有在输入框占满整行时才会自然换行。
   这里把输入框收窄了，不显式转成 block 的话提示会挤在输入框右边、断成两截。 */
.nameline .cbx-field__hint {
  display: block;
}
.chip {
  padding: 0 var(--cbx-space-2);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg-secondary);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-secondary);
}
.chip--ok {
  background: var(--cbx-success-light);
  color: var(--cbx-success);
}

@media (max-width: 767px) {
  .peer {
    min-height: var(--cbx-tap-min);
  }
}

@media (max-width: 767px) {
  .acts .cbx-btn {
    min-height: var(--cbx-tap-min);
  }
}
</style>
