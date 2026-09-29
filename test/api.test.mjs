/**
 * Offline test for the same-origin HTTP API (lib/api.js).
 *
 * Drives the real route handler with fake IncomingMessage/ServerResponse
 * objects against the mock Vaultwarden server: loopback policy, every route,
 * the reprompt gate, TOTP, and the "never leak a password on list" rule.
 *
 * Run: node test/api.test.mjs
 */
import { EventEmitter } from 'node:events'
import { VaultClient } from '../lib/vault.js'
import { API_PREFIX, createApiHandler } from '../lib/api.js'
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

/** Invoke the handler with a synthetic request; resolves with the response. */
const call = (handler, { method = 'GET', path = `${API_PREFIX}/status`, body, remoteAddress = '127.0.0.1' }) =>
  new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = path
    req.socket = { remoteAddress }
    const res = {
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(payload) {
        resolve({ status: this.status, headers: this.headers, json: payload ? JSON.parse(payload) : null, raw: payload ?? '' })
      },
    }
    const deliver = () => {
      if (body !== undefined) {
        req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      }
      req.emit('end')
    }
    process.nextTick(deliver)
    handler(req, res).catch(reject)
  })

async function main() {
  console.log('http api test (same-origin routes for the browser half)')
  const server = await startMockServer({ repromptCipher: true })
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }
  const client = new VaultClient({
    serverUrl: server.url,
    email: EMAIL,
    masterPassword: PASSWORD,
    apiKeyClientId: '',
    apiKeyClientSecret: '',
    cacheMinutes: 30,
  })
  const handler = createApiHandler(() => client)

  // 1. request policy ----------------------------------------------------------
  const foreign = await call(handler, { remoteAddress: '192.168.1.50' })
  check('non-loopback peer is refused', foreign.status === 403 && foreign.json.error === 'forbidden')
  check('refusal sets no-store', foreign.headers?.['cache-control'] === 'no-store')

  // 2. status -------------------------------------------------------------------
  const status = await call(handler, {})
  check('GET /status reports configured + live sync', status.status === 200 && status.json.configured === true && 'liveSync' in status.json)

  // 3. list ---------------------------------------------------------------------
  const list = await call(handler, { path: `${API_PREFIX}/list` })
  check('GET /list returns the whole vault', list.status === 200 && list.json.vaultItems === 5, `vaultItems ${list.json.vaultItems}`)
  check('list never contains a password', !list.raw.includes('gh-p@ssw0rd-42') && !list.raw.includes('reprompt-pass-9'))
  check('list items carry summary fields only', typeof list.json.items[0].id === 'string' && list.json.items[0].hasTotp !== undefined)

  const filtered = await call(handler, { path: `${API_PREFIX}/list?query=${encodeURIComponent('数据库')}` })
  check('list?query= filters', filtered.json.matched === 1 && filtered.json.items[0].id === 'cipher-db')

  // 4. reveal --------------------------------------------------------------------
  const reveal = await call(handler, { method: 'POST', path: `${API_PREFIX}/reveal`, body: { id: 'cipher-github', field: 'password' } })
  check('POST /reveal returns the password', reveal.status === 200 && reveal.json.password === 'gh-p@ssw0rd-42')

  const reprompt = await call(handler, { method: 'POST', path: `${API_PREFIX}/reveal`, body: { id: 'cipher-reprompt' } })
  check('reprompt entry is gated on the API too', reprompt.json.repromptRequired === true && !('password' in reprompt.json))
  const confirmed = await call(handler, { method: 'POST', path: `${API_PREFIX}/reveal`, body: { id: 'cipher-reprompt', confirm: true } })
  check('reprompt entry reveals with confirm', confirmed.json.password === 'reprompt-pass-9')

  const missing = await call(handler, { method: 'POST', path: `${API_PREFIX}/reveal`, body: {} })
  check('reveal without a reference is a bad_request', missing.status === 400 && missing.json.code === 'bad_request')

  const byName = await call(handler, { method: 'POST', path: `${API_PREFIX}/reveal`, body: { name: 'GitHub 工作账号', field: 'username' } })
  check('reveal resolves by name', byName.json.username === 'octocat@jindom.cc')

  // 5. totp ----------------------------------------------------------------------
  const totp = await call(handler, { method: 'POST', path: `${API_PREFIX}/totp`, body: { id: 'cipher-github' } })
  check('POST /totp returns code + countdown', totp.status === 200 && /^\d{8}$/.test(totp.json.totp?.code ?? ''), JSON.stringify(totp.json.totp))
  check('countdown seconds are within the period', totp.json.totp.secondsRemaining >= 1 && totp.json.totp.secondsRemaining <= 30)

  // 6. sync ----------------------------------------------------------------------
  const sync = await call(handler, { method: 'POST', path: `${API_PREFIX}/sync`, body: {} })
  check('POST /sync forces a sync', sync.status === 200 && sync.json.ok === true && sync.json.items === 5)

  // 7. errors --------------------------------------------------------------------
  const unknown = await call(handler, { path: `${API_PREFIX}/nope` })
  check('unknown route is a 404 with a message', unknown.status === 404 && unknown.json.error === 'not_found')

  const badJson = await call(handler, { method: 'POST', path: `${API_PREFIX}/reveal`, body: '{not json' })
  check('malformed JSON body is a structured error', badJson.status === 400 && badJson.json.code === 'bad_request')

  const outsidePrefix = await call(handler, { path: '/somewhere/else' })
  check('paths outside the prefix are not handled', outsidePrefix.status === 404)

  // 8. the client stays the single source of truth --------------------------------
  const vault = await client.unlock()
  check('the API shares the client cache', vault.items.length === 5 && vault.byId.has('cipher-github'))

  await server.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
