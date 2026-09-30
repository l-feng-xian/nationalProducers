<script setup lang="ts">
/**
 * 节点流程图的连线：贝塞尔曲线 + 沿线流动的虚线 + 从起点跑到终点的光点，表示「执行方向」。
 * 系统要求减少动态效果时（prefers-reduced-motion）两种动画都停掉，只留静态实线。
 * 连线种类决定颜色：阶段出口 / 规则动作链 / 切换阶段跳转 / 阶段条件。
 */
import { computed } from 'vue'
import { EdgeLabelRenderer, getBezierPath, type Position } from '@vue-flow/core'
import type { EdgeKind } from '@/services/flow/graph'

const props = defineProps<{
  id: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourcePosition: Position
  targetPosition: Position
  markerEnd?: string
  selected?: boolean
  data?: { kind: EdgeKind; label?: string; active?: boolean }
}>()
/** 标签渲染在 SVG 外（EdgeLabelRenderer），Vue Flow 的 edge-click 收不到，自己抛出去 */
const emit = defineEmits<{ labelClick: [] }>()

const geo = computed(() => {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  })
  return { path, labelX, labelY }
})
const kind = computed(() => props.data?.kind ?? 'chain')
// 光点跑一趟的时长随线长变：长线不至于飞快、短线不至于拖沓
const duration = computed(() => {
  const d = Math.hypot(props.targetX - props.sourceX, props.targetY - props.sourceY)
  return `${Math.min(3.2, Math.max(1.2, d / 160)).toFixed(2)}s`
})
</script>

<template>
  <g class="fe" :class="[`fe--${kind}`, { 'fe--selected': selected, 'fe--active': data?.active }]">
    <!-- 加宽的透明命中区：细线也好点 -->
    <path class="fe__hit vue-flow__edge-interaction" :d="geo.path" fill="none" />
    <path class="fe__base" :d="geo.path" fill="none" :marker-end="markerEnd" />
    <path class="fe__flow" :d="geo.path" fill="none" />
    <circle class="fe__dot" r="4">
      <animateMotion :dur="duration" repeatCount="indefinite" :path="geo.path" />
    </circle>
  </g>
  <EdgeLabelRenderer v-if="data?.label">
    <div
      class="fe-label nodrag nopan"
      :class="[`fe-label--${kind}`, { 'fe-label--selected': selected }]"
      :style="{ transform: `translate(-50%, -50%) translate(${geo.labelX}px, ${geo.labelY}px)` }"
      role="button"
      tabindex="0"
      @click.stop="emit('labelClick')"
      @keydown.enter.prevent="emit('labelClick')"
    >
      {{ data.label }}
    </div>
  </EdgeLabelRenderer>
</template>

<style>
/* 非 scoped：路径由本组件渲染，但动画与颜色要能被 Vue Flow 的 svg 容器继承 */
.fe {
  --fe-color: var(--cbx-brand);
}
.fe--transition {
  --fe-color: var(--cbx-brand);
}
.fe--chain {
  --fe-color: var(--cbx-warning-hover, #d97706);
}
.fe--jump {
  --fe-color: var(--cbx-error, #dc2626);
}
.fe--when {
  --fe-color: var(--cbx-text-tertiary, #94a3b8);
}
.fe__hit {
  stroke: transparent;
  stroke-width: 18px;
  cursor: pointer;
}
.fe__base {
  stroke: var(--fe-color);
  stroke-width: 2px;
  stroke-opacity: 0.35;
}
.fe__flow {
  stroke: var(--fe-color);
  stroke-width: 2px;
  stroke-dasharray: 6 10;
  stroke-linecap: round;
  animation: fe-flow 0.9s linear infinite;
  pointer-events: none;
}
.fe--when .fe__flow {
  stroke-dasharray: 2 8;
}
.fe__dot {
  fill: var(--fe-color);
  filter: drop-shadow(0 0 4px var(--fe-color));
  pointer-events: none;
}
.fe--selected .fe__base,
.fe--active .fe__base {
  stroke-opacity: 0.9;
  stroke-width: 3px;
}
.fe--selected .fe__flow,
.fe--active .fe__flow {
  stroke-width: 3px;
  animation-duration: 0.5s;
}
@keyframes fe-flow {
  to {
    stroke-dashoffset: -16;
  }
}
.fe-label {
  position: absolute;
  max-width: 180px;
  padding: 2px 8px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--cbx-text);
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  border-radius: 999px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: all;
  cursor: pointer;
}
.fe-label--selected {
  border-color: var(--cbx-brand);
  color: var(--cbx-brand);
}
@media (prefers-reduced-motion: reduce) {
  .fe__flow {
    animation: none;
    stroke-dasharray: none;
  }
  .fe__dot {
    display: none;
  }
}
</style>
