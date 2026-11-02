/**
 * Passkey (WebAuthn / FIDO2) support for the vault half of dsh-vaultwarden.
 *
 * What lives here and why
 * -----------------------
 * Bitwarden stores a passkey as one element of
 * `login.fido2Credentials[]`, with every field except `creationDate` wrapped
 * in an EncString encrypted with the cipher's item key. The plaintext shapes
 * are NOT the shapes a WebAuthn client consumes:
 *
 *   - `credentialId` is a UUID (legacy) or `b64.<base64url>` (current);
 *   - `keyValue`, `userHandle` are base64url WITHOUT padding;
 *   - `counter` is a string, `discoverable` is the string "true"/"false".
 *
 * The DevTools WebAuthn domain wants `credentialId`/privateKey/userHandle as
 * plain base64 and `signCount` as a number, so exporting a passkey is a real
 * conversion — the "it already matches" claim is wrong. This module owns that
 * conversion in one place, in both directions, so the export and the import
 * path cannot drift apart.
 *
 * This file never talks to a browser: it produces/consumes the credential
 * object only. Driving WebAuthn with it is a separate, deliberate step.
 */
import { createPrivateKey } from 'node:crypto'
import { appendFileSync, chmodSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { ensurePrivateDir } from './atomic-file.js'

export class PasskeyError extends Error {
  constructor(message, code = 'bad_passkey') {
    super(message)
    this.name = 'PasskeyError'
    this.code = code
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const B64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/

/** Standard base64 → Buffer (URL-safe characters tolerated). */
export function base64ToBytes(text, label = '值') {
  const raw = String(text ?? '').trim()
  if (!raw) throw new PasskeyError(`${label}为空`)
  const bytes = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (!bytes.length) throw new PasskeyError(`${label}不是有效的 base64`)
  return bytes
}

/** Buffer → standard base64 (what the WebAuthn CDP domain expects). */
export function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

/** Buffer → base64url without padding (what Bitwarden stores). */
export function bytesToB64Url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode a base64url value Bitwarden wrote (padding optional). */
export function b64UrlToBytes(text, label = '值') {
  const raw = String(text ?? '').trim()
  if (!raw) throw new PasskeyError(`${label}为空`)
  if (!B64URL_RE.test(raw)) throw new PasskeyError(`${label}不是有效的 base64url`)
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** UUID text → its 16 raw bytes (Bitwarden's guidToRawFormat). */
export function guidToRawBytes(guid) {
  const text = String(guid ?? '').trim()
  if (!UUID_RE.test(text)) throw new PasskeyError('credentialId 不是合法的 UUID')
  return Buffer.from(text.replace(/-/g, ''), 'hex')
}

/**
 * A stored `credentialId` plaintext → raw credential-ID bytes.
 * Supports the current `b64.<base64url>` form, the legacy UUID form, and a
 * bare base64url string (some exports drop the prefix).
 */
export function credentialIdBytes(credentialId) {
  const text = String(credentialId ?? '').trim()
  if (!text) throw new PasskeyError('credentialId 为空')
  if (text.startsWith('b64.')) return b64UrlToBytes(text.slice(4), 'credentialId')
  if (UUID_RE.test(text)) return guidToRawBytes(text)
  return b64UrlToBytes(text, 'credentialId')
}

/**
 * Decrypt one server-side fido2 credential with the item key.
 * @param {object} credential raw object from `login.fido2Credentials[]`
 * @param {(value: string|undefined) => string|undefined} dec decryptString bound to the item key
 * @param {number} rawIndex position in the server array (needed to edit/remove it)
 * @returns {object|null} null when the entry is unusable/corrupt
 */
export function decodePasskey(credential, dec, rawIndex = 0) {
  if (!credential || typeof credential !== 'object') return null
  const passkey = {
    rawIndex,
    credentialId: dec(credential.credentialId),
    keyType: dec(credential.keyType),
    keyAlgorithm: dec(credential.keyAlgorithm),
    keyCurve: dec(credential.keyCurve),
    keyValue: dec(credential.keyValue),
    rpId: dec(credential.rpId),
    userHandle: dec(credential.userHandle),
    userName: dec(credential.userName),
    counter: dec(credential.counter),
    rpName: dec(credential.rpName),
    userDisplayName: dec(credential.userDisplayName),
    discoverable: dec(credential.discoverable),
    creationDate: credential.creationDate ?? null,
  }
  // A passkey without an id or a key cannot be used or represented; treat it
  // as undecryptable rather than showing a half-row.
  if (!passkey.credentialId || !passkey.keyValue) return null
  return passkey
}

/** Metadata safe to show anywhere: never key material, never the user handle. */
export function passkeySummary(passkey, index = 0) {
  let idBytes = null
  try {
    idBytes = credentialIdBytes(passkey.credentialId)
  } catch {
    idBytes = null
  }
  return {
    index,
    credentialId: idBytes ? bytesToBase64(idBytes) : null,
    credentialIdHint: idBytes ? bytesToBase64(idBytes).slice(0, 8) + '…' : null,
    rpId: passkey.rpId || null,
    rpName: passkey.rpName || null,
    userName: passkey.userName || null,
    userDisplayName: passkey.userDisplayName || null,
    algorithm: passkey.keyAlgorithm || null,
    curve: passkey.keyCurve || null,
    discoverable: String(passkey.discoverable ?? '').toLowerCase() === 'true',
    // A non-discoverable credential still works, but the site must name it in
    // allowCredentials — a "login with passkey" button that sends an empty
    // allowCredentials list can only use discoverable credentials.
    usableForLogin: String(passkey.discoverable ?? '').toLowerCase() === 'true',
    counter: Number.isFinite(Number(passkey.counter)) ? Number(passkey.counter) : 0,
    created: passkey.creationDate || null,
  }
}

/**
 * Stored passkey → the object `WebAuthn.addCredential` takes (CDP Credential).
 * Every conversion the naive "it matches" reading misses happens here.
 */
export function toCdpCredential(passkey) {
  const rpId = String(passkey.rpId ?? '').trim()
  if (!rpId) throw new PasskeyError('通行密钥缺少 rpId，无法导出')
  const idBytes = credentialIdBytes(passkey.credentialId)
  const keyBytes = b64UrlToBytes(passkey.keyValue, 'keyValue')
  // Refuse to hand out bytes no authenticator could use: a corrupted field
  // must fail at export time, not inside the browser.
  let key
  try {
    key = createPrivateKey({ key: keyBytes, format: 'der', type: 'pkcs8' })
  } catch (error) {
    throw new PasskeyError('通行密钥私钥不是合法的 PKCS#8：' + String(error?.message ?? error))
  }
  if (key.asymmetricKeyType !== 'ec') throw new PasskeyError('通行密钥私钥不是 EC 密钥')
  const curve = key.asymmetricKeyDetails?.namedCurve
  if (curve && curve !== 'prime256v1') throw new PasskeyError(`通行密钥曲线不是 P-256（${curve}）`)
  return {
    credentialId: bytesToBase64(idBytes),
    isResidentCredential: String(passkey.discoverable ?? '').toLowerCase() === 'true',
    rpId,
    privateKey: bytesToBase64(keyBytes),
    ...(passkey.userHandle ? { userHandle: bytesToBase64(b64UrlToBytes(passkey.userHandle, 'userHandle')) } : {}),
    signCount: Number.isFinite(Number(passkey.counter)) ? Number(passkey.counter) : 0,
  }
}

/**
 * Accept either a bare CDP credential or our exported wrapper `{cdp: {...}}`,
 * validate it, and normalise every binary field to a Buffer for re-encryption.
 */
export function normalizeCdpCredential(input) {
  const source = input && typeof input === 'object' && input.cdp && typeof input.cdp === 'object' ? input.cdp : input
  if (!source || typeof source !== 'object') throw new PasskeyError('缺少通行密钥数据')
  const rpId = String(source.rpId ?? '').trim()
  if (!rpId) throw new PasskeyError('缺少 rpId（通行密钥绑定的站点）')
  const credentialId = base64ToBytes(source.credentialId, 'credentialId')
  const privateKey = base64ToBytes(source.privateKey, 'privateKey')
  let key
  try {
    key = createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' })
  } catch (error) {
    throw new PasskeyError('privateKey 不是合法的 PKCS#8：' + String(error?.message ?? error))
  }
  if (key.asymmetricKeyType !== 'ec') throw new PasskeyError('privateKey 不是 EC 密钥')
  const curve = key.asymmetricKeyDetails?.namedCurve
  if (curve && curve !== 'prime256v1') throw new PasskeyError(`privateKey 曲线不是 P-256（${curve}）`)
  const signCount = Number(source.signCount)
  return {
    credentialId,
    privateKey,
    rpId,
    userHandle: source.userHandle ? base64ToBytes(source.userHandle, 'userHandle') : null,
    signCount: Number.isFinite(signCount) && signCount >= -1 ? Math.trunc(signCount) : 0,
    isResidentCredential: Boolean(source.isResidentCredential),
    userName: source.userName ? String(source.userName) : null,
    userDisplayName: source.userDisplayName ? String(source.userDisplayName) : null,
    rpName: source.rpName ? String(source.rpName) : null,
    creationDate: source.creationDate ? String(source.creationDate) : new Date().toISOString(),
  }
}

/**
 * Normalised credential → the encrypted fields Bitwarden expects inside
 * `login.fido2Credentials[]`. `encrypt` is `encryptString(value, itemKey)`.
 */
export function passkeyCipherFields(normalized, itemKey, encrypt) {
  const field = (value) => {
    const cipher = encrypt(String(value), itemKey)
    return cipher === undefined ? null : cipher
  }
  return {
    credentialId: field('b64.' + bytesToB64Url(normalized.credentialId)),
    keyType: field('public-key'),
    keyAlgorithm: field('ECDSA'),
    keyCurve: field('P-256'),
    keyValue: field(bytesToB64Url(normalized.privateKey)),
    rpId: field(normalized.rpId),
    ...(normalized.userHandle ? { userHandle: field(bytesToB64Url(normalized.userHandle)) } : {}),
    ...(normalized.userName ? { userName: field(normalized.userName) } : {}),
    counter: field(String(normalized.signCount)),
    ...(normalized.rpName ? { rpName: field(normalized.rpName) } : {}),
    ...(normalized.userDisplayName ? { userDisplayName: field(normalized.userDisplayName) } : {}),
    discoverable: field(normalized.isResidentCredential ? 'true' : 'false'),
    creationDate: normalized.creationDate,
  }
}

/** How long an exported credential file is kept before the next export prunes it. */
export const PASSKEY_EXPORT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Delete exported credential files older than `maxAgeMs`. Called before a new
 * export so a forgotten file does not become a permanent private key on disk;
 * the caller gets an `expiresAt` in the result as well.
 */
export function prunePasskeyExports(dir, now = Date.now(), maxAgeMs = PASSKEY_EXPORT_TTL_MS) {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const file = join(dir, name)
      try {
        const stat = statSync(file)
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) rmSync(file, { force: true })
      } catch {
        /* a file that vanished or cannot be read is not this call's problem */
      }
    }
  } catch {
    /* directory missing/unreadable: nothing to prune */
  }
}

/**
 * Delete one export, or every export in the plugin's own passkey directory.
 *
 * This exists because cleaning up a private-key file must not become a second
 * approval prompt: a caller that has just finished a WebAuthn step should be
 * able to remove the file immediately, even when the write tier is readonly.
 * The check is deliberately path-based and narrow: only regular `.json` files
 * directly beneath `dir` are removable, so a stray path cannot turn this into
 * an arbitrary-file deletion primitive.
 *
 * @param {string} dir - the plugin-owned passkey export directory
 * @param {string|null} target - an export path, or null to clear the directory
 * @returns {{ removed: string[], count: number }}
 */
export function removePasskeyExports(dir, target = null) {
  const root = resolve(String(dir))
  const removed = []
  const removeOne = (file) => {
    const full = resolve(String(file))
    if (full === root || !full.startsWith(root + sep)) return false
    if (!full.endsWith('.json') || basename(full).startsWith('.')) return false
    try {
      const stat = statSync(full)
      if (!stat.isFile()) return false
      rmSync(full, { force: true })
      removed.push(basename(full))
      return true
    } catch {
      return false
    }
  }
  if (target !== null && target !== undefined && String(target).trim() !== '') {
    removeOne(String(target).trim())
  } else {
    try {
      for (const name of readdirSync(root)) {
        if (name.endsWith('.json')) removeOne(join(root, name))
      }
    } catch {
      /* directory missing/unreadable: nothing to remove */
    }
  }
  return { removed, count: removed.length }
}

/**
 * Append one export event to `passkeys/audit.jsonl` (0600). The record carries
 * who (model tool vs panel operator) and what (entry id, rpId, access tier);
 * never the private key, the user handle or the credential bytes.
 *
 * Best effort: an audit failure must not turn a written export into an error,
 * but the caller reports `audit: false` so the gap is visible.
 */
export function appendPasskeyAudit(dir, record) {
  const file = join(dir, 'audit.jsonl')
  try {
    ensurePrivateDir(file)
    appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      /* the create mode already applies on a fresh file */
    }
    return true
  } catch {
    return false
  }
}

/** Read recent audit records, newest first. A malformed line is skipped. */
export function readPasskeyAudit(dir, limit = 20) {
  const max = Math.max(1, Math.min(Number(limit) || 20, 200))
  try {
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean)
    const out = []
    for (let index = lines.length - 1; index >= 0 && out.length < max; index -= 1) {
      try {
        const record = JSON.parse(lines[index])
        if (record && typeof record === 'object') out.push(record)
      } catch {
        /* skip a torn or hand-edited line */
      }
    }
    return out
  } catch {
    return []
  }
}

/** Where exported credential files go: private data dir, one file per export. */
export function defaultPasskeyExportDir(home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')) {
  return join(home, 'data', 'dsh-vaultwarden', 'passkeys')
}

/** A filesystem-safe fragment for the exported file name. */
export function safeFilePart(value) {
  return String(value ?? 'passkey').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'passkey'
}
