/**
 * 流程节点上显示的一行摘要（节点流程图与检查面板共用）。纯 TS。
 * 世界书名 / 条目名要查仓库，由调用方传 loreLabel 进来，这里不 import pinia。
 */
import {
  FLOW_ACTION_LABEL,
  FLOW_MODE_LABEL,
  FLOW_OP_LABEL,
  FLOW_SOURCE_LABEL,
  type FlowAction,
  type FlowCondition,
  type FlowRule,
  type FlowStage,
  type FlowTransition,
} from '@/types/flow'

const clip = (t: string | undefined, n = 24) => {
  const s = (t ?? '').trim()
  return s ? (s.length > n ? `${s.slice(0, n)}…` : s) : '（未填写）'
}
const stageName = (stages: FlowStage[], id: string | undefined) =>
  stages.find((s) => s.id === id)?.name || '（未选择）'

export function triggerText(r: FlowRule): string {
  const when = r.trigger.kind === 'everyN' ? `每 ${r.trigger.n ?? 1} 条 AI 回复` : '每条 AI 回复后'
  const cd = r.mode === 'always' && r.cooldown ? `，冷却 ${r.cooldown} 轮` : ''
  return `${when} · ${FLOW_MODE_LABEL[r.mode]}${cd}`
}

export function condText(c: FlowCondition, stages: FlowStage[]): string {
  const subject =
    c.source === 'person'
      ? `${c.who || '?'} 的 ${c.key || '?'}`
      : c.source === 'scene'
        ? `场景 ${c.key || '?'}`
        : c.source === 'var'
          ? `变量 ${c.key || '?'}`
          : FLOW_SOURCE_LABEL[c.source]
  const value = c.source === 'stage' ? stageName(stages, c.value) : c.value || '（空）'
  return `${subject} ${FLOW_OP_LABEL[c.op]} ${value}`
}

/** 一组条件压成一行：连线标签 / 规则节点用 */
export function condsText(
  list: FlowCondition[],
  match: 'all' | 'any',
  stages: FlowStage[],
  empty = '无条件',
): string {
  if (!list.length) return empty
  return list.map((c) => condText(c, stages)).join(match === 'any' ? ' 或 ' : ' 且 ')
}

export function transitionText(t: FlowTransition, stages: FlowStage[]): string {
  return condsText(t.conditions, t.match, stages, '没有条件，不会自动切换')
}

export function actionText(
  a: FlowAction,
  stages: FlowStage[],
  loreLabel: (book?: string, uid?: number) => string = () => '',
): string {
  switch (a.kind) {
    case 'guide':
      return `${FLOW_ACTION_LABEL.guide}（${a.turns ?? 1} 轮）：${clip(a.text)}`
    case 'say':
      return `${a.speaker || '{{char}}'} 说：${clip(a.text)}`
    case 'setStatus': {
      const who = !a.who || a.who === 'scene' ? '场景' : a.who
      const op = { set: '设为', add: '增加', push: '加入', pull: '移除' }[a.mode ?? 'set']
      return `${who} 的 ${a.key || '?'} ${op} ${a.value || '（空）'}`
    }
    case 'setVar':
      return `变量 ${a.key || '?'} ${a.mode === 'add' ? '增加' : '设为'} ${a.value || '（空）'}`
    case 'setStage':
      return `切换到阶段：${stageName(stages, a.stage)}`
    case 'activateLore':
      return `激活世界书（${a.turns ?? 1} 轮）：${loreLabel(a.book, a.uid) || '（未选择）'}`
    case 'nextSpeaker':
      return `下一位发言：${a.who || '{{char}}'}`
    case 'mute':
      return `静音：${a.who || '{{char}}'}`
    case 'unmute':
      return `取消静音：${a.who || '{{char}}'}`
    case 'image':
      return '为这条回复生成配图'
  }
}
