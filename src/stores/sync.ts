/**
 * 扫码同步的界面状态机。
 *
 * 传输逻辑全在 services/sync/session.ts，这里只负责「当前处在哪一步」和进度，
 * 与仓里其它 store 一样：service 纯、store 管响应式。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { FULL_SCOPE, type ImportResult, type SyncScope } from '@/services/io/backup'
import { SyncSession } from '@/services/sync/session'
import type { Manifest } from '@/services/sync/protocol'
import {
  isRendezvous,
  makeToken,
  packRendezvous,
  rendezvousUrls,
  SAME_ORIGIN,
  signalCandidates,
  SignalClient,
  unpackRendezvous,
} from '@/services/sync/signaling'

/**
 * 步骤：
 *  pick      选「发起」还是「加入」
 *  showCode  显示自己的码，等对方扫
 *  scan      扫对方的码
 *  connecting 两边的码都交换完了，等通道真正打开
 *  ready     已连通，选方向与范围
 *  confirm   收到对方的 manifest，等用户点接收
 *  transfer  传输中
 *  done / error
 */
export type SyncStep =
  | 'pick'
  | 'showCode'
  | 'scan'
  | 'connecting'
  | 'ready'
  | 'confirm'
  | 'transfer'
  | 'done'
  | 'error'

export type SyncRole = 'host' | 'guest'

