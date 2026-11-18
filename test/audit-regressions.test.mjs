/**
 * Regression suite for the 2026-11-18 audit.
 *
 * Run: node test/audit-regressions.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultClient } from '../lib/vault.js'
import { VaultMutations } from '../lib/mutations.js'
import { CacheStore } from '../lib/cache-store.js'
import { EMAIL, PASSWORD, startMockServer } from './mock-server.mjs'

let passed = 0
let failed = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log('  ok ' + label)
  } else {
    failed += 1
    console.error('  FAIL ' + label + (detail ? ' - ' + detail : ''))
  }
}

const settingsFor = (server) => ({
  serverUrl: server.url,
  email: EMAIL,
  masterPassword: PASSWORD,
  apiKeyClientId: '',
  apiKeyClientSecret: '',
  cacheMinutes: 30,
})

async function main() {
  console.log('audit regressions (2026-11-18)')
  const server = await startMockServer({ richCipher: true, repromptCipher: true })
  if (!server) {
    console.error('  hash-wasm missing, skipping')
    process.exit(0)
  }
  const dir = mkdtempSync(join(tmpdir(), 'vw-audit-reg-'))
  try {
    const client = new VaultClient(settingsFor(server), {
      cacheStore: new CacheStore(join(dir, 'cache.json.gz'), { enabled: false }),
    })
    const mutations = new VaultMutations(client, { guard: () => null })
    await client.unlock()

    const syncsBefore = server.stats.syncs
    const id = client.vault.items.find((item) => item.type === 'login')?.id
    await client.get(id, 'password', undefined, { fresh: true })
    await client.get(id, 'password', undefined, { fresh: true })
    check('localCache false keeps fresh reads on the revision probe', server.stats.syncs === syncsBefore, 'syncs delta ' + (server.stats.syncs - syncsBefore))

    const created = await mutations.create({
      name: 'field-regression',
      type: 'login',
      fields: [
        { name: 'API Key', value: 'one', type: 1 },
        { name: 'API Key', value: 'two', type: 1 },
        { name: 'Other', value: 'x', type: 0 },
      ],
    })
    await mutations.update(created.id, { fields: [{ name: 'Other', value: 'y', type: 0 }] })
    let fields = JSON.parse(await client.get(created.id, 'fields')).fields
    check('partial field merge preserves duplicate names', fields.length === 3 && fields[2].value === 'y', JSON.stringify(fields))
    await mutations.update(created.id, { fields: [], replaceFields: true })
    fields = JSON.parse(await client.get(created.id, 'fields')).fields
    check('replaceFields with empty list clears custom fields', fields.length === 0, JSON.stringify(fields))
    await mutations.update(created.id, { fields: [{ name: 'Only', value: '1', type: 0 }], replaceFields: true })
    fields = JSON.parse(await client.get(created.id, 'fields')).fields
    check('replaceFields replaces the whole field list', fields.length === 1 && fields[0].name === 'Only', JSON.stringify(fields))

    const richBefore = JSON.parse(await client.get('cipher-rich'))
    check('rich fixture starts with two URIs', richBefore.uris.length === 2, JSON.stringify(richBefore.uris))
    await mutations.update('cipher-rich', { uris: ['https://spa.jindom.cc/sso'] })
    const richAfter = server.fixtures.syncPayload.ciphers.find((cipher) => cipher.id === 'cipher-rich')
    check('URI match policy follows the surviving URI', richAfter.login.uris[0]?.match === 0 && richAfter.login.uris[0]?.uriChecksum === 'checksum-2', JSON.stringify(richAfter.login.uris))

    const org = client.vault.byId.get('cipher-org')
    check('organization collection name decrypts with the org key', org?.collections?.[0] === '运维', JSON.stringify(org?.collections))

    const richRaw = server.fixtures.syncPayload.ciphers.find((cipher) => cipher.id === 'cipher-rich')
    richRaw.passwordHistory = [{ password: 'not-an-encstring', lastUsedDate: '2025-01-01T00:00:00Z' }]
    server.bumpRevision()
    const afterCorrupt = await client.syncNow()
    const richItem = afterCorrupt.items.find((item) => item.id === 'cipher-rich')
    check('a corrupt passwordHistory row keeps the entry visible', afterCorrupt.skipped === 0 && Boolean(richItem) && richItem.password === 'rich-pass-1', JSON.stringify({ skipped: afterCorrupt.skipped, present: Boolean(richItem) }))

    const repromptRow = server.fixtures.syncPayload.ciphers.find((cipher) => cipher.id === 'cipher-github')
    repromptRow.reprompt = 1
    server.bumpRevision()
    let exportError = null
    try {
      await client.exportPasskey('cipher-github', '', undefined, { outputDir: join(dir, 'passkeys') })
    } catch (error) {
      exportError = error
    }
    check('stale passkey export is blocked by the fresh reprompt flag', exportError?.code === 'reprompt_required', String(exportError?.code ?? exportError?.message))

    const generated = await mutations.create({
      name: 'generated-regression',
      type: 'login',
      username: 'generated-user',
      generatePassword: true,
      passwordOptions: { length: 24, symbols: false },
    })
    const generatedRead = JSON.parse(await client.get(generated.id, 'password'))
    check('generated create does not return the secret', generated.passwordGenerated === true && !JSON.stringify(generated).includes(generatedRead.password), JSON.stringify(generated))
    check('generated password obeys length and symbol options', generatedRead.password.length === 24 && !/[!@#$%^&*()]/.test(generatedRead.password), String(generatedRead.password?.length))
    const rotated = await mutations.update(generated.id, { generatePassword: true, passwordOptions: { length: 32 } })
    const rotatedRead = JSON.parse(await client.get(generated.id, 'password'))
    const history = JSON.parse(await client.get(generated.id, 'passwordHistory')).passwordHistory
    check('generated update rotates and records history', rotated.passwordGenerated === true && rotatedRead.password.length === 32 && history.length === 1 && rotatedRead.password !== generatedRead.password, JSON.stringify({ history: history.length }))

    const longNote = 'x'.repeat(2500) + 'END'
    const note = await mutations.create({ type: 'secureNote', name: 'long-note-regression', notes: longNote, secureNote: { type: 0 } })
    const shortRead = JSON.parse(await client.get(note.id, 'secureNote'))
    const fullRead = JSON.parse(await client.get(note.id, 'secureNote', undefined, { fullText: true }))
    check('ordinary note read stays truncated', shortRead.secureNote.notes.length < longNote.length && !shortRead.secureNote.notes.endsWith('END'))
    check('fullText reveal returns the complete note', fullRead.secureNote.notes === longNote)

    const panelShape = { name: 'panel-shape', username: '', password: '', totp: '', uris: '', notes: '', favorite: false, reprompt: 0, folderId: '', fields: [], card: {}, identity: {}, sshKey: {} }
    for (const type of ['login', 'secureNote', 'card', 'identity', 'sshKey']) {
      let ok = false
      try {
        await mutations.create({ ...panelShape, type, name: 'panel-' + type })
        ok = true
      } catch (error) {
        ok = false
      }
      check('panel blank form creates ' + type, ok)
    }
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
