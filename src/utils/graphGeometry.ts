/**
 * 关系图谱的几何计算（需求 3）。
 *
 * 有向边：A→B 与 B→A 是两条独立的边，必须向**两侧弯开**，
 * 否则会完全重叠、看起来只有一条。
 */

export interface Pt {
  x: number
  y: number
}

export const NODE_R = 26

/**
 * 弯曲方向符号。
 *
 * ⚠️ 这里**必须对两个方向返回同一个值**，看起来反直觉但推导如下：
 * `edgeGeometry` 里的法向量 n = (-dy, dx)/len 依赖 d = b - a。
 * 交换端点时 d 取反 → n 也取反。若再把符号也取反，两次取反相互抵消，
 * A→B 与 B→A 会弯到**同一侧**而完全重叠（只看得见一条边）。
 * 保持符号一致，配合已经翻转的法向量，才能得到左右分开的两条弧。
 *
 * 参数保留 from/to 只为调用处可读，以及将来若要按对做差异化弯曲。
 */
export function bowSignOf(_from: string, _to: string): 1 | -1 {
  return 1
}

export interface EdgeGeometry {
  /** 二次贝塞尔路径，起终点已裁到节点圆之外 */
  path: string
  /** t=0.5 处的点，放关系标签 */
  label: Pt
}

/**
 * 计算一条边的路径。
 * @param bow 弯曲幅度（像素），0 = 直线
 */
export function edgeGeometry(a: Pt, b: Pt, bowSign: 1 | -1, bow = 34): EdgeGeometry {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  // 单位法向量，用来把控制点推离直线
  const nx = -dy / len
  const ny = dx / len
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const cx = mx + nx * bow * bowSign
  const cy = my + ny * bow * bowSign

  // 起终点各自沿「指向控制点」的方向裁到圆外，箭头才不会插进节点里
  const start = shrink(a, { x: cx, y: cy }, NODE_R)
  const end = shrink(b, { x: cx, y: cy }, NODE_R + 6)

  return {
    path: `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`,
    // 二次贝塞尔 t=0.5：(P0 + 2C + P2) / 4
    label: {
      x: (start.x + 2 * cx + end.x) / 4,
      y: (start.y + 2 * cy + end.y) / 4,
    },
  }
}

function shrink(from: Pt, toward: Pt, r: number): Pt {
  const dx = toward.x - from.x
  const dy = toward.y - from.y
  const len = Math.hypot(dx, dy) || 1
  return { x: from.x + (dx / len) * r, y: from.y + (dy / len) * r }
}

export function hitTestNode(
  pt: Pt,
  nodes: { id: string; x: number; y: number }[],
  r = NODE_R,
): string | undefined {
  // 倒序：后画的（视觉在上层）优先命中
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (!n) continue
    if (Math.hypot(pt.x - n.x, pt.y - n.y) <= r) return n.id
  }
  return undefined
}

/** 成员初次进入图谱时，沿圆周排布 */
export function circleLayout(ids: string[], w: number, h: number): Record<string, Pt> {
  const out: Record<string, Pt> = {}
  const n = Math.max(1, ids.length)
  const r = Math.max(110, Math.min(Math.min(w, h) / 2 - 70, 80 + n * 22))
  ids.forEach((id, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
    out[id] = { x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a) }
  })
  return out
}
