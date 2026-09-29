/**
 * Same-origin HTTP API for the plugin's browser half.
 *
 * The web server carries no authentication of its own (see
 * `@deepseek-ai/dsh-host-webserver`: "route owners enforce their own request
 * policy"), so this route enforces one: it answers loopback clients only.
 * Everything is JSON; failures are structured `{ error, code, hint }` objects
 * the UI can render directly.
 *
 * Routes (all under `/dsh-vaultwarden/api`):
 *   GET  /status            → the bitwarden_status report (incl. live sync)
 *   GET  /list?query=&limit= → entry summaries — never passwords
 *   POST /reveal {id|name, field?, confirm?} → one entry's fields (reprompt-gated)
 *   POST /totp   {id|name}  → the current TOTP code + countdown
 *   POST /sync              → force a sync + decrypt, report the item count
 */
import { VaultError } from './vault.js'

export const API_PREFIX = '/dsh-vaultwarden/api'

/** The web server has no auth of its own: accept loopback peers only. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const json = (res, status, payload) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new VaultError('请求体不是合法 JSON', { code: 'bad_request' }))
      }
    })
    req.on('error', reject)
  })

/**
 * @param {() => import('./vault.js').VaultClient} getClient lazily creates the client
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiHandler(getClient) {
  return async function vaultwardenApi(req, res) {
    if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) {
      return json(res, 403, { error: 'forbidden', message: '该接口仅接受本机回环请求' })
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.startsWith(API_PREFIX)
        ? url.pathname.slice(API_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
        : ''
      const method = (req.method ?? 'GET').toUpperCase()
      const client = getClient()

      if (method === 'GET' && route === 'status') {
        return json(res, 200, JSON.parse(await client.status()))
      }
      if (method === 'GET' && route === 'list') {
        const query = url.searchParams.get('query') ?? ''
        const limit = Number(url.searchParams.get('limit') ?? 100)
        return json(res, 200, await client.findEntries(query, limit))
      }
      if (method === 'POST' && route === 'reveal') {
        const body = await readJsonBody(req)
        const ref = body.id || body.name
        if (!ref) return json(res, 400, { error: 'bad_request', code: 'bad_request', message: '需要 id 或 name' })
        return json(res, 200, await client.revealEntry(ref, body.field ?? 'all', undefined, { confirm: Boolean(body.confirm) }))
      }
      if (method === 'POST' && route === 'totp') {
        const body = await readJsonBody(req)
        const ref = body.id || body.name
        if (!ref) return json(res, 400, { error: 'bad_request', code: 'bad_request', message: '需要 id 或 name' })
        return json(res, 200, await client.totpEntry(ref))
      }
      if (method === 'POST' && route === 'sync') {
        const vault = await client.syncNow()
        return json(res, 200, { ok: true, items: vault.items.length })
      }
      return json(res, 404, { error: 'not_found', code: 'not_found', message: `未知接口 ${method} /${route}` })
    } catch (error) {
      const vaultError = error instanceof VaultError ? error : null
      return json(res, 400, {
        error: error?.message ?? String(error),
        code: vaultError?.code ?? 'internal_error',
        hint: vaultError?.hint,
      })
    }
  }
}
