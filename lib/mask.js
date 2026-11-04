/**
 * Value masking with stable placeholders — the local redaction layer for
 * model-facing reads.
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
import { createHash, createHmac, randomBytes } from 'node:crypto'
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

const PLACEHOLDER_EXACT_RE = /^\{\{BW_([A-Z]+)_([a-z2-7]{8})\}\}$/
const REDACTION_MARKER_RE = /\[REDACTED:BW_[A-Z]+\]/

/**
 * Parse one exact placeholder into its kind/tag. Unlike `isPlaceholder`, this
 * returns the two fields a reveal-by-handle call needs; surrounding text is
 * rejected so a placeholder embedded in prose cannot be mistaken for a handle.
 *
 * @param {string} text
 * @returns {{kind: string, tag: string, text: string}|null}
 */
export function parsePlaceholder(text) {
  if (typeof text !== 'string') return null
  const match = PLACEHOLDER_EXACT_RE.exec(text.trim())
  if (!match) return null
  return { kind: match[1], tag: match[2], text: match[0] }
}

/**
 * True when a value must never be written back into the vault: a placeholder,
 * a sweeper redaction marker, or the legacy `<hidden>` sentinel that an older
 * projection used for withheld custom fields. `[REDACTED:BW_*]` is included
 * because a model that copies a swept transcript would otherwise persist the
 * marker as a literal credential.
 */
export function isMaskedWriteValue(value) {
  if (typeof value !== 'string') return false
  PLACEHOLDER_RE.lastIndex = 0
  return PLACEHOLDER_RE.test(value) || REDACTION_MARKER_RE.test(value) || value === '<hidden>'
}

/**
 * Walk a write payload and return the first path that contains a masked value,
 * or null. Both keys and values are inspected: a placeholder copied into a
 * custom field's *name* is as corrupting as one copied into its value.
 *
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string|null}
 */
export function findMaskedWritePath(value, path = '') {
  if (typeof value === 'string') return isMaskedWriteValue(value) ? path || 'value' : null
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findMaskedWritePath(value[index], path ? `${path}[${index}]` : `[${index}]`)
      if (hit) return hit
    }
    return null
  }
  if (value && typeof value === 'object') {
    if (value.hidden === true) return path || 'value'
    for (const [key, child] of Object.entries(value)) {
      const keyPath = path ? `${path}.${key}` : key
      if (isMaskedWriteValue(key)) return keyPath
      const hit = findMaskedWritePath(child, keyPath)
      if (hit) return hit
    }
  }
  return null
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
      // A key file that exists but is not 32 bytes is corruption or a bad copy.
      // Regenerating here would silently ROTATE the key and every placeholder
      // already written to past transcripts would become unresolvable — fail
      // closed instead: masking off beats silent rotation.
      return null
    }
    const key = randomBytes(KEY_BYTES)
    writeFilePrivate(keyPath, key, { mode: 0o600 })
    // Another process may have created its own key between the existence check
    // and this write; whatever landed in the file wins, so every reader
    // derives the same placeholders.
    const landed = readFileSync(keyPath)
    return landed.length === KEY_BYTES ? landed : key
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
// Older projections used the literal '<hidden>' sentinel for withheld custom
// fields; current projections carry `hidden:true` + `value:null`. Keep the
// legacy sentinel from being double-masked when reading old payloads.
const HIDDEN_FIELD_VALUE = '<hidden>'

/**
 * Stable identity for one password-history slot. The old salt was the array
 * index, so inserting a newer password shifted every older placeholder and
 * made the trail page lose their origin. Date plus a short hash of the value
 * survives a reorder without putting the old password into the field name.
 */
export function historyFieldName(entry) {
  const date = entry?.lastUsedDate == null ? '' : String(entry.lastUsedDate)
  const digest = createHash('sha256').update(String(entry?.password ?? '')).digest('hex').slice(0, 8)
  return `history:${date}:${digest}`
}

/** Identity fields that are safe to show while filling a form. */
export const IDENTITY_SAFE_FIELDS = new Set([
  'title',
  'firstName',
  'middleName',
  'lastName',
  'address1',
  'address2',
  'address3',
  'city',
  'state',
  'postalCode',
  'country',
  'company',
  'email',
  'phone',
  'username',
])

