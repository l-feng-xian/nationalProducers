/**
 * 让浏览器重新计算一棵子树的「惰性（inert）」状态。
 *
 * ## 为什么需要
 * 打包后的 exe（WebView2 / Chromium）里偶发「切换页面后整个内容区点不动」：
 * 画面完全正常，但 `.main` 及其所有子元素从命中测试里消失了（elementsFromPoint 只剩
 * `.shell → #app → body → html`）。现场核对过：没有 inert 属性、没有打开的 dialog、
 * pointer-events / visibility / clip-path / transform 与正常状态**逐项相同**。
 *
 * 原生 `<dialog>.showModal()` 期间，Chromium 用一个**不暴露给 getComputedStyle 的内部样式位**
 * 把 dialog 之外的内容标成 inert；关闭后本应整体清掉。压力测试里它偶尔在 `.main` 上残留
 * （约每 100~1000 次随机切页 / 开关弹层出现一次，孤立地开关 dialog 复现不出来 —— 是引擎内部的竞态），
 * 残留后要等下一次整棵子树的样式重算才会恢复，表现就是「有时点不动、过一会或刷新才好」。
 *
 * 实测把 `inert` 属性**同一任务内**设上再撤掉，会让 Chromium 对子树整体失效重算，立刻恢复命中。
 * 中间没有渲染帧，所以没有任何闪烁；之前在子树里的焦点也还回去（弹层关闭后焦点会回到触发按钮）。
 */
export function revalidateInert(el: HTMLElement | null | undefined): void {
  if (!el || el.hasAttribute('inert')) return
  const active = document.activeElement as HTMLElement | null
  el.inert = true
  el.inert = false
  if (active && el.contains(active) && document.activeElement !== active) {
    active.focus({ preventScroll: true })
  }
}
