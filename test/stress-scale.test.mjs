// Scale stress: a 2000-entry vault through the whole read path.
//
// The point is not a speed threshold — hardware varies — but that nothing in
// the pipeline collapses at size: one full download decrypts every row, the
// first list/overview walk costs something, and the memoised repeats cost
// nothing. Timings are printed so a regression is visible, not asserted.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { CacheStore } from '../lib/cache-store.js'
import { SessionStore } from '../lib/session-store.js'
import { VaultClient, decryptEncString, stretchKey } from '../lib/vault.js'
import { EMAIL, PASSWORD, encryptString, startMockServer } from './mock-server.mjs'

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const section = (title) => console.log('\n' + title)
const SIZE = 2000

const settingsFor = (server, extra = {}) => ({
  serverUrl: server.url,
  email: EMAIL,
  masterPassword: PASSWORD,
  apiKeyClientId: '',
  apiKeyClientSecret: '',
  cacheMinutes: 30,
  ...extra,
})

function scratchDir(label) {
  const dir = mkdtempSync(join(tmpdir(), 'vw-stress-' + label + '-'))
  return {
    dir,
    cachePath: join(dir, 'vault-cache.json.gz'),
    sessionPath: join(dir, 'session.json'),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const readCache = (path) => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))
const nowMs = () => Number(performance.now())
const round = (value) => Math.round(value * 10) / 10

/** Wrap the real transport so a failure names its cause instead of 'fetch failed'. */
const watchdogFetch = async (url, init) => {
  try {
    return await globalThis.fetch(url, init)
  } catch (error) {
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message
    console.log('  ! transport failure ' + url + ' → ' + cause)
    throw error
  }
}

/**
 * Build the big sync payload once. The rows are encrypted with the account's
 * real user key so the client's own decrypt path — not a fixture shortcut — is
 * what the timings measure.
 */
async function bigPayload(fixtures) {
  const masterStretch = stretchKey(fixtures.masterKey)
  const userKey = stretchKey(decryptEncString(fixtures.encryptedUserKey, masterStretch.enc, masterStretch.mac))
  const ciphers = []
  for (let index = 0; index < SIZE; index++) {
    const id = 'cipher-scale-' + String(index).padStart(4, '0')
    const folderId = index % 3 === 0 ? 'folder-work' : null
    if (index % 10 === 7) {
      ciphers.push({
        id,
        type: 2,
        name: encryptString('安全笔记 ' + index, userKey),
        notes: encryptString('第 ' + index + ' 条规模化笔记', userKey),
        folderId,
        favorite: false,
        revisionDate: '2026-03-01T00:00:00.000Z',
      })
      continue
    }
    ciphers.push({
      id,
      type: 1,
      name: encryptString('条目 ' + index, userKey),
      notes: encryptString('notes ' + index, userKey),
      folderId,
      favorite: index % 50 === 0,
      login: {
        username: encryptString('user' + index + '@example.com', userKey),
        password: encryptString('scale-pass-' + index, userKey),
        uris: [{ uri: encryptString('https://host' + index + '.example.com/login', userKey) }],
      },
      fields: [
        { name: encryptString('env', userKey), value: encryptString('prod', userKey), type: 0 },
        { name: encryptString('token', userKey), value: encryptString('tok-' + index, userKey), type: 1 },
      ],
      revisionDate: '2026-03-01T00:00:00.000Z',
    })
  }
  return { ...fixtures.syncPayload, ciphers }
}

