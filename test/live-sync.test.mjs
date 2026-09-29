/**
 * Live-sync test: WebSocket notification channel, incremental re-sync,
 * LogOut handling, polling fallback, reprompt gating, device identity.
 *
 * The mock server (test/mock-server.mjs) implements the SignalR hub by hand
 * (RFC 6455 framing + the SignalR JSON protocol), so the whole loop — login,
 * negotiate, WebSocket upgrade, push notification, re-sync, decrypt — runs
 * offline against a server that behaves like Vaultwarden.
 *
 * Run: node test/live-sync.test.mjs
 */
import { VaultClient } from '../lib/vault.js'
import { NotificationChannel, NotificationType } from '../lib/notifications.js'
import { EMAIL, PASSWORD, startMockServer } from './mock-server.mjs'

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const settingsFor = (server, extra = {}) => ({
  serverUrl: server.url,
  email: EMAIL,
  masterPassword: PASSWORD,
  apiKeyClientId: '',
  apiKeyClientSecret: '',
  cacheMinutes: 30,
  ...extra,
})

async function waitFor(condition, { timeout = 8000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await sleep(interval)
  }
}

async function main() {
  console.log('live sync test (WebSocket notifications + polling fallback)')
  const server = await startMockServer({ repromptCipher: true })
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }

  // 1. bare channel: negotiate + upgrade + SignalR handshake ------------------
  const client = new VaultClient(settingsFor(server))
  await client.unlock()
  const channel = new NotificationChannel({
    server: client.server,
    getToken: async () => (await client.ensureToken()).accessToken,
    fetch: client.fetch,
  })
  await channel.start()
  const opened = await waitFor(() => channel.connected)
  check('WebSocket handshake completes (negotiate + SignalR)', opened && server.hubStats.connections === 1, JSON.stringify(channel.report()))
  await channel.stop()
  check('channel stops cleanly', channel.state === 'closed')

  // 2. live sync through VaultClient ------------------------------------------
  const initialItems = client.vault.items.length
  const live = client.startLiveSync({ pollIntervalMs: 60_000 })
  const attached = await waitFor(() => live.mode === 'websocket')
  check('live sync attaches to the notifications hub', attached, JSON.stringify(live.report()))

  // Another device adds an entry: the server payload grows, then a hub
  // notification arrives. Two rapid notifications must debounce into one sync.
  const syncsBefore = server.stats.syncs
  server.fixtures.syncPayload.ciphers.push({ ...server.fixtures.syncPayload.ciphers[1], id: 'cipher-db-2' })
  server.notify(NotificationType.SyncCipherCreate)
  server.notify(NotificationType.SyncCipherUpdate)
  const pickedUp = await waitFor(() => client.vault.items.length === initialItems + 1)
  check('hub notification triggers a debounced re-sync', pickedUp, `items ${initialItems}→${client.vault.items.length}`)
  check('exactly one sync per notification burst', server.stats.syncs - syncsBefore === 1, `+${server.stats.syncs - syncsBefore}`)
  const found = JSON.parse(await client.find('生产数据库口令'))
  check('the new entry is searchable without any tool refresh', found.matched === 2, `matched ${found.matched}`)
  check('status reports the live channel', JSON.parse(await client.status()).liveSync?.connected === true)

  // 3. LogOut revokes the session ---------------------------------------------
  server.notify(NotificationType.LogOut)
  const loggedOut = await waitFor(() => client.token === null && client.vault === null)
  check('LogOut notification drops tokens and cached vault', loggedOut)
  const tokensBefore = server.stats.tokenIssued
  await client.find('github')
  check('next use re-logs in after LogOut', server.stats.tokenIssued === tokensBefore + 1, `tokens ${tokensBefore}→${server.stats.tokenIssued}`)
  client.stopLiveSync()

  // 4. polling when WebSocket is disabled --------------------------------------
  const poller = new VaultClient(settingsFor(server, { websocket: false }))
  await poller.unlock()
  const polling = poller.startLiveSync({ pollIntervalMs: 5000, websocket: false })
  check('websocket disabled → polling mode', polling.mode === 'polling')
  const pollSyncs = server.stats.syncs
  const polled = await waitFor(() => server.stats.syncs > pollSyncs, { timeout: 9000 })
  check('polling re-syncs on its interval', polled, `syncs ${pollSyncs}→${server.stats.syncs}`)
  poller.stopLiveSync()

  // 5. hub unreachable (proxy blocks the upgrade) → polling ---------------------
  const blocked = new VaultClient(settingsFor(server))
  await blocked.unlock()
  const fallback = blocked.startLiveSync({
    channelOptions: {
      WebSocketImpl: () => {
        throw new Error('proxy blocks the upgrade')
      },
      maxAttempts: 1,
    },
  })
  const degraded = await waitFor(() => fallback.mode === 'polling')
  check('WebSocket failure degrades to polling', degraded, JSON.stringify(fallback.report()))
  blocked.stopLiveSync()

  // 6. Bitwarden reprompt convention -------------------------------------------
  const reprompt = JSON.parse(await client.get('cipher-reprompt'))
  check('reprompt item is not auto-revealed', reprompt.repromptRequired === true && !('password' in reprompt), JSON.stringify(reprompt))
  const confirmed = JSON.parse(await client.get('cipher-reprompt', 'password', undefined, { confirm: true }))
  check('reprompt item reveals with explicit confirm', confirmed.password === 'reprompt-pass-9')

  // 7. stable, deterministic device identity ------------------------------------
  const ids = new Set(server.stats.deviceIdentifiers)
  check('device identifier is stable across logins', ids.size === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test([...ids][0]), [...ids].join(','))
  const custom = new VaultClient(settingsFor(server, { deviceIdentifier: 'my-fixed-device-id' }))
  await custom.unlock()
  check('explicit deviceIdentifier is honored', server.stats.deviceIdentifiers.at(-1) === 'my-fixed-device-id')

  await server.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
