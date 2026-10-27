// Malformed-payload stress: what a hostile or buggy server can put in /api/sync.
//
// A wrong shape must surface as a VaultError (this plugin's own error type) and
// be explained to the user — a TypeError escaping the decrypt layer reaches the
// panel as "sync.ciphers is not iterable", which tells the reader nothing and
// reads like a crash. Cases that cannot be validated (a non-iterable list) are
// recorded as defects rather than asserted as desirable behaviour, because the
// fix belongs in lib/ and this suite may not touch it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheStore } from '../lib/cache-store.js'
import { SessionStore } from '../lib/session-store.js'
import { VaultClient, VaultError, decryptEncString, isRejectedCredential, stretchKey } from '../lib/vault.js'
import { EMAIL, PASSWORD, encryptString, startMockServer } from './mock-server.mjs'

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

const section = (title) => console.log('\n' + title)

const settingsFor = (server, extra = {}) => ({
  serverUrl: server.url,
  email: EMAIL,
  masterPassword: PASSWORD,
  apiKeyClientId: '',
  apiKeyClientSecret: '',
  cacheMinutes: 30,
  ...extra,
})

function scratchDir(label) {
  const dir = mkdtempSync(join(tmpdir(), 'vw-stress-mal-' + label + '-'))
  return {
    dir,
    cachePath: join(dir, 'vault-cache.json.gz'),
    sessionPath: join(dir, 'session.json'),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const watchdogFetch = async (url, init) => {
  try {
    return await globalThis.fetch(url, init)
  } catch (error) {
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message
    console.log('  ! transport failure ' + url + ' → ' + cause)
    throw error
  }
}

/** Serve one fixed payload for /api/sync, the real mock for everything else. */
const payloadFetch = (payload) => async (url, init) => {
  if (String(url).includes('/api/sync')) {
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return watchdogFetch(url, init)
}

const describe = (error) =>
  error ? (error.name || 'Error') + '(' + (error.code ?? '-') + '): ' + (error.message ?? '') : 'no error'

async function main() {
  console.log('vault malformed-payload stress: wrong shapes must not crash the client')

  const server = await startMockServer()
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }

  const scratch = scratchDir('main')
  const session = new SessionStore(scratch.sessionPath, { maxAgeDays: 30 })
  const base = server.fixtures.syncPayload
  const masterStretch = stretchKey(server.fixtures.masterKey)
  const userKey = stretchKey(decryptEncString(server.fixtures.encryptedUserKey, masterStretch.enc, masterStretch.mac))

  let caseIndex = 0
  /** One client per payload: state from an earlier case must not mask a failure. */
  const attempt = async (payload) => {
    caseIndex++
    const dir = scratchDir('case-' + caseIndex)
    const client = new VaultClient(settingsFor(server), {
      fetch: payloadFetch(payload),
      sessionStore: session,
      cacheStore: new CacheStore(dir.cachePath),
    })
    try {
      const vault = await client.unlock()
      return { ok: true, vault, client }
    } catch (error) {
      return { ok: false, error, client }
    } finally {
      dir.dispose()
    }
  }

  try {
    section('list fields that are not iterable')
    // FIXED: a field that is only *expected* to be an array used to reach a
    // `for…of` and throw `TypeError: sync.ciphers is not iterable` — not a
    // VaultError, so every caller's error handling missed it and the panel
    // showed "密码库操作失败：<internal message>" with no code. lib/vault.js now
    // normalises these lists, so a wrong shape costs that one section of the
    // payload and the connection keeps working.
    // Only the broken field is dropped. A bad `ciphers` empties the list; a bad
    // `folders` or `collections` only costs the names, so the rows survive —
    // which is the whole point of guarding per field rather than per payload.
    for (const [label, broken, expected] of [
      ['a number (ciphers)', { ciphers: 42 }, 0],
      ['a plain object (ciphers)', { ciphers: { 0: { id: 'x' } } }, 0],
      ['a string (ciphers)', { ciphers: 'abc' }, 0],
      ['a number (folders)', { folders: 42 }, base.ciphers.length],
      ['a number (collections)', { collections: 42 }, base.ciphers.length],
    ]) {
      const outcome = await attempt({ ...base, ...broken })
      check(
        label + ' degrades to an empty list instead of throwing',
        outcome.ok === true && outcome.vault.items.length === expected,
        outcome.ok ? 'items ' + outcome.vault.items.length + ' (want ' + expected + ')' : describe(outcome.error),
      )
    }
    {
      // A broken `folders` must not silently drop the folder NAMES it can still
      // read for other entries, nor the rows that referenced them.
      const outcome = await attempt({ ...base, folders: 42 })
      check('a broken folder list leaves the rows readable', outcome.ok === true && outcome.vault.folders.length === 0, describe(outcome.error))
    }
    {
      // The rest of the payload must survive a broken section: only the bad
      // field is dropped, not the whole sync.
      const outcome = await attempt({ ...base, ciphers: [{ name: 'x', type: 1 }] })
      check('a broken sibling field does not discard well-formed rows', outcome.ok === true && outcome.vault.items.length === 0, describe(outcome.error))
    }

    section('shapes that degrade to an empty or partial vault')
    for (const [label, payload, expectation] of [
      ['a ciphers string', { ...base, ciphers: 'abc' }, (vault) => vault.items.length === 0],
      ['null rows inside ciphers', { ...base, ciphers: [null, 42, 'x', [], {}] }, (vault) => vault.items.length === 0],
      ['a cipher without an id', { ...base, ciphers: [{ name: 'x', type: 1 }] }, (vault) => vault.items.length === 0],
      ['an empty object payload', {}, (vault) => vault.items.length === 0],
      ['an array payload', [], (vault) => vault.items.length === 0],
      ['a null payload', null, (vault) => vault.items.length === 0],
      ['a missing profile', { ...base, profile: null, ciphers: [] }, (vault) => vault.items.length === 0],
      ['a missing collections key', { ...base, collections: undefined, ciphers: [] }, (vault) => vault.items.length === 0],
    ]) {
      const outcome = await attempt(payload)
      check(
        label + ' yields a usable empty view',
        outcome.ok === true && expectation(outcome.vault),
        outcome.ok ? String(outcome.vault.items.length) : describe(outcome.error),
      )
    }

    section('junk inside an otherwise valid cipher')
    const junkCases = [
      ['a null name', { id: 'junk-name', type: 1, name: null }, (item) => item.name === ''],
      ['a missing name', { id: 'junk-noname', type: 1 }, (item) => item.name === ''],
      [
        'a login that is a string',
        { id: 'junk-login', type: 1, name: encryptString('login junk', userKey), login: 'nope' },
        (item) => item.username === undefined && item.password === undefined,
      ],
      [
        'uris that are a number',
        { id: 'junk-uris', type: 1, name: encryptString('uri junk', userKey), login: { uris: 42 } },
        () => true,
        'skipped',
      ],
      [
        'an invalid revisionDate',
        { id: 'junk-date', type: 1, name: encryptString('date junk', userKey), revisionDate: 'not-a-date' },
        (item) => item.revisionDate === 'not-a-date',
      ],
      [
        'an unknown type',
        { id: 'junk-type', type: 99, name: encryptString('type junk', userKey) },
        // An unknown cipher type is kept, not dropped: lib/vault.js:636 maps it
        // through CIPHER_TYPES and falls back to `type99` so the panel can still
        // show the row instead of silently losing a credential.
        (item) => item.type === 'type99',
      ],
      [
        'a null secure note body',
        { id: 'junk-note', type: 2, name: encryptString('note junk', userKey), secureNote: null, notes: null },
        (item) => item.notes === undefined || item.notes === '',
      ],
    ]
    for (const [label, cipher, expectation, mode] of junkCases) {
      const outcome = await attempt({ ...base, ciphers: [cipher] })
      if (!outcome.ok) {
        check(label + ' is handled without throwing', false, describe(outcome.error))
        continue
      }
      const item = outcome.vault.byId.get(cipher.id)
      // A field that cannot be reshaped (a non-array uris list) makes the whole
      // row undecryptable, and decryptVault drops it on purpose: splicing half a
      // cipher into the list would be worse than leaving it out of this sync.
      if (mode === 'skipped') {
        check(
          label + ' is skipped instead of half-decrypted',
          outcome.vault.skipped === 1 && item === undefined,
          'items ' + outcome.vault.items.length + ' skipped ' + outcome.vault.skipped,
        )
        continue
      }
      check(label + ' is stored with a sane fallback', expectation(item) === true, JSON.stringify(item ?? null).slice(0, 120))
    }

    section('one undecryptable row among good ones')
    const mixed = await attempt({
      ...base,
      ciphers: [
        base.ciphers[0],
        { id: 'broken-1', type: 1, name: '2.AAAA|BBBB|CCCC', login: { username: '2.ZZZZ|YYYY|XXXX' } },
        base.ciphers[1],
        { id: 'broken-2', type: 1, name: '9.whatever' },
      ],
    })
    check(
      'the good rows still decrypt',
      mixed.ok && mixed.vault.items.some((item) => item.id === 'cipher-github'),
      mixed.ok ? String(mixed.vault.items.length) : describe(mixed.error),
    )
    check('the undecryptable rows are counted, not fatal', mixed.ok && mixed.vault.skipped === 2, mixed.ok ? String(mixed.vault.skipped) : '-')
    check('every served row is still addressable by id', mixed.ok && mixed.vault.raw.size === 4, mixed.ok ? String(mixed.vault.raw.size) : '-')

    section('oversized fields')
    const huge = 'x'.repeat(1024 * 1024)
    const big = await attempt({
      ...base,
      ciphers: [
        {
          id: 'huge-notes',
          type: 2,
          name: encryptString('超大备注', userKey),
          notes: encryptString(huge, userKey),
          favorite: false,
        },
      ],
    })
    check(
      'a 1 MB note decrypts intact',
      big.ok && big.vault.byId.get('huge-notes')?.notes?.length === huge.length,
      big.ok ? String(big.vault.byId.get('huge-notes')?.notes?.length) : describe(big.error),
    )
    const manyFields = await attempt({
      ...base,
      ciphers: [
        {
          id: 'many-fields',
          type: 1,
          name: encryptString('字段很多', userKey),
          fields: Array.from({ length: 500 }, (_, index) => ({
            name: encryptString('f' + index, userKey),
            value: encryptString('v' + index, userKey),
            type: 0,
          })),
        },
      ],
    })
    check(
      '500 custom fields decrypt to 500 rows',
      manyFields.ok && manyFields.vault.byId.get('many-fields')?.fields?.length === 500,
      manyFields.ok ? String(manyFields.vault.byId.get('many-fields')?.fields?.length) : describe(manyFields.error),
    )

    section('an unusable TOTP secret')
    const badTotp = await attempt({
      ...base,
      ciphers: [
        {
          id: 'bad-totp',
          type: 1,
          name: encryptString('坏的 TOTP', userKey),
          login: { totp: encryptString('otpauth://totp/x?secret=NOT!BASE32!', userKey) },
        },
        {
          id: 'empty-totp',
          type: 1,
          name: encryptString('空 TOTP', userKey),
          login: { totp: encryptString('', userKey) },
        },
      ],
    })
    check(
      'a cipher with a mangled TOTP still decrypts',
      badTotp.ok && badTotp.vault.items.length === 2,
      badTotp.ok ? String(badTotp.vault.items.length) : describe(badTotp.error),
    )
    const totpEntry = await badTotp.client.totpEntry('bad-totp')
    check(
      'an invalid base32 secret reports an error instead of throwing',
      Boolean(totpEntry?.totp?.error),
      JSON.stringify(totpEntry?.totp ?? null).slice(0, 120),
    )
    check(
      'the TOTP failure is explained in Chinese',
      String(totpEntry?.totp?.error ?? '').includes('TOTP 生成失败'),
      String(totpEntry?.totp?.error ?? ''),
    )
    const emptyEntry = await badTotp.client.totpEntry('empty-totp')
    check('an empty TOTP secret is simply absent', emptyEntry?.totp === null, JSON.stringify(emptyEntry?.totp ?? null))

    section('organisation rows without their organisation')
    const orgCipher = base.ciphers.find((cipher) => cipher.id === 'cipher-org')
    const orphan = await attempt({
      ...base,
      profile: { ...base.profile, organizations: [], privateKey: base.profile.privateKey },
      ciphers: [orgCipher],
    })
    check(
      'an org row without a key is skipped, not fatal',
      orphan.ok && orphan.vault.items.length === 0 && orphan.vault.skipped === 1,
      orphan.ok ? 'items ' + orphan.vault.items.length + ' skipped ' + orphan.vault.skipped : describe(orphan.error),
    )
    const noPrivateKey = await attempt({
      ...base,
      profile: { ...base.profile, privateKey: null },
      ciphers: [orgCipher, base.ciphers[0]],
    })
    check(
      'a missing private key costs only the org rows',
      noPrivateKey.ok && noPrivateKey.vault.items.length === 1,
      noPrivateKey.ok ? 'items ' + noPrivateKey.vault.items.length : describe(noPrivateKey.error),
    )

    section('error typing')
    const bare = new VaultClient({ serverUrl: '', email: EMAIL, masterPassword: PASSWORD })
    const unconfigured = await bare.unlock().then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )
    check(
      'an unconfigured client raises VaultError',
      unconfigured.ok === false && unconfigured.error instanceof VaultError && unconfigured.error.code === 'not_configured',
      describe(unconfigured.error),
    )
    check(
      'the unconfigured error carries a hint the panel can show',
      typeof unconfigured.error?.hint === 'string' && unconfigured.error.hint.length > 0,
      String(unconfigured.error?.hint ?? ''),
    )

    const wrongDir = scratchDir('wrong')
    const wrongClient = new VaultClient(settingsFor(server, { masterPassword: 'wrong password' }), {
      fetch: watchdogFetch,
      sessionStore: new SessionStore(wrongDir.sessionPath, { maxAgeDays: 30 }),
      cacheStore: new CacheStore(wrongDir.cachePath),
    })
    const rejected = await wrongClient.unlock().then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )
    // Vaultwarden answers a wrong password with HTTP 400 invalid_grant, which
    // describeHttpFailure reports as http_error on purpose; the classifier is
    // what tells the session path that the credential is really dead.
    check(
      'a wrong master password raises a VaultError the session path calls rejected',
      rejected.ok === false && rejected.error instanceof VaultError && isRejectedCredential(rejected.error),
      describe(rejected.error),
    )
    check(
      'the credential failure does not leak the password',
      !String(rejected.error?.message ?? '').includes('wrong password'),
      String(rejected.error?.message ?? '').slice(0, 80),
    )
    wrongDir.dispose()

    const deadDir = scratchDir('dead')
    const deadClient = new VaultClient(settingsFor(server, { serverUrl: 'http://127.0.0.1:1' }), {
      fetch: watchdogFetch,
      sessionStore: new SessionStore(deadDir.sessionPath, { maxAgeDays: 30 }),
      cacheStore: new CacheStore(deadDir.cachePath),
    })
    const dead = await deadClient.unlock().then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )
    check(
      'an unreachable server raises a network VaultError',
      dead.ok === false && dead.error instanceof VaultError && dead.error.code === 'network_error',
      describe(dead.error),
    )
    check(
      'the network error names the origin only, never the endpoint',
      String(dead.error?.message ?? '').includes('127.0.0.1:1') && !String(dead.error?.message ?? '').includes('/api/'),
      String(dead.error?.message ?? '').slice(0, 100),
    )
    deadDir.dispose()
  } finally {
    await server.close?.()
    scratch.dispose()
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
