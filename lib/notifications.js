/**
 * Real-time change notifications for Vaultwarden / Bitwarden.
 *
 * The server exposes a SignalR hub at `/notifications/hub` over WebSocket
 * (enabled by default since Vaultwarden 1.29.0; `ENABLE_WEBSOCKET=false`
 * turns it off, and servers older than that lack it entirely). The hub only
 * carries *signals* — every message means "something changed, go re-sync" —
 * so this module never touches vault data; it only tells the caller when to
 * fetch. Re-syncing is `GET /api/sync` followed by the usual decryption.
 *
 * Handshake (SignalR JSON protocol):
 *   1. POST /notifications/hub/negotiate                     → connectionToken
 *   2. WS   /notifications/hub?access_token=<jwt>&id=<token> (the access token
 *      travels as a query parameter — neither a browser nor the Node client
 *      can set headers on the WS handshake)
 *   3. → send  {"protocol":"json","version":1}<RS>
 *      ← recv  {}<RS>                                       (handshake ack)
 *      ← recv  {"type":6}<RS>                               (keepalive ping)
 *      ← recv  {"type":1,"target":"ReceiveMessage", ...}<RS> (a vault change)
 *
 * Reconnects use exponential backoff with jitter; after `maxAttempts` failed
 * rounds the channel gives up (`onGiveUp`) so the caller can fall back to
 * polling `/api/sync`. Nothing in here is Vaultwarden-specific beyond the
 * endpoint paths, and it has no dependency outside Node builtins plus the
 * platform `WebSocket` global (Node ≥ 22).
 */

const RS = '\u001e' // SignalR record separator
const PING_TYPE = 6
const INVOCATION_TYPE = 1
const HANDSHAKE = JSON.stringify({ protocol: 'json', version: 1 })
const DEFAULT_MAX_BACKOFF_MS = 30_000

/**
 * Bitwarden's `NotificationType` enum (bitwarden/clients
 * `libs/common/src/enums/notification-type.enum.ts`). Only `LogOut` needs
 * special handling — everything else means "re-sync".
 */
export const NotificationType = {
  SyncCipherUpdate: 0,
  SyncCipherCreate: 1,
  SyncLoginDelete: 2,
  SyncFolderDelete: 3,
  SyncCiphers: 4,
  SyncVault: 5,
  SyncOrgKeys: 6,
  SyncFolderCreate: 7,
  SyncFolderUpdate: 8,
  SyncCipherDelete: 9,
  SyncSettings: 10,
  LogOut: 11,
}

export class NotificationChannel {
  /**
   * @param {object} options
   * @param {string} options.server            normalized server origin (https://…)
   * @param {() => Promise<string>} options.getToken  resolves a fresh access token
   * @param {Function} [options.fetch]         fetch implementation
   * @param {Function} [options.WebSocketImpl] WebSocket constructor (tests inject one)
   * @param {(detail?: unknown) => void} [options.onSignal]  a change was signalled
   * @param {(detail?: unknown) => void} [options.onLogout]  the server revoked this session
   * @param {(state: string) => void} [options.onStateChange]
   * @param {(error: Error) => void} [options.onGiveUp]  ws unusable → caller polls
   * @param {number} [options.maxAttempts]    failed rounds before giving up (default 3)
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.server = options.server
    this.getToken = options.getToken
    this.fetch = options.fetch ?? globalThis.fetch
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket
    this.onSignal = options.onSignal ?? (() => {})
    this.onLogout = options.onLogout ?? (() => {})
    this.onStateChange = options.onStateChange ?? (() => {})
    this.onGiveUp = options.onGiveUp ?? (() => {})
    this.maxAttempts = Math.max(1, Number(options.maxAttempts ?? 3))
    this.log = options.log ?? (() => {})

    /** @type {'idle'|'connecting'|'open'|'waiting'|'failed'|'closed'} */
    this.state = 'idle'
    this.lastError = null
    this.reconnects = 0

