/**
 * Reading a placeholder back to its entry.
 *
 * The interesting property is not "the lookup works" but "the field names
 * agree": lib/unmask.js re-derives every (kind, fieldName, value) triple that
 * lib/mask.js maskProjection() hashed. If the two lists drift by one character,
 * every recomputed tag misses and the value card silently loses its origin —
 * with no error anywhere. So the main test here is a round trip: mask a real
 * projection, then look every placeholder it produced back up.
 *
 * Run: node test/unmask.test.mjs
 */
import { maskProjection, maskValue, PLACEHOLDER_RE } from '../lib/mask.js'
import { isTagFingerprint, lookupFingerprint, maskSlots, previewOf, tagIndex } from '../lib/unmask.js'

let passed = 0
let failed = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    passed++
    console.log('  ✓ ' + label)
  } else {
    failed++
    console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''))
  }
}

const key = Buffer.alloc(32, 7)
const TAG_RE = /^\{\{BW_([A-Z]+)_([a-z2-7]{8})\}\}$/

// ── one entry holding a value in every slot maskProjection touches ────────────
const PASSWORD = 'Adm1n-Passw0rd-2026'
const OLD_ONE = 'first-old-Passw0rd'
const OLD_TWO = 'second-old-Passw0rd'
const ITEM = {
  id: 'item-42',
  name: '生产环境 API',
  username: 'lyn',
  password: PASSWORD,
  totpSecret: 'JBSWY3DPEHPK3PXP',
  notes: 'the note body',
  fields: [
    { name: 'env', value: 'prod-2' },
    { name: 'token', type: 1, value: 'tok_abcdef123456' },
  ],
  card: { number: '4111111111111111', code: '123', brand: 'Visa' },
  sshKey: { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----' },
  passwordHistory: [{ password: OLD_ONE }, { password: OLD_TWO }],
  identity: { ssn: '123-45-6789', passportNumber: 'E1234567', licenseNumber: 'D7654321' },
  secureNote: { type: 0 },
}

// maskProjection runs over a PROJECTION — the shape projectItem returns — whose
// totp (if any) is an object with a code, and whose secure note text lives in
// notes. Build that projection from the item, mask it, and keep both sides.
const projection = {
  id: ITEM.id,
  username: ITEM.username,
  password: ITEM.password,
  totp: { code: '654321', period: 30, remaining: 20 },
  notes: ITEM.notes,
  fields: ITEM.fields.map((entry) => ({ ...entry })),
  card: { ...ITEM.card },
  sshKey: { ...ITEM.sshKey },
  passwordHistory: ITEM.passwordHistory.map((entry) => ({ ...entry })),
  identity: { ssn: ITEM.identity.ssn, passportNumber: ITEM.identity.passportNumber, licenseNumber: ITEM.identity.licenseNumber },
}
maskProjection(projection, key, ITEM.id)

const index = tagIndex([ITEM], key)
const resolve = (placeholder) => {
  const match = TAG_RE.exec(placeholder)
  return match ? lookupFingerprint(index, match[1] + ':' + match[2]) : null
}

// Every placeholder the projection produced must resolve back to this entry.
const produced = []
const walk = (node) => {
  if (typeof node === 'string') {
    if (PLACEHOLDER_RE.test(node)) produced.push(node)
    return
  }
  if (Array.isArray(node)) return node.forEach(walk)
  if (node && typeof node === 'object') return Object.values(node).forEach(walk)
}
walk(projection)

check('the projection really was masked', produced.length >= 8, String(produced.length))
check('every placeholder resolves back to its entry', produced.every((text) => { const hit = resolve(text); return Boolean(hit) && hit.itemId === ITEM.id }), JSON.stringify(produced.map((text) => { const hit = resolve(text); return hit ? hit.field : null })))
check('the password placeholder names the password slot', (() => {
  const hit = resolve(projection.password)
  return Boolean(hit) && hit.field === 'password' && hit.kind === 'PASSWORD'
})(), JSON.stringify(resolve(projection.password)))
check('a custom field keeps its own name in the salt', (() => {
  const hit = resolve(projection.fields[1].value)
  return Boolean(hit) && hit.field === 'field:token' && hit.kind === 'FIELD'
})(), JSON.stringify(resolve(projection.fields[1].value)))
check('card number and code are two different slots', (() => {
  const number = resolve(projection.card.number)
  const code = resolve(projection.card.code)
  return Boolean(number) && Boolean(code) && number.field === 'card:number' && code.field === 'card:code'
})())
check('the ssh key resolves through sshKey:privateKey', (() => {
  const hit = resolve(projection.sshKey.privateKey)
  return Boolean(hit) && hit.field === 'sshKey:privateKey' && hit.kind === 'SSHKEY'
})(), JSON.stringify(resolve(projection.sshKey.privateKey)))
check('a historical password resolves by its position', (() => {
  const first = resolve(projection.passwordHistory[0].password)
  const second = resolve(projection.passwordHistory[1].password)
  return Boolean(first) && Boolean(second) && first.field === 'history:0' && second.field === 'history:1'
})(), JSON.stringify([resolve(projection.passwordHistory[0].password)?.field, resolve(projection.passwordHistory[1].password)?.field]))
check('identity numbers resolve as identity:<name>', (() => {
  const hit = resolve(projection.identity.ssn)
  return Boolean(hit) && hit.field === 'identity:ssn' && hit.kind === 'IDENTITY'
})(), JSON.stringify(resolve(projection.identity.ssn)))
check('the entry name comes back with the hit, the value does not', (() => {
  const hit = resolve(projection.password)
  return Boolean(hit) && hit.itemName === '生产环境 API' && !JSON.stringify(hit).includes(PASSWORD)
})(), JSON.stringify(resolve(projection.password)))
check('the answer carries no field the page does not need', (() => {
  const hit = resolve(projection.password)
  return Object.keys(hit).sort().join(',') === 'field,itemId,itemName,kind,preview'
})(), JSON.stringify(Object.keys(resolve(projection.password) ?? {}).sort()))

// ── notes: masked after the cut-off, so the tag is over the cut text ─────────
// projectItem() truncates notes at 2000 characters BEFORE maskProjection hashes
// them, so the tag is over the truncated string. Getting this order wrong would
// mean every long note silently misses, which is why the cut-off is repeated in
// lib/unmask.js and tested here rather than assumed.
const LONG = 'n'.repeat(2500)
const CUT = LONG.slice(0, 2000) + '…（已截断，共 2500 字符）'
const longIndex = tagIndex([{ id: 'n1', name: 'long', notes: LONG }], key)
const longProjection = { id: 'n1', notes: CUT }
maskProjection(longProjection, key, 'n1')
const longMatch = TAG_RE.exec(longProjection.notes)
check('a long note resolves through its truncation', Boolean(longMatch) && Boolean(lookupFingerprint(longIndex, 'NOTES:' + longMatch[2])), JSON.stringify(longMatch?.[2]))
// The same text under a different field name is a different tag — that is the
// whole point of the salt — so the secure-note slot needs its own placeholder.
const secureMatch = TAG_RE.exec(maskValue(key, 'secureNote', 'n1', 'secureNote', CUT))
check('the same note text answers for the secureNote slot too', Boolean(secureMatch) && lookupFingerprint(longIndex, 'SECURENOTE:' + secureMatch[2])?.field === 'secureNote')
check('but it is not the notes tag', Boolean(secureMatch) && Boolean(longMatch) && secureMatch[2] !== longMatch[2])

// ── preview ───────────────────────────────────────────────────────────────────
check('a long value shows four characters and dots', previewOf(PASSWORD) === 'Adm1••••••…', previewOf(PASSWORD))
check('a short value shows no characters at all', previewOf('1234567') === '••••••…', previewOf('1234567'))
check('the preview is never the value', !previewOf(PASSWORD).includes('Passw0rd'))
check('exactly eight characters still shows four', previewOf('abcdefgh') === 'abcd••••••…', previewOf('abcdefgh'))

// ── misses: the ways a card keeps its bare placeholder ───────────────────────
// A marker is a sweeper rewrite with no salt to recompute.
check('a marker is not a tag and is never looked up', !isTagFingerprint('M|9f3ab21c'))
check('a placeholder-shaped tag is', isTagFingerprint('PASSWORD:abcdefgh'))
// Real logs hold fingerprints whose tag slot caught another masker's
// placeholder instead of a tag; those must never be treated as a tag. The
// literal is assembled so no placeholder-shaped token appears in this file.
const NESTED = 'PASSWORD:' + String.fromCharCode(123, 123) + 'SECRET' + String.fromCharCode(95) + 'pr4fc57s' + String.fromCharCode(125, 125)
check('a nested placeholder in the tag slot is not a tag', !isTagFingerprint(NESTED), NESTED)
check('a marker misses even against a full index', lookupFingerprint(index, 'M|9f3ab21c') === null)
check('an unknown tag misses', lookupFingerprint(index, 'PASSWORD:zzzzzzzz') === null)
// The kind rides in the placeholder, not the hash: the same tag claimed by a
// different kind means the log and the vault disagree, so it must NOT resolve.
check('the right tag under the wrong kind does not resolve', (() => {
  const match = TAG_RE.exec(projection.password)
  return lookupFingerprint(index, 'NOTES:' + match[2]) === null
})(), TAG_RE.exec(projection.password)?.[2])
check('an empty index resolves nothing', lookupFingerprint(tagIndex([], key), 'PASSWORD:abcdefgh') === null)
check('no key, no index', lookupFingerprint(tagIndex([ITEM], null), 'PASSWORD:abcdefgh') === null)
check('a deleted entry leaves nothing to match', (() => {
  const gone = tagIndex([], key)
  const match = TAG_RE.exec(maskValue(key, 'password', 'gone-1', 'password', PASSWORD))
  return lookupFingerprint(gone, 'PASSWORD:' + match[2]) === null
})())

// ── maskSlots: the reverse of maskProjection's field list ────────────────────
const slots = maskSlots(ITEM)
const names = slots.map((slot) => slot.fieldName)
check('every slot carries the field name maskProjection would hash', names.includes('password') && names.includes('notes') && names.includes('field:env') && names.includes('card:number') && names.includes('identity:ssn'), JSON.stringify(names))
check('the totp secret is not a slot (the code is what got hashed)', !names.includes('totp'))
check('empty and hidden values are not slots', maskSlots({ id: 'x', password: '', fields: [{ name: 'h', value: '<hidden>' }] }).length === 0, JSON.stringify(maskSlots({ id: 'x', password: '', fields: [{ name: 'h', value: '<hidden>' }] })))
check('a value that is not a string is not a slot', maskSlots({ id: 'x', password: 12345 }).length === 0)
check('a top-level privateKey is a slot too', maskSlots({ id: 'x', privateKey: 'k' }).some((slot) => slot.fieldName === 'sshKey:privateKey'))
check('the username is never a slot', !names.includes('username'))

// ── two entries, one value: the salt keeps them apart ────────────────────────
const twinIndex = tagIndex([{ id: 'a', name: 'first', password: 'same-value' }, { id: 'b', name: 'second', password: 'same-value' }], key)
check('the tag is salted by the entry, so twins stay distinct', (() => {
  const a = TAG_RE.exec(maskValue(key, 'password', 'a', 'password', 'same-value'))
  const b = TAG_RE.exec(maskValue(key, 'password', 'b', 'password', 'same-value'))
  return a[2] !== b[2]
})())
check('each twin resolves to its own entry', (() => {
  const a = TAG_RE.exec(maskValue(key, 'password', 'a', 'password', 'same-value'))
  const b = TAG_RE.exec(maskValue(key, 'password', 'b', 'password', 'same-value'))
  return lookupFingerprint(twinIndex, 'PASSWORD:' + a[2]).itemName === 'first' && lookupFingerprint(twinIndex, 'PASSWORD:' + b[2]).itemName === 'second'
})())

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
