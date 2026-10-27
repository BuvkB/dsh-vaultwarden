/**
 * Reading a placeholder back to the entry it came from.
 *
 * A placeholder's tag is `HMAC-SHA256(maskKey, itemId \0 fieldName \0 value)`
 * truncated to eight base32 characters (lib/mask.js). It cannot be inverted —
 * but it CAN be recomputed, and the vault holds every input except the key:
 * the item id salts the hash, the field name names the slot, and the decrypted
 * value is the third input. So "which value did this placeholder stand in for"
 * is answerable by brute force over one vault: a few thousand HMACs, which is
 * milliseconds, not a search.
 *
 * What this module deliberately does NOT do:
 *  - It never returns a whole value. `previewOf` keeps the first four
 *    characters of a long-enough value and gives the length away nowhere; a
 *    short value shows no characters at all. The page needs to say "this was
 *    your password for that entry", not to become a second password viewer.
 *  - It never guesses. A marker ([REDACTED:BW]) is a sweeper rewrite with no
 *    salt to recompute, a TOTP code is a function of the minute it was read
 *    (so its tag is gone by the time anyone opens the row), and an entry that
 *    has since been deleted or edited simply produces no match. All of those
 *    come back as a miss, and the page keeps showing the bare placeholder.
 *  - It never reads a reprompt-protected entry unless the operator has already
 *    cleared the prompt for it in this session; the caller filters those out
 *    (see VaultGateway.readableItems).
 *
 * Field names must match lib/mask.js maskProjection() character for character:
 * that is the only reason a recomputed tag can equal a recorded one. Note that
 * projectItem() truncates notes at 2000 characters before masking, so the tag
 * is over the TRUNCATED text — `truncate` below repeats that, suffix included.
 */
import { tag } from './mask.js'

/** Same cut-off projectItem() applies to notes, secure notes and history text. */
const TRUNCATE_MAX = 2000

/** The vault's placeholder for a hidden custom field; never a real value. */
const HIDDEN_FIELD_VALUE = '<hidden>'

/** `KIND:tag` — the fingerprint shape lib/trail.js records on a ledger row. */
const FINGERPRINT_RE = /^([A-Z]+):([a-z2-7]{8})$/

/** Characters a preview may show before the dots. */
const PREVIEW_CHARS = 4

/** Values shorter than this show nothing at all — four of six characters is
 *  most of the secret. */
const PREVIEW_MIN = 8

const truncate = (text, max = TRUNCATE_MAX) =>
  typeof text !== 'string' || text.length <= max ? text : `${text.slice(0, max)}…（已截断，共 ${text.length} 字符）`

/** True when a fingerprint could name a placeholder (markers and malformed
 *  fingerprints cannot, so the caller can skip unlocking for them). */
export function isTagFingerprint(fingerprint) {
  return FINGERPRINT_RE.test(String(fingerprint ?? ''))
}

function collect(slots, kind, fieldName, value) {
  if (typeof value !== 'string' || value === '' || value === HIDDEN_FIELD_VALUE) return
  slots.push({ kind, fieldName, value })
}

/**
 * Every (kind, fieldName, value) triple maskProjection() could have hashed for
 * this decrypted item — the reverse of that function's field list.
 * @param {object} item decrypted cipher (lib/vault.js decryptCipher output)
 */
export function maskSlots(item) {
  const slots = []
  if (!item || typeof item !== 'object') return slots
  collect(slots, 'PASSWORD', 'password', item.password)
  // projectItem gives notes under 'all' and 'notes'; a secure note gives the
  // same text under its own kind. Both salts get computed.
  const notes = truncate(item.notes)
  collect(slots, 'NOTES', 'notes', notes)
  collect(slots, 'SECURENOTE', 'secureNote', notes)
  for (const entry of Array.isArray(item.fields) ? item.fields : []) {
    collect(slots, 'FIELD', 'field:' + String(entry && entry.name != null ? entry.name : ''), entry && entry.value)
  }
  if (item.card) {
    collect(slots, 'CARD', 'card:number', item.card.number)
    collect(slots, 'CARD', 'card:code', item.card.code)
  }
  if (item.sshKey) collect(slots, 'SSHKEY', 'sshKey:privateKey', item.sshKey.privateKey)
  // Some shapes keep the key at the top level instead of under sshKey.
  collect(slots, 'SSHKEY', 'sshKey:privateKey', item.privateKey)
  const history = Array.isArray(item.passwordHistory) ? item.passwordHistory : []
  history.forEach((entry, index) => collect(slots, 'HISTORY', 'history:' + index, entry && entry.password))
  if (item.identity && typeof item.identity === 'object') {
    for (const name of ['ssn', 'passportNumber', 'licenseNumber']) {
      collect(slots, 'IDENTITY', 'identity:' + name, item.identity[name])
    }
  }
  return slots
}

/**
 * tag → the slot that produces it, for one vault and one key.
 * @param {object[]} items decrypted ciphers (live entries and trashed ones)
 * @param {Buffer} key the mask key (lib/mask.js loadMaskKey)
 */
export function tagIndex(items, key) {
  const index = new Map()
  if (!key) return index
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.id == null) continue
    const itemId = String(item.id)
    for (const slot of maskSlots(item)) {
      const computed = tag(key, slot.kind, itemId, slot.fieldName, slot.value)
      if (index.has(computed)) continue
      index.set(computed, {
        itemId,
        itemName: typeof item.name === 'string' ? item.name : '',
        kind: slot.kind,
        field: slot.fieldName,
        value: slot.value,
      })
    }
  }
  return index
}

/** What the page may print instead of the value itself. */
export function previewOf(value) {
  const text = String(value ?? '')
  const shown = text.length >= PREVIEW_MIN ? text.slice(0, PREVIEW_CHARS) : ''
  return shown + '••••••…'
}

/**
 * Resolve one ledger fingerprint against a tag index.
 * @returns {null | { itemId: string, itemName: string, kind: string, field: string, preview: string }}
 */
export function lookupFingerprint(index, fingerprint) {
  const match = FINGERPRINT_RE.exec(String(fingerprint ?? ''))
  if (!match || !index) return null
  const found = index.get(match[2])
  // The kind rides in the placeholder, not in the hash, so it is a second
  // witness rather than a lookup key: a FIELD tag that turns out to be the
  // password of the same entry means the log and the vault disagree.
  if (!found || found.kind !== match[1]) return null
  return {
    itemId: found.itemId,
    itemName: found.itemName,
    kind: found.kind,
    field: found.field,
    preview: previewOf(found.value),
  }
}

/**
 * Attach `origin` to every value of a trailRow() detail payload.
 *
 * Lives here rather than in the gateway so the mapping is testable without a
 * live vault: the gateway only has to answer "which index, if any", and a null
 * index (locked vault, no mask key, two-factor pending) leaves each value with
 * `origin: null` — the card then prints the bare placeholder, exactly as it did
 * before this feature existed.
 *
 * An entry that no longer matches the log entry keeps its counts and spots; it
 * only loses the preview, which is the one thing the vault could not prove.
 * @param {object} detail trailRowDetail() output
 * @param {Map|null} index tagIndex() output
 */
export function attachOrigins(detail, index) {
  if (!detail || detail.ok !== true || !Array.isArray(detail.values)) return detail
  return {
    ...detail,
    values: detail.values.map((value) => ({
      ...value,
      origin: index ? lookupFingerprint(index, value.fingerprint) : null,
    })),
  }
}
