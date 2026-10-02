/**
 * Session resilience test: what a failed token refresh is allowed to do.
 *
 * The reported pain (second time): "重启一次输一次密码". A restart leaves an
 * aged access token on disk, so the next use must swap the refresh token.
 * The old code treated EVERY refresh failure — offline, 429, 5xx — as "the
 * refresh token is dead", deleted the stored session, and let the panel fall
 * back to the credential form. One flaky moment on the network was therefore
 * enough to cost a master password and a two-factor code.
 *
 * The rule this suite pins down:
 *   - a transient failure (network / 429 / 5xx) keeps the stored session:
 *     nothing is deleted, no password grant is started, and the very next
 *     attempt with the network back recovers silently;
 *   - only an explicit server rejection (invalid_grant / 401) clears it,
 *     because then the stored refresh token really is worthless.
 *
 * Run: node test/session-resilience.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VaultClient } from '../lib/vault.js'
import { SessionStore } from '../lib/session-store.js'
import { VaultGateway } from '../lib/gateway.js'
import { EMAIL, PASSWORD, TWO_FACTOR_CODE, startMockServer } from './mock-server.mjs'

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

const AGE_MS = 3_600_000

const settingsFor = (url) => ({
  serverUrl: url,
  email: EMAIL,
  masterPassword: PASSWORD,
  apiKeyClientId: '',
  apiKeyClientSecret: '',
  cacheMinutes: 30,
  websocket: false,
  pollIntervalSeconds: 300,
  deviceIdentifier: '',
  accessMode: 'readonly',
  sessionDays: 30,
})

/** Age the stored access token so the next use has to refresh. */
function ageSession(file) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  record.expiresAt = Date.now() - AGE_MS
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 })
  return record
}

/** fetch that cannot reach the network at all (what a flaky moment looks like). */
const offlineFetch = async () => {
  throw new TypeError('fetch failed')
}

/** fetch that answers with a status code and a JSON body. */
const statusFetch = (status, body) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const passwordGrants = (server) => server.stats.tokenGrants.filter((grant) => grant === 'password').length

