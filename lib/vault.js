/**
 * Vaultwarden / Bitwarden client for dsh-bitwarden.
 *
 * Implements the Bitwarden client protocol directly against the server REST
 * API (no `bw` CLI, no runtime dependencies beyond Node builtins):
 *
 *   POST /identity/accounts/prelogin   → KDF parameters for the account
 *   POST /identity/connect/token       → access + refresh token (password or API key grant)
 *   GET  /api/sync?excludeDomains=true → encrypted vault (profile key, ciphers, folders)
 *
 * Vault crypto (all values stay in memory, nothing is written to disk):
 *   masterKey  = PBKDF2-SHA256(password, email, iterations, 32)      [KDF 0]
 *              = Argon2id(password, email, memory, iterations, par)  [KDF 1, needs hash-wasm]
 *   masterPwHash = PBKDF2-SHA256(masterKey, password, 1, 32) → base64  (token grant)
 *   {enc, mac} = HKDF-Expand(masterKey, "enc"/"mac", 32)
 *   userKey    = AES-256-CBC-decrypt(profile.key, enc) + HMAC-SHA256(mac)  [EncString type 2]
 *   item fields= same, with the user key (or the per-item key of an org cipher)
 */
import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  pbkdf2Sync,
  privateDecrypt,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { generateTotp } from './totp.js'
import { NotificationChannel } from './notifications.js'

const CLIENT_ID = 'cli'
const DEVICE_TYPE = 25 // DeviceType.LinuxCLI — what the official CLI declares on Linux
const CLIENT_NAME = 'dsh-vaultwarden'
const CLIENT_VERSION = '2026.6.0'
const DEFAULT_TIMEOUT_MS = 20_000
/**
 * How long a two-factor challenge stays usable. Bitwarden's continuation token
 * is short-lived (minutes); within this window the plugin refuses to start a
 * new login, so the code the user is typing cannot be invalidated by a
 * background retry.
 */
const TWO_FACTOR_PENDING_TTL_MS = 5 * 60_000

/**
 * How long a failed fallback login blocks the next one.
 *
 * When both the access token and the refresh token are gone, `ensureToken`
 * has exactly one recovery left: a full password grant. That is fine once —
 * it is how a restart or a revoked refresh token comes back — but a *dead*
 * session plus a background caller (poll tick, tool call) must not turn into a
 * silent login loop against the login endpoint and its rate limiter. One
 * attempt, then this cooldown, with the reason reported via `lastSessionEvent`.
 */
const LOGIN_RETRY_COOLDOWN_MS = 60_000

/**
 * How long a `/api/config` reachability probe is reused.
 *
 * The panel calls `status()` on every open, and that probe is a full network
 * round trip — measured 380-830 ms against a real Vaultwarden — whose only
 * useful output is the server version string. Remembering it briefly keeps
 * opening the panel snappy without hiding a server that genuinely went away:
 * five minutes is far shorter than any realistic outage anyone would notice by
 * reopening a settings page.
 */
const SERVER_PROBE_TTL_MS = 5 * 60_000
/**
 * How long one master-password proof keeps reprompt entries readable. The
 * official clients remember the re-prompt for the rest of the session; this
 * window is the same idea made finite, and it is deliberately generous (5
 * minutes by default) so that working through several reprompt entries does
 * not mean retyping the password between each one.
 */
const DEFAULT_REPROMPT_GRANT_MINUTES = 5

/**
 * Failed reprompt proofs: how many are free, and how the penalty grows.
 *
 * Every attempt costs a full KDF run (600k PBKDF2 rounds, or Argon2id), so an
 * unthrottled check is an oracle AND a way to make the host burn CPU. The
 * first few tries are free because mistyping a master password twice is
 * ordinary; from there each further failure doubles the wait, capped at a
 * minute, which leaves a person unaffected and a guesser with a handful of
 * tries per minute.
 */
const REPROMPT_FREE_ATTEMPTS = 5
const REPROMPT_LOCK_BASE_MS = 1_000
const REPROMPT_LOCK_MAX_MS = 60_000

/**
 * Polling is only a fallback for an unreachable hub, so the default interval is
 * deliberately slow and cannot be configured below this floor. Callers that
 * need a faster tick on purpose (the test suite) pass `minPollIntervalMs`.
 */
const MIN_POLL_INTERVAL_MS = 30_000

/**
 * How often the stored session's idle timestamp is actually rewritten.
 *
 * `touchSession` runs on every token fetch, and the write is durable (temp file
 * + fsync + rename + directory fsync): ~50 ms of synchronous I/O per RPC on the
 * machine this was measured on, which the panel's first paint and the per-second
 * TOTP poll both paid. The timestamp only feeds the idle deadline (default 30
 * days), so a minute of granularity changes nothing a person can observe.
 */
const SESSION_TOUCH_INTERVAL_MS = 60_000
const DEFAULT_POLL_INTERVAL_MS = 300_000

const CIPHER_TYPES = { 1: 'login', 2: 'secureNote', 3: 'card', 4: 'identity', 5: 'sshKey' }

/**
 * How much of a TOTP window a caller needs to actually use a code.
 *
 * The cost that matters is not the fetch, it is the trip from the tool result
 * to the form: the model has to finish a turn, the next call has to start, the
 * page has to be reached. 20 of a 30-second window leaves a measurable margin
 * for that, and it is short enough that waiting for it never feels stuck.
 */
const DEFAULT_TOTP_MIN_REMAINING = 20

/** The sidebar's type order (see `overview`): the order official clients use. */
const TYPE_ORDER = ['login', 'card', 'identity', 'secureNote', 'sshKey']

/** The human word for a cipher type. English on purpose: the panel translates. */
const TYPE_LABELS = { login: 'Login', card: 'Card', identity: 'Identity', secureNote: 'Secure note', sshKey: 'SSH key' }

const typeLabel = (type) => TYPE_LABELS[type] ?? String(type ?? '')

/** Epoch ms for a server timestamp, or null when there is none / it is junk. */
function revisionAt(value) {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}

/** Every failure raised by this module, with an optional `hint` for the model. */
export class VaultError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'VaultError'
    this.code = options.code ?? 'vault_error'
    this.hint = options.hint
    // Two-factor continuation data, present when code === 'two_factor_required'.
    this.twoFactorToken = options.twoFactorToken ?? null
    this.providers = options.providers ?? null
    this.providerDescriptions = options.providerDescriptions ?? null
  }
}

const fail = (message, code, hint) => {
  throw new VaultError(message, { code, hint })
}

/** Accept `192.168.88.101`, `vault.example.com`, or a full URL. */
export function normalizeServerUrl(raw) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!value) {
    fail('未配置 Vaultwarden 服务器地址', 'not_configured', '请在 DSH 设置 → 插件 → bitwarden 填写 serverUrl')
  }
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

/**
 * Stable device identifier for this account.
 *
 * Official desktop/browser/web clients persist a random identifier so the
 * server sees one device across restarts (the official CLI, by contrast,
 * registers a new device on every login). This plugin keeps nothing on disk,
 * so the identifier is derived deterministically from the server + account:
 * stable across restarts and upgrades, without persisting anything. Set
 * `deviceIdentifier` in the settings to override with an explicit value.
 */
export function resolveDeviceIdentifier(settings) {
  const explicit = String(settings?.deviceIdentifier ?? '').trim()
  if (explicit) return explicit
  const seed = `${normalizeServerUrl(settings?.serverUrl)}|${String(settings?.email ?? '').trim().toLowerCase()}`
  const hex = createHash('sha256').update(seed).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Today's epoch milliseconds; overridable in tests. */
const now = () => Date.now()

// ── low level HTTP ───────────────────────────────────────────────────────────

export async function httpJson(fetchImpl, url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { method = 'GET', headers = {}, body, signal } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  // A pending request must not be the only thing keeping the process alive:
  // every other timer in this plugin (notifications.js, syncSoon) is unref'd,
  // and a 20 s socket held open by a shutdown path is the difference between
  // the host exiting now and exiting after the timeout.
  timer.unref?.()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let response
  try {
    response = await fetchImpl(url, { method, headers, body, signal: controller.signal })
  } catch (error) {
    // Origin only, never the full URL: the path names the endpoint being
    // probed (/identity/connect/token, /api/sync), and this message ends up in
    // the panel's sync tooltip and in `bitwarden_status`. The rest of the
    // plugin already refuses to hand out deployment details (`gateway.js`
    // strips the session file's absolute path for the same reason).
    const origin = (() => {
      try {
        return new URL(url).origin
      } catch {
        return '服务器'
      }
    })()
    const reason = signal?.aborted ? '请求已取消' : `无法连接 ${origin}（${error?.message ?? error}）`
    throw new VaultError(reason, {
      code: 'network_error',
      hint: '检查网络连通性、TLS 证书与服务地址；自签证书需在服务器侧换成受信任证书',
    })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
  const text = await response.text().catch(() => '')
  let json
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
  }
  return { status: response.status, ok: response.ok, json, text }
}

function errorDetail(payload, fallback) {
  if (!payload) return fallback
  if (typeof payload === 'string') return payload
  const parts = []
  if (payload.error_description) parts.push(String(payload.error_description))
  if (payload.error) parts.push(String(payload.error))
  if (payload.message) parts.push(String(payload.message))
  if (payload.validationErrors && typeof payload.validationErrors === 'object') {
    for (const [field, errs] of Object.entries(payload.validationErrors)) {
      const text = Array.isArray(errs) ? errs.map((e) => e?.message ?? e).join('; ') : String(errs)
      parts.push(`${field}: ${text}`)
    }
  }
  if (payload.captchaRequired) parts.push('需要人机验证(captchaRequired)')
  return parts.filter(Boolean).join(' | ') || fallback
}

function describeHttpFailure(status, payload) {
  const detail = errorDetail(payload, '')
  if (status === 429) return { message: 'Vaultwarden 拒绝了请求（429 限流），稍后重试', code: 'rate_limited' }
  if (status === 401 || status === 403) return { message: `认证失败（HTTP ${status}）${detail ? `：${detail}` : ''}`, code: 'unauthorized' }
  if (status >= 500) return { message: `Vaultwarden 服务端错误（HTTP ${status}）${detail ? `：${detail}` : ''}`, code: 'server_error' }
  return { message: `请求失败（HTTP ${status}）${detail ? `：${detail}` : ''}`, code: 'http_error' }
}

/**
 * Whether a failed token request was *refused by the server* (the credential is
 * really dead) or merely never arrived (the credential is probably fine).
 *
 * The distinction is load-bearing for the refresh path: only an explicit
 * rejection may delete the stored session. An offline moment, a 429 or a 5xx
 * says nothing about the refresh token, and treating one as "dead" is exactly
 * what made a flaky network cost a master password plus a two-factor code.
 *
 * `requestToken` reports Vaultwarden's HTTP 400 `invalid_grant` as
 * `http_error` (see `describeHttpFailure`), so the code alone cannot decide.
 */
export function isRejectedCredential(error) {
  if (!error) return false
  if (error.code === 'bad_credentials' || error.code === 'unauthorized') return true
  if (error.code !== 'http_error') return false
  return /invalid_grant|invalid_token|refresh token is invalid/i.test(String(error.message ?? ''))
}

// ── crypto ───────────────────────────────────────────────────────────────────

/** HKDF-Expand only (Bitwarden stretches the master key without an extract step). */
function hkdfExpand(prk, info, length) {
  const infoBytes = Buffer.from(info, 'utf8')
  let previous = Buffer.alloc(0)
  let okm = Buffer.alloc(0)
  for (let counter = 1; okm.length < length; counter++) {
    previous = createHmac('sha256', prk)
      .update(Buffer.concat([previous, infoBytes, Buffer.from([counter])]))
      .digest()
    okm = Buffer.concat([okm, previous])
  }
  return okm.subarray(0, length)
}

/** Split a 64-byte user key, or stretch a 32-byte key (user-key v2). */
export function stretchKey(key) {
  if (key.length === 64) return { enc: key.subarray(0, 32), mac: key.subarray(32, 64) }
  if (key.length === 32) return { enc: hkdfExpand(key, 'enc', 32), mac: hkdfExpand(key, 'mac', 32) }
  fail(`用户密钥长度异常（${key.length} 字节），无法解密保险库`, 'bad_user_key')
}

/**
 * Derive the 32-byte master key from the master password.
 * KDF 0 = PBKDF2-SHA256, KDF 1 = Argon2id (dynamic `hash-wasm` import).
 */
export async function deriveMasterKey(password, email, kdf, iterations, options = {}) {
  const pass = String(password ?? '')
  if (!pass) fail('未配置主密码', 'not_configured', '请在 DSH 设置 → 插件 → bitwarden 填写 masterPassword')
  const salt = String(email ?? '').trim().toLowerCase()
  if (!salt) fail('未配置邮箱', 'not_configured', '请在 DSH 设置 → 插件 → bitwarden 填写 email')
  const kdfType = Number(kdf ?? 0)
  if (kdfType === 1) {
    let argon2id
    try {
      ;({ argon2id } = await import('hash-wasm'))
    } catch {
      fail('该账户使用 Argon2id KDF，但本机缺少 hash-wasm 依赖，无法派生主密钥', 'unsupported_kdf', '在插件目录执行 npm install hash-wasm，或在 Bitwarden 网页端把 KDF 改为 PBKDF2-SHA256')
    }
    const hash = await argon2id({
      password: pass.normalize('NFKC'),
      salt,
      parallelism: Number(options.parallelism ?? 4),
      iterations: Number(iterations ?? 3),
      // Bitwarden/Vaultwarden report KDF memory in MiB (default 64); hash-wasm
      // counts in KiB, so a missing ×1024 derives the key from 64 KiB of memory
      // instead of 64 MiB and the server rejects the login as a wrong password.
      memorySize: Number(options.memory ?? 64) * 1024,
      hashLength: 32,
      outputType: 'binary',
    })
    return Buffer.from(hash)
  }
  return pbkdf2Sync(pass.normalize('NFKC'), salt, Number(iterations ?? 600_000), 32, 'sha256')
}

/** Bitwarden's `masterPasswordHash`: PBKDF2(masterKey, password, 1). */
export function hashMasterPassword(masterKey, password) {
  return pbkdf2Sync(masterKey, String(password ?? '').normalize('NFKC'), 1, 32, 'sha256').toString('base64')
}

/** Decrypt one Bitwarden EncString (`<type>.<iv>|<data>[|<mac>]`). */
export function decryptEncString(value, encKey, macKey) {
  const text = String(value ?? '')
  if (!text) return Buffer.alloc(0)
  const dot = text.indexOf('.')
  if (dot <= 0) throw new VaultError('无法识别的密文字符串', { code: 'bad_cipher_string' })
  const type = Number(text.slice(0, dot))
  const segments = text.slice(dot + 1).split('|')
  const iv = Buffer.from(segments[0] ?? '', 'base64')
  const data = Buffer.from(segments[1] ?? '', 'base64')
  if (type === 2) {
    if (segments.length < 3) throw new VaultError('类型 2 密文缺少 MAC', { code: 'bad_cipher_string' })
    const mac = Buffer.from(segments[2], 'base64')
    const expected = createHmac('sha256', macKey).update(Buffer.concat([iv, data])).digest()
    if (expected.length !== mac.length || !timingSafeEqual(expected, mac)) {
      fail('凭据解密失败（MAC 校验不通过）：主密码或账户密钥不匹配', 'bad_master_password', '确认 masterPassword/email 与 Bitwarden 登录一致')
    }
  } else if (type !== 0) {
    throw new VaultError(`不支持的密文类型 ${type}`, { code: 'bad_cipher_string' })
  }
  const decipher = createDecipheriv('aes-256-cbc', encKey, iv)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/** Decrypt an EncString to UTF-8 text (`undefined` for empty input). */
export function decryptString(value, userKey) {
  if (value === null || value === undefined || value === '') return undefined
  const buf = decryptEncString(value, userKey.enc, userKey.mac)
  return buf.toString('utf8')
}

/**
 * Encrypt a string (or raw bytes, e.g. a per-item key) into a Bitwarden
 * EncString (type 2: AES-256-CBC + HMAC-SHA256).
 */
export function encryptString(plain, key, type = 2) {
  if (plain === undefined || plain === null || plain === '') return undefined
  const bytes = Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8')
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key.enc, iv)
  const data = Buffer.concat([cipher.update(bytes), cipher.final()])
  const base = `${type}.${iv.toString('base64')}|${data.toString('base64')}`
  if (type === 2) {
    const mac = createHmac('sha256', key.mac).update(Buffer.concat([iv, data])).digest('base64')
    return `${base}|${mac}`
  }
  return base
}

/**
 * RSA EncString types, as Bitwarden defines them:
 * 4/6 = RSA-2048 OAEP SHA-1, 5/7 = RSA-2048 OAEP SHA-256.
 */
const RSA_OAEP_HASH = { 4: 'sha1', 5: 'sha256', 6: 'sha1', 7: 'sha256' }

/** Decrypt a type 4–7 EncString with the account's RSA private key. */
export function decryptRsaEncString(value, privateKeyObject) {
  const text = String(value ?? '')
  const dot = text.indexOf('.')
  const type = Number(text.slice(0, dot))
  const oaepHash = RSA_OAEP_HASH[type]
  if (!oaepHash) {
    throw new VaultError(`不支持的 RSA 密文类型 ${type}`, { code: 'bad_cipher_string' })
  }
  const data = Buffer.from(text.slice(dot + 1).split('|')[0], 'base64')
  return privateDecrypt(
    { key: privateKeyObject, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash },
    data,
  )
}

/**
 * Organization keys: each organization's symmetric key is delivered in
 * `profile.organizations[].key` RSA-OAEP wrapped with the account's public key,
 * and the matching PKCS#8 private key sits encrypted in `profile.privateKey`.
 * Organization ciphers are then encrypted with their organization's key (their
 * own `cipher.key` wrapping a per-item key), never with the user key.
 */
function resolveOrgKeys(sync, userKey) {
  const orgKeys = new Map()
  const organizations = asList(sync?.profile?.organizations)
  const encryptedPrivateKey = sync?.profile?.privateKey
  if (!organizations.length || !encryptedPrivateKey) return orgKeys
  let privateKeyObject
  try {
    const der = decryptEncString(encryptedPrivateKey, userKey.enc, userKey.mac)
    privateKeyObject = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  } catch {
    return orgKeys // no usable RSA key: organization items stay unreadable
  }
  for (const organization of organizations) {
    if (!organization?.key) continue
    try {
      let raw = decryptRsaEncString(organization.key, privateKeyObject)
      // Legacy vaults double-encrypt: the RSA plaintext is itself an EncString.
      const text = raw.toString('utf8')
      if (/^[0-9]\.[A-Za-z0-9+/=|]+$/.test(text)) {
        try {
          raw = decryptEncString(text, userKey.enc, userKey.mac)
        } catch {
          /* keep the raw bytes */
        }
      }
      orgKeys.set(organization.id, stretchKey(raw))
    } catch {
      /* one unreadable organization key must not hide the rest of the vault */
    }
  }
  return orgKeys
}

// ── protocol ─────────────────────────────────────────────────────────────────

/** Read an account's KDF parameters (also proves the server is reachable). */
export async function prelogin(fetchImpl, server, email, signal) {
  const { ok, status, json } = await httpJson(
    fetchImpl,
    `${server}/identity/accounts/prelogin`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email }),
      signal,
    },
  )
  if (!ok) {
    const { message, code } = describeHttpFailure(status, json)
    throw new VaultError(`预登录失败：${message}`, { code })
  }
  // Vaultwarden answers with the flat `kdf*` fields (and mirrors them under
  // `kdfSettings`); accept either shape.
  const settings = json?.kdfSettings ?? {}
  return {
    kdf: Number(json?.kdf ?? json?.kdfType ?? settings.kdfType ?? settings.kdf ?? 0),
    kdfIterations: Number(json?.kdfIterations ?? settings.iterations ?? 600_000),
    kdfMemory: json?.kdfMemory ?? settings.memory ?? null,
    kdfParallelism: json?.kdfParallelism ?? settings.parallelism ?? null,
  }
}

