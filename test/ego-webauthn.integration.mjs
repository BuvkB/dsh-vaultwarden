/**
 * Optional integration test for the ego CDP host. It is skipped unless
 * EGO_BROWSER_BIN points at an ego-browser executable and a browser is up.
 *
 * This is the regression that matters most for the recipe: a virtual
 * authenticator lives only in the CDP session that created it, so two
 * separate `ego-browser nodejs` invocations cannot share one. A single
 * heredoc can complete the whole enable → add → get flow.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'

const bin = process.env.EGO_BROWSER_BIN
if (!bin || !existsSync(bin)) {
  console.log('skip: EGO_BROWSER_BIN is not set or does not exist')
  process.exit(0)
}

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

const run = (script) => spawnSync(process.execPath, [bin, 'nodejs'], {
  input: script,
  encoding: 'utf8',
  timeout: 120000,
})

const options = `{ protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }`

// 1. A single heredoc can complete the entire flow.
const full = run(`
const { generateKeyPairSync } = await import('node:crypto')
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const der = privateKey.export({ format: 'der', type: 'pkcs8' })
await cdp('WebAuthn.enable', {})
const auth = await cdp('WebAuthn.addVirtualAuthenticator', { options: ${options} })
await cdp('WebAuthn.addCredential', { authenticatorId: auth.authenticatorId, credential: { credentialId: Buffer.from('cafebabe01020304','hex').toString('base64'), rpId: 'example.com', privateKey: Buffer.from(der).toString('base64'), isResidentCredential: true, userHandle: Buffer.from('probe-user').toString('base64'), signCount: 0 } })
const got = await cdp('WebAuthn.getCredentials', { authenticatorId: auth.authenticatorId })
console.log('@@DSH_RESULT@@' + JSON.stringify({ ok: true, count: got.credentials.length, hasPrivateKey: Boolean(got.credentials[0]?.privateKey) }))
`)
check('single ego_script heredoc completes WebAuthn', full.status === 0 && /"count":1/.test(full.stdout), (full.stderr || full.stdout).slice(0, 500))

// 2. A second process cannot reuse the first process's virtual environment.
const first = run(`
await cdp('WebAuthn.enable', {})
const auth = await cdp('WebAuthn.addVirtualAuthenticator', { options: ${options} })
console.log('@@DSH_RESULT@@' + JSON.stringify({ ok: true, authenticatorId: auth.authenticatorId }))
`)
check('first ego_cdp-style call enables the authenticator', first.status === 0, (first.stderr || first.stdout).slice(0, 500))
const second = run(`
await cdp('WebAuthn.addVirtualAuthenticator', { options: ${options} })
console.log('@@DSH_RESULT@@' + JSON.stringify({ ok: true }))
`)
const errorText = (second.stderr || '') + (second.stdout || '')
check(
  'a second process cannot reuse the virtual authenticator',
  second.status !== 0 && errorText.includes('The Virtual Authenticator Environment has not been enabled for this session'),
  errorText.slice(0, 500),
)

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
