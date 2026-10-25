/**
 * Value masking with stable placeholders — the magpie-style local redaction
 * layer for model-facing reads.
 *
 * Why this exists
 * ---------------
 * `bitwarden_get` hands the model a plaintext credential so it can finish a
 * task. Once that happens the secret is in the transcript, in the session
 * log, and in every downstream cache of either. `maskMode` flips the default:
 * model-facing reads return a placeholder (`{{BW_PASSWORD_ab12cd34}}`) and the
 * vault itself stays the only place the secret lives. The model calls
 * `bitwarden_reveal` for the minority of tasks that truly need the plaintext
 * (typing it into a form, deriving a token from it), and that call is a
 * single auditable event instead of a side effect of every read.
 *
 * Placeholder shape
 * -----------------
 * `{{BW_<KIND>_<tag>}}` where KIND names the field class (PASSWORD, TOTP,
 * NOTES, FIELD, CARD, IDENTITY, SSHKEY, HISTORY, VALUE) and `tag` is the
 * first 8 base32 chars of HMAC-SHA256(maskKey, itemId + "\0" + fieldName +
 * "\0" + value). Same value → same placeholder, so a model can reason about
 * identity ("this is the same password as before") without ever seeing it.
 * The itemId/fieldName salt means the same secret filed under two entries
 * yields two tags, so placeholders cannot be joined across entries to
 * discover a duplicate.
 *
 * The mask key is a separate file (mask.key) next to the session record, not
 * cache.key: rotating or deleting the vault cache must not silently change
 * every placeholder, because a transcript full of tags that no longer resolve
 * is worse than no masking at all.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFilePrivate } from './atomic-file.js'

const KEY_BYTES = 32
const TAG_CHARS = 8
// RFC 4648 base32, lowercased, without padding — unambiguous in a transcript
// and impossible to mistake for base64 or hex.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** Field classes a placeholder can name. Persisted in the placeholder itself,
 *  so a reader can tell what a tag stands for without the key. */
const KINDS = {
  password: 'PASSWORD',
  totp: 'TOTP',
  notes: 'NOTES',
  fields: 'FIELD',
  card: 'CARD',
  identity: 'IDENTITY',
  sshKey: 'SSHKEY',
  secureNote: 'SECURENOTE',
  passwordHistory: 'HISTORY',
  value: 'VALUE',
}

/** Matches what `tag()` can produce — used to keep placeholders intact
 *  through later redaction passes (the sweeper). */
export const PLACEHOLDER_RE = /\{\{BW_([A-Z]+)_([a-z2-7]{8})\}\}/g

/** True when `text` is (or contains only) one placeholder. */
export function isPlaceholder(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (!trimmed.startsWith('{{BW_') || !trimmed.endsWith('}}')) return false
  PLACEHOLDER_RE.lastIndex = 0
  const match = trimmed.match(PLACEHOLDER_RE)
  return Boolean(match) && match[0] === trimmed
}

/**
 * Load (or lazily create) the HMAC key for placeholders.
 * @param {string} keyPath absolute path of the mask.key file
 * @returns {Buffer|null} 32-byte key, or null when it cannot be read/created
 */
export function loadMaskKey(keyPath) {
  try {
    if (existsSync(keyPath)) {
      const key = readFileSync(keyPath)
      if (key.length === KEY_BYTES) return key
    }
    const key = randomBytes(KEY_BYTES)
    writeFilePrivate(keyPath, key, { mode: 0o600 })
    return key
  } catch {
    // Without a stable key the placeholders would change every call, which
    // breaks the one property (stability) they exist to provide. Callers
    // should treat null as "masking unavailable" and pass the value through
    // rather than emit unstable tags.
    return null
  }
}

/** Default mask key location: beside the plugin's session record. */
export function defaultMaskKeyPath(home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')) {
  return join(home, 'data', 'dsh-vaultwarden', 'mask.key')
}

function base32(buffer) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * The stable tag for one value. Secret is derived, never stored: the vault is
 * the authority, the tag is only a stable name for "the thing at itemId/field".
 */
export function tag(key, kind, itemId, fieldName, value) {
  const mac = createHmac('sha256', key)
    .update(String(itemId ?? '') + '\0' + String(fieldName ?? '') + '\0' + String(value ?? ''))
    .digest()
  return base32(mac).slice(0, TAG_CHARS)
}

/**
 * Build the placeholder for one value.
 * @returns {string} `{{BW_KIND_xxxxxxxx}}`, or the original value when no key
 */
export function maskValue(key, kind, itemId, fieldName, value) {
  const kindName = KINDS[kind] ?? KINDS.value
  if (value === undefined || value === null || value === '') return value
  if (!key) return value
  if (typeof value !== 'string') value = JSON.stringify(value)
  // An already-masked value is final: re-masking (a get of a masked
  // projection, a sweep of a swept log) must not wrap placeholders further.
  if (isPlaceholder(value)) return value
  return `{{BW_${kindName}_${tag(key, kind, itemId, fieldName, value)}}}`
}

