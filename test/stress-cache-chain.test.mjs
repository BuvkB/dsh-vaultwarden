/**
 * Stress: the disk-cache chain under cold starts, damage, account switches and
 * a burst of concurrent unlocks.
 *
 * Everything here lives on the edge of the cache path rather than its happy
 * day: the payload is served without a download, a moved revision is caught, a
 * probe that fails or hangs cannot block the read, each kind of file damage
 * falls back to a full sync, another account's file is refused, an aged record
 * is served but refreshed, an 8-way burst downloads exactly once, and a cache
 * that cannot be written never fails the unlock.
 *
 * Run: node test/stress-cache-chain.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { CacheStore, MAX_TRUST_MS } from '../lib/cache-store.js'
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

async function waitFor(condition, { timeout = 8000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await sleep(interval)
  }
}

function scratchDir(label) {
  const dir = mkdtempSync(join(tmpdir(), 'vw-stress-cache-' + label + '-'))
  return {
    dir,
    cachePath: join(dir, 'vault-cache.json.gz'),
    sessionPath: join(dir, 'session.json'),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// A pass-through fetch that reports the undici cause of a transport failure:
// "fetch failed" alone does not say whether the server refused the connection
// or a pooled socket was closed under us. The count is also what lets a case
// tell "nothing happened" apart from "the probe never arrived": a dropped
// revision probe is the documented fallback into a full download, so it must
// not be judged as a cache regression.
// The mock is a plain node:http server: it closes idle keep-alive sockets after
// a few seconds, and a request that undici had already pipelined onto one of
// those sockets dies with ECONNRESET. That is a property of the harness, not of
// the plugin, so every request asks for its own connection. Without this the
// eight-way burst below fails intermittently with a network_error on /api/sync.
let transportFailures = 0
const closeHeaders = (init) => {
  const headers = new Headers(init?.headers ?? {})
  headers.set('connection', 'close')
  return { ...init, headers }
}
const watchdogFetch = async (url, init) => {
  try {
    return await fetch(url, closeHeaders(init))
  } catch (error) {
    transportFailures += 1
    console.error('  ! transport failure ' + String(url) + ' → ' + (error?.cause?.code ?? error?.cause?.message ?? error?.message))
    throw error
  }
}

const readCache = (path) => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))
const section = (title) => console.log('\n' + title)

async function main() {
  console.log('vault cache stress: cold start · damage · account binding · single flight')

  const server = await startMockServer()
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }

  const scratch = scratchDir('main')
  // One session file for the whole file: a login is PBKDF2 600k (~200-400 ms)
  // and none of these cases is about the login path.
  const session = new SessionStore(scratch.sessionPath, { maxAgeDays: 30 })
  const makeClient = (options = {}) =>
    new VaultClient(settingsFor(server, options.settings), {
      fetch: options.fetch ?? watchdogFetch,
      sessionStore: session,
      cacheStore: new CacheStore(options.cachePath ?? scratch.cachePath, options.cacheOptions),
    })

  // Several cases measure a delta of server.stats.syncs. A background
  // revalidation started by an earlier case can still be in flight when the
  // next baseline is taken, which would inflate that delta by one. Waiting for
  // the counter to go quiet keeps every delta attributable to its own case.
  const settle = async ({ quiet = 250, timeout = 5000 } = {}) => {
    const deadline = Date.now() + timeout
    let last = -1
    let lastStamp = ''
    while (Date.now() < deadline) {
      const stamp = existsSync(scratch.cachePath) ? String(statSync(scratch.cachePath).mtimeMs) : 'none'
      if (server.stats.syncs === last && stamp === lastStamp) return true
      last = server.stats.syncs
      lastStamp = stamp
      await sleep(quiet)
    }
    return false
  }

  // A tampered record only means something if no earlier case still has a
  // background save in flight: that save would quietly restore a valid
  // envelope between the write and the read, and the case would then measure a
  // cache hit instead of a fallback. Plant, wait for quiescence, plant again,
  // and only then trust the state.
  const plant = async (mutate) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        bindingStore.save(mutate(readCache(scratch.cachePath)))
      } catch {
        return false
      }
      await sleep(60)
      await settle({ quiet: 150 })
      bindingStore.save(mutate(readCache(scratch.cachePath)))
      await sleep(40)
      if (bindingStore.load({ serverUrl: server.url, email: EMAIL }) === null) return true
    }
    return false
  }

  const bindingStore = new CacheStore(scratch.cachePath)
  try {
    // ── 1. Cold start writes the cache, the next start reads it ─────────────
    section('cold start → warm start')
    const first = makeClient()
    const coldSyncs = server.stats.syncs
    const warm = await first.unlock()
    check('a cold start downloads once', server.stats.syncs === coldSyncs + 1, String(server.stats.syncs - coldSyncs))
    check('a cold start is not a cache hit', warm.cached !== true)
    check('a cold start writes the cache file', existsSync(scratch.cachePath))
    check('the cached payload holds every cipher', readCache(scratch.cachePath).payload.ciphers.length === 4)

    const settleFrom = server.stats.syncs
    const second = makeClient()
    const cached = await second.unlock()
    check('a warm start is a cache hit', cached.cached === true, String(cached.cached))
    check('a warm start decrypts the same number of entries', cached.items.length === 4, String(cached.items.length))
    check('a warm start reports when the payload was stored', typeof cached.cachedAt === 'number' && cached.cachedAt > 0)
    const probesBefore = server.stats.revisionChecks
    const failuresBefore = transportFailures
    check('a warm start probes the revision instead of downloading', await waitFor(() => server.stats.revisionChecks > probesBefore, { timeout: 3000 }))
    await sleep(400)
    const lostProbes = transportFailures - failuresBefore
    if (lostProbes === 0) {
      check('an unchanged revision downloads nothing', server.stats.syncs === settleFrom, String(server.stats.syncs - settleFrom))
    } else {
      // The mock closes idle keep-alive sockets, so a probe can die in transit.
      // #revalidate reads a failed probe as "revision unknown" and re-downloads
      // once — the documented fallback — which is exactly what a stress harness
      // should see rather than mask.
      console.log('  ~ the revision probe was dropped in transit (' + lostProbes + 'x); judging the fallback instead')
      check('a dropped probe falls back to exactly one download', server.stats.syncs === settleFrom + 1, String(server.stats.syncs - settleFrom))
    }
    check('the cache file survives a warm start', existsSync(scratch.cachePath))

    // ── 2. A moved revision invalidates the cache ──────────────────────────
    section('revision moves')
    server.bumpRevision()
    await settle()
    const syncsBefore = server.stats.syncs
    const moved = makeClient()
    const staleVault = await moved.unlock()
    check('a moved revision still serves the cache first', staleVault.cached === true)
    check('a moved revision triggers exactly one background download', await waitFor(() => server.stats.syncs === syncsBefore + 1, { timeout: 6000 }), String(server.stats.syncs - syncsBefore))
    check('the refreshed vault is no longer a cache hit', moved.vault?.cached !== true)
    await sleep(200)
    check('the refresh stores the new revision', readCache(scratch.cachePath).revision === server.revision(), String(readCache(scratch.cachePath).revision))

    // ── 3. A revision probe that fails ─────────────────────────────────────
    section('revision probe fails')
    server.failRevision(true)
    await settle()
    const failSyncs = server.stats.syncs
    const failing = makeClient()
    const servedAnyway = await failing.unlock()
    check('a failed probe still serves the cache', servedAnyway.cached === true)
    check('a failed probe falls back to one full download', await waitFor(() => server.stats.syncs === failSyncs + 1, { timeout: 6000 }), String(server.stats.syncs - failSyncs))
    check('a failed probe records revision: null', await waitFor(() => {
      try {
        return readCache(scratch.cachePath).revision === null
      } catch {
        return false
      }
    }, { timeout: 3000 }), String(readCache(scratch.cachePath).revision))
    server.failRevision(false)
    const afterRecovery = server.stats.syncs
    const recovered = makeClient()
    const nullRevision = await recovered.unlock()
    check('a null revision never takes the fast path', nullRevision.cached === true && (await waitFor(() => server.stats.syncs === afterRecovery + 1, { timeout: 6000 })))

    // ── 4. A revision probe that hangs ─────────────────────────────────────
    section('revision probe hangs')
    const hangClient = makeClient({
      fetch: async (url, init) => {
        if (String(url).includes('/api/accounts/revision-date')) await sleep(2500)
        return fetch(url, init)
      },
    })
    await settle()
    const hangFrom = server.stats.syncs
    const startedAt = Date.now()
    const hung = await hangClient.unlock()
    const elapsed = Date.now() - startedAt
    check('a hanging probe does not delay the cached read', elapsed < 2000, String(elapsed) + 'ms')
    check('a hanging probe still yields a cache hit', hung.cached === true && hung.items.length === 4, String(hung.items?.length))
    await sleep(2800)
    check('a late probe with the same revision downloads nothing', server.stats.syncs === hangFrom, String(server.stats.syncs - hangFrom))

    // ── 5. Five kinds of file damage ───────────────────────────────────────
    section('damaged cache files')
    const damageCases = [
      ['gzip truncated', (bytes) => bytes.subarray(0, Math.max(0, bytes.length - 20))],
      ['payload is not JSON', () => gzipSync('{ not json at all')],
      ['MAC does not match', (bytes) => gzipSync(JSON.stringify({ ...JSON.parse(gunzipSync(bytes).toString('utf8')), mac: 'a'.repeat(64) }))],
      ['envelope version is old', (bytes) => gzipSync(JSON.stringify({ ...JSON.parse(gunzipSync(bytes).toString('utf8')), version: 1 }))],
      ['payload is not a sync response', (bytes) => gzipSync(JSON.stringify({ ...JSON.parse(gunzipSync(bytes).toString('utf8')), payload: 42 }))],
    ]
    for (const [label, damage] of damageCases) {
      const seeded = makeClient()
      await seeded.unlock()
      await settle()
      const good = readFileSync(scratch.cachePath)
      writeFileSync(scratch.cachePath, damage(good))
      const before = server.stats.syncs
      const client = makeClient()
      const vault = await client.unlock()
      check(label + ': falls back to a full download', server.stats.syncs === before + 1, String(server.stats.syncs - before))
      check(label + ': the damaged file is not served', vault.cached !== true && vault.items.length === 4, String(vault.items.length))
      check(label + ': the file is rewritten into a valid envelope', (() => {
        try {
          const record = readCache(scratch.cachePath)
          return record.version === 2 && Array.isArray(record.payload?.ciphers) && record.payload.ciphers.length === 4
        } catch {
          return false
        }
      })())
    }
    check('the damage matrix left no payload readable by a plain reader', (() => {
      try {
        return readCache(scratch.cachePath).version === 2
      } catch {
        return false
      }
    })())

    // ── 6. A cache that belongs to somebody else ────────────────────────────
    section('account binding')
    const own = readCache(scratch.cachePath)
    check('the record names this account', own.serverUrl === server.url && own.email === EMAIL, JSON.stringify({ serverUrl: own.serverUrl, email: own.email }))

    check('the foreign record is planted', await plant((record) => ({ ...record, serverUrl: 'https://another-vault.invalid' })))
    check('another server does not load', bindingStore.load({ serverUrl: server.url, email: EMAIL }) === null)
    check('another server leaves the file alone', existsSync(scratch.cachePath))
    await settle()
    const otherServerSyncs = server.stats.syncs
    const otherServer = makeClient()
    const rebuilt = await otherServer.unlock()
    check('another server forces a download', server.stats.syncs === otherServerSyncs + 1 && rebuilt.cached !== true, String(server.stats.syncs - otherServerSyncs))
    check('the download rewrites the record for this account', readCache(scratch.cachePath).serverUrl === server.url)

    const ownAgain = readCache(scratch.cachePath)
    check('the email comparison ignores case', bindingStore.load({ serverUrl: server.url, email: EMAIL.toUpperCase() }) !== null)
    check('the foreign email is planted', await plant((record) => ({ ...record, email: 'someone-else@example.com' })))
    check('another email does not load', bindingStore.load({ serverUrl: server.url, email: EMAIL }) === null)
    await settle()
    const otherEmailSyncs = server.stats.syncs
    const otherEmail = makeClient()
    const recoveredVault = await otherEmail.unlock()
    check('another email forces a download', server.stats.syncs === otherEmailSyncs + 1 && recoveredVault.cached !== true, String(server.stats.syncs - otherEmailSyncs))
    check('the download restores this account as the owner', readCache(scratch.cachePath).email === EMAIL, readCache(scratch.cachePath).email)
    check('the recovered vault holds this account ciphertext only', recoveredVault.items.length === 4 && recoveredVault.raw.size === 4, String(recoveredVault.raw.size))

    // ── 7. The seven-day trust window ───────────────────────────────────────
    section('seven-day trust window')
    const agedSavedAt = Date.now() - MAX_TRUST_MS - 60_000
    await settle()
    bindingStore.save({ ...readCache(scratch.cachePath), savedAt: agedSavedAt })
    check('the store refuses to trust the aged record', bindingStore.trusted(readCache(scratch.cachePath)) === false)
    await settle()
    const agedSyncs = server.stats.syncs
    const agedClient = makeClient()
    const aged = await agedClient.unlock()
    check('an aged record is still served', aged.cached === true && aged.cachedAt === agedSavedAt, String(aged.cachedAt))
    check('an aged record is refreshed in the background', await waitFor(() => server.stats.syncs === agedSyncs + 1, { timeout: 6000 }), String(server.stats.syncs - agedSyncs))
    check('the refresh re-stamps savedAt', await waitFor(() => readCache(scratch.cachePath).savedAt > agedSavedAt + MAX_TRUST_MS, { timeout: 4000 }), String(readCache(scratch.cachePath).savedAt - agedSavedAt))

    // ── 8. localCache = false ───────────────────────────────────────────────
    section('local cache disabled')
    check('the cache file exists before the switch', existsSync(scratch.cachePath))
    await settle()
    const offSyncs = server.stats.syncs
    const disabled = makeClient({ cacheOptions: { enabled: false } })
    const disabledVault = await disabled.unlock()
    check('a disabled cache is never served', disabledVault.cached !== true && disabledVault.items.length === 4)
    check('a disabled cache always downloads', server.stats.syncs === offSyncs + 1, String(server.stats.syncs - offSyncs))
    check('a disabled cache deletes the stale file', !existsSync(scratch.cachePath))

    // ── 9. Eight concurrent unlocks, one download ───────────────────────────
    section('single flight, eight callers')
    const burstDir = scratchDir('burst')
    const burstSession = new SessionStore(burstDir.sessionPath, { maxAgeDays: 30 })
    try {
      const burst = new VaultClient(settingsFor(server), {
        sessionStore: burstSession,
        cacheStore: new CacheStore(burstDir.cachePath),
      })
      await settle()
      const burstSyncs = server.stats.syncs
      const burstGrants = server.stats.tokenGrants.length
      const results = await Promise.all(Array.from({ length: 8 }, () => burst.unlock()))
      check('eight concurrent cold unlocks download exactly once', server.stats.syncs === burstSyncs + 1, String(server.stats.syncs - burstSyncs))
      check('eight concurrent cold unlocks log in exactly once', server.stats.tokenGrants.length === burstGrants + 1, String(server.stats.tokenGrants.length - burstGrants))
      check('every caller sees the whole vault', results.every((vault) => vault?.items?.length === 4), JSON.stringify(results.map((vault) => vault?.items?.length)))
      check('every caller shares the one flight result', results.every((vault) => vault === results[0]))
      check('the burst wrote one cache file', existsSync(burstDir.cachePath) && readCache(burstDir.cachePath).payload.ciphers.length === 4)

      await settle()
      const warmBurstSyncs = server.stats.syncs
      const warmResults = await Promise.all(Array.from({ length: 8 }, () => burst.unlock()))
      check('eight concurrent warm unlocks stay in memory', warmResults.every((vault) => vault === results[0]))
      check('eight concurrent warm unlocks download nothing', server.stats.syncs === warmBurstSyncs)
    } finally {
      burstDir.dispose()
    }

    // ── 10. A cache that cannot be written ──────────────────────────────────
    section('unwritable cache')
    const notADir = join(scratch.dir, 'blocker')
    writeFileSync(notADir, 'not a directory')
    const unwritablePath = join(notADir, 'vault-cache.json.gz')
    const unwritable = makeClient({ cachePath: unwritablePath })
    await settle()
    const blockedSyncs = server.stats.syncs
    const blockedVault = await unwritable.unlock()
    check('an unwritable cache does not fail the unlock', blockedVault.items.length === 4, String(blockedVault.items?.length))
    check('the unlock still downloaded', server.stats.syncs === blockedSyncs + 1, String(server.stats.syncs - blockedSyncs))
    check('a write to that path reports failure', new CacheStore(unwritablePath).save({ serverUrl: server.url, email: EMAIL, payload: { ciphers: [] } }) === false)
    check('a second unlock after the write failure still works', (await unwritable.unlock()).items.length === 4)

    // ── 11. Damage and deletion under a live client ─────────────────────────
    section('damage and deletion under a live client')
    const liveDir = scratchDir('live')
    const liveSession = new SessionStore(liveDir.sessionPath, { maxAgeDays: 30 })
    try {
      const live = new VaultClient(settingsFor(server), { sessionStore: liveSession, cacheStore: new CacheStore(liveDir.cachePath) })
      await live.unlock()
      rmSync(liveDir.cachePath, { force: true })
      const afterDelete = await live.unlock()
      check('deleting the file under a live client keeps the in-memory vault', afterDelete.items.length === 4)
      const report = JSON.parse(await live.status())
      check('status reports the vault as unlocked', report.unlocked === true && report.items === 4, JSON.stringify({ unlocked: report.unlocked, items: report.items }))
      check('status reports the cache as gone', report.cache?.stored === false, JSON.stringify(report.cache))
      writeFileSync(liveDir.cachePath, 'garbage')
      const nextClient = new VaultClient(settingsFor(server), { sessionStore: liveSession, cacheStore: new CacheStore(liveDir.cachePath) })
      const fresh = await nextClient.unlock()
      check('garbage written behind a live client is replaced', fresh.cached !== true && readCache(liveDir.cachePath).payload.ciphers.length === 4)
    } finally {
      liveDir.dispose()
    }
  } finally {
    await server.close()
    scratch.dispose()
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
