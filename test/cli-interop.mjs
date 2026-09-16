/**
 * Cross-implementation interop check (optional, skipped when unavailable).
 *
 * Points the *official* Bitwarden CLI at our mock Vaultwarden server and asks it
 * to log in, sync and decrypt. Because the mock verifies the master password
 * hash it receives, a successful CLI login proves our KDF + master-password hash
 * agree with the official implementation; a successful `list items` / `get`
 * proves our HKDF stretch and EncString (AES-CBC + HMAC) output is readable by
 * the official client — i.e. our crypto is wire-compatible, not just
 * self-consistent.
 *
 * Requirements (all optional; the script exits 0 with a notice when missing):
 *   - the official CLI:  npm install --prefix /tmp/bwcli-install @bitwarden/cli
 *                        (or set BW_CLI=/path/to/bw)
 *   - openssl, for a throwaway self-signed certificate (the CLI refuses http)
 *
 * Run: BW_CLI=/tmp/bwcli-install/node_modules/.bin/bw node test/cli-interop.mjs
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { EMAIL, PASSWORD, startMockServer } from './mock-server.mjs'

const run = promisify(execFile)
const BW = process.env.BW_CLI ?? '/tmp/bwcli-install/node_modules/.bin/bw'

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

async function makeCertificate(dir) {
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  try {
    await run('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '2',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ])
    return { key, cert }
  } catch {
    return null
  }
}

async function bw(args, env) {
  // The CLI's fetch honours the ambient proxy variables; a loopback mock must
  // bypass them or the TLS handshake is answered by the proxy instead.
  const cleanEnv = { ...process.env, ...env }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY']) {
    delete cleanEnv[key]
  }
  cleanEnv.NO_PROXY = '127.0.0.1,localhost'
  cleanEnv.no_proxy = '127.0.0.1,localhost'
  const { stdout = '', stderr = '' } = await run(BW, args, {
    env: cleanEnv,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  }).catch((error) => ({ stdout: error.stdout ?? '', stderr: `${error.stderr ?? ''}${error.message}` }))
  return { stdout, stderr }
}

/** Drop node/CLI noise so a failure detail stays readable. */
const clean = (text) =>
  String(text ?? '')
    .split('\n')
    .filter((line) => !/UNDICI|trace-warnings|NODE_TLS_REJECT_UNAUTHORIZED/.test(line))
    .join('\n')
    .trim()
    .slice(0, 400)

async function main() {
  if (!existsSync(BW)) {
    console.log(`cli-interop: official Bitwarden CLI not found at ${BW} — skipping`)
    console.log('  install it with: npm install --prefix /tmp/bwcli-install @bitwarden/cli')
    process.exit(0)
  }

  const workDir = mkdtempSync(join(tmpdir(), 'dsh-bw-interop-'))
  const appData = join(workDir, 'appdata')
  mkdirSync(appData, { recursive: true })
  const tls = await makeCertificate(workDir)
  if (!tls) {
    console.log('cli-interop: openssl unavailable, cannot serve HTTPS (the CLI refuses http) — skipping')
    process.exit(0)
  }

  // Classic 64-byte user key (enc||mac): the shape every Bitwarden client
  // handles identically. The 32-byte "user key v2" shape is covered by
  // `mock-e2e.test.mjs`, which asserts the HKDF stretch against the same
  // algorithm the official client uses.
  const server = await startMockServer({
    legacyCipher: false,
    tls: { key: readFileSync(tls.key), cert: readFileSync(tls.cert) },
  })
  if (!server) {
    console.log('cli-interop: hash-wasm missing — skipping')
    process.exit(0)
  }

  console.log('official Bitwarden CLI ↔ mock Vaultwarden interop test')
  const env = {
    BITWARDENCLI_APPDATA_DIR: appData,
    NODE_TLS_REJECT_UNAUTHORIZED: '0', // throwaway self-signed certificate
    BW_NOINTERACTION: 'true',
  }

  const configured = await bw(['config', 'server', server.url], env)
  check('CLI accepts the mock server', !/error/i.test(configured.stderr), clean(configured.stderr))

  const login = await bw(['login', EMAIL, PASSWORD, '--raw'], env)
  const session = login.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  check(
    'CLI logs in ⇒ our master password hash + KDF match the official implementation',
    session.length > 20 && !/invalid|error/i.test(login.stderr),
    `${clean(login.stderr)} ${clean(login.stdout)}`,
  )
  if (!session || session.length <= 20) {
    await server.close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(1)
  }

  const sync = await bw(['sync', '--session', session], env)
  check('CLI syncs the encrypted vault', !/error/i.test(sync.stderr), clean(sync.stderr))

  // The CLI persists its unlocked user key between processes; when a run lands
  // before that state settles it reports the vault as locked. Unlock explicitly
  // so the assertions are deterministic rather than timing-dependent.
  let activeSession = session
  const lockedProbe = await bw(['list', 'items', '--session', activeSession], env)
  if (/Vault is locked/i.test(`${lockedProbe.stdout}${lockedProbe.stderr}`)) {
    const unlocked = await bw(['unlock', '--raw', '--passwordenv', 'BW_PASSWORD'], { ...env, BW_PASSWORD: PASSWORD })
    const next = unlocked.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
    if (next.length > 20) activeSession = next
    check('CLI unlocks the vault when its persisted state was not ready', activeSession !== session || next.length > 20)
  }

  const list = await bw(['list', 'items', '--session', activeSession], env)
  let items = []
  try {
    items = JSON.parse(list.stdout.slice(list.stdout.indexOf('[')))
  } catch {
    items = []
  }
  const byId = new Map(items.map((item) => [item.id, item]))
  check(
    'CLI decrypts our EncStrings (item names) ⇒ HKDF/AES/HMAC formats agree',
    items.length === 3 && byId.has('cipher-github') && byId.has('cipher-org'),
    `items=${items.length} stderr=${clean(list.stderr)}`,
  )
  check(
    'CLI decrypts login username/password/uris',
    byId.get('cipher-github')?.login?.username === 'octocat@jindom.cc' &&
      byId.get('cipher-github')?.login?.password === 'gh-p@ssw0rd-42' &&
      byId.get('cipher-github')?.login?.uris?.[0]?.uri === 'https://github.com/login',
    JSON.stringify(byId.get('cipher-github')?.login ?? null).slice(0, 300),
  )
  check('CLI decrypts custom fields + notes + folder', byId.get('cipher-github')?.fields?.[1]?.value === 'tok_live_abc123' && Boolean(byId.get('cipher-github')?.notes) && Boolean(byId.get('cipher-github')?.folderId))
  check(
    'CLI decrypts a per-item organization key',
    byId.get('cipher-org')?.login?.password === 'deploy-secret-9',
    JSON.stringify(byId.get('cipher-org')?.login ?? null).slice(0, 300),
  )

  const totp = await bw(['get', 'totp', 'cipher-github', '--session', activeSession], env)
  check('CLI generates a TOTP code from our stored otpauth URI', /^\d{6,8}$/.test(totp.stdout.trim()), `out=${clean(totp.stdout)} err=${clean(totp.stderr)}`)

  const password = await bw(['get', 'password', 'cipher-github', '--session', activeSession], env)
  check('CLI `get password` returns the expected secret', password.stdout.trim() === 'gh-p@ssw0rd-42', clean(password.stdout))

  await server.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('interop test crashed:', error)
  process.exit(1)
})