    this.#stopped = true
    this.#attempts = 0
    this.#socket = null
    this.#timer = null
  }

  #stopped
  #attempts
  #socket
  #timer

  /** Open the channel. Safe to call when already running (no-op). */
  async start() {
    if (!this.#stopped) return
    this.#stopped = false
    await this.#connect()
  }

  /** Close the socket and cancel every pending reconnect. */
  stop() {
    this.#stopped = true
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const socket = this.#socket
    this.#socket = null
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      try {
        socket.close()
      } catch {
        /* already closing */
      }
    }
    this.#setState('closed')
  }

  #setState(state) {
    if (this.state === state) return
    this.state = state
    try {
      this.onStateChange(state)
    } catch {
      /* a listener must not break the channel */
    }
  }

  #wsUrl() {
    return this.server.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  }

  /** Negotiate a SignalR connection token (best effort — some builds answer 404). */
  async #negotiate(accessToken) {
    try {
      const response = await this.fetch(`${this.server}/notifications/hub/negotiate`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: 'null',
      })
      if (!response?.ok) return null
      const json = await response.json().catch(() => null)
      return json?.connectionToken ?? json?.connectionId ?? null
    } catch {
      return null // negotiate is an optimization; the hub accepts a bare token too
    }
  }

  async #connect() {
    if (this.#stopped) return
    this.#setState('connecting')
    let accessToken
    try {
      accessToken = await this.getToken()
    } catch (error) {
      this.lastError = error
      this.log(`notifications: token unavailable (${error?.message ?? error})`)
      this.#retry()
      return
    }
    if (this.#stopped) return

    const connectionToken = await this.#negotiate(accessToken)
    if (this.#stopped) return

    const params = new URLSearchParams({ access_token: accessToken })
    if (connectionToken) params.set('id', connectionToken)
    const url = `${this.#wsUrl()}/notifications/hub?${params.toString()}`

    let socket
    try {
      socket = new this.WebSocketImpl(url)
    } catch (error) {
      this.lastError = error
      this.log(`notifications: cannot open WebSocket (${error?.message ?? error})`)
      this.#retry()
      return
    }
    this.#socket = socket

    socket.onopen = () => {
      if (this.#socket !== socket) return
      this.#attempts = 0
      this.#setState('open')
      try {
        socket.send(HANDSHAKE + RS)
      } catch (error) {
        this.lastError = error
        this.#retry()
      }
    }

    socket.onmessage = (event) => {
      if (this.#socket !== socket) return
      // One WS frame can carry several SignalR records; handle them all.
      for (const record of String(event.data ?? '').split(RS)) {
        const frame = record.trim()
        if (!frame) continue
        let message
        try {
          message = JSON.parse(frame)
        } catch {
          continue
        }
        if (message?.type === PING_TYPE) {
          try {
            socket.send(JSON.stringify({ type: PING_TYPE }) + RS)
          } catch {
            /* a dead socket is handled by onclose */
          }
          continue
        }
        if (message?.type === INVOCATION_TYPE) {
          // The payload is `arguments: [{ Type, Id, Identifier, ContextId }]`;
          // `Type` is a Bitwarden NotificationType. A LogOut means the session
          // was revoked elsewhere — the caller must drop its tokens, not sync.
          const notificationType = message?.arguments?.[0]?.Type
          try {
            if (notificationType === NotificationType.LogOut) this.onLogout(message)
            else this.onSignal(message)
          } catch {
            /* a listener must not break the channel */
          }
        }
        // type 3 (completion) / 7 (close) / handshake ack `{}` need no action
      }
    }

    socket.onerror = () => {
      if (this.#socket !== socket) return
      this.lastError = new Error('WebSocket 连接错误')
    }

    socket.onclose = (event) => {
      if (this.#socket !== socket) return
      if (this.state === 'open') this.reconnects += 1
      this.#socket = null
      if (this.#stopped) return
      this.lastError = new Error(`WebSocket 已关闭（code ${event?.code ?? 'unknown'}）`)
      this.#retry()
    }
  }

  #retry() {
    if (this.#stopped) return
    this.#attempts += 1
    if (this.#attempts >= this.maxAttempts) {
      this.#setState('failed')
      try {
        this.onGiveUp(this.lastError ?? new Error('WebSocket 不可用'))
      } catch {
        /* caller decides the fallback */
      }
      return
    }
    const backoff = Math.min(1000 * 2 ** (this.#attempts - 1), DEFAULT_MAX_BACKOFF_MS)
    const delay = backoff + Math.floor(Math.random() * 500) // jitter
    this.#setState('waiting')
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#connect()
    }, delay)
    this.#timer.unref?.()
  }

  /** True while the socket is open and signalling. */
  get connected() {
    return this.state === 'open'
  }

  report() {
    return {
      state: this.state,
      connected: this.connected,
      reconnects: this.reconnects,
      lastError: this.lastError?.message ?? null,
    }
  }
}
