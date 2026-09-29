/**
 * Gateway sign-in flow test: drives the real `VaultGateway` (the RPC surface
 * the settings panel talks to) against the mock Vaultwarden server.
 *
 * This is the regression guard for the reported bug where submitting a correct
 * two-factor code bounced the user back to the credential form. It covers the
 * whole path the UI performs:
 *
 *   session()  → no live session
 *   connect()  → wrong password is rejected; right password + 2FA account
 *                returns a challenge (providers only, no continuation token)
 *   submitTwoFactor() → a wrong code fails inline, the right code signs in
 *   session()  → live session, entries readable
 *
 * It also pins the two rules that keep the panel usable:
 *   - connecting with already-stored values writes NO settings (a settings
 *     write restarts the plugin and would destroy the session it just made)
 *   - a code submission never depends on state carried from the challenge
 *
 * Run: node test/gateway-flow.test.mjs
 */
import { VaultGateway } from '../lib/gateway.js'
import { VaultClient } from '../lib/vault.js'
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

/** Build a gateway wired to a live settings store, like the host does. */
function makeGateway(serverUrl, stored) {
  const settings = { ...stored }
  const writes = []
  let client = new VaultClient({ serverUrl, ...settings })
  const owner = {
    getSettings: () => settings,
    update: async (patch) => {
      writes.push(patch)
      Object.assign(settings, patch)
      // The host restarts the plugin on a settings write; mirror that by
      // rebuilding the client, which is what makes a needless write fatal.
      client = new VaultClient({ serverUrl, ...settings })
    },
  }
  // `TypertRemoteService`'s constructor needs a live Cordis context, so build
  // the instance from the prototype and wire the fields it uses — exactly what
  // the host's `ctx.plugin(VaultGateway, ...)` ends up calling into.
  const gateway = Object.create(VaultGateway.prototype)
  gateway.getClient = () => client
  // Mirrors lib/index.js: the probe client shares the store and may be built
  // from candidate settings that have not been written yet.
  gateway.createClient = (override) => new VaultClient(override ? { serverUrl, ...settings, ...override } : { serverUrl, ...settings })
  gateway.owner = owner
  gateway.mutations = null
  gateway.pendingProbe = null
  gateway.pendingPatch = null
  return { gateway, writes, current: () => client }
}

