<script setup lang="ts">
import { computed, useId } from 'vue'
import { iconArtwork, type IconName } from './artwork'

/** One optical grid and one reversible motion system for every interface icon. */
const props = withDefaults(
  defineProps<{
    name: IconName
    size?: number | string
    active?: boolean
    tone?: 'inherit' | 'brand' | 'danger' | 'warning' | 'success'
    label?: string
  }>(),
  { active: false, tone: 'inherit' },
)

const gradientId = `icon-${useId()}`
const artwork = computed(() => iconArtwork[props.name])

/** 尺寸走 CSS 变量；brand 渐变时把 --icon-fill 一并挂根上，
 *  供 icons.css 把 glyph 里显式 currentColor 的填充件（如 Orbit 卫星）接到渐变。 */
const rootStyle = computed(() => {
  const style: Record<string, string> = {}
  if (props.size != null) {
    style['--icon-size'] = /^\d+(\.\d+)?$/.test(String(props.size))
      ? `${props.size}px`
      : String(props.size)
  }
  if (props.tone === 'brand') style['--icon-fill'] = `url(#${gradientId})`
  return style
})
</script>

<template>
  <svg
    class="cbx-icon"
    :class="{
      'cbx-icon--active': active,
      'cbx-icon--brand': tone === 'brand',
      'cbx-icon--semantic': ['danger', 'warning', 'success'].includes(tone),
      [`cbx-icon--${tone}`]: tone !== 'inherit',
      'cbx-icon--ambient': artwork.ambient,
      'cbx-icon--loader': name === 'LoaderCircle',
    }"
    :data-icon="name"
    :width="size ?? 20"
    :height="size ?? 20"
    :style="rootStyle"
    viewBox="0 0 24 24"
    fill="none"
    :stroke="tone === 'brand' ? `url(#${gradientId})` : 'currentColor'"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="label ? undefined : true"
    :aria-label="label"
    :role="label ? 'img' : undefined"
    focusable="false"
  >
    <defs v-if="tone === 'brand'">
      <linearGradient :id="gradientId" gradientUnits="userSpaceOnUse" x1="3" y1="21" x2="21" y2="3">
        <stop offset="0" style="stop-color: var(--icon-gradient-a)" />
        <stop offset="1" style="stop-color: var(--icon-gradient-b)" />
      </linearGradient>
    </defs>
    <g class="cbx-icon__press">
      <g class="cbx-icon__optical" :transform="artwork.optical">
        <g class="cbx-icon__body">
          <g
            v-for="(part, index) in artwork.parts"
            :key="index"
            class="cbx-icon__part"
            :style="{
              '--part-rest': part.rest ?? 'none',
              '--part-hover': part.hover ?? 'none',
              '--part-active': part.active ?? part.hover ?? 'none',
              '--part-origin': part.origin ?? '12px 12px',
              '--part-delay': `${index * 24}ms`,
              '--part-rest-opacity': part.opacity ?? 1,
              '--part-active-opacity': part.activeOpacity ?? 1,
            }"
          >
            <g :class="{ 'cbx-icon__accent': part.ambient }">
              <component
                :is="node[0]"
                v-for="(node, nodeIndex) in part.nodes"
                :key="nodeIndex"
                v-bind="node[1]"
              />
            </g>
          </g>
        </g>
      </g>
    </g>
  </svg>
</template>
