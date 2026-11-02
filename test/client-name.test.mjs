/**
 * Bitwarden cloud client-identification contract.
 *
 * Official Bitwarden cloud only accepts its own client names in the
 * `bitwarden-client-name` header. Anything else gets an empty-body HTTP 429
 * from /identity/connect/token — a client-name rejection disguised as a rate
 * limit, so retrying never helps. These tests pin three things:
 *
 *   - the token request advertises `cli` (the OAuth client the grant uses),
 *   - the account device list still shows `dsh-vaultwarden` via deviceName,
 *   - an empty 429 is reported as a client-name rejection, while a 429 with a
 *     body remains a real rate limit.
 *
 * Run: node test/client-name.test.mjs
 */
import { VaultClient } from '../lib/vault.js'

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

const PRELOGIN_OK = {
  kdf: 0,
  kdfIterations: 1000,
  kdfSettings: { kdfType: 0, iterations: 1000 },
}

const settings = {
  serverUrl: 'https://vault.example.com',
  email: 'user@example.com',
  masterPassword: 'correct horse battery staple',
  apiKeyClientId: '',
  apiKeyClientSecret: '',
  cacheMinutes: 30,
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Capture the token request and answer it with the supplied response. */
function fetchForToken(tokenResponse, capture = {}) {
  return async (url, init) => {
    if (String(url).endsWith('/identity/accounts/prelogin')) return jsonResponse(PRELOGIN_OK)
    if (String(url).endsWith('/identity/connect/token')) {
      capture.headers = init.headers
      capture.body = new URLSearchParams(String(init.body))
      return tokenResponse()
    }
    throw new Error(`unexpected request: ${url}`)
  }
}

console.log('Bitwarden client-name contract test')

// 1. The wire identity: client-name is the official CLI's OAuth client, and
//    deviceName still identifies the plugin in the account's device list.
{
  const capture = {}
  const client = new VaultClient(settings, {
    fetch: fetchForToken(
      () =>
        jsonResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          Key: '2.mock-key',
        }),
      capture,
    ),
  })
  await client.login()
  check('token request sends bitwarden-client-name: cli', capture.headers?.['bitwarden-client-name'] === 'cli', String(capture.headers?.['bitwarden-client-name']))
  check('token request keeps deviceName: dsh-vaultwarden', capture.body?.get('deviceName') === 'dsh-vaultwarden', String(capture.body?.get('deviceName')))
  check('token request keeps client_id: cli', capture.body?.get('client_id') === 'cli', String(capture.body?.get('client_id')))
}

// 2. Empty 429: the server's client-name rejection. It must not be called a
//    rate limit, because the user would wait forever and nothing would change.
{
  const client = new VaultClient(settings, {
    fetch: fetchForToken(() => new Response('', { status: 429 })),
  })
  let thrown = null
  try {
    await client.login()
  } catch (error) {
    thrown = error
  }
  check('empty 429 is a client-name rejection', thrown?.code === 'client_name_rejected', String(thrown?.code))
  check('empty 429 message does not say rate-limited/retry', !/限流|稍后重试/.test(String(thrown?.message)), String(thrown?.message))
  check('empty 429 hint names the client identifier', /客户端标识|bitwarden-client-name/i.test(String(thrown?.hint)), String(thrown?.hint))
}

// 3. A 429 that carries a body is a real rate limit and must stay retryable.
{
  const client = new VaultClient(settings, {
    fetch: fetchForToken(() => jsonResponse({ error: 'rate_limited' }, 429)),
  })
  let thrown = null
  try {
    await client.login()
  } catch (error) {
    thrown = error
  }
  check('429 with a body stays rate_limited', thrown?.code === 'rate_limited', String(thrown?.code))
  check('429 with a body says rate-limited', /限流/.test(String(thrown?.message)), String(thrown?.message))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