async function main() {
  console.log('vault scale stress: ' + SIZE + ' entries through download · list · overview · memo')

  const server = await startMockServer()
  if (!server) {
    console.error('  ! hash-wasm missing, Argon2 mock unavailable — skipping')
    process.exit(0)
  }

  const scratch = scratchDir('scale')
  const payload = await bigPayload(server.fixtures)
  let syncCalls = 0
  // Only /api/sync is replaced: the login, the revision probe and the config
  // probe all still go to the mock server, so this measures the real client.
  const scaleFetch = async (url, init) => {
    if (String(url).includes('/api/sync')) {
      syncCalls++
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return watchdogFetch(url, init)
  }

  const startedAt = nowMs()
  const session = new SessionStore(scratch.sessionPath, { maxAgeDays: 30 })
  const makeClient = (options = {}) =>
    new VaultClient(settingsFor(server, options.settings), {
      fetch: options.fetch ?? scaleFetch,
      sessionStore: session,
      cacheStore: new CacheStore(options.cachePath ?? scratch.cachePath, options.cacheOptions),
    })

  try {
    // ── 1. One download of 2000 rows ────────────────────────────────────────
    section('download and decrypt ' + SIZE + ' entries')
    const client = makeClient()
    const unlockStart = nowMs()
    const vault = await client.unlock()
    const unlockMs = nowMs() - unlockStart
    console.log('  · unlock (login + download + decrypt ' + SIZE + '): ' + round(unlockMs) + 'ms')
    check('the whole payload arrived', vault.items.length === SIZE, String(vault.items.length))
    check('no row was dropped as undecryptable', vault.skipped === 0, String(vault.skipped))
    check('the id index covers every row', vault.byId.size === SIZE, String(vault.byId.size))
    check('exactly one download happened', syncCalls === 1, String(syncCalls))
    check('the download finished inside 30s', unlockMs < 30000, round(unlockMs) + 'ms')
    const last = vault.byId.get('cipher-scale-1999')
    check('the last row decrypted to its own secret', last?.password === 'scale-pass-1999', String(last?.password))
    check(
      'folder grouping counted the folder rows',
      vault.folders.length === 1 && vault.folders[0].id === 'folder-work' && vault.folders[0].count === Math.ceil(SIZE / 3),
      JSON.stringify(vault.folders),
    )

    // ── 2. First list read walks 2000 rows ─────────────────────────────────
    section('first list read over ' + SIZE + ' entries')
    const firstStart = nowMs()
    const firstPage = await client.findEntries('', 100)
    const firstMs = nowMs() - firstStart
    console.log('  · findEntries("" ,100) first call: ' + round(firstMs) + 'ms')
    check('the first list read reports the whole vault', firstPage.vaultItems === SIZE, String(firstPage.vaultItems))
    check('the first list read respects the page size', firstPage.items.length === 100, String(firstPage.items.length))
    check('the first list read flags more pages', firstPage.hasMore === true)
    check('a big list read costs less than 10s', firstMs < 10000, round(firstMs) + 'ms')

    // ── 3. The memoised repeat costs nothing ───────────────────────────────
    section('memoised list reads (#listCache)')
    const repeatStart = nowMs()
    const repeatPage = await client.findEntries('', 100)
    const repeatMs = nowMs() - repeatStart
    console.log('  · findEntries("" ,100) repeat: ' + round(repeatMs) + 'ms')
    check('an identical read returns the very same payload object', repeatPage === firstPage)
    check('an identical read is not slower than the first', repeatMs <= Math.max(firstMs, 1), round(firstMs) + 'ms → ' + round(repeatMs) + 'ms')
    const burstStart = nowMs()
    for (let index = 0; index < 200; index++) await client.findEntries('', 100)
    const burstMs = nowMs() - burstStart
    console.log('  · 200 identical reads: ' + round(burstMs) + 'ms total')
    check('200 memoised reads stay under 1s', burstMs < 1000, round(burstMs) + 'ms')
    const otherPage = await client.findEntries('', 50)
    check('a different page size is a different read', otherPage !== firstPage)
    check('a different page size still reads the vault', otherPage.items.length === 50, String(otherPage.items.length))

    // ── 4. First overview walks the same rows ──────────────────────────────
    section('first overview over ' + SIZE + ' entries')
    const overviewStart = nowMs()
    const overview = await client.overview()
    const overviewMs = nowMs() - overviewStart
    console.log('  · overview() first call: ' + round(overviewMs) + 'ms')
    check('the overview counts every cipher', overview.ciphers === SIZE, String(overview.ciphers))
    check('the overview counts the unfiled rows', overview.unfiled === SIZE - Math.ceil(SIZE / 3), String(overview.unfiled))
    check('the overview has a section for every row kind', overview.sections.every((entry) => Number.isFinite(entry.count)))
    check('an overview over 2000 rows costs less than 5s', overviewMs < 5000, round(overviewMs) + 'ms')

    // ── 5. Paging and search still land on the right rows ──────────────────
    section('paging and search at size')
    const tail = await client.findEntries('', 100, 1950)
    check('the last page returns the remaining rows', tail.items.length === 50, String(tail.items.length))
    check('the last page reports no further pages', tail.hasMore === false)
    // The list is ranked by name, not by arrival order, so offset 1999 holds
    // whichever row sorts last — the assertion is about reachability, not ids.
    const deep = await client.findEntries('', 100, 1999)
    check('the final row is reachable by offset', deep.items.length === 1 && Boolean(vault.byId.get(deep.items[0].id)), String(deep.items?.[0]?.id))
    check('every row is inside the paged window', deep.matched === SIZE, String(deep.matched))
    const beyond = await client.findEntries('', 100, SIZE + 50)
    check('an offset past the end returns an empty page', beyond.items.length === 0, String(beyond.items.length))
    const search = await client.findEntries('条目 1999', 10)
    check('a search over 2000 rows finds its row', search.items.some((item) => item.id === 'cipher-scale-1999'))
    check('a search over 2000 rows does not return the vault', search.matched <= 10, String(search.matched))
    const none = await client.findEntries('no-such-entry-zzz', 10)
    check('a missing query returns an empty page instead of throwing', none.items.length === 0, String(none.items.length))

    // ── 6. Concurrent reads over the big vault ─────────────────────────────
    section('concurrent reads over ' + SIZE + ' entries')
    const queries = ['条目 1', '条目 2', 'notes', 'user1', 'cipher-scale-0001', '', 'env', 'prod']
    const reads = await Promise.allSettled(queries.map((query, index) => client.findEntries(query, 20 + index)))
    check('every concurrent read at size resolves', reads.every((entry) => entry.status === 'fulfilled'))
    check(
      'no concurrent read at size returns a duplicated row',
      reads.every((entry) => {
        if (entry.status !== 'fulfilled') return false
        const ids = entry.value.items.map((item) => item.id)
        return new Set(ids).size === ids.length
      }),
    )

    // ── 7. The 2000-row cache is written and is ciphertext only ────────────
    section('the large cache file')
    check('the large payload was cached', existsSync(scratch.cachePath))
    const record = readCache(scratch.cachePath)
    check('the cached payload holds every row', record.payload.ciphers.length === SIZE, String(record.payload?.ciphers?.length))
    const raw = readFileSync(scratch.cachePath)
    check('the large cache file stores ciphertext only', !raw.includes('scale-pass-'), 'plaintext password in cache')
    check('the large cache file stays under 64 MB', raw.length < 64 * 1024 * 1024, String(raw.length))

    // ── 8. Restoring 2000 rows from disk is a read, not a download ─────────
    section('cold start from a ' + SIZE + '-row cache')
    const before = syncCalls
    const cold = makeClient()
    const coldStart = nowMs()
    const coldVault = await cold.unlock()
    const coldMs = nowMs() - coldStart
    console.log('  · unlock from a ' + SIZE + '-row disk cache: ' + round(coldMs) + 'ms')
    check('the disk cache served the whole vault', coldVault.items.length === SIZE, String(coldVault.items.length))
    check('the disk cache reports itself as cached', coldVault.cached === true)
    check('the disk cache start downloaded nothing', syncCalls === before, String(syncCalls - before))
    const coldPageStart = nowMs()
    const coldPage = cold.findEntries('', 100)
    await coldPage
    console.log('  · first list read after a cache restore: ' + round(nowMs() - coldPageStart) + 'ms')
    check('a cached cold start still lists rows', (await cold.findEntries('', 100)).items.length === 100)

    const total = nowMs() - startedAt
    console.log('  · whole suite: ' + round(total) + 'ms')
    check('the scale suite finishes inside 60s', total < 60000, round(total) + 'ms')
  } finally {
    await server.close?.()
    scratch.dispose()
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
