/**
 * 通用关系图谱的视图类型。
 *
 * ## 设计原则：画布只认「画得出来的东西」
 * 这里**刻意不包含** `desc` / `score` / `trust` 这类业务字段。画布不该知道
 * 群聊有说明、世界有好感度 —— 它只负责画节点、画有向边、画标签。
 * 数值由父级渲染成 `badge` 字符串再传进来，编辑一律交回父级。
 *
 * 这条线划清楚了，同一个画布才能同时服务群聊（就地气泡编辑）与
 * 无限世界（侧面板 + 好感/信任滑块），而不用在组件里塞 `if (isWorld)`。
 */

/** 节点在画布上的逻辑坐标（viewBox 单位，与 CSS 像素 1:1） */
export interface GraphLayout {
  x: number
  y: number
}

export type GraphLayoutMap = Record<string, GraphLayout>

export interface GraphNode {
  id: string
  name: string
  /** 「我」节点：虚线描边 + 品牌色高亮。画布上全是角色，混进去就分不清哪个是自己 */
  isUser?: boolean
  /**
   * 有则画头像，无则画名字首字。
   *
   * ⚠️ 这里是**已解析好的 URL**，不是 blobId。objectURL 的引用计数与宽限回收
   * 由 `@/composables/useObjectUrl` 管理，那套生命周期不该塞进一个纯展示组件 ——
   * 画布提前卸载或列表抖动都会让它算错引用数。父级解析好再传进来。
   */
  avatarUrl?: string
  /** 节点名下的第二行小字，如职业 */
  subtitle?: string
  dimmed?: boolean
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  label: string
  /**
   * 补充描述。与 label 同一层级 —— 都是「这条边是什么」的直接描述，
   * 气泡编辑器要用它做初值。
   *
   * ⚠️ 这不违反「画布不认业务字段」：被排除在外的是 score/trust 那种
   * 需要业务规则才能解释的数值，desc 只是一段自由文本。
   */
  desc?: string
  /**
   * 标签下方的小字徽标，如 `亲近 +42 · 信任 70`。
   *
   * ⚠️ 由父级**渲染好**再传进来。画布不认识 score/trust 的语义，
   * 也不该决定「42 算不算亲近」—— 那是业务规则。
   */
  badge?: string
  tone?: 'positive' | 'negative' | 'neutral'
}

/** 画布向父级申请的修改。画布**永不**直接写 props.edges */
export interface GraphEdgePatch {
  label?: string
  desc?: string
}

/**
 * 代表「用户自己」的哨兵节点 id。
 *
 * 与 `@/types/group` 的 `USER_NODE_ID` 同值，在这里重新导出是为了让
 * 无限世界模块不必反向依赖群聊模块。
 */
export const GRAPH_USER_NODE = '__user__'
