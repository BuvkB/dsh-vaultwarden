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
 * Polling is only a fallback for an unreachable hub, so the default interval is
 * deliberately slow and cannot be configured below this floor. Callers that
 * need a faster tick on purpose (the test suite) pass `minPollIntervalMs`.
 */
const MIN_POLL_INTERVAL_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 300_000

const CIPHER_TYPES = { 1: 'login', 2: 'secureNote', 3: 'card', 4: 'identity', 5: 'sshKey' }

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
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let response
  try {
    response = await fetchImpl(url, { method, headers, body, signal: controller.signal })
  } catch (error) {
    const reason = signal?.aborted ? '请求已取消' : `无法连接 ${url}（${error?.message ?? error}）`
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
  const organizations = sync?.profile?.organizations ?? []
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
  const fields = (cipher.fields ?? [])
    .map((field) => ({ name: dec(field?.name), value: dec(field?.value), type: field?.type }))
    .filter((field) => field.name || field.value)
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
    favorite: Boolean(cipher.favorite),
    organizationId: cipher.organizationId ?? null,
    folderId: cipher.folderId ?? null,
    folder: cipher.folderId ? folderNames.get(cipher.folderId) ?? null : null,
    collections: (cipher.collectionIds ?? []).map((id) => collectionNames.get(id)).filter(Boolean),
    revisionDate: cipher.revisionDate ?? null,
    // Bitwarden's password-reprompt flag: clients must not reveal such an
    // item's secrets without an explicit user confirmation.
    reprompt: Number(cipher.reprompt ?? 0),
  }
}

function decryptVault(sync, userKey) {
  const folderNames = new Map()
  for (const folder of sync.folders ?? []) {
    try {
      folderNames.set(folder.id, decryptString(folder.name, userKey) ?? '')
    } catch {
      folderNames.set(folder.id, '(无法解密)')
    }
  }
  const collectionNames = new Map()
  for (const collection of sync.collections ?? []) {
    try {
      collectionNames.set(collection.id, decryptString(collection.name, userKey) ?? '')
    } catch {
      collectionNames.set(collection.id, '(无法解密)')
    }
  }
  const items = []
  const orgKeys = resolveOrgKeys(sync, userKey)
  let skipped = 0
  for (const cipher of sync.ciphers ?? []) {
    // Soft-deleted ciphers stay in the sync payload with a `deletedDate`;
    // official clients exclude them from the vault list (they live in trash).
    if (cipher.deletedDate) continue
    try {
      items.push(decryptCipher(cipher, userKey, orgKeys, folderNames, collectionNames))
    } catch {
      // One undecryptable cipher (e.g. an organization key this account cannot
      // unwrap) must not hide the rest of the vault — but it is reported.
      skipped += 1
    }
  }
  return { items, byId: new Map(items.map((item) => [item.id, item])), folderCount: folderNames.size, skipped }
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
    folder: item.folder ?? undefined,
    collections: item.collections.length ? item.collections : undefined,
    hasTotp: Boolean(item.totpSecret),
    hasNotes: Boolean(item.notes),
    customFields: item.fields.map((field) => field.name).filter(Boolean),
    favorite: item.favorite || undefined,
  }
}

function resolveItem(vault, ref) {
  const needle = String(ref ?? '').trim()
  if (!needle) fail('需要提供条目 id 或名称', 'bad_request')
  const direct = vault.byId.get(needle)
  if (direct) return direct
  const lower = needle.toLowerCase()
  const exact = vault.items.filter((item) => item.name.toLowerCase() === lower)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    fail(`名称 "${needle}" 命中 ${exact.length} 个条目，请用 bitwarden_find 取 id 再查询`, 'ambiguous', '用返回的 id 调用 bitwarden_get')
  }
  const partial = vault.items.filter((item) => matchScore(item, [lower]) > 0)
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    fail(`"${needle}" 匹配到 ${partial.length} 个条目（${partial.slice(0, 5).map((item) => item.name).join('、')}），请用 id 指定`, 'ambiguous', '先调用 bitwarden_find 拿到 id')
  }
  fail(`凭据库中没有匹配 "${needle}" 的条目`, 'not_found', '换关键词调用 bitwarden_find，或请用户确认条目标题')
}