/** Bearer + client-identification headers for `/api/*` calls. */
export function authHeaders(accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    'device-type': String(DEVICE_TYPE),
    'bitwarden-client-name': CLIENT_NAME,
    'bitwarden-client-version': CLIENT_VERSION,
  }
}

function tokenHeaders() {
  return {
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    accept: 'application/json',
    'device-type': String(DEVICE_TYPE),
    'bitwarden-client-name': CLIENT_NAME,
    'bitwarden-client-version': CLIENT_VERSION,
  }
}

function parseTokenResponse(json, clock = now) {
  const accessToken = json?.access_token
  if (!accessToken) fail('身份服务未返回 access_token', 'bad_token_response')
  const expiresIn = Number(json?.expires_in ?? 3600)
  return {
    accessToken,
    refreshToken: json?.refresh_token ?? null,
    expiresAt: clock() + Math.max(60, expiresIn) * 1000,
    encryptedKey: json?.Key ?? json?.key ?? null,
    kdf: json?.Kdf ?? json?.kdf ?? null,
    kdfIterations: json?.KdfIterations ?? json?.kdfIterations ?? null,
    kdfMemory: json?.KdfMemory ?? null,
    kdfParallelism: json?.KdfParallelism ?? null,
    twoFactorToken: json?.TwoFactorToken ?? null,
  }
}

/**
 * Exchange credentials for tokens.
 * `mode` is `password` (master password hash grant) or `apikey`
 * (client_credentials with a `user.<uuid>` client id — bypasses 2FA).
 *
 * Two-factor contract (verified against vaultwarden `src/api/identity.rs`):
 * the refused password grant answers with `TwoFactorProviders` only — the
 * server issues NO continuation token. The client re-sends the full password
 * grant with the user's code in `two_factor_token`, plus `two_factor_provider`
 * and `two_factor_remember`.
 */
async function requestToken(fetchImpl, server, body, signal, clock = now) {
  const { ok, status, json } = await httpJson(fetchImpl, `${server}/identity/connect/token`, {
    method: 'POST',
    headers: tokenHeaders(),
    body: new URLSearchParams(body).toString(),
    signal,
  })
  if (!ok) {
    const twoFactor = json?.TwoFactorProviders ?? json?.twoFactorProviders
    if (twoFactor?.length) {
      throw new VaultError('该账户启用了两步验证，需要验证码', {
        code: 'two_factor_required',
        hint: '重新发送带 twoFactor 验证码的密码授权',
        providers: twoFactor,
        providerDescriptions: json?.TwoFactorProviders2 ?? json?.twoFactorProviders2 ?? null,
      })
    }
    const { message, code } = describeHttpFailure(status, json)
    const hint = /username or password is incorrect|invalid_grant/i.test(message)
      ? '邮箱或主密码不正确（注意 email 需与登录账号一致）'
      : '检查 serverUrl/email/masterPassword 是否正确'
    throw new VaultError(`登录失败：${message}`, { code: code === 'unauthorized' ? 'bad_credentials' : code, hint })
  }
  return parseTokenResponse(json, clock)
}

/** Fetch and decrypt the vault. */
async function fetchSync(fetchImpl, server, accessToken, signal) {
  const { ok, status, json } = await httpJson(fetchImpl, `${server}/api/sync?excludeDomains=true`, {
    headers: authHeaders(accessToken),
    signal,
  })
  if (!ok) {
    const { message, code } = describeHttpFailure(status, json)
    throw new VaultError(`同步保险库失败：${message}`, { code })
  }
  return json ?? {}
}

/**
 * Ask the server for the account's revision date — the cheapest way to learn
 * whether anything sync-visible changed. Measured 13 bytes / ~0.5 s against a
 * real Vaultwarden, versus ~660 KB / ~3 s for a full sync.
 *
 * Returns null when the answer is not a number: callers must treat "unknown"
 * as "sync", never as "unchanged".
 */
async function fetchRevision(fetchImpl, server, accessToken, signal) {
  const { ok, status, json, text } = await httpJson(fetchImpl, `${server}/api/accounts/revision-date`, {
    headers: authHeaders(accessToken),
    signal,
  })
  if (!ok) {
    const { message, code } = describeHttpFailure(status, json)
    throw new VaultError(`读取账号修订号失败：${message}`, { code })
  }
  const value = typeof json === 'number' ? json : Number(String(text ?? '').trim())
  return Number.isFinite(value) ? value : null
}

// ── vault projection ─────────────────────────────────────────────────────────

function truncate(text, max = 2000) {
  if (typeof text !== 'string' || text.length <= max) return text
  return `${text.slice(0, max)}…（已截断，共 ${text.length} 字符）`
}

function decryptCipher(cipher, userKey, orgKeys, folderNames, collectionNames) {
  // An organization cipher lives under its organization's key, not the user key.
  const base = (cipher.organizationId && orgKeys.get(cipher.organizationId)) || userKey
  let key = base
  if (cipher.key) {
    key = stretchKey(decryptEncString(cipher.key, base.enc, base.mac))
  }
  const dec = (value) => decryptString(value, key)
  const uris = (cipher.login?.uris ?? []).map((entry) => dec(entry?.uri)).filter(Boolean)
  // `type` is kept because it is not decoration: Bitwarden's 1 means a hidden
  // field (PIN, API key, recovery code) — the one kind an official client never
  // puts on screen unasked. `projectItem` uses it to keep the wider `all`
  // projection from handing those values to the model.
  const fields = (cipher.fields ?? [])
    .map((field) => ({ name: dec(field?.name), value: dec(field?.value), type: Number(field?.type ?? 0) }))
    .filter((field) => field.name || field.value)
  // Attachment metadata only: the file names are encrypted with the item key
  // and the sizes are plain, but the bytes are a separate encrypted blob behind
  // `url` — this plugin never downloads them.
  const attachments = (cipher.attachments ?? [])
    .map((entry) => ({
      id: entry?.id ?? null,
      fileName: dec(entry?.fileName) ?? null,
      size: Number.isFinite(Number(entry?.size)) ? Number(entry.size) : null,
      sizeName: entry?.sizeName ?? null,
      url: entry?.url ?? null,
    }))
    .filter((entry) => entry.id || entry.fileName)
  // Previous passwords, newest first — official clients keep them so that
  // "what was the old password" still has an answer after a rotation.
  const passwordHistory = (cipher.passwordHistory ?? [])
    .map((entry) => ({ password: dec(entry?.password), lastUsedDate: entry?.lastUsedDate ?? null }))
    .filter((entry) => entry.password)
  return {
    id: cipher.id,
    type: CIPHER_TYPES[cipher.type] ?? `type${cipher.type}`,
    name: dec(cipher.name) ?? '',
    username: dec(cipher.login?.username),
    password: dec(cipher.login?.password),
    totpSecret: dec(cipher.login?.totp),
    uris,
    notes: dec(cipher.notes),
    fields,
    attachments: attachments.length ? attachments : undefined,
    passwordHistory: passwordHistory.length ? passwordHistory : undefined,
    passwordRevisionDate: cipher.login?.passwordRevisionDate ?? null,
    // Passkeys survive a write verbatim (see lib/mutations.js), but they cannot
    // be used from here — still, "this item has a passkey" matters before an
    // edit that would otherwise have quietly dropped it.
    hasFido2: Boolean(cipher.login?.fido2Credentials?.length),
    card: cipher.card
      ? {
          cardholderName: dec(cipher.card.cardholderName),
          brand: dec(cipher.card.brand),
          number: dec(cipher.card.number),
          expMonth: dec(cipher.card.expMonth),
          expYear: dec(cipher.card.expYear),
          code: dec(cipher.card.code),
        }
      : undefined,
    identity: cipher.identity
      ? Object.fromEntries(
          Object.entries(cipher.identity)
            .filter(([, value]) => typeof value === 'string')
            .map(([field, value]) => [field, dec(value)])
            .filter(([, value]) => value),
        )
      : undefined,
    sshKey: cipher.sshKey
      ? {
          privateKey: dec(cipher.sshKey.privateKey),
          publicKey: dec(cipher.sshKey.publicKey),
          keyFingerprint: dec(cipher.sshKey.keyFingerprint),
        }
      : undefined,
    secureNote: cipher.secureNote ? { type: cipher.secureNote.type ?? null } : undefined,
    favorite: Boolean(cipher.favorite),
    organizationId: cipher.organizationId ?? null,
    folderId: cipher.folderId ?? null,
    folder: cipher.folderId ? folderNames.get(cipher.folderId) ?? null : null,
    collections: (cipher.collectionIds ?? []).map((id) => collectionNames.get(id)).filter(Boolean),
    revisionDate: cipher.revisionDate ?? null,
    // Archive and trash state: both are plaintext dates on the server, and both
    // decide whether the item shows up in a search.
    archived: Boolean(cipher.archivedDate),
    archivedDate: cipher.archivedDate ?? null,
    deletedDate: cipher.deletedDate ?? null,
    // Bitwarden's password-reprompt flag: clients must not reveal such an
    // item's secrets without an explicit user confirmation.
    reprompt: Number(cipher.reprompt ?? 0),
  }
}

/**
 * A list field of a server payload, or an empty list.
 *
 * A sync payload is remote input, and the fields this file iterates are only
 * *expected* to be arrays. A number or an object there used to escape as
 * `TypeError: sync.ciphers is not iterable` — not a VaultError, so it bypassed
 * every caller's error handling and surfaced as "凭据库操作失败：<internal
 * message>" with no code. Treating a wrong shape as an empty list keeps the
 * connection usable and reports nothing it cannot know; a well-formed payload
 * is unaffected, since the test is the cheapest one available.
 */
function asList(value) {
  return Array.isArray(value) ? value : []
}

function decryptVault(sync, userKey) {
  const folderNames = new Map()
  for (const folder of asList(sync.folders)) {
    try {
      folderNames.set(folder.id, decryptString(folder.name, userKey) ?? '')
    } catch {
      folderNames.set(folder.id, '(无法解密)')
    }
  }
  const collectionNames = new Map()
  for (const collection of asList(sync.collections)) {
    try {
      collectionNames.set(collection.id, decryptString(collection.name, userKey) ?? '')
    } catch {
      collectionNames.set(collection.id, '(无法解密)')
    }
  }
  const items = []
  const trashed = []
  // The server's own cipher objects, kept so a write can start from the real
  // record instead of from this projection (see lib/mutations.js): a field the
  // request does not repeat is a field the server deletes.
  const raw = new Map()
  const orgKeys = resolveOrgKeys(sync, userKey)
  let skipped = 0
  for (const cipher of asList(sync.ciphers)) {
    if (!cipher?.id) continue
    raw.set(cipher.id, cipher)
    let item
    try {
      item = decryptCipher(cipher, userKey, orgKeys, folderNames, collectionNames)
    } catch {
      // One undecryptable cipher (e.g. an organization key this account cannot
      // unwrap) must not hide the rest of the vault — but it is reported.
      skipped += 1
      continue
    }
    // Soft-deleted ciphers stay in the sync payload with a `deletedDate`;
    // official clients keep them out of the vault list — they are the trash.
    if (cipher.deletedDate) trashed.push(item)
    else items.push(item)
  }
  const folders = countFolders(items, folderNames)
  return {
    items,
    trashed,
    byId: new Map(items.map((item) => [item.id, item])),
    folders,
    folderCount: folderNames.size,
    orgKeys,
    profileId: sync?.profile?.id ?? null,
    raw,
    skipped,
    // Kept so one cipher can be re-projected after a write without downloading
    // the whole vault again (see VaultClient#applyCipher). A cipher object
    // carries its `folderId` and `collectionIds` but not their names, and the
    // names are the one part of a projection that cannot be recovered from the
    // cipher itself.
    folderNames,
    collectionNames,
  }
}

