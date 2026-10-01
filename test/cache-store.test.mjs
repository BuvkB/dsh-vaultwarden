/**
 * Vault cache test: the encrypted-at-rest payload on disk plus the
 * revision-date fast path that decides whether it can be trusted.
 *
 * Two layers are covered:
 *   1. CacheStore — atomic 0600 writes, gzip envelope, account checks,
 *      damage handling, the 7-day trust window, enabled/disabled.
 *   2. VaultClient — a cold start downloads once and stores the payload;
 *      the next start serves the cache and probes instead of downloading;
 *      a moved revision, a failed probe, an aged record or a damaged file
 *      each fall back to a full sync; sign-out and account switches drop it.
 *
 * Run: node test/cache-store.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { CacheStore, MAX_TRUST_MS, defaultCachePath } from '../lib/cache-store.js'
import { SessionStore } from '../lib/session-store.js'
import { VaultClient } from '../lib/vault.js'
import { EMAIL, PASSWORD, startMockServer } from './mock-server.mjs'

let passed = 0
let failed = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
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

async function waitFor(condition, { timeout = 8000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await sleep(interval)
  }
}

/** A throwaway home for one cache file plus one session file. */
function scratchDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `vw-${label}-`))
  return {
    dir,
    cachePath: join(dir, 'vault-cache.json.gz'),
    sessionPath: join(dir, 'session.json'),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const modeOf = (path) => statSync(path).mode & 0o777

const readCache = (path) => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))

async function unitChecks() {
  // ── CacheStore: envelope, account checks, damage, enabled ─────────────────
  check('default path lands in the plugin data dir', defaultCachePath('/home/x') === '/home/x/data/dsh-vaultwarden/vault-cache.json.gz', defaultCachePath('/home/x'))

  const scratch = scratchDir('unit')
  const store = new CacheStore(scratch.cachePath)
  const payload = { profile: { key: 'k' }, ciphers: [{ id: 'cipher-1' }], folders: [] }
  const record = { serverUrl: 'https://vault.example', email: EMAIL, savedAt: Date.now(), revision: 42, payload }

  check('save reports success and creates the file', store.save(record) === true && existsSync(scratch.cachePath))
  check('the cache file is private (0600)', modeOf(scratch.cachePath) === 0o600, modeOf(scratch.cachePath).toString(8))

  const loaded = store.load({ serverUrl: 'https://vault.example', email: EMAIL })
  check('load returns the stored record', loaded?.revision === 42 && loaded?.payload?.ciphers?.length === 1, JSON.stringify(loaded?.revision))
  check('the stored payload is still the server ciphertext (not plaintext)', JSON.stringify(loaded?.payload) === JSON.stringify(payload))
  check('a matching record inside the window is trusted', store.trusted(loaded) === true)

  check('another server is refused, keeping the file', store.load({ serverUrl: 'https://other', email: EMAIL }) === null && existsSync(scratch.cachePath))
  check('another account is refused', store.load({ serverUrl: 'https://vault.example', email: 'someone@example.com' }) === null)
  check('the email comparison is case-insensitive', store.load({ serverUrl: 'https://vault.example', email: 'DSH-Test@Example.com' }) !== null)
  check('load without expectations skips the account check', store.load()?.revision === 42)

  check('an aged record is not trusted', store.trusted({ ...record, savedAt: Date.now() - MAX_TRUST_MS - 1000 }) === false)
  check('exactly at the window edge it is still trusted', store.trusted({ ...record, savedAt: Date.now() - MAX_TRUST_MS + 60_000 }) === true)
  check('a record without a usable timestamp is not trusted', store.trusted({ ...record, savedAt: 'yesterday' }) === false)
  check('no record means no trust', store.trusted(null) === false)

  writeFileSync(scratch.cachePath, 'this is not gzip')
  check('garbage is discarded and removed', store.load({}) === null && !existsSync(scratch.cachePath))

  writeFileSync(scratch.cachePath, gzipSync(JSON.stringify({ ...record, version: 99 })))
  check('a future envelope version is discarded', store.load({}) === null && !existsSync(scratch.cachePath))

  writeFileSync(scratch.cachePath, gzipSync(JSON.stringify({ ...record, payload: 'nope' })))
  check('a payload that is not an object is discarded', store.load({}) === null && !existsSync(scratch.cachePath))

  check('saving an empty payload is refused', store.save({ ...record, payload: null }) === false && !existsSync(scratch.cachePath))

  const off = new CacheStore(scratch.cachePath, { enabled: false })
  check('a disabled store reports itself disabled', off.disabled === true)
  check('a disabled store never writes', off.save(record) === false && !existsSync(scratch.cachePath))
  check('a disabled store never loads', off.load() === null)
  check('a disabled store never trusts', off.trusted(record) === false)
  check('describe() of a disabled store is honest', JSON.stringify(off.describe(record)) === '{"enabled":false,"stored":false}')

  store.save(record)
  const described = store.describe(store.load({}))
  check('describe() reports the file, location and trust window', described.enabled === true && described.stored === true && described.path === scratch.cachePath && described.maxTrustDays === 7, JSON.stringify(described))
  check('describe() reports the recorded revision', described.revision === 42 && typeof described.savedAt === 'string')

  store.clear()
  check('clear() removes the file', !existsSync(scratch.cachePath) && store.load({}) === null)

  scratch.dispose()
}