/** Redaction marker used when the plaintext must disappear entirely (sweeper):
 *  the placeholder keeps its readable tag, the secret behind it does not. */
export function redactionMarker(kind) {
  return `[REDACTED:BW_${KINDS[kind] ?? KINDS.value}]`
}

/**
 * Mask the JSON object `bitwarden_get` would return, in place.
 *
 * Mirrors the field classes `projectItem` can emit (lib/vault.js): every key
 * below carries credential material. `username` is deliberately NOT masked —
 * it is the handle the model needs to reason with (`lyn@hermes`), not the
 * secret; masking it would make every placeholder useless for the task.
 *
 * @param {object} projected the parsed projectItem output
 * @param {Buffer} key mask key
 * @param {string} itemId entry id, salt for the tag
 * @returns {object} the same object with secrets replaced by placeholders
 */
// vault.js projects hidden custom fields as '<hidden>' when maskHiddenFields
// is on (all projection); that sentinel must survive masking untouched.
const HIDDEN_FIELD_VALUE = '<hidden>'

export function maskProjection(projected, key, itemId) {
  if (!projected || typeof projected !== 'object') return projected
  const maskLeaf = (kind, fieldName, value) => {
    if (value === undefined || value === null) return value
    return maskValue(key, kind, itemId, fieldName, value)
  }
  if (typeof projected.password === 'string') projected.password = maskLeaf('password', 'password', projected.password)
  if (typeof projected.totp === 'object' && projected.totp !== null) {
    // The TOTP projection is {code, period, remaining, freshFor} — the code is
    // the secret; the timing metadata is what makes the row useful.
    if (typeof projected.totp.code === 'string') projected.totp.code = maskValue(key, 'totp', itemId, 'totp', projected.totp.code)
  } else if (typeof projected.totp === 'string') {
    projected.totp = maskLeaf('totp', 'totp', projected.totp)
  }
  if (typeof projected.notes === 'string') projected.notes = maskLeaf('notes', 'notes', projected.notes)
  if (typeof projected.secureNote === 'object' && projected.secureNote !== null && typeof projected.secureNote.notes === 'string') {
    projected.secureNote.notes = maskValue(key, 'secureNote', itemId, 'secureNote', projected.secureNote.notes)
  }
  if (Array.isArray(projected.fields)) {
    projected.fields = projected.fields.map((entry) =>
      entry && typeof entry === 'object' && typeof entry.value === 'string' && entry.value !== HIDDEN_FIELD_VALUE
        ? { ...entry, value: maskValue(key, 'fields', itemId, 'field:' + String(entry.name ?? ''), entry.value) }
        : entry,
    )
  }
  if (projected.card && typeof projected.card === 'object') {
    const masked = { ...projected.card }
    for (const name of ['number', 'code']) {
      if (typeof masked[name] === 'string' && masked[name] !== '') masked[name] = maskValue(key, 'card', itemId, 'card:' + name, masked[name])
    }
    projected.card = masked
  }
  // field=sshKey projects {privateKey, publicKey, keyFingerprint} at the TOP
  // level (no sshKey wrapper) — mask that shape too or the private key leaks.
  if (typeof projected.privateKey === 'string' && projected.privateKey !== '') {
    projected.privateKey = maskValue(key, 'sshKey', itemId, 'sshKey:privateKey', projected.privateKey)
  }
  if (projected.sshKey && typeof projected.sshKey === 'object') {
    const masked = { ...projected.sshKey }
    if (typeof masked.privateKey === 'string' && masked.privateKey !== '') {
      masked.privateKey = maskValue(key, 'sshKey', itemId, 'sshKey:privateKey', masked.privateKey)
    }
    projected.sshKey = masked
  }
  if (Array.isArray(projected.passwordHistory)) {
    projected.passwordHistory = projected.passwordHistory.map((entry, index) =>
      entry && typeof entry === 'object' && typeof entry.password === 'string'
        ? { ...entry, password: maskValue(key, 'passwordHistory', itemId, 'history:' + index, entry.password) }
        : entry,
    )
  }
  // identity: government numbers are credential-grade. Mask the number-shaped
  // fields, keep names/addresses readable — the model needs them to fill forms.
  if (projected.identity && typeof projected.identity === 'object') {
    const masked = { ...projected.identity }
    for (const name of ['ssn', 'passportNumber', 'licenseNumber']) {
      if (typeof masked[name] === 'string' && masked[name] !== '') {
        masked[name] = maskValue(key, 'identity', itemId, 'identity:' + name, masked[name])
      }
    }
    projected.identity = masked
  }
  return projected
}
