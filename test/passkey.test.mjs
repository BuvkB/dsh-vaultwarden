/**
 * Passkey (WebAuthn) vault support: decryption, metadata projection, the
 * gated private-key export, and the import/remove write path.
 *
 * Run: node test/passkey.test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultClient, VaultError } from '../lib/vault.js'
import { VaultMutations } from '../lib/mutations.js'
import { EMAIL, PASSWORD, startMockServer } from './mock-server.mjs'

let passed = 0
let failed = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    passed++
    console.log('  ✓ ' + label)
  } else {
    failed++
    console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''))
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
  console.log('passkey vault test (metadata / gated export / import / remove)')
  const server = await startMockServer({ repromptCipher: true })
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }
  const exportDir = mkdtempSync(join(tmpdir(), 'bw-passkey-export-'))
  try {
    const client = new VaultClient(settingsFor(server))
    await client.unlock()
    const mutations = new VaultMutations(client, { guard: () => null })

    // 1. metadata -------------------------------------------------------------
    const listed = await client.passkeyList('cipher-github')
    check('the entry reports one passkey', listed.passkeys.length === 1, JSON.stringify(listed))
    const meta = listed.passkeys[0]
    check('the rpId is decrypted', meta.rpId === 'github.com', JSON.stringify(meta))
    check('the user name is decrypted', meta.userName === 'octocat@example.com')
    check('discoverable is a boolean, not the stored string', meta.discoverable === true)
    check('the credential id is the raw id in base64', meta.credentialId === server.fixtures.passkeyCredentialId.toString('base64'), meta.credentialId)
    check('the metadata carries no private key', !('keyValue' in meta) && !('privateKey' in meta))
    const viaGet = JSON.parse(await client.get('cipher-github', 'passkeys'))
    check('field=passkeys projects metadata only', viaGet.passkeys?.[0]?.rpId === 'github.com' && !('keyValue' in viaGet.passkeys[0]))

    // 2. export needs the human proof -----------------------------------------
    let refused = null
    try {
      await client.exportPasskey('cipher-github', '', undefined, { outputDir: exportDir })
    } catch (error) {
      refused = error
    }
    check('export without a master-password proof is refused', refused instanceof VaultError && refused.code === 'passkey_proof_required', String(refused?.code))

    const proof = await client.authorizeReprompt(PASSWORD, undefined, { id: 'cipher-github' })
    check('the panel proof is accepted', proof?.authorized === true, JSON.stringify(proof))

    // 3. export writes a 0600 CDP-shaped file ---------------------------------
    const exported = await client.exportPasskey('cipher-github', '', undefined, { outputDir: exportDir })
    check('export reports a path', typeof exported.path === 'string' && exported.path.length > 0)
    check('export never returns the private key', !('privateKey' in exported) && !JSON.stringify(exported).includes(server.fixtures.passkeyPkcs8.toString('base64').slice(0, 24)))
    const mode = statSync(exported.path).mode & 0o777
    check('the exported file is 0600', mode === 0o600, mode.toString(8))
    const document = JSON.parse(readFileSync(exported.path, 'utf8'))
    check('the file declares its format', document.format === 'webauthn-credential/v1' && document.cdp)
    check('the credential id is converted to standard base64', document.cdp.credentialId === server.fixtures.passkeyCredentialId.toString('base64'))
    check('the private key is the original PKCS#8 in standard base64', document.cdp.privateKey === server.fixtures.passkeyPkcs8.toString('base64'))
    check('the rpId survives', document.cdp.rpId === 'github.com')
    check('the user handle is decoded from base64url to base64', document.cdp.userHandle === Buffer.from('github-user-1').toString('base64'))
    check('the counter becomes signCount', document.cdp.signCount === 0)
    check('discoverable becomes isResidentCredential', document.cdp.isResidentCredential === true)

    // 4. import round trip ----------------------------------------------------
    const created = await mutations.create({ name: 'Passkey 导入测试', username: 'import-user', notes: '保留备注', favorite: true }, undefined)
    const imported = await mutations.importPasskey(created.id, document.cdp, undefined)
    check('import reports one credential', imported.imported === true && imported.count === 1, JSON.stringify(imported))
    // A passkey-only edit must not reset the entry's own fields: buildCipherBody
    // rebuilds name/favorite/reprompt from its `plain` argument.
    const preserved = await client.draftEntry(created.id)
    check(
      'the import preserved the entry fields',
      preserved.name === 'Passkey 导入测试' && preserved.username === 'import-user' && preserved.notes === '保留备注' && preserved.favorite === true,
      JSON.stringify({ name: preserved.name, username: preserved.username, notes: preserved.notes, favorite: preserved.favorite }),
    )
    const importedList = await client.passkeyList(created.id)
    check('the imported passkey is readable', importedList.passkeys.length === 1 && importedList.passkeys[0].rpId === 'github.com')
    let duplicate = null
    try {
      await mutations.importPasskey(created.id, document.cdp, undefined)
    } catch (error) {
      duplicate = error
    }
    check('a duplicate credential id is refused', duplicate instanceof VaultError && duplicate.code === 'passkey_exists', String(duplicate?.code))

    await client.authorizeReprompt(PASSWORD, undefined, { id: created.id })
    const reExported = await client.exportPasskey(created.id, '', undefined, { outputDir: exportDir })
    const again = JSON.parse(readFileSync(reExported.path, 'utf8'))
    check('the re-exported private key matches the original', again.cdp.privateKey === document.cdp.privateKey)
    check('the re-exported credential id matches the original', again.cdp.credentialId === document.cdp.credentialId)

    // 5. remove ---------------------------------------------------------------
    const removed = await mutations.removePasskey(created.id, '', undefined)
    check('remove reports zero left', removed.removed === true && removed.count === 0, JSON.stringify(removed))
    const afterRemove = await client.passkeyList(created.id)
    check('the passkey is gone from the entry', afterRemove.passkeys.length === 0)
    const preservedAfterRemove = await client.draftEntry(created.id)
    check(
      'the remove preserved the entry fields',
      preservedAfterRemove.name === 'Passkey 导入测试' && preservedAfterRemove.favorite === true && preservedAfterRemove.notes === '保留备注',
      JSON.stringify({ name: preservedAfterRemove.name, notes: preservedAfterRemove.notes, favorite: preservedAfterRemove.favorite }),
    )

    // 6. write-shape guards ---------------------------------------------------
    let nonLogin = null
    try {
      await mutations.importPasskey('cipher-db', document.cdp, undefined)
    } catch (error) {
      nonLogin = error
    }
    check('a secure note refuses a passkey import', nonLogin instanceof VaultError && nonLogin.code === 'bad_request', String(nonLogin?.code))
    let badKey = null
    try {
      await mutations.importPasskey(created.id, { ...document.cdp, privateKey: Buffer.from('not-a-key').toString('base64') }, undefined)
    } catch (error) {
      badKey = error
    }
    check('a malformed PKCS#8 is refused', badKey instanceof VaultError && badKey.code === 'bad_request', String(badKey?.code))
  } finally {
    rmSync(exportDir, { recursive: true, force: true })
    await server.close()
  }

  console.log('')
  console.log(passed + ' passed, ' + failed + ' failed')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