async function main() {
  console.log('gateway sign-in flow (vw/connect → vw/submitTwoFactor)')

  // ── fresh install: the panel's FIRST RPC must not reject ──────────────────
  // Reported bug: on a new install the settings panel showed only
  // "尚未配置完成" + 重试 and the guided setup form could never be reached.
  // The panel opens with `config()`, and that call used to reject: it reports
  // the session store through `VaultClient.sessionPersistence`, whose getter
  // normalised `serverUrl` — empty on a fresh install — and threw
  // `not_configured`, taking the whole config payload down with it.
  //
  // The wiring below mirrors lib/index.js exactly (the client owns a real
  // SessionStore); drop the store and the getter returns early, which is why
  // this slipped through the existing gateway test.
  {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { SessionStore } = await import('../lib/session-store.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-unconfigured-'))
    const store = new SessionStore(path.join(dir, 'session.json'), { maxAgeDays: 30 })
    const empty = {
      serverUrl: '',
      email: '',
      masterPassword: '',
      apiKeyClientId: '',
      apiKeyClientSecret: '',
      cacheMinutes: 30,
      websocket: true,
      pollIntervalSeconds: 300,
      deviceIdentifier: '',
      accessMode: 'readonly',
      sessionDays: 30,
    }
    const client = new VaultClient(empty, { sessionStore: store })
    const gateway = Object.create(VaultGateway.prototype)
    gateway.getClient = () => client
    gateway.createClient = () => client
    gateway.owner = { getSettings: () => empty, update: async () => {} }
    gateway.mutations = null

    let config = null
    let threw = null
    try {
      config = await gateway.config()
    } catch (error) {
      threw = error
    }
    check("a fresh install can read its config (the panel's first RPC)", threw === null, String(threw?.message))
    check('the config reports the empty state rather than failing', config?.serverUrl === '' && config?.email === '', JSON.stringify(config))
    check('the config still describes the session store', config?.session?.enabled === true, JSON.stringify(config?.session))
    check('an unconfigured install reports no stored session', config?.session?.stored === false, JSON.stringify(config?.session))

    // The same trap must not reappear through the other read-only RPCs.
    let sessionThrew = null
    try {
      await gateway.session()
    } catch (error) {
      sessionThrew = error
    }
    check('session() stays usable while unconfigured', sessionThrew === null, String(sessionThrew?.message))

    fs.rmSync(dir, { recursive: true, force: true })
  }

  const server = await startMockServer({ twoFactor: true })
  const base = { serverUrl: server.url, email: EMAIL }

  // ── wrong password: rejected, nothing stored ───────────────────────────────
  {
    const { gateway, writes } = makeGateway(server.url, {})
    let rejected = null
    try {
      await gateway.connect(server.url, EMAIL, 'not-the-password')
    } catch (error) {
      rejected = error
    }
    check('a wrong master password is rejected', rejected !== null, String(rejected?.message))
    check('a rejected password stores nothing', writes.length === 0, JSON.stringify(writes))
  }

  // ── right password, 2FA account: challenge, still nothing stored ───────────
  {
    const { gateway, writes } = makeGateway(server.url, {})
    const result = await gateway.connect(server.url, EMAIL, PASSWORD)
    check('the right password returns a two-factor challenge', result?.twoFactor === true, JSON.stringify(result))
    check('the challenge lists the account providers', JSON.stringify(result?.providers) === JSON.stringify([0]), JSON.stringify(result?.providers))
    check('the challenge carries no continuation token', result?.token === undefined, JSON.stringify(result))
    // The write must precede the sign-in: it restarts the plugin, so a session
    // established first would be destroyed by its own save.
    check('credentials are stored before the code is submitted', writes.length === 1 && writes[0].masterPassword === PASSWORD, JSON.stringify(writes))

    // Wrong code: fails, stays recoverable.
    let badCode = null
    try {
      await gateway.submitTwoFactor('000000', 0, false)
    } catch (error) {
      badCode = error
    }
    check('a wrong code is rejected', badCode !== null, String(badCode?.message))
    check('a wrong code does not rewrite settings', writes.length === 1, JSON.stringify(writes))

    // Right code: completes the sign-in on the live client.
    const submitted = await gateway.submitTwoFactor(TWO_FACTOR_CODE, 0, false)
    check('the right code completes the sign-in', submitted?.ok === true && submitted.items === 4, JSON.stringify(submitted))
  }

  // ── the challenge is adopted by the live client ───────────────────────────
  {
    const { gateway, current } = makeGateway(server.url, {})
    await gateway.connect(server.url, EMAIL, PASSWORD)
    const live = current()
    check('the live client knows a challenge is pending', Boolean(live.twoFactorPending), JSON.stringify(live.twoFactorPending))
    let guarded = null
    try {
      await live.unlock()
    } catch (error) {
      guarded = error
    }
    check('background work cannot start a fresh login mid-challenge', guarded?.code === 'two_factor_required', String(guarded?.code))
  }

  // ── already signed in: session() reports it and connect() writes nothing ───
  {
    const { gateway, writes } = makeGateway(server.url, { serverUrl: server.url, email: EMAIL, masterPassword: PASSWORD })
    const before = await gateway.session()
    check('a fresh gateway reports no live session', before?.authenticated === false, JSON.stringify(before))

    const result = await gateway.connect(server.url, EMAIL, PASSWORD)
    check('signing in with stored values succeeds', result?.twoFactor === true, JSON.stringify(result))
    check('a sign-in with unchanged values writes no settings', writes.length === 0, JSON.stringify(writes))

    const afterCode = await gateway.submitTwoFactor(TWO_FACTOR_CODE, 0, true)
    check('the stored-credential sign-in completes', afterCode?.ok === true, JSON.stringify(afterCode))

    const live = await gateway.session()
    check('session() reports the live session', live?.authenticated === true, JSON.stringify(live))

    const listed = await gateway.list('', 50)
    check('the signed-in session lists entries', listed?.items?.length === 4, String(listed?.items?.length))

    // The panel's "back to settings" path must drop the session so the next
    // visit starts from the credential form.
    await gateway.reset()
    const cleared = await gateway.session()
    check('reset() clears the live session', cleared?.authenticated === false, JSON.stringify(cleared))
  }

  // ── leaving the code screen mid-challenge keeps a live session ────────────
  {
    const { gateway } = makeGateway(server.url, { serverUrl: server.url, email: EMAIL, masterPassword: PASSWORD })
    await gateway.submitTwoFactor(TWO_FACTOR_CODE, 0, true)
    const live = await gateway.session()
    check('a live session exists before discarding a challenge', live?.authenticated === true, JSON.stringify(live))
    await gateway.discardChallenge()
    const stillLive = await gateway.session()
    check('discarding a challenge keeps the live session', stillLive?.authenticated === true, JSON.stringify(stillLive))
  }

  // ── session persistence: surviving a restart ──────────────────────────────
  // The reported pain: every plugin restart forced a fresh master password,
  // and with two-factor enabled a fresh code as well. A persisted session must
  // let a brand-new client reopen the vault with no prompts.
  {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { SessionStore } = await import('../lib/session-store.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-session-'))
    const store = new SessionStore(path.join(dir, 'session.json'), { maxAgeDays: 30 })

    // First run: sign in with the code, which persists the session.
    const first = new VaultClient({ serverUrl: server.url, email: EMAIL, masterPassword: PASSWORD }, { sessionStore: store })
    try {
      await first.unlock()
    } catch {
      /* expected two-factor challenge */
    }
    await first.loginWithTwoFactor({ code: TWO_FACTOR_CODE, provider: 0, remember: true })
    const firstVault = await first.unlock()
    check('the first run unlocks the vault', firstVault.items.length === 4, String(firstVault.items.length))
    check('the session is written to disk', fs.existsSync(store.path))
    check('the session file is owner-only (0600)', (fs.statSync(store.path).mode & 0o777) === 0o600, (fs.statSync(store.path).mode & 0o777).toString(8))

    // "Restart": a brand-new client, empty memory, same store. It must NOT need
    // a password or a code.
    const challengesBefore = server.stats.twoFactorChallenges
    const loginsBefore = server.stats.tokenGrants.length
    const second = new VaultClient({ serverUrl: server.url, email: EMAIL, masterPassword: PASSWORD }, { sessionStore: store })
    const restoredVault = await second.unlock()
    check('a restarted client reopens the vault with no prompt', restoredVault.items.length === 4, String(restoredVault.items.length))
    check('the restart needed no new two-factor challenge', server.stats.twoFactorChallenges === challengesBefore, `challenges ${challengesBefore}→${server.stats.twoFactorChallenges}`)
    check('the restart reused the stored session rather than a password grant', server.stats.tokenGrants.length === loginsBefore, `grants ${loginsBefore}→${server.stats.tokenGrants.length}`)

    // A session belonging to a different account must never be reused.
    const other = new VaultClient({ serverUrl: server.url, email: 'someone-else@example.com', masterPassword: PASSWORD }, { sessionStore: store })
    check('another account does not inherit the stored session', other.restoreSession() === false)

    // Explicit sign-out wipes it.
    second.reset()
    check('signing out clears the stored session', !fs.existsSync(store.path))

    // Idle expiry: 30 days of no use drops it.
    const expiring = new SessionStore(path.join(dir, 'idle.json'), { maxAgeDays: 30, now: () => 1_000_000 })
    expiring.save({ accessToken: 'a', refreshToken: 'r', serverUrl: server.url, email: EMAIL, lastUsedAt: 1_000_000 })
    check('an idle session is still valid before the window', expiring.load() !== null)
    expiring.now = () => 1_000_000 + 31 * 86_400_000
    check('an idle session expires after the window', expiring.load() === null)
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