async function main() {
  console.log('session resilience (a failed refresh must not cost a password)')

  const server = await startMockServer({ twoFactor: true })
  if (!server) {
    console.error('mock server unavailable')
    process.exitCode = 1
    return
  }

  // ── transient failures keep the stored session ────────────────────────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-resilience-'))
    const file = path.join(dir, 'session.json')
    const store = new SessionStore(file, { maxAgeDays: 30 })
    const settings = settingsFor(server.url)

    // Sign in once (password + code), which is the only time a code is spent.
    const first = new VaultClient(settings, { sessionStore: store })
    try {
      await first.unlock()
    } catch {
      /* expected two-factor challenge */
    }
    await first.loginWithTwoFactor({ code: TWO_FACTOR_CODE, provider: 0, remember: true })
    await first.unlock()
    check('a signed-in session is stored', fs.existsSync(file))

    // Age it: the next use must swap the refresh token, exactly like a restart
    // the morning after.
    ageSession(file)
    const refreshesBefore = server.stats.refreshes
    const grantsBefore = server.stats.tokenGrants.length
    const passwordsBefore = passwordGrants(server)

    const offline = new VaultClient(settings, { sessionStore: store, fetch: offlineFetch })
    const resumed = await offline.resumeSession()
    check('an offline refresh does not resume the session', resumed === false)
    check('an offline refresh keeps the stored session file', fs.existsSync(file))
    check('an offline refresh keeps the refresh token in memory', Boolean(offline.token?.refreshToken))
    check(
      'an offline refresh never reaches the server',
      server.stats.refreshes === refreshesBefore && server.stats.tokenGrants.length === grantsBefore,
      `refreshes ${refreshesBefore}→${server.stats.refreshes}, grants ${grantsBefore}→${server.stats.tokenGrants.length}`,
    )

    // The panel path: boot() must report "no live session" WITHOUT deleting the
    // file, so the next visit can still recover on its own.
    const gateway = Object.create(VaultGateway.prototype)
    const gatewayClient = new VaultClient(settings, { sessionStore: store, fetch: offlineFetch })
    gateway.getClient = () => gatewayClient
    gateway.createClient = () => gatewayClient
    gateway.owner = { getSettings: () => settings, update: async () => {} }
    gateway.mutations = null
    gateway.pendingProbe = null
    gateway.pendingPatch = null
    const boot = await gateway.boot()
    check('boot reports no resumed session while offline', boot?.resumed === false, JSON.stringify(boot?.resumed))
    check('boot keeps the stored session file while offline', fs.existsSync(file))

    // A rate limit (429) and a server error (5xx) are just as transient.
    for (const [status, body, label] of [
      [429, { error: 'rate_limited' }, 'a rate-limited refresh'],
      [503, { message: 'service unavailable' }, 'a 5xx refresh'],
    ]) {
      const client = new VaultClient(settings, { sessionStore: store, fetch: statusFetch(status, body) })
      const ok = await client.resumeSession()
      check(`${label} does not resume the session`, ok === false)
      check(`${label} keeps the stored session file`, fs.existsSync(file))
    }

    // ensureToken must surface the network error instead of starting a password
    // grant (which is what put the user in front of the two-factor screen).
    const direct = new VaultClient(settings, { sessionStore: store, fetch: offlineFetch })
    let thrown = null
    try {
      await direct.ensureToken()
    } catch (error) {
      thrown = error
    }
    check('a transient refresh failure surfaces as a network error', thrown?.code === 'network_error', String(thrown?.code ?? thrown))
    check(
      'a transient refresh failure starts no password grant',
      passwordGrants(server) === passwordsBefore,
      `passwords ${passwordsBefore}→${passwordGrants(server)}`,
    )
    check('the stored session survived the failed ensureToken', fs.existsSync(file))

    // Network back: the very next attempt recovers without any prompt.
    const back = new VaultClient(settings, { sessionStore: store })
    const recovered = await back.resumeSession()
    check('the stored session revives once the network is back', recovered === true, String(recovered))
    check('the recovery reused the refresh token, not a password grant', passwordGrants(server) === passwordsBefore)
    const vault = await back.unlock()
    check('the recovered session reads the vault', vault.items.length === 4, String(vault.items.length))

    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── an explicit rejection still clears the session ────────────────────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-rejected-'))
    const file = path.join(dir, 'session.json')
    const store = new SessionStore(file, { maxAgeDays: 30 })
    const settings = settingsFor(server.url)

    // A stored session whose refresh token the server will not recognise.
    store.save({
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh-token',
      expiresAt: Date.now() - AGE_MS,
      serverUrl: server.url,
      email: EMAIL,
      savedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    check('a stale session is on disk', fs.existsSync(file))
    const grantsBefore = server.stats.tokenGrants.length

    const client = new VaultClient(settings, { sessionStore: store })
    const resumed = await client.resumeSession()
    check('a rejected refresh token does not resume the session', resumed === false)
    check('a rejected refresh token clears the stored session', !fs.existsSync(file))
    check(
      'the rejection was answered by the server',
      server.stats.tokenGrants.length === grantsBefore + 1 && server.stats.tokenGrants.at(-1) === 'refresh_token',
      server.stats.tokenGrants.slice(grantsBefore).join(','),
    )

    // And a fresh sign-in still works afterwards (the file being gone is not a
    // dead end for the panel).
    const again = new VaultClient(settings, { sessionStore: store })
    try {
      await again.unlock()
    } catch {
      /* expected challenge */
    }
    await again.loginWithTwoFactor({ code: TWO_FACTOR_CODE, provider: 0, remember: true })
    const restored = await again.unlock()
    check('a fresh sign-in after a rejection works', restored.items.length === 4, String(restored.items.length))

    fs.rmSync(dir, { recursive: true, force: true })
  }

  await server.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exitCode = 1
})
