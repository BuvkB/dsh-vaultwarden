/**
 * Cipher write-back test: create / update / delete / restore / purge against
 * the mock Vaultwarden, with the real encrypt → transport → sync → decrypt
 * round trip (per-item keys, type-2 EncStrings, deletedDate semantics).
 *
 * Run: node test/mutations.test.mjs
 */
import { VaultClient, VaultError } from '../lib/vault.js'
import { VaultMutations, buildLoginCipher } from '../lib/mutations.js'
import { EMAIL, PASSWORD, RFC_SECRET, startMockServer } from './mock-server.mjs'

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
  console.log('cipher write-back test (create/update/delete/restore/purge)')
  const server = await startMockServer({ repromptCipher: true })
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }
  const client = new VaultClient(settingsFor(server))
  await client.unlock()
  const mutations = new VaultMutations(client)

  // 1. create ------------------------------------------------------------------
  const created = await mutations.create(
    {
      name: '新站点账号',
      username: 'new-user@example.com',
      password: 'new-pass-123',
      totp: RFC_SECRET,
      uris: ['https://new.example.com/login'],
      notes: '写回测试条目',
      fields: [{ name: '环境', value: 'test', type: 0 }],
      favorite: true,
    },
    undefined,
  )
  check('create returns the new id', typeof created.id === 'string' && created.created === true, JSON.stringify(created))
  check('server recorded the create', server.stats.mutations.includes('create'))
  const found = JSON.parse(await client.find('新站点账号'))
  check('created entry is searchable after the auto-sync', found.matched === 1 && found.items[0].username === 'new-user@example.com')
  const revealed = JSON.parse(await client.get(created.id))
  check('created entry decrypts end-to-end', revealed.password === 'new-pass-123' && revealed.notes === '写回测试条目')
  check('created custom field decrypts', revealed.fields?.[0]?.value === 'test')
  check('created TOTP decrypts', /^\d{6}$/.test(JSON.parse(await client.get(created.id, 'totp')).totp?.code ?? ''), 'bare Base32 secret defaults to 6 digits')
  const rawCipher = server.fixtures.syncPayload.ciphers.find((cipher) => cipher.id === created.id)
  check('cipher carries a wrapped per-item key', typeof rawCipher.key === 'string' && rawCipher.key.startsWith('2.'))

  // 2. create validation ---------------------------------------------------------
  const before = server.stats.created
  let validationError = null
  try {
    await mutations.create({ password: 'no-name' }, undefined)
  } catch (error) {
    validationError = error
  }
  check('create without a name fails before any request', validationError instanceof VaultError && validationError.code === 'bad_request' && server.stats.created === before)

  // 3. update --------------------------------------------------------------------
  const updated = await mutations.update('cipher-github', { password: 'rotated-pass-9' }, undefined)
  check('update reports success', updated.updated === true && updated.id === 'cipher-github')
  const afterUpdate = JSON.parse(await client.get('cipher-github'))
  check('updated password is readable', afterUpdate.password === 'rotated-pass-9')
  check('update keeps the other fields', afterUpdate.username === 'octocat@jindom.cc' && afterUpdate.notes === 'SSH 部署密钥在 CI 里')
  check('update keeps custom fields (whole-cipher replace)', afterUpdate.fields?.[1]?.value === 'tok_live_abc123', JSON.stringify(afterUpdate.fields))

  // 4. update guards ---------------------------------------------------------------
  let typeError = null
  try {
    await mutations.update('cipher-db', { name: 'x' }, undefined)
  } catch (error) {
    typeError = error
  }
  check('non-login item update is refused', typeError?.code === 'unsupported_type')

  let orgError = null
  try {
    await mutations.update('cipher-org', { password: 'x' }, undefined)
  } catch (error) {
    orgError = error
  }
  check('organization item update is refused', orgError?.code === 'unsupported_org_item', orgError?.code)

  let missingError = null
  try {
    await mutations.update('cipher-nope', { password: 'x' }, undefined)
  } catch (error) {
    missingError = error
  }
  check('unknown id update is not_found', missingError?.code === 'not_found')

  // 5. soft delete + restore ------------------------------------------------------
  const deleted = await mutations.remove('cipher-legacy', {}, undefined)
  check('soft delete reports trash', deleted.deleted === true && deleted.permanent === false)
  const afterDelete = JSON.parse(await client.find('老式加密条目'))
  check('trashed item leaves the vault list', afterDelete.matched === 0, `matched ${afterDelete.matched}`)
  const restored = await mutations.restore('cipher-legacy', undefined)
  check('restore reports success', restored.restored === true)
  const afterRestore = JSON.parse(await client.find('legacy-user'))
  check('restored item is back', afterRestore.matched === 1)

  // 6. permanent purge ---------------------------------------------------------------
  await mutations.remove('cipher-reprompt', { permanent: true }, undefined)
  const afterPurge = JSON.parse(await client.find('需要重新验证的条目'))
  check('purged item is gone', afterPurge.matched === 0)
  let restoreError = null
  try {
    await mutations.restore('cipher-reprompt', undefined)
  } catch (error) {
    restoreError = error
  }
  check('restoring a purged item reports the server error', restoreError instanceof VaultError && /写回失败/.test(restoreError.message))

  // 7. encryption sanity --------------------------------------------------------
  const { userKey } = await client.unlockKeys()
  const built = buildLoginCipher({ name: 'enc-check', username: 'u', password: 'p' }, userKey)
  check('built cipher uses a per-item key + type-2 strings', built.type === 1 && built.key.startsWith('2.') && built.login.password.startsWith('2.'))

  await server.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
