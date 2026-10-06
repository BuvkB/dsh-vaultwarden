/**
 * Write-back regression suite for the P0/P1 round.
 *
 * Every section pins one failure mode that the old tests could not see because
 * the mock reproduced the same mistake as the plugin:
 *   1. P0-1  soft delete must go over PUT /delete, and the row must survive
 *            with a deletedDate (POST /delete is the permanent one)
 *   2. P0-4  a concurrent edit must come back as stale_revision, and the write
 *            must carry lastKnownRevisionDate + encryptedFor (P1-1)
 *   3. P0-6  folderId moves in, moves out on null, and folderList hands out ids
 *   4. P0-3  trash: hidden by default, visible with includeTrashed, countable
 *            in status(), restorable
 *   5. P0-2  a whole-cipher replace keeps every field it does not touch
 *            (fido2Credentials, passwordHistory, passwordRevisionDate, the
 *            singular uri, uris[].match/uriChecksum, attachments, archivedDate)
 *   6. P1-4  archived items stay out of the default search
 *   7. the panel list cache is dropped when the vault is replaced
 *
 * Run: node test/write-back.test.mjs
 */
import { VaultClient, VaultError } from '../lib/vault.js'
import { VaultMutations } from '../lib/mutations.js'
import { EMAIL, PASSWORD, USER_ID, encryptString, startMockServer } from './mock-server.mjs'

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
  console.log('write-back regression (P0-1/P0-3/P0-4/P0-6, P1-1/P1-4, data preservation)')
  const server = await startMockServer({ richCipher: true })
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }
  const client = new VaultClient(settingsFor(server))
  await client.unlock()
  const mutations = new VaultMutations(client)
  const row = (id) => server.fixtures.syncPayload.ciphers.find((cipher) => cipher.id === id)

  // 1. P0-4: a concurrent edit is refused, not overwritten ----------------------
  const github = row('cipher-github')
  const knownRevision = github.revisionDate
  github.revisionDate = new Date(Date.now() + 60_000).toISOString() // another client wrote
  let stale = null
  try {
    await mutations.update('cipher-github', { notes: '并发写入' }, undefined)
  } catch (error) {
    stale = error
  }
  check('a stale write is refused', stale instanceof VaultError && stale.code === 'stale_revision', stale?.message)
  check('the refused write changed nothing', github.notes === row('cipher-github').notes)
  github.revisionDate = knownRevision // back to what the client holds

  const ok = await mutations.update('cipher-github', { notes: '串行写入' }, undefined)
  check('the retried write lands once the revision matches', ok.updated === true)
  const sent = server.stats.lastWrite.body
  check('the write carries lastKnownRevisionDate (P0-4)', sent.lastKnownRevisionDate === knownRevision, JSON.stringify(sent.lastKnownRevisionDate))
  check('the write carries encryptedFor (P1-1)', sent.encryptedFor === USER_ID, JSON.stringify(sent.encryptedFor))

  // 2. P1-1 on create ------------------------------------------------------------
  const made = await mutations.create({ name: '字段检查条目', username: 'u1', password: 'p1' }, undefined)
  check('create carries encryptedFor', server.stats.lastWrite.body.encryptedFor === USER_ID, JSON.stringify(server.stats.lastWrite.body.encryptedFor))
  check('the created row keeps its own item key', typeof row(made.id)?.key === 'string' && row(made.id).key.startsWith('2.'))

  // 3. P0-6: folder tri-state + folderList ---------------------------------------
  const folders = JSON.parse(await client.folderList())
  check(
    'folderList exposes id + name + count',
    folders.folders.some((folder) => folder.id === 'folder-work' && folder.name === '工作' && folder.count > 0) && typeof folders.unfiled === 'number',
    JSON.stringify(folders),
  )
  await mutations.update('cipher-db', { folderId: 'folder-work' }, undefined)
  check('folderId moves an item into a folder', row('cipher-db').folderId === 'folder-work')
  await mutations.update('cipher-db', { folderId: null }, undefined)
  check('folderId: null moves it back out (P0-6)', row('cipher-db').folderId === undefined, JSON.stringify(row('cipher-db').folderId))
  let badFolder = null
  try {
    await mutations.update('cipher-db', { folderId: 'folder-nope' }, undefined)
  } catch (error) {
    badFolder = error
  }
  check('an unknown folderId is translated', badFolder?.code === 'bad_folder', badFolder?.message)

  // 4. P0-1 + P0-3: trash is a soft delete with a way back -----------------------
  const trashed = await mutations.remove('cipher-db', {}, undefined)
  check('soft delete reports a recoverable trash', trashed.deleted === true && trashed.permanent === false && /bitwarden_restore/.test(trashed.hint ?? ''))
  check('soft delete uses PUT /delete (P0-1)', server.stats.paths.includes('PUT /api/ciphers/cipher-db/delete') && !server.stats.paths.includes('POST /api/ciphers/cipher-db/delete'), server.stats.paths.slice(-4).join(' | '))
  check('the trashed row still exists with a deletedDate', Boolean(row('cipher-db')?.deletedDate) && server.stats.mutations.includes('delete'))

  const hidden = JSON.parse(await client.find('生产数据库口令'))
  check('trash is out of the default search', hidden.matched === 0)
  check('the search still reports the trash (P0-3)', /回收站/.test(hidden.trashedItems ?? ''), JSON.stringify(hidden.trashedItems))
  const shown = JSON.parse(await client.find('生产数据库口令', 8, undefined, { includeTrashed: true }))
  check('includeTrashed lists it as trashed', shown.matched === 1 && shown.items[0].trashed === true)
  const merged = await client.findEntries('', 100, 0, undefined, { includeArchived: true, includeTrashed: true })
  check('the trashed row leads the merged list (P0-3)', merged.items[0]?.id === 'cipher-db', JSON.stringify(merged.items.map((item) => item.id)))
  check('behind it the live rows follow in their own order', merged.items.length >= 4 && merged.items.slice(1).every((item) => !item.trashed), JSON.stringify(merged.items.map((item) => item.id + (item.trashed ? '*' : ''))))
  let readError = null
  try {
    await client.get('cipher-db')
  } catch (error) {
    readError = error
  }
  check('a trashed item refuses a silent read', readError?.code === 'trashed', readError?.code)
  const readTrashed = JSON.parse(await client.get('cipher-db', 'all', undefined, { includeTrashed: true }))
  check('includeTrashed reads it on purpose', /postgres:\/\//.test(readTrashed.notes ?? ''))
  const report = JSON.parse(await client.status())
  check('status() counts the trash (P0-3)', report.trashed >= 1, JSON.stringify(report.trashed))
  const back = await mutations.restore('cipher-db', undefined)
  check('restore empties the trash', back.restored === true && !row('cipher-db').deletedDate && JSON.parse(await client.find('生产数据库口令')).matched === 1)

  // 5. P0-2: a whole-cipher replace must not drop what it does not touch ---------
  const rich = row('cipher-rich')
  const before = JSON.parse(JSON.stringify(rich))
  const touched = await mutations.update('cipher-rich', { notes: '改过的备注' }, undefined)
  check('the rich item updates', touched.updated === true)
  const after = row('cipher-rich')
  check('fido2Credentials survive (P0-2)', after.login.fido2Credentials?.[0]?.credentialId === before.login.fido2Credentials[0].credentialId)
  check('passwordHistory survives (P0-2)', after.passwordHistory?.length === 1 && after.passwordHistory[0].password === before.passwordHistory[0].password)
  check('passwordRevisionDate survives (P0-2)', after.login.passwordRevisionDate === before.login.passwordRevisionDate)
  check('uris[].match / uriChecksum survive (P0-2)', after.login.uris[0].match === 3 && after.login.uris[0].uriChecksum === 'checksum-1')
  check('the singular login.uri stays in step (P0-2)', after.login.uri === after.login.uris[0].uri)
  check('attachments survive (P0-2)', after.attachments?.[0]?.id === 'att-1')
  check('archivedDate survives an unrelated edit (P0-2)', after.archivedDate === before.archivedDate)
  check('the item key is reused, not rotated (P0-2)', after.key === before.key)
  const richRead = JSON.parse(await client.get('cipher-rich'))
  check('the decrypted projection agrees', richRead.hasFido2 === true && richRead.passwordHistory?.[0]?.password === 'rich-pass-0' && richRead.archived === true && richRead.uris?.length === 2)
  check('the edited note is readable', richRead.notes === '改过的备注')

  // rewriting the uri list keeps the match policy and re-syncs the singular copy
  await mutations.update('cipher-rich', { uris: ['https://spa.jindom.cc/login', 'https://spa.jindom.cc/sso2'] }, undefined)
  const rewritten = row('cipher-rich')
  check('a uri rewrite keeps the stored match policy', rewritten.login.uris[0].match === 3 && rewritten.login.uri === rewritten.login.uris[0].uri)

  // 6. P1-4: archived items stay out of the default search -----------------------
  const archivedSearch = JSON.parse(await client.find('SPA 管理后台'))
  check('archived items are hidden by default', archivedSearch.matched === 0)
  check('the search reports the archive count', /归档/.test(archivedSearch.archivedItems ?? ''), JSON.stringify(archivedSearch.archivedItems))
  const withArchived = JSON.parse(await client.find('SPA', 8, undefined, { includeArchived: true }))
  check('includeArchived lists the item as archived', withArchived.matched === 1 && withArchived.items[0].archived === true)

  await mutations.update('cipher-rich', { archived: false }, undefined)
  check('archived: false un-archives (P1-4)', !row('cipher-rich').archivedDate && JSON.parse(await client.find('SPA 管理后台')).matched === 1)
  await mutations.update('cipher-rich', { archived: true }, undefined)
  check('archived: true re-archives', Boolean(row('cipher-rich').archivedDate))

  // 6b. the settings panel reads with includeArchived, the model tools do not ----
  // gateway.list() is what the panel calls; it asks for archived rows on
  // purpose (a retired entry must stay findable for the person who filed it),
  // while find() and the tool wrappers keep hiding them.
  const panelRows = await client.findEntries('', 100, 0, undefined, { includeArchived: true })
  const panelRich = panelRows.items.find((item) => item.id === 'cipher-rich')
  check('the panel list keeps an archived row', panelRich?.archived === true, JSON.stringify(panelRich))
  check('the panel list counts archived rows in the total', panelRows.vaultItems === panelRows.matched, JSON.stringify({ vaultItems: panelRows.vaultItems, matched: panelRows.matched, returned: panelRows.returned }))
  const modelRows = await client.findEntries('', 100, 0)
  check('the default list read drops the archived row', !modelRows.items.some((item) => item.id === 'cipher-rich'))
  check('the default list total excludes the archive', modelRows.vaultItems < panelRows.vaultItems, JSON.stringify({ plain: modelRows.vaultItems, panel: panelRows.vaultItems }))
  check('the archived flag is part of the memo key', panelRows !== modelRows)

  // 7. the panel list cache follows the vault ------------------------------------
  const first = await client.findEntries('', 100, 0)
  const second = await client.findEntries('', 100, 0)
  check('an identical list query is served from the memo', first === second)
  const { userKey } = await client.unlockKeys()
  server.fixtures.syncPayload.folders[0].name = encryptString('工作（新）', userKey)
  server.bumpRevision()
  await client.syncNow()
  const third = await client.findEntries('', 100, 0)
  check('a replaced vault drops the memo', third !== second)
  check(
    'the renamed folder shows through the list (renameFolder regression)',
    third.items.find((item) => item.id === 'cipher-github')?.folder === '工作（新）',
    JSON.stringify(third.items.find((item) => item.id === 'cipher-github')?.folder),
  )

  await server.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