/** Live entries per folder, as `{id, name, count}` in the folder map's order. */
function countFolders(items, folderNames) {
  const counts = new Map()
  for (const item of items) {
    if (item.folderId) counts.set(item.folderId, (counts.get(item.folderId) ?? 0) + 1)
  }
  return [...folderNames].map(([id, name]) => ({ id, name, count: counts.get(id) ?? 0 }))
}

// ── search + projection for the model ────────────────────────────────────────

function matchScore(item, tokens) {
  const haystacks = {
    name: (item.name ?? '').toLowerCase(),
    username: (item.username ?? '').toLowerCase(),
    uris: item.uris.join(' ').toLowerCase(),
    notes: (item.notes ?? '').toLowerCase(),
    fields: item.fields.map((field) => `${field.name ?? ''} ${field.value ?? ''}`).join(' ').toLowerCase(),
  }
  let score = 0
  for (const token of tokens) {
    let hit = 0
    if (item.id.toLowerCase() === token) hit = 100
    else if (haystacks.name === token) hit = 90
    else if (haystacks.name.startsWith(token)) hit = 70
    else if (haystacks.name.includes(token)) hit = 50
    else if (haystacks.username.includes(token)) hit = 35
    else if (haystacks.uris.includes(token)) hit = 30
    else if (haystacks.fields.includes(token)) hit = 20
    else if (haystacks.notes.includes(token)) hit = 10
    if (!hit) return 0
    score += hit
  }
  return score
}

function summary(item) {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    username: item.username ?? null,
    uris: item.uris.length ? item.uris : undefined,
    // The id `create`/`update` accept — the name alone cannot be written back.
    folderId: item.folderId ?? undefined,
    folder: item.folder ?? undefined,
    collections: item.collections.length ? item.collections : undefined,
    archived: item.archived || undefined,
    // Set only by the trashed half of `searchPayload`: without it the list a
    // `includeTrashed` search returns looks identical to a live one.
    trashed: item.trashed || undefined,
    hasTotp: Boolean(item.totpSecret),
    hasNotes: Boolean(item.notes),
    customFields: item.fields.map((field) => field.name).filter(Boolean),
    favorite: item.favorite || undefined,
    // The list paints the update time beside the name, so the row text and
    // the row order agree about which entry the reader touched last. It
    // rides along in the summary instead of being revealed per row:
    // decryptCipher already carries it, and a per-row reveal would turn one
    // list read into a page of full-entry reads.
    revisionDate: item.revisionDate ?? null,
  }
}

function resolveItem(vault, ref) {
  const needle = String(ref ?? '').trim()
  if (!needle) fail('需要提供条目 id 或名称', 'bad_request')
  // Trashed entries are resolvable by id so `get`/`restore` can name them, but
  // they never win a name match over a live entry.
  const direct = vault.byId.get(needle) ?? (vault.trashed ?? []).find((item) => item.id === needle)
  if (direct) return direct
  const all = [...vault.items, ...(vault.trashed ?? [])]
  const lower = needle.toLowerCase()
  const exact = all.filter((item) => item.name.toLowerCase() === lower)
  if (exact.length === 1) return exact[0]
  // Neither the needle nor the matched names are echoed back. The caller
  // already knows what it asked for, so repeating it adds nothing — and the
  // answer travels into transcripts and logs, where a list of entry titles
  // (or a "no such entry" for a name someone guessed) is reconnaissance the
  // vault never agreed to hand out. Counts and ids are the parts the caller
  // cannot reconstruct, so those are what the messages carry.
  if (exact.length > 1) {
    fail(`名称精确命中了 ${exact.length} 个条目（含回收站），无法确定是哪一个`, 'ambiguous', '用 bitwarden_find 取 id，再按 id 调用 bitwarden_get')
  }
  const partial = all.filter((item) => matchScore(item, [lower]) > 0)
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    fail(`关键词匹配到 ${partial.length} 个条目（含回收站），无法确定是哪一个`, 'ambiguous', '先调用 bitwarden_find 拿到 id，再按 id 指定')
  }
  fail('凭据库中没有匹配的条目', 'not_found', '换关键词调用 bitwarden_find，或请用户确认条目标题')
}

/**
 * What `field: 'all'` puts in place of a hidden custom field's value.
 *
 * A marker, not a mask: the caller has to be able to tell "this is a secret I
 * have not been given" from "this field is empty", and the name it reads back
 * is what it passes to `field: 'fields'` when it genuinely needs the value.
 */
const HIDDEN_FIELD_VALUE = '<hidden>'

function projectItem(item, field, at, confirm = false, options = {}) {
  const base = { id: item.id, name: item.name, type: item.type }
  // A trashed item is still readable by id, but the caller must never mistake
  // it for a live one (its password may already be gone from the account).
  if (item.deletedDate) base.trashed = true
  // Bitwarden's reprompt convention: an item flagged `reprompt: 1` must not be
  // auto-revealed. Official clients ask for the master password again, so this
  // gate covers EVERY field — notes and custom fields are as sensitive as the
  // password, and a gate that only covered the obvious ones would leak on the
  // way around it. `confirm` is no longer a caller-supplied boolean (that was
  // bypassable by the model itself); it is now a grant only `authorizeReprompt`
  // can produce, after the user typed the master password in the panel.
  if (item.reprompt === 1 && !confirm) {
    return {
      ...base,
      // The gate withholds the entry's fields, not its identity: the panel's
      // header still needs the host to show the right favicon, and a URI is
      // already on screen in the list row that opened this entry.
      uris: item.uris.length ? item.uris : undefined,
      repromptRequired: true,
      hint: '该条目在 Bitwarden 中启用了「重新验证」（reprompt），需要本人在插件面板里输入主密码才能读取；工具调用无法绕过这道门。请转告用户在「设置 → 凭据库」里打开该条目并输入主密码，或到官方客户端查看。',
    }
  }
  const withTotp = () => {
    if (!item.totpSecret) return undefined
    try {
      return generateTotp(item.totpSecret, at)
    } catch (error) {
      return { error: `TOTP 生成失败：${error.message}` }
    }
  }
  switch (field) {
    case 'password':
      return { ...base, username: item.username ?? null, password: item.password ?? null }
    case 'username':
      return { ...base, username: item.username ?? null }
    case 'totp':
      return { ...base, totp: withTotp() ?? null }
    case 'notes':
      return { ...base, notes: truncate(item.notes ?? '') ?? null }
    // Naming this field IS the ask: a caller that wants a hidden value has to
    // say so, exactly like the card number and the SSH key below.
    case 'fields':
      return { ...base, fields: item.fields }
    // The narrow cases below exist so that `all` can stop being a shotgun.
    // Each returns exactly one class of secret, on purpose: a caller that
    // wants a card number says so, and nothing else rides along.
    case 'passwordHistory':
      // The narrow read for the retired passwords themselves. Same gate as
      // every other secret field: `all` only says how many there are.
      return { ...base, passwordHistory: item.passwordHistory ?? [] }
    case 'card':
      return { ...base, card: item.card ?? null }
    case 'identity':
      return { ...base, identity: item.identity ?? null }
    case 'sshKey':
      // An SSH private key is a months-long credential, so `all` reports the
      // fingerprint and only this case hands over the material.
      return { ...base, sshKey: item.sshKey ?? null }
    // A secure note's content lives in `notes`; `secureNote.type` only says
    // which note kind it is. Naming the field is what tells the caller they
    // asked for a note body on purpose, so it comes back under that name.
    case 'secureNote':
      // Some servers omit the `secureNote` object and send only type 2 with
      // the body in `notes`, so the presence of a body — not the object — is
      // what decides whether this field has anything to hand back.
      if (!item.secureNote && !item.notes) return { ...base, secureNote: null }
      return { ...base, secureNote: { type: item.secureNote?.type ?? 0, notes: truncate(item.notes ?? '') ?? null } }
    case 'all':
    default:
      return {
        ...base,
        username: item.username ?? null,
        password: item.password ?? null,
        // Whether the entry carries a second factor, as a boolean. The seed
        // itself never leaves this layer (`totpSecret` is projection-local), so
        // this flag is the only thing the panel can gate its TOTP row on; the
        // code above is still withheld from a reprompt-gated read.
        hasTotp: Boolean(item.totpSecret),
        // `all` deliberately stops short of the TOTP code. A code is valid for
        // ~30 s: once it is in a transcript it is useless to the caller and a
        // live secret to whoever reads the transcript later.
        uris: item.uris.length ? item.uris : undefined,
        // For a secure note the `notes` field IS the secret, so `all` leaves it
        // out the same way it leaves out the card number: the caller has to
        // name `field=secureNote` to get the body.
        // Ordinary notes ride along (they are usually "which tenant was this
        // again"), but a secure note's body does not — see `secureNote` below.
        notes: item.notes && item.type !== 'secureNote' ? truncate(item.notes) : undefined,
        // Custom fields, with hidden ones withheld. Bitwarden's `type: 1` is
        // where people put the PIN, the API key and the recovery code, and
        // `all` was the one projection that still handed those values over
        // without being asked for them. The name and the placeholder stay so a
        // caller can see the field exists and name it back (field: 'fields').
        fields: item.fields.length
          ? item.fields.map((field) => (field.type === 1 && options.maskHiddenFields ? { name: field.name, type: field.type, value: HIDDEN_FIELD_VALUE } : field))
          : undefined,
        // Presence flags instead of the payloads. Card numbers, identity
        // numbers, secure notes and SSH keys each need a dedicated `field`
        // call now; `all` still tells the caller they exist and what shape.
        hasCard: Boolean(item.card),
        hasIdentity: Boolean(item.identity),
        hasSshKey: Boolean(item.sshKey),
        secureNote: item.secureNote || item.notes ? { type: item.secureNote?.type ?? 0 } : undefined,
        sshKeyFingerprint: item.sshKey?.keyFingerprint ?? undefined,
        attachments: item.attachments,
        // Retired passwords used to ride along with `all` in the clear: every
        // one of them is a credential that may still open the same account (a
        // rotation that was never rolled out everywhere). `all` reports that
        // history EXISTS and when each entry was retired, and the material
        // itself needs `field: 'passwordHistory'` — the same rule the card
        // number, the identity and the SSH key already follow.
        passwordHistory: item.passwordHistory?.map((entry) => ({ lastUsedDate: entry.lastUsedDate ?? null })),
        passwordHistoryCount: item.passwordHistory?.length ?? 0,
        hasFido2: item.hasFido2 || undefined,
        folderId: item.folderId ?? undefined,
        folder: item.folder ?? undefined,
        collections: item.collections.length ? item.collections : undefined,
        archived: item.archived || undefined,
        archivedDate: item.archivedDate ?? undefined,
        deletedDate: item.deletedDate ?? undefined,
        revisionDate: item.revisionDate ?? undefined,
      }
  }
}

// ── live sync ────────────────────────────────────────────────────────────────

/**
 * Keeps the in-memory vault fresh without the model asking for it.
 *
 * Primary path: a `NotificationChannel` WebSocket to `/notifications/hub`.
 * Every hub message means "something changed", so the controller debounces
 * (400 ms) and re-runs the same fetch+decrypt as `unlock()`, then swaps the
 * client's cached vault — tools and UI read the new state immediately.
 *
 * Fallback path: when the hub is unreachable (disabled by
 * `ENABLE_WEBSOCKET=false`, an old server, or a proxy that blocks the
 * upgrade), the channel gives up and the controller polls `/api/sync` on a
 * fixed interval instead. Either way the caller only sees `report()`.
 */
class LiveSync {
  /**
   * @param {VaultClient} client
   * @param {{pollIntervalMs?: number, minPollIntervalMs?: number, websocket?: boolean, onUpdate?: (vault: any) => void, log?: (m: string) => void, channelOptions?: object}} [options]
   *   `minPollIntervalMs` lowers the built-in floor; only tests should need it.
   *   `channelOptions` is merged into the NotificationChannel constructor (tests
   *   inject a failing WebSocket implementation this way).
   */
  constructor(client, options = {}) {
    this.client = client
    this.pollIntervalMs = Math.max(
      Number(options.minPollIntervalMs ?? MIN_POLL_INTERVAL_MS),
      Number(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    )
    this.websocketEnabled = options.websocket !== false
    this.channelOptions = options.channelOptions ?? {}
    this.onUpdate = options.onUpdate ?? (() => {})
    this.log = options.log ?? (() => {})

    /** @type {'off'|'starting'|'websocket'|'polling'} */
    this.mode = 'off'
    this.lastSignalAt = null
    this.lastSyncAt = null
    this.lastError = null

    this.#channel = null
    this.#pollTimer = null
    this.#upgradeTimer = null
    this.#debounceTimer = null
    this.#retryTimer = null
    this.#stopped = true
  }

  #channel
  #pollTimer
  #upgradeTimer
  #debounceTimer
  #retryTimer
  #stopped

  start() {
    if (!this.#stopped) return
    this.#stopped = false
    if (!this.client.configured) {
      this.mode = 'off'
      return
    }
    if (this.websocketEnabled) {
      this.mode = 'starting'
      this.#rebuildChannel()
    } else {
      this.#startPolling()
    }
  }

  #startPolling() {
    if (this.#stopped || this.mode === 'polling') return
    this.#stopChannel()
    this.mode = 'polling'
    this.#pollTimer = setInterval(() => this.#signal(), this.pollIntervalMs)
    this.#pollTimer.unref?.()
    // The usual reason the hub is unreachable is that no session exists yet —
    // at activation a two-factor account still has to sign in. Without this
    // periodic upgrade attempt the fallback would be permanent, and the user
    // would stay on slow polling even after a successful sign-in.
    if (this.websocketEnabled) {
      this.#upgradeTimer = setInterval(() => this.#tryUpgrade(), this.#upgradeIntervalMs())
      this.#upgradeTimer.unref?.()
    }
  }

  #stopPolling() {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    if (this.#upgradeTimer) {
      clearInterval(this.#upgradeTimer)
      this.#upgradeTimer = null
    }
  }

  /** How often to retry the hub while falling back to polling. */
  #upgradeIntervalMs() {
    return Math.max(30_000, Math.min(this.pollIntervalMs, 120_000))
  }

