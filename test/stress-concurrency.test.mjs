/**
 * Stress: concurrency and races around the vault client.
 *
 * These are the interleavings a single-threaded UI never shows but a process
 * with tool calls, a panel and a live-sync poller absolutely does: an unlock
 * that straddles a sign-out or a settings change, a write landing on the same
 * cache file a sync is rewriting, readers walking the list while a writer
 * replaces rows, and a burst of logins for the same account.
 *
 * The bar every case is held to: no crash, no half-installed vault, no file
 * damage, and never another account's rows.
 *
 * Run: node test/stress-concurrency.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { CacheStore } from '../lib/cache-store.js'
import { VaultMutations } from '../lib/mutations.js'
import { SessionStore } from '../lib/session-store.js'
import { VaultClient } from '../lib/vault.js'
import { EMAIL, PASSWORD, startMockServer } from './mock-server.mjs'

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const settingsFor = (server, extra = {}) => ({
  serverUrl: server.url,
  email: EMAIL,
  masterPassword: PASSWORD,
  apiKeyClientId: '',
  apiKeyClientSecret: '',
  cacheMinutes: 30,
  ...extra,
})

async function waitFor(condition, { timeout = 8000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await sleep(interval)
  }
}

function scratchDir(label) {
  const dir = mkdtempSync(join(tmpdir(), 'vw-stress-race-' + label + '-'))
  return {
    dir,
    cachePath: join(dir, 'vault-cache.json.gz'),
    sessionPath: join(dir, 'session.json'),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const watchdogFetch = async (url, init) => {
  try {
    return await fetch(url, init)
  } catch (error) {
    console.error('  ! transport failure ' + String(url) + ' → ' + (error?.cause?.code ?? error?.cause?.message ?? error?.message))
    throw error
  }
}

const readCache = (path) => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))
const section = (title) => console.log('\n' + title)

async function main() {
  console.log('vault concurrency stress: sign-out races · cache writes · mixed reads and writes · logins')

  const server = await startMockServer()
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }
  // A second account-shaped server: it holds one cipher fewer, so "which
  // account answered" is a countable fact rather than a guess.
  const other = await startMockServer({ legacyCipher: false })

  const scratch = scratchDir('main')
  const scratchB = scratchDir('other')
  const session = new SessionStore(scratch.sessionPath, { maxAgeDays: 30 })
  const sessionB = new SessionStore(scratchB.sessionPath, { maxAgeDays: 30 })

  const makeClient = (target, store, cachePath, options = {}) =>
    new VaultClient(settingsFor(target, options.settings), {
      fetch: options.fetch ?? watchdogFetch,
      sessionStore: store,
      cacheStore: new CacheStore(cachePath ?? scratch.cachePath, options.cacheOptions),
      ...options.extra,
    })

  try {
    // ── 1. A sign-out landing inside an unlock: two different windows ────────
    section('unlock against a concurrent sign-out')
    // 1a. The sign-out lands while the LOGIN is in flight. login() records the
    // session generation before its first await and refuses to hand the token
    // over if a sign-out overtook it, so this window rejects on purpose.
    const signoutDir = scratchDir('signout')
    const signoutClient = new VaultClient(settingsFor(server), {
      fetch: watchdogFetch,
      sessionStore: new SessionStore(signoutDir.sessionPath, { maxAgeDays: 30 }),
      cacheStore: new CacheStore(signoutDir.cachePath),
    })
    const duringLogin = signoutClient.unlock()
    await sleep(40)
    signoutClient.invalidate({ keepStored: true })
    const loginOutcome = await duringLogin.then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    )
    check(
      'a sign-out during login refuses the token (login_superseded)',
      loginOutcome.status === 'rejected' && loginOutcome.error?.code === 'login_superseded',
      loginOutcome.status === 'rejected' ? String(loginOutcome.error?.code) : 'resolved',
    )
    check('the refused login installs no vault', signoutClient.vault === null)
    check('the refused login leaves no token behind', signoutClient.token === null)
    check('the refused login writes no cache file', !existsSync(signoutDir.cachePath))
    // FIXED: a refused login arms the 60 s retry cooldown in ensureToken, and
    // invalidate() used to leave it armed — so an explicit sign-out followed by
    // an immediate unlock on the SAME client was refused with session_expired
    // for a minute afterwards. That cooldown belongs to the attempt being
    // dropped, not to the caller who starts the next one, so invalidate() now
    // clears it (along with the re-prompt back-off and the touch throttle).
    const afterSignOut = await signoutClient.unlock().then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    )
    check(
      'a sign-out clears the login retry cooldown',
      afterSignOut.status === 'fulfilled' && afterSignOut.value?.items?.length === 4,
      afterSignOut.status === 'fulfilled' ? 'items ' + afterSignOut.value?.items?.length : String(afterSignOut.error?.code),
    )
    // A fresh client (as after a plugin restart) is unaffected by that cooldown.
    const recovered = await new VaultClient(settingsFor(server), {
      fetch: watchdogFetch,
      sessionStore: new SessionStore(signoutDir.sessionPath, { maxAgeDays: 30 }),
      cacheStore: new CacheStore(signoutDir.cachePath),
    }).unlock()
    check('a fresh client still works after the refusal', recovered.items.length === 4, String(recovered.items.length))
    check('the next unlock writes the cache it refused before', existsSync(signoutDir.cachePath))
    signoutDir.dispose()

    // 1b. The sign-out lands AFTER the login, while the download is in flight.
    // The download completes, #adopt sees a moved generation and returns the
    // vault without installing it — so the ciphertext must not reach the disk.
    const lateDir = scratchDir('late')
    const slowSyncFetch = async (url, init) => {
      if (String(url).includes('/api/sync')) await sleep(300)
      return watchdogFetch(url, init)
    }
    const lateClient = new VaultClient(settingsFor(server), {
      fetch: slowSyncFetch,
      sessionStore: new SessionStore(lateDir.sessionPath, { maxAgeDays: 30 }),
      cacheStore: new CacheStore(lateDir.cachePath),
    })
    const duringDownload = lateClient.unlock()
    // Wait for the token to exist: everything after that point is the download.
    check('the login finished before the sign-out landed', await waitFor(() => Boolean(lateClient.token), { timeout: 4000 }))
    lateClient.invalidate({ keepStored: true })
    const downloadOutcome = await duringDownload.then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    )
    check('a sign-out during download settles without throwing', downloadOutcome.status === 'fulfilled', String(downloadOutcome.error?.message ?? ''))
    check('the abandoned download still decrypted its rows', downloadOutcome.value?.items?.length === 4, String(downloadOutcome.value?.items?.length))
    check('the abandoned download installs nothing', lateClient.vault === null)
    check('the abandoned download leaves no token behind', lateClient.token === null)
    check('the abandoned download writes no cache file', !existsSync(lateDir.cachePath))
    await sleep(200)
    check('no late cache write lands afterwards either', !existsSync(lateDir.cachePath))
    lateDir.dispose()

    // ── 2. An unlock straddling a switch to another server ───────────────────
    section('unlock against a concurrent reconfigure')
    const client = makeClient(server, session, scratch.cachePath)
    const before = await client.unlock()
    check('the first account loads its own vault', before.items.length === 4, String(before.items.length))

    const straddling = client.syncNow()
    await sleep(30)
    client.reconfigure(settingsFor(other))
    const orphan = await straddling
    check('the abandoned sync still resolves', Boolean(orphan))
    check('the abandoned sync does not install another account view', client.vault === null)
    check('the switch dropped the previous cache file', !existsSync(scratch.cachePath))

    const switched = await client.unlock()
    check('the new server answers after the switch', switched.items.length === 3, String(switched.items.length))
    check('no row from the previous account survives', !switched.raw.has('cipher-legacy'))
    const switchedRecord = readCache(scratch.cachePath)
    check('the new cache file names the new server', switchedRecord.serverUrl === other.url, switchedRecord.serverUrl)
    check('the new cache file holds only the new account rows', switchedRecord.payload.ciphers.length === 3, String(switchedRecord.payload.ciphers.length))

    // ── 3. patchCachedCipher racing syncNow on the same file ─────────────────
    section('cache writes racing a sync')
    const raceDir = scratchDir('race')
    const raceSession = new SessionStore(raceDir.sessionPath, { maxAgeDays: 30 })
    const raceClient = new VaultClient(settingsFor(server), {
      fetch: watchdogFetch,
      sessionStore: raceSession,
      cacheStore: new CacheStore(raceDir.cachePath),
    })
    const raceVault = await raceClient.unlock()
    const githubRaw = raceVault.raw.get('cipher-github')
    check('the raced cache starts from a stored record', existsSync(raceDir.cachePath))
    check('the cipher to patch is available in the raw payload', Boolean(githubRaw))

    const patched = raceClient.patchCachedCipher({ ...githubRaw, revisionDate: '2026-03-03T00:00:00.000Z' })
    check('a known cipher patches the stored record', patched === true, String(patched))
    check('an unknown id is refused', raceClient.patchCachedCipher({ id: 'not-in-this-vault' }) === false)

    const writers = []
    for (let i = 0; i < 24; i++) {
      writers.push(
        (async () => {
          await sleep(i % 4)
          raceClient.patchCachedCipher({ ...githubRaw, revisionDate: new Date(1_800_000_000_000 + i * 1000).toISOString() })
        })(),
      )
    }
    const syncs = [raceClient.syncNow(), raceClient.syncNow(), raceClient.syncNow()]
    const storm = await Promise.allSettled([...writers, ...syncs])
    const stormFailures = storm.filter((entry) => entry.status === 'rejected')
    check('no writer or sync rejects during the storm', stormFailures.length === 0, stormFailures.map((e) => String(e.reason?.message ?? e.reason)).join(' | '))

    let reloaded = null
    let reloadError = null
    try {
      reloaded = new CacheStore(raceDir.cachePath).load({ serverUrl: server.url, email: EMAIL })
    } catch (error) {
      reloadError = error
    }
    check('the raced cache file still parses', reloadError === null, String(reloadError?.message ?? ''))
    check('the raced cache file still verifies', Boolean(reloaded))
    check('the raced cache file keeps every cipher', reloaded?.payload?.ciphers?.length === 4, String(reloaded?.payload?.ciphers?.length))
    const leak = readFileSync(raceDir.cachePath).toString('latin1')
    check('the raced cache still holds ciphertext only', !leak.includes('gh-p@ssw0rd-42'))
    const afterStorm = await new VaultClient(settingsFor(server), {
      fetch: watchdogFetch,
      sessionStore: new SessionStore(raceDir.sessionPath, { maxAgeDays: 30 }),
      cacheStore: new CacheStore(raceDir.cachePath),
    }).unlock()
    check('a cold start after the storm decrypts the raced file', afterStorm.items.length === 4, String(afterStorm.items.length))
    raceDir.dispose()

    // ── 4. Readers walking the list while a writer replaces rows ─────────────
    section('concurrent reads against interleaved writes')
    const mixDir = scratchDir('mix')
    const mixSession = new SessionStore(mixDir.sessionPath, { maxAgeDays: 30 })
    const mixClient = new VaultClient(settingsFor(server), {
      fetch: watchdogFetch,
      sessionStore: mixSession,
      cacheStore: new CacheStore(mixDir.cachePath),
    })
    await mixClient.unlock()
    const mutations = new VaultMutations(mixClient, { guard: () => null })

    const readPayloads = []
    const readErrors = []
    const readers = Array.from({ length: 4 }, (_, index) =>
      (async () => {
        for (let round = 0; round < 8; round++) {
          try {
            const payload = await mixClient.findEntries('', 100, 0, undefined, {
              section: index % 2 === 0 ? 'all' : 'favorites',
            })
            readPayloads.push(payload)
          } catch (error) {
            readErrors.push(String(error?.message ?? error))
          }
          await sleep(5)
        }
      })(),
    )
    const writeErrors = []
    const writersLive = [
      (async () => {
        for (let round = 0; round < 4; round++) {
          try {
            await mutations.update('cipher-db', { name: '生产数据库口令 r' + round })
          } catch (error) {
            writeErrors.push(String(error?.message ?? error))
          }
          await sleep(7)
        }
      })(),
      (async () => {
        for (let round = 0; round < 4; round++) {
          try {
            await mutations.update('cipher-github', { notes: 'SSH 部署密钥在 CI 里 #' + round })
          } catch (error) {
            writeErrors.push(String(error?.message ?? error))
          }
          await sleep(9)
        }
      })(),
    ]
    await Promise.all([...readers, ...writersLive])
    check('every interleaved read resolves', readErrors.length === 0, readErrors.join(' | '))
    check('every interleaved write lands', writeErrors.length === 0, writeErrors.join(' | '))
    check('every interleaved read returned rows', readPayloads.length === 32, String(readPayloads.length))
    check(
      'every interleaved read is a well-formed payload',
      readPayloads.every((p) => typeof p === 'object' && Array.isArray(p.items) && typeof p.matched === 'number'),
    )
    check(
      'no interleaved read reports a duplicated row',
      readPayloads.every((p) => new Set(p.items.map((i) => i.id)).size === p.items.length),
    )
    const settledVault = await mixClient.unlock()
    check('the vault still holds every cipher after the mix', settledVault.items.length === 4, String(settledVault.items.length))
    check('the written name is what the list now shows', settledVault.byId.get('cipher-db')?.name === '生产数据库口令 r3', settledVault.byId.get('cipher-db')?.name)
    const settledCache = new CacheStore(mixDir.cachePath).load({ serverUrl: server.url, email: EMAIL })
    check('the mixed-write cache file still verifies', Boolean(settledCache))
    check('the mixed-write cache file names this server only', settledCache?.serverUrl === server.url)
    mixDir.dispose()

    // ── 5. The same account logging in several times at once ────────────────
    section('repeated concurrent logins')
    const loginDir = scratchDir('login')
    const loginClient = new VaultClient(settingsFor(server), {
      fetch: watchdogFetch,
      sessionStore: new SessionStore(loginDir.sessionPath, { maxAgeDays: 30 }),
      cacheStore: new CacheStore(loginDir.cachePath),
    })
    const grantsBefore = server.stats.tokenGrants.length
    const logins = await Promise.allSettled([loginClient.login(), loginClient.login(), loginClient.login()])
    check('three concurrent logins all settle', logins.length === 3)
    check('no concurrent login rejects', logins.every((entry) => entry.status === 'fulfilled'), logins.map((e) => String(e.reason?.message ?? '')).join(' | '))
    check('every login obtained its own grant', server.stats.tokenGrants.length === grantsBefore + 3, String(server.stats.tokenGrants.length - grantsBefore))
    check('one token survived the burst', Boolean(loginClient.token?.accessToken))
    const afterLogins = await loginClient.unlock()
    check('the surviving token unlocks the vault', afterLogins.items.length === 4, String(afterLogins.items.length))
    check('the burst wrote one usable cache file', existsSync(loginDir.cachePath))
    const loginCache = new CacheStore(loginDir.cachePath).load({ serverUrl: server.url, email: EMAIL })
    check('the cache from the login burst verifies', Boolean(loginCache))
    loginDir.dispose()

    // ── 6. Two accounts, two directories, no shared rows ────────────────────
    section('two accounts in parallel')
    const parallelA = new VaultClient(settingsFor(server), {
      fetch: watchdogFetch,
      sessionStore: session,
      cacheStore: new CacheStore(scratch.cachePath),
    })
    const parallelB = new VaultClient(settingsFor(other), {
      fetch: watchdogFetch,
      sessionStore: sessionB,
      cacheStore: new CacheStore(scratchB.cachePath),
    })
    const [vaultA, vaultB] = await Promise.all([parallelA.unlock(), parallelB.unlock()])
    check('account A sees its four rows', vaultA.items.length === 4, String(vaultA.items.length))
    check('account B sees its three rows', vaultB.items.length === 3, String(vaultB.items.length))
    check('account A keeps the row B does not have', vaultA.raw.has('cipher-legacy'))
    check('account B never received the row A has', !vaultB.raw.has('cipher-legacy'))
    check('account A cache names server A', readCache(scratch.cachePath).serverUrl === server.url)
    check('account B cache names server B', readCache(scratchB.cachePath).serverUrl === other.url)
    check(
      'the two cache files hold different row counts',
      readCache(scratch.cachePath).payload.ciphers.length !== readCache(scratchB.cachePath).payload.ciphers.length,
    )
    scratchB.dispose()
  } finally {
    await other.close?.()
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
