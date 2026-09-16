<script setup lang="ts">
/**
 * 走到居民跟前的即时对话面板。
 *
 * 自成一路：本地保存消息、直连 provider 流式，**不碰主聊天 store/管线** ——
 * 于是「普通会话提示词逐字不变」这条硬约束结构上不可能被破坏。
 * 复用 `ChatComposer` 输入框与 provider 传输层。
 */
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import { useSettingsStore } from '@/stores/settings'
import { streamChat, chatOnce } from '@/services/provider/openaiCompatible'
import {
  buildDialogueMessages,
  openingLine,
  type DialogueMessage,
  type WorldMoment,
} from '@/services/infinite-world/dialogue/worldDialogue'
import {
  affinityWord,
  findUserRelation,
  rewardForTurn,
  SESSION_SCORE_CAP,
  SESSION_TRUST_CAP,
  type RelationDelta,
} from '@/services/infinite-world/dialogue/relationRules'
import type { GameWorld, NpcBlueprint } from '@/types/infiniteWorld'

const props = defineProps<{
  npc: NpcBlueprint
  world: GameWorld
  moment: WorldMoment
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'reward', delta: RelationDelta): void }>()

const settings = useSettingsStore()
const messages = ref<DialogueMessage[]>([])
const busy = ref(false)
const error = ref('')
const scroller = ref<HTMLElement | null>(null)
let controller: AbortController | null = null

const userName = props.world.player.name || '旅行者'

// ── 关系回写状态 ──
let rewardedTurns = 0
let sessionScore = 0
let sessionTrust = 0
const gainPulse = ref(0) // 刚刚涨的好感，短暂显示

/** 当前关系（响应式，随回写实时更新） */
const relation = computed(() => findUserRelation(props.world, props.npc.npcId))
const relationText = computed(() => {
  const r = relation.value
  if (!r) return '初次见面'
  return `${affinityWord(r.score)} · 好感 ${r.score >= 0 ? '+' : ''}${r.score} · 信任 ${r.trust}`
})

/** 一次完整交谈后按规则给一次奖励（确定性、幂等、每场封顶） */
function rewardTurn() {
  const d = rewardForTurn(rewardedTurns)
  const dScore = Math.max(0, Math.min(d.dScore, SESSION_SCORE_CAP - sessionScore))
  const dTrust = Math.max(0, Math.min(d.dTrust, SESSION_TRUST_CAP - sessionTrust))
  rewardedTurns++
  if (dScore === 0 && dTrust === 0) return
  sessionScore += dScore
  sessionTrust += dTrust
  emit('reward', { dScore, dTrust })
  if (dScore > 0) {
    gainPulse.value = dScore
    window.setTimeout(() => (gainPulse.value = 0), 2200)
  }
}

onMounted(() => {
  messages.value = [{ role: 'assistant', text: openingLine(props.npc, userName) }]
})
onBeforeUnmount(() => controller?.abort())

