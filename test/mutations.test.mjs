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

  // 1b. non-login create (P0-5): a secure note carries a plain-JSON payload -----
  const note = await mutations.create(
    { type: 'secureNote', name: '安全笔记 A', notes: '多行\n备注', folderId: 'folder-work', secureNote: { type: 0 } },
    undefined,
  )
  check('create accepts a type name', note.created === true && note.type === 'secureNote', JSON.stringify(note))
  const noteRaw = server.fixtures.syncPayload.ciphers.find((cipher) => cipher.id === note.id)
  check(
    'secure-note payload is stored as plain JSON (not an EncString)',
    noteRaw?.secureNote?.type === 0,
    JSON.stringify(noteRaw?.secureNote),
  )
  // `all` says a secure note exists but no longer hands over its body — for
  // a note the body IS the secret. The caller has to name the field.
  const noteRead = JSON.parse(await client.get(note.id))
  check('a secure note reports its type but not its body under all', noteRead.secureNote?.type === 0 && !('notes' in noteRead) && noteRead.folderId === 'folder-work', JSON.stringify(noteRead).slice(0, 160))
  const noteBody = JSON.parse(await client.get(note.id, 'secureNote'))
  check('the body comes back on field=secureNote', noteBody.secureNote?.notes === '多行\n备注', JSON.stringify(noteBody).slice(0, 160))
  check('secure note summary reports folderId (P0-6)', JSON.parse(await client.find('安全笔记 A')).items[0]?.folderId === 'folder-work')

  // 2. create validation ---------------------------------------------------------
  const before = server.stats.created
  let validationError = null
  try {
    await mutations.create({ password: 'no-name' }, undefined)
  } catch (error) {
    validationError = error
  }
  check('create without a name fails before any request', validationError instanceof VaultError && validationError.code === 'bad_request' && server.stats.created === before)

  let typeError = null
  try {
    await mutations.create({ name: '类型错误', type: 'magnet' }, undefined)
  } catch (error) {
    typeError = error
  }
  check('create rejects an unknown type', typeError?.code === 'bad_request' && server.stats.created === before, typeError?.message)

  // 3. update --------------------------------------------------------------------
  const updated = await mutations.update('cipher-github', { password: 'rotated-pass-9' }, undefined)
  check('update reports success', updated.updated === true && updated.id === 'cipher-github')
  const afterUpdate = JSON.parse(await client.get('cipher-github'))
  check('updated password is readable', afterUpdate.password === 'rotated-pass-9')
  check('update keeps the other fields', afterUpdate.username === 'octocat@jindom.cc' && afterUpdate.notes === 'SSH 部署密钥在 CI 里')
  check('update keeps custom fields (whole-cipher replace)', afterUpdate.fields?.[1]?.value === 'tok_live_abc123', JSON.stringify(afterUpdate.fields))

  // 4. non-login and organization updates are supported (P0-5 / P1-8) ------------
  const noteUpdated = await mutations.update('cipher-db', { name: '生产数据库口令（已改名）' }, undefined)
  check('non-login item update is accepted', noteUpdated.updated === true, JSON.stringify(noteUpdated))
  const dbAfter = JSON.parse(await client.get('cipher-db'))
  const dbBody = JSON.parse(await client.get('cipher-db', 'secureNote'))
  check('non-login update keeps notes and type', dbAfter.name === '生产数据库口令（已改名）' && /postgres:\/\//.test(dbBody.secureNote?.notes ?? '') && dbAfter.type === 'secureNote', JSON.stringify(dbAfter).slice(0, 160))

  const orgUpdated = await mutations.update('cipher-org', { password: 'org-rotated-1' }, undefined)
  check('organization item update is accepted', orgUpdated.updated === true, JSON.stringify(orgUpdated))
  const orgAfter = JSON.parse(await client.get('cipher-org'))
  check(
    'organization update rotates the password under the org key',
    orgAfter.password === 'org-rotated-1' && orgAfter.username === 'deploy-bot' && orgAfter.fields?.[0]?.value === 'prod',
    JSON.stringify(orgAfter).slice(0, 200),
  )
  const orgRaw = server.fixtures.syncPayload.ciphers.find((cipher) => cipher.id === 'cipher-org')
  check('organization cipher keeps its key and org id on the wire', orgRaw.key === '2.' + orgRaw.key.slice(2) && orgRaw.organizationId === 'org-1')

  let missingError = null
  try {
    await mutations.update('cipher-nope', { password: 'x' }, undefined)
  } catch (error) {
    missingError = error
  }
  check('unknown id update is not_found', missingError?.code === 'not_found')

  // 5. legacy (account-key) update -------------------------------------------------
  const legacyUpdate = await mutations.update('cipher-legacy', { username: 'legacy-user-2' }, undefined)
  check('legacy account-key item updates without inventing an item key', legacyUpdate.updated === true)
  const legacyAfter = JSON.parse(await client.get('cipher-legacy'))
  check('legacy update keeps the password', legacyAfter.username === 'legacy-user-2' && legacyAfter.password === 'legacy-pass', JSON.stringify(legacyAfter).slice(0, 160))
  const legacyRaw = server.fixtures.syncPayload.ciphers.find((cipher) => cipher.id === 'cipher-legacy')
  check('legacy update sends no key (nothing to re-wrap)', !legacyRaw.key)

  // 6. soft delete + restore ------------------------------------------------------
  const deleted = await mutations.remove('cipher-legacy', {}, undefined)
  check('soft delete reports trash', deleted.deleted === true && deleted.permanent === false && /bitwarden_restore/.test(deleted.hint ?? ''))
  const afterDelete = JSON.parse(await client.find('老式加密条目'))
  check('trashed item leaves the vault list', afterDelete.matched === 0, `matched ${afterDelete.matched}`)
  const trashedRaw = server.fixtures.syncPayload.ciphers.find((cipher) => cipher.id === 'cipher-legacy')
  check('soft delete keeps the row and stamps deletedDate (P0-1)', Boolean(trashedRaw?.deletedDate) && server.stats.mutations.includes('delete'))
  const restored = await mutations.restore('cipher-legacy', undefined)
  check('restore reports success', restored.restored === true)
  const afterRestore = JSON.parse(await client.find('legacy-user'))
  check('restored item is back', afterRestore.matched === 1)
  check('restore clears deletedDate on the row', !server.fixtures.syncPayload.ciphers.find((cipher) => cipher.id === 'cipher-legacy')?.deletedDate)

  // 7. permanent purge needs the explicit confirmation (P1-5) ----------------------
  let confirmError = null
  try {
    await mutations.remove('cipher-reprompt', { permanent: true }, undefined)
  } catch (error) {
    confirmError = error
  }
  check('permanent delete without confirm is refused', confirmError?.code === 'confirmation_required', confirmError?.message)
  check('the refused purge sent no request', !server.stats.mutations.includes('purge'))

  await mutations.remove('cipher-reprompt', { permanent: true, confirm: true }, undefined)
  const afterPurge = JSON.parse(await client.find('需要重新验证的条目'))
  check('purged item is gone', afterPurge.matched === 0)
  check('permanent delete used DELETE and really dropped the row', server.stats.mutations.includes('purge') && !server.fixtures.syncPayload.ciphers.some((cipher) => cipher.id === 'cipher-reprompt'))
  let restoreError = null
  try {
    await mutations.restore('cipher-reprompt', undefined)
  } catch (error) {
    restoreError = error
  }
  // The purge removed the row from the server *and* from the refreshed vault, so
  // this is caught locally — the id no longer resolves, and no request is sent.
  check(
    'restoring a purged item reports not_found without a request',
    restoreError instanceof VaultError && restoreError.code === 'not_found',
    restoreError?.code,
  )

  // 8. encryption sanity --------------------------------------------------------
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
