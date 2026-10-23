// stress: time & TOTP boundaries.
//
// What this suite pins down:
//   • RFC 6238 vectors, and exactly where a window ends (the last millisecond
//     still belongs to the old window; the boundary belongs to the new one).
//   • The `remaining` contract the panel renders a countdown from.
//   • getFreshTotp's waited-window semantics: it sleeps to the *exact* next
//     boundary, never to `(remaining + 1) * 1000`; minRemaining 0 means "do not
//     wait"; a code that is already good enough is never slept on.
//   • Behaviour when the wall clock moves backwards (NTP step, VM restore,
//     a laptop waking with a stale RTC): a rolled-back clock makes ages
//     negative, and negative ages pass every `now - stamp < ttl` comparison.
//     Those cases are asserted as they behave today, with a note, because
//     "the vault expires" is not what the code claims in either place.
//
// Nothing here touches the network clock: every client gets an injected `now`
// and an injected `sleep` that advances the very same clock, so the suite runs
// in milliseconds and is fully deterministic.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base32Decode, generateTotp, parseTotp } from '../lib/totp.js'
import { CacheStore, MAX_TRUST_MS } from '../lib/cache-store.js'
import { SessionStore } from '../lib/session-store.js'
import { VaultClient, VaultError, decryptEncString, encryptString, stretchKey } from '../lib/vault.js'
import { EMAIL, PASSWORD, RFC_SECRET, RFC_URI, startMockServer } from './mock-server.mjs'

let passed = 0
let failed = 0

const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log('  ✓ ' + label)
  } else {
    failed += 1
    console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''))
  }
}

const section = (title) => console.log('\n' + title)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait until the mock server stops receiving syncs.
 *
 * A cached unlock kicks off a background revision probe, and whether that probe
 * has finished by the time the next measurement starts depends on how loaded
 * the machine is — a fixed sleep made the section below flaky exactly once in
 * ten runs under CPU contention. Polling for quiescence measures the thing the
 * assertion is actually about (did *this* client re-download?) instead of
 * hoping a stopwatch is long enough.
 */
async function settleSyncs(server, { quietMs = 250, timeoutMs = 5000 } = {}) {
  const started = Date.now()
  let last = server.stats.syncs
  let quietSince = Date.now()
  while (Date.now() - started < timeoutMs) {
    await sleep(50)
    if (server.stats.syncs !== last) {
      last = server.stats.syncs
      quietSince = Date.now()
      continue
    }
    if (Date.now() - quietSince >= quietMs) return last
  }
  return server.stats.syncs
}

const settingsFor = (server, extra = {}) => ({
  serverUrl: server.url,
  email: EMAIL,
  masterPassword: PASSWORD,
  apiKeyClientId: '',
  apiKeyClientSecret: '',
  cacheMinutes: 30,
  ...extra,
})

const scratchDir = (label) => {
  const dir = mkdtempSync(join(tmpdir(), 'vw-' + label + '-'))
  return {
    dir,
    cachePath: join(dir, 'vault-cache.json.gz'),
    sessionPath: join(dir, 'session.json'),
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const capture = async (run) => {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error }
  }
}

// Same shape for the synchronous parsers: awaiting a non-promise would turn a
// thrown error into an unhandled rejection instead of a recorded result.
const attempt = (run) => {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    return { ok: false, error }
  }
}

const watchdogFetch = async (url, init) => {
  try {
    return await fetch(url, init)
  } catch (error) {
    const reason = error?.cause?.code ?? error?.cause?.message ?? error?.message
    console.log('  ! transport failure ' + String(url) + ' → ' + reason)
    throw error
  }
}

// ── pure TOTP arithmetic ─────────────────────────────────────────────────────