function projectItem(item, field, at, confirm = false) {
  const base = { id: item.id, name: item.name, type: item.type }
  // Bitwarden's reprompt convention: an item flagged `reprompt: 1` must not be
  // auto-revealed. Official clients ask for the master password again; this
  // plugin refuses unless the caller explicitly confirms.
  if (item.reprompt === 1 && !confirm && ['all', 'password', 'totp'].includes(field)) {
    return {
      ...base,
      repromptRequired: true,
      hint: '该条目在 Bitwarden 中启用了「重新验证」（reprompt），自动返回明文不符合官方客户端约定；确认仍要读取请带 confirm: true 调用，或到官方客户端查看。',
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
    case 'fields':
      return { ...base, fields: item.fields }
    case 'all':
    default:
      return {
        ...base,
        username: item.username ?? null,
        password: item.password ?? null,
        totp: withTotp() ?? null,
        uris: item.uris.length ? item.uris : undefined,
        notes: item.notes ? truncate(item.notes) : undefined,
        fields: item.fields.length ? item.fields : undefined,
        card: item.card,
        identity: item.identity,
        folder: item.folder ?? undefined,
        collections: item.collections.length ? item.collections : undefined,
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

/**
 * Build the search payload object, shared by the `bitwarden_find` tool and the
 * HTTP API. Never contains passwords. With `allowEmpty`, an empty query lists
 * every item (score 1) — the UI's initial view; the tool keeps requiring one.
 */
function searchPayload(vault, query, limit, { allowEmpty = false, offset = 0 } = {}) {
  const tokens = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!tokens.length && !allowEmpty) {
    fail('query 不能为空', 'bad_request', '传入名称、用户名或网址关键词')
  }
  const scored = vault.items
    .map((item) => ({ item, score: tokens.length ? matchScore(item, tokens) : 1 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'zh-Hans-CN'))
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
    vaultItems: vault.items.length,
    hint: scored.length ? '用 bitwarden_get（id 或 name）取出密码等字段' : '换个关键词，或先确认条目是否存在于该账户',
    items: page.map(({ item, score }) => ({ ...summary(item), score })),
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
  }

  /** Cached `/api/config` reachability probe (see SERVER_PROBE_TTL_MS). */
  #serverProbe
  /** Memoised search payload, invalidated whenever the vault is replaced. */
  #listCache
  /** The cache record behind the in-memory vault (null when none was used). */
  #cacheRecord
  /** True while a background freshness check is in flight. */
  #revalidating

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
    return store.save({
      accessToken: this.token.accessToken,
      refreshToken: this.token.refreshToken ?? null,
      expiresAt: this.token.expiresAt,
      encryptedKey: this.token.encryptedKey ?? null,
      // Base64 because JSON cannot carry a Buffer.
      masterKey: masterKey ? Buffer.from(masterKey).toString('base64') : null,
      userKey: this.token.userKey ? Buffer.from(this.token.userKey).toString('base64') : null,
      serverUrl: this.server,
      email: String(this.settings.email ?? '').trim(),
      savedAt: this.now(),
      lastUsedAt: this.now(),
    })
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
    }
    return true
  }

  /** Slide the idle deadline forward after a successful use. */
  touchSession() {
    const store = this.sessionStore
    if (!store || typeof store.touch !== 'function' || !this.token) return
    if (typeof store.load === 'function') {
      const record = store.load({ serverUrl: this.server, email: String(this.settings.email ?? '').trim() })
      if (record) {
        store.touch(record)
        store.save(record)
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
    if (!token.encryptedKey) {
      const sync = await fetchSync(this.fetch, server, token.accessToken, signal)
      token.encryptedKey = sync?.profile?.key ?? null
      token.pendingSync = sync
    }
    this.token = token
    this.lastSessionLoss = null // a fresh sign-in supersedes any earlier loss
    // A successful login is the moment the session becomes worth keeping: for a
    // two-factor account it is the only time a code was required.
    this.persistSession()
    return token
  }

  async #refresh(signal) {
    const server = this.server
    try {
      const refreshed = await requestToken(
        this.fetch,
        server,
        {
          grant_type: 'refresh_token',
          refresh_token: this.token.refreshToken,
          client_id: this.authMode === 'apikey' ? String(this.settings.apiKeyClientId).trim() : CLIENT_ID,
        },
        signal,
        this.now,
      )
      refreshed.masterKey = this.token.masterKey
      refreshed.encryptedKey = refreshed.encryptedKey ?? this.token.encryptedKey
      refreshed.userKey = this.token.userKey
      this.token = refreshed
      this.persistSession()
      return true
    } catch (error) {
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
    }
    return this.login(signal)
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
    if (this.vault && this.now() - this.vault.at < ttlMs) return this.vault
    const { token, userKey } = await this.#userKey(signal)
    if (token.pendingSync) {
      const sync = token.pendingSync
      token.pendingSync = undefined
      // Fetched by the login itself, so it is fresh — but its revision is
      // unknown, and a cache written without one simply syncs next time.
      return this.#adopt(sync, userKey, null)
    }
    const cached = this.#restoreCache(userKey)
    if (cached) return cached
    const revision = await this.#revisionOf(token, signal)
    const sync = await fetchSync(this.fetch, this.server, token.accessToken, signal)
    return this.#adopt(sync, userKey, revision)
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

  /** Replace the in-memory vault from a sync payload and refresh the cache. */
  #adopt(sync, userKey, revision) {
    const vault = { ...decryptVault(sync, userKey), at: this.now() }
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

  /** Search metadata only — never returns passwords. */
  async find(query, limit = 8, signal) {
    const max = Math.max(1, Math.min(Number(limit) || 8, 25))
    return JSON.stringify(searchPayload(await this.unlock(signal), query, max), null, 2)
  }

  /**
   * Object form of the search for the HTTP API / UI: a UI-sized limit and an
   * empty query that lists the whole vault.
   *
   * `offset` slices the result for paged reads; `signal` is optional and last
   * (it used to sit in the third position, which paging now needs).
   */
  async findEntries(query = '', limit = 100, offset = 0, signal) {
    const max = Math.max(1, Math.min(Number(limit) || 100, 200))
    const start = Math.max(0, Number(offset) || 0)
    const key = `${query}\u0000${max}\u0000${start}`
    // Reuse the previous payload for an identical query: rebuilding it walks
    // and scores every entry, which is wasted work when the user simply
    // reopened the panel. Dropped whenever the vault is replaced (see above).
    if (this.#listCache && this.#listCache.key === key) return this.#listCache.payload
    const payload = searchPayload(await this.unlock(signal), query, max, { allowEmpty: true, offset: start })
    this.#listCache = { key, payload }
    return payload
  }

  /** Object form of `get()` for the HTTP API / UI. */
  async revealEntry(ref, field = 'all', signal, options = {}) {
    return JSON.parse(await this.get(ref, field, signal, options))
  }

  /** One entry's current TOTP code, with the countdown the UI renders. */
  async totpEntry(ref, signal) {
    const vault = await this.unlock(signal)
    const item = resolveItem(vault, ref)
    if (!item.totpSecret) return { id: item.id, name: item.name, totp: null }
    try {
      const totp = generateTotp(item.totpSecret, this.now())
      return { id: item.id, name: item.name, totp: { ...totp, secondsRemaining: totp.remaining } }
    } catch (error) {
      return { id: item.id, name: item.name, totp: { error: `TOTP 生成失败：${error.message}` } }
    }
  }

  /** Reveal one item's credential fields. */
  async get(ref, field = 'all', signal, options = {}) {
    const vault = await this.unlock(signal)
    const item = resolveItem(vault, ref)
    return JSON.stringify(projectItem(item, field, this.now(), Boolean(options.confirm)), null, 2)
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
    }
    if (!this.configured) {
      report.missing = this.missing
      report.hint = '请用户在 DSH 设置 → 插件 → bitwarden 里补全这些字段（保存后立即生效）'
    }
    if (refresh) this.invalidate({ keepStored: true })
    if (this.settings.serverUrl) {
      // Reuse a recent probe: this is a network round trip whose answer
      // (reachability + version) barely ever changes, and the panel pays for it
      // on every single open. A forced `refresh` always re-probes.
      const cached = refresh ? null : this.#serverProbe
      if (cached && this.now() - cached.at < SERVER_PROBE_TTL_MS) {
        report.reachable = cached.reachable
        report.serverVersion = cached.serverVersion
        if (cached.connectError) report.connectError = cached.connectError
      } else {
        let probe = { at: this.now(), reachable: false, serverVersion: null, connectError: null }
        try {
          const { ok, json } = await httpJson(this.fetch, `${this.server}/api/config`, { signal: undefined }, 8000)
          probe.reachable = ok
          probe.serverVersion = json?.version ?? null
        } catch (error) {
          probe.connectError = error.message
        }
        this.#serverProbe = probe
        report.reachable = probe.reachable
        report.serverVersion = probe.serverVersion
        if (probe.connectError) report.connectError = probe.connectError
      }
    }
    if (this.configured && report.reachable !== false) {
      try {
        if (refresh) this.invalidate({ keepStored: true })
        const vault = await this.unlock(signal)
        report.unlocked = true
        report.items = vault.items.length
        report.folders = vault.folderCount
        if (vault.skipped) report.skippedItems = vault.skipped
        report.tokenExpiresAt = this.token ? new Date(this.token.expiresAt).toISOString() : null
        // `at` is when the data entered memory; a cached unlock is "now" while
        // the data itself is older, so report when it was fetched.
        report.cached = Boolean(vault.cached)
        report.syncedAt = new Date(vault.cached ? (vault.cachedAt ?? vault.at) : vault.at).toISOString()
        report.cache = this.cacheStore ? this.cacheStore.describe(this.#cacheRecord) : { enabled: false, stored: false }
      } catch (error) {
        report.unlocked = false
        report.error = error.message
        if (error.hint) report.hint = error.hint
      }
    }
    return JSON.stringify(report, null, 2)
  }
}
