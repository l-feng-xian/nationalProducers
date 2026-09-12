<script setup lang="ts">
/**
 * NPC 与玩家身份的配置面板。
 *
 * 两件事对应需求里的两条：
 *  - NPC 可以关联角色卡；不关联也必须能自己填名字与简介
 *  - 玩家能设定自己在这个世界里的身份
 * 玩家身份与群聊那套同构：留空即回落全局人设，UI 上也把回落结果显示出来，
 * 免得用户以为自己没配生效。
 */
import { computed } from 'vue'
import { useRpgStore } from '@/stores/rpg'
import { useCharactersStore } from '@/stores/characters'
import { useSettingsStore } from '@/stores/settings'
import {
  nativeIdentity,
  NPC_MAX,
  ROUTINE_KIND_LABEL,
  type RpgPoi,
  type RpgRoutine,
  type RpgRoutineKind,
} from '@/types/rpg'
import { formatTimeOfDay } from '@/services/rpg/time'
import { confirmDialog } from '@/composables/useConfirm'

const emit = defineEmits<{ close: []; changed: []; rederive: [id: string] }>()

const rpg = useRpgStore()
const chars = useCharactersStore()
const settings = useSettingsStore()

const world = computed(() => rpg.current)

/** 回落之后实际生效的「我」，显示给用户看，别让人猜 */
const effectiveMe = computed(() => {
  const p = world.value?.persona
  return {
    name: p?.name?.trim() || settings.settings.persona.name || '我',
    description: p?.description?.trim() || settings.settings.persona.description || '（未填写）',
  }
})

/** 不填简介时实际会进提示词的那句，直接显示出来，别让用户猜 */
const nativeHint = computed(() => nativeIdentity(world.value?.name))

/**
 * 超编：NPC 比上限还多。
 *
 * 上限只挡「在脚下放 NPC」这一条路，而导入备份（services/io/backup.ts）与设备
 * 同步（services/sync/session.ts）都是**零校验原样回写**的，所以超编世界确实存在。
 * 读档时不截断是有意的：normalize 不回写，真截断了也要等某次无关的 save 才落盘，
 * 而这个页面每跨一格就 save 一次 —— 用户会在打开世界几十秒后，
 * 莫名其妙少掉几个从没动过的 NPC，连同他们的对话历史一起失去线索。
 */
const overCap = computed(() => (world.value?.npcs.length ?? 0) > NPC_MAX)

function onChange() {
  emit('changed')
}

async function removeNpc(id: string) {
  if (!(await confirmDialog({ text: '删除这个 NPC？它的对话历史会保留在会话列表里。' }))) return
  rpg.removeNpc(id)
  emit('changed')
}

/**
 * 一天的行程，按时刻排好。
 *
 * 直接渲染 `routine.slots` 就够了吗 —— 不够：`slots[i].poi` 是索引，
 * 界面上要显示的是那个点叫什么、在那儿干嘛。这里一次性拼好，
 * 顺便把索引越界（导入的存档可能被手改过）挡掉。
 */
function scheduleOf(r: RpgRoutine) {
  return r.slots.map((s) => {
    const poi = r.pois[s.poi]
    return {
      at: formatTimeOfDay(s.from),
      label: poi?.label ?? '（这一段指向了不存在的地点）',
      act: poi?.act ?? '',
    }
  })
}

/** 导入的存档可能带着一个本版本不认识的 kind，别渲染成一片空白 */
function kindLabel(k: RpgRoutineKind): string {
  return ROUTINE_KIND_LABEL[k] ?? k
}

/**
 * 活动半径：失焦时一次性写入一个**校验过的数字**。
 *
 * ⚠️ 刻意不用 `v-model.number`。它在输入框被清空的那一刻就把 `''` 写进
 * `poi.r`，而引擎每游戏分钟读一次、存档每 3 秒写一次 —— 那个空串会真的进仿真
 * （`'' ?? 2` 还是 `''`，兜底根本不触发），也会真的落进 IndexedDB。
 * 改成只在 change（失焦）时从 DOM 取值、夹进 [1,12] 再写回，模型里永远是数字。
 */
