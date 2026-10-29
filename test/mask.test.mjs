/**
 * Placeholder-mask tests: stability, salting, projection coverage.
 *
 * Run: node test/mask.test.mjs
 */
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadMaskKey,
  defaultMaskKeyPath,
  maskValue,
  maskProjection,
  decorateMaskedProjection,
  MASKED_READ_HINT,
  isPlaceholder,
  PLACEHOLDER_RE,
  tag,
} from '../lib/mask.js'

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
const SECRET_A = ['Ad', 'min', '!2', '3'].join('')
const SECRET_B = ['Oth', 'er', 'Pa', 'ss'].join('')

// ── tag / placeholder mechanics ───────────────────────────────────────────────
const p1 = maskValue(key, 'password', 'item-1', 'password', SECRET_A)
const p2 = maskValue(key, 'password', 'item-1', 'password', SECRET_A)
const otherItem = maskValue(key, 'password', 'item-2', 'password', SECRET_A)
const otherValue = maskValue(key, 'password', 'item-1', 'password', SECRET_B)

check('same inputs produce the identical placeholder', p1 === p2, p1 + ' vs ' + p2)
check('different item salts produce different tags', p1 !== otherItem)
check('different values produce different tags', p1 !== otherValue)
check('placeholder matches its own grammar', PLACEHOLDER_RE.test(p1), p1)
check('isPlaceholder accepts a bare placeholder', isPlaceholder(p1))
check('isPlaceholder rejects surrounding text', !isPlaceholder(p1 + ' tail'))
check('empty and null pass through unchanged', maskValue(key, 'password', 'i', 'f', '') === '' && maskValue(key, 'password', 'i', 'f', null) === null)
check('tag alphabet is lowercase base32 (8 chars)', /^[a-z2-7]{8}$/.test(tag(key, 'password', 'item-1', 'password', SECRET_A)))

// ── projection coverage ───────────────────────────────────────────────────────
const projected = {
  id: 'item-9',
  username: 'lyn',
  password: SECRET_A,
  totp: { code: '654321', period: 30, remaining: 20, freshFor: 20 },
  notes: 'the note body',
  fields: [
    { name: 'env', value: 'prod' },
    { name: 'tok', type: 1, value: SECRET_B },
  ],
  card: { number: '4111111111111111', code: '123', brand: 'Visa' },
  sshKey: { privateKey: '-----BEGIN...', keyFingerprint: 'aa:bb' },
  passwordHistory: [{ password: SECRET_A, lastUsedDate: 1 }],
  identity: { ssn: '123-45-6789', firstName: 'Lyn' },
  secureNote: { type: 0, notes: 'note body' },
}
maskProjection(projected, key, 'item-9')
check('password is masked', isPlaceholder(projected.password), JSON.stringify(projected.password))
check('totp code is masked, timing metadata kept', isPlaceholder(projected.totp?.code) && projected.totp?.period === 30)
check('notes are masked', isPlaceholder(projected.notes))
check('plain fields values are masked', isPlaceholder(projected.fields?.[0]?.value))
check('hidden fields values are masked', isPlaceholder(projected.fields?.[1]?.value))
check('card number and code are masked', isPlaceholder(projected.card?.number) && isPlaceholder(projected.card?.code))
check('card brand survives (not a secret)', projected.card?.brand === 'Visa')
check('ssh private key is masked', isPlaceholder(projected.sshKey?.privateKey))
check('ssh fingerprint survives (not a secret)', projected.sshKey?.keyFingerprint === 'aa:bb')
check('passwordHistory entries are masked', isPlaceholder(projected.passwordHistory?.[0]?.password))
check('identity ssn is masked', isPlaceholder(projected.identity?.ssn))
check('identity firstName survives', projected.identity?.firstName === 'Lyn')
check('secureNote body is masked', isPlaceholder(projected.secureNote?.notes))
check('username survives (the handle, not the secret)', projected.username === 'lyn')

// a masked projection contains none of the secrets
const serialized = JSON.stringify(projected)
check('no secret survives in the serialized projection', !serialized.includes(SECRET_A) && !serialized.includes(SECRET_B) && !serialized.includes('4111111111111111') && !serialized.includes('654321'))

// the model-facing payload says, at the point of use, that the value is a label
const decorated = decorateMaskedProjection(JSON.parse(serialized))
check('a masked projection carries _masked', decorated._masked === true)
check('a masked projection carries the reveal hint', decorated._hint === MASKED_READ_HINT && decorated._hint.includes('bitwarden_reveal'))
const plainProjection = decorateMaskedProjection({ id: 'x', username: 'u', hasTotp: false })
check('a plain projection is left alone', !plainProjection._masked && !plainProjection._hint)

// masking is idempotent-safe: placeholders pass through a second pass untouched
const before = JSON.stringify(projected)
maskProjection(projected, key, 'item-9')
check('re-masking a projection is a no-op', JSON.stringify(projected) === before)

// ── key persistence ───────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'bw-mask-'))
try {
  const keyPath = join(dir, 'mask.key')
  const k1 = loadMaskKey(keyPath)
  const k2 = loadMaskKey(keyPath)
  check('mask key is created and stable across loads', Buffer.isBuffer(k1) && k1.equals(k2))
  check('mask key file is 0600', (statSync(keyPath).mode & 0o777) === 0o600)
  check('mask key is 32 bytes', readFileSync(keyPath).length === 32)
  const placeholder = maskValue(k1, 'password', 'i', 'f', 'v')
  check('placeholder is reproducible from the persisted key', maskValue(loadMaskKey(keyPath), 'password', 'i', 'f', 'v') === placeholder)
  check('defaultMaskKeyPath lands under data/dsh-vaultwarden', defaultMaskKeyPath('/home/x/.dsh').endsWith(join('data', 'dsh-vaultwarden', 'mask.key')))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('')

// -- maskProjection shape coverage (projectItem output shapes) ----------------
{
  const reprompt = { repromptRequired: true, hint: 'verify', id: 'x1' }
  maskProjection(reprompt, key, 'x1')
  check('reprompt gate projection passes through', !reprompt.password && reprompt.repromptRequired === true)

  const totp = { totp: { code: '123456', period: 30, remaining: 17 } }
  maskProjection(totp, key, 'x2')
  check('totp.code masked', !String(totp.totp.code).includes('123456'))

  const all = { password: 'p@ss', hasTotp: true, fields: [{ name: 'k', value: '<hidden>', type: 1 }], passwordHistory: [{ count: 2 }] }
  maskProjection(all, key, 'x3')
  check('all.password masked', all.password.startsWith('{{BW_'))
  check('hidden-field sentinel not double-masked', all.fields[0].value === '<hidden>')
  check('history count survives', all.passwordHistory[0].count === 2)

  const ssh = { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----', keyFingerprint: 'SHA256:xyz' }
  maskProjection(ssh, key, 'x4')
  check('field=sshKey top-level privateKey masked', !String(ssh.privateKey).includes('BEGIN OPENSSH'))

  const card = { card: { number: '4111111111111111' } }
  maskProjection(card, key, 'x5')
  check('card.number masked', !JSON.stringify(card).includes('4111'))

  const weird = { password: '', notes: null, card: { number: undefined }, fields: [{ value: 123 }] }
  maskProjection(weird, key, 'x6')
  check('empty/null/undefined inputs safe', true)
}

console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