async function main() {
  console.log('vault cache test (encrypted-at-rest payload + revision probe)')
  await unitChecks()

  const server = await startMockServer()
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }

  const settings = settingsFor(server)
  const scratch = scratchDir('client')
  const session = new SessionStore(scratch.sessionPath, { maxAgeDays: 30 })
  const makeClient = (options = {}) =>
    new VaultClient(settings, { sessionStore: session, cacheStore: new CacheStore(scratch.cachePath, options) })

  // ── cold start: one download, one stored payload ──────────────────────────
  const cold = makeClient()
  const syncs0 = server.stats.syncs
  const checks0 = server.stats.revisionChecks
  const coldVault = await cold.unlock()
  const coldItems = coldVault.items.length
  check('a cold start downloads the vault once', server.stats.syncs - syncs0 === 1 && coldItems === 4, `syncs +${server.stats.syncs - syncs0}, items ${coldItems}`)
  check('the cold start reads the revision before downloading', server.stats.revisionChecks - checks0 === 1, `probes +${server.stats.revisionChecks - checks0}`)
  check('the cold start stores the payload', existsSync(scratch.cachePath) && modeOf(scratch.cachePath) === 0o600)
  const stored = readCache(scratch.cachePath)
  check('the stored revision matches the server', stored.revision === server.revision(), `${stored.revision} vs ${server.revision()}`)
  check('the stored payload looks like a sync response', Array.isArray(stored.payload?.ciphers) && stored.payload.ciphers.length === 4)
  check('the stored payload is ciphertext only', !JSON.stringify(stored).includes('gh-p@ssw0rd-42') && !JSON.stringify(stored).includes('SSH 部署密钥') && JSON.stringify(stored).includes('cipher-github'))
  check('the stored record names the account', stored.email === EMAIL && stored.serverUrl === server.url)

  // ── warm start: cache served, probe says unchanged, no download ───────────
  const warm = makeClient()
  const syncs1 = server.stats.syncs
  const checks1 = server.stats.revisionChecks
  const warmVault = await warm.unlock()
  check('a warm start serves the cache', warmVault.items.length === coldItems && warmVault.cached === true)
  const probed = await waitFor(() => server.stats.revisionChecks > checks1)
  check('a warm start still probes the revision', probed, `probes +${server.stats.revisionChecks - checks1}`)
  await sleep(300)
  check('an unchanged revision skips the download entirely', server.stats.syncs === syncs1, `syncs +${server.stats.syncs - syncs1}`)
  const warmReport = JSON.parse(await warm.status())
  check('status() reports the cache and its age', warmReport.cached === true && warmReport.cache?.enabled === true && warmReport.cache?.stored === true && warmReport.cache?.revision === server.revision(), JSON.stringify(warmReport.cache))
  check('status() dates the cached data from the file, not from now', warmReport.syncedAt === new Date(stored.savedAt).toISOString(), warmReport.syncedAt)

  // ── a moved revision: cache first, then one replacement download ──────────
  const moved = server.bumpRevision()
  const changed = makeClient()
  const syncs2 = server.stats.syncs
  const changedVault = await changed.unlock()
  check('a moved revision still serves the cache first', changedVault.cached === true && changedVault.items.length === coldItems)
  const resynced = await waitFor(() => server.stats.syncs > syncs2)
  check('a moved revision triggers one background download', resynced, `syncs +${server.stats.syncs - syncs2}`)
  const refreshed = await waitFor(() => readCache(scratch.cachePath).revision === moved)
  check('the replacement download refreshes the stored revision', refreshed, `stored ${readCache(scratch.cachePath).revision} vs ${moved}`)
  const changedReport = JSON.parse(await changed.status())
  check('the vault in memory is no longer marked cached', changedReport.cached === false)

  // ── a failing probe is never read as "unchanged" ──────────────────────────
  server.failRevision(true)
  const probeDown = makeClient()
  const syncs3 = server.stats.syncs
  const downVault = await probeDown.unlock()
  check('a failing probe still serves the cache', downVault.cached === true)
  const fellBack = await waitFor(() => server.stats.syncs > syncs3)
  check('a failing probe falls back to a full download', fellBack, `syncs +${server.stats.syncs - syncs3}`)
  const nulled = await waitFor(() => readCache(scratch.cachePath).revision === null)
  check('a download without a revision stores revision: null', nulled, `stored ${JSON.stringify(readCache(scratch.cachePath).revision)}`)

  server.failRevision(false)
  const afterNull = makeClient()
  const syncs4 = server.stats.syncs
  const nullVault = await afterNull.unlock()
  check('a null revision still serves the cache first', nullVault.cached === true)
  const repaired = await waitFor(() => server.stats.syncs > syncs4)
  check('a null revision never authorises the fast path', repaired, `syncs +${server.stats.syncs - syncs4}`)
  const realRevision = await waitFor(() => typeof readCache(scratch.cachePath).revision === 'number')
  check('the next download restores a real revision', realRevision, `stored ${JSON.stringify(readCache(scratch.cachePath).revision)}`)

  // ── the 7-day trust window overrides an unchanged revision ────────────────
  const aged = new CacheStore(scratch.cachePath)
  const agedRecord = aged.load({})
  aged.save({ ...agedRecord, savedAt: Date.now() - MAX_TRUST_MS - 60_000 })
  const stale = makeClient()
  const syncs5 = server.stats.syncs
  const staleVault = await stale.unlock()
  check('an aged cache is still served (it is only suspect)', staleVault.cached === true)
  const forced = await waitFor(() => server.stats.syncs > syncs5)
  check('an unchanged revision past 7 days forces a download', forced, `syncs +${server.stats.syncs - syncs5}`)
  check('the forced download re-dates the cache', readCache(scratch.cachePath).savedAt > Date.now() - 60_000)

  // ── damage on disk never reaches the user ────────────────────────────────
  writeFileSync(scratch.cachePath, 'corrupted on purpose')
  const damaged = makeClient()
  const syncs6 = server.stats.syncs
  const damagedVault = await damaged.unlock()
  check('a damaged cache falls back to a clean download', damagedVault.items.length === coldItems && damagedVault.cached !== true && server.stats.syncs - syncs6 === 1)
  check('the damaged file is replaced by a valid one', Array.isArray(readCache(scratch.cachePath).payload?.ciphers))

  // ── the cache follows the account ────────────────────────────────────────
  const other = await startMockServer()
  const switched = makeClient()
  await switched.unlock()
  check('the cache exists before the switch', existsSync(scratch.cachePath))
  switched.reconfigure(settingsFor(other))
  check('switching accounts drops the other account\'s payload', !existsSync(scratch.cachePath))
  const syncs7 = other.stats.syncs
  const otherVault = await switched.unlock()
  check('the switched client downloads from the new server', otherVault.cached !== true && other.stats.syncs - syncs7 === 1 && existsSync(scratch.cachePath))

  const signedOut = makeClient()
  await signedOut.unlock()
  signedOut.invalidate()
  check('signing out drops the cache', !existsSync(scratch.cachePath) && signedOut.vault === null)

  // ── disabled: no cache at all, no probe, one download every time ─────────
  const plain = scratchDir('plain')
  const plainSession = new SessionStore(plain.sessionPath, { maxAgeDays: 30 })
  const offClient = new VaultClient(settings, { sessionStore: plainSession, cacheStore: new CacheStore(plain.cachePath, { enabled: false }) })
  const syncs8 = server.stats.syncs
  const checks8 = server.stats.revisionChecks
  await offClient.unlock()
  await offClient.unlock()
  check('a disabled cache writes nothing', !existsSync(plain.cachePath))
  check('a disabled cache skips the probe', server.stats.revisionChecks === checks8, `probes +${server.stats.revisionChecks - checks8}`)
  const offReport = JSON.parse(await offClient.status())
  check('status() tells the panel the cache is off', offReport.cache?.enabled === false && offReport.cache?.stored === false)
  const plainAgain = new VaultClient(settings, { sessionStore: plainSession, cacheStore: null })
  await plainAgain.unlock()
  check('a client without a cache store behaves as before', existsSync(plain.cachePath) === false && server.stats.syncs > syncs8)

  await other.close()
  await server.close()
  scratch.dispose()
  plain.dispose()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
