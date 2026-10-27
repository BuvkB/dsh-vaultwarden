/**
 * The gateway's side of "which entry was this placeholder".
 *
 * trailRow() itself is a thin map over the trail index, which has its own test;
 * what is worth pinning here is maskIndex(), because every one of its failure
 * modes is silent by design. A locked vault, a missing mask key and a
 * two-factor-pending session must all come back as "no index" rather than an
 * error — the detail page then shows bare placeholders, which is what it showed
 * before this feature existed. The two rules that are NOT negotiable are also
 * here: a reprompt-protected entry is never hashed without its prompt having
 * been cleared, and the index is dropped when the vault it was built from goes.
 *
 * Run: node test/trail-origin.test.mjs
 */
import { maskValue } from '../lib/mask.js'
import { VaultGateway } from '../lib/gateway.js'
import { attachOrigins, lookupFingerprint } from '../lib/unmask.js'

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
// A plain value on purpose: the tag maths does not care what the secret looks
// like, and a placeholder-shaped literal here would be rewritten in transit.
const SECRET = 'Adm1n-9f3ab21c-7710'
const SECRET_NAME = '生产环境 API'
const ENTRY = { id: 'item-1', name: SECRET_NAME, password: SECRET }
const TAGGED = maskValue(key, 'password', 'item-1', 'password', SECRET)
const PLACEHOLDER_RE = /^[{][{]BW_PASSWORD_([a-z2-7]{8})[}][}]$/
const TAG = PLACEHOLDER_RE.exec(TAGGED)[1]
const FINGERPRINT = 'PASSWORD:' + TAG
// What previewOf() prints for SECRET: four characters, then dots.
const DOTS = '••••••…'

/** A gateway built from the prototype, wired like the host does it. */
function makeGateway(options) {
  const state = { unlockCalls: 0, vault: options.vault }
  const client = {
    unlock: async () => {
      state.unlockCalls++
      if (options.locked) throw new Error('locked')
      return state.vault
    },
    repromptGrantedFor: options.granted ? (id) => options.granted.includes(id) : undefined,
  }
  const gateway = Object.create(VaultGateway.prototype)
  gateway.getClient = () => client
  gateway.maskKey = options.maskKey === undefined ? () => key : options.maskKey
  gateway.maskIndexCache = null
  return { gateway, state, client }
}

