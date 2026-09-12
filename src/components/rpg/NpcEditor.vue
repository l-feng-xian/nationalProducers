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
import { nativeIdentity } from '@/types/rpg'
import { confirmDialog } from '@/composables/useConfirm'

const emit = defineEmits<{ close: []; changed: [] }>()

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

function onChange() {
  emit('changed')
}

async function removeNpc(id: string) {
  if (
    !(await confirmDialog({ text: '删除这个 NPC？它的对话历史会保留在会话列表里。' }))
  )
    return
  rpg.removeNpc(id)
  emit('changed')
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
            <span class="cbx-field__label">NPC（{{ world.npcs.length }}）</span>
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
@media (max-width: 767px) {
  .npc .cbx-btn {
    min-height: var(--cbx-tap-min);
  }
}
</style>