function pureTotpChecks() {
  section('RFC 6238 vectors')
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]
  for (const [seconds, expected] of vectors) {
    const totp = generateTotp(RFC_URI, seconds * 1000)
    check('RFC 6238 T=' + seconds + ' → ' + expected, totp.code === expected, totp.code)
  }

  section('window edges, ±1 ms')
  const period = 30_000
  const lastMs = generateTotp(RFC_URI, period - 1)
  const firstMs = generateTotp(RFC_URI, period)
  const secondMs = generateTotp(RFC_URI, period + 1)
  const headMs = generateTotp(RFC_URI, 1)
  check('the last millisecond of a window still answers with that window', lastMs.code === headMs.code, lastMs.code + ' vs ' + headMs.code)
  check('that last millisecond reports remaining=1', lastMs.remaining === 1, String(lastMs.remaining))
  check('the boundary itself already belongs to the next window', firstMs.code !== lastMs.code, firstMs.code + ' vs ' + lastMs.code)
  check('one millisecond into the window reports the full period', firstMs.remaining === 30 && secondMs.remaining === 30, firstMs.remaining + '/' + secondMs.remaining)
  check('both sides of the boundary agree on the same code pattern', firstMs.code === secondMs.code, firstMs.code + ' vs ' + secondMs.code)

  const nearEnd = generateTotp(RFC_URI, 2 * period - 1)
  const rollover = generateTotp(RFC_URI, 2 * period)
  check('the second window ends on the same rule', nearEnd.remaining === 1 && rollover.remaining === 30, nearEnd.remaining + '/' + rollover.remaining)
  check('consecutive windows produce different codes', nearEnd.code !== rollover.code, nearEnd.code + ' vs ' + rollover.code)

  section('the remaining contract')
  let formulaOk = true
  let rangeOk = true
  let monotoneOk = true
  let previousRemaining = null
  for (let second = 0; second < 300; second += 1) {
    const atMs = 1_700_000_000_000 + second * 1000
    const totp = generateTotp(RFC_URI, atMs)
    if (totp.remaining !== totp.period - (Math.floor(atMs / 1000) % totp.period)) formulaOk = false
    if (!(totp.remaining >= 1 && totp.remaining <= totp.period)) rangeOk = false
    // Within one window the countdown must decrease by exactly one per second,
    // and jump back up to the full period on rollover.
    if (previousRemaining === null) {
      if (totp.remaining !== totp.period - (Math.floor(atMs / 1000) % totp.period)) monotoneOk = false
    } else if (previousRemaining > 1) {
      if (totp.remaining !== previousRemaining - 1) monotoneOk = false
    } else if (totp.remaining !== totp.period) {
      monotoneOk = false
    }
    previousRemaining = totp.remaining
  }
  check('remaining is always period - (floor(at/1000) % period)', formulaOk)
  check('remaining never falls to zero and never exceeds the period', rangeOk)
  check('the countdown decreases by one per second and resets on the boundary', monotoneOk)

  section('secret parsing tolerates real-world formatting')
  check('spaces are stripped', Buffer.compare(base32Decode('JBSW Y3DP'), base32Decode('JBSWY3DP')) === 0)
  check('lowercase is accepted', Buffer.compare(base32Decode('jbswy3dp'), base32Decode('JBSWY3DP')) === 0)
  check('dashes are stripped', Buffer.compare(base32Decode('JBSW-Y3DP'), base32Decode('JBSWY3DP')) === 0)
  check('padding is optional', Buffer.compare(base32Decode('MZXW6==='), base32Decode('MZXW6')) === 0)
  const badSecret = attempt(() => base32Decode('JBSWY3D1'))
  check('a non-base32 character is rejected, not silently dropped', badSecret.ok === false && /invalid base32 character/.test(badSecret.error.message), badSecret.ok ? 'no throw' : badSecret.error.message)
  const emptySecret = attempt(() => base32Decode(''))
  check('an empty secret is rejected', emptySecret.ok === false && /empty base32 secret/.test(emptySecret.error.message))

  check('a bare secret is read as 6 digits over 30 seconds', JSON.stringify(parseTotp(RFC_SECRET)) === JSON.stringify({ secret: RFC_SECRET, digits: 6, period: 30, algorithm: 'SHA1' }), JSON.stringify(parseTotp(RFC_SECRET)))
  const clamped = parseTotp('otpauth://totp/x?secret=JBSWY3DP&digits=99&period=0&algorithm=MD5')
  check('out-of-range digits/period/algorithm fall back instead of throwing', clamped.digits === 6 && clamped.period === 30 && clamped.algorithm === 'SHA1', JSON.stringify(clamped))
  const tenDigit = parseTotp('otpauth://totp/x?secret=JBSWY3DP&digits=10&period=60&algorithm=SHA256')
  check('a 10-digit / 60-second SHA256 secret is honoured', tenDigit.digits === 10 && tenDigit.period === 60 && tenDigit.algorithm === 'SHA256', JSON.stringify(tenDigit))
  const noSecret = attempt(() => parseTotp('otpauth://totp/x'))
  check('an otpauth URI without a secret is rejected', noSecret.ok === false && /no secret parameter/.test(noSecret.error.message))
  const emptyValue = attempt(() => parseTotp(''))
  check('an empty TOTP value is rejected', emptyValue.ok === false && /empty TOTP value/.test(emptyValue.error.message))
}