export function maskProjection(projected, key, itemId, options = {}) {
  if (!projected || typeof projected !== 'object') return projected
  // Bitwarden's type=1 custom fields are the "hidden" class (PIN/API key/
  // recovery code). Type=0 fields are ordinary form metadata such as tenant
  // or environment; masking them too forced a reveal for values a human would
  // happily put on screen. Keep the old full-mask behaviour as the default for
  // callers that ask for it, but the model-facing get can opt out.
  const maskNonHiddenFields = options.maskNonHiddenFields !== false
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
    projected.fields = projected.fields.map((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.value !== 'string' || entry.value === HIDDEN_FIELD_VALUE) return entry
      if (!maskNonHiddenFields && Number(entry.type ?? 0) !== 1) return entry
      return { ...entry, value: maskValue(key, 'fields', itemId, 'field:' + String(entry.name ?? ''), entry.value) }
    })
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
        ? { ...entry, password: maskValue(key, 'passwordHistory', itemId, historyFieldName(entry), entry.password) }
        : entry,
    )
  }
  // identity: government numbers and any future field not on the safe list are
  // credential-grade. Names/addresses remain readable because the model needs
  // them to fill forms; an unknown `bankAccountNumber` must not slip through
  // just because this list was written before that field existed.
  if (projected.identity && typeof projected.identity === 'object') {
    const masked = { ...projected.identity }
    for (const [name, value] of Object.entries(masked)) {
      if (IDENTITY_SAFE_FIELDS.has(name)) continue
      if (typeof value === 'string' && value !== '') {
        masked[name] = maskValue(key, 'identity', itemId, 'identity:' + name, value)
      }
    }
    projected.identity = masked
  }
  return projected
}

/**
 * The sentence a model sees next to a masked projection. It must answer the
 * only question the value itself cannot: "is this the credential, or a label
 * for it?" A placeholder is a well-formed string in the same field a password
 * used to occupy, so without this line the call site looks like a credential.
 */
export const MASKED_READ_HINT =
  '本结果中标记为脱敏的密码、TOTP、备注、卡号、私钥等是占位符或隐藏值，不是真实凭据，不能用于登录、填表或派生 token；需要明文请调用 bitwarden_reveal（按条目+字段，或直接传 placeholder）取回。'

/**
 * Every path in a projection that stands in for a withheld value. This is what
 * lets the model see *which* fields were replaced instead of having to infer
 * it from a bottom-of-object hint. Hidden custom fields (value withheld with
 * `hidden:true`) count even though their value is null, because that is
 * exactly the case where a bare `null` would otherwise look harmless.
 */
export function maskedPaths(projected) {
  const paths = []
  const visit = (node, path) => {
    if (typeof node === 'string') {
      if (isPlaceholder(node) || node === '<hidden>') paths.push(path || 'value')
      return
    }
    if (Array.isArray(node)) {
      node.forEach((value, index) => visit(value, path ? `${path}[${index}]` : `[${index}]`))
      return
    }
    if (node && typeof node === 'object') {
      if (node.hidden === true) {
        paths.push(path || 'value')
        return
      }
      for (const [key, value] of Object.entries(node)) visit(value, path ? `${path}.${key}` : key)
    }
  }
  visit(projected, '')
  return paths
}

/**
 * Add `_masked` / `_hint` / `_maskedFields` to a projection that actually
 * contains placeholders or withheld fields. A projection with no masked value
 * is left untouched: a plain `username` read should not grow a paragraph about
 * a mask that never happened.
 *
 * Markers are returned before the payload, not appended after it: a host that
 * caps tool-result bytes keeps the prefix, and the prefix is where the model
 * must learn that the following values are labels rather than credentials.
 *
 * @param {object} projected parsed `bitwarden_get` payload
 * @returns {object} a decorated copy when needed; the original otherwise
 */
export function decorateMaskedProjection(projected) {
  if (!projected || typeof projected !== 'object') return projected
  const fields = maskedPaths(projected)
  if (fields.length === 0) return projected
  const { _masked, _hint, _maskedFields, ...rest } = projected
  return {
    _masked: true,
    _hint: MASKED_READ_HINT,
    _maskedFields: fields,
    ...rest,
  }
}