export const useSyncStore = defineStore('sync', () => {
  const step = ref<SyncStep>('pick')
  const role = ref<SyncRole>('host')
  const error = ref('')
  /** 本机要展示成二维码的配对码 */
  const myCode = ref('')
  const loaded = ref(0)
  const total = ref(0)
  const result = ref<ImportResult | null>(null)
  /**
   * 本机是不是**收**数据的那一方。
   *
   * 只靠 result 判断不行：push 成功时 result 里装的是**对端**写库的条数，
   * 发送方据此刷新页面纯属白刷 —— 它自己的库一个字节都没变。
   */
  const received = ref(false)
  /** 对方发来的清单，确认页用 */
  const incoming = ref<Manifest | null>(null)
  /** 接收方确认页的回调闸门 */
  let confirmGate: ((ok: boolean) => void) | null = null

  /**
   * 是否走信令服务器。
   *
   * 有服务器时**只需扫一次码**：二维码里只放「去哪台服务器找哪个 id」，
   * SDP 与 ICE 都在 WebSocket 上来回走。服务器没起时自动退回无服务器模式，
   * 那种要两个码扫两次 —— 功能不会因为服务器没开就整个不可用。
   */
  const relayed = ref(true)
  /** 退回无服务器模式的原因，显示给用户看，免得以为是自己操作错了 */
  const fallbackReason = ref('')
  let signal: SignalClient | null = null

  /** 默认不勾「设置」—— 它会整包覆盖对方的接口地址、模型与人设 */
  const scope = ref<SyncScope>({ ...FULL_SCOPE, settings: false })

  let session: SyncSession | null = null

  const pct = computed(() => {
    if (!total.value) return 0
    return Math.min(100, Math.round((loaded.value / total.value) * 100))
  })

  function reset(): void {
    session?.close()
    session = null
    signal?.close()
    signal = null
    confirmGate = null
    relayed.value = true
    fallbackReason.value = ''
    step.value = 'pick'
    role.value = 'host'
    error.value = ''
    myCode.value = ''
    loaded.value = 0
    total.value = 0
    result.value = null
    received.value = false
    incoming.value = null
    scope.value = { ...FULL_SCOPE, settings: false }
  }

  function fail(e: unknown): void {
    error.value = e instanceof Error ? e.message : String(e)
    step.value = 'error'
  }

  function makeSession(): SyncSession {
    const s = new SyncSession({
      onProgress: (p) => {
        loaded.value = p.loaded
        total.value = p.total
      },
      onIncoming: (m) => {
        incoming.value = m
        step.value = 'confirm'
        return new Promise<boolean>((res) => {
          confirmGate = res
        })
      },
      onApplied: (r) => {
        result.value = r
        received.value = true
        step.value = 'done'
      },
      onClose: (reason) => {
        // 已经走完的流程不该被收尾的 close 打成错误
        if (step.value === 'done') return
        fail(new Error(reason))
      },
    })
    session = s
    return s
  }

  /**
   * 连信令服务器。连不上不算失败 —— 退回无服务器模式，只是要多扫一次码。
   * 返回是否连上。
   */
  async function trySignal(name: string): Promise<boolean> {
    const s = new SignalClient({
      onRelay: (m) => void session?.handleRelay(m),
      onClose: (reason) => {
        // 通道已经建好之后信令断开无所谓，数据是点对点走的
        if (step.value === 'transfer' || step.value === 'done') return
        if (step.value === 'showCode' || step.value === 'connecting') fail(new Error(reason))
      },
    })
    try {
      await s.connectAny(signalCandidates(), name)
      signal = s
      relayed.value = true
      return true
    } catch (e) {
      s.close()
      signal = null
      relayed.value = false
      fallbackReason.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  /** 发起方：出码 → 等对方扫。有信令时只出这一个码，扫完直接连上 */
  async function startHost(): Promise<void> {
    try {
      role.value = 'host'
      error.value = ''
      step.value = 'connecting'
      const s = makeSession()

      if (await trySignal('发起方')) {
        const token = makeToken()
        s.hostViaSignal(signal!, token)
        // url 写 SAME_ORIGIN：扫码方按自己的同源规则去算，
        // 否则手机会拿到发起方的 localhost 地址，连的是它自己
        myCode.value = packRendezvous({ url: SAME_ORIGIN, id: signal!.id, token })
        step.value = 'showCode'
        // 对方扫码后会自己把 offer 送上门，这里等通道打开即可。
        // 这一段等的是**人**（掏手机、开应用、对准摄像头），不是网络，
        // 所以走分钟级的等待，否则二维码刚亮起来就会自己报「连接超时」
        await s.waitOpen({ waitingForScan: true })
        step.value = 'ready'
        return
      }

      // 无服务器：退回两个码的手动交换
      myCode.value = await s.createOffer()
      step.value = 'showCode'
    } catch (e) {
      fail(e)
    }
  }

  /** 加入方：去扫对方的码 */
  function startGuest(): void {
    role.value = 'guest'
    error.value = ''
    makeSession()
    step.value = 'scan'
  }

  /**
   * 吃下扫到的码。
   * 加入方扫到的是 offer（回一个 answer 码给对方扫）；发起方扫到的是 answer（直接连通）。
   */
  async function feedCode(code: string): Promise<void> {
    const s = session
    if (!s) return
    try {
      // 会合码（MJ| 开头）= 有信令服务器，扫这一次就够了
      if (isRendezvous(code)) {
        const rv = unpackRendezvous(code)
        step.value = 'connecting'
        const sig = new SignalClient({
          onRelay: (m) => void session?.handleRelay(m),
          onClose: (reason) => {
            if (step.value === 'transfer' || step.value === 'done') return
            if (step.value === 'connecting') fail(new Error(reason))
          },
        })
        await sig.connectAny(rendezvousUrls(rv), '扫码方')
        signal = sig
        relayed.value = true
        await s.joinViaSignal(sig, rv.id, rv.token)
        await s.waitOpen()
        step.value = 'ready'
        return
      }

      // 无服务器模式：两个码手动交换
      relayed.value = false
      let waitingForScan = false
      if (role.value === 'guest') {
        // 应答码要一直显示着让对方扫，所以停在 showCode 等通道打开
        myCode.value = await s.acceptOffer(code)
        step.value = 'showCode'
        waitingForScan = true
      } else {
        await s.acceptAnswer(code)
        step.value = 'connecting'
      }
      await s.waitOpen({ waitingForScan })
      step.value = 'ready'
    } catch (e) {
      fail(e)
    }
  }

  /** 发起方在出码后切到扫描态，去扫对方的应答码 */
  function toScan(): void {
    error.value = ''
    step.value = 'scan'
  }

  async function push(): Promise<void> {
    const s = session
    if (!s) return
    try {
      step.value = 'transfer'
      loaded.value = 0
      total.value = 0
      result.value = await s.push(scope.value)
      step.value = 'done'
    } catch (e) {
      fail(e)
    }
  }

  async function pull(): Promise<void> {
    const s = session
    if (!s) return
    try {
      step.value = 'transfer'
      loaded.value = 0
      total.value = 0
      await s.pull(scope.value)
      // 写库完成由 onApplied 推进到 done
    } catch (e) {
      fail(e)
    }
  }

  /** 接收方在确认页点「接收 / 拒绝」 */
  function answerConfirm(ok: boolean): void {
    step.value = ok ? 'transfer' : 'ready'
    confirmGate?.(ok)
    confirmGate = null
    if (!ok) incoming.value = null
  }

  return {
    step,
    role,
    error,
    myCode,
    loaded,
    total,
    pct,
    result,
    received,
    incoming,
    relayed,
    fallbackReason,
    scope,
    reset,
    startHost,
    startGuest,
    feedCode,
    toScan,
    push,
    pull,
    answerConfirm,
  }
})
