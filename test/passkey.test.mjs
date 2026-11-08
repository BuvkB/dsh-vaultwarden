/**
 * Passkey (WebAuthn) vault support: decryption, metadata projection, the
 * gated private-key export, and the import/remove write path.
 *
 * Run: node test/passkey.test.mjs
 */
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultClient, VaultError } from '../lib/vault.js'
import { VaultMutations } from '../lib/mutations.js'
import {
  removePasskeyExports,
  toCdpCredential,
  toPlaywrightCredential,
  normalizeCdpCredential,
  credentialIdBytes,
  guidToRawBytes,
  bytesToBase64,
  bytesToB64Url,
} from '../lib/passkey.js'
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

const b64url = (value) => bytesToB64Url(Buffer.from(value))
const publicKeyFor = (pkcs8) => {
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  return createPublicKey(key).export({ type: 'spki', format: 'der' })
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
    check('a discoverable passkey is marked usable for username-less login', meta.usableForLogin === true)
    check('the credential id is the raw id in base64', meta.credentialId === server.fixtures.passkeyCredentialId.toString('base64'), meta.credentialId)
    check('the metadata carries no private key', !('keyValue' in meta) && !('privateKey' in meta))
    const viaGet = JSON.parse(await client.get('cipher-github', 'passkeys'))
    check('field=passkeys projects metadata only', viaGet.passkeys?.[0]?.rpId === 'github.com' && !('keyValue' in viaGet.passkeys[0]))

    // 1b. passkey-first login: the read that hands a password back must say,
    // right there, that this entry has a better door — a hasFido2 flag alone
    // leaves the caller to infer precedence, and a caller about to type a
    // password is the one that cannot afford the inference.
    const allRead = JSON.parse(await client.get('cipher-github', 'all'))
    check('a passkey entry tells a password read to use the passkey first', /通行密钥/.test(String(allRead.loginHint)) && /优先/.test(String(allRead.loginHint)), String(allRead.loginHint))
    const passwordRead = JSON.parse(await client.get('cipher-github', 'password'))
    check('the password projection carries the same passkey-first hint', /通行密钥/.test(String(passwordRead.loginHint)))
    const plainRead = JSON.parse(await client.get('cipher-db', 'all'))
    check('an entry without a passkey carries no login hint', plainRead.loginHint === undefined, String(plainRead.loginHint))
    const found = JSON.parse(await client.find('github'))
    check('the find hint states the passkey-first order', /hasFido2/.test(String(found.hint)) && /优先/.test(String(found.hint)), String(found.hint))

    // 2. export writes a 0600 CDP-shaped file ---------------------------------
    // A forgotten export must not live forever: an old file in the same private
    // directory is pruned before the new one is written.
    const stale = join(exportDir, 'stale-export.json')
    const staleTmp = join(exportDir, 'stale-export.json.deadbeef.tmp')
    writeFileSync(stale, '{"old":true}')
    writeFileSync(staleTmp, '{"private":true}', { mode: 0o600 })
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(stale, old, old)
    utimesSync(staleTmp, old, old)
    const exported = await client.exportPasskey('cipher-github', '', undefined, { outputDir: exportDir, surface: 'tool' })
    check('a stale export file is pruned on the next export', !existsSync(stale))
    check('a stale .tmp export is pruned on the next export', !existsSync(staleTmp))
    check('the export reports its expiry', typeof exported.expiresAt === 'string' && Date.parse(exported.expiresAt) > Date.now())
    check('export reports a path', typeof exported.path === 'string' && exported.path.length > 0)
    check('export never returns the private key', !('privateKey' in exported) && !JSON.stringify(exported).includes(server.fixtures.passkeyPkcs8.toString('base64').slice(0, 24)))
    const mode = statSync(exported.path).mode & 0o777
    check('the exported file is 0600', mode === 0o600, mode.toString(8))
    const document = JSON.parse(readFileSync(exported.path, 'utf8'))
    check('the file declares its format', document.format === 'webauthn-credential/v2' && document.cdp)
    check('the file carries a Playwright block', Boolean(document.playwright) && document.playwright.rpId === 'github.com')
    check('the Playwright block uses base64url for the credential id', document.playwright.id === b64url(server.fixtures.passkeyCredentialId))
    check('the Playwright block uses base64url for the private key', document.playwright.privateKey === b64url(server.fixtures.passkeyPkcs8))
    check('the Playwright block derives the matching public key', document.playwright.publicKey === b64url(publicKeyFor(server.fixtures.passkeyPkcs8)))
    check('the Playwright block maps signCount', document.playwright.signCount === 0)
    check('the credential id is converted to standard base64', document.cdp.credentialId === server.fixtures.passkeyCredentialId.toString('base64'))
    check('the private key is the original PKCS#8 in standard base64', document.cdp.privateKey === server.fixtures.passkeyPkcs8.toString('base64'))
    check('the rpId survives', document.cdp.rpId === 'github.com')
    check('the user handle is decoded from base64url to base64', document.cdp.userHandle === Buffer.from('github-user-1').toString('base64'))
    check('the counter becomes signCount', document.cdp.signCount === 0)
    check('the export reports the counter and its source', exported.counter === 0 && exported.counterSource === 'vault' && typeof exported.counterWarning === 'string', JSON.stringify({ counter: exported.counter, source: exported.counterSource, warning: exported.counterWarning }))
    check('discoverable becomes isResidentCredential', document.cdp.isResidentCredential === true)
    // Export alone is not a login: the caller needs a per-client recipe, and it
    // must be host-neutral — Playwright covers Chromium/Firefox/WebKit, raw CDP
    // covers every Chromium automation, ego is one convenience on top of CDP.
    const handoff = exported.handoff
    const clientIds = handoff.clients.map((client) => client.id)
    check('the export ships a multi-client handoff', handoff?.version === 1 && clientIds.join() === 'playwright,cdp,ego', clientIds.join())
    check('Playwright covers Chromium, Firefox and WebKit', handoff.clients[0].engines.includes('Firefox') && handoff.clients[0].engines.includes('WebKit'))
    check('raw CDP is limited to Chromium', handoff.clients[1].engines.join() === 'Chromium')
    check('every client code points at the exported file', handoff.clients.every((client) => client.code.includes(exported.path)))
    check('the rules state the inject-before-navigate order', handoff.rules.some((rule) => rule.includes('注入必须早于导航')))
    check('the handoff carries no key material', !JSON.stringify(handoff).includes(document.cdp.privateKey.slice(0, 16)))
    // A login url upgrades the runnable clients to whole scripts.
    const full = await client.exportPasskey('cipher-github', '', undefined, {
      outputDir: exportDir,
      surface: 'tool',
      url: 'https://github.com/login',
      account: 'octocat@example.com',
    })
    const fullById = Object.fromEntries(full.handoff.clients.map((client) => [client.id, client]))
    check('a login url makes the portable clients complete', fullById.playwright.complete === true && fullById.ego.complete === true && fullById.cdp.complete === false)
    check('the complete script navigates on its own', fullById.playwright.code.includes('await page.goto("https://github.com/login")'))
    check('the complete script fills the account', fullById.playwright.code.includes('octocat@example.com'))
    check('the complete script still injects before navigating', fullById.ego.code.indexOf('addVirtualAuthenticator') < fullById.ego.code.indexOf('page.goto'))
    // The audit trail answers who exported what, when — never the key itself.
    const auditLines = readFileSync(join(exportDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const audit = auditLines.at(-1)
    check('the export writes an audit record', Boolean(audit) && typeof audit.at === 'string' && audit.entryId === 'cipher-github' && audit.rpId === 'github.com', JSON.stringify(audit))
    check('the audit records the actor and access tier', audit.actor === 'model' && audit.accessMode === 'readonly', JSON.stringify({ actor: audit.actor, accessMode: audit.accessMode }))
    check('the audit carries no private key material', !JSON.stringify(audit).includes(document.cdp.privateKey.slice(0, 16)) && !('keyValue' in audit) && !('privateKey' in audit))

    // Cleanup is deliberately available without an approval prompt (it only
    // reduces exposure) and is scoped to the plugin's own export directory.
    const cleanupPath = join(exportDir, 'cleanup-test.json')
    const cleanupTmp = join(exportDir, 'cleanup-test.json.deadbeef.tmp')
    writeFileSync(cleanupPath, '{"temporary":true}', { mode: 0o600 })
    writeFileSync(cleanupTmp, '{"private":true}', { mode: 0o600 })
    const cleaned = removePasskeyExports(exportDir, cleanupPath)
    check('cleanup removes the named export without touching the vault', cleaned.count === 1 && !existsSync(cleanupPath), JSON.stringify(cleaned))
    const cleanedTmp = removePasskeyExports(exportDir, cleanupTmp)
    check('cleanup removes a named .tmp export', cleanedTmp.count === 1 && !existsSync(cleanupTmp), JSON.stringify(cleanedTmp))
    const outside = join(tmpdir(), 'not-a-vault-export.json')
    writeFileSync(outside, '{"outside":true}', { mode: 0o600 })
    const refused = removePasskeyExports(exportDir, outside)
    check('cleanup refuses a path outside the plugin export directory', refused.count === 0 && existsSync(outside), JSON.stringify(refused))
    rmSync(outside, { force: true })

    // A reprompt-flagged entry stays gated: its passkey metadata and private
    // key are part of the entry's data, so the same master-password proof is
    // required before any export, import or removal.
    let repromptRemove = null
    try {
      await mutations.removePasskey('cipher-reprompt', '', undefined)
    } catch (error) {
      repromptRemove = error
    }
    check('a reprompt entry refuses passkey removal until its proof', repromptRemove instanceof VaultError && repromptRemove.code === 'reprompt_required', String(repromptRemove?.code))
    let repromptImport = null
    try {
      await mutations.importPasskey('cipher-reprompt', document.cdp, undefined)
    } catch (error) {
      repromptImport = error
    }
    check('a reprompt entry refuses passkey import until its proof', repromptImport instanceof VaultError && repromptImport.code === 'reprompt_required', String(repromptImport?.code))
    let repromptRefused = null
    try {
      await client.exportPasskey('cipher-reprompt', '', undefined, { outputDir: exportDir })
    } catch (error) {
      repromptRefused = error
    }
    check('a reprompt entry refuses passkey export until its proof', repromptRefused instanceof VaultError && repromptRefused.code === 'reprompt_required', String(repromptRefused?.code))
    const repromptProof = await client.authorizeReprompt(PASSWORD, undefined, { id: 'cipher-reprompt' })
    check('the reprompt proof is accepted for the passkey entry', repromptProof?.authorized === true, JSON.stringify(repromptProof))
    const repromptExport = await client.exportPasskey('cipher-reprompt', '', undefined, { outputDir: exportDir })
    check('the proof opens the reprompt passkey export', repromptExport.ok === true && repromptExport.passkey.rpId === 'reprompt.example')

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

    // A v2 file must be importable as a whole: the wrapper's passkey metadata
    // supplies userName/rpName/created, which the cdp block alone does not carry.
    const wrapperCreated = await mutations.create({ name: 'Passkey wrapper 导入测试' }, undefined)
    const wrapperImported = await mutations.importPasskey(wrapperCreated.id, document, undefined)
    check('import accepts the whole v2 wrapper', wrapperImported.imported === true && wrapperImported.count === 1, JSON.stringify(wrapperImported))
    const wrapperList = await client.passkeyList(wrapperCreated.id)
    check(
      'the wrapper metadata survives import',
      wrapperList.passkeys[0]?.userName === 'octocat@example.com'
        && wrapperList.passkeys[0]?.rpName === 'GitHub'
        && wrapperList.passkeys[0]?.created === '2026-01-02T03:04:05.000Z',
      JSON.stringify(wrapperList.passkeys[0]),
    )
    const fromPlaywrightBlock = normalizeCdpCredential(document.playwright)
    check(
      'the playwright block is importable on its own',
      fromPlaywrightBlock.credentialId.equals(server.fixtures.passkeyCredentialId)
        && fromPlaywrightBlock.privateKey.equals(server.fixtures.passkeyPkcs8)
        && fromPlaywrightBlock.isResidentCredential === true,
      JSON.stringify({ rpId: fromPlaywrightBlock.rpId, resident: fromPlaywrightBlock.isResidentCredential }),
    )

    // v1 files predate the playwright block; they must keep importing.
    const v1Normalized = normalizeCdpCredential({ format: 'webauthn-credential/v1', cdp: document.cdp })
    check('a v1 wrapper still imports from its cdp block', v1Normalized.credentialId.equals(server.fixtures.passkeyCredentialId))

    const reExported = await client.exportPasskey(created.id, '', undefined, { outputDir: exportDir })
    const again = JSON.parse(readFileSync(reExported.path, 'utf8'))
    check('the re-exported private key matches the original', again.cdp.privateKey === document.cdp.privateKey)
    check('the re-exported credential id matches the original', again.cdp.credentialId === document.cdp.credentialId)

    // The explicit signCount override exists for relying parties that have
    // already recorded a higher counter than the vault knows.
    const overridden = await client.exportPasskey('cipher-github', '', undefined, { outputDir: exportDir, signCount: 1000000 })
    const overriddenDoc = JSON.parse(readFileSync(overridden.path, 'utf8'))
    check(
      'the signCount override is written to both blocks',
      overridden.counter === 1000000
        && overridden.counterSource === 'override'
        && overriddenDoc.cdp.signCount === 1000000
        && overriddenDoc.playwright.signCount === 1000000
        && overridden.counterWarning === null,
      JSON.stringify({ counter: overridden.counter, source: overridden.counterSource, cdp: overriddenDoc.cdp.signCount, playwright: overriddenDoc.playwright.signCount }),
    )
    let badOverride = null
    try {
      await client.exportPasskey('cipher-github', '', undefined, { outputDir: exportDir, signCount: 4294967296 })
    } catch (error) {
      badOverride = error
    }
    check('an out-of-range signCount override is refused', badOverride instanceof VaultError && badOverride.code === 'bad_passkey', String(badOverride?.code))

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
    // Selenium feeds raw bytes; its JSON input is base64url without padding.
    const seleniumStyle = {
      credentialId: bytesToB64Url(server.fixtures.passkeyCredentialId),
      privateKey: bytesToB64Url(server.fixtures.passkeyPkcs8),
      rpId: 'github.com',
      userHandle: bytesToB64Url(Buffer.from('github-user-1')),
      signCount: 0,
      isResidentCredential: true,
    }
    const seleniumNormalized = normalizeCdpCredential(seleniumStyle)
    check(
      'Selenium-style base64url input decodes to the same bytes',
      seleniumNormalized.credentialId.equals(server.fixtures.passkeyCredentialId)
        && seleniumNormalized.privateKey.equals(server.fixtures.passkeyPkcs8)
        && seleniumNormalized.userHandle.equals(Buffer.from('github-user-1')),
    )

    // A legacy UUID credentialId must become its 16 raw bytes, not its text.
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    const uuidCdp = toCdpCredential({
      rpId: 'example.com',
      credentialId: uuid,
      keyValue: bytesToB64Url(server.fixtures.passkeyPkcs8),
      counter: '0',
      discoverable: 'false',
    })
    check('a UUID credentialId converts to its 16 raw bytes', uuidCdp.credentialId === bytesToBase64(guidToRawBytes(uuid)))
    check('a non-resident passkey has no Playwright block', toPlaywrightCredential({
      rpId: 'example.com',
      credentialId: uuid,
      keyValue: bytesToB64Url(server.fixtures.passkeyPkcs8),
      counter: '0',
      discoverable: 'false',
    }) === null)

    // Fail at export time, not later inside Chrome.
    let noHandle = null
    try {
      toCdpCredential({
        rpId: 'example.com',
        credentialId: uuid,
        keyValue: bytesToB64Url(server.fixtures.passkeyPkcs8),
        counter: '0',
        discoverable: 'true',
      })
    } catch (error) {
      noHandle = error
    }
    check('resident without userHandle is refused at export', noHandle?.name === 'PasskeyError' && /userHandle/.test(noHandle.message), String(noHandle?.message))
    let tooLong = null
    try {
      toCdpCredential({
        rpId: 'example.com',
        credentialId: uuid,
        keyValue: bytesToB64Url(server.fixtures.passkeyPkcs8),
        counter: '0',
        discoverable: 'true',
        userHandle: bytesToB64Url(Buffer.alloc(65, 1)),
      })
    } catch (error) {
      tooLong = error
    }
    check('a 65-byte userHandle is refused at export', tooLong?.name === 'PasskeyError' && /64/.test(tooLong.message), String(tooLong?.message))
    let badBoolean = null
    try {
      normalizeCdpCredential({ ...document.cdp, isResidentCredential: 'false' })
    } catch (error) {
      badBoolean = error
    }
    check('a string isResidentCredential is refused', badBoolean?.name === 'PasskeyError' && /布尔/.test(badBoolean.message), String(badBoolean?.message))
    let badCount = null
    try {
      normalizeCdpCredential({ ...document.cdp, signCount: -2 })
    } catch (error) {
      badCount = error
    }
    check('signCount below -1 is refused', badCount?.name === 'PasskeyError' && /-1/.test(badCount.message), String(badCount?.message))

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
