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
  gateway.owner = owner
  gateway.mutations = null
  gateway.pendingProbe = null
  gateway.pendingPatch = null
  return { gateway, writes, current: () => client }
}

async function main() {
  console.log('gateway sign-in flow (vw/connect → vw/submitTwoFactor)')
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

  await server.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exitCode = 1
})
