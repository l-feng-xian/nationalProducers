<script setup lang="ts">
/**
 * blobs 缩略图。所有图片显示必须走 useObjectUrl 的集中缓存与引用计数，
 * 长列表里散写 createObjectURL 会持续泄漏几十上百 MB（见该文件注释）。
 */
import { computed } from 'vue'
import { useObjectUrl } from '@/composables/useObjectUrl'

const props = defineProps<{ blobId?: string }>()
const idRef = computed(() => props.blobId)
const { url } = useObjectUrl(idRef)
</script>

<template>
  <img v-if="url" class="dthumb" :src="url" alt="图片缩略图" />
  <span v-else class="dthumb dthumb--missing">无图</span>
</template>
