/**
 * 局域网 WebRTC 同步会话。
 *
 * 刻意 **不配 STUN**（`iceServers: []`）：这样只会产出 host 候选，流量必然
 * 留在局域网内，不经过任何第三方服务器 —— 这正是「局域网同步」的本意。
 * 代价是跨网段用不了，且依赖 mDNS 解析（见 connect 的超时文案）。
 *
 * 纯 service：不 import vue/pinia，响应式状态由 stores/sync.ts 持有。
 */

import {
  applyBackup,
  buildBackup,
  FULL_SCOPE,
  type ImportResult,
  type SyncScope,
} from '@/services/io/backup'
import { deflateRaw, inflateRaw, fromUtf8, utf8 } from '@/utils/bytes'
import { packSignal, unpackSignal } from './signal'
import type { RelayMessage, SignalClient } from './signaling'
import { decodeFrame, encodeFrame, PROTOCOL_VERSION, type Frame, type Manifest } from './protocol'

/** ICE 收集的等待上限。本地候选是瞬间就有的，超了就按现有候选发车 */
const GATHER_TIMEOUT = 3000
/** 连接建立超时。两端都已开始协商后才用它 —— mDNS 不通时会停在 connecting */
const CONNECT_TIMEOUT = 20_000
/**
 * 发起方「等人来扫码」的上限。
 *
 * 这段等待是**人的节奏**不是网络的节奏：对方要摸出手机、打开应用、点扫码、
 * 对准屏幕，半分钟一分钟都很正常。一开始这里和 CONNECT_TIMEOUT 共用 20 秒，
 * 结果二维码刚显示出来没多久就自己报「连接超时，检查 Wi-Fi」—— 既打断了
 * 正常操作，给的还是个误导性的原因。
 */
const SCAN_WAIT_TIMEOUT = 5 * 60_000
/** 停滞超时：每收到一片就重置。用「多久没动静」而不是「总共跑了多久」判死 */
const STALL_TIMEOUT = 30_000

/** 分片大小。实测 sctp.maxMessageSize = 262144，留足余量取 64KB */
const CHUNK = 64 * 1024
/** 发送缓冲高水位，超过就等排空，否则大库会把内存顶爆 */
const BUFFER_HIGH = 4 * 1024 * 1024
const BUFFER_LOW = 1 * 1024 * 1024

export interface Progress {
  loaded: number
  total: number
}

export interface SessionHooks {
  /** 连接状态变化。UI 靠它从「等待扫码」切到「已连接」 */
  onOpen?: () => void
  onClose?: (reason: string) => void
  /** 对方要发数据过来，返回 true 才接收。UI 在这里弹确认页 */
  onIncoming?: (m: Manifest) => Promise<boolean>
  onProgress?: (p: Progress) => void
  /** 接收完成并已写库 */
  onApplied?: (r: ImportResult) => void
}

function waitGather(pc: RTCPeerConnection): Promise<void> {
  return new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res()
    const t = setTimeout(res, GATHER_TIMEOUT)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t)
        res()
      }
    })
  })
}

export class SyncSession {
  readonly pc: RTCPeerConnection
  #dc: RTCDataChannel | null = null
  #hooks: SessionHooks
  #closed = false

  /** 收包缓冲。只在接收期间非空 */
  #rx: { chunks: Uint8Array[]; got: number; manifest: Manifest } | null = null
  /** 我方主动 pull 时置位：对端回来的 manifest 无需再问用户 */
  #pullPending = false
  #doneWaiters: ((r: ImportResult) => void)[] = []
  #failWaiters: ((e: Error) => void)[] = []
  #stallTimer: ReturnType<typeof setTimeout> | null = null

  // ── 信令模式（扫一次码）用到的状态 ──
  #signal: SignalClient | null = null
  /** 对端在信令服务器上的 id，ICE 候选要发给它 */
  #peerId = ''
  /** 配对令牌：同一台信令服务器上别人就算猜到 id 也接不进来 */
  #token = ''
  /**
   * 在 setRemoteDescription 之前到达的 ICE 候选。
   *
   * trickle 模式下候选和 SDP 是两条独立的消息，网络上谁先到不一定。
   * 抢跑的候选直接 addIceCandidate 会抛 InvalidStateError，必须先攒着，
   * 等远端描述落位再补进去 —— 漏掉这一步的表现是「偶尔连不上」，很难复现。
   */
  #pendingIce: RTCIceCandidateInit[] = []