  /** Try to replace the polling fallback with a real WebSocket channel. */
  #tryUpgrade() {
    if (this.#stopped || this.mode !== 'polling') return
    if (this.#channel) return
    this.#rebuildChannel()
  }

  /** Build the channel and start it (shared by start() and #tryUpgrade()). */
  #rebuildChannel() {
    if (this.#stopped || !this.client.configured) return
    this.#channel = new NotificationChannel({
      server: this.client.server,
      getToken: async () => (await this.client.ensureToken()).accessToken,
      fetch: this.client.fetch,
      onSignal: () => this.#signal(),
      onLogout: () => {
        this.client.invalidate()
        this.lastError = new Error('会话已在别处注销（服务端 LogOut 通知），下次使用将重新登录')
        this.log('live sync: 收到 LogOut 通知，已清除本地会话')
      },
      onStateChange: (state) => {
        if (state === 'open') this.mode = 'websocket'
      },
      onOpen: () => {
        this.mode = 'websocket'
        this.#stopPolling()
        this.lastError = null
      },
      onGiveUp: (error) => {
        this.lastError = error
        this.log(`live sync: WebSocket 不可用（${error?.message ?? error}），降级为轮询`)
        this.#channel = null
        // Idempotent: from 'starting' this switches to polling and arms the
        // upgrade timer; while already polling it leaves both alone.
        this.#startPolling()
      },
      log: this.log,
      ...this.channelOptions,
    })
    this.#channel.start().catch((error) => {
      this.lastError = error
      this.#channel = null
      this.#startPolling()
    })
  }

  #stopChannel() {
    if (this.#channel) {
      this.#channel.stop()
      this.#channel = null
    }
  }

  /** A change was signalled (hub message or poll tick) — debounce then re-sync. */
  #signal() {
    this.lastSignalAt = this.client.now()
    if (this.#debounceTimer) return
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null
      this.#syncWithBackoff()
    }, 400)
    this.#debounceTimer.unref?.()
  }

  /** Re-sync; a 429 (Bitwarden rate limit) schedules one bounded retry. */
  #syncWithBackoff() {
    this.client.syncNow().catch((error) => {
      this.lastError = error
      this.log(`live sync: 同步失败（${error?.message ?? error}）`)
      if (error?.code !== 'rate_limited' || this.#stopped || this.#retryTimer) return
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null
        if (this.#stopped) return
        this.client.syncNow().catch(() => {})
      }, this.pollIntervalMs)
      this.#retryTimer.unref?.()
    })
  }

  stop() {
    this.#stopped = true
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer)
      this.#debounceTimer = null
    }
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    this.#stopPolling()
    this.#stopChannel()
    this.mode = 'off'
  }

  report() {
    return {
      mode: this.mode,
      connected: this.#channel?.connected ?? false,
      pollIntervalMs: this.pollIntervalMs,
      lastSignalAt: this.lastSignalAt ? new Date(this.lastSignalAt).toISOString() : null,
      lastSyncAt: this.lastSyncAt ? new Date(this.lastSyncAt).toISOString() : null,
      lastError: this.lastError?.message ?? null,
    }
  }
}

/** The sections the panel's sidebar can name (see `overview`). Anything else reads as `all`. */
const SECTION_KINDS = new Set(['all', 'totp', 'type', 'folder', 'unfiled', 'favorites', 'archive', 'trash'])

/**
 * Build the search payload object, shared by the `bitwarden_find` tool and the
 * HTTP API. Never contains passwords. With `allowEmpty`, an empty query lists
 * every item (score 1) — the UI's initial view; the tool keeps requiring one.
 *
 * `section`/`sectionValue` narrow the read to one sidebar section. They belong
 * here rather than in the panel because the scoring, the page window and the
 * `matched` count all have to agree: filtering a served window would make the
 * counter and the pager describe a list nobody is looking at.
 */
function searchPayload(vault, query, limit, { allowEmpty = false, offset = 0, includeArchived = false, includeTrashed = false, section = 'all', sectionValue = null } = {}) {
  const tokens = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!tokens.length && !allowEmpty) {
    fail('query 不能为空', 'bad_request', '传入名称、用户名或网址关键词')
  }
  // Archived entries are retired credentials: a search for "github" must not
  // hand the agent an old token as if it were the current one. They come back
  // only when the caller asks for them, and trashed entries (soft-deleted)
  // likewise — each is flagged in its summary when it does.
  // A section is a place in the sidebar, not a refinement of the list: the pool
  // it names is the whole of that place, so `matched`, paging and the counter
  // all describe what the reader picked. Filtering the pool (rather than the
  // page) is what keeps page two of a folder honest. Trash and archive are the
  // two sections that swap which half of the vault is read at all; the rest
  // narrow the live list.
  const kind = SECTION_KINDS.has(section) ? section : 'all'
  const pool = (() => {
    if (kind === 'trash') return (vault.trashed ?? []).map((item) => ({ ...item, trashed: true }))
    if (kind === 'archive') return vault.items.filter((item) => item.archived)
    const live = includeArchived ? vault.items : vault.items.filter((item) => !item.archived)
    if (kind === 'type') return live.filter((item) => item.type === sectionValue)
    if (kind === 'folder') return live.filter((item) => item.folderId === sectionValue)
    if (kind === 'unfiled') return live.filter((item) => !item.folderId)
    if (kind === 'favorites') return live.filter((item) => item.favorite)
    if (kind === 'totp') return live.filter((item) => Boolean(item.totpSecret))
    return live
  })()
  const extra =
    kind === 'trash' || !includeTrashed ? [] : (vault.trashed ?? []).map((item) => ({ ...item, trashed: true }))
  // Trashed entries lead the ranking: an empty query scores everything 1, and
  // the name tiebreak would otherwise fold the soft-deleted rows in among the
  // live ones — past the first page of a large vault, which is the one page
  // the panel always reads. The flag has to sit in the comparator itself; a
  // stable sort only preserves the incoming order among comparator-equal
  // entries, and the name tiebreak makes these unequal, so spreading the trash
  // half first is not enough to hoist it.
  const scored = [...extra, ...pool]
    .map((item) => ({ item, score: tokens.length ? matchScore(item, tokens) : 1 }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.item.trashed ? 1 : 0) - (a.item.trashed ? 1 : 0) ||
        a.item.name.localeCompare(b.item.name, 'zh-Hans-CN'),
    )
  // One page of the ranked list: the panel asks for a small first page and
  // walks forward with `offset` as the reader scrolls, so a large vault no
  // longer has to cross the RPC boundary in one read.
  const start = Math.max(0, Number(offset) || 0)
  const page = scored.slice(start, start + limit)
  const payload = {
    query: query ?? '',
    matched: scored.length,
    returned: page.length,
    offset: start,
    hasMore: start + page.length < scored.length,
    vaultItems: pool.length,
    hint: scored.length ? '用 bitwarden_get（id 或 name）取出密码等字段' : '换个关键词，或先确认条目是否存在于该账户',
    // The score stays inside this function: it is a ranking device, and its
    // value band tells the caller which KIND of field matched (20 = custom
    // field, 10 = notes), which is an existence oracle for anyone probing a
    // guessed token prefix. Callers get the order, not the arithmetic.
    items: page.map(({ item }) => summary(item)),
  }
  const archivedCount = vault.items.length - vault.items.filter((item) => !item.archived).length
  if (archivedCount && !includeArchived) {
    payload.archivedItems = `${archivedCount} 个条目已归档（默认不列出；includeArchived: true 可查看）`
  }
  if (vault.trashed?.length) {
    payload.trashedItems = includeTrashed
      ? vault.trashed.length
      : `${vault.trashed.length} 个条目在回收站（includeTrashed: true 可查看，bitwarden_restore 可恢复）`
  }
  if (vault.skipped) {
    payload.unavailableItems = `${vault.skipped} 个条目属于本账户无法解密的组织（缺少可用组织密钥）`
  }
  return payload
}

// ── the client the plugin talks to ───────────────────────────────────────────

export class VaultClient {
  /**
   * @param {object} settings - resolved plugin settings.
   * @param {{fetch?: Function, now?: () => number, timeoutMs?: number, sessionStore?: object, cacheStore?: object}} [options]
   *   `sessionStore` persists the signed-in session across plugin restarts (see
   *   lib/session-store.js). Without it a restart forces a fresh login — and
   *   with two-factor enabled that means a fresh code every time.
   *   `cacheStore` keeps the last sync payload (still the server's ciphertext)
   *   so a cold start can draw the list before the network answers (see
   *   lib/cache-store.js). Optional: without it every start is a full sync.
   */
  constructor(settings, options = {}) {
    this.settings = settings
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? now
    // Waiting out a TOTP window is a real sleep in production, but a test must
    // not spend 20 seconds of wall clock proving it waited. Injected, like `now`.
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    /** @type {object|null} on-disk session persistence (optional) */
    this.sessionStore = options.sessionStore ?? null
    /** @type {object|null} on-disk vault cache (optional; see lib/cache-store.js) */
    this.cacheStore = options.cacheStore ?? null
    /** @type {null | {accessToken: string, refreshToken: string|null, expiresAt: number, encryptedKey: string|null, masterKey?: Buffer}} */
    this.token = null
    /** @type {null | {items: any[], byId: Map<string, any>, at: number}} */
    this.vault = null
    /** @type {LiveSync | null} */
    this.live = null
    /** @type {null | {twoFactorToken: string|null, providers: number[], provider: number, at: number}} */
    this.pendingTwoFactor = null
    /** @type {null | {at: number, reachable: boolean, serverVersion: string|null, connectError: string|null}} */
    this.#serverProbe = null
    /** @type {null | {key: string, payload: object}} memoised `findEntries` result */
    this.#listCache = null
    /** @type {null | object} the cache record the current vault came from */
    this.#cacheRecord = null
    /** @type {null | {at: number, reason: string, message: string}} why the last stored session was discarded */
    this.lastSessionLoss = null
    /** @type {null | {at: number, kind: string, message: string}} the last session event (see ensureToken) */
    this.lastSessionEvent = null
    this.#unlockFlight = null
  }

  /** Cached `/api/config` reachability probe (see SERVER_PROBE_TTL_MS). */
  #serverProbe
  /** Memoised search payload, invalidated whenever the vault is replaced. */
  #listCache
  /** The cache record behind the in-memory vault (null when none was used). */
  #cacheRecord
  /** True while a background freshness check is in flight. */
  #revalidating
  /**
   * The unlock currently in flight, if any — the single-flight gate.
   *
   * Without it every concurrent reader ran the whole cold chain for itself:
   * the panel's own first paint fires four RPCs together (list, status,
   * overview, folders), and on a cold start each of those missed the in-memory
   * vault, missed the disk cache at the same instant, and issued its own
   * /api/sync download plus its own revision probe. Measured on a real account:
   * four concurrent cold reads = 4 downloads, 4.7 s; the same four run in
   * sequence = 1 download, 0.9 s. Sharing one attempt is what makes the panel
   * open once instead of four times over.
   */
  #unlockFlight = null
  /** Pending coalescing timer for `syncSoon()` (see the write path). */
  #syncSoonTimer = null
  /**
   * Bumped whenever the session is dropped (sign-out, reconfigure). An unlock
   * attempt records the value it started under and refuses to install its
   * result if the value moved: a slow cold start that finishes after the
   * operator signed out must not put the old account's vault back on screen.
   */
  #sessionGeneration = 0
  /** Earliest time a fallback login may be attempted again (see ensureToken). */
  #loginRetryAt = 0
  /**
   * When the stored session was last written by `touchSession` (ms epoch).
   *
   * The idle deadline only needs minute granularity, and the write costs a
   * durable fsync (~50 ms) on every RPC that fetches a token — see touchSession.
   */
  #touchAt = 0
  /**
   * The token refresh currently in flight, if any — the single-flight gate.
   *
   * Vaultwarden rotates the refresh token on use, so two parallel refreshes
   * make the loser look like a revoked credential (see #refresh).
   */
  #refreshFlight = null
  // In-memory proof that the user re-entered the master password for a
  // reprompt-gated entry. Never persisted, never derived from an argument.
  // Shape: { until, itemId: string|null, fields: string[]|null } — `itemId:
  // null` means the proof was not scoped to one entry.
  #repromptGrant = null
  /** Consecutive failed reprompt proofs, reset by a success (see authorizeReprompt). */
  #repromptAttempts = 0
  /** Earliest time a reprompt proof may be attempted again; 0 when unlocked. */
  #repromptLockUntil = 0

  /** Swap settings (used when the user edits them) and drop every cached secret. */
  reconfigure(settings) {
    const previous = this.identity
    this.settings = settings
    // Pointed at another account or server: the previous account's cached
    // ciphertext must not linger on disk. (The next sync would overwrite it
    // anyway, but the file should not outlive the account it belongs to.)
    if (previous !== this.identity) {
      if (this.cacheStore?.clear) this.cacheStore.clear()
      this.#cacheRecord = null
    }
    // Keep the stored session: this fires on every settings write, and wiping
    // it would force a fresh two-factor login for a mere preference change.
    this.invalidate({ keepStored: true })
  }

  /** `serverUrl` + `email` as one comparable value (change detection only). */
  get identity() {
    const url = String(this.settings.serverUrl ?? '').trim()
    const mail = String(this.settings.email ?? '').trim().toLowerCase()
    return `${url}\u0000${mail}`
  }

  // ── session persistence ────────────────────────────────────────────────────
  // A restart used to discard the session, forcing a fresh login (and a fresh
  // two-factor code). The token, its refresh token and the derived master key
  // are enough to reopen the vault silently, so they are kept on disk and
  // expired on IDLE rather than on age.

  /**
   * Persist the current session, if one exists and persistence is enabled.
   * Called after every successful login/refresh and whenever the session is
   * used, so `lastUsedAt` keeps sliding forward.
   */
  persistSession() {
    const store = this.sessionStore
    if (!store || typeof store.save !== 'function' || !this.token) return false
    const masterKey = this.token.masterKey
    this.#touchAt = this.now()
    const saved = store.save({
      accessToken: this.token.accessToken,
      refreshToken: this.token.refreshToken ?? null,
      expiresAt: this.token.expiresAt,
      encryptedKey: this.token.encryptedKey ?? null,
      // Base64 because JSON cannot carry a Buffer.
      masterKey: masterKey ? Buffer.from(masterKey).toString('base64') : null,
      userKey: this.token.userKey ? Buffer.from(this.token.userKey).toString('base64') : null,
      // KDF parameters travel with the session so `authorizeReprompt` can
      // re-derive a typed master password offline (see that method).
      kdf: this.token.kdf ?? null,
      kdfIterations: this.token.kdfIterations ?? null,
      kdfMemory: this.token.kdfMemory ?? null,
      kdfParallelism: this.token.kdfParallelism ?? null,
      serverUrl: this.server,
      email: String(this.settings.email ?? '').trim(),
      savedAt: this.now(),
      lastUsedAt: this.now(),
    })
    // A store that cannot write is a silent data-loss path: the operator is
    // told the device is remembered, and the next start asks for the password
    // again with no explanation. Recording the failure puts it in `status()`
    // instead (see #noteSessionEvent).
    if (saved === false) this.#noteSessionEvent('session_not_persisted', '会话文件写入失败（磁盘只读或空间不足），重启后需要重新登录')
    return saved
  }

  /**
   * Load a stored session for the configured account, if any.
   * @returns {boolean} whether a usable session was restored
   */
  restoreSession() {
    const store = this.sessionStore
    if (!store || typeof store.load !== 'function' || !this.configured) return false
    const record = store.load({ serverUrl: this.server, email: String(this.settings.email ?? '').trim() })
    if (!record) return false
    const masterKey = record.masterKey ? Buffer.from(record.masterKey, 'base64') : null
    this.token = {
      accessToken: record.accessToken ?? null,
      refreshToken: record.refreshToken ?? null,
      // Force an immediate refresh when the stored access token has aged out.
      expiresAt: Number(record.expiresAt) || 0,
      encryptedKey: record.encryptedKey ?? null,
      masterKey: masterKey ?? undefined,
      userKey: record.userKey ? Buffer.from(record.userKey, 'base64') : undefined,
      kdf: record.kdf ?? null,
      kdfIterations: record.kdfIterations ?? null,
      kdfMemory: record.kdfMemory ?? null,
      kdfParallelism: record.kdfParallelism ?? null,
    }
    return true
  }

