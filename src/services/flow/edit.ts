/**
 * 流程编辑时的「联动清理」。纯 TS，可离线测（verify-flow.ts）。
 *
 * 表单里上级下拉一改，下级内容往往就不再成立：换了动作类型，原来填的字段名可能
 * 不属于新类型；换了世界书，原来的条目 uid 指向别的书；换了「改谁的状态」，
 * 同一字段名在场景与人物两套字段里含义不同。这些残留不会报错，只会在真正触发时
 * 静默失效 —— 所以统一在这里清掉，逼用户重新选一次。
 */

import type {
  FlowAction,
  FlowActionKind,
  FlowCondition,
  FlowConfig,
  FlowSource,
} from '@/types/flow'

/** 每种动作真正用到的字段。换类型时只保留这些，其余清空 */
const KIND_FIELDS: Record<FlowActionKind, (keyof FlowAction)[]> = {
  guide: ['text', 'turns'],
  say: ['text', 'speaker'],
  setStatus: ['who', 'key', 'mode', 'value'],
  setVar: ['key', 'mode', 'value'],
  setStage: ['stage'],
  activateLore: ['book', 'uid', 'turns'],
  nextSpeaker: ['who'],
  mute: ['who'],
  unmute: ['who'],
  image: [],
}

/**
 * 换动作类型：只留下新类型用得上的字段。
 * `text` 与 `turns` 有默认值，所以「引导剧情（1 轮）」这种留白不会丢。
 */
export function pruneActionForKind(action: FlowAction, kind: FlowActionKind): FlowAction {
  const allow = new Set<keyof FlowAction>([...KIND_FIELDS[kind], 'id'])
  const next = { id: action.id, kind } as FlowAction
  for (const [k, v] of Object.entries(action)) {
    // ⚠️ 必须跳过 kind：它是「旧」动作的类型，照抄过来会把刚换的新类型覆盖回去，
    // 表现是下拉选了别的类型、面板却纹丝不动（且补丁里带的就是旧值）。
    if (k === 'kind' || v === undefined || !allow.has(k as keyof FlowAction)) continue
    ;(next as unknown as Record<string, unknown>)[k] = v
  }
  // 引导剧情没写轮数时给默认值，不然摘要会显示「(undefined 轮)」
  if (kind === 'guide' && next.turns === undefined) next.turns = 1
  if (kind === 'activateLore' && next.turns === undefined) next.turns = 1
  return next
}

/**
 * 换「取值来源」：字段名与比较值都不再成立。
 * person↔scene 的字段是两套；stage 的值是阶段 id；turn 只认数字 —— 都清掉重选。
 */
export function clearConditionForSource(c: FlowCondition, source: FlowSource): FlowCondition {
  const next: FlowCondition = { id: c.id, source, op: c.op, value: '' }
  // 人物来源才需要「谁」，换过去时给个可用的默认值
  if (source === 'person') next.who = c.who ?? '{{char}}'
  return next
}

/** 比较方式切换时：值清空（等于/包含 与 大于/小于 的写法不同） */
export function clearConditionForOp(c: FlowCondition, op: FlowCondition['op']): FlowCondition {
  return { ...c, op, value: '' }
}

/**
 * 删掉某个阶段后，把指向它的引用一并清掉：动作里的「切换阶段」、
 * 条件里的「当前阶段 = 它」。连线由调用方另行清理（那里还带着 from 阶段）。
 */
export function dropStageRefs(cfg: FlowConfig, stageId: string): FlowConfig {
  const cleanConds = (list: FlowCondition[]) =>
    list.map((c) => (c.source === 'stage' && c.value === stageId ? { ...c, value: '' } : c))
  return {
    ...cfg,
    rules: cfg.rules.map((r) => ({
      ...r,
      conditions: cleanConds(r.conditions),
      actions: r.actions.map((a) =>
        a.kind === 'setStage' && a.stage === stageId ? { ...a, stage: undefined } : a,
      ),
    })),
    ...(cfg.stages
      ? {
          stages: cfg.stages
            .filter((s) => s.id !== stageId)
            .map((s) => ({
              ...s,
              transitions: s.transitions
                .filter((t) => t.to !== stageId)
                .map((t) => ({ ...t, conditions: cleanConds(t.conditions) })),
            })),
        }
      : {}),
  }
}

/**
 * 换类型 / 换来源时要 emit 的**补丁**。
 *
 * 父级是 `{ ...旧对象, ...补丁 }` 的合并写法，所以「清空」必须显式把该键设成
 * undefined 传下去 —— 只在补丁里省略它，旧值会原样留着。
 */
function diffPatch<T extends object>(before: T, after: T): Partial<T> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = (after as unknown as Record<string, unknown>)[k]
  return out as Partial<T>
}

/** 换动作类型的补丁：新类型用不上的字段一律清掉 */
export function actionKindPatch(action: FlowAction, kind: FlowActionKind): Partial<FlowAction> {
  return diffPatch(action, pruneActionForKind(action, kind))
}

/** 换取值来源的补丁：字段名与比较值清空，等用户重新选 */
export function conditionSourcePatch(c: FlowCondition, source: FlowSource): Partial<FlowCondition> {
  return diffPatch(c, clearConditionForSource(c, source))
}

/** 换比较方式的补丁：值清空（「等于文本」与「大于数字」的写法不同） */
export function conditionOpPatch(
  c: FlowCondition,
  op: FlowCondition['op'],
): Partial<FlowCondition> {
  return diffPatch(c, clearConditionForOp(c, op))
}