  constructor(hooks: SessionHooks = {}) {
    this.#hooks = hooks
    this.pc = new RTCPeerConnection({ iceServers: [] })
    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState
      if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        this.#fail(new Error('连接已断开'))
      }
    })
  }

  /** 发起方：建 datachannel、出 offer，返回要显示成二维码的配对码 */
  async createOffer(): Promise<string> {
    const dc = this.pc.createDataChannel('sync', { ordered: true })
    this.#bindChannel(dc)
    await this.pc.setLocalDescription(await this.pc.createOffer())
    await waitGather(this.pc)
    const sdp = this.pc.localDescription?.sdp
    if (!sdp) throw new Error('无法生成本机的连接信息')
    return packSignal(sdp, 'offer')
  }

  /** 加入方：吃下对方的 offer 码，返回自己的 answer 码 */
  async acceptOffer(code: string): Promise<string> {
    const { kind, sdp } = unpackSignal(code)
    if (kind !== 'offer') throw new Error('这是一个应答码，请扫描对方的发起码')
    this.pc.addEventListener('datachannel', (e) => this.#bindChannel(e.channel))
    await this.pc.setRemoteDescription({ type: 'offer', sdp })
    await this.pc.setLocalDescription(await this.pc.createAnswer())
    await waitGather(this.pc)
    const local = this.pc.localDescription?.sdp
    if (!local) throw new Error('无法生成本机的连接信息')
    return packSignal(local, 'answer')
  }

  /** 发起方：吃下对方的 answer 码，之后等 onOpen */
  async acceptAnswer(code: string): Promise<void> {
    const { kind, sdp } = unpackSignal(code)
    if (kind !== 'answer') throw new Error('这是一个发起码，请扫描对方的应答码')
    await this.pc.setRemoteDescription({ type: 'answer', sdp })
  }

  // ───────── 信令模式：只需扫一次码 ─────────

  /**
   * 把 ICE 候选边收集边发给对端（trickle）。
   *
   * 无服务器模式必须等候选收集完才能生成二维码；有了信令通道，候选可以
   * 随时补发，所以这里不再 await 收集完成 —— 连接建立明显更快。
   */
  #wireTrickle(): void {
    this.pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate || !this.#peerId) return
      this.#signal?.send({ type: 'ice', to: this.#peerId, candidate: e.candidate.toJSON() })
    })
  }

  async #flushIce(): Promise<void> {
    const queued = this.#pendingIce
    this.#pendingIce = []
    for (const c of queued) {
      try {
        await this.pc.addIceCandidate(c)
      } catch {
        // 单个候选无效不该拖垮整条连接，其它候选仍可能连通
      }
    }
  }

  /** 发起方：连上信令后等对方扫码接入 */
  hostViaSignal(signal: SignalClient, token: string): void {
    this.#signal = signal
    this.#token = token
    // 通道由扫码方创建，这边只管接住
    this.pc.addEventListener('datachannel', (e) => this.#bindChannel(e.channel))
    this.#wireTrickle()
  }

  /** 扫码方：主动向二维码里的那个 id 发起连接 */
  async joinViaSignal(signal: SignalClient, targetId: string, token: string): Promise<void> {
    this.#signal = signal
    this.#token = token
    this.#peerId = targetId
    this.#wireTrickle()
    const dc = this.pc.createDataChannel('sync', { ordered: true })
    this.#bindChannel(dc)
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    signal.send({ type: 'offer', to: targetId, sdp: offer.sdp ?? '', token })
  }

  /** 信令服务器转发过来的消息。由 store 接到 SignalClient 的 onRelay 上 */
  async handleRelay(m: RelayMessage): Promise<void> {
    try {
      switch (m.type) {
        case 'offer': {
          // 令牌不对就是别人猜到了我的 id，直接不理
          if (!m.token || m.token !== this.#token) return
          if (this.#peerId && this.#peerId !== m.from) return // 已经和别人配上了
          this.#peerId = m.from
          await this.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp ?? '' })
          await this.#flushIce()
          const answer = await this.pc.createAnswer()
          await this.pc.setLocalDescription(answer)
          this.#signal?.send({ type: 'answer', to: m.from, sdp: answer.sdp ?? '' })
          return
        }
        case 'answer': {
          if (m.from !== this.#peerId) return
          await this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp ?? '' })
          await this.#flushIce()
          return
        }
        case 'ice': {
          if (m.from !== this.#peerId || !m.candidate) return
          if (!this.pc.remoteDescription) {
            this.#pendingIce.push(m.candidate)
            return
          }
          try {
            await this.pc.addIceCandidate(m.candidate)
          } catch {
            // 同上：单个候选失败不致命
          }
          return
        }
        case 'bye':
          if (m.from === this.#peerId) this.#fail(new Error('对方已断开'))
          return
      }
    } catch (e) {
      this.#fail(toErr(e))
    }
  }

  /**
   * 等连接真正可用。
   *
   * `waitingForScan` 区分两种等待：等人扫码（分钟级，超时文案是「没人扫」）
   * 与等 ICE 协商完成（秒级，超时文案才该提 Wi-Fi 与 AP 隔离）。
   * 混用会在二维码刚亮起来时就误报网络故障。
   */
  waitOpen(opts: { waitingForScan?: boolean } = {}): Promise<void> {
    if (this.#dc?.readyState === 'open') return Promise.resolve()
    const scan = opts.waitingForScan === true
    return new Promise((res, rej) => {
      const t = setTimeout(
        () => {
          rej(
            new Error(
              scan
                ? '等了 5 分钟没有设备扫码。二维码已失效，请重新发起。'
                : '连接超时。请确认两台设备连的是同一个 Wi-Fi；部分访客网络与开启了 AP 隔离的路由器会阻断设备间直连。',
            ),
          )
        },
        scan ? SCAN_WAIT_TIMEOUT : CONNECT_TIMEOUT,
      )
      const prevOpen = this.#hooks.onOpen
      this.#hooks.onOpen = () => {
        clearTimeout(t)
        prevOpen?.()
        res()
      }
      this.#failWaiters.push((e) => {
        clearTimeout(t)
        rej(e)
      })
    })
  }

  #bindChannel(dc: RTCDataChannel): void {
    this.#dc = dc
    dc.binaryType = 'arraybuffer'
    dc.bufferedAmountLowThreshold = BUFFER_LOW
    dc.addEventListener('open', () => {
      this.#send({ t: 'hello', version: PROTOCOL_VERSION })
      this.#hooks.onOpen?.()
    })
    dc.addEventListener('close', () => this.#hooks.onClose?.('通道已关闭'))
    dc.addEventListener('message', (e) => {
      void this.#onMessage(e.data)
    })
  }

  #send(f: Frame): void {
    this.#dc?.send(encodeFrame(f))
  }

  async #onMessage(data: unknown): Promise<void> {
    try {
      if (typeof data === 'string') {
        const f = decodeFrame(data)
        if (!f) throw new Error('收到无法解析的数据')
        await this.#onFrame(f)
        return
      }
      // 二进制 = 数据分片
      if (!this.#rx) throw new Error('收到了未经协商的数据')
      const bytes = new Uint8Array(data as ArrayBuffer)
      this.#rx.chunks.push(bytes)
      this.#rx.got += bytes.length
      this.#armStall()
      this.#hooks.onProgress?.({ loaded: this.#rx.got, total: this.#rx.manifest.bytes })
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      this.#send({ t: 'err', message: err.message })
      this.#fail(err)
    }
  }

  async #onFrame(f: Frame): Promise<void> {
    switch (f.t) {
      case 'hello':
        if (f.version !== PROTOCOL_VERSION) {
          throw new Error(`对方的应用版本不一致（协议 v${f.version}，本机 v${PROTOCOL_VERSION}）`)
        }
        return
      case 'pull':
        // 对方要拉数据，等同于我方发送
        void this.push(f.scope).catch((e: unknown) => this.#fail(toErr(e)))
        return
      case 'manifest': {
        const ok = this.#pullPending ? true : ((await this.#hooks.onIncoming?.(f)) ?? false)
        this.#pullPending = false
        if (!ok) {
          this.#send({ t: 'reject', reason: '对方拒绝了本次同步' })
          this.#rx = null
          return
        }
        this.#rx = { chunks: [], got: 0, manifest: f }
        this.#hooks.onProgress?.({ loaded: 0, total: f.bytes })
        this.#armStall()
        this.#send({ t: 'accept' })
        return
      }
      case 'eof': {
        const rx = this.#rx
        this.#rx = null
        this.#clearStall()
        if (!rx) throw new Error('没有正在进行的接收')
        const raw = await inflateRaw(concat(rx.chunks))
        const file: unknown = JSON.parse(fromUtf8(raw))
        const result = await applyBackup(file as Parameters<typeof applyBackup>[0])
        this.#hooks.onApplied?.(result)
        this.#send({ t: 'done', result })
        return
      }
      case 'accept':
        this.#acceptWaiter?.(true)
        return
      case 'reject':
        this.#acceptWaiter?.(false)
        this.#fail(new Error(f.reason))
        return
      case 'done':
        this.#clearStall()
        for (const w of this.#doneWaiters) w(f.result)
        this.#doneWaiters = []
        return
      case 'err':
        this.#fail(new Error(f.message))
        return
    }
  }

  #acceptWaiter: ((ok: boolean) => void) | null = null

  /**
   * 把本地数据推给对端。resolve 时对端已经写库完成。
   *
   * 进度按**压缩后**字节走：载荷里的头像是 base64 过的压缩图，几乎压不动，
   * 拿原始大小算会让进度条一路卡在末尾。
   */
  async push(scope: Partial<SyncScope>, onProgress?: (p: Progress) => void): Promise<ImportResult> {
    const dc = this.#dc
    if (!dc || dc.readyState !== 'open') throw new Error('尚未连接')

    const resolved: SyncScope = { ...FULL_SCOPE, ...scope }
    const file = await buildBackup(resolved)
    const payload = await deflateRaw(utf8(JSON.stringify(file)))

    const manifest: Manifest = {
      t: 'manifest',
      scope: resolved,
      bytes: payload.length,
      counts: {
        characters: file.characters.length,
        worldbooks: file.worldbooks.length,
        groups: file.groups.length,
        chats: file.chats.length,
        messages: file.messages.length,
        blobs: file.blobs.length,
      },
      chatIds: file.chats.map((c) => idOf(c)),
      charIds: file.characters.map((c) => idOf(c)),
    }

    const accepted = await new Promise<boolean>((res, rej) => {
      this.#acceptWaiter = res
      this.#failWaiters.push(rej)
      this.#send(manifest)
    })
    this.#acceptWaiter = null
    if (!accepted) throw new Error('对方拒绝了本次同步')

    const done = new Promise<ImportResult>((res, rej) => {
      this.#doneWaiters.push(res)
      this.#failWaiters.push(rej)
    })

    const max = Math.min(CHUNK, this.pc.sctp?.maxMessageSize ?? CHUNK)
    for (let off = 0; off < payload.length; off += max) {
      if (this.#closed) throw new Error('同步已取消')
      await this.#drain(dc)
      const slice = payload.subarray(off, off + max)
      // 必须拷一份：subarray 与原数组共享 buffer，直接 send 在部分实现下会连累整块
      dc.send(new Uint8Array(slice).buffer as ArrayBuffer)
      onProgress?.({ loaded: Math.min(off + max, payload.length), total: payload.length })
      this.#hooks.onProgress?.({
        loaded: Math.min(off + max, payload.length),
        total: payload.length,
      })
    }
    this.#send({ t: 'eof' })
    this.#armStall()
    return done
  }

  /** 反过来：请对端把它的数据发给我 */
  async pull(scope: Partial<SyncScope>): Promise<ImportResult> {
    const dc = this.#dc
    if (!dc || dc.readyState !== 'open') throw new Error('尚未连接')
    this.#pullPending = true
    const applied = new Promise<ImportResult>((res, rej) => {
      const prev = this.#hooks.onApplied
      this.#hooks.onApplied = (r) => {
        prev?.(r)
        res(r)
      }
      this.#failWaiters.push(rej)
    })
    this.#send({ t: 'pull', scope: scope as SyncScope })
    return applied
  }

  /**
   * 等发送缓冲排空到低水位。
   *
   * 必须同时监听 close/error：只等 bufferedamountlow 的话，通道在等待期间断掉
   * 就没人会再唤醒这个 Promise —— 发送循环会**静静地永远挂在这一行**，
   * 既不报错也不超时（停滞计时器此时还没启动）。
   */
  #drain(dc: RTCDataChannel): Promise<void> {
    if (dc.bufferedAmount < BUFFER_HIGH) return Promise.resolve()
    return new Promise((res, rej) => {
      const cleanup = (): void => {
        dc.removeEventListener('bufferedamountlow', onLow)
        dc.removeEventListener('close', onDead)
        dc.removeEventListener('error', onDead)
      }
      const onLow = (): void => {
        cleanup()
        res()
      }
      const onDead = (): void => {
        cleanup()
        rej(new Error('连接在传输过程中断开'))
      }
      dc.addEventListener('bufferedamountlow', onLow)
      dc.addEventListener('close', onDead)
      dc.addEventListener('error', onDead)
    })
  }

  #armStall(): void {
    this.#clearStall()
    this.#stallTimer = setTimeout(() => {
      this.#fail(new Error('传输超时，长时间没有进展'))
    }, STALL_TIMEOUT)
  }

  #clearStall(): void {
    if (this.#stallTimer) clearTimeout(this.#stallTimer)
    this.#stallTimer = null
  }

  #fail(e: Error): void {
    if (this.#closed) return
    this.#clearStall()
    const waiters = this.#failWaiters
    this.#failWaiters = []
    for (const w of waiters) w(e)
    this.#hooks.onClose?.(e.message)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#clearStall()
    // 告诉对端我走了，它就能立刻报「对方已断开」而不是干等超时
    if (this.#peerId) this.#signal?.send({ type: 'bye', to: this.#peerId })
    try {
      this.#dc?.close()
      this.pc.close()
      this.#signal?.close()
    } catch {
      // 已经关掉了，无所谓
    }
    this.#signal = null
  }
}

function idOf(row: unknown): string {
  return (row as { id?: string })?.id ?? ''
}

function toErr(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