async function scrollDown() {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(() => messages.value.map((m) => m.text).join('|'), scrollDown)

async function send(text: string) {
  const t = text.trim()
  if (!t || busy.value) return
  if (!settings.isConfigured) {
    error.value = '还没配置模型服务，请先到「设置」里填写接口地址与密钥。'
    return
  }
  messages.value.push({ role: 'user', text: t })
  const aiIdx = messages.value.push({ role: 'assistant', text: '' }) - 1
  busy.value = true
  error.value = ''
  controller = new AbortController()
  try {
    const p = settings.settings.provider
    const cfg: { baseUrl: string; apiKey?: string; proxyPrefix?: string; headers?: Record<string, string> } = {
      baseUrl: p.baseUrl,
    }
    const key = await settings.getApiKey()
    if (key) cfg.apiKey = key
    if (p.proxyPrefix) cfg.proxyPrefix = p.proxyPrefix
    if (Object.keys(p.extraHeaders).length) cfg.headers = p.extraHeaders

    const req = {
      model: p.model,
      messages: buildDialogueMessages({
        npc: props.npc,
        world: props.world,
        moment: props.moment,
        history: messages.value.slice(0, aiIdx),
      }),
      stream: p.stream,
      maxTokens: p.maxTokens,
      temperature: p.temperature,
      ...(p.topP != null ? { topP: p.topP } : {}),
      ...(p.stop.length ? { stop: p.stop } : {}),
    }

    if (p.stream) {
      let acc = ''
      for await (const chunk of streamChat(cfg, req, controller.signal)) {
        acc += chunk.delta
        messages.value[aiIdx]!.text = acc
      }
    } else {
      messages.value[aiIdx]!.text = await chatOnce(cfg, req, controller.signal)
    }
    if (!messages.value[aiIdx]!.text.trim()) {
      messages.value[aiIdx]!.text = '（' + props.npc.name + '若有所思地看着你，没有说话）'
    }
    // 一次完整交谈 → 按规则回写关系（确定性、幂等、每场封顶）
    rewardTurn()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    // 抽掉没收到内容的空气泡
    if (messages.value[aiIdx] && !messages.value[aiIdx]!.text) messages.value.splice(aiIdx, 1)
  } finally {
    busy.value = false
    controller = null
  }
}

function stop() {
  controller?.abort()
}
</script>

<template>
  <div class="panel-mask" @click.self="emit('close')">
    <section class="cbx-card panel">
      <header class="head">
        <div class="who">
          <strong>{{ npc.name }}</strong>
          <span>{{ npc.profession || '居民' }}</span>
          <span class="rel">{{ relationText }}<em v-if="gainPulse" class="gain">好感 +{{ gainPulse }}</em></span>
        </div>
        <button class="cbx-btn cbx-btn--ghost" @click="emit('close')">结束交谈</button>
      </header>

      <div ref="scroller" class="cbx-scroll log">
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <span class="name">{{ m.role === 'assistant' ? npc.name : userName }}</span>
          <p class="bubble">
            {{ m.text
            }}<span v-if="busy && i === messages.length - 1 && m.role === 'assistant'" class="caret">▍</span>
          </p>
        </div>
        <p v-if="error" class="err">{{ error }}</p>
      </div>

      <ChatComposer :busy="busy" :send-on-enter="true" @send="send" @stop="stop" />
    </section>
  </div>
</template>

<style scoped>
.panel-mask {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: end center;
  background: rgba(0, 0, 0, 0.28);
  z-index: 40;
}
.panel {
  width: min(560px, 100%);
  max-height: min(70%, 620px);
  margin: 0 0 16px;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--cbx-border);
}
.who { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.who strong { font-size: var(--cbx-fs-lg); }
.who span { color: var(--cbx-text-secondary); font-size: var(--cbx-fs-sm); }
.who .rel { color: var(--cbx-text-tertiary); font-size: var(--cbx-fs-xs); }
.gain { color: var(--cbx-success); font-style: normal; margin-left: 6px; animation: gain-fade 2.2s ease-out; }
@keyframes gain-fade { 0% { opacity: 0; transform: translateY(4px); } 15% { opacity: 1; transform: none; } 100% { opacity: 0; } }
.log { flex: 1; min-height: 200px; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.msg { display: flex; flex-direction: column; gap: 4px; max-width: 85%; }
.msg.user { align-self: flex-end; align-items: flex-end; }
.name { color: var(--cbx-text-tertiary); font-size: var(--cbx-fs-xs); }
.bubble {
  margin: 0;
  padding: 10px 14px;
  border-radius: 14px;
  white-space: pre-wrap;
  line-height: 1.6;
  background: var(--cbx-bg-secondary);
}
.msg.user .bubble { background: var(--cbx-brand-light); color: var(--cbx-text); }
.caret { color: var(--cbx-brand); animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.err { color: var(--cbx-danger); font-size: var(--cbx-fs-sm); margin: 0; }
@media (max-width: 767px) {
  .panel { width: 100%; max-height: 78%; margin-bottom: 0; border-radius: 16px 16px 0 0; }
}
</style>