  /**
   * Slide the idle deadline forward after a successful use.
   *
   * Throttled, and that is the whole point. `ensureToken` calls this on every
   * successful token fetch — i.e. once per RPC — and the store's write path is
   * a durable one (temp file + fsync + rename + directory fsync), measured at
   * ~50 ms on this machine. So every list read, every status poll and every
   * per-second TOTP tick paid half a hundred milliseconds of synchronous disk
   * I/O to move one timestamp. The value only drives the idle deadline
   * (`sessionDays`, default 30 days), where a minute of granularity is
   * invisible: what matters is that the record is not left at a timestamp from
   * days ago, not that it is accurate to the second.
   */
  touchSession() {
    const store = this.sessionStore
    if (!store || typeof store.touch !== 'function' || !this.token) return
    const at = this.now()
    if (this.#touchAt && at - this.#touchAt < SESSION_TOUCH_INTERVAL_MS) return
    this.#touchAt = at
    if (typeof store.load === 'function') {
      const record = store.load({ serverUrl: this.server, email: String(this.settings.email ?? '').trim() })
      if (record) {
        store.touch(record)
        if (store.save(record) === false) this.#noteSessionEvent('session_not_persisted', '会话文件写入失败（磁盘只读或空间不足），重启后需要重新登录')
        return
      }
    }
    this.persistSession()
  }

  /**
   * Bring a stored session back without ever prompting for credentials.
   *
   * `restoreSession()` reads the file, `#refresh()` swaps a still-valid refresh
   * token for a fresh access token. Both are silent, so the panel can revive a
   * remembered device (the 2FA "记住" path) without dragging the operator back
   * into the sign-in form. Returns `true` when the client is authenticated
   * afterwards; never performs a password grant, so a two-factor account can
   * never be challenged by a mere panel open.
   *
   * @param {AbortSignal} [signal] aborted by a newer boot() → keeps one session
   */
  async resumeSession(signal) {
    if (!this.configured) return false
    if (signal?.aborted) return false
    this.restoreSession()
    if (this.token && this.token.expiresAt - 60_000 > this.now()) {
      // Already fresh on disk — only the idle deadline moves.
      this.touchSession()
      return true
    }
    if (!this.token?.refreshToken) return false
    try {
      const ok = await this.#refresh()
      if (ok) {
        this.touchSession()
        return true
      }
    } catch {
      // Transient failure (offline, 429, 5xx): `#refresh` deliberately kept
      // both the token and the file, so this is "not right now" rather than
      // "signed out". Fall through to re-read what is actually stored.
    }
    // Either the refresh was rejected — the record is gone — or it failed
    // transiently and the record was kept. Another process may also have
    // renewed the file in the meantime (two hosts), so answer from the store.
    this.restoreSession()
    return Boolean(this.token && this.token.expiresAt - 60_000 > this.now())
  }

  /** Session persistence status, for the settings panel. */
  get sessionPersistence() {
    const store = this.sessionStore
    if (!store || typeof store.describe !== 'function') return { enabled: false, stored: false }
    // An unconfigured install has no server URL to key a stored session by,
    // and reporting "nothing stored" is the honest answer. It must not throw:
    // this getter is one field of the panel config() payload, so letting
    // normalizeServerUrl("") raise not_configured here rejected the whole
    // call and left a fresh install on a "尚未配置完成" dead end whose only
    // control was a 重试 button that re-ran the same failing request.
    if (!String(this.settings?.serverUrl ?? '').trim()) return store.describe(null)
    const record = typeof store.load === 'function' ? store.load({ serverUrl: this.server, email: String(this.settings.email ?? '').trim() }) : null
    return store.describe(record)
  }

  /**
   * Drop every cached credential.
   * @param {{keepStored?: boolean}} [options] `keepStored` leaves the on-disk
   *   session alone. Internal callers (settings change, LogOut notification)
   *   use it so a transient invalidation does not silently sign the user out;
   *   an explicit user sign-out passes nothing and also wipes the store.
   */
  invalidate(options = {}) {
    this.token = null
    this.vault = null
    this.#listCache = null
    // A queued background sync belongs to the session being dropped: letting it
    // fire would re-download and re-install a vault the sign-out just cancelled.
    this.#cancelSyncSoon()
    // An in-flight unlock belongs to the session being dropped: without this
    // it would finish and install a vault the sign-out just cancelled, and
    // every later reader would join an attempt that started as another
    // account. The generation is what the attempt itself checks.
    this.#unlockFlight = null
    this.#sessionGeneration += 1
    // A re-prompt grant only means anything while the session it was proved
    // against is still live: dropping the session drops the grant with it.
    this.#repromptGrant = null
    // Back-off state belongs to the attempt being dropped, not to the caller
    // who starts the next one. Leaving it armed made an explicit sign-out
    // followed by an immediate sign-in fail with `session_expired` for a
    // minute — the user had just told us to forget the session, and the
    // leftover cooldown from the *previous* failure was still refusing them.
    // The same applies to the re-prompt attempts (a fresh session must start
    // with a clean slate) and to the touch throttle (the next session should
    // persist on its first use, not a minute later).
    this.#loginRetryAt = 0
    this.#repromptAttempts = 0
    this.#repromptLockUntil = 0
    this.#touchAt = 0
    // A stale two-factor challenge must not keep blocking the panel.
    this.pendingTwoFactor = null
    if (!options.keepStored) {
      if (this.sessionStore?.clear) this.sessionStore.clear()
      // An explicit sign-out also drops the cached vault.
      if (this.cacheStore?.clear) this.cacheStore.clear()
      this.#cacheRecord = null
    }
  }

  /**
   * Drop every cached credential and any pending two-factor challenge, so the
   * next call starts a clean login. This is the UI's escape hatch when a
   * challenge expired or the stored account is wrong.
   */
  reset() {
    this.invalidate()
  }

  /**
   * Record a two-factor challenge on this client. `connect()` verifies new
   * credentials on a throwaway probe, then adopts the challenge here so the
   * background guard (`ensureToken`) keeps refusing to start fresh logins
   * while the user types the code — otherwise every poll tick would hit the
   * login endpoint and its rate limiter.
   */
  adoptChallenge(pending) {
    this.pendingTwoFactor = {
      providers: pending?.providers ?? [],
      providerDescriptions: pending?.providerDescriptions ?? null,
      provider: pending?.provider ?? 0,
      at: this.now(),
    }
  }

  /**
   * Drop only a half-finished two-factor challenge, keeping any established
   * session. Used when the code screen goes away: the incomplete sign-in must
   * not linger, while an already-signed-in user stays signed in.
   */
  discardChallenge() {
    this.pendingTwoFactor = null
  }

  get authMode() {
    return this.settings.apiKeyClientId && this.settings.apiKeyClientSecret ? 'apikey' : 'password'
  }

  /**
   * Current sign-in state, WITHOUT contacting the server or starting a login.
   * The panel uses this to decide what to render on open: a stored-but-unused
   * credential set must NOT auto-trigger a login, or the two-factor screen
   * would reappear on every visit.
   */
  get session() {
    const token = this.token
    return {
      configured: this.configured,
      authenticated: Boolean(token && token.expiresAt - 60_000 > this.now()),
      pendingTwoFactor: Boolean(this.pendingTwoFactor),
      unlocked: Boolean(this.vault),
      // Why the last stored session was discarded, when it was (the panel and
      // `bitwarden_status` surface it, so "why am I being asked for a password
      // again" has an answer).
      lastSessionLoss: this.lastSessionLoss,
      // The last session event (silent re-login, failed login, two-factor
      // needed), so a background session loss is visible instead of surfacing
      // only as a bare 401 from whichever call happened to be first.
      lastSessionEvent: this.lastSessionEvent,
    }
  }

  get missing() {
    const missing = []
    if (!this.settings.serverUrl) missing.push('serverUrl')
    if (!this.settings.email) missing.push('email')
    if (this.authMode === 'apikey') {
      if (!this.settings.masterPassword) missing.push('masterPassword（解密保险库仍需主密码）')
    } else if (!this.settings.masterPassword) {
      missing.push('masterPassword（或改用 apiKeyClientId + apiKeyClientSecret）')
    }
    return missing
  }

  get configured() {
    return this.missing.length === 0
  }

  get server() {
    return normalizeServerUrl(this.settings.serverUrl)
  }

  #notConfigured() {
    fail(`凭据库尚未配置完整，缺少：${this.missing.join('、')}`, 'not_configured', '请用户在 DSH 设置 → 插件 → bitwarden 中填写后重试')
  }

