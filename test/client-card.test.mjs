/**
 * Structural + interaction test for the browser half (`lib/client.js`).
 *
 * Loads the client bundle exactly the way the browser module loader does
 * (`window.__ModuleLoader__.load({id, factory})`), runs `apply` against a fake
 * client context whose `connection.rpc.call` is stubbed, then mounts the
 * registered settings section with react-test-renderer and drives it: list,
 * debounced search, detail, password reveal, copy, the Bitwarden reprompt
 * gate, the TOTP countdown, and the empty / not-configured / no-connection
 * states. Two of the checks are races: a stale list answer for a query the
 * reader has left, and a late "confirm read" for an entry they have left.
 *
 * Run: node test/client-card.test.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let react
let rendererApi
try {
  react = require('react')
  rendererApi = require('react-test-renderer')
} catch {
  // A suite that prints "skipping" and exits 0 is a suite that reports success
  // without running a single assertion — every panel check below would vanish
  // from the run and nobody would notice. Fail loudly instead.
  console.error('client-card: react / react-test-renderer not installed — cannot run the panel checks')
  console.error('  install them with: npm install --no-save --legacy-peer-deps react@18.3.1 react-test-renderer@18.3.1')
  process.exit(1)
}
const { create, act } = rendererApi

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The browser provides window; react-test-renderer does not. The panel's
// "/" shortcut listens on it, so scaffold the minimal surface here.
if (typeof globalThis.window === 'undefined' || typeof globalThis.window.addEventListener !== 'function') {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

// The panel writes its own stylesheet, because a container query cannot live
// in an inline style. react-test-renderer hands out no document either, so
// scaffold the smallest surface `ensureStyles` needs and keep the text it
// writes: the narrow-panel rules are assertions in their own right below.
let panelSheetText = ''
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({
      id: '',
      set textContent(value) { panelSheetText = value },
      get textContent() { return panelSheetText },
    }),
    head: { appendChild: () => {} },
  }
}

// The browser hands out localStorage; react-test-renderer does not. The panel
// keeps the last successful read there so a reload can paint instantly, and the
// tests below drive that store directly. The key must match lib/client.js.
const SNAPSHOT_KEY = 'dsh-vaultwarden:snapshot'
const storageMock = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
  setItem(key, value) { this.store.set(key, String(value)) },
  removeItem(key) { this.store.delete(key) },
}
globalThis.localStorage = storageMock

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

// ── canned RPC payloads ───────────────────────────────────────────────────────
const ITEMS = [
  { id: 'item-1', name: 'GitHub 工作账号', type: 'login', username: 'octocat@example.com', uris: ['https://github.com/login'], folder: '工作', collections: [], hasTotp: true, hasNotes: true, customFields: ['租户'], favorite: true },
  { id: 'item-2', name: '生产数据库口令', type: 'secureNote', username: null, uris: [], folder: null, collections: [], hasTotp: false, hasNotes: false, customFields: [], favorite: false },
  { id: 'item-3', name: '需要重新验证的条目', type: 'login', username: 'reprompt-user', uris: [], folder: null, collections: [], hasTotp: false, hasNotes: false, customFields: [], favorite: false },
  // The shape most real vaults are full of: an entry named after a host, whose
  // first character is a digit. Its tile must come from the username.
  { id: 'item-4', name: '10.0.0.10', type: 'login', username: 'demo-user', uris: ['https://10.0.0.10'], folder: null, collections: [], hasTotp: false, hasNotes: false, customFields: [], favorite: false },
]
/** Derived, so adding a fixture entry cannot leave a count assertion stale. */
const ITEM_COUNT = ITEMS.length

const STATUS_REPORT = {
  configured: true,
  authMode: 'password',
  serverUrl: 'https://vault.example.com',
  email: 'me@example.com',
  cacheMinutes: 30,
  liveSync: { mode: 'websocket', connected: true, pollIntervalMs: 60000, lastSyncAt: new Date().toISOString(), lastError: null },
  unlocked: true,
  items: ITEM_COUNT,
}
// A reveal payload carries no `totpSecret` — the host never sends it across the
// boundary, only the boolean `hasTotp` (plus the computed `totp` on the 'totp'
// field, stubbed below). The fixture used to carry a secret, which made the panel
// look correct while every real entry showed a dash.
const REVEALS = {
  'item-1': { id: 'item-1', name: 'GitHub 工作账号', type: 'login', username: 'octocat@example.com', password: 'gh-p@ssw0rd-42', hasTotp: true, uris: ['https://github.com/login'], notes: 'SSH 密钥在 CI 里', fields: [{ name: '租户', value: 'jindom' }], folder: '工作', collections: [] },
  'item-3': { repromptRequired: true, id: 'item-3', name: '需要重新验证的条目', type: 'login' },
}
const CONFIRMED_REVEAL = { ...REVEALS['item-3'], repromptRequired: undefined, password: 'reprompt-pass-9', username: 'reprompt-user' }

/** The hosted configuration the panel opens with. */
const CONFIG_VALUE = { serverUrl: 'https://vault.example.com', email: 'me@example.com', hasMasterPassword: true, hasApiKey: false, websocket: true, pollIntervalSeconds: 60, cacheMinutes: 30, accessMode: 'readonly' }
/** `boot`'s view of a live session. */
const AUTHED_SESSION = { configured: true, authenticated: true, pendingTwoFactor: false, unlocked: true }
/** `boot`'s view of a session the host could not revive. */
const SIGNED_OUT_SESSION = { configured: true, authenticated: false, pendingTwoFactor: false, unlocked: false }
/** One `boot` answer, shaped the way the gateway returns it. */
const bootWith = (config, resumed, session) => ({ ok: true, value: { config, resumed: Boolean(resumed), session } })

/**
 * The rows one sidebar place holds, narrowed the way the host narrows them.
 *
 * The host picks the pool first and scores and pages second, so the count it
 * reports describes the place on screen. A stub that filtered after paging
 * would make every badge a lie, and the panel checks below would pass against
 * a host contract nobody serves.
 */
const sectionPool = (items, section, sectionValue, includeTrashed = false) => {
  if (section === 'trash') return items.filter((item) => item.trashed === true)
  if (section === 'archive') return items.filter((item) => item.archived === true)
  const live = items.filter((item) => !item.archived && !item.trashed)
  // The one place that mixes the two: 全部条目 asks for the trashed rows as
  // well, and the host puts them in front of the live ones.
  const extra = section === 'all' && includeTrashed ? items.filter((item) => item.trashed === true) : []
  const value = sectionValue === undefined || sectionValue === null ? '' : String(sectionValue)
  if (section === 'favorites') return [...extra, ...live.filter((item) => item.favorite === true)]
  if (section === 'totp') return [...extra, ...live.filter((item) => item.hasTotp === true)]
  if (section === 'type') return [...extra, ...live.filter((item) => String(item.type ?? 'login') === value)]
  if (section === 'folder') return [...extra, ...live.filter((item) => String(item.folderId ?? '') === value || item.folder === value)]
  if (section === 'unfiled') return [...extra, ...live.filter((item) => !item.folder && !item.folderId)]
  return [...extra, ...live]
}

