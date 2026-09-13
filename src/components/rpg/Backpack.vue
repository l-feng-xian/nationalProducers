<script setup lang="ts">
/**
 * 背包面板（参考「小岛时光」右上角的「背包 B」）。
 *
 * 只读展示：采集来的东西放在这里。视觉语言沿用游戏页那套 cozy 令牌 ——
 * ⚠️ 令牌定义在 RpgPlayView 的 `.page` 上，这里靠 CSS 自定义属性的**继承**拿到，
 * 所以本组件必须挂在游戏页内部；单独拿去别处用会掉回浏览器默认色。
 */
import { computed } from 'vue'
import { ITEMS, type ItemId } from '@/services/rpg/harvest'

const props = defineProps<{ items: Record<string, number> }>()
defineEmits<{ close: [] }>()

/**
 * 按 ITEMS 的定义顺序排列，而不是按存档里键的插入顺序 ——
 * 否则「先采到什么就排在前面」，每个存档的背包顺序都不一样，找东西全靠扫。
 * 不认识的 id（老存档 / 改过规则表）也照样列出来，宁可显示得丑一点，
 * 也好过让玩家的东西凭空消失。
 */
const rows = computed(() => {
  const known = (Object.keys(ITEMS) as ItemId[])
    .filter((id) => (props.items[id] ?? 0) > 0)
    .map((id) => ({
      id: id as string,
      name: ITEMS[id].name,
      icon: ITEMS[id].icon,
      n: props.items[id]!,
    }))
  const unknown = Object.entries(props.items)
    .filter(([id, n]) => n > 0 && !(id in ITEMS))
    .map(([id, n]) => ({ id, name: id, icon: '❓', n }))
  return [...known, ...unknown]
})
</script>

<template>
  <div class="mask" @click.self="$emit('close')">
    <section class="card" role="dialog" aria-label="背包">
      <header class="card__head">
        <h3 class="card__title">背包</h3>
        <button class="x" aria-label="关闭" @click="$emit('close')">✕</button>
      </header>

      <p v-if="!rows.length" class="empty">
        背包还是空的。<br />
        拿上斧头或矿镐，走到树木、石头旁边按空格试试。
      </p>

      <ul v-else class="grid">
        <li v-for="r in rows" :key="r.id" class="cell">
          <span class="cell__icon">{{ r.icon }}</span>
          <span class="cell__name">{{ r.name }}</span>
          <span class="cell__n">×{{ r.n }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.mask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: var(--cbx-space-4);
  background: rgba(36, 79, 74, 0.22);
}
.card {
  width: min(420px, 100%);
  max-height: 100%;
  overflow: auto;
  padding: var(--cbx-space-4);
  border: 1px solid rgba(255, 252, 231, 0.9);
  border-radius: var(--rpg-radius, 19px);
  background: var(--rpg-cream-light, #fffdf0);
  box-shadow: var(--rpg-shadow, 0 5px 0 rgba(71, 115, 84, 0.19));
  color: var(--rpg-ink, #244f4a);
  font-family: var(--rpg-font, inherit);
}
.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--cbx-space-3);
}
.card__title {
  margin: 0;
  font-size: var(--cbx-fs-lg);
  font-weight: 700;
}
.x {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 50%;
  background: var(--rpg-cream, #f7f5dd);
  color: inherit;
  font-size: var(--cbx-fs-sm);
  cursor: pointer;
}
.empty {
  margin: 0;
  padding: var(--cbx-space-5) 0;
  text-align: center;
  font-size: var(--cbx-fs-sm);
  line-height: 1.8;
  opacity: 0.7;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: var(--cbx-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--cbx-space-3) var(--cbx-space-2);
  border: 2px solid transparent;
  border-radius: var(--rpg-radius-sm, 11px);
  background: rgba(255, 255, 255, 0.6);
  font-size: var(--cbx-fs-xs);
}
.cell__icon {
  font-size: 26px;
  line-height: 1.1;
}
.cell__name {
  font-weight: 700;
}
.cell__n {
  position: absolute;
  right: 6px;
  bottom: 4px;
  padding: 0 5px;
  border-radius: 6px;
  background: var(--rpg-active, #fff5c4);
  box-shadow: inset 0 0 0 1px var(--rpg-green-soft, #93b075);
  color: var(--rpg-green, #507f50);
  font-weight: 700;
}
</style>
