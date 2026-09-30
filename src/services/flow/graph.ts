/**
 * 流程配置 → 节点流程图（给 FlowGraph 用，纯 TS，可离线测）。
 *
 * 节点：阶段 s:<id>、规则 r:<id>、动作 a:<规则 id>:<动作 id>。
 * 连线：
 *  - transition 阶段 → 阶段（阶段出口，条件成立时进入）
 *  - chain      规则 → 动作 → 下一个动作（依次执行）
 *  - jump       「切换阶段」动作 → 目标阶段
 *  - when       阶段 → 规则（规则里有「当前阶段 = 该阶段」的条件）
 * 坐标优先取 cfg.layout，没有就按下标自动排：阶段一行在上，规则一行一条、动作向右展开。
 */
import type { FlowConfig, FlowLayout } from '@/types/flow'

export type NodeKind = 'stage' | 'rule' | 'action'
export type EdgeKind = 'transition' | 'chain' | 'jump' | 'when'

export interface GraphNode {
  id: string
  type: NodeKind
  position: { x: number; y: number }
  data: { stageId?: string; ruleId?: string; actionId?: string; initial?: boolean }
}
export interface GraphEdge {
  id: string
  source: string
  target: string
  type: 'flow'
  markerEnd: 'arrowclosed'
  /** 回连的线（切换阶段 / 阶段条件）从节点的上/下侧接出，免得横穿整张画布 */
  sourceHandle?: string
  targetHandle?: string
  data: { kind: EdgeKind; stageId?: string; transitionId?: string; ruleId?: string }
}

/** 辅助锚点 id：节点组件里对应的 <Handle :id> 必须一致 */
export const AUX_HANDLE = {
  /** 动作底部的源点：切换阶段 */
  jumpSource: 'aux-jump-out',
  /** 阶段底部的源点：阶段条件 */
  whenSource: 'aux-when-out',
  /** 规则顶部的目标点：阶段条件 */
  whenTarget: 'aux-when-in',
} as const

/** 流程图上当前选中的东西（检查面板据此显示对应表单） */
export type FlowSelection =
  | { kind: 'stage'; stageId: string }
  | { kind: 'transition'; stageId: string; transitionId: string }
  | { kind: 'rule'; ruleId: string }
  | { kind: 'action'; ruleId: string; actionId: string }
  | null

export const stageNodeId = (id: string) => `s:${id}`
export const ruleNodeId = (id: string) => `r:${id}`
export const actionNodeId = (ruleId: string, id: string) => `a:${ruleId}:${id}`

const STAGE_GAP = 260
/** 阶段一行与规则一行之间留出垂直空间：阶段条件 / 切换阶段的线走这一段 */
const RULE_TOP = 260
const RULE_GAP = 150
const ACTION_X = 300
const ACTION_GAP = 250

export function buildGraph(cfg: FlowConfig): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const layout = cfg.layout ?? {}
  const stages = cfg.stages ?? []
  const stageIds = new Set(stages.map((s) => s.id))
  const at = (id: string, x: number, y: number) => layout[id] ?? { x, y }
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const edge = (
    id: string,
    source: string,
    target: string,
    data: GraphEdge['data'],
    handles: { sourceHandle?: string; targetHandle?: string } = {},
  ) => edges.push({ id, source, target, type: 'flow', markerEnd: 'arrowclosed', data, ...handles })

  stages.forEach((s, i) => {
    const id = stageNodeId(s.id)
    nodes.push({
      id,
      type: 'stage',
      position: at(id, i * STAGE_GAP, 0),
      data: { stageId: s.id, ...(i === 0 ? { initial: true } : {}) },
    })
    for (const t of s.transitions) {
      if (stageIds.has(t.to)) {
        edge(`t:${s.id}:${t.id}`, id, stageNodeId(t.to), {
          kind: 'transition',
          stageId: s.id,
          transitionId: t.id,
        })
      }
    }
  })

  const top = stages.length ? RULE_TOP : 0
  cfg.rules.forEach((r, i) => {
    const id = ruleNodeId(r.id)
    const y = top + i * RULE_GAP
    nodes.push({ id, type: 'rule', position: at(id, 0, y), data: { ruleId: r.id } })
    let prev = id
    r.actions.forEach((a, j) => {
      const aid = actionNodeId(r.id, a.id)
      nodes.push({
        id: aid,
        type: 'action',
        position: at(aid, ACTION_X + j * ACTION_GAP, y),
        data: { ruleId: r.id, actionId: a.id },
      })
      edge(`c:${r.id}:${a.id}`, prev, aid, { kind: 'chain', ruleId: r.id })
      prev = aid
      if (a.kind === 'setStage' && a.stage && stageIds.has(a.stage)) {
        edge(
          `j:${r.id}:${a.id}`,
          aid,
          stageNodeId(a.stage),
          { kind: 'jump', ruleId: r.id },
          {
            sourceHandle: AUX_HANDLE.jumpSource,
          },
        )
      }
    })
    for (const c of r.conditions) {
      if (c.source === 'stage' && stageIds.has(c.value)) {
        edge(
          `w:${r.id}:${c.id}`,
          stageNodeId(c.value),
          id,
          { kind: 'when', ruleId: r.id },
          { sourceHandle: AUX_HANDLE.whenSource, targetHandle: AUX_HANDLE.whenTarget },
        )
      }
    }
  })
  return { nodes, edges }
}

/** 只保留仍存在的节点坐标：删掉的规则 / 阶段 / 动作不在配置里留垃圾 */
export function pruneLayout(cfg: FlowConfig): FlowLayout | undefined {
  if (!cfg.layout) return undefined
  const alive = new Set(buildGraph({ ...cfg, layout: {} }).nodes.map((n) => n.id))
  const out: FlowLayout = {}
  for (const [k, v] of Object.entries(cfg.layout)) if (alive.has(k)) out[k] = v
  return Object.keys(out).length ? out : undefined
}
