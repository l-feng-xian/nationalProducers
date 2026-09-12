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
  /**
   * 有人从在线名单里点了我，返回 true 才接受连接。
   *
   * 扫码连接靠二维码里的令牌证明「对方确实看过我的屏幕」；从名单点击没有
   * 这个前提，所以**必须由用户当面点头**，否则信令服务器上任何人都能凭
   * 一个 id 直接把通道建起来。
   */
  onInvite?: (from: { id: string; name: string }) => Promise<boolean>
  /**
   * 对方要**从我这里拉数据**，返回 true 才发。UI 在这里弹确认页。
   *
   * ⚠️ 这一道是必须的，而且此前是缺的。`pull` 帧一到就直接 `push()` 出去了 ——
   * 也就是说通道一旦接通，对端发一句 `{"t":"pull"}` 就能把本机整个库（角色、
   * 全部会话与消息、世界，还有 settings 里的接口地址与人设）导出发走，
   * 本机**不弹任何东西**。而邀请页上明写着「允许之后只是接通通道；具体传不传
   * 数据、传哪些，还要再确认一次」—— 拉取方向上这句话原本是假的。
   *
   * 入参是**已经过滤过**的范围（见 #sanitizeScope），UI 直接照它显示即可。
   *
   * ⚠️ 返回的是**批准的范围**，不是 boolean。UI 那边还会拿本机自己的勾选去取交集
   * （本机默认就不给 settings）；如果这里只回 true/false，那份收窄就只停在界面上，
   * 真正发出去的仍是对方点名要的全部 —— 界面许下一个协议层没兑现的承诺，
   * 比不做还糟。返回 null 表示拒绝。
   */
  onPullRequest?: (scope: SyncScope) => Promise<SyncScope | null>
  onProgress?: (p: Progress) => void
  /** 接收完成并已写库 */
  onApplied?: (r: ImportResult) => void
}

const SCOPE_KEYS = ['characters', 'worldbooks', 'groups', 'chats', 'settings', 'rpgworlds'] as const

/** 两份范围取交集：只有双方都要的才留下 */
function intersectScope(a: SyncScope, b: SyncScope): SyncScope {
  const out = {} as SyncScope
  for (const k of SCOPE_KEYS) out[k] = a[k] && b[k]
  return out
}