// ── client-level TOTP / time behaviour ──────────────────────────────────────

function makeClock(start) {
  const state = { at: start, slept: [] }
  return {
    state,
    now: () => state.at,
    // The waiting code is the point of this suite, so the injected sleep
    // advances the same clock the client reads — no wall-clock dependency.
    sleep: async (ms) => {
      state.slept.push(ms)
      state.at += ms
    },
  }
}

function makeClient(server, clock, dir, options = {}) {
  const session = options.sessionStore ?? new SessionStore(dir.sessionPath, { maxAgeDays: 30 })
  return new VaultClient(settingsFor(server, options.settings), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: options.fetch ?? watchdogFetch,
    sessionStore: session,
    cacheStore: options.cacheStore ?? new CacheStore(dir.cachePath, options.cacheOptions),
  })
}

const findClockForRemaining = (want, from) => {
  for (let second = 0; second < 120; second += 1) {
    const at = from + second * 1000
    if (generateTotp(RFC_URI, at).remaining === want) return at
  }
  return null
}

async function clientTotpChecks(server) {
  const dir = scratchDir('stress-time')
  // One login for the whole section: 600k PBKDF2 per grant is the slowest
  // thing in this file and every case only needs the vault, not a fresh token.
  const sessionStore = new SessionStore(dir.sessionPath, { maxAgeDays: 30 })
  const base = 1_700_000_000_000
  const clock = makeClock(base)
  const client = makeClient(server, clock, dir, { sessionStore })
  await client.unlock()

  section('a code that is already usable is never slept on')
  const goodAt = findClockForRemaining(20, base)
  clock.state.at = goodAt
  clock.state.slept.length = 0
  const immediate = await client.getFreshTotp('cipher-github', undefined, { minRemaining: 20 })
  check('remaining == minRemaining answers straight away', clock.state.slept.length === 0, JSON.stringify(clock.state.slept))
  check('the answered code is the current one', immediate.totp.code === generateTotp(RFC_URI, goodAt).code, immediate.totp.code)
  check('freshFor mirrors remaining', immediate.totp.freshFor === immediate.totp.remaining, immediate.totp.freshFor + '/' + immediate.totp.remaining)

  section('a code about to expire waits for the next window')
  const shortAt = findClockForRemaining(9, base)
  clock.state.at = shortAt
  clock.state.slept.length = 0
  const staleCode = generateTotp(RFC_URI, shortAt).code
  const waited = await client.getFreshTotp('cipher-github', undefined, { minRemaining: 20 })
  const boundary = Math.ceil(shortAt / 30_000) * 30_000
  check('it slept exactly once', clock.state.slept.length === 1, JSON.stringify(clock.state.slept))
  check('it slept to the exact boundary, not (remaining + 1) * 1000', clock.state.slept[0] === boundary - shortAt, clock.state.slept[0] + ' vs ' + (boundary - shortAt))
  check('the clock now sits on the boundary', clock.state.at === boundary && clock.state.at % 30_000 === 0, String(clock.state.at))
  check('the answered code is a different, freshly minted one', waited.totp.code !== staleCode, waited.totp.code + ' vs ' + staleCode)
  check('the answered code matches the new window', waited.totp.code === generateTotp(RFC_URI, boundary).code, waited.totp.code)
  check('a fresh window reports a full freshFor', waited.totp.freshFor === 30, String(waited.totp.freshFor))

  section('one millisecond before the boundary')
  clock.state.at = boundary - 1
  clock.state.slept.length = 0
  const edge = await client.getFreshTotp('cipher-github', undefined, { minRemaining: 20 })
  check('it sleeps the single millisecond left, not a whole second', clock.state.slept[0] === 1, JSON.stringify(clock.state.slept))
  check('it lands exactly on the boundary', clock.state.at === boundary, String(clock.state.at))
  check('it returns the new window\'s code', edge.totp.code === generateTotp(RFC_URI, boundary).code, edge.totp.code)
  check('one more millisecond in still means no waiting', (() => {
    clock.state.at = boundary + 1
    clock.state.slept.length = 0
    return true
  })())
  const justInside = await client.getFreshTotp('cipher-github', undefined, { minRemaining: 20 })
  check('no sleep at the start of a window', clock.state.slept.length === 0, JSON.stringify(clock.state.slept))
  check('the code is the window\'s own', justInside.totp.code === generateTotp(RFC_URI, boundary + 1).code, justInside.totp.code)

  section('minRemaining edge values')
  clock.state.at = findClockForRemaining(9, base)
  clock.state.slept.length = 0
  const noWait = await client.getFreshTotp('cipher-github', undefined, { minRemaining: 0 })
  check('minRemaining: 0 means "do not wait" and is not treated as the default', clock.state.slept.length === 0, JSON.stringify(clock.state.slept))
  check('the unwaited code is still returned with its real freshFor', noWait.totp.freshFor === 9, String(noWait.totp.freshFor))

  clock.state.at = findClockForRemaining(9, base)
  clock.state.slept.length = 0
  const clampedHigh = await client.getFreshTotp('cipher-github', undefined, { minRemaining: 500 })
  check('a huge minRemaining is clamped, not honoured literally', clock.state.slept.length === 1 && clock.state.slept[0] <= 30_000, JSON.stringify(clock.state.slept))
  check('the clamped request still yields a full window', clampedHigh.totp.freshFor === 30, String(clampedHigh.totp.freshFor))

  clock.state.at = findClockForRemaining(9, base)
  clock.state.slept.length = 0
  const nonNumeric = await client.getFreshTotp('cipher-github', undefined, { minRemaining: 'nope' })
  check('a non-numeric minRemaining falls back to the documented default', clock.state.slept.length === 1 && nonNumeric.totp.freshFor === 30, JSON.stringify(clock.state.slept))

  clock.state.at = findClockForRemaining(9, base)
  clock.state.slept.length = 0
  const negative = await client.getFreshTotp('cipher-github', undefined, { minRemaining: -5 })
  check('a negative minRemaining behaves like zero', clock.state.slept.length === 0, JSON.stringify(clock.state.slept))

  section('an aborted wait is reported, not swallowed')
  clock.state.at = findClockForRemaining(9, base)
  const controller = new AbortController()
  const pending = client.getFreshTotp('cipher-github', controller.signal, { minRemaining: 20 })
  controller.abort()
  const aborted = await capture(() => pending)
  check('the wait raises a VaultError', aborted.ok === false && aborted.error instanceof VaultError, aborted.ok ? 'no throw' : aborted.error.name)
  check('the error code is bad_request', aborted.ok === false && aborted.error.code === 'bad_request', aborted.ok ? '-' : aborted.error.code)
  check('the message says the wait was cancelled', aborted.ok === false && /取码等待被取消/.test(aborted.error.message), aborted.ok ? '-' : aborted.error.message)

  section('gated and trashed entries never wait')
  const reprompt = await client.totpEntry('cipher-reprompt')
  check('a reprompt entry reports repromptRequired', reprompt.repromptRequired === true && reprompt.totp === null, JSON.stringify(reprompt))
  clock.state.slept.length = 0
  const gatedFresh = await client.getFreshTotp('cipher-reprompt', undefined, { minRemaining: 20 })
  check('getFreshTotp refuses to wait on a gated entry either', clock.state.slept.length === 0 && gatedFresh.repromptRequired === true, JSON.stringify(clock.state.slept))
  const securables = await client.get('cipher-reprompt', 'all')
  check('a gated entry hides its password behind repromptRequired', !String(securables).includes('reprompt-pass-9'), securables.slice(0, 80))

  section('the unwaited read still names its shelf life')
  clock.state.at = findClockForRemaining(7, base)
  const plain = JSON.parse(await client.get('cipher-github', 'totp'))
  check('field=totp reports freshFor', plain.totp.freshFor === 7, String(plain.totp.freshFor))
  check('field=totp reports the matching digits', plain.totp.digits === 8, String(plain.totp.digits))
  check('field=totp does not sleep', clock.state.slept.length === 0, JSON.stringify(clock.state.slept))
  const waitedThroughGet = await client.get('cipher-github', 'totp', undefined, { waitFresh: true, minRemaining: 20 })
  check('waitFresh routes through the waiting path', JSON.parse(waitedThroughGet).totp.freshFor === 30, waitedThroughGet.slice(0, 60))

  section('resolution errors')
  const missing = await capture(() => client.totpEntry('no-such-entry-anywhere'))
  check('an unknown reference is not_found', missing.ok === false && missing.error.code === 'not_found', missing.ok ? '-' : missing.error.code)
  const empty = await capture(() => client.getFreshTotp(''))
  check('an empty reference is bad_request', empty.ok === false && empty.error.code === 'bad_request', empty.ok ? '-' : empty.error.code)

  section('the same secret read twice within one window must agree')
  clock.state.at = findClockForRemaining(25, base)
  const firstRead = await client.totpEntry('cipher-github')
  const secondRead = await client.totpEntry('cipher-github')
  check('two reads in the same window return the same code', firstRead.totp.code === secondRead.totp.code, firstRead.totp.code + ' vs ' + secondRead.totp.code)
  check('totpEntry reports secondsRemaining', firstRead.totp.secondsRemaining === firstRead.totp.remaining, firstRead.totp.secondsRemaining + '/' + firstRead.totp.remaining)

  dir.dispose()
}