/** Build a stubbed `connection.rpc.call` over canned `vw/*` payloads. */
function makeRpc(overrides = {}) {
  const calls = []
  const rpc = {
    calls,
    call: async (_channel, endpoint, payload) => {
      const method = String(endpoint).replace(/^vw\//, '')
      calls.push({ method, args: payload?.args ?? {} })
      const route = overrides[method]
      if (route !== undefined) return route(payload?.args ?? {})
      if (method === 'status') return { ok: true, value: STATUS_REPORT }
      if (method === 'list') {
        const args = payload?.args ?? {}
        const query = String(args.query ?? '')
        const pool = sectionPool(ITEMS, String(args.section ?? 'all'), args.sectionValue, args.includeTrashed === true)
        const matchedItems = query ? pool.filter((item) => `${item.name}${item.username ?? ''}`.includes(query)) : pool
        // Honour limit/offset the way the host does, so the paging scenarios
        // below exercise the real read contract rather than a full dump.
        const offset = Math.max(0, Number(args.offset) || 0)
        const limit = Math.max(1, Math.min(Number(args.limit) || 200, 200))
        const page = matchedItems.slice(offset, offset + limit)
        return {
          ok: true,
          value: {
            query,
            matched: matchedItems.length,
            returned: page.length,
            offset,
            hasMore: offset + page.length < matchedItems.length,
            vaultItems: pool.length,
            items: page,
          },
        }
      }
      if (method === 'overview') {
        // The sidebar's own read. Its counts are the host's, which is the whole
        // reason the method exists: numbers taken from the page that happens to
        // be loaded would describe a window, not a place.
        const typeCounts = new Map()
        for (const item of ITEMS) {
          const id = String(item.type ?? 'login')
          typeCounts.set(id, (typeCounts.get(id) ?? 0) + 1)
        }
        const live = ITEMS.filter((item) => !item.archived && !item.trashed)
        const trashed = ITEMS.filter((item) => item.trashed === true).length
        const archived = ITEMS.filter((item) => item.archived === true).length
        const folderList = [{ id: 'folder-work', name: '工作', count: live.filter((item) => item.folder === '工作' || item.folderId === 'folder-work').length }]
        return {
          ok: true,
          value: {
            identity: `${CONFIG_VALUE.serverUrl}\u0000${CONFIG_VALUE.email}`,
            ciphers: ITEMS.length,
            items: live.length,
            liveItems: live.length,
            archived,
            trashed,
            folders: folderList.length,
            folderCount: folderList.length,
            unfiled: live.filter((item) => !item.folder && !item.folderId).length,
            sections: [
              { id: 'all', label: '全部条目', count: live.length },
              { id: 'favorites', label: '收藏', count: live.filter((item) => item.favorite === true).length },
              { id: 'totp', label: '验证码', count: live.filter((item) => item.hasTotp === true).length },
              { id: 'archive', label: '归档', count: archived },
              { id: 'trash', label: '回收站', count: trashed },
            ],
            types: [...typeCounts].map(([id, count]) => ({ id, label: id, count })),
            folderList,
            latestAt: null,
            trashLatestAt: null,
            updatedAt: new Date().toISOString(),
          },
        }
      }
      if (method === 'reveal') {
        const args = payload?.args ?? {}
        // No `confirm` shortcut any more: the panel reaches a reprompt entry
        // through `authorizeReprompt`, which hands the view back with the
        // unlock, so `reveal` never sees the password for item-3.
        return { ok: true, value: REVEALS[args.id] ?? { error: 'not_found' } }
      }
      if (method === 'repromptGrant') return { ok: true, value: { granted: false, remainingMs: 0 } }
      if (method === 'authorizeReprompt') {
        const args = payload?.args ?? {}
        if (args.password !== 'correct horse battery staple') {
          return { ok: true, value: { authorized: false, message: '主密码不对' } }
        }
        return { ok: true, value: { authorized: true, remainingMs: 300000, grantMinutes: 5, view: CONFIRMED_REVEAL } }
      }
      if (method === 'totp') return { ok: true, value: { id: 'item-1', name: 'GitHub 工作账号', totp: { code: '123456', digits: 6, period: 30, secondsRemaining: 20, remaining: 20, algorithm: 'SHA1' } } }
      if (method === 'config') return { ok: true, value: CONFIG_VALUE }
      if (method === 'configure') return { ok: true, value: { serverUrl: 'https://vault.example.com', email: 'me@example.com', hasMasterPassword: true } }
      if (method === 'twoFactor') return { ok: true, value: { pending: true, providers: [0], provider: 0 } }
      // Default: a stored session, so the panel renders the vault. The host
      // revives it from disk inside `boot` — that used to be two sequential
      // RPCs (`config` then `session`) and neither of them restored it, which
      // is why a restart (or an expired access token) demanded a password
      // again. Tests that need the sign-in screen override this with
      // `resumed: false`.
      if (method === 'boot') return { ok: true, value: { config: CONFIG_VALUE, resumed: true, session: AUTHED_SESSION } }
      if (method === 'submitTwoFactor') return { ok: true, value: { ok: true, items: 3 } }
      return { ok: false, error: { code: 'not_found', message: `vw.${method} unknown` } }
    },
  }
  return rpc
}

/** Load the bundle once and return its materialized module. */
function loadModule() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry
  const windowStub = {
    __ModuleLoader__: { load: (value) => (entry = value) },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  new Function('window', source)(windowStub)
  const mod = entry.factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require(${id})`)
  })
  return { entry, mod }
}

/** Apply the module against a context whose connection returns `rpc`. */
async function mountPanel(mod, dictionaries, rpcOrUndefined, options = {}) {
  // The panel keeps a module-level cache across unmounts; each test starts from
  // a clean slate so one scenario cannot leak into the next. Tests that
  // deliberately exercise the cache pass { keepCache: true }.
  if (!options.keepCache) {
    mod.__resetOpenCache?.()
    // The "this host cannot page" memory is module-scope too: one scenario's
    // refusing host must not decide how the next scenario reads its vault.
    mod.__resetPagingRefusal?.()
  }
  const registrations = []
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (ns, dicts) => {
        dictionaries.zh = dicts.zh
        dictionaries.en = dicts.en
        return () => {}
      },
      bind: () => (key) => dictionaries.zh?.[key] ?? key,
    },
    get: (name) => (name === 'connection' && rpcOrUndefined ? { rpc: rpcOrUndefined } : undefined),
    slots: {
      inject: (name, callback) => callback(),
      register: (options, render) => {
        registrations.push({ options, render })
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  const registration = registrations.find((candidate) => candidate.options.name === 'settings.section')
  let renderer
  await act(async () => {
    renderer = create(registration.render({ ...registration.options.inject() }))
  })
  await act(async () => {
    await sleep(50)
  })
  return { renderer, registration, t: (key) => dictionaries.zh[key] ?? key }
}

/** A 130-entry vault: large enough that paging must kick in twice. */
const BIG_ITEMS = Array.from({ length: 130 }, (_, index) => ({
  id: `big-${index + 1}`,
  name: `条目 ${String(index + 1).padStart(3, '0')}`,
  type: 'login',
  username: `user${index + 1}@example.com`,
  uris: [],
  folder: null,
  collections: [],
  hasTotp: false,
  hasNotes: false,
  customFields: [],
  favorite: false,
}))
const BIG_COUNT = BIG_ITEMS.length

/** "The reader is at the bottom": remaining distance 0. */
const atBottom = { scrollTop: 700, scrollHeight: 700, clientHeight: 0 }
/** A bare object without DOM metrics: the bottom check must not trust it. */
const noElement = {}

const isRow = (node) => node?.props?.role === 'option'
const optionRows = (renderer) => renderer.root.findAll((node) => isRow(node))
const flush = async (ms = 60) => {
  await act(async () => {
    await sleep(ms)
  })
}

async function main() {
  console.log('entry panel (browser half) test')

  const { entry, mod } = loadModule()
  check('bundle calls window.__ModuleLoader__.load with the package id', entry?.id === 'dsh-vaultwarden', String(entry?.id))
  check('bundle exposes a factory', typeof entry?.factory === 'function')
  check('materialization returns the exports object (loader contract)', Boolean(mod) && typeof mod === 'object')
  check('client module exports name/inject/apply', mod.name === 'dsh-vaultwarden' && Array.isArray(mod.inject) && typeof mod.apply === 'function')
  check('client module injects slots + locale + connection', ['slots', 'locale', 'connection'].every((name) => mod.inject.includes(name)), JSON.stringify(mod.inject))

  // ── happy path ────────────────────────────────────────────────────────────
  const dictionaries = {}
  const rpc = makeRpc()
  const { renderer, registration, t } = await mountPanel(mod, dictionaries, rpc)
  check('registers the entry panel as a settings page', Boolean(registration) && registration.options.id === 'vaultwarden', JSON.stringify(registration?.options))
  {
    // The host's settings nav hands every plugin section the generic gear and
    // offers no icon slot, so the label itself carries the glyph: VaultNavLabel
    // hides that gear and lets the glyph join its flex flow, keeping the row's
    // rhythm in the desktop column and the mobile tab strip alike.
    let labelRenderer = null
    await act(async () => {
      labelRenderer = create(registration.options.label())
    })
    const labelJson = JSON.stringify(labelRenderer.toJSON())
    check('panel label comes from the dictionary', labelJson.includes('凭据库'), labelJson.slice(0, 120))
    check('the settings label carries the vault glyph', labelJson.includes('vw-nav-glyph') && labelJson.includes('M8 1.7 13.8 3.7V8'), labelJson.slice(0, 120))
    check('the settings label is marked for the gear replacement', labelJson.includes('vw-nav-label') && labelJson.includes('vw-nav-text'))
  }

  // ── compact header (reported: the title and search box were noisy) ───────
  // The title stays short; Vaultwarden support rides alongside it in small
  // type. The search placeholder used to carry the keyboard shortcuts and was
  // truncated on a phone, so it is short now and the shortcuts moved into the
  // input tooltip.
  {
    const headerText = JSON.stringify(renderer.toJSON())
    check('the panel title stays short', headerText.includes('Bitwarden 凭据库') && !headerText.includes('Bitwarden / Vaultwarden 凭据库'))
    check('the title notes Vaultwarden alongside Bitwarden', headerText.includes('支持 Bitwarden / Vaultwarden'))
    const search = renderer.root.findAllByType('input').find((node) => node.props.type === 'search')
    check('the search placeholder is short', search?.props.placeholder === '搜索名称、用户名或网址', String(search?.props.placeholder))
    check('the keyboard shortcuts moved into the tooltip', String(search?.props.title).includes('Esc'))
    check('the search box carries the narrow-screen hook', search?.props['data-vw-search'] === '')

  }

  const text = () => JSON.stringify(renderer.toJSON())
  const buttons = () => renderer.root.findAllByType('button')
  const rows = () => buttons().filter((node) => node.props.role === 'option')

  check('panel loads the vault list over vw/list', text().includes('GitHub 工作账号') && text().includes('生产数据库口令'))

  // A leading digit identifies nothing: entries named after an IP address all
  // showed the same "1" tile. Such an entry now takes its glyph from the
  // username, so the list reads as distinct rows at a glance.
  const monograms = rows().map((row) => String(row.children[0]?.children?.[0] ?? ''))
  check('no list entry is reduced to its leading digit', !monograms.includes('1'), JSON.stringify(monograms))
  check('an IP-named entry takes its glyph from the username', monograms[3] === 'D', JSON.stringify(monograms))
  check('panel shows the sync chip', text().includes('实时同步'))
  // The chip is also the manual-sync control and carries a hover tooltip.
  {
    const chip = renderer.root.findAllByType('button').find((node) => /实时同步|轮询|同步已关闭/.test(String(node.props.children?.[1] ?? '')))
    check('the sync chip is a clickable control', Boolean(chip) && chip.props.type === 'button', chip ? String(chip.props.children?.[1]) : 'not found')
    check('the sync chip carries a tooltip', Boolean(chip?.props.title) && /同步方式/.test(chip.props.title), String(chip?.props.title).slice(0, 60))
    const syncCallsBefore = rpc.calls.filter((call) => call.method === 'sync').length
    await act(async () => {
      chip.props.onClick()
    })
    await act(async () => {
      await sleep(50)
    })
    check('clicking the chip triggers a manual sync', rpc.calls.filter((call) => call.method === 'sync').length > syncCallsBefore)
  }
  // ── one round trip, and no sign-in for a stored session ──────────────────
  // Opening used to cost two sequential RPCs (config, then session), and the
  // answer to `session` was the in-memory token only: after a restart — or an
  // hour later, when the access token aged out — a perfectly good device was
  // asked to type its password again. `boot` answers both in one call and
  // revives the stored session from disk while it is in there.
  check('opening asks the host for boot', rpc.calls.some((call) => call.method === 'boot'), JSON.stringify(rpc.calls.map((call) => call.method)))
  check('opening no longer asks for config and session separately', !rpc.calls.some((call) => call.method === 'session'))
  check('a revived session is drawn without a fresh login', !rpc.calls.some((call) => call.method === 'connect'))

  check('panel shows the vault size', text().includes(`共 ${ITEM_COUNT} 条`))
  check('list renders one option per entry', rows().length === ITEM_COUNT, `rows=${rows().length}`)
  check('selected state is exposed via aria-selected', rows()[0].props['aria-selected'] === 'false')

  // ── an archived entry stays visible in the list, and says so ─────────────
  // The host's list read asks for archived rows on purpose (a retired entry
  // must stay findable for the person who filed it) and flags them; the row
  // carries a badge so it does not read as a live credential. The model-facing
  // search hides them by default — that side is tested in write-back.
  {
    const archivedRpc = makeRpc({
      list: () => ({
        ok: true,
        value: {
          query: '',
          matched: 1,
          returned: 1,
          vaultItems: 1,
          items: [{ id: 'item-archived', name: '旧运维账号', type: 'login', username: 'ops@example.com', uris: [], folder: null, collections: [], hasTotp: false, hasNotes: false, customFields: [], favorite: false, archived: true }],
        },
      }),
    })
    const panel = await mountPanel(mod, {}, archivedRpc)
    const panelText = JSON.stringify(panel.renderer.toJSON())
    check('an archived row stays on the list', panelText.includes('旧运维账号'))
    check('an archived row carries a badge', panelText.includes('已归档'), panelText.slice(0, 240))
    await act(async () => {
      panel.renderer.unmount()
    })
  }
  check('a live list carries no archive badge', !text().includes('已归档'))

  // search: debounced reload
  const search = () => renderer.root.findByType('input')
  await act(async () => {
    search().props.onChange({ target: { value: '数据库' } })
  })
  await act(async () => {
    await sleep(350)
  })
  check('search filters through vw/list', text().includes('生产数据库口令') && !text().includes('GitHub 工作账号'))
  await act(async () => {
    search().props.onChange({ target: { value: '' } })
  })
  await act(async () => {
    await sleep(350)
  })

  // ── a keystroke must not blank the rows it is typed over ─────────────────
  // Reported: every letter typed into the search box flashed the whole panel.
  // The read a keystroke starts used to drop the list into a "loading" status,
  // so the rows were replaced by a placeholder and the toolbar — carrying the
  // search box the reader is typing into — was unmounted and remounted under
  // the cursor. The read now lands on 'refreshing': the previous rows and the
  // toolbar stay put until the answer arrives.
  {
    let releaseSearch = null
    const slowSearchRpc = makeRpc({
      list: (args) => {
        const query = String(args.query ?? '')
        const matched = query ? ITEMS.filter((item) => `${item.name}${item.username ?? ''}`.includes(query)) : ITEMS
        const offset = Math.max(0, Number(args.offset) || 0)
        const limit = Math.max(1, Math.min(Number(args.limit) || 200, 200))
        const page = matched.slice(offset, offset + limit)
        const payload = { query, matched: matched.length, returned: page.length, offset, hasMore: offset + page.length < matched.length, vaultItems: ITEMS.length, items: page }
        // The search read is held open: the test needs the moment where the
        // reader has typed and the host has not answered yet.
        if (query && !releaseSearch) {
          return new Promise((resolve) => {
            releaseSearch = () => resolve({ ok: true, value: payload })
          })
        }
        return { ok: true, value: payload }
      },
    })
    const panel = await mountPanel(mod, {}, slowSearchRpc)
    const panelText = () => JSON.stringify(panel.renderer.toJSON())
    const panelSearch = () => panel.renderer.root.findAllByType('input').find((node) => node.props.type === 'search')
    check('flicker setup: the whole vault is on screen first', optionRows(panel.renderer).length === ITEM_COUNT, `rows=${optionRows(panel.renderer).length}`)

    await act(async () => {
      panelSearch().props.onChange({ target: { value: '数' } })
    })
    // Past the debounce: the read is in flight and nothing has answered it.
    await act(async () => {
      await sleep(350)
    })
    check('flicker setup: the search read is in flight', typeof releaseSearch === 'function')
    check('a keystroke leaves the previous rows on screen', optionRows(panel.renderer).length === ITEM_COUNT, `rows=${optionRows(panel.renderer).length}`)
    check('a keystroke raises no loading placeholder over the rows', !panelText().includes('正在读取'), panelText().slice(0, 200))
    check('the search box survives the read it started', Boolean(panelSearch()))
    check('the panel says it is refreshing instead', panelText().includes('正在刷新'), panelText().slice(0, 200))

    await act(async () => {
      releaseSearch?.()
    })
    await flush()
    check('the answer replaces the rows once it lands', optionRows(panel.renderer).length === 1 && panelText().includes('生产数据库口令'), `rows=${optionRows(panel.renderer).length}`)
    check('the refreshing note goes away with the answer', !panelText().includes('正在刷新'))
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // selection → detail
  await act(async () => {
    rows()[0].props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  check('selecting a row loads its detail over vw/reveal', text().includes('octocat@example.com'))
  check('password is masked until revealed', text().includes('●●●●●●●●') && !text().includes('gh-p@ssw0rd-42'))
  check('TOTP countdown renders the code', /\b123456\b/.test(text()))
  // The panel is never handed a secret, only the host's boolean: the code above
  // can only be on screen because the gate reads that flag and asks vw/totp.
  check('the TOTP gate opens from the host flag alone', rpc.calls.some((call) => call.method === 'totp' && call.args.id === 'item-1'), JSON.stringify(rpc.calls.filter((call) => call.method === 'totp')))
  check('the reveal fixture carries the boolean, never a secret', REVEALS['item-1'].hasTotp === true && !('totpSecret' in REVEALS['item-1']))
  check('detail offers copy buttons', text().includes('复制'))

  // ── the countdown is a ring that shrinks, and cools as it does ───────────
  // Reported: the bar only moved once a second, and nothing said how urgent
  // the remaining seconds were. It is now an arc that sweeps between ticks,
  // with the seconds inside it. Then: the last seconds must read as red, so the
  // tone is a ramp — green while the time is ample, cooling through orange, and
  // landing on red. The stylesheet carries the sweep (and its reduced-motion
  // opt-out); these checks pin the geometry, the ramp and the label.
  {
    // Node has no `CSS` global, so the mix path is opened explicitly here; the
    // no-support fallback is checked separately below.
    const savedCSS = globalThis.CSS
    globalThis.CSS = { supports: () => true }
    const ringWrapOf = (renderer) => renderer.root.findAll((node) => node.props?.role === 'img').find((node) => String(node.props?.['aria-label'] ?? '').includes('动态码剩余'))
    const ringOf = (renderer) => renderer.root.findAllByType('circle').find((node) => node.props['data-vw-totp-ring'] !== undefined)
    /** Everything written under one node — react-test-renderer nodes have no toJSON of their own. */
    const textOf = (node) => {
      const walk = (current) => {
        if (current === null || current === undefined) return ''
        if (typeof current === 'string' || typeof current === 'number') return String(current)
        if (Array.isArray(current)) return current.map(walk).join('')
        return walk(current.children)
      }
      return walk(node)
    }
    const offsets = []
    const ladder = [
      [24, ['--vw-ok'], 'still green'],
      [12, ['color-mix', '--vw-ok', '--vw-warn'], 'cooling out of green'],
      [3, ['color-mix', '--vw-err', '--vw-warn'], 'arriving at red'],
    ]
    for (const [seconds, expected, note] of ladder) {
      const rpc = makeRpc({
        totp: () => ({ ok: true, value: { id: 'item-1', name: 'GitHub 工作账号', totp: { code: '123456', digits: 6, period: 30, secondsRemaining: seconds, remaining: seconds, algorithm: 'SHA1' } } }),
      })
      const panel = await mountPanel(mod, {}, rpc)
      await act(async () => {
        optionRows(panel.renderer)[0].props.onClick()
      })
      await flush()
      const wrap = ringWrapOf(panel.renderer)
      const ring = ringOf(panel.renderer)
      const offset = Number(ring?.props?.strokeDashoffset)
      offsets.push(offset)
      const stroke = String(ring?.props?.stroke)
      check('with ' + seconds + 's left the ring is ' + note, Boolean(ring) && expected.every((part) => stroke.includes(part)), stroke)
      check('with ' + seconds + 's left the arc has shortened accordingly', Math.abs(offset - 2 * Math.PI * 12 * (1 - seconds / 30)) < 0.05, 'offset=' + ring?.props.strokeDashoffset)
      check('with ' + seconds + 's left the seconds sit inside the ring', textOf(wrap) === String(seconds) && String(wrap?.props['aria-label']).includes(String(seconds)), textOf(wrap) + ' / ' + String(wrap?.props['aria-label']))
      await act(async () => {
        panel.renderer.unmount()
      })
    }
    check('the arc only ever grows shorter as the window closes', offsets[0] < offsets[1] && offsets[1] < offsets[2], JSON.stringify(offsets))

    // A browser without color-mix() must snap to the nearer end of the ramp,
    // never drop the stroke: an invisible arc reads as "no countdown at all".
    if (savedCSS === undefined) delete globalThis.CSS
    else globalThis.CSS = savedCSS
    const plain = await mountPanel(mod, {}, makeRpc({
      totp: () => ({ ok: true, value: { id: 'item-1', name: 'GitHub 工作账号', totp: { code: '123456', digits: 6, period: 30, secondsRemaining: 12, remaining: 12, algorithm: 'SHA1' } } }),
    }))
    await act(async () => {
      optionRows(plain.renderer)[0].props.onClick()
    })
    await flush()
    const plainStroke = String(ringOf(plain.renderer)?.props?.stroke)
    check('without color-mix() the ring snaps to the nearer tone instead of vanishing', plainStroke.includes('--vw-ok') || plainStroke.includes('--vw-warn'), plainStroke)
    await act(async () => {
      plain.renderer.unmount()
    })

    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    check('the sweep is declared, with a reduced-motion opt-out', source.includes('stroke-dashoffset 1s linear') && source.includes('prefers-reduced-motion: reduce'))
    check('the ramp lands on the error token, not a third flat amber', source.includes('rampTone(TOKEN.warn, TOKEN.err') && !source.includes('--vw-amber'))
  }

  const revealToggle = () => buttons().filter((node) => node.props.children === '显示')
  await act(async () => {
    revealToggle()[0].props.onClick()
  })
  check('the show toggle reveals the password', text().includes('gh-p@ssw0rd-42'))

  // reprompt gate: going back to the list is now a step (one level at a time)
  const backToList = () => buttons().find((node) => /返回列表/.test(String(node.props.children ?? '')))
  check('the detail view offers a way back to the list', Boolean(backToList()))
  await act(async () => {
    backToList().props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  check('going back restores the list', rows().length === ITEM_COUNT, `rows=${rows().length}`)
  await act(async () => {
    rows()[2].props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  check('reprompt entry is gated with an explanation', text().includes('重新验证') && !text().includes('reprompt-pass-9'))
  // The panel asks for the master password; a wrong one leaves the gate shut.
  const masterInput = () => renderer.root.findAllByType('input').find((node) => node.props.type === 'password')
  const confirmButton = () => buttons().find((node) => node.props.children === '输入主密码解锁')
  check('the gate asks for the master password', Boolean(masterInput()) && Boolean(confirmButton()))
  await act(async () => {
    masterInput().props.onInput({ target: { value: 'wrong password' } })
  })
  await act(async () => {
    confirmButton().props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  check('a wrong master password is reported and reveals nothing', text().includes('主密码不对') && !text().includes('reprompt-pass-9'))
  await act(async () => {
    masterInput().props.onInput({ target: { value: 'correct horse battery staple' } })
  })
  await act(async () => {
    confirmButton().props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  check('the master password reads the reprompt entry', text().includes('reprompt-pass-9'))
  check('the unlock goes through vw/authorizeReprompt, never a reveal flag', rpc.calls.some((call) => call.method === 'authorizeReprompt') && !rpc.calls.some((call) => call.method === 'reveal' && call.args.confirm === true))
  await act(async () => {
    renderer.unmount()
  })

  // ── progressive paging: a small first page, then the rest on scroll ───────
  // The reported slowness: one read carried the whole vault across the RPC
  // boundary before a single row could be drawn. The panel now reads a small
  // first page, appends the next as the reader nears the bottom, and keeps the
  // count honest from the host's own total.
  {
    const bigDictionaries = {}
    const bigRpc = makeRpc({
      list: (args) => {
        const query = String(args.query ?? '')
        const matched = query ? BIG_ITEMS.filter((item) => item.name.includes(query)) : BIG_ITEMS
        const offset = Math.max(0, Number(args.offset) || 0)
        const limit = Math.max(1, Math.min(Number(args.limit) || 200, 200))
        const page = matched.slice(offset, offset + limit)
        return { ok: true, value: { query, matched: matched.length, returned: page.length, offset, hasMore: offset + page.length < matched.length, vaultItems: BIG_COUNT, items: page } }
      },
    })
    const panel = await mountPanel(mod, bigDictionaries, bigRpc)
    const listCalls = () => bigRpc.calls.filter((call) => call.method === 'list')
    check('the first read asks for one small page', listCalls()[0]?.args.limit === 50 && listCalls()[0]?.args.offset === undefined, JSON.stringify(listCalls()[0]?.args))
    check('a large vault paints only the first page', optionRows(panel.renderer).length === 50, `rows=${optionRows(panel.renderer).length}`)
    check('the total still counts the whole vault', JSON.stringify(panel.renderer.toJSON()).includes(`共 ${BIG_COUNT} 条`))

    // Reaching the bottom asks for the next page and appends it.
    const scroller = () => panel.renderer.root.findByProps({ 'data-scroll-area': '' })
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush()
    const callsAfterScroll = listCalls()
    check('reaching the bottom reads the next page', callsAfterScroll.length === 2 && callsAfterScroll[1].args.limit === 50 && callsAfterScroll[1].args.offset === 50, JSON.stringify(callsAfterScroll[1]?.args))
    check('the next page is appended to the rows', optionRows(panel.renderer).length === 100, `rows=${optionRows(panel.renderer).length}`)
    check('the appended page does not ask for a page of its own', listCalls().length === 2, String(listCalls().length))

    // The end of the list is quiet: no control, no extra read.
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush()
    const tail = JSON.stringify(panel.renderer.toJSON())
    check('the third page completes the list', optionRows(panel.renderer).length === BIG_COUNT, `rows=${optionRows(panel.renderer).length}`)
    check('the completed list offers no more control', !tail.includes('还有') && !tail.includes('正在加载'), tail.slice(-160))
    check('no read is issued once the list is complete', listCalls().length === 3, String(listCalls().length))
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── outrun: a fast scroll gets the explicit control ───────────────────────
  // A flick through a large vault must not stack reads: the in-flight page is
  // awaited, and the reader gets the "还有 N 条" control instead.
  {
    let releasePage = null
    let listCallCount = 0
    const slowRpc = makeRpc({
      list: (args) => {
        listCallCount += 1
        const query = String(args.query ?? '')
        const matched = query ? BIG_ITEMS.filter((item) => item.name.includes(query)) : BIG_ITEMS
        const offset = Math.max(0, Number(args.offset) || 0)
        const limit = Math.max(1, Math.min(Number(args.limit) || 200, 200))
        const page = matched.slice(offset, offset + limit)
        const payload = { query, matched: matched.length, returned: page.length, offset, hasMore: offset + page.length < matched.length, vaultItems: BIG_COUNT, items: page }
        // The second page answers only when the test says so.
        if (listCallCount === 2) {
          return new Promise((resolve) => {
            releasePage = () => resolve({ ok: true, value: payload })
          })
        }
        return { ok: true, value: payload }
      },
    })
    const panel = await mountPanel(mod, {}, slowRpc)
    const scroller = () => panel.renderer.root.findByProps({ 'data-scroll-area': '' })
    check('the outrun fixture starts on the first page', optionRows(panel.renderer).length === 50, `rows=${optionRows(panel.renderer).length}`)

    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await act(async () => {
      await sleep(20)
    })
    // The page is still in flight; another bottom hit must not queue a read.
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush(20)
    check('a scroll during an in-flight page does not stack a read', listCallCount === 2, String(listCallCount))
    const waitingText = JSON.stringify(panel.renderer.toJSON())
    check('the outrun scroll reveals the explicit control', waitingText.includes('还有 80 条'), waitingText.slice(-160))

    await act(async () => {
      releasePage?.()
    })
    await flush()
    check('the in-flight page lands', optionRows(panel.renderer).length === 100, `rows=${optionRows(panel.renderer).length}`)
    // The control stays: it was raised before the page landed, and a reader
    // who kept scrolling is still at the bottom.
    check('the control stays for a reader who outran the page', JSON.stringify(panel.renderer.toJSON()).includes('还有 30 条'))
    const moreButton = () => panel.renderer.root.findAllByType('button').find((node) => node.props['data-load-more'] === '')
    await act(async () => {
      moreButton().props.onClick()
    })
    await flush()
    check('the control reads the rest of the list', optionRows(panel.renderer).length === BIG_COUNT, `rows=${optionRows(panel.renderer).length}`)
    check('the control disappears at the end', !JSON.stringify(panel.renderer.toJSON()).includes('还有'), '')
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── a host that predates paging refuses the extra field ───────────────────
  // A host from before paging declares `list(query, limit)` and nothing else.
  // The gateway matches the descriptor exactly, so a page read carrying
  // `offset` is rejected with `gateway/arguments-invalid` — it is never
  // silently ignored. The panel must treat that as "this host cannot page"
  // and read the rest of the vault in one call.
  {
    const legacyRpc = makeRpc({
      list: (args) => {
        if (args.offset !== undefined) {
          return { ok: false, error: { code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor: unexpected "offset"' } }
        }
        const limit = Math.max(1, Math.min(Number(args.limit) || 200, 200))
        const page = BIG_ITEMS.slice(0, limit)
        return { ok: true, value: { query: '', matched: BIG_COUNT, returned: page.length, vaultItems: BIG_COUNT, items: page } }
      },
    })
    const panel = await mountPanel(mod, {}, legacyRpc)
    const scroller = () => panel.renderer.root.findByProps({ 'data-scroll-area': '' })
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush()
    check('a refusing host still gets the whole vault', optionRows(panel.renderer).length === BIG_COUNT, `rows=${optionRows(panel.renderer).length}`)
    const legacyCalls = legacyRpc.calls.filter((call) => call.method === 'list')
    check('the page read is rejected, then the full read answers', legacyCalls.length === 3 && legacyCalls[0].args.offset === undefined && legacyCalls[1].args.offset === 50 && legacyCalls[2].args.limit === 200, JSON.stringify(legacyCalls.map((call) => call.args)))
    // The full read answers for the whole query, so the list is complete:
    // further scrolling must not start asking a paging-less host for pages.
    const afterFallback = legacyCalls.length
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush()
    check('the fallback marks the list complete', legacyRpc.calls.filter((call) => call.method === 'list').length === afterFallback, String(legacyRpc.calls.filter((call) => call.method === 'list').length))
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── a host that caps a full read cannot hide the rows it left behind ──────
  // `limit` is a ceiling, not a promise: a host clamps every read to 200
  // entries, so a 300-entry vault comes back short of its own `matched` count.
  // Such a host cannot page either, so the rows behind the ceiling are out of
  // reach from here: the list must admit the shortfall in place (a notice, not
  // a control that spins), and the next open must skip the page read the host
  // has already refused.
  {
    const HUGE_ITEMS = Array.from({ length: 300 }, (_, index) => ({
      ...BIG_ITEMS[0],
      id: `huge-${index + 1}`,
      name: `大库条目 ${String(index + 1).padStart(3, '0')}`,
      username: `huge${index + 1}@example.com`,
    }))
    const cappedRpc = makeRpc({
      list: (args) => {
        // The host the panel actually talks to here still refuses `offset`…
        if (args.offset !== undefined) {
          return { ok: false, error: { code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor: unexpected "offset"' } }
        }
        // …and serves at most 200 rows per call, however large the vault is,
        // so the first page is 50 rows and the one full read is 200 of 300.
        const limit = Math.max(1, Math.min(Number(args.limit) || 200, 200))
        const page = HUGE_ITEMS.slice(0, limit)
        return { ok: true, value: { query: '', matched: HUGE_ITEMS.length, returned: page.length, vaultItems: HUGE_ITEMS.length, items: page } }
      },
    })
    const panel = await mountPanel(mod, {}, cappedRpc)
    const scroller = () => panel.renderer.root.findByProps({ 'data-scroll-area': '' })
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush()
    check('a capped host shows every row it will serve', optionRows(panel.renderer).length === 200, `rows=${optionRows(panel.renderer).length}`)
    check('a capped list admits the rows it left behind', JSON.stringify(panel.renderer.toJSON()).includes('本机只同步到 200/300 条，其余 100 条请在 Bitwarden 网页端查看'), JSON.stringify(panel.renderer.toJSON()).slice(-220))
    const cappedMoreButton = () => panel.renderer.root.findAllByType('button').find((node) => node.props['data-load-more'] === '')
    check('a capped list does not offer a control that cannot work', !cappedMoreButton() && !JSON.stringify(panel.renderer.toJSON()).includes('点击继续显示'), '')
    // The ceiling is known now: another scroll must not send the host a page
    // read it has already refused twice, nor stack a second copy of the list.
    const callsAtCeiling = cappedRpc.calls.filter((call) => call.method === 'list').length
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush()
    check('a capped list is replaced, not duplicated', optionRows(panel.renderer).length === 200, `rows=${optionRows(panel.renderer).length}`)
    check('a host at its ceiling is not asked again', cappedRpc.calls.filter((call) => call.method === 'list').length === callsAtCeiling, String(cappedRpc.calls.filter((call) => call.method === 'list').length))
    await act(async () => {
      panel.renderer.unmount()
    })
    // The refusal is remembered for the session: the next open skips the page
    // this host cannot serve and asks straight for the whole vault.
    // `keepCache`: a real reopen keeps the module's own memory (the flag and
    // the snapshot) — only the renderer is rebuilt.
    const reopened = await mountPanel(mod, {}, cappedRpc, { keepCache: true })
    const reopenedCalls = cappedRpc.calls.filter((call) => call.method === 'list')
    check('the next open skips the page this host cannot serve', reopenedCalls.at(-1)?.args.limit === 200 && reopenedCalls.at(-1)?.args.offset === undefined, JSON.stringify(reopenedCalls.at(-1)?.args))
    check('the reopened list paints what the host will serve', optionRows(reopened.renderer).length === 200, `rows=${optionRows(reopened.renderer).length}`)
    check('the reopened list keeps the notice', JSON.stringify(reopened.renderer.toJSON()).includes('本机只同步到 200/300 条'), JSON.stringify(reopened.renderer.toJSON()).slice(-220))
    await act(async () => {
      reopened.renderer.unmount()
    })
  }

  // ── a page read that fails leaves the rows and offers the control ─────────
  {
    let failingCallCount = 0
    const flakyRpc = makeRpc({
      list: (args) => {
        failingCallCount += 1
        const query = String(args.query ?? '')
        const matched = query ? BIG_ITEMS.filter((item) => item.name.includes(query)) : BIG_ITEMS
        const offset = Math.max(0, Number(args.offset) || 0)
        const limit = Math.max(1, Math.min(Number(args.limit) || 200, 200))
        if (failingCallCount === 2) return { ok: false, error: { code: 'network_error', message: '网络中断' } }
        const page = matched.slice(offset, offset + limit)
        return { ok: true, value: { query, matched: matched.length, returned: page.length, offset, hasMore: offset + page.length < matched.length, vaultItems: BIG_COUNT, items: page } }
      },
    })
    const panel = await mountPanel(mod, {}, flakyRpc)
    const scroller = () => panel.renderer.root.findByProps({ 'data-scroll-area': '' })
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush()
    check('a failed page keeps the rows on screen', optionRows(panel.renderer).length === 50, `rows=${optionRows(panel.renderer).length}`)
    check('a failed page leaves an explicit control', JSON.stringify(panel.renderer.toJSON()).includes('还有 80 条'))
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── a scroll event without layout metrics is a no-op ──────────────────────
  // "I cannot tell where this container is" must not be read as "at the
  // bottom": that would let a measurement-less container drain the whole vault
  // one page at a time. Nothing happens until a measurable scroll arrives.
  {
    const bigPage = (args) => {
      const query = String(args.query ?? '')
      const matched = query ? BIG_ITEMS.filter((item) => item.name.includes(query)) : BIG_ITEMS
      const offset = Math.max(0, Number(args.offset) || 0)
      const limit = Math.max(1, Math.min(Number(args.limit) || 200, 200))
      const page = matched.slice(offset, offset + limit)
      return { ok: true, value: { query, matched: matched.length, returned: page.length, offset, hasMore: offset + page.length < matched.length, vaultItems: BIG_COUNT, items: page } }
    }
    const metricRpc = makeRpc({ list: bigPage })
    const panel = await mountPanel(mod, {}, metricRpc)
    const scroller = () => panel.renderer.root.findByProps({ 'data-scroll-area': '' })
    await act(async () => {
      scroller().props.onScroll({ currentTarget: noElement })
    })
    await flush()
    const metricCalls = metricRpc.calls.filter((call) => call.method === 'list').length
    check('a metric-less scroll reads nothing and leaves the panel mounted', optionRows(panel.renderer).length === 50 && metricCalls === 1 && Boolean(scroller()), `rows=${optionRows(panel.renderer).length} calls=${metricCalls}`)
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── a page served from where the host really is, not where it was ─────────
  // Rows arriving upstream between two reads shift every row the panel knows
  // further down: a page served from the offset the panel asked for carries
  // ids it has already seen. The repeats must not be drawn twice, and — since
  // the host reports the window it served — the next read must continue from
  // that window's end, not from a count of rows on screen. A count would say
  // 95 while the host's own edge is at 100; following the count would leave
  // the drift permanent and the tail of the vault unreachable.
  {
    const DRIFT = 5
    let listCallCount = 0
    const driftingRpc = makeRpc({
      list: (args) => {
        listCallCount += 1
        const offset = Math.max(0, Number(args.offset) || 0)
        // After the first page, five rows have arrived upstream, so every id
        // the panel knows sits five positions further down.
        const shift = listCallCount === 1 ? 0 : DRIFT
        const from = Math.max(0, offset - shift)
        const items = BIG_ITEMS.slice(from, from + 50)
        const end = offset + items.length
        return { ok: true, value: { query: '', matched: BIG_COUNT, returned: items.length, offset, hasMore: end < BIG_COUNT, vaultItems: BIG_COUNT, items } }
      },
    })
    const panel = await mountPanel(mod, {}, driftingRpc)
    const scroller = () => panel.renderer.root.findByProps({ 'data-scroll-area': '' })
    const listCalls = () => driftingRpc.calls.filter((call) => call.method === 'list')
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush()
    check('rows the panel already had are not drawn twice', optionRows(panel.renderer).length === 95, `rows=${optionRows(panel.renderer).length}`)
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush()
    // Page two was served from 50 and carried 50 rows, so the host's answer
    // ends at 100: that is where page three must start.
    check('the next read starts where the host said its page ended', listCalls()[2]?.args.offset === 100, JSON.stringify(listCalls().map((call) => call.args)))
    check('drift does not trigger a full re-read', !listCalls().some((call) => call.args.limit === 200), JSON.stringify(listCalls().map((call) => call.args)))
    check('the drifted list still completes', optionRows(panel.renderer).length === BIG_COUNT, `rows=${optionRows(panel.renderer).length}`)
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush()
    check('a completed drifted list stops reading', listCalls().length === 3, String(listCalls().length))
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── a page from an abandoned list cannot leak into the new one ────────────
  // Typing while a page is on its way starts a fresh read for the new query.
  // The page that lands late belongs to the list that no longer exists: it
  // must be dropped, and it must not move the paging cursor of the new list.
  {
    let releaseOldPage = null
    let listCallCount = 0
    const raceRpc = makeRpc({
      list: (args) => {
        listCallCount += 1
        const query = String(args.query ?? '')
        const matched = query ? BIG_ITEMS.filter((item) => `${item.name}${item.username ?? ''}`.includes(query)) : BIG_ITEMS
        const offset = Math.max(0, Number(args.offset) || 0)
        const page = matched.slice(offset, offset + 50)
        const payload = { query, matched: matched.length, returned: page.length, offset, hasMore: offset + page.length < matched.length, vaultItems: BIG_COUNT, items: page }
        // The second read is the page a fast typist outruns: it answers only
        // when the test says so.
        if (listCallCount === 2) {
          return new Promise((resolve) => {
            releaseOldPage = () => resolve({ ok: true, value: payload })
          })
        }
        return { ok: true, value: payload }
      },
    })
    const panel = await mountPanel(mod, {}, raceRpc)
    const scroller = () => panel.renderer.root.findByProps({ 'data-scroll-area': '' })
    const searchBox = () => panel.renderer.root.findAllByType('input').find((node) => node.props.type === 'search')
    // The next page goes in flight...
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await act(async () => {
      await sleep(20)
    })
    check('the outrun page is in flight', typeof releaseOldPage === 'function')
    // ...and the reader types a new query before it lands.
    await act(async () => {
      searchBox().props.onChange({ target: { value: 'user' } })
    })
    await act(async () => {
      await sleep(350)
    })
    check('the new query paints its own first page', optionRows(panel.renderer).length === 50, `rows=${optionRows(panel.renderer).length}`)
    // The abandoned page lands late.
    await act(async () => {
      releaseOldPage?.()
    })
    await flush()
    check('a page from an abandoned list is dropped', optionRows(panel.renderer).length === 50, `rows=${optionRows(panel.renderer).length}`)
    check('the abandoned page leaks no rows', !JSON.stringify(panel.renderer.toJSON()).includes('条目 051'), '')
    // The cursor of the new list is where its own first page ended (50), not
    // wherever the abandoned page was reading.
    await act(async () => {
      scroller().props.onScroll({ currentTarget: atBottom })
    })
    await flush()
    const pageCalls = raceRpc.calls.filter((call) => call.method === 'list')
    check('the search read carries the new query', pageCalls[2]?.args.query === 'user', JSON.stringify(pageCalls[2]?.args))
    check('the new list keeps reading from its own cursor', pageCalls[3]?.args.offset === 50, JSON.stringify(pageCalls.map((call) => call.args)))
    check('the new list continues to its second page', optionRows(panel.renderer).length === 100, `rows=${optionRows(panel.renderer).length}`)
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── not configured → guided setup form ────────────────────────────────────
  // The panel chooses the setup form from the configuration state (not from an
  // error code, which does not survive the RPC boundary).
  const unconfiguredConfig = { ok: true, value: { serverUrl: '', email: '', hasMasterPassword: false, hasApiKey: false, websocket: true, pollIntervalSeconds: 60, cacheMinutes: 30, accessMode: 'readonly' } }
  const notConfiguredError = { ok: false, error: { code: 'not_configured', message: '凭据库尚未配置完整' } }
  const setupRpc = makeRpc({ boot: () => bootWith(unconfiguredConfig.value, false), list: () => notConfiguredError, status: () => notConfiguredError })
  const unconfigured = await mountPanel(mod, {}, setupRpc)
  const setupText = JSON.stringify(unconfigured.renderer.toJSON())
  check('unconfigured state offers the guided setup form', setupText.includes('连接 Vaultwarden') && setupText.includes('服务器地址'))
  const setupInputs = () => unconfigured.renderer.root.findAllByType('input')
  check('setup form renders three inputs (server/email/master)', setupInputs().length === 3, `inputs=${setupInputs().length}`)
  await act(async () => {
    setupInputs()[0].props.onChange({ target: { value: 'https://vault.example.com' } })
  })
  check('setup server field accepts the address', setupInputs()[0].props.value === 'https://vault.example.com')
  check('setup master password starts empty and is a password field', setupInputs()[2].props.type === 'password' && setupInputs()[2].props.value === '')
  const setupSave = () => unconfigured.renderer.root.findAllByType('button').find((node) => node.props.children === '保存并连接')
  await act(async () => {
    setupInputs()[1].props.onChange({ target: { value: 'me@example.com' } })
  })
  // Nothing is stored yet, so the master password is still required: the vault
  // cannot be decrypted without it.
  check('setup save waits for the first master password', setupSave().props.disabled === true)
  await act(async () => {
    setupInputs()[2].props.onChange({ target: { value: 'master-pass-123' } })
  })
  check('setup save enables once server + email + password are filled', setupSave().props.disabled === false)
  await act(async () => {
    setupSave().props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  const configureCall = setupRpc.calls.find((call) => call.method === 'configure')
  check('setup writes through vw/configure', Boolean(configureCall) && configureCall.args.serverUrl === 'https://vault.example.com' && configureCall.args.masterPassword === 'master-pass-123', JSON.stringify(configureCall?.args))
  await act(async () => {
    unconfigured.renderer.unmount()
  })

  // ── API key method in the UI ──────────────────────────────────────────────
  // The API key lives on the same form as the password, behind a method select:
  // it must be reachable from the panel, not only from the host's plugin config.
  {
    const apiConfig = { ok: true, value: { serverUrl: 'https://vault.example.com', email: 'me@example.com', hasMasterPassword: true, hasApiKey: false, apiKeyClientId: '' } }
    const rpc = makeRpc({ boot: () => bootWith(apiConfig.value, false, SIGNED_OUT_SESSION) })
    const panel = await mountPanel(mod, {}, rpc)
    const text = () => JSON.stringify(panel.renderer.toJSON())
    check('the sign-in form offers a method selector', text().includes('登录方式') && text().includes('API 密钥'))
    const selects = () => panel.renderer.root.findAllByType('select')
    check('the method selector lists both sign-in methods', selects().length >= 1 && String(selects()[0].props.children?.length ?? 0) >= 2, `selects=${selects().length}`)

    // Switching to API key reveals its two fields.
    await act(async () => {
      selects()[0].props.onChange({ target: { value: 'apikey' } })
    })
    const inputs = () => panel.renderer.root.findAllByType('input')
    const ids = inputs().map((node) => String(node.props.value ?? ''))
    check('choosing API key reveals its two fields', text().includes('client_id') && text().includes('client_secret'), ids.join('|'))
    check('the API key secret is a password field', inputs().some((node) => node.props.type === 'password' && /secret|密钥/i.test(String(node.props.placeholder ?? ''))))

    // Submitting sends the key through vw/connect.
    const idInput = inputs().find((node) => /user\./.test(String(node.props.placeholder ?? '')))
    const secretInput = inputs().find((node) => node.props.type === 'password' && /secret|密钥/i.test(String(node.props.placeholder ?? '')))
    await act(async () => {
      idInput.props.onChange({ target: { value: 'user.11111111-1111-1111-1111-111111111111' } })
    })
    await act(async () => {
      secretInput.props.onChange({ target: { value: 'secret-value' } })
    })
    await act(async () => {
      panel.renderer.root.findAllByType('button').find((node) => node.props.children === '验证并登录').props.onClick()
    })
    await act(async () => {
      await sleep(50)
    })
    const connectCall = rpc.calls.find((call) => call.method === 'connect')
    check('the API key is submitted through vw/connect', connectCall?.args.apiKeyClientId === 'user.11111111-1111-1111-1111-111111111111' && connectCall?.args.apiKeyClientSecret === 'secret-value', JSON.stringify({ ...connectCall?.args, apiKeyClientSecret: connectCall?.args?.apiKeyClientSecret ? '<set>' : undefined }))
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── two-factor challenge ──────────────────────────────────────────────────
  const twoFactorError = { ok: false, error: { code: 'two_factor_required', message: '该账户启用了两步验证，需要验证码' } }
  const twoFactorRpc = makeRpc({ list: () => twoFactorError, status: () => twoFactorError })
  const challenged = await mountPanel(mod, {}, twoFactorRpc)
  const twoFactorText = JSON.stringify(challenged.renderer.toJSON())
  check('two-factor challenge asks for a code instead of dead-ending', twoFactorText.includes('需要两步验证码'))
  const codeInput = () => challenged.renderer.root.findAllByType('input').find((node) => node.props.autoComplete === 'one-time-code')
  check('two-factor form exposes a one-time-code input', Boolean(codeInput()))
  const submitCode = () => challenged.renderer.root.findAllByType('button').find((node) => node.props.children === '提交验证码')
  check('two-factor submit is disabled until a code is typed', submitCode().props.disabled === true)
  await act(async () => {
    codeInput().props.onChange({ target: { value: '123456' } })
  })
  await act(async () => {
    submitCode().props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  const twoFactorCall = twoFactorRpc.calls.find((call) => call.method === 'submitTwoFactor')
  check('two-factor code is submitted through vw/submitTwoFactor', Boolean(twoFactorCall) && twoFactorCall.args.code === '123456', JSON.stringify(twoFactorCall?.args))
  // No continuation token exists in the protocol: the code alone finishes it.
  check('the code is submitted without a continuation token', twoFactorCall?.args.token === undefined, JSON.stringify(twoFactorCall?.args))
  // A rejected code must keep the user on THIS screen so they can retry.
  const failingRpc = makeRpc({
    list: () => twoFactorError,
    status: () => twoFactorError,
    submitTwoFactor: () => ({ ok: false, error: { code: 'bad_request', message: '两步验证码不正确' } }),
  })
  const retryable = await mountPanel(mod, {}, failingRpc)
  const retryInput = () => retryable.renderer.root.findAllByType('input').find((node) => node.props.autoComplete === 'one-time-code')
  const retrySubmit = () => retryable.renderer.root.findAllByType('button').find((node) => node.props.children === '提交验证码')
  await act(async () => {
    retryInput().props.onChange({ target: { value: '000000' } })
  })
  await act(async () => {
    retrySubmit().props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  const retryText = JSON.stringify(retryable.renderer.toJSON())
  check('a rejected code reports the error inline', retryText.includes('两步验证码不正确'))
  check('a rejected code stays on the two-factor screen', retryText.includes('需要两步验证码') && !retryText.includes('连接 Vaultwarden'))
  check('a rejected code does not clear the session', !failingRpc.calls.some((call) => call.method === 'reset'))
  await act(async () => {
    retryable.renderer.unmount()
  })

  // The deliberate way back still works: it clears the session and opens the form.
  const restartButton = () => challenged.renderer.root.findAllByType('button').find((node) => node.props.children === '返回设置，重新填写')
  check('two-factor form offers a restart escape hatch', Boolean(restartButton()))
  await act(async () => {
    restartButton().props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  check('restart clears the host session through vw/reset', twoFactorRpc.calls.some((call) => call.method === 'reset'))
  check('restart opens the setup form (back to the previous level)', JSON.stringify(challenged.renderer.toJSON()).includes('连接 Vaultwarden'))
  await act(async () => {
    challenged.renderer.unmount()
  })

  // Leaving the view (switching settings pages / closing the dialog) must
  // deactivate the half-finished sign-in so the next visit starts fresh.
  const leavingRpc = makeRpc({ list: () => twoFactorError, status: () => twoFactorError })
  const leaving = await mountPanel(mod, {}, leavingRpc)
  const resetsBeforeUnmount = leavingRpc.calls.filter((call) => call.method === 'discardChallenge').length
  await act(async () => {
    leaving.renderer.unmount()
  })
  await act(async () => {
    await sleep(50)
  })
  const resetsAfterUnmount = leavingRpc.calls.filter((call) => call.method === 'discardChallenge').length
  check('unmounting the panel discards the pending challenge', resetsAfterUnmount > resetsBeforeUnmount, `${resetsBeforeUnmount}→${resetsAfterUnmount}`)

  // A hard failure keeps a way back too (wrong password, expired challenge…).
  const hardFailError = { ok: false, error: { code: 'bad_credentials', message: '登录失败：邮箱或主密码不正确' } }
  const hardFail = await mountPanel(mod, {}, makeRpc({ boot: () => bootWith({ serverUrl: 'https://vault.example.com', email: 'me@example.com', hasMasterPassword: true, hasApiKey: false }, true), list: () => hardFailError, status: () => hardFailError }))
  const hardFailText = JSON.stringify(hardFail.renderer.toJSON())
  check('a failed login explains the failure', hardFailText.includes('登录失败'))
  check('a failed login still offers a way back', hardFailText.includes('返回设置，重新填写'))
  await act(async () => {
    hardFail.renderer.unmount()
  })

  // ── an older host must not dead-end the panel either ──────────────────────
  // `vw/boot` arrived in v0.2.5. A page bundle from that release can briefly
  // talk to a host half from before it (stale page after an upgrade), and an
  // unknown method would otherwise render "尚未配置完成" on a fully configured
  // vault. The old config + session pair is the fallback.
  {
    // The code the gateway really raises for a host that has no `vw/boot`
    // (dsh-api-gateway: "no active Remote method exports this endpoint").
    const unknownMethod = { ok: false, error: { code: 'gateway/invocation-unavailable', message: 'no active Remote method exports this endpoint' } }
    const rpc = makeRpc({
      boot: () => unknownMethod,
      config: () => ({ ok: true, value: CONFIG_VALUE }),
      session: () => ({ ok: true, value: AUTHED_SESSION }),
      // The list payload the default route builds; spelled out so this
      // scenario does not depend on the default list filter. No `hasMore`,
      // like a host that predates paging.
      list: () => ({ ok: true, value: { query: '', matched: ITEM_COUNT, returned: ITEM_COUNT, vaultItems: ITEM_COUNT, items: ITEMS } }),
      status: () => ({ ok: true, value: STATUS_REPORT }),
    })
    const panel = await mountPanel(mod, {}, rpc)
    const legacyText = JSON.stringify(panel.renderer.toJSON())
    check('a host without vw/boot still opens the list', legacyText.includes('实时同步') && !legacyText.includes('尚未配置完成'))
    check('a host without vw/boot is never asked to log in', rpc.calls.filter((call) => call.method === 'connect').length === 0)
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── a host that HAS vw/boot and rejected it must not be read as an old one ─
  // "Missing method" is the only failure a fallback may act on. A gateway that
  // answered and refused (argument shape, permission, an error thrown inside
  // boot) has to reach the screen, or a real failure would be hidden behind a
  // silent fallback that changes what the panel shows.
  {
    const rejected = { ok: false, error: { code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor: unexpected "boot"' } }
    const rpc = makeRpc({ boot: () => rejected })
    const panel = await mountPanel(mod, {}, rpc)
    const rejectedText = JSON.stringify(panel.renderer.toJSON())
    check('a rejected vw/boot is reported, not read as an old host', rejectedText.includes('args fields do not match the descriptor'), rejectedText.slice(-220))
    check('a rejected vw/boot never falls back to the pre-boot pair', rpc.calls.filter((call) => call.method === 'config' || call.method === 'session').length === 0)
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── a failing config RPC must not dead-end the panel ─────────────────────
  // The reported bug rendered "尚未配置完成" + 重试 when `config` rejected, and
  // 重试 re-ran the same failing call forever — the guided setup form, which is
  // the only way out, sat unreachable behind it. Whatever makes `config` fail,
  // the form has to stay on screen.
  {
    const failingConfig = { ok: false, error: { code: 'not_configured', message: '未配置 Vaultwarden 服务器地址' } }
    const rpc = makeRpc({ boot: () => failingConfig, list: () => failingConfig, status: () => failingConfig })
    const panel = await mountPanel(mod, {}, rpc)
    const failureText = JSON.stringify(panel.renderer.toJSON())
    check('a failing config RPC still offers the guided setup form', failureText.includes('连接 Vaultwarden') && failureText.includes('服务器地址'))
    check('a failing config RPC does not render the dead end', !failureText.includes('尚未配置完成'))
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── reopen performance: a second open must not re-fetch everything ────────
  // The host unmounts the panel when the dialog closes, so reopening used to
  // re-run config + session + list + a status probe. A recent read is now
  // painted from a module-level cache and refreshed behind it.
  {
    const cfg = { ok: true, value: { serverUrl: 'https://vault.example.com', email: 'me@example.com', hasMasterPassword: true, hasApiKey: false } }
    const live = { ok: true, value: { configured: true, authenticated: true, pendingTwoFactor: false, unlocked: true } }
    const rpc = makeRpc({ boot: () => bootWith(cfg.value, true, live.value) })
    const first = await mountPanel(mod, {}, rpc)
    await act(async () => {
      await sleep(60)
    })
    const firstCalls = rpc.calls.length
    await act(async () => {
      first.renderer.unmount()
    })

    // Reopen without resetting the cache: the list must be painted from it.
    const before = rpc.calls.filter((call) => call.method === 'list').length
    const second = await mountPanel(mod, {}, rpc, { keepCache: true })
    await act(async () => {
      await sleep(20)
    })
    // The cached view is on screen before the refresh resolves.
    check('a reopen paints the cached list immediately', JSON.stringify(second.renderer.toJSON()).includes('GitHub 工作账号'), `pre-refresh`)
    check('the first open did real work (baseline)', before >= 1 && firstCalls > 0, `${before}/${firstCalls}`)
    await act(async () => {
      await sleep(120)
    })
    const after = rpc.calls.filter((call) => call.method === 'list').length
    check('the reopen still refreshes in the background', after > before, `list calls ${before}→${after}`)
    await act(async () => {
      second.renderer.unmount()
    })
  }

  // ── reload: the snapshot outlives the module scope ───────────────────────
  // Closing the settings dialog unmounts the panel, and the host shell
  // re-evaluates the bundle on the next open, so the module-level cache is
  // gone by then. The last read is therefore also kept in localStorage.
  {
    // A freshly loaded bundle: its module scope is empty, exactly like a
    // page reload. (keepCache only suppresses the test hook that wipes the
    // shared storage, so the earlier read is still there to paint.)
    const { mod: reloaded } = loadModule()
    let releaseBoot = null
    const slowBoot = makeRpc({
      boot: () => new Promise((resolve) => { releaseBoot = () => resolve(bootWith(CONFIG_VALUE, true, AUTHED_SESSION)) }),
    })
    const panel = await mountPanel(reloaded, {}, slowBoot, { keepCache: true })
    const painted = JSON.stringify(panel.renderer.toJSON())
    check('a reload paints the stored list before the host answers', painted.includes('GitHub 工作账号'), painted.slice(0, 120))
    check('the reload does not wait for the host to draw', slowBoot.calls.length === 1, JSON.stringify(slowBoot.calls.map((call) => call.method)))
    await act(async () => {
      releaseBoot?.()
    })
    await act(async () => {
      await sleep(60)
    })
    check('the stored list is refreshed once the host answers', JSON.stringify(panel.renderer.toJSON()).includes('GitHub 工作账号'))
    check('the refreshed read is stored again', storageMock.store.has(SNAPSHOT_KEY))
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── a signed-out reload must not show the stored entries ─────────────────
  // Painting first is only safe because the snapshot is dropped the moment
  // the host says there is no session: otherwise a signed-out panel — or one
  // belonging to another account — would still greet the reader with rows.
  {
    const { mod: reloaded } = loadModule()
    const dropped = makeRpc({ boot: () => bootWith(CONFIG_VALUE, false, SIGNED_OUT_SESSION) })
    const panel = await mountPanel(reloaded, {}, dropped, { keepCache: true })
    const text = JSON.stringify(panel.renderer.toJSON())
    check('a reload without a session shows the sign-in form only', text.includes('登录 Vaultwarden') && !text.includes('实时同步'), text.slice(0, 120))
    check('the stored snapshot is erased', storageMock.store.size === 0, String(Array.from(storageMock.store.keys())))
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── sign-in flow: credentials first, code screen only after they verify ────
  const signedOutConfig = { ok: true, value: { serverUrl: 'https://vault.example.com', email: 'me@example.com', hasMasterPassword: true, hasApiKey: false } }
  const signedOut = { ok: true, value: { configured: true, authenticated: false, pendingTwoFactor: false, unlocked: false } }
  const twoFactorChallenge = { ok: true, value: { ok: true, authenticated: false, twoFactor: true, providers: [0], provider: 0, providerDescriptions: null } }

  // Opening with credentials stored but no session must ask to sign in — NOT
  // jump straight to the code screen (the reported bug).
  const signInRpc = makeRpc({ boot: () => bootWith(signedOutConfig.value, false, signedOut.value) })
  const signedOutPanel = await mountPanel(mod, {}, signInRpc)
  const signInText = JSON.stringify(signedOutPanel.renderer.toJSON())
  check('a stored credential set lands on the sign-in form, not the code screen', signInText.includes('登录 Vaultwarden') && !signInText.includes('需要两步验证码'))
  check('opening the panel does not auto-login', !signInRpc.calls.some((call) => call.method === 'list'))

  // Submitting credentials that need 2FA advances to the code screen.
  const connectRpc = makeRpc({
    boot: () => bootWith(signedOutConfig.value, false, signedOut.value),
    connect: () => twoFactorChallenge,
  })
  const connecting = await mountPanel(mod, {}, connectRpc)
  const pw = () => connecting.renderer.root.findAllByType('input').find((node) => node.props.type === 'password')
  await act(async () => {
    pw().props.onChange({ target: { value: 'master-pass-123' } })
  })
  await act(async () => {
    connecting.renderer.root.findAllByType('button').find((node) => node.props.children === '验证并登录').props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  const connectCall = connectRpc.calls.find((call) => call.method === 'connect')
  check('submitting verifies the credentials through vw/connect', Boolean(connectCall) && connectCall.args.masterPassword === 'master-pass-123', JSON.stringify(connectCall?.args))
  check('the code screen appears only after the credentials verify', JSON.stringify(connecting.renderer.toJSON()).includes('需要两步验证码'))
  await act(async () => {
    connecting.renderer.unmount()
  })

  // A rejected password must stay on the sign-in form and say so.
  const badPasswordRpc = makeRpc({
    boot: () => bootWith(signedOutConfig.value, false, signedOut.value),
    connect: () => ({ ok: false, error: { code: 'bad_credentials', message: '邮箱或主密码不正确' } }),
  })
  const badPassword = await mountPanel(mod, {}, badPasswordRpc)
  await act(async () => {
    badPassword.renderer.root.findAllByType('input').find((node) => node.props.type === 'password').props.onChange({ target: { value: 'wrong' } })
  })
  await act(async () => {
    badPassword.renderer.root.findAllByType('button').find((node) => node.props.children === '验证并登录').props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  const badText = JSON.stringify(badPassword.renderer.toJSON())
  check('a wrong password is reported on the sign-in form', badText.includes('邮箱或主密码不正确') && badText.includes('登录 Vaultwarden'))
  check('a wrong password never reaches the code screen', !badText.includes('需要两步验证码'))
  await act(async () => {
    badPassword.renderer.unmount()
  })

  // ── a late unlock answer must not land on another entry ───────────────────
  // Reported: select a reprompt entry, unlock it, then move to a different
  // entry before the host answers. The late answer painted the first entry's
  // plaintext password into the second entry's pane and left the reveal flag
  // set, so that second entry's own password would show the moment it loaded.
  {
    let releaseConfirm = null
    const raceRpc = makeRpc({
      reveal: (args) => {
        if (args.id === 'item-4') {
          return { ok: true, value: { id: 'item-4', name: '10.0.0.10', type: 'login', username: 'demo-user', password: 'demo-pass-4', uris: [], fields: [] } }
        }
        return { ok: true, value: REVEALS[args.id] ?? { error: 'not_found' } }
      },
      authorizeReprompt: () =>
        new Promise((resolve) => {
          releaseConfirm = () => resolve({ ok: true, value: { authorized: true, remainingMs: 300000, grantMinutes: 5, view: CONFIRMED_REVEAL } })
        }),
    })
    const race = await mountPanel(mod, {}, raceRpc)
    const raceText = () => JSON.stringify(race.renderer.toJSON())
    const raceButtons = () => race.renderer.root.findAllByType('button')
    const raceRows = () => raceButtons().filter((node) => node.props.role === 'option')
    const raceInputs = () => race.renderer.root.findAllByType('input')
    const raceSearch = () => raceInputs().find((node) => node.props.type === 'search')
    await act(async () => {
      raceRows()[2].props.onClick()
    })
    await flush()
    check('race setup: the reprompt entry is gated', raceText().includes('重新验证') && !raceText().includes('reprompt-pass-9'))
    await act(async () => {
      raceInputs().find((node) => node.props.type === 'password').props.onInput({ target: { value: 'correct horse battery staple' } })
    })
    await act(async () => {
      raceButtons().find((node) => node.props.children === '输入主密码解锁').props.onClick()
    })
    await flush()
    check('race setup: the unlock is in flight', typeof releaseConfirm === 'function')
    // The toolbar stays mounted while the detail pane loads, so the keyboard
    // shortcut moves the selection without a trip through the list.
    check('race setup: the search box is still mounted', Boolean(raceSearch()))
    await act(async () => {
      raceSearch().props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })
    })
    await flush()
    check('race setup: the next entry is on screen', raceText().includes('demo-user'))
    await act(async () => {
      releaseConfirm()
    })
    await flush()
    check("a late confirm answer never paints the other entry's password", !raceText().includes('reprompt-pass-9'), raceText().slice(-240))
    check('a late confirm answer does not leave the reveal flag set', !raceText().includes('demo-pass-4'), raceText().slice(-240))
    check('the entry on screen keeps its own detail', raceText().includes('demo-user'))
    await act(async () => {
      race.renderer.unmount()
    })
  }

  // ── an answer for an abandoned query must not replace the current list ────
  // Reported: a read for one query came back after a read for another, and the
  // older rows won — they replaced what the reader had asked for, and the first
  // page of the older list was written to the snapshot as well.
  {
    const base = makeRpc()
    const originalCall = base.call
    let releaseSlow = null
    base.call = async (channel, endpoint, payload) => {
      const method = String(endpoint).replace(/^vw\//, '')
      if (method === 'list' && String(payload?.args?.query ?? '') === '') {
        return new Promise((resolve) => {
          releaseSlow = () => resolve({
            ok: true,
            value: {
              query: '',
              matched: 1,
              returned: 1,
              offset: 0,
              hasMore: false,
              vaultItems: 1,
              items: [{ id: 'stale-1', name: 'STALE-ROW', type: 'login', username: 'stale@example.com', uris: [], folder: null, collections: [], hasTotp: false, hasNotes: false, customFields: [], favorite: false }],
            },
          })
        })
      }
      return originalCall(channel, endpoint, payload)
    }
    // A first open fills the snapshot that the reopen paints from, so the panel
    // is interactive while its background read is still in flight.
    const warm = await mountPanel(mod, {}, makeRpc())
    await flush()
    await act(async () => {
      warm.renderer.unmount()
    })
    const panel = await mountPanel(mod, {}, base, { keepCache: true })
    await flush()
    const panelText = () => JSON.stringify(panel.renderer.toJSON())
    const search = () => panel.renderer.root.findAllByType('input').find((node) => node.props.type === 'search')
    check('race setup: the cached list is painted before the host answers', panelText().includes('GitHub 工作账号'))
    check('race setup: the background read is in flight', typeof releaseSlow === 'function')
    await act(async () => {
      search().props.onChange({ target: { value: '数据库' } })
    })
    await flush(350)
    check('race setup: the newer query painted its rows', panelText().includes('生产数据库口令'))
    await act(async () => {
      releaseSlow()
    })
    await flush()
    check('a stale list answer never replaces the newer query', !panelText().includes('STALE-ROW'), panelText().slice(-240))
    check('the newer query keeps its rows', panelText().includes('生产数据库口令'))
    const stored = String(storageMock.store.get(SNAPSHOT_KEY) ?? '')
    check('a stale first page is not stored as the snapshot', !stored.includes('STALE-ROW'))
    await act(async () => {
      panel.renderer.unmount()
    })
  }

  // ── no matches ────────────────────────────────────────────────────────────
  const empty = await mountPanel(mod, {}, makeRpc({ list: () => ({ ok: true, value: { query: 'zzz', matched: 0, returned: 0, vaultItems: ITEM_COUNT, items: [] } }) }))
  check('no-match list renders an actionable empty state', JSON.stringify(empty.renderer.toJSON()).includes('没有匹配的条目'))
  await act(async () => {
    empty.renderer.unmount()
  })

  // ── missing connection ────────────────────────────────────────────────────
  const noConn = await mountPanel(mod, {}, undefined)
  check('missing connection degrades to an inline error, not a crash', JSON.stringify(noConn.renderer.toJSON()).includes('连接通道不可用'))
  await act(async () => {
    noConn.renderer.unmount()
  })

  // ── the sidebar: one place at a time, counted by the host ─────────────────
  // v0.6.0 replaced the flat filter row (trash chip, folder and archive
  // selects) with a Bitwarden-App-style menu. A row is a place, not a
  // refinement: stepping into one reads that place's pool on the host, so the
  // badge and the list under it are the same number. That is also what lets a
  // place be a cache entry instead of a fresh query every visit.
  {
    const navRpc = makeRpc()
    const baseCall = navRpc.call
    const listArgs = []
    navRpc.call = async (channel, endpoint, payload) => {
      if (String(endpoint).replace(/^vw\//, '') === 'list') listArgs.push(payload?.args ?? {})
      return baseCall(channel, endpoint, payload)
    }
    const panel = await mountPanel(mod, {}, navRpc)
    const nodeWith = (key, value = '') => panel.renderer.root.findAll((node) => node.props?.[key] === value)
    const navRows = () => panel.renderer.root.findAll((node) => node.props && node.props['data-vw-section'] !== undefined)
    const navRow = (key) => navRows().find((node) => node.props['data-vw-section'] === key)
    const navKeys = () => navRows().map((node) => node.props['data-vw-section'])
    const navCount = (key) => String(navRow(key).props.children[2]?.props?.children)
    const nRows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')
    const nText = () => JSON.stringify(panel.renderer.toJSON())

    check('the sidebar is a landmark, not a list', nodeWith('data-vw-nav').length === 1 && nodeWith('data-vw-nav')[0].props['aria-label'] === '凭据库分区')
    check(
      'the sidebar offers every place the host counted',
      navKeys().join(',') === 'all,favorites,totp,type:login,type:secureNote,folder:folder-work,unfiled,archive,trash',
      navKeys().join(','),
    )
    check(
      'each place carries the host count',
      navCount('all') === '4' && navCount('favorites') === '1' && navCount('type:login') === '3' && navCount('folder:folder-work') === '1' && navCount('trash') === '0',
      navKeys().map((key) => key + ':' + navCount(key)).join(','),
    )
    const groupHeads = () => panel.renderer.root.findAll((node) => node.props && node.props['data-vw-nav-group'] !== undefined)
    check(
      'the two groups are headed and counted',
      groupHeads().map((node) => String(node.props.children)).join('|') === '类型 (2)|文件夹 (1)',
      groupHeads().map((node) => String(node.props.children)).join('|'),
    )
    check('the place on screen is marked current', navRow('all').props['aria-current'] === 'true' && navRow('totp').props['aria-current'] === undefined)
    check('the sidebar rows are not entry rows', navKeys().every((key) => navRow(key).props.role === undefined))
    // The rail draws its marks now: one 16x16 SVG per row instead of a text
    // glyph whose optical size depended on the host's font. The count stays the
    // bare number — the chip is the style around it, never part of its text.
    const navIcons = () => panel.renderer.root.findAll((node) => node.props && node.props['data-vw-section-icon'] !== undefined)
    check('every place draws its own icon', navIcons().length === navKeys().length && navIcons().every((node) => String(node.props['data-vw-section-icon']).length > 0), JSON.stringify(navIcons().map((node) => node.props['data-vw-section-icon'])))
    check(
      'the icons are drawn, not typed: one svg per row',
      navIcons().every((node) => node.children?.[0]?.type === 'svg' && node.children[0].props.viewBox === '0 0 16 16'),
      JSON.stringify(navIcons().map((node) => node.children?.[0]?.type)),
    )
    check('the icons are decoration', navIcons().every((node) => node.children[0].props['aria-hidden'] === 'true'))
    const countChips = () => panel.renderer.root.findAll((node) => node.props && node.props['data-vw-section-count'] !== undefined)
    check(
      'a count chip keeps the bare number inside its own box',
      countChips().length === navKeys().length && countChips().every((node) => /^\d+$/.test(String(node.props.children)) && node.props.style.minWidth >= 22),
      JSON.stringify(countChips().map((node) => String(node.props.children))),
    )
    check(
      'the chip follows its row: the place in view inverts it',
      navRow('all').props.children[2].props.style.background !== navRow('totp').props.children[2].props.style.background,
      JSON.stringify([navRow('all').props.children[2].props.style.background, navRow('totp').props.children[2].props.style.background]),
    )

    await act(async () => { navRow('type:login').props.onClick() })
    await flush(120)
    check('stepping into a place reads that place on the host', listArgs.at(-1)?.section === 'type' && listArgs.at(-1)?.sectionValue === 'login', JSON.stringify(listArgs.at(-1)))
    check('a place never drags in archived or deleted rows', listArgs.at(-1)?.includeArchived === false && listArgs.at(-1)?.includeTrashed === false, JSON.stringify(listArgs.at(-1)))
    check('the list shows that place and nothing else', nRows().length === 3 && !nText().includes('生产数据库口令'), 'rows=' + nRows().length)
    check('the place just entered becomes the current one', navRow('type:login').props['aria-current'] === 'true' && navRow('all').props['aria-current'] === undefined)

    await act(async () => { navRow('trash').props.onClick() })
    await flush(120)
    check('the trash place asks the host for the deleted half', listArgs.at(-1)?.section === 'trash' && listArgs.at(-1)?.includeTrashed === true, JSON.stringify(listArgs.at(-1)))
    check('an empty trash says which emptiness it is', nRows().length === 0 && nText().includes('回收站是空的'), 'rows=' + nRows().length)

    // The whole point of the menu: a place the reader just left is still on
    // screen. Nothing is asked again — not the list, not the boot.
    const readsBefore = listArgs.length
    await act(async () => { navRow('type:login').props.onClick() })
    await flush(120)
    check('stepping back into a place just left asks the host nothing', listArgs.length === readsBefore, readsBefore + ' → ' + listArgs.length)
    check('the cached rows paint straight away', nRows().length === 3 && !nText().includes('生产数据库口令'), 'rows=' + nRows().length)

    await act(async () => { navRow('type:login').props.onClick() })
    await flush(120)
    check('clicking the place already open changes nothing', listArgs.length === readsBefore)

    await act(async () => { navRow('favorites').props.onClick() })
    await flush(120)
    check('the favorite place holds only the starred entry', listArgs.at(-1)?.section === 'favorites' && nRows().length === 1 && nText().includes('GitHub 工作账号'), 'rows=' + nRows().length)
    // The rail is a place you stand in, not a row that scrolls away: the list
    // shares the panel's scroll container, so a rail laid out in sync with the
    // entries walked off the top the moment the list moved. Sticky holds it at
    // the top of the scroll area at every width; only the coarse-pointer rule
    // in ensureStyles drops back to static, because on a phone the rail
    // belongs above the list and moves with it.
    const rail = nodeWith('data-vw-nav')[0]
    check(
      'the rail is pinned to the top of the panel while the list scrolls',
      rail.props.style.position === 'sticky' && rail.props.style.top === 0,
      JSON.stringify([rail.props.style.position, rail.props.style.top]),
    )

    await act(async () => { panel.renderer.unmount() })
  }

  // ── the 验证码 place: rows you read, not rows you open ────────────────────
  // A code and its copy control live on the row itself, so this one place
  // trades the row <button> for a div carrying the same role and the same row
  // contract — a nested button is invalid markup React refuses to build.
  {
    const panel = await mountPanel(mod, {}, makeRpc())
    const navRow = (key) => panel.renderer.root.findAll((node) => node.props && node.props['data-vw-section'] === key)[0]
    await act(async () => { navRow('totp').props.onClick() })
    await flush(120)
    const tRows = () => panel.renderer.root.findAll((node) => node.props?.['data-vw-totp-row'] !== undefined)
    const tCode = () => panel.renderer.root.findAll((node) => node.props?.['data-vw-totp-code'] !== undefined)[0]
    const tCopy = () => panel.renderer.root.findAll((node) => node.props?.['data-vw-totp-copy'] !== undefined)[0]
    const tRing = () => panel.renderer.root.findAll((node) => node.props?.['data-vw-totp-ring'] !== undefined)[0]

    check('the code place holds exactly the entries with a secret', tRows().length === 1 && tRows()[0].props.role === 'option' && tRows()[0].props['data-row'] === '', 'rows=' + tRows().length)
    // The row is a div, so it gets no UA border-box the way a button row does:
    // without it the code row overflows the list by its own padding and the
    // copy control is clipped at the panel edge (seen live at 390px and 800px).
    check('the code row cannot outgrow the list it sits in', tRows()[0].props.style.boxSizing === 'border-box', String(tRows()[0].props.style.boxSizing))
    check('the code is grouped three and three', String(tCode()?.props?.children) === '123 456', String(tCode()?.props?.children))
    check('the row carries its own countdown ring', Boolean(tRing()))
    check('the row offers a copy control', String(tCopy()?.props?.children) === '复制' && tCopy().props.title === '复制动态码', String(tCopy()?.props?.children))
    await act(async () => { panel.renderer.unmount() })
  }

  // ── the panel's own layout: nothing squeezes, nothing escapes ─────────────
  // The scroll area is a flex column with a height budget (min(58vh, 560px)),
  // and flex items shrink by default. A card taller than the budget therefore
  // had its BOX squeezed down to the budget while its content kept painting
  // past the card's surface onto the dialog background: in API-key mode the
  // client_id / client_secret rows, their hints and the button row appeared to
  // float free of the card (reported as 错位). Every direct child of the
  // scroll area now keeps its natural height and the panel scrolls instead —
  // which is also what leaves the rail room to stay pinned.
  {
    const panel = await mountPanel(mod, {}, makeRpc())
    const scroller = panel.renderer.root.findByProps({ 'data-scroll-area': '' })
    const wrapper = scroller.children[0]
    check(
      'the scroll area keeps its content at its natural height',
      wrapper?.props.style?.flex === 'none',
      JSON.stringify(wrapper?.props.style),
    )

    // The same fix on the three full-screen cards, which is where the reported
    // misalignment showed: the API-key setup form carries two extra fields and
    // is the one tall enough to exceed the budget.
    const apiConfig = { ok: true, value: { serverUrl: '', email: '', hasMasterPassword: false, hasApiKey: false, websocket: true, pollIntervalSeconds: 60, cacheMinutes: 30, accessMode: 'readonly' } }
    const notConfiguredError = { ok: false, error: { code: 'not_configured', message: '凭据库尚未配置完整' } }
    const setupRpc = makeRpc({ boot: () => bootWith(apiConfig.value, false), list: () => notConfiguredError, status: () => notConfiguredError })
    const setup = await mountPanel(mod, {}, setupRpc)
    const setupCard = setup.renderer.root.findAll((node) => node.props?.style?.minHeight === 200)[0]
    check(
      'the setup card cannot be squeezed below its content',
      Boolean(setupCard) && setupCard.props.style.flex === 'none',
      JSON.stringify(setupCard?.props.style),
    )
    check(
      'the setup card still caps its width for a wide host',
      setupCard?.props.style.maxWidth === 520,
      String(setupCard?.props.style.maxWidth),
    )
    await act(async () => { setup.renderer.unmount() })
    await act(async () => { panel.renderer.unmount() })

    // The unpin lives in the injected stylesheet: an inline style cannot be
    // reached by a container query, so the rule has to override it. It is
    // gated on a coarse pointer — a narrow mouse window keeps the pinned rail
    // (that is exactly the case the width-only rule broke: the places left the
    // screen for a mouse user too, reported as 收藏/验证码/未归类 不固定). The
    // window-based copy covers browsers without container queries, where the
    // panel is full width and the phone layout has already kicked in.
    const sheet = panelSheetText
    const unpin = '[data-vw-nav] { position: static !important }'
    check(
      'the narrow-panel query unpins the rail so it scrolls with the list',
      sheet.includes(unpin),
      sheet.includes(unpin) ? '' : 'rule missing from the injected sheet',
    )
    check(
      'the no-container-query fallback repeats the unpin',
      (sheet.match(new RegExp(unpin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length >= 2,
      String((sheet.match(new RegExp(unpin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length),
    )
    // A mouse keeps the places at any width: the unpin may only live behind a
    // coarse-pointer gate, never as a plain width rule. Both copies are
    // checked: each `position: static !important` has to sit inside a
    // `pointer: coarse` block, so a narrow mouse window keeps the pinned rail.
    const coarseAt = sheet.indexOf('@media (pointer: coarse)')
    const unpinAt = sheet.indexOf(unpin)
    check(
      'the rail unpin is gated on a coarse pointer, not on the panel width',
      coarseAt >= 0 && unpinAt > coarseAt,
      'coarse@' + coarseAt + ' unpin@' + unpinAt,
    )
    const fallbackGate = sheet.indexOf('@media (max-width: 760px) and (pointer: coarse)')
    const lastUnpinAt = sheet.lastIndexOf(unpin)
    check(
      'the no-container-query unpin is gated on the pointer too',
      fallbackGate >= 0 && lastUnpinAt > fallbackGate,
      'fallback@' + fallbackGate + ' lastUnpin@' + lastUnpinAt,
    )
    check(
      'a narrow panel does not cap the rail (a clipped row reads as broken)',
      !/\[data-vw-nav\][^}]*max-height/.test(sheet),
      'rail height cap still in the injected sheet',
    )
  }

  // ── favicons: the server's icon when it has one, the tile otherwise ───────
  // The server already caches site icons and answers at /icons/<host>/icon.png,
  // so the panel renders an <img> straight away — and asks once per host
  // whether there is one. The test double has no DOM, so the answer is preset.
  {
    mod.__setIcons({ 'github.com': 'ok', '10.0.0.10': 'none' })
    const panel = await mountPanel(mod, {}, makeRpc())
    await flush()
    const imgs = () => panel.renderer.root.findAllByType('img')
    const rows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')
    check(
      'the server icon takes the tile when the host has one',
      imgs().length === 1 && String(imgs()[0].props.src) === 'https://vault.example.com/icons/github.com/icon.png',
      JSON.stringify(imgs().map((node) => node.props.src)),
    )
    check('the icon is decoration, not content', imgs()[0]?.props.alt === '')
    check(
      'a host the server has no icon for keeps its letter tile',
      String(rows()[3].props.children[0].props.children) === 'D',
      JSON.stringify(rows().map((row) => String(row.props.children[0].props.children))),
    )

    // The opened entry is where the icon went missing: the header drew its own
    // tile straight from the monogram, so a row that was showing the favicon
    // turned back into a bare letter the moment it was clicked open.
    await act(async () => { rows()[0].props.onClick() })
    await flush()
    const detail = () => panel.renderer.root.findAll((node) => node.props?.['data-vw-detail'] !== undefined)[0]
    const detailImgs = () => detail()?.findAllByType('img') ?? []
    check(
      'the opened entry carries the same site icon its list row had',
      detailImgs().length === 1 && String(detailImgs()[0].props.src) === 'https://vault.example.com/icons/github.com/icon.png',
      JSON.stringify(detailImgs().map((node) => node.props.src)),
    )
    check(
      'the header tile scales its icon up instead of showing an 18px dot in a 36px tile',
      detailImgs()[0]?.props.style?.width === 22,
      JSON.stringify(detailImgs()[0]?.props.style),
    )
    await act(async () => { panel.renderer.unmount() })
    mod.__setIcons({})
  }

  // ── the favicon arrives on its own: the probe must wake the row ───────────
  // The block above presets the answer, which skips the one path that broke in
  // the browser: `probeIcon` answers through a module-scope map, and a map is
  // invisible to React. The version bump used to stop at the counter, so the
  // row kept its letter tile until an unrelated re-render happened to come by —
  // in practice, when the reader typed in the search box. So this case hands
  // the module a real `Image` and fires its load event.
  {
    const loads = []
    const savedImage = globalThis.Image
    globalThis.Image = class {
      constructor() { this.naturalWidth = 0; loads.push(this) }
      set src(value) { this._src = value }
      get src() { return this._src }
    }
    try {
      mod.__setIcons({})
      const panel = await mountPanel(mod, {}, makeRpc())
      await flush()
      const rows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')
      const imgs = () => panel.renderer.root.findAllByType('img')
      check('a host nobody has asked about yet keeps its letter tile', imgs().length === 0, 'imgs=' + imgs().length)
      // One probe per host with a URI, not one per row: the two hosts in the
      // fixture are asked about once each.
      check(
        'each host with a URI is asked about once',
        loads.length === 2 && loads.filter((node) => String(node.src).includes('/icons/github.com/icon.png')).length === 1,
        JSON.stringify(loads.map((node) => node.src)),
      )
      check('the letter tile is what the row shows meanwhile', String(rows()[0].props.children[0].props.children) === 'G')
      // The server answered: the image loaded at a real icon size. Nothing else
      // touches the panel between this line and the assertion below — that is
      // the whole point of the check.
      await act(async () => {
        loads[0].naturalWidth = 72
        loads[0].onload()
      })
      check(
        'a probe answer repaints the row by itself, with no other change',
        imgs().length === 1 && String(imgs()[0].props.src) === 'https://vault.example.com/icons/github.com/icon.png',
        'imgs=' + imgs().length + ' src=' + JSON.stringify(imgs().map((node) => node.props.src)),
      )
      await act(async () => { panel.renderer.unmount() })
    } finally {
      globalThis.Image = savedImage
      mod.__setIcons({})
    }
  }

  // ── a host that cannot count: the sidebar degrades to one place ───────────
  // vw/overview is newer than the rest of the host half. A page served by an
  // older host must still open the vault, so the menu falls back to the one
  // place that needs no counts at all rather than to a menu of guesses.
  {
    const panel = await mountPanel(mod, {}, makeRpc({ overview: () => ({ ok: false, error: { code: 'not_found', message: 'vw.overview unknown' } }) }))
    const navRows = () => panel.renderer.root.findAll((node) => node.props && node.props['data-vw-section'] !== undefined)
    const rows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')
    check('an uncounted host still opens the vault', rows().length === ITEM_COUNT, 'rows=' + rows().length)
    check(
      'the sidebar degrades to the one place that needs no counts',
      navRows().length === 1 && navRows()[0].props['data-vw-section'] === 'all',
      JSON.stringify(navRows().map((node) => node.props['data-vw-section'])),
    )
    await act(async () => { panel.renderer.unmount() })
  }

  // ── write actions (accessMode=ask): every write is confirmed first ────────
  {
    const writes = []
    const writeRpc = makeRpc({
      boot: () => bootWith({ ...CONFIG_VALUE, accessMode: 'ask' }, true, AUTHED_SESSION),
      folders: () => ({ ok: true, value: { folders: [{ id: 'folder-work', name: '工作', count: 1 }], total: 1, unfiled: 3, hint: 'folderList' } }),
      update: (args) => {
        writes.push({ method: 'update', args })
        return { ok: true, value: { id: args.id, name: 'x', updated: true, revisionDate: '2026-10-06T00:00:00.000Z' } }
      },
      remove: (args) => {
        writes.push({ method: 'remove', args })
        return { ok: true, value: { id: args.id, deleted: true, permanent: false, hint: '条目已进入回收站，可用 bitwarden_restore 恢复' } }
      },
      restore: (args) => {
        writes.push({ method: 'restore', args })
        return { ok: true, value: { id: args.id, restored: true, revisionDate: '2026-10-06T00:00:00.000Z' } }
      },
    })
    const panel = await mountPanel(mod, {}, writeRpc)
    const nodeWith = (key, value = '') => panel.renderer.root.findAll((node) => node.props?.[key] === value)
    const actionButtons = () => panel.renderer.root.findAll((node) => node.props && node.props['data-vw-action'] !== undefined).map((node) => node.props['data-vw-action'])
    const wText = () => JSON.stringify(panel.renderer.toJSON())
    const wRows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')

    await act(async () => { wRows()[0].props.onClick() })
    await act(async () => { await sleep(50) })

    check('a writable panel offers archive, trash and move', actionButtons().sort().join(',') === 'archive,move,trash', actionButtons().join(','))

    await act(async () => { nodeWith('data-vw-action', 'archive')[0].props.onClick() })
    check('archive asks before writing', writes.length === 0 && nodeWith('data-vw-confirm').length === 1)
    check('the confirmation names the action', wText().includes('确认归档该条目？归档后模型搜索默认不再返回它。'))
    check('the confirmation repeats the gate warning', wText().includes('面板操作不受 accessMode 门禁保护，请谨慎操作。'))
    await act(async () => { nodeWith('data-vw-confirm-ok')[0].props.onClick() })
    await flush()
    check('confirming archive writes archived=true', writes[0]?.method === 'update' && writes[0]?.args?.id === 'item-1' && writes[0]?.args?.input?.archived === true, JSON.stringify(writes[0]?.args))
    check('the write reports itself done', wText().includes('已完成，正在刷新…'))

    await act(async () => { nodeWith('data-vw-action', 'move')[0].props.onClick() })
    check('move asks for a destination first', nodeWith('data-vw-move').length === 1 && writes.length === 1)
    const moveSelect = () => panel.renderer.root.findAllByType('select')[0]
    const moveOptions = () => {
      const list = Array.isArray(moveSelect().props.children) ? moveSelect().props.children : [moveSelect().props.children]
      return list.filter(Boolean).map((node) => String(node.props?.children ?? '')).join(',')
    }
    check('move offers no-move plus the folders', moveOptions().includes('不移动') && moveOptions().includes('工作'), moveOptions())
    await act(async () => { moveSelect().props.onChange({ target: { value: 'folder-work' } }) })
    await act(async () => { nodeWith('data-vw-move-ok')[0].props.onClick() })
    check('the move confirmation names the destination', wText().includes('把该条目移动到「工作」？'))
    await act(async () => { nodeWith('data-vw-confirm-ok')[0].props.onClick() })
    await flush()
    check('confirming move writes folderId', writes.at(-1)?.method === 'update' && writes.at(-1)?.args?.input?.folderId === 'folder-work', JSON.stringify(writes.at(-1)?.args))

    await act(async () => { nodeWith('data-vw-action', 'move')[0].props.onClick() })
    await act(async () => { nodeWith('data-vw-move-ok')[0].props.onClick() })
    await act(async () => { nodeWith('data-vw-confirm-ok')[0].props.onClick() })
    await flush()
    check('moving out clears the folder with null', writes.at(-1)?.args?.input?.folderId === null, JSON.stringify(writes.at(-1)?.args))

    await act(async () => { nodeWith('data-vw-action', 'trash')[0].props.onClick() })
    check('trash asks before deleting', wText().includes('确认把该条目移入回收站？可在回收站中恢复。'))
    await act(async () => { nodeWith('data-vw-confirm-ok')[0].props.onClick() })
    await flush()
    check('confirming trash calls remove with just the id', writes.at(-1)?.method === 'remove' && writes.at(-1)?.args?.id === 'item-1' && writes.at(-1)?.args?.permanent === undefined, JSON.stringify(writes.at(-1)?.args))
    await act(async () => { panel.renderer.unmount() })
  }

  // ── a trashed entry: read with includeTrashed, restore is the only action ──
  {
    const restoreCalls = []
    const trashedRow = { id: 'item-7', name: '回收站条目', type: 'login', username: 'ghost', uris: [], folder: null, folderId: null, collections: [], hasTotp: false, hasNotes: false, customFields: [], favorite: false, trashed: true }
    const trashedRpc = makeRpc({
      status: () => ({ ok: true, value: { ...STATUS_REPORT, trashed: 1 } }),
      boot: () => bootWith({ ...CONFIG_VALUE, accessMode: 'ask' }, true, AUTHED_SESSION),
      folders: () => ({ ok: true, value: { folders: [], total: 0, unfiled: 1, hint: 'folderList' } }),
      list: () => ({ ok: true, value: { query: '', matched: 1, returned: 1, offset: 0, hasMore: false, vaultItems: 1, items: [trashedRow] } }),
      reveal: () => ({ ok: true, value: { id: 'item-7', name: '回收站条目', type: 'login', username: 'ghost', password: 'ghost-pass', trashed: true, deletedDate: '2026-10-01T00:00:00.000Z', collections: [] } }),
      restore: (args) => {
        restoreCalls.push(args)
        return { ok: true, value: { id: args.id, restored: true, revisionDate: '2026-10-06T00:00:00.000Z' } }
      },
    })
    const panel = await mountPanel(mod, {}, trashedRpc)
    const nodeWith = (key, value = '') => panel.renderer.root.findAll((node) => node.props?.[key] === value)
    const pRows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')
    const actions = () => panel.renderer.root.findAll((node) => node.props && node.props['data-vw-action'] !== undefined).map((node) => node.props['data-vw-action'])

    // The trash is a place of its own now: the reader steps into it from the
    // sidebar, and the read that follows is the one that asks for deleted rows.
    const trashNav = () => panel.renderer.root.findAll((node) => node.props?.['data-vw-section'] === 'trash')[0]
    await act(async () => { trashNav().props.onClick() })
    await flush(120)
    await act(async () => { pRows()[0].props.onClick() })
    await act(async () => { await sleep(50) })

    const revealCall = trashedRpc.calls.filter((call) => call.method === 'reveal').at(-1)
    check('reading a trashed entry asks for the trashed rows too', revealCall?.args?.includeTrashed === true, JSON.stringify(revealCall?.args))
    check('the detail says the entry is in the trash', JSON.stringify(panel.renderer.toJSON()).includes('该条目在回收站中（软删除）'))
    check('a trashed entry offers restore and nothing else', actions().join(',') === 'restore', actions().join(','))

    await act(async () => { nodeWith('data-vw-action', 'restore')[0].props.onClick() })
    check('restore asks first', restoreCalls.length === 0 && JSON.stringify(panel.renderer.toJSON()).includes('确认从回收站恢复该条目？'))
    await act(async () => { nodeWith('data-vw-confirm-ok')[0].props.onClick() })
    await flush()
    check('confirming restore calls vw/restore with the id', restoreCalls[0]?.id === 'item-7', JSON.stringify(restoreCalls))
    await act(async () => { panel.renderer.unmount() })
  }

  // ── typed entries: card / ssh-key projections, attachments, history ───────
  {
    // `all` no longer carries the card body: it says a card is there and the
    // panel has to ask for `field: 'card'` before the number is on screen.
    const cardReveal = {
      id: 'item-card', name: '公司信用卡', type: 'card', username: null,
      hasCard: true,
      attachments: [{ id: 'att-1', fileName: '合同.pdf', size: 2048, sizeName: '2 KB' }],
      passwordHistory: [{ password: 'old-secret', lastUsedDate: '2026-01-01T00:00:00.000Z' }],
      hasFido2: true,
      uris: [], collections: [], folder: null,
    }
    const cardBody = { id: 'item-card', name: '公司信用卡', type: 'card', card: { cardholderName: '张伟', brand: 'Visa', number: '4111111111111111', expMonth: '09', expYear: '2030', code: '123' } }
    const cardRpc = makeRpc({
      list: () => ({ ok: true, value: { query: '', matched: 1, returned: 1, offset: 0, hasMore: false, vaultItems: 1, items: [{ id: 'item-card', name: '公司信用卡', type: 'card', username: null, uris: [], folder: null, folderId: null, collections: [], hasTotp: false, hasNotes: false, customFields: [], favorite: false }] } }),
      reveal: (args) => ({ ok: true, value: args.field === 'card' ? cardBody : cardReveal }),
    })
    const panel = await mountPanel(mod, {}, cardRpc)
    const nodeWith = (key, value = '') => panel.renderer.root.findAll((node) => node.props?.[key] === value)
    const pText = () => JSON.stringify(panel.renderer.toJSON())
    const pButtons = () => panel.renderer.root.findAllByType('button')
    const pRows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')

    await act(async () => { pRows()[0].props.onClick() })
    await act(async () => { await sleep(50) })

    check('a card entry is labelled with its type', pText().includes('银行卡'))
    check('opening a card entry does not hand over the card body', pText().includes('含银行卡') && !pText().includes('4111111111111111') && !pText().includes('张伟'))
    check('the passkey badge shows up', pText().includes('含通行密钥'))
    await act(async () => { pButtons().find((node) => node.props.children === '读取这一项').props.onClick() })
    await act(async () => { await sleep(50) })
    check('the card body arrives only when that field is asked for', cardRpc.calls.some((call) => call.method === 'reveal' && call.args.field === 'card'))
    check('the card number is masked to its last four', pText().includes('•••• •••• •••• 1111') && !pText().includes('4111111111111111'))
    check('the cardholder name shows in the clear', pText().includes('张伟'))
    await act(async () => { pButtons().find((node) => node.props.children === '显示').props.onClick() })
    check('the card number reveals on demand', pText().includes('4111111111111111'))

    check('attachments fold behind a header', nodeWith('data-vw-fold', 'attachments').length === 1 && pText().includes('附件（1）'))
    await act(async () => { nodeWith('data-vw-fold', 'attachments')[0].props.onClick() })
    check('the attachment list names the file, not a download', pText().includes('合同.pdf') && pText().includes('2 KB') && pText().includes('面板只显示附件信息，不下载内容'))
    await act(async () => { nodeWith('data-vw-fold', 'history')[0].props.onClick() })
    check('the password history is listed, masked', pText().includes('历史密码（1）') && pText().includes('最近使用：') && pText().includes('●●●●●●●●') && !pText().includes('old-secret'))
    await act(async () => { panel.renderer.unmount() })
  }
  {
    // Same shape for an SSH key: `all` gives the fingerprint (a public
    // handle, not the material) and the panel fetches `field: 'sshKey'` for
    // the private half.
    const sshReveal = { id: 'item-ssh', name: '部署密钥', type: 'sshKey', hasSshKey: true, sshKeyFingerprint: 'SHA256:abc123', uris: [], collections: [], folder: null }
    const sshBody = { id: 'item-ssh', name: '部署密钥', type: 'sshKey', sshKey: { publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI', keyFingerprint: 'SHA256:abc123', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----' } }
    const sshRpc = makeRpc({
      list: () => ({ ok: true, value: { query: '', matched: 1, returned: 1, offset: 0, hasMore: false, vaultItems: 1, items: [{ id: 'item-ssh', name: '部署密钥', type: 'sshKey', username: null, uris: [], folder: null, folderId: null, collections: [], hasTotp: false, hasNotes: false, customFields: [], favorite: false }] } }),
      reveal: (args) => ({ ok: true, value: args.field === 'sshKey' ? sshBody : sshReveal }),
    })
    const panel = await mountPanel(mod, {}, sshRpc)
    const pText = () => JSON.stringify(panel.renderer.toJSON())
    const pRows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')

    await act(async () => { pRows()[0].props.onClick() })
    await act(async () => { await sleep(50) })

    check('an ssh key is labelled with its type', pText().includes('SSH 密钥'))
    check('opening an ssh entry shows the fingerprint but not the key material', pText().includes('SHA256:abc123') && !pText().includes('BEGIN OPENSSH') && !pText().includes('ssh-ed25519'))
    await act(async () => { panel.renderer.root.findAllByType('button').find((node) => node.props.children === '读取这一项').props.onClick() })
    await act(async () => { await sleep(50) })
    check('the public key is shown in the clear once the field is read', pText().includes('ssh-ed25519'))
    check('the private key stays masked', pText().includes('●●●●●●●●') && !pText().includes('BEGIN OPENSSH'))
    await act(async () => { panel.renderer.root.findAllByType('button').find((node) => node.props.children === '显示').props.onClick() })
    check('the private key reveals on demand', pText().includes('BEGIN OPENSSH'))
    await act(async () => { panel.renderer.unmount() })
  }

  // ── readonly: the write block is replaced by the reason ───────────────────
  {
    const panel = await mountPanel(mod, {}, makeRpc())
    const pRows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')
    await act(async () => { pRows()[0].props.onClick() })
    await act(async () => { await sleep(50) })
    const roActions = panel.renderer.root.findAll((node) => node.props && node.props['data-vw-action'] !== undefined)
    const roNote = panel.renderer.root.findAll((node) => node.props && node.props['data-vw-readonly'] === '')
    check('readonly renders no write buttons', roActions.length === 0, String(roActions.length))
    check('readonly explains the missing write actions', roNote.length === 1 && JSON.stringify(roNote[0].props.children).includes('当前为只读模式'), String(roNote.length))
    check('readonly still renders the entry itself', JSON.stringify(panel.renderer.toJSON()).includes('octocat@example.com'))
    await act(async () => { panel.renderer.unmount() })
  }

  void t
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exit(1)
})
