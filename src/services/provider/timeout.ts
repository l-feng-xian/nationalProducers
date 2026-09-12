/**
 * 请求停滞守卫。
 *
 * 为什么判「多久没动静」而不是「总共跑了多久」：长回复本来就能跑好几分钟，
 * 总时长上限会把正常生成误杀。这跟 vector/manager.ts、depth/generate.ts、
 * sync/session.ts 里那三处判死是同一套思路 —— 本文件把它挪到网络层，但
 * **不去重构那三处**：它们守的是 Worker 与 DataChannel，"取消"是 terminate()
 * 与 close()，没有 AbortSignal，硬凑一个共同抽象比重复更糟。
 *
 * ⚠️ 为什么不用 `AbortSignal.any()`：它是 Baseline 2024「新可用」(Safari 17.4)，
 * 而 iPhone 8 / X / SE2 这批机器永远停在 iOS 16.7，本项目硬性要求兼容移动端。
 * 手工挂 abort 监听只需要 iOS 12.2。
 * `AbortSignal.timeout()` 也不行 —— 它是**总时长**，推不后，与上面第一段相悖。
 */

export interface StallGuard {
  /** 交给 fetch 用的信号：调用方按停止、或本守卫判死，两者都会触发它 */
  readonly signal: AbortSignal
  /** true = 被本守卫掐掉的，不是用户按的停止。catch 里靠它区分两种 abort */
  readonly stalled: boolean
  /** 有进展就调一次，把判死计时器推后 */
  kick(): void
  /** 收尾：清计时器 + 摘掉父信号上的监听。必须放在 finally */
  dispose(): void
}

export interface StallOptions {
  /** 相邻两次「有进展」之间允许的最长空窗 */
  idleMs: number
  /** 首次进展（拿到第一个字节）之前的宽限。缺省与 idleMs 相同 */
  firstMs?: number
  /** 调用方的信号。它先响 = 用户主动停止，不算超时 */
  signal?: AbortSignal
}

export function armStall(opts: StallOptions): StallGuard {
  const ctl = new AbortController()
  const parent = opts.signal
  let timer: ReturnType<typeof setTimeout> | null = null
  let stalled = false
  let disposed = false

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (timer) clearTimeout(timer)
    timer = null
    parent?.removeEventListener('abort', onParentAbort)
  }

  function onParentAbort(): void {
    // 先摘监听再 abort：stalled 保持 false，错误照旧翻译成「已中断」
    dispose()
    ctl.abort()
  }

  function arm(ms: number): void {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      dispose()
      ctl.abort()
    }, ms)
  }

  // 进门时父信号可能已经响了（用户在 await providerConfig() 期间按了停止）。
  // 不判这一下，addEventListener 永远等不到事件，请求照样发出去
  if (parent?.aborted) {
    disposed = true
    ctl.abort()
  } else {
    parent?.addEventListener('abort', onParentAbort)
    arm(opts.firstMs ?? opts.idleMs)
  }

  return {
    signal: ctl.signal,
    // getter 而非快照：消费方是在 catch 里读的，那时值才刚定下来
    get stalled() {
      return stalled
    },
    kick: () => arm(opts.idleMs),
    dispose,
  }
}
