/**
 * 信令服务器客户端（对应 signal-server.js）。
 *
 * 它只是个**中继+在线名单**：连上给一个 id，然后把 offer/answer/ice/bye
 * 按 `to` 转给对方并盖上 `from`。有了它，SDP 与 ICE 候选都能来回走，
 * 于是**只需要扫一次码** —— 二维码里只放「去哪台服务器找哪个 id」，
 * 剩下的握手全在 WebSocket 上完成。
 *
 * 服务器不参与数据传输：DataChannel 建好之后所有内容都是点对点直连，
 * 信令服务器连一个字节的会话数据都看不到。
 *
 * 纯 service：不 import vue/pinia。
 */

/** 连上服务器、拿到自己 id 的等待上限 */
const READY_TIMEOUT = 8000

export interface SignalUser {
  id: string
  name: string
}

/** 从服务器收到的、由别人转发过来的消息 */
export interface RelayMessage {
  type: 'offer' | 'answer' | 'ice' | 'bye'
  from: string
  sdp?: string
  candidate?: RTCIceCandidateInit
  /** 配对令牌，防止同一台服务器上的其他人凭 id 硬连进来 */
  token?: string
}

export interface SignalHooks {
  onRelay?: (m: RelayMessage) => void
  onUsers?: (users: SignalUser[]) => void
  onClose?: (reason: string) => void
}

/**
 * 同源信令地址 —— **首选**，因为它能绕开混合内容限制。
 *
 * 信令服务器跑在 `ws://149.30.222.97/ws`（纯 http，没有 TLS）。而手机那端
 * 必须走 https 才能用摄像头和 WebRTC，**https 页面又禁止打开 ws:// 连接**
 * （混合内容，浏览器直接拦，且不给任何放行入口）。两个要求正面冲突。
 *
 * 解法是让 WebSocket 走**应用自己的源**：页面是 https 就用 wss 连到同一个
 * host，由 vite 的 /ws 代理（开发）或 nginx（生产）在服务端再转给信令服务器。
 * 不安全的那一跳发生在服务端之间，浏览器完全看不到，于是两个要求同时满足。
 */
export function sameOriginSignalUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

/**
 * 绝对地址兜底：应用部署在没有 /ws 反代的地方时用。
 * 由 VITE_SIGNAL_URL 配置，默认指向现有的信令服务器。
 */
export function absoluteSignalUrl(): string {
  return import.meta.env['VITE_SIGNAL_URL'] || 'ws://149.30.222.97/ws'
}

/**
 * 按优先级给出要尝试的信令地址。
 *
 * https 页面下会**跳过** ws:// 的绝对地址 —— 那种连接必定被浏览器拦掉，
 * 试它只会白白多等一个超时，还让用户以为是服务器挂了。
 */
export function signalCandidates(): string[] {
  const out = [sameOriginSignalUrl()]
  const abs = absoluteSignalUrl()
  const blocked = location.protocol === 'https:' && abs.startsWith('ws://')
  if (abs && abs !== out[0] && !blocked) out.push(abs)
  return out
}

export class SignalClient {
  #ws: WebSocket | null = null
  #hooks: SignalHooks
  /** 服务器分配给本机的 id，扫码方要凭它找到我 */
  id = ''
  users: SignalUser[] = []

  constructor(hooks: SignalHooks = {}) {
    this.#hooks = hooks
  }

  /** 依次尝试多个地址，第一个连上的算数。全失败则抛最后一个错误 */
  async connectAny(urls: string[], name: string): Promise<string> {
    let last: Error | null = null
    for (const u of urls) {
      try {
        return await this.connect(u, name)
      } catch (e) {
        last = e instanceof Error ? e : new Error(String(e))
      }
    }
    throw last ?? new Error('没有可用的信令地址')
  }

