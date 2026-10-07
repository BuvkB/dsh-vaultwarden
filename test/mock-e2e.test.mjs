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

  // 3b. paged reads: the panel's small first page and its continuation ---------
  const page1 = await client.findEntries('', 2, 0)
  check(
    'a page reports its offset and that more follows',
    page1.offset === 0 && page1.items.length === 2 && page1.matched === 4 && page1.hasMore === true,
    JSON.stringify({ offset: page1.offset, items: page1.items.length, matched: page1.matched, hasMore: page1.hasMore }),
  )
  const page2 = await client.findEntries('', 2, 2)
  check(
    'the next page continues without overlap',
    page2.offset === 2 && page2.items.length === 2 && page2.hasMore === false && page2.items.every((item) => !page1.items.some((first) => first.id === item.id)),
    JSON.stringify(page2.items.map((item) => item.id)),
  )
  const beyond = await client.findEntries('', 2, 99)
  check('an out-of-range offset comes back empty and complete', beyond.items.length === 0 && beyond.hasMore === false, JSON.stringify({ items: beyond.items.length, hasMore: beyond.hasMore }))

  // 3c. sidebar sections: one place at a time, counted the same way -----------
  // The panel's navigation is an overview read plus one section read per visit.
  // A badge and the list behind it must be the same number, which only holds if
  // both narrow the pool the same way — that is what `section` guarantees.
  const overview = await client.overview()
  check('overview counts the whole vault from one read', overview.ciphers === 4 && overview.items === 4 && overview.archived === 0 && overview.trashed === 0, JSON.stringify(overview))
  check('overview lists the cipher types in official-client order', overview.types.map((entry) => entry.id).join(',') === 'login,secureNote' && overview.types[0].count === 3, JSON.stringify(overview.types))
  check('overview counts each folder and the unfiled entries', overview.folderList.some((folder) => folder.id === 'folder-work' && folder.count === 1) && overview.unfiled === 3, JSON.stringify(overview.folderList))
  check('overview carries the places the panel badges', overview.sections.map((entry) => `${entry.id}:${entry.count}`).join(',') === 'all:4,favorites:1,totp:1,archive:0,trash:0', JSON.stringify(overview.sections))

  const loginSection = await client.findEntries('', 50, 0, undefined, { section: 'type', sectionValue: 'login' })
  check('a type section reads only that type', loginSection.matched === 3 && loginSection.items.every((item) => item.type === 'login'), JSON.stringify(loginSection.items.map((item) => item.id)))
  check('a section badge and the section read agree', loginSection.matched === overview.types[0].count, `${loginSection.matched}/${overview.types[0].count}`)
  const folderSection = await client.findEntries('', 50, 0, undefined, { section: 'folder', sectionValue: 'folder-work' })
  check('a folder section reads that folder and nothing else', folderSection.matched === 1 && folderSection.items[0]?.id === 'cipher-github', JSON.stringify(folderSection.items.map((item) => item.id)))
  const unfiledSection = await client.findEntries('', 50, 0, undefined, { section: 'unfiled' })
  check('the unfiled section skips entries that have a folder', unfiledSection.matched === 3 && !unfiledSection.items.some((item) => item.id === 'cipher-github'), JSON.stringify(unfiledSection.items.map((item) => item.id)))
  const totpSection = await client.findEntries('', 50, 0, undefined, { section: 'totp' })
  check('the code section holds only entries with a TOTP secret', totpSection.matched === 1 && totpSection.items[0]?.hasTotp === true, JSON.stringify(totpSection.items.map((item) => item.id)))
  const favoriteSection = await client.findEntries('', 2, 0, undefined, { section: 'favorites' })
  check('a section pages inside itself', favoriteSection.matched === 1 && favoriteSection.hasMore === false, JSON.stringify({ matched: favoriteSection.matched, hasMore: favoriteSection.hasMore }))
  const trashSection = await client.findEntries('', 50, 0, undefined, { section: 'trash' })
  check('the trash section is empty until something is deleted', trashSection.matched === 0 && trashSection.vaultItems === 0, JSON.stringify(trashSection))
  // The host memoises one findEntries answer, so the section has to be part of
  // the key: otherwise opening the login section would hand the next unfiltered
  // read three rows, or the model's search a folder's worth of entries.
  const allAgain = await client.findEntries('', 50)
  check('a section read does not leak into the unfiltered read', allAgain.matched === 4 && allAgain.items.some((item) => item.type === 'secureNote'), JSON.stringify(allAgain.items.map((item) => item.id)))
  const repeatSection = await client.findEntries('', 50, 0, undefined, { section: 'type', sectionValue: 'login' })
  check('a repeated section read still answers after other sections', repeatSection.matched === 3, String(repeatSection.matched))

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
  // Per vaultwarden's contract the challenge carries the provider list only —
  // there is no server-issued continuation token.
  check('2FA account surfaces two_factor_required', challenge?.code === 'two_factor_required', String(challenge?.code))
  check('2FA challenge lists the available providers', JSON.stringify(challenge?.providers) === JSON.stringify([0]))
  check('pending state is remembered for the retry', twoFactorClient.twoFactorPending?.provider === 0)

  // A background retry (poll tick, tool call) must not fire another password
  // grant while a challenge is outstanding: that would hammer the login
  // endpoint and its rate limiter.
  const challengesBefore = twoFactorServer.stats.twoFactorChallenges
  let backgroundRetry = null
  try {
    await twoFactorClient.unlock()
  } catch (error) {
    backgroundRetry = error
  }
  check('a background retry re-surfaces the pending challenge', backgroundRetry?.code === 'two_factor_required', String(backgroundRetry?.code))
  check('a background retry does not re-issue a challenge', twoFactorServer.stats.twoFactorChallenges === challengesBefore, `challenges ${challengesBefore}→${twoFactorServer.stats.twoFactorChallenges}`)

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

  // A fresh client (simulating a host restart that cleared memory) can still
  // finish: submitting a code re-runs the whole grant, so no carried state is
  // needed.
  const restartedClient = new VaultClient(settingsFor(twoFactorServer))
  let restartChallenge = null
  try {
    await restartedClient.unlock()
  } catch (error) {
    restartChallenge = error
  }
  check('a restarted host re-issues a challenge', restartChallenge?.code === 'two_factor_required', String(restartChallenge?.code))
  const restartedToken = await restartedClient.loginWithTwoFactor({ code: TWO_FACTOR_CODE })
  check('a restart recovers with just a fresh code', Boolean(restartedToken.accessToken) && twoFactorServer.stats.twoFactorAccepted === 2)

  // The UI's escape hatch: reset() must clear a stale challenge so the next
  // attempt starts a clean login instead of re-surfacing the dead one.
  const staleClient = new VaultClient(settingsFor(twoFactorServer))
  try {
    await staleClient.unlock()
  } catch {
    /* expected challenge */
  }
  check('a stale challenge is pending before reset', staleClient.twoFactorPending !== null)
  staleClient.reset()
  check('reset clears the pending challenge', staleClient.twoFactorPending === null && staleClient.token === null && staleClient.vault === null)
  let freshChallenge = null
  try {
    await staleClient.unlock()
  } catch (error) {
    freshChallenge = error
  }
  check('after reset a fresh challenge can be issued', freshChallenge?.code === 'two_factor_required', String(freshChallenge?.code))
  await twoFactorServer.close()

  await server.close()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exit(1)
})