// ── the wall clock moving backwards ────────────────────────────────────────
//
// A NTP step, a restored VM snapshot, or a laptop waking with a dead RTC all
// move `Date.now()` backwards. Every TTL in this codebase is written as
// "now - stamp < ttl", and a negative age satisfies that comparison, so a
// rollback does not expire anything — it makes things expire *later*. The
// checks below record that behaviour as it is rather than pretending the
// guard exists.

async function clockRollbackChecks(server) {
  const dir = scratchDir('stress-time-rollback')
  const base = 1_700_000_000_000
  const clock = makeClock(base)
  const sessionStore = new SessionStore(dir.sessionPath, { maxAgeDays: 30 })
  const client = makeClient(server, clock, dir, { sessionStore })
  // The mock is shared with the section above, so "no re-download" has to be
  // measured as a delta rather than against an absolute count.
  const syncsBeforeSection = server.stats.syncs
  const first = await client.unlock()
  const vaultAt = client.vault.at
  check('the first unlock installed a vault stamped with the injected clock', vaultAt === base, String(vaultAt))

  section('the in-memory ttl is judged on absolute age too')
  // FIXED. ttl is cacheMinutes (30) × 60 s, and the check used to be
  // `now - at < ttl`. Jumping the clock back a year made that difference a huge
  // negative number, which is less than every ttl — so a vault stamped in the
  // future stayed "fresh" for ever and was never re-checked against the server.
  // It is now the absolute distance, the same rule the disk cache uses.
  clock.state.at = vaultAt - 365 * 24 * 60 * 60 * 1000
  const afterRollback = await client.unlock()
  check('a far rollback re-reads the vault instead of trusting it for ever', afterRollback !== first, afterRollback === first ? 'same object' : 'a new object')
  // It re-read it from the existing client's own token (no new login), which
  // means the in-memory guard really did give up rather than the whole session
  // being rebuilt from scratch.
  check('the re-read kept the session it already had', Boolean(client.token), 'no token')
  await settleSyncs(server) // let the background revalidation this kicked off settle

  section('an ordinary clock correction keeps the in-memory vault')
  // The other side of the same rule: NTP stepping back a few seconds must not
  // cost a download.
  clock.state.at = client.vault.at + 5_000
  const syncsBeforeShort = server.stats.syncs
  const afterSmallRollback = await client.unlock()
  check('a seconds-scale rollback is still fresh', afterSmallRollback === client.vault, 're-downloaded')
  check('and it cost no request', server.stats.syncs === syncsBeforeShort, 'syncs ' + syncsBeforeShort + ' → ' + server.stats.syncs)

  section('the disk cache is trusted by the same arithmetic')
  const store = new CacheStore(dir.cachePath)
  const record = store.load({ serverUrl: server.url, email: EMAIL })
  check('the cache record exists to test against', Boolean(record), String(record))
  // Every reading below is judged against the record's own timestamp, because
  // the whole point is where a given clock sits relative to it.
  const onRecordStore = new CacheStore(dir.cachePath, { now: () => record.savedAt })
  check('with the clock on the record it is trusted', onRecordStore.trusted(record) === true)
  // FIXED: the window is judged on the absolute distance, so a clock far enough
  // *behind* the record is as disqualifying as one far enough ahead of it. It
  // used to pass, because `now - savedAt` went negative and a negative age
  // satisfies every upper bound — which left a future-stamped record trusted
  // forever.
  const rolledBackStore = new CacheStore(dir.cachePath, { now: () => record.savedAt - MAX_TRUST_MS - 1000 })
  check('a clock far before the record falls outside the trust window', rolledBackStore.trusted(record) === false)
  const slightRollback = new CacheStore(dir.cachePath, { now: () => record.savedAt - 60_000 })
  check('an ordinary backwards clock correction is still trusted', slightRollback.trusted(record) === true)

  section('and a forward jump is judged correctly')
  const forwardStore = new CacheStore(dir.cachePath, { now: () => record.savedAt + MAX_TRUST_MS + 1000 })
  check('a clock past the 7-day window rejects the record', forwardStore.trusted(record) === false)
  const edgeStore = new CacheStore(dir.cachePath, { now: () => record.savedAt + MAX_TRUST_MS })
  check('exactly on the 7-day boundary the record is still trusted', edgeStore.trusted(record) === true)

  section('a fresh client re-reading a future-stamped cache')
  // Same cache file, brand-new client, clock rolled back an hour. The record
  // looks like it was written in the future, and `trusted` says fine.
  const rollbackClock = makeClock(record.savedAt - 60 * 60 * 1000)
  // Both clocks must be injected for the replay to be coherent: the trust
  // window is judged by the CacheStore's own clock, not by the client's, and a
  // production CacheStore is built with Date.now. Injecting only the client
  // would make this case measure the harness, not the plugin.
  await settleSyncs(server) // let any background revalidation from the section above settle
  const replay = makeClient(server, rollbackClock, dir, {
    sessionStore: new SessionStore(join(dir.dir, 'session-rollback.json'), { maxAgeDays: 30 }),
    cacheStore: new CacheStore(dir.cachePath, { now: () => rollbackClock.state.at }),
  })
  const syncsBefore = server.stats.syncs
  const replayed = await replay.unlock()
  check('the replay is served from disk', replayed.cached === true, String(replayed.cached))
  check('the replay decoded every row', replayed.items.length === first.items.length, replayed.items.length + ' vs ' + first.items.length)
  // The probe the cached unlock schedules is entitled to finish; what must not
  // happen is a *download*. Let it settle, then compare — a fixed sleep raced
  // the probe and made this flaky under load.
  const syncsAfterSettle = await settleSyncs(server)
  check('the replay issued no background re-download', syncsAfterSettle === syncsBefore, 'syncs ' + syncsBefore + ' → ' + syncsAfterSettle)
  // #cacheRecord is private; status() is the public window onto it.
  const replayStatus = JSON.parse(await replay.status())
  check('the replayed record kept its revision', replayStatus.cache?.revision === record.revision, String(replayStatus.cache?.revision) + ' vs ' + String(record.revision))

  section('TOTP still answers while the clock is behind')
  rollbackClock.state.at = record.savedAt - 60 * 60 * 1000
  const stale = await replay.getFreshTotp('cipher-github', undefined, { minRemaining: 0 })
  const expected = generateTotp(RFC_URI, rollbackClock.state.at)
  check('a rolled-back clock yields that instant\'s code, consistently', stale.totp.code === expected.code, stale.totp.code + ' vs ' + expected.code)
  check('the reported window is internally consistent', stale.totp.freshFor === expected.remaining, stale.totp.freshFor + '/' + expected.remaining)

  dir.dispose()
}

// ── harness ────────────────────────────────────────────────────────────────

async function main() {
  console.log('vault time & TOTP boundary stress (standalone mock Vaultwarden)')
  pureTotpChecks()

  const server = await startMockServer({ repromptCipher: true })
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }

  try {
    await clientTotpChecks(server)
    await clockRollbackChecks(server)
  } finally {
    await server.close()
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