  connect(url: string, name: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch (e) {
        reject(new Error(`信令地址无效：${e instanceof Error ? e.message : String(e)}`))
        return
      }
      this.#ws = ws
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error('连不上信令服务器，请确认它已启动（bun run signal-server.js）'))
      }, READY_TIMEOUT)

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'hello', name }))
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        // WebSocket 的 error 事件不带原因，这里只能给通用文案
        reject(new Error('连不上信令服务器，请确认它已启动，且地址可达'))
      })
      ws.addEventListener('close', () => {
        clearTimeout(timer)
        this.#hooks.onClose?.('信令连接已断开')
      })
      ws.addEventListener('message', (ev) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>
        } catch {
          return
        }
        if (msg['type'] === 'welcome' && typeof msg['id'] === 'string') {
          clearTimeout(timer)
          this.id = msg['id']
          resolve(this.id)
          return
        }
        if (msg['type'] === 'users' && Array.isArray(msg['users'])) {
          this.users = msg['users'] as SignalUser[]
          this.#hooks.onUsers?.(this.users)
          return
        }
        if (
          typeof msg['from'] === 'string' &&
          ['offer', 'answer', 'ice', 'bye'].includes(String(msg['type']))
        ) {
          this.#hooks.onRelay?.(msg as unknown as RelayMessage)
        }
      })
    })
  }

  send(m: { type: RelayMessage['type']; to: string } & Record<string, unknown>): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(m))
  }

  close(): void {
    // onClose 会把「断开」当错误报给 UI，主动关闭时先摘掉钩子
    this.#hooks = {}
    try {
      this.#ws?.close()
    } catch {
      // 已经关了
    }
    this.#ws = null
  }
}

/** 二维码里的会合信息 */
export interface Rendezvous {
  /**
   * 信令地址。`-` 表示「你自己按同源规则算」。
   *
   * **默认就该是 `-`**：发起方要是把自己算出来的地址写死进去，扫码的手机
   * 拿到的可能是 `ws://localhost:5176/ws` —— 那会指向手机自己的 localhost，
   * 必然连不上。两台设备既然都能打开这个应用，各自的同源地址本来就指向
   * 同一个反代，让各算各的反而永远正确。
   */
  url: string
  id: string
  token: string
}

/** 会合码里 url 字段的占位值：让扫码方按自己的同源规则去算 */
export const SAME_ORIGIN = '-'

/** 会合码里的 url 展开成实际要尝试的地址列表 */
export function rendezvousUrls(rv: Rendezvous): string[] {
  return rv.url === SAME_ORIGIN ? signalCandidates() : [rv.url]
}

/**
 * 会合码用可读文本而不是二进制。
 *
 * 内容只有「服务器地址 + 对方 id + 令牌」，本来就短（约 50 字符，二维码版本 4 上下），
 * 没有压缩的必要；可读还能让用户在扫不出来时直接念出来。
 * 前缀 `MJ|` 用来和**无服务器模式**的配对码区分开 —— 那种是 base64url，
 * 字符集里不可能出现 `|`，所以判前缀不会误判。
 */
const RV_PREFIX = 'MJ|'

export function packRendezvous(r: Rendezvous): string {
  return `${RV_PREFIX}${r.url}|${r.id}|${r.token}`
}

export function isRendezvous(code: string): boolean {
  return code.trim().startsWith(RV_PREFIX)
}

export function unpackRendezvous(code: string): Rendezvous {
  const rest = code.trim().slice(RV_PREFIX.length)
  // url 里带 `//`，但不含 `|`，所以直接按 `|` 切三段是安全的
  const parts = rest.split('|')
  const [url, id, token] = parts
  if (parts.length !== 3 || !url || !id || !token) {
    throw new Error('会合码内容不完整')
  }
  return { url, id, token }
}

/** 一次性配对令牌 */
export function makeToken(): string {
  const b = new Uint8Array(6)
  crypto.getRandomValues(b)
  return Array.from(b, (n) => n.toString(36).padStart(2, '0')).join('')
}