function onPoiR(poi: RpgPoi, e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const v = Number.parseFloat(raw)
  poi.r = Number.isFinite(v) ? Math.min(12, Math.max(1, v)) : 2
  onChange()
}
</script>

<template>
  <Teleport to="body">
    <div class="cbx-modal__scrim" @click.self="emit('close')">
      <div class="cbx-modal cbx-modal--wide" role="dialog" aria-modal="true">
        <header class="cbx-modal__head">
          <h3>NPC 与身份</h3>
          <button class="cbx-icon-btn" aria-label="关闭" @click="emit('close')">✕</button>
        </header>

        <div v-if="world" class="cbx-modal__body cbx-scroll">
          <!-- 世界简介 -->
          <section class="sec">
            <span class="cbx-field__label">🌍 世界简介</span>
            <p class="cbx-field__hint">
              这是个什么地方、什么年代、有什么规矩。会作为【场景】进入这个世界里
              每一段对话，角色卡自带的情境不会被顶掉，两段并存。
            </p>
            <textarea
              v-model="world.description"
              class="cbx-textarea"
              rows="3"
              placeholder="例：艾尔王国，战后第三年。魔法被教会垄断，边境村镇仍有游荡的残兵。"
              @change="onChange"
            />
          </section>

          <div class="cbx-divider" />

          <!-- 玩家身份 -->
          <section class="sec">
            <div class="sec__head">
              <span class="cbx-field__label">🙋 我在这个世界里是谁</span>
              <span v-if="!world.persona.name && !world.persona.description" class="cbx-badge">
                沿用全局人设
              </span>
            </div>
            <p class="cbx-field__hint">
              只作用于这个世界。留空则回落到设置里的全局人设 —— 当前实际生效的是 「{{
                effectiveMe.name
              }}」。
            </p>
            <input
              v-model="world.persona.name"
              class="cbx-input"
              :placeholder="settings.settings.persona.name || '我'"
              @change="onChange"
            />
            <textarea
              v-model="world.persona.description"
              class="cbx-textarea"
              rows="3"
              placeholder="你在这个世界里是谁、什么身份、为什么在这里"
              @change="onChange"
            />
          </section>

          <div class="cbx-divider" />

          <!-- NPC -->
          <section class="sec">
            <div class="sec__head">
              <span class="cbx-field__label">NPC（{{ world.npcs.length }} / {{ NPC_MAX }}）</span>
              <span v-if="rpg.npcFull" class="cbx-badge">{{ overCap ? '超编' : '已满' }}</span>
            </div>
            <!--
              超编只可能来自导入备份 / 设备同步（那两条路是零校验原样回写的）。
              这里只提醒，**绝不自动删** —— 每个 NPC 都挂着一段真实的对话历史，
              替用户砍掉他从没动过的角色是不可接受的
            -->
            <p v-if="overCap" class="cbx-field__hint warn">
              这个世界有 {{ world.npcs.length }} 个 NPC，超过建议上限 {{ NPC_MAX }}
              个（多半是导入备份或设备同步带进来的）。不会自动删任何一个，但同屏人越多越吃帧，
              卡的话可以手动删掉几个。
            </p>
            <p v-if="!world.npcs.length" class="cbx-field__hint">
              还没有 NPC。回到世界里走到想放的位置，点顶栏的「在脚下放 NPC」。
            </p>

            <div v-for="npc in world.npcs" :key="npc.id" class="npc">
              <div class="npc__head">
                <span class="npc__pos">({{ npc.x }}, {{ npc.y }})</span>
                <button class="cbx-btn cbx-btn--ghost sm danger" @click="removeNpc(npc.id)">
                  删除
                </button>
              </div>

              <label class="cbx-field">
                <span class="cbx-field__label">关联角色卡</span>
                <select v-model="npc.characterId" class="cbx-input" @change="onChange">
                  <option :value="undefined">（不关联，用下面自填的）</option>
                  <option v-for="c in chars.items" :key="c.id" :value="c.id">
                    {{ c.data.name }}
                  </option>
                </select>
                <span class="cbx-field__hint">
                  关联后名字与简介都以角色卡为准，改卡这里立刻跟着变
                </span>
              </label>

              <template v-if="!npc.characterId">
                <label class="cbx-field">
                  <span class="cbx-field__label">名字</span>
                  <input v-model="npc.name" class="cbx-input" @change="onChange" />
                </label>
                <label class="cbx-field">
                  <span class="cbx-field__label">人物简介</span>
                  <textarea
                    v-model="npc.description"
                    class="cbx-textarea"
                    rows="3"
                    placeholder="它是谁、什么身份、说话什么调子 —— 这段会进提示词"
                    @change="onChange"
                  />
                  <span v-if="!npc.description.trim()" class="cbx-field__hint">
                    留空则默认是{{ nativeHint }}
                  </span>
                </label>
              </template>
              <p v-else class="cbx-field__hint">
                当前用「{{ chars.byId(npc.characterId)?.data.name ?? '（卡已删除）' }}」这张卡
              </p>

              <!-- 作息 -->
              <details class="rt">
                <summary>
                  作息 ·
                  {{ npc.routine ? kindLabel(npc.routine.kind) : '进入世界后自动生成' }}
                </summary>

                <!--
                  ⚠️ 内容必须自己包一层 div，不能靠 `.rt { display:flex; gap }`。
                  现代 Chrome 把 <details> 的非 summary 子节点整个塞进
                  ::details-content 这个匿名块盒里（实测 Chrome 152：display:block），
                  于是 gap 只作用在 [summary, ::details-content] 之间 ——
                  各行之间实测间距是 0，末尾的按钮和说明还会挤成一行。
                -->
                <div class="rt__body">
                  <template v-if="npc.routine">
                    <p class="cbx-field__hint">
                      按它出生那一带有什么（田、水井、房子……）推导出来的，只推一次并存进存档 ——
                      往后算法再怎么改，这个人的家也不会悄悄搬走。
                    </p>
                    <p class="cbx-field__hint">
                      「在做什么」会<b>逐字进提示词</b>（「正打铁」），改成贴角色的说法通常比默认的好；
                      地点名只在它<b>正赶过去、或者没能过去</b>时出现（「正赶去铁匠铺」）——
                      已经到了的时候，提示词报的是它<b>实际站在哪</b>，由地形决定，不会因为改了这里就变。
                    </p>

                    <div v-for="(poi, i) in npc.routine.pois" :key="i" class="poi">
                      <span class="poi__pos">({{ poi.x }}, {{ poi.y }})</span>
                      <input
                        v-model="poi.label"
                        class="cbx-input"
                        aria-label="地点名"
                        placeholder="地点名，如：铁匠铺"
                        @change="onChange"
                      />
                      <input
                        v-model="poi.act"
                        class="cbx-input"
                        aria-label="在做什么"
                        placeholder="在做什么，如：打铁"
                        @change="onChange"
                      />
                      <label class="poi__r">
                        <span>范围</span>
                        <!-- 刻意不用 v-model.number：它在输入框被清空的那一刻就把空串
                           写进 poi.r，而引擎每游戏分钟读一次、存档每 3 秒写一次。
                           改成失焦时一次性写入校验过的数字 -->
                        <input
                          class="cbx-input"
                          type="number"
                          min="1"
                          max="12"
                          step="0.5"
                          aria-label="活动半径（格）"
                          :value="poi.r ?? 2"
                          @change="onPoiR(poi, $event)"
                        />
                      </label>
                    </div>

                    <ol class="sched">
                      <li v-for="(s, i) in scheduleOf(npc.routine)" :key="i">
                        <span class="sched__at">{{ s.at }}</span>
                        <span
                          >{{ s.label }}<span v-if="s.act"> · {{ s.act }}</span></span
                        >
                      </li>
                    </ol>

                    <button class="cbx-btn cbx-btn--ghost sm" @click="emit('rederive', npc.id)">
                      按当前位置重新推导
                    </button>
                    <span class="cbx-field__hint">
                      会以它<b>此刻站的地方</b>为新家重新找一遍地标 —— 把人挪到别的村子之后用这个。
                      自己改过的地点名与「在做什么」会被覆盖。
                    </span>
                  </template>
                  <p v-else class="cbx-field__hint">
                    这个 NPC 还没在世界里挂载过。回到世界里待一会儿，它会自己生成一份作息。
                  </p>
                </div>
              </details>
            </div>
          </section>
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
.sec {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
}
.sec__head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
.npc {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
}
.npc__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.npc__pos {
  font-family: var(--cbx-font-mono);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.danger {
  color: var(--cbx-error);
}
/*
 * 超编提示。
 *
 * ⚠️ 不要写成 `color: var(--cbx-warning)` —— 那是 #fab005，12px 字压在白底上
 * 实测对比度只有 1.86:1（WCAG AA 小字要 4.5），几乎读不出来。琥珀色用来做
 * 底色与左边条，字仍用正文色：既有警示感，又是全对比度。
 */
.warn {
  color: var(--cbx-text-secondary);
  background: var(--cbx-warning-light);
  border-left: 3px solid var(--cbx-warning);
  border-radius: var(--cbx-radius-sm);
  padding: var(--cbx-space-2);
}

/* ── 作息 ── */
/*
 * ⚠️ 排版必须落在 .rt__body 上，不能落在 <details> 本身。
 * 现代 Chrome 把非 summary 的子节点整个塞进 ::details-content 匿名块盒
 * （实测 Chrome 152：display:block），`.rt { display:flex; gap }` 只作用在
 * [summary, ::details-content] 之间 —— 各行实测间距是 0，末尾的说明还会
 * 反向压到按钮上（-25px）。
 */
.rt__body {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  padding-bottom: var(--cbx-space-2);
}
/* 按钮别被拉成整行宽 */
.rt__body > .cbx-btn {
  align-self: flex-start;
}
.rt summary {
  cursor: pointer;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  padding: var(--cbx-space-2) 0;
}
/* 一行装下坐标 + 两个文本框 + 范围；窄屏换行成两行 */
.poi {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cbx-space-2);
}
.poi .cbx-input {
  flex: 1 1 8rem;
  min-width: 0; /* 不写这条,flex 子项的 min-width:auto 会把行撑出容器 */
}
.poi__pos {
  font-family: var(--cbx-font-mono);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  flex: 0 0 auto;
}
.poi__r {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-1);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  flex: 0 0 auto;
}
.poi__r .cbx-input {
  width: 4.5rem;
  flex: 0 0 auto;
}
.sched {
  margin: 0;
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-1);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
}
.sched li {
  display: flex;
  gap: var(--cbx-space-2);
}
.sched__at {
  font-family: var(--cbx-font-mono);
  color: var(--cbx-text-tertiary);
  flex: 0 0 auto;
}
@media (max-width: 767px) {
  .npc .cbx-btn {
    min-height: var(--cbx-tap-min);
  }
  /* 390px 下三个输入框并排每个只剩 60px,不如直接摞起来。
     ⚠️ 必须是直接子选择器：`.poi .cbx-input` 会连 .poi__r 里那个数字框一起选中，
     而它的 flex 容器是 .poi__r 不是 .poi，flex-basis:100% 的参照物整个不对 ——
     现在看着正常纯属巧合，换个字号就散架 */
  .poi > .cbx-input {
    flex-basis: 100%;
  }
}
</style>
