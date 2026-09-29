/**
 * Offline end-to-end test for dsh-bitwarden.
 *
 * Drives the real client against the mock Vaultwarden server (see
 * `mock-server.mjs`) and asserts the full lifecycle: login, sync, decryption of
 * every cipher shape, search, reveal, TOTP, token refresh, API-key auth, and
 * the error paths a user will actually hit.
 *
 * The TOTP assertion uses the RFC 6238 reference vector, so that part is
 * checked against an external standard rather than against our own code.
 * `test/cli-interop.mjs` adds the cross-implementation check against the
 * official Bitwarden CLI.
 *
 * Run: node test/mock-e2e.test.mjs
 */
import { VaultClient, VaultError } from '../lib/vault.js'
import { EMAIL, PASSWORD, TWO_FACTOR_CODE, TWO_FACTOR_TOKEN, startMockServer } from './mock-server.mjs'

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

const settingsFor = (server, extra = {}) => ({
  serverUrl: server.url,
  email: EMAIL,
  masterPassword: PASSWORD,
  apiKeyClientId: '',
  apiKeyClientSecret: '',
  cacheMinutes: 30,
  ...extra,
})

async function main() {
  console.log('mock Vaultwarden protocol/crypto test')
  const server = await startMockServer()
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }

  // 1. password login + sync + decrypt ---------------------------------------
  const client = new VaultClient(settingsFor(server))
  const vault = await client.unlock()
  check('password login + sync unlocks the vault', vault.items.length === 4, `got ${vault.items.length}`)
  const github = vault.byId.get('cipher-github')
  check('login item fields decrypt', github?.username === 'octocat@jindom.cc' && github?.password === 'gh-p@ssw0rd-42')
  check('notes + uris + folder decrypt', github?.notes === 'SSH 部署密钥在 CI 里' && github?.uris[0] === 'https://github.com/login' && github?.folder === '工作')
  check('custom fields decrypt (text + hidden)', github?.fields[1]?.value === 'tok_live_abc123')
  check('per-item org key decrypts org cipher', vault.byId.get('cipher-org')?.password === 'deploy-secret-9' && vault.byId.get('cipher-org')?.collections[0] === '运维')
  check('legacy type-0 cipher string decrypts', vault.byId.get('cipher-legacy')?.password === 'legacy-pass')

  // 2. wrong master password --------------------------------------------------
  const badClient = new VaultClient(settingsFor(server, { masterPassword: 'wrong-password' }))
  let badError = null
  try {
    await badClient.unlock()
  } catch (error) {
    badError = error
  }
  check('wrong master password is rejected with guidance', badError instanceof VaultError && /登录失败|凭据/.test(badError.message), String(badError))

  // 3. find never leaks passwords --------------------------------------------
  const found = JSON.parse(await client.find('github'))
  check('find matches by name/uri and hides secrets', found.matched === 1 && !JSON.stringify(found).includes('gh-p@ssw0rd-42'))
  const foundCn = JSON.parse(await client.find('数据库'))
  check('find matches Chinese names', foundCn.items[0]?.id === 'cipher-db')
  const foundUser = JSON.parse(await client.find('deploy-bot'))
  check('find matches usernames in org items', foundUser.items[0]?.id === 'cipher-org')
  const empty = JSON.parse(await client.find('nothing-here-xyz'))
  check('find reports an empty result set cleanly', empty.matched === 0 && empty.items.length === 0)

  // 4. get by id / name / field ----------------------------------------------
  const byId = JSON.parse(await client.get('cipher-github', 'all'))
  check('get by id returns the credential', byId.password === 'gh-p@ssw0rd-42' && byId.username === 'octocat@jindom.cc')
  const byName = JSON.parse(await client.get('GitHub 工作账号', 'password'))
  check('get by name + field=password is narrow', byName.password === 'gh-p@ssw0rd-42' && byName.notes === undefined)

  // RFC 6238 reference vector: T=59s, SHA1, 8 digits → 94287082
  const totpClient = new VaultClient(settingsFor(server), { now: () => 59_000 })
  const totp = JSON.parse(await totpClient.get('cipher-github', 'totp'))
  check('TOTP matches the RFC 6238 test vector', totp.totp?.code === '94287082', JSON.stringify(totp.totp))

  // 5. ambiguity + not found --------------------------------------------------
  let notFound = null
  try {
    await client.get('cipher-does-not-exist')
  } catch (error) {
    notFound = error
  }
  check('unknown reference reports not_found', notFound?.code === 'not_found')

  // 6. token refresh on expiry -------------------------------------------------
  const grantsBefore = server.stats.tokenGrants.length
  let clock = 1_000_000
  const refreshClient = new VaultClient(settingsFor(server, { cacheMinutes: 0 }), { now: () => clock })
  await refreshClient.find('github')
  clock += 3600 * 1000 + 120_000 // past expires_in
  await refreshClient.find('github')
  const newGrants = server.stats.tokenGrants.slice(grantsBefore)
  check('expired access token is refreshed, not re-logged-in', newGrants.includes('refresh_token') && server.stats.refreshes === 1, JSON.stringify(newGrants))

  // 7. API key auth ------------------------------------------------------------
  const apiClient = new VaultClient(
    settingsFor(server, {
      apiKeyClientId: server.fixtures.apiClientId,
      apiKeyClientSecret: server.fixtures.apiClientSecret,
    }),
  )
  const apiVault = await apiClient.unlock()
  check('API key (client_credentials) login works', apiVault.items.length === 4 && apiClient.authMode === 'apikey')

  // 8. user key v2 (32-byte, stretched) ---------------------------------------
  const v2Server = await startMockServer({ userKeyV2: true })
  const v2Client = new VaultClient(settingsFor(v2Server))
  const v2Vault = await v2Client.unlock()
  check('32-byte (v2) user key is stretched and decrypts', v2Vault.byId.get('cipher-github')?.password === 'gh-p@ssw0rd-42')
  await v2Server.close()

  // 9. status reporting --------------------------------------------------------
  const unconfigured = new VaultClient({ serverUrl: server.url, email: '', masterPassword: '', apiKeyClientId: '', apiKeyClientSecret: '' })
  const status = JSON.parse(await unconfigured.status())
  check('status explains missing configuration', status.configured === false && status.missing.length >= 2 && Boolean(status.hint))
  const okStatus = JSON.parse(await client.status())
  check('status reports reachable + unlocked + item count', okStatus.reachable === true && okStatus.unlocked === true && okStatus.items === 4, JSON.stringify(okStatus))

  // 10. network failure --------------------------------------------------------
  const deadClient = new VaultClient(settingsFor(server, { serverUrl: 'http://127.0.0.1:1' }))
  let deadError = null
  try {
    await deadClient.unlock()
  } catch (error) {
    deadError = error
  }
  check('unreachable server raises a network_error with hint', deadError?.code === 'network_error' && Boolean(deadError.hint))

  // 11. resilience: an unreadable organization cipher is reported, not hidden --
  const orphanServer = await startMockServer({ orphanCipher: true })
  const orphanClient = new VaultClient(settingsFor(orphanServer))
  const orphanVault = await orphanClient.unlock()
  const orphanFind = JSON.parse(await orphanClient.find('共享'))
  check(
    'undecryptable org cipher is counted and surfaced, vault stays usable',
    orphanVault.items.length === 4 && orphanVault.skipped === 1 && Boolean(orphanFind.unavailableItems),
    `items=${orphanVault.items.length} skipped=${orphanVault.skipped}`,
  )
  await orphanServer.close()

  // 12. Argon2id KDF -----------------------------------------------------------
  const argonServer = await startMockServer({ kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 })
  if (argonServer) {
    const argonClient = new VaultClient(settingsFor(argonServer))
    try {
      const argonVault = await argonClient.unlock()
      check('Argon2id account unlocks (hash-wasm)', argonVault.byId.get('cipher-github')?.password === 'gh-p@ssw0rd-42')
    } catch (error) {
      check('Argon2id account reports a clear unsupported_kdf error', error?.code === 'unsupported_kdf', String(error))
    }
    await argonServer.close()
  }

  // 13. two-factor login -------------------------------------------------------
  const twoFactorServer = await startMockServer({ twoFactor: true })
  const twoFactorClient = new VaultClient(settingsFor(twoFactorServer))
  let challenge = null
  try {
    await twoFactorClient.unlock()
  } catch (error) {
    challenge = error
  }
  check('2FA account surfaces two_factor_required with a token', challenge?.code === 'two_factor_required' && challenge?.twoFactorToken === TWO_FACTOR_TOKEN, String(challenge?.code))
  check('2FA challenge lists the available providers', JSON.stringify(challenge?.providers) === JSON.stringify([0]))
  check('pending state is remembered for the retry', twoFactorClient.twoFactorPending?.provider === 0)

  let wrongCode = null
  try {
    await twoFactorClient.loginWithTwoFactor({ code: '000000' })
  } catch (error) {
    wrongCode = error
  }
  check('a wrong 2FA code is rejected', wrongCode !== null && !/two_factor_required/.test(wrongCode.code), String(wrongCode?.message))

  const twoFactorToken = await twoFactorClient.loginWithTwoFactor({ code: TWO_FACTOR_CODE })
  check('the right 2FA code completes the login', Boolean(twoFactorToken.accessToken) && twoFactorServer.stats.twoFactorAccepted === 1)
  check('pending state is cleared after success', twoFactorClient.twoFactorPending === null)
  const twoFactorVault = await twoFactorClient.unlock()
  check('2FA login unlocks the vault', twoFactorVault.items.length === 4)
  check('missing code is a clear bad_request', await (async () => {
    try {
      await twoFactorClient.loginWithTwoFactor({ code: '' })
      return false
    } catch (error) {
      return error.code === 'bad_request'
    }
  })())

  // A fresh client (simulating a host restart that cleared memory) must still
  // finish the challenge when the browser supplies the continuation token.
  const restartedClient = new VaultClient(settingsFor(twoFactorServer))
  let restartChallenge = null
  try {
    await restartedClient.unlock()
  } catch (error) {
    restartChallenge = error
  }
  const carriedToken = restartChallenge?.twoFactorToken
  check('a restarted host re-issues a challenge token', carriedToken === TWO_FACTOR_TOKEN, String(carriedToken))
  const restartedToken = await restartedClient.loginWithTwoFactor({ code: TWO_FACTOR_CODE, token: carriedToken })
  check('an explicitly carried token completes the login after a restart', Boolean(restartedToken.accessToken) && twoFactorServer.stats.twoFactorAccepted === 2)
  await twoFactorServer.close()

  await server.close()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exit(1)
})
