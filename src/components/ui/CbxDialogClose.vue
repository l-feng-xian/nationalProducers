<script setup lang="ts">
/**
 * 弹框右上角的关闭按钮；手机上（弹框以整页呈现时）变成左上角的「←」返回。
 *
 * 两枚图标都渲染、由 base.css 的 `.cbx-dialog-close__x / __back` 按断点切换，
 * 位置由 `.cbx-page-head` 在窄屏里用 order 挪到最前 —— 各弹框的标题栏结构不用改。
 * 点击事件走 attrs 透传（@click 直接写在使用处）。
 */
import AppIcon from '@/components/icons/AppIcon.vue'

defineProps<{ disabled?: boolean }>()
</script>

<template>
  <button
    type="button"
    class="cbx-icon-btn cbx-dialog-close"
    aria-label="关闭"
    title="关闭"
    :disabled="disabled"
  >
    <AppIcon name="X" class="cbx-dialog-close__x" />
    <AppIcon name="ArrowLeft" class="cbx-dialog-close__back" />
  </button>
</template>