async function main() {
  console.log('gateway: placeholder to entry (vw/trailRow origin)')

  // -- the happy path --------------------------------------------------
  {
    const { gateway } = makeGateway({ vault: { items: [ENTRY], trashed: [] } })
    const index = await gateway.maskIndex()
    const hit = lookupFingerprint(index, FINGERPRINT)
    check('a placeholder the vault still holds resolves', Boolean(hit) && hit.itemId === 'item-1', JSON.stringify(hit))
    check('the page gets the name and a preview, never the value', Boolean(hit) && hit.itemName === SECRET_NAME && hit.preview === SECRET.slice(0, 4) + DOTS && !JSON.stringify(hit).includes(SECRET), JSON.stringify(hit))
  }

  // -- soft-deleted entries travel in their own bucket ------------------
  {
    const { gateway } = makeGateway({ vault: { items: [], trashed: [{ ...ENTRY, deletedDate: '2026-10-01' }] } })
    const hit = lookupFingerprint(await gateway.maskIndex(), FINGERPRINT)
    check('an entry in the trash still explains an old row', Boolean(hit) && hit.itemId === 'item-1', JSON.stringify(hit))
  }

  // -- the four silent misses -------------------------------------------
  {
    const locked = makeGateway({ vault: { items: [ENTRY] }, locked: true })
    check('a locked vault is a miss, not an error', (await locked.gateway.maskIndex()) === null)
    const noKey = makeGateway({ vault: { items: [ENTRY] }, maskKey: null })
    check('a gateway without a mask key never unlocks', (await noKey.gateway.maskIndex()) === null && noKey.state.unlockCalls === 0, String(noKey.state.unlockCalls))
    const emptyKey = makeGateway({ vault: { items: [ENTRY] }, maskKey: () => null })
    check('an unreadable mask key is a miss', (await emptyKey.gateway.maskIndex()) === null)
    const noVault = makeGateway({ vault: null })
    check('a vault with no items is an empty index, not null', (await noVault.gateway.maskIndex())?.size === 0)
  }

  // -- reprompt: never hashed behind the prompt back ---------------------
  {
    const guarded = { ...ENTRY, reprompt: 1 }
    const ungranted = makeGateway({ vault: { items: [guarded] } })
    check('a reprompt entry is not hashed before its prompt is cleared', (await ungranted.gateway.maskIndex()).size === 0)
    const granted = makeGateway({ vault: { items: [guarded] }, granted: ['item-1'] })
    check('once cleared in this session it resolves', Boolean(lookupFingerprint(await granted.gateway.maskIndex(), FINGERPRINT)))
    // A client that cannot answer the question must not be read as granted.
    const noMethod = makeGateway({ vault: { items: [guarded] } })
    noMethod.client.repromptGrantedFor = undefined
    check('a client that cannot answer the prompt stays a miss', (await noMethod.gateway.maskIndex()).size === 0)
  }

  // -- the index follows the vault, not the clock ------------------------
  {
    const { gateway, state } = makeGateway({ vault: { items: [ENTRY] } })
    const first = await gateway.maskIndex()
    const second = await gateway.maskIndex()
    // The vault identity is the cache key, so answering "same vault?" costs an
    // unlock either way (VaultClient hands back the cached vault). What the cache
    // saves is the rebuild: one HMAC per field, 14-65 ms for a vault this size.
    check('one unlocked vault reuses its index', first === second, 'rebuilt')
    check('asking twice does not rebuild', first.size === second.size && first === second, String(first.size))
    // A re-unlock (cache expiry, sync, lock + unlock) hands back a NEW object,
    // and the index has to be rebuilt: the plaintext it was built from is gone.
    state.vault = { items: [{ id: 'item-1', name: 'renamed', password: 'a-different-secret' }] }
    const third = await gateway.maskIndex()
    check('a new vault object rebuilds the index', third !== first && third.size > 0, String(state.unlockCalls))
    check('the rebuilt index no longer answers for the old value', lookupFingerprint(third, FINGERPRINT) === null, JSON.stringify(lookupFingerprint(third, FINGERPRINT)))
  }

  // -- a rotated mask key must not answer with the cached index ---------
  {
    const { gateway } = makeGateway({ vault: { items: [ENTRY] } })
    await gateway.maskIndex()
    gateway.maskKey = () => Buffer.alloc(32, 9)
    const rotated = await gateway.maskIndex()
    check('a rotated mask key rebuilds it too', rotated !== null && lookupFingerprint(rotated, FINGERPRINT) === null)
  }

  // -- what the page actually receives ----------------------------------
  {
    const detail = { ok: true, values: [{ fingerprint: FINGERPRINT }, { fingerprint: 'M|9f3ab21c' }] }
    const index = await makeGateway({ vault: { items: [ENTRY] } }).gateway.maskIndex()
    const filled = attachOrigins(detail, index)
    check('a placeholder carries its entry', Boolean(filled.values[0].origin) && filled.values[0].origin.itemId === 'item-1')
    check('a marker has no entry to name', filled.values[1].origin === null)
    check('the row is passed through untouched', filled.values[0].fingerprint === FINGERPRINT && filled.ok === true)
    const bare = attachOrigins(detail, null)
    check('no index leaves every value with origin null', bare.values.every((value) => value.origin === null))
    check('a row that could not be found is returned as-is', attachOrigins({ ok: false, reason: 'not-found' }, index).reason === 'not-found')
  }

  console.log('')
  console.log('trail-origin: ' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
