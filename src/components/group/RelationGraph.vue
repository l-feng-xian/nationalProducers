<script setup lang="ts">
import { computed, ref } from 'vue'
import RelationCanvas from '@/components/relation/RelationCanvas.vue'
import type { GraphEdge, GraphEdgePatch, GraphLayoutMap, GraphNode } from '@/types/relationGraph'
import type { GroupNodeLayout, GroupRelation } from '@/types/group'
import { confirmDialog } from '@/composables/useConfirm'

/**
 * 群聊关系图谱：`RelationCanvas` 的适配层。
 *
 * 画布本身已经泛化成通用受控组件（`@/components/relation/RelationCanvas.vue`），
 * 这里只做两件事：类型适配，以及**把群聊那套不纯的数据流收口在一处**。
 *
 * props / emits 与重构前逐字相同 —— `GroupEditView.vue` 不需要任何改动。
 */
const props = defineProps<{
  /** 参与关系的节点。用户自己也是其中一个（isUser），只是没有 characterId */
  members: { id: string; name: string; isUser?: boolean }[]
  relations: GroupRelation[]
  layout: Record<string, GroupNodeLayout>
}>()

const emit = defineEmits<{
  'update:layout': [v: Record<string, GroupNodeLayout>]
  'create-relation': [from: string, to: string]
  /** 气泡里改了字段，请父级落盘 */
  change: []
  'remove-relation': [id: string]
  'swap-relation': [r: GroupRelation]
}>()

const selectedNodeId = ref<string | null>(null)
const selectedEdgeId = ref<string | null>(null)

const nodes = computed<GraphNode[]>(() =>
  props.members.map((m) => ({ id: m.id, name: m.name, isUser: !!m.isUser })),
)

/** GroupRelation 没有 score/trust，所以不产生 badge —— 群聊画面与重构前完全一致 */
const edges = computed<GraphEdge[]>(() =>
  props.relations.map((r) => ({
    id: r.id,
    from: r.from,
    to: r.to,
    label: r.label,
    desc: r.desc,
  })),
)

/**
 * ⚠️ 这里**刻意保留**「就地修改 props.relations 里的对象」这个不纯行为。
 *
 * `GroupEditView` 的 model 是 `toPlain()` 出来的编辑草稿，`save()` 直接把整个
 * model put 进 IndexedDB —— 也就是说它**依赖**画布把改动写进同一个对象。
 * 改成纯受控需要同时改 GroupEditView 的 relations 更新路径，那是另一件事，
 * 会把两处的回归面积绑死。
 *
 * 所以：不纯性收口在这个适配层的这两个函数里，世界侧走纯受控。
 * 下一个人看到这里想「顺手修正一下」之前，请先确认 GroupEditView 也一起改了，
 * 否则群聊的关系编辑会静默丢改动。
 */
function onPatchEdge(id: string, patch: GraphEdgePatch) {
  const r = props.relations.find((x) => x.id === id)
  if (!r) return
  if (patch.label !== undefined) r.label = patch.label
  if (patch.desc !== undefined) r.desc = patch.desc
}

function onCommitEdge() {
  emit('change')
}

function onSwapEdge(id: string) {
  const r = props.relations.find((x) => x.id === id)
  if (r) emit('swap-relation', r)
}

/**
 * 删除确认留在适配层。
 *
 * 重构前确认框在画布里，但那句「删除这条角色关系？」是群聊语境的措辞；
 * 画布现在是通用组件，不该替调用方决定问什么。`GroupEditView` 收到
 * `remove-relation` 后是直接删的，所以确认必须在这一层做完。
 */
async function onRemoveEdge(id: string) {
  if (!(await confirmDialog({ text: '删除这条角色关系？' }))) return
  emit('remove-relation', id)
}

function onLayout(v: GraphLayoutMap) {
  emit('update:layout', v)
}
</script>

<template>
  <RelationCanvas
    v-model:selected-node-id="selectedNodeId"
    v-model:selected-edge-id="selectedEdgeId"
    :nodes="nodes"
    :edges="edges"
    :layout="layout"
    editor-mode="popover"
    @update:layout="onLayout"
    @create-edge="(from, to) => emit('create-relation', from, to)"
    @patch-edge="onPatchEdge"
    @commit-edge="onCommitEdge"
    @swap-edge="onSwapEdge"
    @remove-edge="onRemoveEdge"
  >
    <template #hint>
      拖动头像调整位置 ·
      <strong>从节点右上角的 ＋ 拉一条线到另一个节点即可新建关系</strong>（也可按住 Shift 拖拽）·
      点连线就地编辑
    </template>
  </RelationCanvas>
</template>