function sameScope(a: SyncScope, b: SyncScope): boolean {
  return SCOPE_KEYS.every((k) => a[k] === b[k])
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

  /** 收包缓冲。只在接收期间非空。`scope` 是**实际允许落地**的范围（已取过交集） */
  #rx: { chunks: Uint8Array[]; got: number; manifest: Manifest; scope: SyncScope } | null = null
  /** 我方主动 pull 时置位：对端回来的 manifest 无需再问用户 */
  #pullPending = false
  /** 我方 pull 时**请求**的范围。对端声明得比它多就要退回确认页 */
  #pullScope: SyncScope | null = null
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

  /**
   * 待机：既不出码也不主动连，只等在线名单里有人点我。
   *
   * 与 hostViaSignal 的差别是**没有令牌**可比对 —— 点击方无从得知令牌。
   * 因此这条路径改为逐个询问用户（onInvite），批准了才继续握手。
   */
  listenViaSignal(signal: SignalClient): void {
    this.#signal = signal
    this.#token = ''
    this.pc.addEventListener('datachannel', (e) => this.#bindChannel(e.channel))
    this.#wireTrickle()
  }

  /**
   * 主动连接对端：扫码扫到的，或从在线名单里点的。
   *
   * `token` 在扫码模式下来自二维码；名单点击模式下对方没有可比对的令牌，
   * 传空串即可，那边会改走「问用户要不要接受」的路径。`selfName` 就是显示
   * 在对方询问框里的名字。
   */
  async joinViaSignal(
    signal: SignalClient,
    targetId: string,
    token: string,
    selfName = '',
  ): Promise<void> {
    this.#signal = signal
    this.#token = token
    this.#peerId = targetId
    this.#wireTrickle()
    const dc = this.pc.createDataChannel('sync', { ordered: true })
    this.#bindChannel(dc)
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    signal.send({
      type: 'offer',
      to: targetId,
      sdp: offer.sdp ?? '',
      token,
      name: selfName,
    })
  }

  /** 信令服务器转发过来的消息。由 store 接到 SignalClient 的 onRelay 上 */
  async handleRelay(m: RelayMessage): Promise<void> {
    try {
      switch (m.type) {
        case 'offer': {
          // 已经和别人配上了（含我方正在主动连别人），后来者一律不理。
          // 两边同时点对方会撞在这里，属于罕见情况，重试一次即可。
          if (this.#peerId && this.#peerId !== m.from) return

          // 按**对方带没带令牌**分流，而不是按本机处于哪种模式：
          // 二维码亮着的同时，别人仍可能从在线名单点我，两条路要能并存。
          if (m.token) {
            // 带令牌 = 扫码而来，必须和我出的那个码一致
            if (!this.#token || m.token !== this.#token) return
          } else {
            // 不带令牌 = 从名单点击，没有共享秘密，必须当面问用户
            const ok =
              (await this.#hooks.onInvite?.({ id: m.from, name: m.name ?? '未知设备' })) ?? false
            if (!ok) {
              // 带上原因，对面才能说「对方拒绝了」而不是含糊的「已断开」
              this.#signal?.send({ type: 'bye', to: m.from, reason: 'rejected' })
              return
            }
            // 询问期间可能已经被别人先占住
            if (this.#peerId && this.#peerId !== m.from) return
          }
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
          if (m.from !== this.#peerId) return
          this.#fail(new Error(m.reason === 'rejected' ? '对方拒绝了这次连接请求' : '对方已断开'))
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
    /**
     * ⚠️ 通道关闭必须走 #fail，不能只通知一下 UI 就完事。
     *
     * 原先这里是 `() => this.#hooks.onClose?.('通道已关闭')` —— 绕开了所有收尾：
     * 不清停滞定时器、不清 #rx、**也不唤醒 #failWaiters**。而 push()/pull() 的
     * 返回值正是挂在那些 waiter 上的：传到一半对端掉线，那个 Promise
     * **永远不会 settle**，界面就一直停在「传输中」，既不报错也不结束。
     *
     * 正常收尾不会被误报成错误：close() 先置 #closed，#fail 开头就挡掉了；
     * 而 store 侧的 onClose 对 step==='done' 也另有一道判断。
     */
    dc.addEventListener('close', () => this.#fail(new Error('通道已关闭')))
    dc.addEventListener('message', (e) => {
      void this.#onMessage(e.data)
    })
  }

  #send(f: Frame): void {
    this.#dc?.send(encodeFrame(f))
  }

  /**
   * 把对端 pull 帧里的 scope 收成一个安全的 SyncScope。
   *
   * ⚠️ **逐字段 `=== true`，缺省一律 false。** 绝不能沿用 push() 里那句
   * `{ ...FULL_SCOPE, ...scope }` —— `decodeFrame` 只验了 `t` 是字符串，
   * scope 可以压根不存在。展开一个 undefined 的结果就是 **FULL_SCOPE**：
   * 对端发一句 `{"t":"pull"}` 就等于点名要走整个库，连 settings 都在里面。
   * 「没说」必须解释成「不要」，不能解释成「全都要」。
   */
  #sanitizeScope(raw: unknown): SyncScope {
    const s = (raw ?? {}) as Partial<Record<keyof SyncScope, unknown>>
    return {
      characters: s.characters === true,
      worldbooks: s.worldbooks === true,
      groups: s.groups === true,
      chats: s.chats === true,
      settings: s.settings === true,
      rpgworlds: s.rpgworlds === true,
    }
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
      case 'pull': {
        // 对方要拉数据，等同于我方发送 —— 但必须先问过本机的人
        const want = this.#sanitizeScope(f.scope)
        if (!Object.values(want).some(Boolean)) {
          this.#send({ t: 'reject', reason: '对方没有可拉取的范围' })
          return
        }
        const approved = (await this.#hooks.onPullRequest?.(want)) ?? null
        if (!approved) {
          this.#send({ t: 'reject', reason: '对方拒绝了这次拉取' })
          return
        }
        // ⚠️ 再过一次 sanitize：UI 回来的东西同样不该无条件相信，而且这一步
        // 保证「实际发出去的」恒等于「用户在批准页上看到的那几项」的子集
        const eff = this.#sanitizeScope(approved)
        if (!Object.values(eff).some(Boolean)) {
          this.#send({ t: 'reject', reason: '对方拒绝了这次拉取' })
          return
        }
        void this.push(eff).catch((e: unknown) => this.#fail(toErr(e)))
        return
      }
      case 'manifest': {
        const declared = this.#sanitizeScope(f.scope)
        /**
         * 我方主动 pull 时不再弹确认页 —— 是我自己要的，没必要再问一遍。
         *
         * ⚠️ 但「我要的」只是**请求**，包是对端攒的：它完全可以在 manifest 里
         * 声明比我要的更多。所以这里与 `#pullScope` 取交集，并且只有在
         * **对端没有超额**时才算「我已经同意过了」；一旦它多塞了类别，
         * 就退回去走确认页，让用户自己看见多出来的是什么。
         */
        const asked = this.#pullScope
        const eff = asked ? intersectScope(declared, asked) : declared
        const overreach = asked !== null && !sameScope(eff, declared)
        const preApproved = asked !== null && !overreach
        this.#pullScope = null
        this.#pullPending = false
        const ok = preApproved ? true : ((await this.#hooks.onIncoming?.(f)) ?? false)
        if (!ok || !Object.values(eff).some(Boolean)) {
          this.#send({ t: 'reject', reason: '对方拒绝了本次同步' })
          this.#rx = null
          return
        }
        // 落地用的是交集，不是对端声明的那份
        this.#rx = { chunks: [], got: 0, manifest: f, scope: eff }
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
        // ⚠️ 必须把 manifest 里那份 scope 传下去。用户在确认页上点「接收」，同意的是
        // **manifest 声明的范围**；不兜这一道的话，声明不含 settings 却在包里塞一份，
        // 照样会把本机的接口地址、模型、人设整包盖掉
        const result = await applyBackup(file as Parameters<typeof applyBackup>[0], rx.scope)
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
        rpgworlds: file.rpgworlds.length,
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
    // 记下**我要的**。对端攒包时完全可以多塞，回来的 manifest 要跟它取交集
    this.#pullScope = this.#sanitizeScope(scope)
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

  /**
   * 本次会话失败：唤醒等待者、通知 UI，并**真的把通道关掉**。
   *
   * ⚠️ 以前这里只清了定时器就走了 —— 不置 `#closed`、不关 dc、不清 `#rx`。
   * 于是「同步失败」那个界面背后，连接其实还活着，对端仍能继续发帧：
   *  - 发 `{"t":"pull"}` → 照样触发导出（现在有确认页挡着，但本不该走到那一步）；
   *  - 发一个新的 `manifest` → `step` 从 'error' 被翻回 'confirm'，
   *    弹出一个用户根本没发起过的确认页；
   *  - 继续发二进制分片 → 残留的 `#rx` 会接着往下攒。
   * 用户以为「什么都没发生」，而通道是开的。失败就该是终态。
   *
   * 复用 close()：它本来就做了「置 #closed → 关 dc/pc/信令 → 通知对端」这一整套，
   * 另写一份迟早会漏掉其中一步。
   */
  #fail(e: Error): void {
    if (this.#closed) return
    const waiters = this.#failWaiters
    this.#failWaiters = []
    this.#rx = null
    this.close()
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