  /**
   * Log in (password or API-key grant) and cache the tokens.
   * Pass `twoFactor` (and optionally `twoFactorProvider`, default 0) to finish
   * a login the server answered with `two_factor_required`.
   */
  async login(signal, twoFactor) {
    if (!this.configured) this.#notConfigured()
    // Recorded before the first await: a sign-out that lands while this call
    // is in flight must not be undone by the session it was cancelling. On a
    // shared machine that is one account's tokens appearing after another
    // account signed in.
    const generation = this.#sessionGeneration
    const server = this.server
    const email = String(this.settings.email).trim()
    const password = String(this.settings.masterPassword ?? '')
    const pre = await prelogin(this.fetch, server, email, signal)
    const masterKey = await deriveMasterKey(password, email, pre.kdf, pre.kdfIterations, {
      memory: pre.kdfMemory,
      parallelism: pre.kdfParallelism,
    })
    const body =
      this.authMode === 'apikey'
        ? {
            grant_type: 'client_credentials',
            client_id: String(this.settings.apiKeyClientId).trim(),
            client_secret: String(this.settings.apiKeyClientSecret).trim(),
            scope: 'api',
            deviceType: String(DEVICE_TYPE),
            deviceIdentifier: resolveDeviceIdentifier(this.settings),
            deviceName: CLIENT_NAME,
          }
        : {
            grant_type: 'password',
            username: email,
            password: hashMasterPassword(masterKey, password),
            scope: 'api offline_access',
            client_id: CLIENT_ID,
            deviceType: String(DEVICE_TYPE),
            deviceIdentifier: resolveDeviceIdentifier(this.settings),
            deviceName: CLIENT_NAME,
          }
    // Two-factor continuation: re-send the same password grant with the user's
    // code. Per vaultwarden's `ConnectData`, the code goes in `two_factor_token`
    // (there is no server-issued continuation token).
    if (twoFactor && twoFactor.code) {
      body.twoFactorToken = String(twoFactor.code)
      body.twoFactorProvider = String(twoFactor.provider ?? 0)
      body.twoFactorRemember = twoFactor.remember ? '1' : '0'
    }
    let token
    try {
      token = await requestToken(this.fetch, server, body, signal, this.now)
      this.pendingTwoFactor = null
    } catch (error) {
      // The challenge carries the provider list; keep it so the UI can render
      // the right input without another round trip.
      if (error instanceof VaultError && error.code === 'two_factor_required') {
        this.pendingTwoFactor = {
          providers: error.providers ?? [],
          providerDescriptions: error.providerDescriptions ?? null,
          provider: error.providers?.[0] ?? 0,
          at: this.now(),
        }
      }
      throw error
    }
    token.masterKey = masterKey
    // Keep the KDF parameters the account actually uses even when the token
    // response omits them (the API-key grant does): `authorizeReprompt` needs
    // them to re-derive a typed master password without a network round trip.
    token.kdf = token.kdf ?? pre.kdf
    token.kdfIterations = token.kdfIterations ?? pre.kdfIterations
    token.kdfMemory = token.kdfMemory ?? pre.kdfMemory
    token.kdfParallelism = token.kdfParallelism ?? pre.kdfParallelism
    if (!token.encryptedKey) {
      const sync = await fetchSync(this.fetch, server, token.accessToken, signal)
      token.encryptedKey = sync?.profile?.key ?? null
      token.pendingSync = sync
    }
    if (generation !== this.#sessionGeneration) fail('登录已被取消（会话在登录期间被注销）', 'login_superseded')
    this.token = token
    this.lastSessionLoss = null // a fresh sign-in supersedes any earlier loss
    // And it retires the last event with it: a `login_failed` recorded before
    // this success is history, not state. Leaving it in place made the panel
    // paint its sync chip red forever after one bad restart, because nothing
    // ever cleared a kind that had already been answered.
    this.lastSessionEvent = null
    // A successful login is the moment the session becomes worth keeping: for a
    // two-factor account it is the only time a code was required.
    this.persistSession()
    return token
  }

  /**
   * Refresh the access token, once.
   *
   * Single-flight, for the same reason `unlock` is. The panel's first paint and
   * the live-sync channel both call `ensureToken` around the same moment and
   * both find the same expired token; Vaultwarden ROTATES the refresh token on
   * every use, so two parallel refreshes mean the loser is told `invalid_grant`
   * for a token that was valid a millisecond earlier. That answer looks exactly
   * like a revoked credential (`isRejectedCredential`), so the loser used to
   * clear the session file and sign the operator out — with the winner's fresh
   * token already in memory. Sharing one attempt removes the race; the
   * generation guard is what keeps a late answer from resurrecting a session
   * that has since been dropped.
   */
  async #refresh(signal) {
    if (this.#refreshFlight) return this.#refreshFlight
    this.#refreshFlight = this.#refreshOnce(signal).finally(() => {
      this.#refreshFlight = null
    })
    return this.#refreshFlight
  }

  async #refreshOnce(signal) {
    const generation = this.#sessionGeneration
    const server = this.server
    // Snapshot the token before the first await. Reading `this.token` after it
    // was a use-after-free in slow motion: a concurrent `invalidate()` (sign
    // out, reconfigure) nulls the field while the request is in flight, and
    // every `this.token.x` below then threw a bare TypeError that escaped the
    // generation check and surfaced as an unclassified 凭据库操作失败.
    const current = this.token
    if (!current || !current.refreshToken) return false
    try {
      const refreshed = await requestToken(
        this.fetch,
        server,
        {
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
          client_id: this.authMode === 'apikey' ? String(this.settings.apiKeyClientId).trim() : CLIENT_ID,
        },
        signal,
        this.now,
      )
      // The session this refresh belongs to may have ended while it was in
      // flight; the answer is then not ours to install and not ours to keep.
      if (generation !== this.#sessionGeneration) return false
      refreshed.masterKey = current.masterKey
      refreshed.encryptedKey = refreshed.encryptedKey ?? current.encryptedKey
      refreshed.userKey = current.userKey
      // A refresh response carries no KDF fields; without these the re-prompt
      // check would have to go back to the server after every token renewal.
      refreshed.kdf = refreshed.kdf ?? current.kdf
      refreshed.kdfIterations = refreshed.kdfIterations ?? current.kdfIterations
      refreshed.kdfMemory = refreshed.kdfMemory ?? current.kdfMemory
      refreshed.kdfParallelism = refreshed.kdfParallelism ?? current.kdfParallelism
      // A refresh that lands after a sign-out belongs to the session that is
      // already gone; installing it would sign the operator back in.
      if (generation !== this.#sessionGeneration) return false
      this.token = refreshed
      // The refresh is a success the panel never asked for, so it is also where
      // a stale `login_failed` is retired: the chip stays red otherwise, long
      // after the session came back.
      this.lastSessionEvent = null
      this.persistSession()
      return true
    } catch (error) {
      // A rejection for a session that is already gone says nothing about the
      // session that replaced it: clearing here would delete the stored
      // credential of an account the operator signed into in the meantime.
      if (generation !== this.#sessionGeneration) return false
      if (isRejectedCredential(error)) {
        // The server refused the refresh token itself: it really is dead, and
        // so is the stored session that carries it. Remember why, so the next
        // open can explain the credential prompt instead of it appearing from
        // nowhere.
        this.lastSessionLoss = {
          at: this.now(),
          reason: 'refresh_rejected',
          message: error?.message ?? String(error),
        }
        this.token = null
        if (this.sessionStore?.clear) this.sessionStore.clear()
        return false
      }
      // Offline, timed out, rate-limited, server error — the server never
      // judged the credential. Keep the token and the stored file, and surface
      // the failure: an outage must not cost a master password and a code.
      throw error
    }
  }

  async ensureToken(signal) {
    // A restart leaves no in-memory token; recover the stored one before
    // deciding a fresh (possibly two-factor) login is needed.
    if (!this.token) this.restoreSession()
    if (this.token && this.token.expiresAt - 60_000 > this.now()) {
      this.touchSession()
      return this.token
    }
    // While a two-factor challenge is outstanding, background work (poll ticks,
    // tool calls) must not fire more password grants: that would hammer the
    // login endpoint and its rate limiter. Surface the pending challenge
    // instead; an explicit code submission calls login() directly.
    const pending = this.pendingTwoFactor
    if (pending) {
      if (this.now() - (pending.at ?? 0) < TWO_FACTOR_PENDING_TTL_MS) {
        throw new VaultError('两步验证待完成', {
          code: 'two_factor_required',
          hint: '提交验证码后重试',
          providers: pending.providers ?? null,
          providerDescriptions: pending.providerDescriptions ?? null,
        })
      }
      this.pendingTwoFactor = null // stale challenge: allow a fresh login
    }
    if (this.token?.refreshToken) {
      // A *rejected* refresh returns false and falls through to a fresh login;
      // a transient failure throws instead (see `#refresh`), so a network
      // outage never drags a two-factor account to the code prompt.
      const ok = await this.#refresh(signal)
      if (ok) return this.token
      this.#noteSessionEvent('refresh_rejected', '刷新令牌已被服务端拒绝，需要重新登录')
    }
    // Only a full password grant is left. That is fine once — it is how a
    // restart or a revoked refresh token recovers — but it must not become a
    // silent retry loop: a dead session plus a background poll tick would
    // otherwise hammer the login endpoint and its rate limiter every cycle.
    // One attempt, then a cooldown and an explicit error naming the cause.
    const at = this.now()
    if (at < this.#loginRetryAt) {
      const wait = Math.max(1, Math.ceil((this.#loginRetryAt - at) / 1000))
      throw new VaultError('会话已失效，需要重新登录', {
        code: 'session_expired',
        hint: `上一次重新登录失败（${this.lastSessionEvent?.message ?? '原因未知'}），${wait} 秒内不再重试；请在 DSH 设置 → 插件 → bitwarden 检查凭据，或稍后重试`,
      })
    }
    try {
      const token = await this.login(signal)
      this.#loginRetryAt = 0
      this.#noteSessionEvent('relogin', '会话已重新登录')
      return token
    } catch (error) {
      // A two-factor challenge is an explicit state of its own (recorded as
      // `pendingTwoFactor`, surfaced as `two_factor_required`), so it must
      // neither be branded a failure nor be throttled.
      if (error?.code === 'two_factor_required') {
        this.#noteSessionEvent('two_factor_required', '需要两步验证码，等待用户提交')
      } else if (error?.code === 'login_superseded') {
        // A deliberate sign-out cancelled this attempt while it was in flight.
        // That is not a failed credential, so it must not arm the cooldown: the
        // sign-out had just cleared it, and re-arming here would make the very
        // next sign-in fail with `session_expired` for a minute.
        this.#noteSessionEvent('login_superseded', '登录被登出操作取消')
      } else {
        this.#loginRetryAt = this.now() + LOGIN_RETRY_COOLDOWN_MS
        this.#noteSessionEvent('login_failed', error?.message ?? String(error))
      }
      throw error
    }
  }

  /** Record the last session event so `status()` can explain a lost session. */
  #noteSessionEvent(kind, message) {
    this.lastSessionEvent = { at: this.now(), kind, message }
  }

  // ── two-factor continuation ────────────────────────────────────────────────

  /**
   * Complete a login the server answered with `two_factor_required`.
   * Keeps the master key derived during the first attempt, so a code retry
   * costs one token request instead of a second KDF derivation.
   *
   * @param {{code: string, provider?: number, remember?: boolean}} twoFactor
   * @returns the token record (same shape as {@link login})
   */
  /**
   * Complete a login the server answered with `two_factor_required`.
   *
   * The server issues no continuation token: this re-runs the password grant
   * (same KDF, same credentials) with the user's code in `two_factor_token`.
   * So a failed attempt is fully recoverable — just call again with a fresh
   * code, and the caller may keep the same screen open.
   *
   * @param {{code: string, provider?: number, remember?: boolean}} twoFactor
   * @returns the token record (same shape as {@link login})
   */
  async loginWithTwoFactor(twoFactor, signal) {
    const code = String(twoFactor?.code ?? '').trim()
    if (!code) fail('需要两步验证码', 'bad_request', '传入 twoFactor.code（6 位动态码或恢复码）')
    const pending = this.pendingTwoFactor
    const token = await this.login(signal, {
      provider: twoFactor?.provider ?? pending?.provider ?? 0,
      remember: twoFactor?.remember !== false,
      code,
    })
    this.pendingTwoFactor = null
    return token
  }

  /** Whether a login attempt is waiting for a two-factor code. */
  get twoFactorPending() {
    return this.pendingTwoFactor ?? null
  }

  /**
   * Decrypt the user key, then unlock the vault (kept in memory for
   * `cacheMinutes`).
   *
   * Three sources, cheapest first:
   *   1. a vault the current login already fetched (`pendingSync`);
   *   2. the on-disk cache — decrypted immediately, with a background
   *      revision probe deciding whether it needs replacing;
   *   3. a full `/api/sync` download.
   * The revision date is read *before* the download so the recorded revision
   * can never be newer than the payload it vouches for.
   */
  async unlock(signal) {
    if (!this.configured) this.#notConfigured()
    const ttlMs = Math.max(0, Number(this.settings.cacheMinutes ?? 30)) * 60_000
    // Absolute age, for the same reason the disk cache uses it: a vault stamped
    // in the future (the clock was moved back after it was installed) produced
    // a negative age, and a negative age is less than every ttl — so that vault
    // was served from memory for ever, never re-checked against the server. A
    // clock correction of a few seconds still counts as fresh; a jump larger
    // than the ttl re-reads, which is the safe direction.
    if (this.vault && Math.abs(this.now() - this.vault.at) < ttlMs) return this.vault
    // Single flight: concurrent readers share one attempt. The panel opens by
    // firing four reads at once (list / status / overview / folders), and a
    // cold start would otherwise download and decrypt the vault once per
    // reader — measured at 4 downloads and 4.7 s, against 1 download and
    // 0.9 s for the same four reads run one after another. The caller signal
    // is deliberately NOT handed to the shared attempt: it belongs to one
    // caller, and letting the first caller's abort cancel the vault everyone
    // else is waiting on would turn a closed panel into a failed read.
    if (this.#unlockFlight) return this.#unlockFlight
    const flight = this.#unlock(signal).finally(() => {
      // Only clear our own attempt: a newer one may already have replaced it.
      if (this.#unlockFlight === flight) this.#unlockFlight = null
    })
    this.#unlockFlight = flight
    return flight
  }

  /**
   * One unlock attempt, shared by every concurrent caller (see unlock).
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async #unlock(signal) {
    // Recorded before the first await: everything below may straddle a
    // sign-out, and the result must be discarded if it did.
    const generation = this.#sessionGeneration
    const { token, userKey } = await this.#userKey(signal)
    if (token.pendingSync) {
      const sync = token.pendingSync
      token.pendingSync = undefined
      // Fetched by the login itself, so it is fresh — but its revision is
      // unknown, and a cache written without one simply syncs next time.
      return this.#adopt(sync, userKey, null, generation)
    }
    const cached = this.#restoreCache(userKey)
    if (cached) return cached
    // The revision probe and the download are independent reads, and the
    // download is the slow half (3.4 s against a 13-byte probe). Run in
    // sequence they pay both in full; together the probe rides along inside
    // the download it was already waiting for. The revision is still read
    // before the payload is recorded, so it can never be newer than what it
    // vouches for — `#revisionOf` never rejects, it reports `null` for a probe
    // that failed, and a null revision simply syncs again next time.
    const [revision, sync] = await Promise.all([
      this.#revisionOf(token, signal),
      fetchSync(this.fetch, this.server, token.accessToken, signal),
    ])
    return this.#adopt(sync, userKey, revision, generation)
  }

  /**
   * Serve the on-disk cache, then revalidate it in the background.
   * @returns {object|null} the decrypted vault, or null when the cache is
   *   absent, disabled, damaged, or belongs to another account.
   */
  #restoreCache(userKey) {
    const store = this.cacheStore
    if (!store || store.disabled || typeof store.load !== 'function') return null
    const record = store.load({ serverUrl: this.server, email: String(this.settings.email ?? '').trim() })
    // The payload must at least look like a sync response; anything else is
    // treated as damage and replaced by the full sync that follows.
    if (!record || !Array.isArray(record.payload?.ciphers)) {
      if (record) store.clear()
      return null
    }
    let vault
    try {
      vault = decryptVault(record.payload, userKey)
    } catch {
      store.clear()
      return null
    }
    this.#cacheRecord = record
    this.vault = { ...vault, at: this.now(), cached: true, cachedAt: record.savedAt ?? this.now() }
    this.#listCache = null
    this.#revalidate(record, this.token)
    return this.vault
  }

  /**
   * Background freshness check after a cached unlock. One revision probe
   * decides everything: equal to the recorded revision and inside the trust
   * window → the cache stands and nothing is downloaded; anything else
   * (changed, probe failed, revision unknown, or an aged record) → a full sync.
   *
   * Best effort by design: the caller already has a working vault on screen,
   * so failures are swallowed and the next open retries.
   */
  async #revalidate(record, token) {
    if (this.#revalidating) return
    this.#revalidating = true
    try {
      const store = this.cacheStore
      if (!store || store.disabled || !token) return
      let revision = null
      try {
        revision = await fetchRevision(this.fetch, this.server, token.accessToken, undefined)
      } catch {
        revision = null
      }
      // A sign-out or a new login in the meantime must not be resurrected by
      // this check, and a vault that vanished has nothing to refresh.
      if (this.token !== token || !this.vault) return
      const fresh =
        revision !== null &&
        record.revision !== null &&
        record.revision !== undefined &&
        revision === record.revision &&
        (typeof store.trusted !== 'function' || store.trusted(record))
      if (fresh) return
      await this.syncNow()
    } catch {
      /* the cached vault is already on screen */
    } finally {
      this.#revalidating = false
    }
  }

  /**
   * The account revision date, or null when it is unavailable. Null makes the
   * next full sync record `revision: null`, which disables the probe-based
   * fast path until a sync can record a real revision — never "unchanged".
   */
  async #revisionOf(token, signal) {
    const store = this.cacheStore
    if (!store || store.disabled) return null
    try {
      return await fetchRevision(this.fetch, this.server, token.accessToken, signal)
    } catch {
      return null
    }
  }

  /**
   * Replace the in-memory vault from a sync payload and refresh the cache.
   *
   * `generation` is the value the attempt started under (see
   * {@link #sessionGeneration}): when it no longer matches, the session was
   * dropped while this download was in flight, so the payload is returned to
   * the caller that asked for it but is NOT installed and NOT written to the
   * cache. Without that check a sign-out during a slow cold start was undone
   * by the very download it was cancelling — and on a shared machine that is
   * one account's vault appearing after another account signed in.
   */
  #adopt(sync, userKey, revision, generation = this.#sessionGeneration) {
    const vault = { ...decryptVault(sync, userKey), at: this.now() }
    if (generation !== this.#sessionGeneration) return vault
    this.vault = vault
    this.#listCache = null
    this.#cacheRecord = this.#saveCache(sync, revision)
    return vault
  }

  /** Persist a sync payload (still ciphertext) for the next cold start. */
  #saveCache(sync, revision) {
    const store = this.cacheStore
    if (!store || typeof store.save !== 'function') return null
    const record = {
      serverUrl: this.server,
      email: String(this.settings.email ?? '').trim(),
      savedAt: this.now(),
      revision: revision ?? null,
      payload: sync,
    }
    return store.save(record) ? record : null
  }

  /**
   * Token + the account's decrypted user key, cached on the token so sync,
   * search and cipher write-back share one derivation. Dropped by
   * `invalidate()` (re-login, LogOut, reconfigure).
   */
  async #userKey(signal) {
    const token = await this.ensureToken(signal)
    if (token.userKey) return { token, userKey: token.userKey }
    const masterKey = token.masterKey
    if (!masterKey) fail('会话缺少主密钥，请重新登录', 'session_expired')
    const masterStretch = stretchKey(masterKey)
    const blob = token.encryptedKey ?? token.pendingSync?.profile?.key
    if (!blob) fail('服务端未返回用户密钥（profile.key），无法解密保险库', 'bad_token_response')
    const userKey = stretchKey(decryptEncString(blob, masterStretch.enc, masterStretch.mac))
    token.userKey = userKey
    return { token, userKey }
  }

  /** Public form of `#userKey` for cipher write-back (see lib/mutations.js). */
  async unlockKeys(signal) {
    if (!this.configured) this.#notConfigured()
    return this.#userKey(signal)
  }

  /**
   * True while a master-password proof is still in force (see
   * `authorizeReprompt`). `projectItem` consults nothing else: a tool call
   * cannot talk its way past the gate, and neither can a stale UI click that
   * arrived after the window closed.
   */
  get repromptGranted() {
    return Boolean(this.#repromptGrant && this.#repromptGrant.until > this.now())
  }

  /**
   * Whether the current proof covers THIS read.
   *
   * The grant is scoped, not global. `authorizeReprompt` verifies a password
   * for one entry (the one the user was looking at), and the first version
   * recorded nothing but an expiry — so one successful check made every
   * reprompt-gated entry in the account readable for the whole window,
   * including ones the user never opened. A window is fine; a window over the
   * entire vault is not what "ask me again before showing this secret" means.
   *
   * Called with no id (the panel's countdown) it answers "is any proof in
   * force", which is what the badge renders. Called with an id it answers for
   * that entry only.
   *
   * @param {string} [itemId] the entry being read
   * @param {string} [field] the field being read, when the grant named one
   */
  repromptGrantedFor(itemId, field) {
    const grant = this.#repromptGrant
    if (!grant || grant.until <= this.now()) return false
    if (itemId === undefined || itemId === null) return true
    if (grant.itemId !== null && grant.itemId !== String(itemId)) return false
    if (field !== undefined && Array.isArray(grant.fields) && grant.fields.length > 0 && !grant.fields.includes(String(field))) return false
    return true
  }

  /** Minutes the current proof still has left, for the panel countdown. */
  get repromptGrantRemainingMs() {
    if (!this.#repromptGrant) return 0
    return Math.max(0, this.#repromptGrant.until - this.now())
  }

  /**
   * Verify a master password typed by the user and, if it is the right one,
   * open a short-lived window in which reprompt-gated entries can be read.
   *
   * Why this exists at all: Bitwarden's `reprompt` flag means "ask the human
   * again before showing this secret". The previous implementation let a
   * caller satisfy that with `confirm: true` — a value the model itself could
   * simply pass, which is the cheapest possible way around the flag and no
   * protection at all. Only the panel can call this, because only the panel has
   * the human's keystrokes.
   *
   * The password is compared against the master key of the *live session*
   * (`token.masterKey`, already held in memory and already on disk in the
   * session file the plugin needs to function), so a correct password is
   * recognised without a server round trip and a wrong one cannot be used to
   * distinguish accounts. Nothing is written anywhere: the grant is an expiry
   * timestamp in a private field, dropped by `invalidate()` with the session.
   *
   * The proof is scoped to the entry the user was looking at: `scope.id` is
   * recorded with the grant, so unlocking one entry does not open every other
   * reprompt-gated entry in the account for the rest of the window (see
   * `repromptGrantedFor`). Called without a scope — as the tests and any
   * direct caller may — the grant stays account-wide, which is what the
   * original semantics were.
   *
   * Failed attempts back off. A wrong password costs a full KDF run (PBKDF2 at
   * the account's iteration count, or Argon2id), so an unthrottled check is
   * both an oracle and a way to make the host burn CPU and memory: the caller
   * that can reach this method is already authenticated to the plugin, but
   * "already inside" is not the same as "allowed to guess for free".
   *
   * @param {string} password master password typed by the user
   * @param {AbortSignal} [signal]
   * @param {{id?: string|null, fields?: string[]|null}} [scope] what the proof covers
   * @returns {Promise<{authorized: boolean, until?: number, remainingMs?: number, grantMinutes?: number, message?: string, retryAfterMs?: number}>}
   */
  async authorizeReprompt(password, signal, scope = {}) {
    if (!this.configured) this.#notConfigured()
    // Resolve the named target to the entry's own id before anything else.
    // The caller naturally has a ref (an id, or the title the user clicked),

    // but the grant is keyed on `item.id`, so comparing against the raw ref

    // would leave a name-addressed unlock permanently closed. Resolving here

    // also keeps a bad ref from costing a KDF run.

    let scopedId = null
    const rawRef = scope?.id === undefined || scope?.id === null ? '' : String(scope.id).trim()
    if (rawRef) {
      if (!this.vault) {
        return { authorized: false, message: '密钥库尚未加载，请稍后再试', hint: '等面板完成一次加载后再验证主密码。' }
      }
      try {
        scopedId = resolveItem(this.vault, rawRef).id
      } catch (error) {
        return { authorized: false, message: error?.message ?? String(error), hint: error?.hint ?? undefined }
      }
    }
    const typed = String(password ?? '')
    // No password, no work: an empty submission must not cost a PBKDF2 run.
    if (!typed) {
      return { authorized: false, message: '请输入主密码' }
    }
    // A live session already holds the master key; if there is none there is
    // nothing to compare against and asking for a password would be theatre.
    const token = this.token ?? null
    const masterKey = token?.masterKey
    if (!masterKey) {
      return {
        authorized: false,
        message: '当前没有活跃会话，无法验证主密码',
        hint: '请先让密钥库完成登录（或重新连接），登录后再验证。',
      }
    }
    // Checked BEFORE the derivation below, so a caller in the penalty box gets
    // an answer instead of a KDF run: that is the whole point of the lockout.
    const lockedForMs = this.#repromptLockUntil - this.now()
    if (lockedForMs > 0) {
      const seconds = Math.ceil(lockedForMs / 1000)
      return {
        authorized: false,
        message: `主密码验证失败次数过多，请 ${seconds} 秒后再试`,
        retryAfterMs: lockedForMs,
      }
    }
    const server = this.server
    const email = String(this.settings.email).trim()
    // Derive with the account's own KDF parameters. Asking the server would
    // also work but turns a local check into a network call the gate must
    // survive being offline, so the prelogin answer is cached on the token when
    // login already supplied it and only fetched when it did not.
    const kdf = token.kdf ?? null
    const iterations = token.kdfIterations ?? null
    const pre = kdf !== null && iterations !== null ? { kdf, kdfIterations: iterations, kdfMemory: token.kdfMemory ?? null, kdfParallelism: token.kdfParallelism ?? null } : await prelogin(this.fetch, server, email, signal)
    let candidate
    try {
      candidate = await deriveMasterKey(typed, email, pre.kdf, pre.kdfIterations, {
        memory: pre.kdfMemory,
        parallelism: pre.kdfParallelism,
      })
    } catch (error) {
      // An unsupported KDF is a real answer, not a wrong password: say so.
      return { authorized: false, message: error?.message ?? String(error), hint: error?.hint ?? undefined }
    }
    if (candidate.length !== masterKey.length || !timingSafeEqual(candidate, masterKey)) {
      // Deliberately identical to a right answer that simply has nothing to
      // unlock, so the reply says nothing about which accounts exist here.
      this.#repromptAttempts += 1
      // Free attempts, then an exponential penalty that tops out at a minute.
      // Small enough that a person who mistyped twice never notices; large
      // enough that guessing at KDF speed stops being an option.
      if (this.#repromptAttempts >= REPROMPT_FREE_ATTEMPTS) {
        const over = this.#repromptAttempts - REPROMPT_FREE_ATTEMPTS
        const delay = Math.min(REPROMPT_LOCK_MAX_MS, REPROMPT_LOCK_BASE_MS * 2 ** Math.min(over, 16))
        this.#repromptLockUntil = this.now() + delay
      }
      return { authorized: false, message: '主密码不对' }
    }
    this.#repromptAttempts = 0
    this.#repromptLockUntil = 0
    const minutes = Math.max(1, Number(this.settings.repromptGrantMinutes ?? DEFAULT_REPROMPT_GRANT_MINUTES) || DEFAULT_REPROMPT_GRANT_MINUTES)
    const until = this.now() + minutes * 60_000
    // `itemId: null` keeps the account-wide semantics for a caller that named
    // no target; a named target narrows the proof to that entry.
    const itemId = scopedId
    const fields = Array.isArray(scope?.fields) && scope.fields.length ? scope.fields.map(String) : null
    this.#repromptGrant = { until, itemId, fields }
    return { authorized: true, until, remainingMs: minutes * 60_000, grantMinutes: minutes }
  }

  // ── live sync ──────────────────────────────────────────────────────────────

  /**
   * Start keeping the vault fresh: WebSocket notifications with a polling
   * fallback. Returns the LiveSync controller (also available as
   * `client.live`); call `stopLiveSync()` to tear it down.
   */
  startLiveSync(options = {}) {
    this.stopLiveSync()
    this.live = new LiveSync(this, options)
    this.live.start()
    return this.live
  }

  stopLiveSync() {
    if (!this.live) return
    this.live.stop()
    this.live = null
  }

  /**
   * Ask for a full sync in the background, coalescing rapid calls into one.
   *
   * The write path uses this instead of awaiting `syncNow()`: the local
   * re-projection (`applyCipher`) has already made the vault correct for this
   * client, and the full download is only there to fold in anything the server
   * knows that this client does not. Waiting for it is what made "save" take
   * 6-32 seconds; not waiting costs one stale row on another device until the
   * sync lands, which is the trade the reader actually asked for.
   *
   * Failures are reported through `log` and otherwise swallowed: the write
   * already succeeded, and a background refresh that throws must not become an
   * unhandled rejection. The next read, poll tick or hub signal retries it.
   */
  syncSoon(delayMs = 1500) {
    if (this.#syncSoonTimer) return false
    const timer = setTimeout(() => {
      this.#syncSoonTimer = null
      this.syncNow()
        .then(() => {
          if (this.live) this.live.lastSyncAt = this.now()
        })
        .catch((error) => {
          this.log(`vault: 后台同步失败（${error?.message ?? error}），下次读取会重试`)
        })
    }, Math.max(0, Number(delayMs) || 0))
    // The panel and the tests both need to be able to exit while one is
    // pending; nothing is lost, because the next read syncs anyway.
    timer.unref?.()
    this.#syncSoonTimer = timer
    return true
  }

  /** Cancel a pending background sync (used by invalidate()). */
  #cancelSyncSoon() {
    if (!this.#syncSoonTimer) return
    clearTimeout(this.#syncSoonTimer)
    this.#syncSoonTimer = null
  }

  /**
   * Install a freshly written cipher into the live vault WITHOUT downloading
   * the whole vault again.
   *
   * Why this exists: every mutation used to end in a full `syncNow()` — a
   * download of the entire account (measured 691 KB / 3.4 s on a 426-entry
   * vault, and 8-16 s through a slow link). The write itself is a few hundred
   * milliseconds, so the sync dominated the save and the panel blocked on it
   * before it could even say "saved".
   *
   * The server already hands back the cipher it stored, so the only things
   * missing from a local re-projection are the folder/collection id→name maps,
   * which the current vault already holds. Everything else — the item key, the
   * plaintext, the revision — is recomputed from that returned object, so the
   * projection is identical to what the next sync would produce.
   *
   * A refusal (a cipher this session cannot decrypt) is reported, not thrown:
   * the caller has already written to the server, and the old vault is still a
   * truthful - if stale - picture of it. `syncNow()` remains the fallback.
   *
   * @param {object} cipher the cipher object the server returned
   * @returns {{applied: boolean, reason?: string}}
   */
  applyCipher(cipher, userKey) {
    const vault = this.vault
    if (!vault || !cipher?.id) return { applied: false, reason: 'no_vault' }
    if (!userKey) return { applied: false, reason: 'no_key' }
    let item
    try {
      item = decryptCipher(
        cipher,
        userKey,
        vault.orgKeys ?? new Map(),
        vault.folderNames ?? new Map(),
        vault.collectionNames ?? new Map(),
      )
    } catch (error) {
      // Splicing a half-decrypted row into the list would be worse than a
      // stale one, so the vault is left exactly as it was.
      this.log(`vault: 本条目写入成功，但本地重投影失败（${error?.message ?? error}），下次同步会修正`)
      return { applied: false, reason: 'undecryptable' }
    }
    const trashed = Boolean(item.deletedDate)
    const items = Array.isArray(vault.items) ? vault.items : []
    const trash = Array.isArray(vault.trashed) ? vault.trashed : []
    const keep = (list) => list.filter((entry) => entry.id !== item.id)
    // A soft-deleted row belongs in the trash half and out of the live list,
    // exactly as decryptVault splits them.
    const nextItems = trashed ? keep(items) : [...keep(items), item]
    const nextTrash = trashed ? [...keep(trash), item] : keep(trash)
    // The live rows keep the order the previous sync produced; a brand-new
    // entry goes last, which is where the next sync will put it too (the
    // server sorts by name). `at` is left alone on purpose: it marks when
    // this vault arrived from the network, not when it was patched.
    vault.items = nextItems
    vault.trashed = nextTrash
    vault.byId = new Map([...nextItems, ...nextTrash].map((entry) => [entry.id, entry]))
    vault.raw = new Map(vault.raw ?? []).set(item.id, cipher)
    vault.folders = countFolders(nextItems, vault.folderNames ?? new Map())
    this.#listCache = null
    return { applied: true }
  }

  /**
   * Drop one cipher from the live vault and the cached payload.
   *
   * Used by a permanent delete, where the server answers with an empty body:
   * there is no returned cipher to re-project, only an id that must disappear.
   */
  forgetCipher(id) {
    const vault = this.vault
    const key = String(id ?? '')
    if (!vault || !key) return false
    const keep = (list) => (Array.isArray(list) ? list.filter((entry) => entry.id !== key) : [])
    vault.items = keep(vault.items)
    vault.trashed = keep(vault.trashed)
    vault.byId = new Map([...vault.items, ...vault.trashed].map((entry) => [entry.id, entry]))
    vault.raw = new Map([...new Map(vault.raw ?? [])].filter(([cipherId]) => cipherId !== key))
    vault.folders = countFolders(vault.items, vault.folderNames ?? new Map())
    this.#listCache = null
    const record = this.#cacheRecord
    const store = this.cacheStore
    if (record && store && Array.isArray(record.payload?.ciphers)) {
      record.payload = { ...record.payload, ciphers: record.payload.ciphers.filter((entry) => entry?.id !== key) }
      record.savedAt = this.now()
      store.save(record)
    }
    return true
  }

  /**
   * Patch the ciphertext payload of the on-disk cache with one cipher, so a
   * restart right after a write does not resurrect the pre-write value.
   *
   * Best effort by design: the cache is a performance device, and failing to
   * update it costs one stale row until the next sync — never the write.
   */
  patchCachedCipher(cipher) {
    const store = this.cacheStore
    const record = this.#cacheRecord
    if (!store || !record || !cipher?.id || !Array.isArray(record.payload?.ciphers)) return false
    const next = record.payload.ciphers.map((entry) => (entry?.id === cipher.id ? cipher : entry))
    if (!record.payload.ciphers.some((entry) => entry?.id === cipher.id)) {
      // The cipher is new, or the cached payload predates this session's view
      // of it: a full sync will fold it in, and this patch cannot.
      if (!this.vault?.raw?.has?.(cipher.id)) return false
      next.push(cipher)
    }
    record.payload = { ...record.payload, ciphers: next }
    record.savedAt = this.now()
    return Boolean(store.save(record))
  }

  /** Force a full sync + decrypt now, replacing the cached vault. */
  async syncNow(signal) {
    if (!this.configured) this.#notConfigured()
    const { token, userKey } = await this.#userKey(signal)
    // Revision first: it must describe a state at or before the payload.
    const revision = await this.#revisionOf(token, signal)
    const sync = await fetchSync(this.fetch, this.server, token.accessToken, signal)
    const vault = this.#adopt(sync, userKey, revision)
    if (this.live) this.live.lastSyncAt = this.now()
    return vault
  }

  /**
   * Search metadata only — never returns passwords.
   * Archived entries are hidden unless `includeArchived`; soft-deleted ones
   * (trash) unless `includeTrashed` — each flag is reported in the payload
   * either way, so "nothing found" never hides that the item still exists.
   */
  async find(query, limit = 8, signal, options = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 8, 25))
    return JSON.stringify(
      searchPayload(await this.unlock(signal), query, max, {
        includeArchived: Boolean(options.includeArchived),
        includeTrashed: Boolean(options.includeTrashed),
      }),
      null,
      2,
    )
  }

  /**
   * The sidebar's counts, in one read.
   *
   * Every number here is what the matching `section` read will report as
   * `matched`, because both run the same pool through the same filter — so a
   * badge and the list behind it can never disagree. The panel draws its whole
   * navigation from this call and nothing else, which is what lets a section be
   * a cached place rather than a fresh query each time it is opened.
   */
  async overview(signal) {
    const vault = await this.unlock(signal)
    const now = this.now()
    const live = vault.items.filter((item) => !item.archived)
    const archived = vault.items.length - live.length
    const trashed = vault.trashed?.length ?? 0
    const ciphers = vault.items.length + trashed
    // Counted over the live half only: the sidebar rows all read the same
    // pool the panel lists when it opens them (archived entries have their
    // own row, and they are excluded from every other section read). A
    // badge that counted them would promise rows the list then hides.
    const count = (fn) => live.filter(fn).length
    const types = []
    for (const type of TYPE_ORDER) {
      const total = count((item) => item.type === type)
      if (total) types.push({ id: type, label: typeLabel(type), count: total })
    }
    // A type the panel has no word for still gets a row: an entry with an
    // unknown `type` must not be invisible in the sidebar.
    const known = new Set(TYPE_ORDER)
    for (const item of vault.items) {
      if (known.has(item.type)) continue
      if (item.archived) continue
      known.add(item.type)
      types.push({ id: item.type, label: typeLabel(item.type), count: count((entry) => entry.type === item.type) })
    }
    const folders = vault.folders
      .map((folder) => ({ id: folder.id, name: folder.name, count: count((item) => item.folderId === folder.id) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    let liveTotp = 0
    let liveFavorites = 0
    for (const item of live) {
      if (item.totpSecret) liveTotp += 1
      if (item.favorite) liveFavorites += 1
    }
    // The newest cipher of each half: the section headers say when the place was
    // last touched, which is the one thing a new entry changes.
    let latestAt = null
    for (const item of vault.items) {
      const at = revisionAt(item.revisionDate)
      if (at !== null && (latestAt === null || at > latestAt)) latestAt = at
    }
    let trashLatestAt = null
    for (const item of vault.trashed ?? []) {
      const at = revisionAt(item.revisionDate ?? item.deletedDate)
      if (at !== null && (trashLatestAt === null || at > trashLatestAt)) trashLatestAt = at
    }
    return {
      identity: this.identity,
      ciphers,
      items: live.length,
      liveItems: live.length,
      archived,
      trashed,
      folders: folders.length,
      folderCount: vault.folderCount ?? folders.length,
      unfiled: count((item) => !item.folderId),
      sections: [
        { id: 'all', label: '全部条目', count: live.length },
        { id: 'favorites', label: '收藏', count: liveFavorites },
        { id: 'totp', label: '验证码', count: liveTotp },
        { id: 'archive', label: '归档', count: archived },
        { id: 'trash', label: '回收站', count: trashed },
      ],
      types,
      folderList: folders,
      latestAt: latestAt === null ? null : new Date(latestAt).toISOString(),
      trashLatestAt: trashLatestAt === null ? null : new Date(trashLatestAt).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }
  }

  /**
   * Object form of the search for the HTTP API / UI: a UI-sized limit and an
   * empty query that lists the whole vault.
   *
   * `offset` slices the result for paged reads; `signal` is optional and last
   * (it used to sit in the third position, which paging now needs).
   *
   * `includeArchived` is off by default — the same rule the model-facing tools
   * follow — and the settings panel turns it on, because a human scrolling the
   * vault should still find a retired entry (and see that it is archived).
   * `includeTrashed` adds the soft-deleted rows for the panel's trash view.
   */
  async findEntries(query = '', limit = 100, offset = 0, signal, options = {}) {
    const max = Math.max(1, Math.min(Number(limit) || 100, 200))
    const start = Math.max(0, Number(offset) || 0)
    const withArchived = Boolean(options.includeArchived)
    const withTrashed = Boolean(options.includeTrashed)
    // The section travels with the read for the same reason the flags do: the
    // sidebar reads one place at a time, and a memo entry shared between two
    // places would hand one of them the other's rows.
    const section = SECTION_KINDS.has(options.section) ? options.section : 'all'
    const sectionValue = options.sectionValue === undefined || options.sectionValue === null ? '' : String(options.sectionValue)
    // The flags belong in the key: the panel and the model read the same query
    // with different flags, and a shared memo entry would hand one of them the
    // other's rows.
    const key = `${query}\u0000${max}\u0000${start}\u0000${withArchived ? 1 : 0}\u0000${withTrashed ? 1 : 0}\u0000${section}\u0000${sectionValue}`
    // Reuse the previous payload for an identical query: rebuilding it walks
    // and scores every entry, which is wasted work when the user simply
    // reopened the panel. Dropped whenever the vault is replaced (see above).
    // One slot is enough because the panel asks for one section at a time; the
    // panel's own cache is what makes hopping between sections free.
    if (this.#listCache && this.#listCache.key === key) return this.#listCache.payload
    const payload = searchPayload(await this.unlock(signal), query, max, { allowEmpty: true, offset: start, includeArchived: withArchived, includeTrashed: withTrashed, section, sectionValue: sectionValue || null })
    this.#listCache = { key, payload }
    return payload
  }

  /** Object form of `get()` for the HTTP API / UI. */
  async revealEntry(ref, field = 'all', signal, options = {}) {
    return JSON.parse(await this.get(ref, field, signal, options))
  }

  /**
   * Folder id → name → live item count. The ids are what `create`/`update`
   * accept as `folderId`; a name alone cannot be written back.
   */
  async folderList(signal) {
    const vault = await this.unlock(signal)
    const unfiled = vault.items.filter((item) => !item.folderId).length
    return JSON.stringify(
      {
        folders: vault.folders,
        total: vault.folders.length,
        unfiled,
        hint: 'folderId 可直接用于 bitwarden_create / bitwarden_update；传 null 表示移出文件夹',
      },
      null,
      2,
    )
  }

  /**
   * One entry's current TOTP code, with the countdown the UI renders.
   *
   * The reprompt gate covers this read like every other one. It used to be the
   * single hole in it: `get()` and `draftEntry()` both consulted the grant,
   * while this method generated a code straight from the seed — so an entry the
   * operator had flagged "re-verify" handed out live second factors to anyone
   * at the screen (the panel polls it for every row of 验证码 section). A code
   * is 30 s of a real credential, i.e. exactly what the gate exists to
   * withhold.
   */
  async totpEntry(ref, signal) {
    const vault = await this.unlock(signal)
    const item = resolveItem(vault, ref)
    if (item.deletedDate) {
      // Same rule as `get`: a trashed item's seed is not current state.
      // The panel's totp section never lists trashed rows, so nothing on
      // screen regresses — a hand-built RPC call is what this refuses.
      return { id: item.id, name: item.name, trashed: true, totp: null }
    }
    // Scoped to this entry: a proof opened for one entry must not hand out the
    // live second factor of every other gated entry in the account.
    if (item.reprompt === 1 && !this.repromptGrantedFor(item.id, 'totp')) {
      return { id: item.id, name: item.name, repromptRequired: true, totp: null }
    }
    if (!item.totpSecret) return { id: item.id, name: item.name, totp: null }
    try {
      const totp = generateTotp(item.totpSecret, this.now())
      return { id: item.id, name: item.name, totp: { ...totp, secondsRemaining: totp.remaining } }
    } catch (error) {
      return { id: item.id, name: item.name, totp: { error: `TOTP 生成失败：${error.message}` } }
    }
  }

  /**
   * The editable plaintext of one entry, for the panel's editor.
   *
   * `get()` splits a reveal across narrow fields on purpose: a caller that
   * only wanted the username must not be handed the card number. The editor
   * needs the whole record to fill a form, and asking for each field one RPC
   * at a time would mean a round trip per control — so this method assembles
   * the plaintext once.
   *
   * It is still a read, so the same gates apply: a trashed entry needs
   * `includeTrashed`, and a `reprompt` entry stays locked until
   * `authorizeReprompt` opens its window. The TOTP *seed* is deliberately
   * not part of the answer: the panel computes codes through `totp()` and
   * never holds the secret, so an edit that does not touch the seed cannot
   * disturb it, and one that does goes through the explicit form field.
   */
  async draftEntry(ref, signal, options = {}) {
    const vault = await this.unlock(signal)
    const item = resolveItem(vault, ref)
    if (item.deletedDate && !options.includeTrashed) {
      fail('该条目在回收站中（已软删除）', 'trashed', '编辑请先恢复；读取请传 includeTrashed: true')
    }
    if (item.reprompt === 1 && !this.repromptGrantedFor(item.id)) {
      return { id: item.id, name: item.name, type: item.type, repromptRequired: true }
    }
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      username: item.username ?? null,
      password: item.password ?? null,
      hasTotp: Boolean(item.totpSecret),
      uris: item.uris,
      // A secure note's body lives in `notes`, and it is the whole secret —
      // so it is carried here for the editor, exactly as the panel would read
      // it back through `reveal(field=secureNote)`.
      notes: item.notes ?? null,
      fields: item.fields,
      favorite: Boolean(item.favorite),
      reprompt: Number(item.reprompt ?? 0),
      folderId: item.folderId ?? null,
      organizationId: item.organizationId ?? null,
      revisionDate: item.revisionDate ?? null,
      card: item.card ?? null,
      identity: item.identity ?? null,
      sshKey: item.sshKey ?? null,
      secureNote: item.secureNote ?? null,
      attachments: item.attachments ?? [],
      // Password history is deliberately NOT carried: the editor never renders
      // it (it saves through the server's own object, see lib/mutations.js), so
      // sending it would put N previous passwords of the entry on the wire and
      // into the panel's React state for no feature at all. `get()` still
      // reports it in `all` for a caller that asked for the entry's record.
      hasFido2: item.hasFido2 || false,
    }
  }

  /**
   * Wait until the current TOTP window has at least `minRemaining` seconds
   * left, then return the entry read at that instant.
   *
   * A code handed out with one second on the clock is not a code — it is a
   * failure that costs a round trip and, on sites that throttle, an attempt.
   * The caller cannot repair that by hurrying: the seconds it needs are the
   * ones already spent getting from here to the browser. So the wait happens
   * here, before the code exists, and what leaves this method is always good
   * for at least `minRemaining` seconds.
   *
   * Returns the reading together with how long it is valid, so a caller that
   * still misses the window learns that instead of guessing.
   */
  async getFreshTotp(ref, signal, options = {}) {
    // `??` and not `||`: a caller asking for 0 means "do not wait", and `||`
    // would quietly turn that into the default. Only a value that is not a
    // number at all falls back.
    const requested = Number(options.minRemaining)
    const minRemaining = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 0), 59)
      : DEFAULT_TOTP_MIN_REMAINING
    const vault = await this.unlock(signal)
    const item = resolveItem(vault, ref)
    if (item.deletedDate && !options.includeTrashed) {
      fail('该条目在回收站中（已软删除）', 'trashed', '读取请传 includeTrashed: true；恢复请用 bitwarden_restore')
    }
    const gated = projectItem(item, 'totp', this.now(), this.repromptGrantedFor(item.id, 'totp'))
    // A reprompt-gated entry, a missing seed, or a broken seed are all
    // answers, not reasons to wait: only a code that EXISTS and is about to
    // expire is worth sleeping for.
    if (gated.repromptRequired || !gated.totp || gated.totp.error) return gated
    let totp = gated.totp
    if (minRemaining > 0 && totp.remaining < minRemaining) {
      // Sleep to just past the boundary, computed exactly. `remaining` is a
      // whole number of seconds rounded up, so waiting `(remaining + 1) *
      // 1000` overshot by up to a full second — tolerable, but this is a
      // caller blocking on a code, and the boundary is arithmetic: the next
      // window starts at the next multiple of `period`.
      const nowMs = this.now()
      const period = Number(totp.period) > 0 ? Number(totp.period) : 30
      const nextBoundary = (Math.floor(nowMs / 1000 / period) + 1) * period * 1000
      // No slack needed: the boundary is itself the first instant of the new
      // window, so evaluating the code there is exactly what the caller wants.
      const waitMs = Math.max(0, nextBoundary - nowMs)
      await this.sleep(waitMs)
      if (signal?.aborted) fail('取码等待被取消', 'bad_request', '等待新的验证码窗口时调用被中止，请重试')
      totp = generateTotp(item.totpSecret, this.now())
    }
    return { ...gated, totp: { ...totp, freshFor: totp.remaining } }
  }

  /** Reveal one item's credential fields. */
  async get(ref, field = 'all', signal, options = {}) {
    const vault = await this.unlock(signal)
    const item = resolveItem(vault, ref)
    // A trashed entry is still readable — but only on purpose: reading one
    // silently would make a deleted credential look current.
    if (item.deletedDate && !options.includeTrashed) {
      fail('该条目在回收站中（已软删除）', 'trashed', '读取请传 includeTrashed: true；恢复请用 bitwarden_restore')
    }
    // `options.confirm` is deliberately ignored. It used to unlock reprompt
    // entries, which made the gate a checkbox the caller could tick for
    // itself — including the model, which is the thing the gate exists to
    // stop. Only the in-memory grant from `authorizeReprompt` opens the door.
    //
    // `field=totp` is the one reading with a shelf life. Asking for one
    // seconds before it expires is the same as asking for none, so this path
    // can wait for a usable window (`waitFresh`) instead of handing back a
    // code the caller cannot reach the form in time to use.
    if (field === 'totp' && options.waitFresh) {
      return JSON.stringify(await this.getFreshTotp(ref, signal, { includeTrashed: options.includeTrashed, minRemaining: options.minRemaining }), null, 2)
    }
    if (field === 'totp') {
      // Even unwaited, the caller deserves to know how long it has. The number
      // was already in the payload; naming it is what stops "is this still
      // good?" from being a guess.
      const projected = projectItem(item, field, this.now(), this.repromptGrantedFor(item.id, field))
      if (projected.totp && !projected.totp.error) {
        return JSON.stringify({ ...projected, totp: { ...projected.totp, freshFor: projected.totp.remaining } }, null, 2)
      }
      return JSON.stringify(projected, null, 2)
    }
    // `maskHiddenFields` is the MODEL-facing boundary, not a display rule:
    // the host's own panel (revealEntry) is the account owner reading their
    // own vault, so it keeps the values it then renders masked behind a
    // click. A tool call is a different principal and does not get them for
    // free — see the `all` projection in projectItem.
    return JSON.stringify(
      projectItem(item, field, this.now(), this.repromptGrantedFor(item.id, field), { maskHiddenFields: Boolean(options.maskHiddenFields) }),
      null,
      2,
    )
  }

  /** Configuration / connectivity / unlock report. */
  async status({ refresh = false, signal } = {}) {
    const report = {
      configured: this.configured,
      authMode: this.authMode,
      serverUrl: this.settings.serverUrl || null,
      email: this.settings.email || null,
      cacheMinutes: this.settings.cacheMinutes ?? 30,
      liveSync: this.live ? this.live.report() : { mode: 'off' },
      // Present only when a stored session was thrown away; answers "why does
      // it want my password again" without reading the file system.
      lastSessionLoss: this.lastSessionLoss,
      lastSessionEvent: this.lastSessionEvent,
    }
    if (!this.configured) {
      report.missing = this.missing
      report.hint = '请用户在 DSH 设置 → 插件 → bitwarden 里补全这些字段（保存后立即生效）'
    }
    if (refresh) this.invalidate({ keepStored: true })
    // Reuse a recent probe: this is a network round trip whose answer
    // (reachability + version) barely ever changes, and the panel pays for it
    // on every single open. A forced `refresh` always re-probes.
    const cached = refresh ? null : this.#serverProbe
    const reuseProbe = Boolean(cached && this.settings.serverUrl && this.now() - cached.at < SERVER_PROBE_TTL_MS)
    if (reuseProbe) {
      report.reachable = cached.reachable
      report.serverVersion = cached.serverVersion
      if (cached.connectError) report.connectError = cached.connectError
    }
    // The probe and the unlock are two round trips to the same server, and the
    // probe is the slow half of a cold open (~1.5 s measured against a vault
    // that comes off the disk cache in ~90 ms). Run in sequence they were the
    // whole reason a cold panel looked like it had hung; run together the wait
    // is the slower of the two, not the sum. The probe still gates what the
    // report CLAIMS: an unreachable server must not be reported as a wrong
    // password, so it is awaited before the unlock's outcome is applied.
    const probePromise =
      this.settings.serverUrl && !reuseProbe
        ? (async () => {
            const probe = { at: this.now(), reachable: false, serverVersion: null, connectError: null }
            try {
              const { ok, json } = await httpJson(this.fetch, `${this.server}/api/config`, { signal: undefined }, 8000)
              probe.reachable = ok
              probe.serverVersion = json?.version ?? null
            } catch (error) {
              probe.connectError = error.message
            }
            this.#serverProbe = probe
            return probe
          })()
        : Promise.resolve(null)
    const unlockPromise = this.configured ? this.unlock(signal) : null
    // The probe can prove the server is gone before the unlock settles. That
    // path never awaits it — mark the rejection observed so a server that is
    // simply unreachable does not also raise an unhandled rejection.
    unlockPromise?.catch(() => {})
    const probe = await probePromise
    if (probe) {
      report.reachable = probe.reachable
      report.serverVersion = probe.serverVersion
      if (probe.connectError) report.connectError = probe.connectError
    }
    if (unlockPromise && report.reachable !== false) {
      try {
        const vault = await unlockPromise
        report.unlocked = true
        report.items = vault.items.length
        report.folders = vault.folderCount
        // Soft-deleted items are invisible in the list by design; without a
        // count here one would look like it never existed.
        report.trashed = vault.trashed?.length ?? 0
        report.archived = vault.items.filter((item) => item.archived).length
        if (vault.skipped) report.skippedItems = vault.skipped
        report.tokenExpiresAt = this.token ? new Date(this.token.expiresAt).toISOString() : null
        // `at` is when the data entered memory; a cached unlock is "now" while
        // the data itself is older, so report when it was fetched.
        report.cached = Boolean(vault.cached)
        report.syncedAt = new Date(vault.cached ? (vault.cachedAt ?? vault.at) : vault.at).toISOString()
        // The absolute file path is not part of the answer. It tells the caller
        // which host directory holds the encrypted vault, and the gateway's own
        // `config` RPC already strips the session path for exactly this reason —
        // a path is a map for anyone reading the payload, and it is not
        // information the caller can act on anyway.
        const described = this.cacheStore ? this.cacheStore.describe(this.#cacheRecord) : { enabled: false, stored: false }
        const { path: _cachePath, ...cache } = described
        report.cache = cache
      } catch (error) {
        report.unlocked = false
        report.error = error.message
        if (error.hint) report.hint = error.hint
      }
    }
    return JSON.stringify(report, null, 2)
  }
}
