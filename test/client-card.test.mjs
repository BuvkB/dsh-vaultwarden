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
// The listeners are kept, not discarded: the shortcuts are panel-wide and the
// only way to press a key on them from here is to call the handler the panel
// registered.
const windowListeners = new Map()
if (typeof globalThis.window === 'undefined' || typeof globalThis.window.addEventListener !== 'function') {
  globalThis.window = {
    addEventListener: (type, handler) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set())
      windowListeners.get(type).add(handler)
    },
    removeEventListener: (type, handler) => { windowListeners.get(type)?.delete(handler) },
  }
} else {
  const originalAdd = globalThis.window.addEventListener.bind(globalThis.window)
  const originalRemove = globalThis.window.removeEventListener.bind(globalThis.window)
  globalThis.window.addEventListener = (type, handler) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set())
    windowListeners.get(type).add(handler)
    originalAdd(type, handler)
  }
  globalThis.window.removeEventListener = (type, handler) => {
    windowListeners.get(type)?.delete(handler)
    originalRemove(type, handler)
  }
}
/** Press a key on every handler the panel registered for it. */
const press = (key, options = {}) => {
  let prevented = false
  const event = {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: null,
    ...options,
    preventDefault: () => { prevented = true },
  }
  for (const handler of [...(windowListeners.get('keydown') ?? [])]) handler(event)
  return prevented
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
/**
 * `vw/draft` answers: the whole plaintext record, for the editor.
 *
 * The shape mirrors what lib/vault.js draftEntry() returns — including the
 * reprompt stub, which carries the entry's identity and nothing else. The
 * fixture used to be a copy of the reveal payload, which would have let the
 * editor open on an entry the host had actually locked.
 */
const DRAFTS = {
  'item-1': {
    id: 'item-1',
    name: 'GitHub 工作账号',
    type: 'login',
    username: 'octocat@example.com',
    password: 'gh-p@ssw0rd-42',
    hasTotp: true,
    uris: ['https://github.com/login'],
    notes: 'SSH 密钥在 CI 里',
    fields: [{ name: '租户', value: 'jindom', type: 0 }],
    favorite: true,
    reprompt: 0,
    folderId: 'folder-work',
    organizationId: null,
    revisionDate: '2026-10-01T00:00:00.000Z',
    card: null,
    identity: null,
    sshKey: null,
    secureNote: null,
    attachments: [],
    passwordHistory: [],
    hasFido2: false,
  },
  'item-3': { id: 'item-3', name: '需要重新验证的条目', type: 'login', repromptRequired: true },
}


/** The hosted configuration the panel opens with. */
const CONFIG_VALUE = { serverUrl: 'https://vault.example.com', email: 'me@example.com', hasMasterPassword: true, hasApiKey: false, websocket: true, pollIntervalSeconds: 60, cacheMinutes: 30, accessMode: 'readonly' }
/** `boot`'s view of a live session. */
const AUTHED_SESSION = { configured: true, authenticated: true, pendingTwoFactor: false, unlocked: true }
/** `boot`'s view of a session the host could not revive. */
const SIGNED_OUT_SESSION = { configured: true, authenticated: false, pendingTwoFactor: false, unlocked: false }
/**
 * What the host reports about itself on `boot`: the installed manifest's
 * identity. The panel's title row shows the version from here, so the fixture
 * has to carry one — a boot answer without it is the shape of an OLDER host,
 * which is covered separately below.
 */
const PLUGIN_IDENTITY = { name: 'dsh-vaultwarden', version: '0.8.7', repository: 'git+https://github.com/BuvkB/dsh-vaultwarden.git' }
/** One `boot` answer, shaped the way the gateway returns it. */
const bootWith = (config, resumed, session, plugin = PLUGIN_IDENTITY) => ({ ok: true, value: { config, resumed: Boolean(resumed), session, plugin } })

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
      if (method === 'draft') {
        const args = payload?.args ?? {}
        return { ok: true, value: DRAFTS[args.id] ?? { error: 'not_found' } }
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
      if (method === 'boot') return { ok: true, value: { config: CONFIG_VALUE, resumed: true, session: AUTHED_SESSION, plugin: PLUGIN_IDENTITY } }
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
  // The bundle is invoked with its own window object, so the shortcut handlers
  // land on this stub rather than on globalThis.window: both feed the same
  // registry, which is what lets `press` reach them.
  const windowStub = {
    __ModuleLoader__: { load: (value) => (entry = value) },
    addEventListener: (type, handler) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set())
      windowListeners.get(type).add(handler)
    },
    removeEventListener: (type, handler) => { windowListeners.get(type)?.delete(handler) },
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
  // `createNodeMock` is how a test hands a `ref` a real object to point at:
  // react-test-renderer otherwise leaves every ref null, and the scroll memory
  // below cannot be observed at all. The default (no option) stays null.
  const createOptions = options.createNodeMock ? { createNodeMock: options.createNodeMock } : undefined
  await act(async () => {
    renderer = create(registration.render({ ...registration.options.inject() }), createOptions)
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
    check('panel label comes from the dictionary', labelJson.includes('密码库'), labelJson.slice(0, 120))
    // The label carries the plugin's badge — the same mark the panel heading
    // leads with. Asserting the contract, not a path string: a redesign must
    // not fail this for the wrong reason.
    //
    // Two shapes carry two ideas: the shield outline (the vault) and a check
    // inside it (the thing is unlocked and verified). The keyhole this mark
    // used to carry was three shapes in a 16-unit box and read as a smudge at
    // rail size; the check is one stroke with room around it, and it is the
    // silhouette the plugin is recognised by in the host's navigation.
    //
    // Monochrome throughout — both shapes are stroke-only and inherit
    // `currentColor`, so the mark flips with the theme and introduces no
    // colour of its own, and the two share one centre so the badge reads as
    // composed rather than scattered.
    const glyphSvg = JSON.parse(labelJson).children[0]
    const shapes = glyphSvg.children ?? []
    const paints = shapes.map((s) => String((s.props && (s.props.fill || s.props.stroke)) ?? ''))
    check('the settings label carries the vault glyph', labelJson.includes('vw-nav-glyph'), labelJson.slice(0, 120))
    check(
      'the label glyph draws the shield and the check inside it',
      shapes.length === 2,
      labelJson.slice(0, 200),
    )
    // The check sits on the shield's own axis and inside its outline: a tick
    // drawn outside the shield or off its centre reads as two unrelated marks.
    const tick = shapes[1]
    const tickPoints = String(tick?.props?.d ?? '')
      .match(/-?\d+(\.\d+)?/g)
      ?.map(Number) ?? []
    const tickXs = tickPoints.filter((_, index) => index % 2 === 0)
    const tickYs = tickPoints.filter((_, index) => index % 2 === 1)
    check(
      'the check is centred on the shield axis and inside its outline',
      tickXs.length > 0 &&
        tickYs.length > 0 &&
        Math.abs(tickXs.reduce((a, b) => a + b, 0) / tickXs.length - 8) <= 1.2 &&
        Math.min(...tickYs) > 3 &&
        Math.max(...tickYs) < 13,
      JSON.stringify({ tickXs, tickYs }),
    )
    check(
      'no keyhole is left behind (the check replaced it)',
      !shapes.some((s) => s.props && s.props.cx !== undefined),
      labelJson.slice(0, 200),
    )
    check(
      'the label glyph is monochrome: every shape inherits the ink',
      paints.every((p) => p === 'currentColor' || p === 'none'),
      JSON.stringify(paints),
    )
    check('the settings label is marked for the gear replacement', labelJson.includes('vw-nav-label') && labelJson.includes('vw-nav-text'))
  }

  // ── compact header (reported: the title and search box were noisy) ───────
  // The title stays short; Vaultwarden support rides alongside it in small
  // type. The search placeholder used to carry the keyboard shortcuts and was
  // truncated on a phone, so it is short now and the shortcuts moved into the
  // input tooltip.
  {
    const headerText = JSON.stringify(renderer.toJSON())
    // The heading is three parts now: a 密码库 badge, the package name, then
    // the build identity. The badge shares the panel's Badge system, so it is
    // the same 19px pill the list uses for a TOTP mark.
    check(
      'the heading opens with a 密码库 badge',
      headerText.includes('"data-vw-badge"' ) && headerText.includes('密码库'),
      headerText.slice(0, 260),
    )
    check('the heading names the package itself', headerText.includes('dsh-vaultwarden'), headerText.slice(0, 260))
    // The old note ("supports Bitwarden / Vaultwarden") only repeated what the
    // heading already says, so it is gone; the small-type slot instead carries
    // the installed version and a link to the source.
    check('the redundant compatibility note is gone', !headerText.includes('支持 Bitwarden / Vaultwarden'))
    check(
      'the title row carries the installed version',
      headerText.includes('"data-vw-version"') && headerText.includes('0.8.7'),
      headerText.slice(0, 300),
    )
    check(
      'the title row carries a clickable link to the source',
      headerText.includes('"data-vw-repo"') && headerText.includes('https://github.com/BuvkB/dsh-vaultwarden'),
      headerText.slice(0, 300),
    )
    const search = renderer.root.findAllByType('input').find((node) => node.props.type === 'search')
    check('the search placeholder is short', search?.props.placeholder === '搜索名称、用户名或网址', String(search?.props.placeholder))
    check('the keyboard shortcuts moved into the tooltip', String(search?.props.title).includes('Esc'))
    check('the search box carries the narrow-screen hook', search?.props['data-vw-search'] === '')

  }

  const text = () => JSON.stringify(renderer.toJSON())
  const buttons = () => renderer.root.findAllByType('button')
  // Rows are divs, not buttons: a row holds the hover island, and a button
  // cannot nest a button.
  const rows = () => renderer.root.findAll((node) => node.props?.role === 'option')

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

  // The standing entry count is gone by design: the toolbar carries only
  // the transient refresh word, so at rest the slot renders nothing.
  check('the toolbar keeps no standing entry count', !text().includes(`共 ${ITEM_COUNT} 条`))
  check('list renders one option per entry', rows().length === ITEM_COUNT, `rows=${rows().length}`)
  check('selected state is exposed via aria-selected', rows()[0].props['aria-selected'] === 'false')

  // ── a row is a div now, and it carries its own quick actions ─────────────
  // The row used to be a <button>, which is why copying an account meant
  // opening the card first: a button cannot hold the copy buttons. It is a
  // focusable div now, and hover reveals the island. Three things have to hold
  // or the trade was not worth making — the row must stay operable from the
  // keyboard, a key pressed inside the island must not also open the row, and
  // the island must never appear on a code row (those stay exactly as they —
  // were: same tail, same single control, no second copy affordance).
  {
    const islandOf = (row) => row.findAll((node) => node.props?.['data-vw-row-actions'] === '')[0]
    const isDiv = rows().every((row) => row.type === 'div')
    check('a row is a div, so the island can live inside it', isDiv, JSON.stringify(rows().map((row) => row.type)))
    check('a row is still reachable by keyboard', rows().every((row) => row.props.tabIndex === 0))
    check('Enter on a row opens it', (() => {
      let stopped = false
      rows()[1].props.onKeyDown({ key: 'Enter', target: rows()[1], currentTarget: rows()[1], preventDefault: () => { stopped = true } })
      return stopped
    })())
    check('a key pressed inside the island does not open the row', (() => {
      const row = rows()[0]
      let stopped = false
      row.props.onKeyDown({ key: 'Enter', target: {}, currentTarget: row, preventDefault: () => { stopped = true } })
      return stopped === false
    })())
    const island = islandOf(rows()[0])
    const islandLabels = island ? island.findAllByType('button').map((node) => node.props['aria-label']) : []
    check('the row offers copy-account and copy-password without opening', islandLabels.join('|') === '复制用户名|复制密码', JSON.stringify(islandLabels))
    // An entry with no username has nothing to copy but its password, and a
    // disabled first control would be a keyboard trap on every such row.
    const bare = islandOf(rows()[1])
    check('an entry with no username offers only the password', bare ? bare.findAllByType('button').length === 1 : false)
    const notTotp = rows().every((row) => islandOf(row)?.findAllByType('button').length >= 1)
    check('every ordinary row carries the island', notTotp)
  }

  // The password is not in the list projection — the row asks for it on click.
  // Two consequences worth pinning: the read is scoped to one field (a row must
  // not pull a whole card to copy one value), and a refused read (reprompt gate)
  // copies nothing at all rather than putting an empty string on the clipboard.
  {
    const writes = []
    const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async (text) => { writes.push(text) } } },
      configurable: true,
    })
    const islandOf = (row) => row.findAll((node) => node.props?.['data-vw-row-actions'] === '')[0]
    const passButtonOf = (row) => islandOf(row).findAllByType('button').find((node) => node.props['aria-label'] === '复制密码')
    try {
      const before = rpc.calls.filter((call) => call.method === 'reveal' && call.args.field === 'password').length
      await act(async () => {
        await passButtonOf(rows()[0]).props.onClick({ stopPropagation: () => {} })
      })
      await flush(50)
      const reads = rpc.calls.filter((call) => call.method === 'reveal' && call.args.field === 'password')
      check('the row copies a password over a field-scoped read', reads.length === before + 1 && reads.at(-1).args.id === 'item-1', JSON.stringify(reads.at(-1)?.args))
      check('the row never reads the whole card to copy one value', !reads.some((call) => call.args.field === undefined))
      check('the password reached the clipboard, not the screen', writes.includes('gh-p@ssw0rd-42') && !text().includes('gh-p@ssw0rd-42'), JSON.stringify(writes))
      // item-3 is behind the reprompt gate: its read comes back refused.
      const writesBefore = writes.length
      await act(async () => {
        await passButtonOf(rows()[2]).props.onClick({ stopPropagation: () => {} })
      })
      await flush(50)
      check('a refused read copies nothing', writes.length === writesBefore, JSON.stringify(writes))
      check('a refused read raises no confirmation', passButtonOf(rows()[2]).props['aria-label'] === '复制密码')
    } finally {
      if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator)
      else delete globalThis.navigator
    }
  }

  // A read in flight must not disable the control. `disabled` drops a button out
  // of every `:not(:disabled)` rule, and the hover wash lives in one of those —
  // so the control went dead exactly while the pointer was resting on it, which
  // read as "the hover sometimes does nothing". The island also takes the next
  // step of the host's interaction scale: it already wears the row's hover wash,
  // and painting the same wash on a control inside it is a wash on a wash.
  {
    let release = null
    const slowRpc = makeRpc({
      reveal: () => new Promise((resolve) => { release = () => resolve({ ok: true, value: REVEALS['item-1'] }) }),
    })
    const panel = await mountPanel(mod, {}, slowRpc)
    const islandOf = (row) => row.findAll((node) => node.props?.['data-vw-row-actions'] === '')[0]
    const passOf = (row) => islandOf(row).findAllByType('button').find((node) => node.props['aria-label'] === '复制密码')
    const firstRow = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')[0]
    const control = passOf(firstRow())
    let pending = null
    await act(async () => {
      pending = control.props.onClick({ stopPropagation: () => {} })
      await sleep(20)
    })
    check('a password read leaves the control enabled under the pointer', passOf(firstRow()).props.disabled !== true, String(passOf(firstRow()).props.disabled))
    check('a password read is announced busy instead of disabled', passOf(firstRow()).props['aria-busy'] === 'true', String(passOf(firstRow()).props['aria-busy']))
    await act(async () => {
      release?.()
      await pending
      await sleep(20)
    })
    check('the control is idle again once the read lands', passOf(firstRow()).props['aria-busy'] === undefined, String(passOf(firstRow()).props['aria-busy']))
    const sheet = mod.__panelSheet?.() ?? panelSheetText
    check(
      'the island stacks its own hover on the wash it already wears',
      /\[data-vw-row-actions\] button:not\(:disabled\):hover \{ background: var\(--dsw-alias-interactive-bg-active/.test(sheet),
      'the island controls still hover with the same wash as the row behind them',
    )
    await act(async () => { panel.renderer.unmount() })
  }

  // ── the panel's shortcuts ────────────────────────────────────────────────
  // Escape used to do nothing outside the search box, which made the back
  // button the only way out of a card — and in the drill layout that button is
  // the whole way back. The rules that matter: a key typed into a field is the
  // field's, and a key the panel does claim has to actually do the thing.
  {
    const panel = await mountPanel(mod, {}, makeRpc())
    const pText = () => JSON.stringify(panel.renderer.toJSON())
    const pRows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')
    await act(async () => { pRows()[0].props.onClick() })
    await flush(60)
    const cardOpen = () => panel.renderer.root.findAll((node) => node.props?.['data-vw-detail'] === '').length > 0
    check('a card is open before the shortcut is used', cardOpen())
    check('Escape is claimed by the panel while a card is open', press('Escape') === true)
    await flush(40)
    check('Escape steps out of the card', !cardOpen(), pText().slice(0, 200))
    check('Escape is a no-op when nothing is open', press('Escape') === false)
    // The search box owns Escape (it clears the query): the panel-wide handler
    // must not also fire while the reader is typing.
    check('a key typed in a field belongs to the field', press('Escape', { target: { tagName: 'INPUT' } }) === false)
    check('slash looks for the search box', press('/') === true)
    check('slash does nothing while typing in a field', press('/', { target: { tagName: 'INPUT' } }) === false)
    check('Cmd/Ctrl-K is search too', press('k', { metaKey: true }) === true && press('k', { ctrlKey: true }) === true)
    check('a bare k is not a shortcut', press('k') === false)
    await act(async () => { panel.renderer.unmount() })
  }

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
  check('detail offers copy controls, labelled by their tooltip', buttons().filter((node) => node.props.title === '复制').length >= 1)

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

    // ── one window, one fetch ────────────────────────────────────────────────
    // The countdown used to cost an RPC per second per row: fifty rows was
    // fifty calls a second for a code that changes once per window. The window
    // is now fetched once and the countdown is arithmetic on it. This mounts a
    // fresh panel with a counting totp mock, lets three clock beats pass, and
    // pins that the fetches stayed at one.
    {
      let totpCalls = 0
      const rpc = makeRpc({
        totp: () => { totpCalls += 1; return { ok: true, value: { id: 'item-1', name: 'GitHub 工作账号', totp: { code: '123456', digits: 6, period: 30, secondsRemaining: 28, remaining: 28, algorithm: 'SHA1' } } } },
      })
      const panel = await mountPanel(mod, {}, rpc)
      await act(async () => {
        optionRows(panel.renderer)[0].props.onClick()
      })
      await flush()
      const afterOpen = totpCalls
      await act(async () => {
        await sleep(3200)
      })
      check('three seconds of countdown cost one window fetch', totpCalls === afterOpen, 'calls ' + afterOpen + '→' + totpCalls)
      check('the code is still on screen after the beats', /\b123456\b/.test(text()), 'totp calls ' + totpCalls)
      await act(async () => {
        panel.renderer.unmount()
      })
    }

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

  const revealToggle = () => buttons().filter((node) => node.props.title === '显示')
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
  const count = (k) => renderer.root.findAll((n) => n.props?.[k] !== undefined).length
  const dnode = renderer.root.findAll((n) => n.props?.['data-vw-detail'] !== undefined)[0]
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
    // The server still reports the vault total, but the toolbar no longer
    // renders a standing count of it.
    check('no standing total renders while paging', !JSON.stringify(panel.renderer.toJSON()).includes(`共 ${BIG_COUNT} 条`))

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
  const notConfiguredError = { ok: false, error: { code: 'not_configured', message: '密码库尚未配置完整' } }
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
    const raceRows = () => race.renderer.root.findAll((node) => node.props?.role === 'option')
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

    check('the sidebar is a landmark, not a list', nodeWith('data-vw-nav').length === 1 && nodeWith('data-vw-nav')[0].props['aria-label'] === '密码库分区')
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
    // The rail draws its marks now: one SVG per row instead of a text glyph
    // whose optical size depended on the host's font. The rail alone uses the
    // reference's 24-unit grid at 2-unit stroke; everything else in the panel
    // keeps the panel's own 16-unit family, so the two asserts below pin both
    // facts rather than just "some svg is there". The count stays the bare
    // number — the chip is the style around it, never part of its text.
    const navIcons = () => panel.renderer.root.findAll((node) => node.props && node.props['data-vw-section-icon'] !== undefined)
    check('every place draws its own icon', navIcons().length === navKeys().length && navIcons().every((node) => String(node.props['data-vw-section-icon']).length > 0), JSON.stringify(navIcons().map((node) => node.props['data-vw-section-icon'])))
    check(
      'the icons are drawn, not typed: one svg per row',
      navIcons().every((node) => node.children?.[0]?.type === 'svg'),
      JSON.stringify(navIcons().map((node) => node.children?.[0]?.type)),
    )
    check(
      'the rail draws on the reference grid, with its stroke and round joins',
      navIcons().every((node) => {
        const svg = node.children[0].props
        return svg.viewBox === '0 0 24 24' && svg.strokeWidth === 2 && svg.strokeLinecap === 'round' && svg.strokeLinejoin === 'round'
      }),
      JSON.stringify(
        navIcons().slice(0, 2).map((node) => {
          const svg = node.children[0].props
          return [svg.viewBox, svg.strokeWidth, svg.strokeLinecap, svg.strokeLinejoin]
        }),
      ),
    )
    // The reference is line art: nothing in the rail may carry a translucent
    // body the way the old family's tiles did. A solid dot (the key's ward) is
    // part of the drawing, not a body, so the test pins the tint and not the
    // fill.
    check(
      'no rail mark carries a tinted body: the reference is line art',
      navIcons().every((node) => node.children[0].children.every((shape) => shape.props.fillOpacity === undefined)),
      JSON.stringify(navIcons().map((node) => node.children[0].children.length)),
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

  // ── a read that never lands must not hold the rail hostage ────────────────
  // The reported bug: a first load showed the entries already listed under a
  // sidebar stuck on its ghost block, the status still reading "未同步". The
  // two background reads used to sit in one `Promise.all`, which made the
  // slower one the gate for the faster one: `folders` feeds only the
  // move-to-folder step, but a folders call that never settled held the
  // already-arrived `overview` hostage, so `setOverview` never ran and the rail
  // never left `!overview`. The overview had succeeded; no retry or timeout on
  // the overview could have helped. Each read now settles on its own.
  {
    const hangRpc = makeRpc({ folders: () => new Promise(() => {}) })
    const panel = await mountPanel(mod, {}, hangRpc)
    await flush(300)
    const rail = panel.renderer.root.findAll((node) => node.props?.['data-vw-nav'] === '')[0]
    const railRows = () => rail.findAll((node) => node.props?.['data-vw-section'] !== undefined)
    const railGhosts = () => rail.findAll((node) => node.props?.['data-vw-skeleton'] !== undefined)
    const rows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')
    check(
      'a folders read that never answers does not freeze the rail on its placeholder',
      Boolean(rail) && railGhosts().length === 0 && railRows().length === 9,
      'ghosts=' + railGhosts().length + ' rows=' + railRows().length,
    )
    check('the rail stops claiming to be busy once the overview landed', rail?.props?.['aria-busy'] === undefined, JSON.stringify(rail?.props?.['aria-busy']))
    check('the entries the reader came for are on screen', rows().length > 0, 'rows=' + rows().length)
    await act(async () => { panel.renderer.unmount() })
  }

  // ── the rail counts in one shape, then fills it ───────────────────────────
  // Reported: on a first load the sidebar showed 全部条目 / 收藏 / 验证码 as
  // three finished rows above a block of skeleton bars — "单独显示出来有点突兀".
  // The three were drawn for real because they need no count, and everything
  // else was ghosted because it does; the seam between the two is what the eye
  // caught. So the rail is one object while it is counting: every slot is a
  // ghost, in the real row's own metrics, and the answer replaces it slot for
  // slot.
  //
  // Two things are asserted here, and the second is the one that makes the
  // swap invisible rather than merely tidy: the ghost rows measure what the
  // real rows measure (same padding, gap, icon box, label strut, count pill),
  // so the rail's box is already the height it will end at.
  {
    const base = makeRpc()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const rpc = makeRpc({ overview: () => gate.then(() => base.call('/api', 'vw/overview', { args: {} })) })
    const panel = await mountPanel(mod, {}, rpc)
    await flush(200)
    const rail = () => panel.renderer.root.findAll((node) => node.props?.['data-vw-nav'] === '')[0]
    const ghosts = () => rail().findAll((node) => node.props?.['data-vw-ghost-row'] !== undefined)
    const ghostHeads = () => rail().findAll((node) => node.props?.['data-vw-ghost-group'] !== undefined)
    const places = () => rail().findAll((node) => node.props?.['data-vw-section'] !== undefined)

    check(
      'while counting, the rail draws no finished rows at all',
      places().length === 0,
      'places=' + places().length,
    )
    check(
      'the rail is one skeleton: every slot, including the three structural places',
      ghosts().length === 9 && ghostHeads().length === 2,
      'rows=' + ghosts().length + ' heads=' + ghostHeads().length,
    )
    check('the counting rail says it is busy', rail()?.props?.['aria-busy'] === 'true', JSON.stringify(rail()?.props?.['aria-busy']))
    const ghostRowStyle = ghosts()[0].props.style
    const ghostIconBox = ghosts()[0].findAll((node) => node.props?.style?.width === 16)[0]
    check(
      'a ghost row borrows the real row\u2019s metrics, not a guessed height',
      ghostRowStyle.gap === 8 && ghostRowStyle.padding === '9px 12px' && ghostRowStyle.fontSize === 14 && Boolean(ghostIconBox),
      JSON.stringify({ gap: ghostRowStyle.gap, padding: ghostRowStyle.padding, fontSize: ghostRowStyle.fontSize, icon: Boolean(ghostIconBox) }),
    )

    // The answer lands. Same slot count, so the rail does not resize; the
    // ghosts go away in the same frame rather than fading out underneath.
    await act(async () => { release(); await sleep(80) })
    await flush(200)
    check(
      'the answer replaces the ghosts in one frame, with none left behind',
      places().length === 9 && ghosts().length === 0 && ghostHeads().length === 0,
      'places=' + places().length + ' ghosts=' + ghosts().length + ' heads=' + ghostHeads().length,
    )
    check('the filled rail stops claiming to be busy', rail()?.props?.['aria-busy'] === undefined, JSON.stringify(rail()?.props?.['aria-busy']))
    const realRowStyle = places()[0].props.style
    check(
      'the ghost slot and the real row it becomes measure the same',
      realRowStyle.gap === ghostRowStyle.gap && realRowStyle.padding === ghostRowStyle.padding && realRowStyle.fontSize === ghostRowStyle.fontSize,
      JSON.stringify({ real: { gap: realRowStyle.gap, padding: realRowStyle.padding }, ghost: { gap: ghostRowStyle.gap, padding: ghostRowStyle.padding } }),
    )
    await act(async () => { panel.renderer.unmount() })
  }

  // The rail is chrome, not content: it has no arrival to animate. It used to
  // stagger its rows 18ms apart like a page of entries, but every frame that
  // re-inserted the rail replayed that arrival — the phone's drill state did
  // exactly that on 返回列表, so the sidebar looked like it flashed. The staged
  // arrival belongs to the entry rows, which really are new.
  {
    const sheet = mod.__panelSheet?.() ?? panelSheetText
    check(
      'the rail does not animate its rows in (no arrival to replay)',
      !/\[data-vw-nav\] > \[[^{]*\{[^}]*animation:/.test(sheet) &&
        !/\[data-vw-nav\] > \*:nth-child\(\d+\)\s*\{[^}]*animation-delay/.test(sheet),
      'an arrival animation is back on the rail rows',
    )
    check(
      'the entry list keeps the panel\u2019s one staggered arrival',
      /\[data-vw-list\] > \[data-row\]:nth-child\(2\)\s*\{ animation-delay: 18ms \}/.test(sheet),
      'the entry rows lost their stagger (the rail was supposed to give it up, not take it with it)',
    )
    check(
      'the rail\u2019s own height is not animated (auto \u2192 auto cannot ease)',
      !/\[data-vw-nav\]\s*\{[^}]*transition:\s*height/.test(sheet),
      'a height transition is back on the rail',
    )
  }

  // ── the three motions the panel gained, and their exits ──────────────────
  // Each one is a small piece of feedback that has to survive two conditions:
  // the island must not exist for a finger, and none of it may run for a reader
  // who asked for less motion.
  {
    const sheet = mod.__panelSheet?.() ?? panelSheetText
    check(
      'the island is revealed by hover, and is not a target for a finger',
      /@media \(hover: hover\)/.test(sheet) && /\[data-row\] \[data-vw-row-actions\] \{ display: none \}/.test(sheet),
      'the island is not gated on a hover-capable pointer',
    )
    check(
      'the confirmation is a shape change on the glyph',
      /\[data-vw-copied="true"\] svg \{ animation: vw-tick/.test(sheet),
      'the tick morph is not hooked up',
    )
    check(
      'the sync dot breathes only when it has a state worth breathing',
      /\[data-vw-sync-dot="ok"\][\s\S]{0,90}vw-breathe/.test(sheet) && !/\[data-vw-sync-dot="idle"\]/.test(sheet),
      'the breathing dot is either missing or applied to every tone',
    )
    check(
      'reduced motion drops the new arrivals too',
      /prefers-reduced-motion[\s\S]*\[data-vw-copied="true"\] svg/.test(sheet) && /prefers-reduced-motion[\s\S]*\[data-vw-sync-dot\]::after/.test(sheet),
      'the new animations are not in the reduced-motion whitelist',
    )
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
    check('the row offers a copy control', tCopy()?.props?.title === '复制动态码', String(tCopy()?.props?.title))
    // The code place is deliberately untouched: its row keeps the single tail it
    // was designed around (ring, grouped code, one copy button) and must not pick
    // up the account/password island that ordinary rows now wear.
    check('a code row keeps its own tail and takes no island', tRows()[0].findAll((node) => node.props?.['data-vw-row-actions'] === '').length === 0 && tRows()[0].findAllByType('button').length === 1)
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
    const notConfiguredError = { ok: false, error: { code: 'not_configured', message: '密码库尚未配置完整' } }
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

  // ── scroll position: a section switch may not remount the scroll area ────
  // A switch to a place whose rows are not cached flips the panel through
  // refreshing and back. The surface wrapper used to key on the raw status,
  // so those flips swapped the whole pane — scroll container included — and
  // the reader's position jumped to the top (reported: 下滑后点「未归类」回到
  // 顶部). The wrapper now keys ready/refreshing/loading as one 'vault'
  // surface, so the container instance survives every flip.
  {
    const panel = await mountPanel(mod, {}, makeRpc())
    await flush()
    const scrollArea = () => panel.renderer.root.findAll((node) => node.props?.['data-scroll-area'] === '')[0]
    const before = scrollArea()
    check('the scroll area is on screen after the first read', Boolean(before))
    // The same instance the whole time the panel sits still.
    await flush()
    check('a quiet repaint keeps the scroll container', scrollArea() === before)
    // Switch to 未归类 — a place with no cached section — and let the real
    // read run its full refreshing → ready round trip.
    const unfiled = panel.renderer.root.findAll((node) => node.props?.['data-vw-section'] === 'unfiled')[0]
    check('the 未归类 place is on screen', Boolean(unfiled))
    await act(async () => { unfiled.props.onClick() })
    await flush()
    await flush()
    check(
      'a section switch keeps the scroll container mounted',
      scrollArea() === before,
      'container remounted across the switch',
    )
    // And a second switch (back to 全部条目) through the now-populated cache.
    const all = panel.renderer.root.findAll((node) => node.props?.['data-vw-section'] === 'all')[0]
    await act(async () => { all.props.onClick() })
    await flush()
    check('switching back keeps the container too', scrollArea() === before)
    await act(async () => { panel.renderer.unmount() })
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

  // ── a host that cannot count: the sidebar keeps its three fixed places ────
  // vw/overview is newer than the rest of the host half. A page served by an
  // older host must still open the vault, so the menu falls back to the places
  // that need no counts rather than to a menu of guesses.
  //
  // "No counts" means 全部条目 / 收藏 / 验证码 — not 全部条目 alone. Those three
  // exist in every vault whatever the numbers say, and drawing only the first
  // one made the sidebar render one row and then grow to ten a moment later
  // (measured 48px → 418px): that reflow is the flicker the panel was reported
  // for, and no transition can hide a box that changes its mind. What waits for
  // the overview is the data underneath — the type and folder groups — because
  // a group that does not exist must not hold an empty slot.
  {
    const panel = await mountPanel(mod, {}, makeRpc({ overview: () => ({ ok: false, error: { code: 'not_found', message: 'vw.overview unknown' } }) }))
    const navRows = () => panel.renderer.root.findAll((node) => node.props && node.props['data-vw-section'] !== undefined)
    const rows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')
    check('an uncounted host still opens the vault', rows().length === ITEM_COUNT, 'rows=' + rows().length)
    const keys = navRows().map((node) => node.props['data-vw-section'])
    check(
      'the sidebar keeps the three places that need no counts',
      keys.join(',') === 'all,favorites,totp',
      JSON.stringify(keys),
    )
    // The count pill renders nothing at all when the number is unknown. A 0
    // there would be a statement the panel cannot make yet.
    const pillOf = (node) => {
      const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children]
      return kids.map((child) => (child && child.props ? child.props.children : null)).filter((value) => value !== null && value !== undefined)
    }
    check(
      'the countless places carry no invented zero',
      navRows().slice(1).every((node) => pillOf(node).every((value) => String(value) !== '0')),
      navRows().slice(1).map((node) => pillOf(node).map(String).join('|')).join(' ; '),
    )
    // And the data-driven places are genuinely absent, not blank rows.
    check('no type or folder group is drawn without an overview', !JSON.stringify(panel.renderer.toJSON()).includes('文件夹 ('), '')
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

    check('a writable panel offers edit, archive, trash and move', actionButtons().sort().join(',') === 'archive,edit,move,trash', actionButtons().join(','))

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

  // ── the editor: one draft, one diff, one save ─────────────────────────────
  // The reported gap: the panel could archive, trash and move an entry but
  // could not change what was inside it. The editor opens on the detail's
  // 编辑 button (and on the toolbar's 新建条目 for a new one), reads the whole
  // record over vw/draft, and saves only the fields that changed.
  {
    const writes = []
    const drafts = []
    const syncs = []
    const editorRpc = makeRpc({
      boot: () => bootWith({ ...CONFIG_VALUE, accessMode: 'ask' }, true, AUTHED_SESSION),
      folders: () => ({ ok: true, value: { folders: [{ id: 'folder-work', name: '工作', count: 1 }], total: 1, unfiled: 3, hint: 'folderList' } }),
      draft: (args) => {
        drafts.push(args)
        return { ok: true, value: DRAFTS[args.id] ?? { error: 'not_found' } }
      },
      update: (args) => {
        writes.push({ method: 'update', args })
        return { ok: true, value: { id: args.id, name: args.input?.name ?? 'x', updated: true, revisionDate: '2026-10-14T00:00:00.000Z' } }
      },
      create: (args) => {
        writes.push({ method: 'create', args })
        return { ok: true, value: { id: 'item-new', name: args.input?.name ?? 'x', type: args.input?.type ?? 'login', created: true, revisionDate: '2026-10-14T00:00:00.000Z' } }
      },
      sync: () => {
        syncs.push(true)
        return { ok: true, value: { ok: true, items: 3 } }
      },
    })
    const panel = await mountPanel(mod, {}, editorRpc)
    const nodeWith = (key, value = '') => panel.renderer.root.findAll((node) => node.props?.[key] === value)
    const eText = () => JSON.stringify(panel.renderer.toJSON())
    const eRows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')
    const editorNode = () => panel.renderer.root.findAll((node) => node.props?.['data-vw-editor'] !== undefined)[0]
    const editorInput = (label) => panel.renderer.root.findAllByType('input').find((node) => node.props['aria-label'] === label)
    const editorTextarea = (label) => panel.renderer.root.findAllByType('textarea').find((node) => node.props['aria-label'] === label)
    const fieldValue = (key) => {
      const node = panel.renderer.root.findAll((n) => n.props?.['data-vw-editor-field'] === key)[0]
      if (!node) return undefined
      const walk = (current) => {
        if (current == null) return undefined
        if (typeof current === 'string' || typeof current === 'number') return String(current)
        if (Array.isArray(current)) return current.map(walk).find((entry) => entry !== undefined)
        return walk(current.children)
      }
      return walk(node)
    }

    await act(async () => { eRows()[0].props.onClick() })
    await act(async () => { await sleep(50) })

    // Opening: the draft is asked for, and the form is filled from it.
    await act(async () => { nodeWith('data-vw-action', 'edit')[0].props.onClick() })
    await act(async () => { await sleep(50) })
    check('edit asks the host for the whole record', drafts.length === 1 && drafts[0].id === 'item-1', JSON.stringify(drafts))
    check('the editor replaces the detail, not a section of it', Boolean(editorNode()) && nodeWith('data-vw-detail').length === 1)
    check('the editor fills the form from the draft', editorInput('名称').props.value === 'GitHub 工作账号' && editorInput('用户名').props.value === 'octocat@example.com', String(editorInput('用户名')?.props.value))
    check('the password field is a password field', editorInput('密码').props.type === 'password' && editorInput('密码').props.value === 'gh-p@ssw0rd-42')
    // A single-line input: a URL is one line, and a 66px textarea under a
    // short label read as a chunky empty slab on a phone.
    check('the URI list is a single-line input', editorInput('网址').props.type === 'text' && editorInput('网址').props.value === 'https://github.com/login', String(editorInput('网址')?.props.value))
    check('the draft totp seed is not echoed back as a value', editorInput('验证码密钥（otpauth:// 或 Base32）').props.value === '')
    check('the editor names what it will not touch', eText().includes('保存时会原样保留'))

    // A save sends only the fields that changed: the untouched username is
    // absent, and the passkeys/attachments/history the form never showed are
    // not touched at all.
    await act(async () => { editorInput('用户名').props.onChange({ target: { value: 'new-user@example.com' } }) })
    await act(async () => { editorInput('名称').props.onChange({ target: { value: 'GitHub 主账号' } }) })
    await act(async () => { panel.renderer.root.findAll((n) => n.props?.['data-vw-editor-save'] !== undefined)[0].props.onClick() })
    await act(async () => { await sleep(60) })
    check('saving writes the changed fields', writes.length === 1 && writes[0].method === 'update' && writes[0].args.id === 'item-1', JSON.stringify(writes[0]?.args))
    const savedInput = writes[0]?.args?.input ?? {}
    check('the save names the username and the name', savedInput.username === 'new-user@example.com' && savedInput.name === 'GitHub 主账号', JSON.stringify(savedInput))
    check('an untouched password is not resent', !('password' in savedInput))
    check('an untouched TOTP seed is not resent', !('totp' in savedInput))
    check('the fields are flat, never nested under a patch', Object.keys(savedInput).every((key) => !['patch', 'input'].includes(key)))
    // The panel used to run a SECOND full sync here, after the write path had
    // already synced — that is the wait the reader spent staring at a form that
    // had in fact been saved. Syncing the write is the host's job now.
    check('the save does not run a second sync of its own', syncs.length === 0, String(syncs.length))
    check('the editor reports the save', eText().includes('已保存'))
    check('the editor says the sync finished', eText().includes('已同步到服务器'))
    check('the save left the editor open on the entry', Boolean(editorNode()))


    // Escape steps back out of the editor before it steps out of the card — a
    // reader who opened the wrong entry should not lose the card underneath as
    // well. Only after the editor is gone does another Escape close the card.
    check('Escape is claimed while the editor is open', press('Escape') === true)
    await act(async () => { await sleep(40) })
    check('Escape closes the editor, not the card', !editorNode() && nodeWith('data-vw-detail').length === 1)
    check('a card is still open for the second Escape', press('Escape') === true)
    await act(async () => { await sleep(40) })
    check('the second Escape closes the card', nodeWith('data-vw-detail').length === 0)
    // A conflict: the host refuses a write whose own copy moved on, and the
    // editor must say so rather than offering a retry that would overwrite.
    const conflictRpc = makeRpc({
      boot: () => bootWith({ ...CONFIG_VALUE, accessMode: 'ask' }, true, AUTHED_SESSION),
      update: () => {
        const error = new Error('条目已被其他客户端修改，请重新读取后再试')
        error.code = 'stale_revision'
        throw error
      },
    })
    const conflicted = await mountPanel(mod, {}, conflictRpc)
    await act(async () => { conflicted.renderer.root.findAll((n) => n.props?.role === 'option')[0].props.onClick() })
    await act(async () => { await sleep(50) })
    await act(async () => { conflicted.renderer.root.findAll((n) => n.props?.['data-vw-action'] === 'edit')[0].props.onClick() })
    await act(async () => { await sleep(50) })
    // A field must actually change: a save that changes nothing is short-circuited
    // to 没有改动 and never reaches the host, so there would be no conflict to report.
    await act(async () => {
      conflicted.renderer.root.findAllByType('input').find((n) => n.props['aria-label'] === '用户名').props.onChange({ target: { value: 'conflict@example.com' } })
    })
    await act(async () => { conflicted.renderer.root.findAll((n) => n.props?.['data-vw-editor-save'] !== undefined)[0].props.onClick() })
    await act(async () => { await sleep(60) })
    const conflictText = () => JSON.stringify(conflicted.renderer.toJSON())
    check('a stale write is reported as a conflict', conflictText().includes('已被其他客户端修改'))
    check('a conflicted editor stops offering the save', Boolean(conflicted.renderer.root.findAll((n) => n.props?.['data-vw-editor-save'] !== undefined)[0]?.props.disabled))
    check('a conflicted editor explains what to do', conflictText().includes('重新打开编辑器'))
    await act(async () => { conflicted.renderer.unmount() })

    // New entries: the toolbar button opens a blank form, and the save is a
    // create. The type selector rebuilds the form, so switching to a card
    // entry offers card fields and not a password.
    await act(async () => { panel.renderer.unmount() })
    const creatorRpc = makeRpc({
      boot: () => bootWith({ ...CONFIG_VALUE, accessMode: 'auto' }, true, AUTHED_SESSION),
      create: (args) => {
        writes.push({ method: 'create', args })
        return { ok: true, value: { id: 'item-new', name: args.input?.name ?? 'x', type: args.input?.type ?? 'login', created: true, revisionDate: '2026-10-14T00:00:00.000Z' } }
      },
      sync: () => {
        syncs.push(true)
        return { ok: true, value: { ok: true, items: 3 } }
      },
    })
    const creator = await mountPanel(mod, {}, creatorRpc)
    const cText = () => JSON.stringify(creator.renderer.toJSON())
    const cNodeWith = (key, value = '') => creator.renderer.root.findAll((node) => node.props?.[key] === value)
    // The editor lives in the detail pane, which sits AFTER the list in the
    // tree. On a narrow panel the list is thousands of pixels tall, so without
    // the drill flag the form opened far below the fold and the + that opened
    // it vanished from the toolbar — the button worked and looked broken.
    // Asserted on the flag itself, because the layout that consumes it is CSS.
    const drillFlag = () => creator.renderer.root.findAll((node) => node.props?.['data-vw-body'] !== undefined)[0]?.props['data-vw-drill']
    check('the list keeps the column while nothing is open', drillFlag() === undefined, String(drillFlag()))
    await act(async () => { cNodeWith('data-vw-new')[0].props.onClick() })
    check('the new-entry button opens a blank editor', cNodeWith('data-vw-editor').length === 1 && cText().includes('新建条目'))
    check('the editor is opened in the drill state once it exists', drillFlag() === '1', String(drillFlag()))
    check('a blank editor asks for a name before it saves', Boolean(cNodeWith('data-vw-editor-save')[0]))
    // The settings glyph must read as a GEAR, not as a sun. The previous
    // version was a hub circle with eight detached spokes, which is the sun
    // glyph at 14px; a gear's teeth are part of the outline, which is what
    // makes the difference visible. Asserted structurally: the glyph is a hub
    // plus ONE closed outline with no detached radial strokes.
    const settingsBtn = () => creator.renderer.root.findAll((n) => n.type === 'button' && n.props['aria-label'] === '设置')[0]
    check('the settings action is still a single labelled button', Boolean(settingsBtn()))
    const glyphPaths = () => {
      const svg = settingsBtn()?.findAllByType('svg')[0]
      return svg ? { hub: svg.findAllByType('circle').map((c) => c.props.r), paths: svg.findAllByType('path').map((p) => p.props.d) } : null
    }
    const gear = glyphPaths()
    check('the gear glyph is a hub plus one closing outline', Boolean(gear) && gear.hub.length === 1 && gear.paths.length === 1, JSON.stringify(gear))
    check(
      'the outline is a single closed path (teeth are the rim, not spokes)',
      Boolean(gear) && gear.paths[0].trimEnd().endsWith('Z') && (gear.paths[0].match(/M/g) ?? []).length === 1,
      gear?.paths?.[0]?.slice(0, 60),
    )
    // SVG line-to repeats its command implicitly, so counting `L` sees only
    // the first one. Count the POINTS instead: each tooth contributes two
    // outer corners and two root corners, so eight teeth is 32 points.
    const gearPoints = (gear?.paths?.[0] ?? '').replace(/[MLZ]/g, ' ').trim().split(/\s+/).filter(Boolean).length / 2
    check('the outline has eight teeth around the hub', gearPoints === 32, String(gearPoints) + ' points')
    // The three toolbar actions are icon-only: their labels live in title and
    // aria-label, and each carries the 16×16 glyph from the shared table.
    check('the toolbar actions are icon-only, each with an accessible name', (() => {
      const glyphs = creator.renderer.root.findAll((n) => n.type === 'svg' && n.props.viewBox === '0 0 16 16')
      const named = creator.renderer.root.findAll((n) => n.type === 'button' && typeof n.props['aria-label'] === 'string')
      return glyphs.length >= 3 && named.length >= 3
    })(), JSON.stringify(creator.renderer.root.findAll((n) => n.type === 'button').map((b) => b.props['aria-label'])))
    const nameInput = () => creator.renderer.root.findAllByType('input').find((node) => node.props['aria-label'] === '名称')
    await act(async () => { nameInput().props.onChange({ target: { value: '' } }) })
    await act(async () => { cNodeWith('data-vw-editor-save')[0].props.onClick() })
    check('a nameless entry is refused without a round trip', writes.filter((w) => w.method === 'create').length === 0 && cText().includes('请填写条目名称'))

    await act(async () => { nameInput().props.onChange({ target: { value: '新数据库口令' } }) })
    await act(async () => { cNodeWith('data-vw-editor-save')[0].props.onClick() })
    await act(async () => { await sleep(60) })
    const created = writes.filter((w) => w.method === 'create').at(-1)
    check('a new entry is created with the typed name', created?.args?.input?.name === '新数据库口令', JSON.stringify(created?.args))
    check('a new entry is created as a login', created?.args?.input?.type === 'login')
    check('a created entry does not run a second sync either', syncs.length === 0, String(syncs.length))
    check('the editor closes once the entry exists', cNodeWith('data-vw-editor').length === 0)

    // The type selector rebuilds the form: a card entry gets card fields, and
    // the login-only controls are gone.
    await act(async () => { cNodeWith('data-vw-new')[0].props.onClick() })
    const typeSelect = () => creator.renderer.root.findAllByType('select').find((node) => node.props['aria-label'] === '类型')
    check('the creator offers every entry type', typeSelect().props.children.length === 5, String(typeSelect().props.children.length))
    await act(async () => { typeSelect().props.onChange({ target: { value: 'card' } }) })
    const cardLabels = () => creator.renderer.root.findAll((node) => node.props?.['data-vw-editor-field'] !== undefined).map((node) => node.props['data-vw-editor-field'])
    check('switching to a card rebuilds the form around card fields', cardLabels().includes('number') && cardLabels().includes('code') && !cardLabels().includes('password'), cardLabels().join(','))
    const cardNumber = () => creator.renderer.root.findAll((node) => node.props?.['data-vw-editor-field'] === 'number')[0]
    check('the card number field is masked while typing', Boolean(cardNumber()))
    await act(async () => { typeSelect().props.onChange({ target: { value: 'identity' } }) })
    check('switching to an identity rebuilds it again', cardLabels().includes('firstName') && cardLabels().includes('lastName') && !cardLabels().includes('number'), cardLabels().join(','))
    await act(async () => { typeSelect().props.onChange({ target: { value: 'sshKey' } }) })
    check('switching to an SSH key offers the key material', cardLabels().includes('privateKey') && cardLabels().includes('publicKey'), cardLabels().join(','))
    await act(async () => { typeSelect().props.onChange({ target: { value: 'secureNote' } }) })
    check('a secure note keeps only the body', cardLabels().join(',') === 'notes', cardLabels().join(','))
    await act(async () => { creator.renderer.unmount() })

    // A reprompt entry cannot be edited from here: the host answers the draft
    // with a stub, and the panel says the gate is in the way.
    const lockedRpc = makeRpc({
      boot: () => bootWith({ ...CONFIG_VALUE, accessMode: 'ask' }, true, AUTHED_SESSION),
      reveal: () => ({ ok: true, value: { id: 'item-3', name: '需要重新验证的条目', type: 'login', repromptRequired: true } }),
    })
    // The gate is the detail, and the editor is only reachable through the
    // unlock window the master password opens. What is asserted here is the
    // half of the contract that must hold *before* that: while the entry is
    // locked there is no form, no save, and no way to reach the editor.
    const locked = await mountPanel(mod, {}, lockedRpc)
    await act(async () => { locked.renderer.root.findAll((n) => n.props?.role === 'option')[2].props.onClick() })
    await act(async () => { await sleep(50) })
    const lockedText = () => JSON.stringify(locked.renderer.toJSON())
    check('a locked entry shows the gate, not the write actions', locked.renderer.root.findAll((n) => n.props?.['data-vw-action'] === 'edit').length === 0)
    check('a locked entry opens no form', locked.renderer.root.findAll((n) => n.props?.['data-vw-editor'] !== undefined).length === 0)
    check('a locked entry offers no save', locked.renderer.root.findAll((n) => n.props?.['data-vw-editor-save'] !== undefined).length === 0)
    await act(async () => { locked.renderer.unmount() })

    // Once the master password has opened the window, the editor becomes
    // reachable from the gate itself — and the host answers a draft for a
    // still-gated entry with a stub, never the plaintext.
    const stubRpc = makeRpc({
      boot: () => bootWith({ ...CONFIG_VALUE, accessMode: 'ask' }, true, AUTHED_SESSION),
      repromptGrant: () => ({ ok: true, value: { granted: true, remainingMs: 300000 } }),
      draft: () => ({ ok: true, value: DRAFTS['item-3'] }),
      reveal: () => ({ ok: true, value: { id: 'item-3', name: '需要重新验证的条目', type: 'login', repromptRequired: true } }),
    })
    const stub = await mountPanel(mod, {}, stubRpc)
    await act(async () => { stub.renderer.root.findAll((n) => n.props?.role === 'option')[2].props.onClick() })
    await act(async () => { await sleep(80) })
    check('the unlock window opens the editor from the gate', stub.renderer.root.findAll((n) => n.props?.['data-vw-action'] === 'edit').length === 1)
    await act(async () => { stub.renderer.root.findAll((n) => n.props?.['data-vw-action'] === 'edit')[0].props.onClick() })
    await act(async () => { await sleep(60) })
    const stubText = () => JSON.stringify(stub.renderer.toJSON())
    check('a stub draft fills no form', stub.renderer.root.findAllByType('input').every((node) => node.props['aria-label'] !== '名称'))
    check('a stub draft says the master password is in the way', stubText().includes('需要先输入主密码解锁'))
    check('a stub draft offers no save', stub.renderer.root.findAll((n) => n.props?.['data-vw-editor-save'] !== undefined).length === 0)
    await act(async () => { stub.renderer.unmount() })

    // readonly: the button is not offered at all, and the panel says why.
    const readonlyRpc = makeRpc({
      boot: () => bootWith({ ...CONFIG_VALUE, accessMode: 'readonly' }, true, AUTHED_SESSION),
    })
    const readonlyPanel = await mountPanel(mod, {}, readonlyRpc)
    check('a readonly panel offers no new-entry button', readonlyPanel.renderer.root.findAll((n) => n.props?.['data-vw-new'] !== undefined).length === 0)
    await act(async () => { readonlyPanel.renderer.root.findAll((n) => n.props?.role === 'option')[0].props.onClick() })
    await act(async () => { await sleep(50) })
    check('a readonly panel offers no edit action', readonlyPanel.renderer.root.findAll((n) => n.props?.['data-vw-action'] === 'edit').length === 0)
    check('a readonly panel explains the missing edit', JSON.stringify(readonlyPanel.renderer.toJSON()).includes('当前为只读模式'))
    await act(async () => { readonlyPanel.renderer.unmount() })
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
    await act(async () => { pButtons().find((node) => node.props.title === '读取这一项').props.onClick() })
    await act(async () => { await sleep(50) })
    check('the card body arrives only when that field is asked for', cardRpc.calls.some((call) => call.method === 'reveal' && call.args.field === 'card'))
    check('the card number is masked to its last four', pText().includes('•••• •••• •••• 1111') && !pText().includes('4111111111111111'))
    check('the cardholder name shows in the clear', pText().includes('张伟'))
    await act(async () => { pButtons().find((node) => node.props.title === '显示').props.onClick() })
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
    await act(async () => { panel.renderer.root.findAllByType('button').find((node) => node.props.title === '读取这一项').props.onClick() })
    await act(async () => { await sleep(50) })
    check('the public key is shown in the clear once the field is read', pText().includes('ssh-ed25519'))
    check('the private key stays masked', pText().includes('●●●●●●●●') && !pText().includes('BEGIN OPENSSH'))
    await act(async () => { panel.renderer.root.findAllByType('button').find((node) => node.props.title === '显示').props.onClick() })
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

  // ── the transcript row: secrets never reach the conversation surface ──────
  // The model-facing result is plaintext by design, so the card is the only
  // thing standing between a password and a screenshot / session log. These
  // checks are the security contract: the row must render, must show WHICH
  // entry and field were touched, and must never render the value.
  {
    const H = react.createElement
    const renderToolRow = (toolName, args, resultText, isError = false) => {
      const element = H(mod.__toolRow.component, {
        toolName,
        block: {
          kind: 'tool-result',
          call: { name: toolName, argsRaw: JSON.stringify(args ?? {}) },
          content: resultText === null ? [] : [{ type: 'text', text: resultText }],
          isError,
        },
        t: (key) => dictionaries.zh[key] ?? key,
      })
      let renderer
      act(() => { renderer = create(element) })
      // The row opens collapsed, like the host's own tool cards: the visible
      // line is the summary, and the payload is one click away. The assertions
      // below expand it, because that is what a reader sees when they look — and
      // a secret reachable by clicking is still a secret on screen.
      const toggle = renderer.root.findAll((node) => node.props?.['data-vw-tool-toggle'] !== undefined)[0]
      act(() => { toggle.props.onClick() })
      const json = renderer.toJSON()
      renderer.unmount()
      return json
    }
    const rowKeys = Object.keys(mod.__toolRow.keys ?? {})
    check('every bitwarden tool has a transcript row registered', rowKeys.length === 11 && rowKeys.every((k) => k.startsWith('bitwarden_')), rowKeys.join(','))
    const rows = renderToolRow('bitwarden_get', {
      id: 'item-1',
      name: 'github.com',
      field: 'password',
    }, JSON.stringify({ id: 'item-1', name: 'github.com', type: 'login', username: 'octocat@example.com', password: 'hunter2-secret', uris: ['https://github.com/login'] }, null, 2))
    const rowText = JSON.stringify(rows)
    check('the row names the tool and the entry', rowText.includes('读取凭据') && rowText.includes('github.com'), rowText.slice(0, 200))
    check('NEGATIVE CONTROL: the plaintext password is nowhere in the row', !rowText.includes('hunter2-secret'))
    check('the password is replaced by dots', rowText.includes('••••••••'))
    check('the identifier fields still read normally', rowText.includes('octocat@example.com') && rowText.includes('item-1'))
    // The row does not announce the masking: the dots in the body are the only
    // signal. The assertions name the WORDS a note would use, not a bare
    // "hidden" — the serialized tree carries the inline styles, where
    // `overflow: "hidden"` is a CSS keyword and would match every row.
    const MASKING_NOTES = ['已隐藏', '敏感值', '脱敏', 'Passwords and other', 'secrets hidden']
    check('the row does not advertise that it masked anything',
      MASKING_NOTES.every((note) => !rowText.includes(note)))

    // A create carries the password in its ARGUMENTS, which the row also draws.
    const createRow = JSON.stringify(renderToolRow('bitwarden_create', { name: '新站点', username: 'u', password: 'arg-secret-1' }, JSON.stringify({ id: 'n1', name: '新站点', type: 'login' })))
    check('NEGATIVE CONTROL: a password in the arguments is masked too', !createRow.includes('arg-secret-1') && createRow.includes('••••••••'))
    check('the new entry is still named', createRow.includes('新站点'))

    // TOTP, card, identity and SSH shapes: each is a separate secret class the
    // plugin can return under its own field name.
    const totpRow = JSON.stringify(renderToolRow('bitwarden_get', { id: 'x', field: 'totp' }, JSON.stringify({ id: 'x', name: 'x', totp: '986029' })))
    check('NEGATIVE CONTROL: a live TOTP code is masked', !totpRow.includes('986029'))
    const cardRow = JSON.stringify(renderToolRow('bitwarden_get', { id: 'x', field: 'card' }, JSON.stringify({ id: 'x', card: { cardholderName: '张三', brand: 'Visa', number: '4111111111111111', code: '321' } })))
    check('NEGATIVE CONTROL: card number and security code are masked', !cardRow.includes('4111111111111111') && !cardRow.includes('321'))
    check('the cardholder name is still readable', cardRow.includes('张三'))
    const sshRow = JSON.stringify(renderToolRow('bitwarden_get', { id: 'x', field: 'sshKey' }, JSON.stringify({ id: 'x', sshKey: { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----', keyFingerprint: 'SHA256:abc' } })))
    check('NEGATIVE CONTROL: the SSH private key is masked', !sshRow.includes('BEGIN OPENSSH'))
    check('the SSH fingerprint stays readable', sshRow.includes('SHA256:abc'))
    const noteRow = JSON.stringify(renderToolRow('bitwarden_get', { id: 'x', field: 'secureNote' }, JSON.stringify({ id: 'x', secureNote: { type: 0, notes: 'a note body that is the secret' } })))
    check('NEGATIVE CONTROL: a secure note body is masked', !noteRow.includes('a note body that is the secret'))
    const fieldRow = JSON.stringify(renderToolRow('bitwarden_get', { id: 'x', field: 'fields' }, JSON.stringify({ id: 'x', fields: [{ name: 'PIN', value: '4321' }] })))
    check('NEGATIVE CONTROL: a custom field value is masked', !fieldRow.includes('4321'))
    check('the custom field name is still readable', fieldRow.includes('PIN'))

    // A search returns no secrets, so its line must read like any other row's —
    // no masking note, because nothing was masked.
    const findRow = JSON.stringify(renderToolRow('bitwarden_find', { query: 'github' }, JSON.stringify({ query: 'github', matched: 1, items: [{ id: 'i1', name: 'github.com', username: 'octocat@example.com', uris: ['https://github.com/login'] }] })))
    check('a search row carries no masking note', !findRow.includes('已隐藏'), findRow.slice(0, 220))
    check('a search row states what it found', findRow.includes('github.com') && findRow.includes('1 条'))
    const failRow = JSON.stringify(renderToolRow('bitwarden_status', {}, null, true))
    check('a failed call is reported as failed', failRow.includes('调用失败'))
  }

  // ── the DETAIL pane masks what it holds ───────────────────────────────────
  // The transcript row was always careful; the pane next to it was not. A note
  // body and every custom-field value were painted as plain text the moment the
  // entry was opened, so a PIN held in a "hidden" custom field and the body of
  // a secure note were on screen for anyone who walked past — and in any
  // screenshot of the panel. Both now start as dots behind the same reveal
  // toggle a card number uses.
  {
    const detailReveal = {
      id: 'item-notes', name: '运维笔记', type: 'login', username: 'ops@example.com',
      password: 'detail-pass-1', hasTotp: false, hasNotes: true,
      notes: 'NOTE-BODY-SECRET',
      fields: [{ name: 'PIN', value: '4321' }, { name: '租户', value: 'jindom' }],
      uris: [], collections: [], folder: null,
    }
    const detailRpc = makeRpc({
      list: () => ({ ok: true, value: { query: '', matched: 1, returned: 1, offset: 0, hasMore: false, vaultItems: 1, items: [{ id: 'item-notes', name: '运维笔记', type: 'login', username: 'ops@example.com', uris: [], folder: null, collections: [], hasTotp: false, hasNotes: true, customFields: ['PIN', '租户'], favorite: false }] } }),
      reveal: () => ({ ok: true, value: detailReveal }),
    })
    const panel = await mountPanel(mod, {}, detailRpc)
    const dText = () => JSON.stringify(panel.renderer.toJSON())
    const dButtons = () => panel.renderer.root.findAllByType('button')
    await act(async () => { panel.renderer.root.findAll((node) => node.props?.role === 'option')[0].props.onClick() })
    await flush()
    check('opening an entry does not print its note body', !dText().includes('NOTE-BODY-SECRET'), dText().slice(0, 240))
    check('opening an entry does not print its custom field values', !dText().includes('4321') && !dText().includes('jindom'))
    check('the custom field name is still readable in the pane', dText().includes('PIN') && dText().includes('租户'))
    check('the masked rows carry a reveal control', dButtons().filter((node) => node.props.title === '显示').length >= 3, String(dButtons().filter((node) => node.props.title === '显示').length))
    // One click on the note's own toggle reveals that row and nothing else.
    // Walk the element tree by hand: a field row's children include component
    // instances, and JSON.stringify on a fiber throws on its circular parent.
    const textOf = (node) => {
      if (node == null) return ''
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      if (Array.isArray(node)) return node.map(textOf).join('')
      return textOf(node.children)
    }
    const fieldRowLabelled = (label) => panel.renderer.root
      .findAll((node) => node.props?.['data-vw-field'] !== undefined)
      .find((node) => textOf(node).startsWith(label))
    const noteToggle = () => fieldRowLabelled('备注').findAllByType('button').find((node) => node.props.title === '显示')
    await act(async () => { noteToggle().props.onClick() })
    check('the note body reveals on demand', dText().includes('NOTE-BODY-SECRET'))
    check('revealing the note does not reveal the custom fields', !dText().includes('4321'))
    await act(async () => { panel.renderer.unmount() })
  }

  // ── the re-prompt window closing takes the plaintext with it ──────────────
  // The expiry path used to clear the reveal flag, the narrow payloads and the
  // editor — and leave `detail` holding the host's full plaintext. The pane
  // went on rendering it, and its own 显示 toggle (which never consulted the
  // grant) put a password straight back on screen after the proof had lapsed.
  // A grant is a window; when it closes the pane has to be behind the gate
  // again, not merely re-masked.
  {
    const gatedView = { id: 'item-3', name: '需要重新验证的条目', type: 'login', uris: [], repromptRequired: true }
    const grantedView = {
      id: 'item-3', name: '需要重新验证的条目', type: 'login', username: 'ops@example.com',
      password: 'EXPIRY-PLAINTEXT', notes: 'EXPIRY-NOTES', hasTotp: false,
      fields: [{ name: 'PIN', value: 'EXPIRY-PIN', type: 1 }], uris: [], collections: [], folder: null,
    }
    let grantState = { granted: false, remainingMs: 0 }
    const expiryRpc = makeRpc({
      boot: () => bootWith({ ...CONFIG_VALUE, accessMode: 'ask' }, true, AUTHED_SESSION),
      // The entry is gated until the reader proves the master password.
      reveal: () => ({ ok: true, value: grantState.granted ? grantedView : gatedView }),
      authorizeReprompt: () => {
        grantState = { granted: true, remainingMs: 300000 }
        return { ok: true, value: { authorized: true, remainingMs: 300000, grantMinutes: 5, view: grantedView } }
      },
      repromptGrant: () => ({ ok: true, value: grantState }),
    })
    const panel = await mountPanel(mod, {}, expiryRpc)
    const xText = () => JSON.stringify(panel.renderer.toJSON())
    const xRows = () => panel.renderer.root.findAll((node) => node.props?.role === 'option')
    const xInput = (type) => panel.renderer.root.findAllByType('input').find((node) => node.props.type === type)
    await act(async () => { xRows()[0].props.onClick() })
    await flush(80)
    check('the gated entry starts behind the gate', xText().includes('EXPIRY-PLAINTEXT') === false)
    // Prove the master password; the host answers with the unlocked view.
    await act(async () => { xInput('password').props.onInput({ target: { value: 'master-password' } }) })
    await act(async () => { panel.renderer.root.findAllByType('button').find((node) => node.props.children === '输入主密码解锁').props.onClick() })
    await flush(120)
    check('the proof opens the pane', xText().includes('EXPIRY-PLAINTEXT'), xText().slice(0, 240))
    // The window lapses while the entry is on screen. One poll tick later the
    // host reports no grant and the pane must stop holding the plaintext.
    grantState = { granted: false, remainingMs: 0 }
    await flush(5200)
    check('EXPIRY: the password leaves the pane when the window closes', !xText().includes('EXPIRY-PLAINTEXT'), xText().slice(0, 260))
    check('EXPIRY: the note body leaves too', !xText().includes('EXPIRY-NOTES'))
    check('EXPIRY: the hidden field value leaves too', !xText().includes('EXPIRY-PIN'))
    check('EXPIRY: the pane is behind the gate again', xText().includes('需要重新验证') || xText().includes('需要主密码') || xText().includes('重新验证'))
    const revealCalls = expiryRpc.calls.filter((call) => call.method === 'reveal').length
    check('EXPIRY: the host is asked again for the gated answer', revealCalls >= 2, String(revealCalls))
    await act(async () => { panel.renderer.unmount() })
  }

  // ── a re-prompt entry has no code to show, anywhere ───────────────────────
  // The 验证码 list was the one read surface that skipped the master-password
  // gate: it asked vw/totp for every row, and a gated entry answered with a
  // live code. The host refuses now; the row must render that refusal as a
  // label and must stop asking every second for a code it cannot have.
  {
    const gatedRpc = makeRpc({
      list: () => ({ ok: true, value: { query: '', matched: 1, returned: 1, offset: 0, hasMore: false, vaultItems: 1, items: [{ id: 'item-gated', name: '需重新验证', type: 'login', username: null, uris: [], folder: null, collections: [], hasTotp: true, hasNotes: false, customFields: [], favorite: false }] } }),
      totp: () => ({ ok: true, value: { id: 'item-gated', name: '需重新验证', repromptRequired: true } }),
    })
    const panel = await mountPanel(mod, {}, gatedRpc)
    const navRow = (key) => panel.renderer.root.findAll((node) => node.props?.['data-vw-section'] === key)[0]
    await act(async () => { navRow('totp').props.onClick() })
    await flush(120)
    const gText = () => JSON.stringify(panel.renderer.toJSON())
    check('a gated code row shows a label, not a code', gText().includes('需重新验证'))
    check('a gated code row offers no copy control', panel.renderer.root.findAll((node) => node.props?.['data-vw-totp-copy'] !== undefined).length === 0)
    const asksBefore = gatedRpc.calls.filter((call) => call.method === 'totp').length
    await flush(1100)
    const asksAfter = gatedRpc.calls.filter((call) => call.method === 'totp').length
    check('a gated code row stops polling every second', asksAfter === asksBefore, `${asksBefore} -> ${asksAfter}`)
    await act(async () => { panel.renderer.unmount() })
  }

  // ── reopening the panel keeps the write tier it was configured with ───────
  // The panel derives `accessMode` from the config the host hands it, and that
  // state starts at 'readonly'. A reopen takes a shortcut past `boot` when the
  // config is already in hand — and the shortcut only carried the config
  // across, so it left the tier at its initial value: a vault configured with
  // accessMode=ask painted no edit or create control at all, on the one path a
  // reader takes most often. The regression is invisible to a single open,
  // which is exactly why it survived the suite.
  {
    const askRpc = makeRpc({ boot: () => bootWith({ ...CONFIG_VALUE, accessMode: 'ask' }, true, AUTHED_SESSION) })
    // The tier reaches the DOM as the write controls themselves.
    const writeControls = (renderer) => renderer.root
      .findAll((node) => node.props && ['edit', 'archive', 'trash', 'move'].includes(node.props['data-vw-action']))
      .map((node) => node.props['data-vw-action'])
    // The create control is icon-only (its words live in title + aria-label),
    // so it is found by its own attribute rather than by its text.
    const newEntryControls = (renderer) => renderer.root
      .findAll((node) => node.props && node.props['data-vw-new'] === '')
      .length

    mod.__resetOpenCache()
    const first = await mountPanel(mod, {}, askRpc)
    const firstRows = () => first.renderer.root.findAll((node) => node.props?.role === 'option')
    await flush()
    await act(async () => { firstRows()[0].props.onClick() })
    await flush()
    const firstOpen = writeControls(first.renderer).sort().join(',')
    check('accessMode=ask: the first open offers the entry write actions', firstOpen.includes('edit'), firstOpen)
    await act(async () => { first.renderer.unmount() })

    // Reopen: `keepCache` is what makes this the reopen a reader performs —
    // mountPanel clears the module cache by default, and clearing it would be a
    // first open with nothing to skip, which is the case that never broke. A
    // fresh rpc log is what makes the no-second-boot assertion meaningful.
    const reopenCalls = askRpc.calls.length
    const second = await mountPanel(mod, {}, askRpc, { keepCache: true })
    const secondRows = () => second.renderer.root.findAll((node) => node.props?.role === 'option')
    await flush()
    await act(async () => { secondRows()[0].props.onClick() })
    await flush()
    const reopened = writeControls(second.renderer).sort().join(',')
    check(
      'accessMode=ask: reopening the panel still offers them',
      reopened.includes('edit'),
      reopened || '(none)',
    )
    check(
      'accessMode=ask: reopening still offers 新建条目',
      newEntryControls(second.renderer) >= 1,
      String(newEntryControls(second.renderer)),
    )
    // And the shortcut really was taken: this reopen asked the host for no
    // session — the round trip the cached config exists to avoid.
    const bootsOnReopen = askRpc.calls.slice(reopenCalls).filter((call) => call.method === 'boot').length
    check('reopening does not re-ask the host for a session', bootsOnReopen === 0, 'boot calls on reopen: ' + String(bootsOnReopen))
    await act(async () => { second.renderer.unmount() })
    mod.__resetOpenCache()
  }

  // ── the second page: passwords, then the masking trail ───────────────────
  // The strip is the host's own tab pattern, and the two pages are ONE
  // surface: switching must not remount the scroll container (a reader's
  // position is the reason that container is stable), must not leave the
  // list's rail or its search box behind on a page that has neither, and
  // must reach the host for the trail's numbers rather than inventing
  // them locally.
  {
    const trailRpc = makeRpc({
      trail: (args) => ({
        ok: true,
        value: {
          range: args.days,
          total: 1557,
          distinct: 853,
          requests: 281,
          days: Array.from({ length: args.days }, (_, index) => ({ day: `2026-10-${String(index + 1).padStart(2, '0')}`, count: index })),
          sessions: [
            { key: '/sessions/aaa', id: 'aaa', name: '喜鹊服务配置与插件安装', count: 475 },
            { key: '/sessions/bbb', id: 'bbb', name: '馒头保号登录', count: 300 },
            { key: '/sessions/ccc', id: 'ccc', name: '脱敏流水详情页与移动端优化', count: 220 },
            { key: '/sessions/ddd', id: 'ddd', name: '第四个会话不该上板', count: 90 },
          ],
          models: [
            { provider: 'curi-gate', model: 'workbuddy/deepseek-v4.1-flash', count: 480 },
            { provider: 'stepfun', model: 'step-5-preview', count: 220 },
            { provider: 'curi-gate', model: 'zcode/GLM-5.3', count: 120 },
            { provider: 'zhipu', model: 'glm-5', count: 60 },
            { provider: null, model: null, count: 7 },
          ],
          // Only the three busiest on each side get a ribbon. The pairs are
          // what the board draws, not a decoration: 400 went aaa →
          // workbuddy, 180 went bbb → stepfun, 90 went ccc → zcode.
          flows: {
            sessions: [
              { id: 'aaa', name: '喜鹊服务配置与插件安装', count: 475 },
              { id: 'bbb', name: '馒头保号登录', count: 300 },
              { id: 'ccc', name: '脱敏流水详情页与移动端优化', count: 220 },
            ],
            models: [
              { provider: 'curi-gate', model: 'workbuddy/deepseek-v4.1-flash', count: 480 },
              { provider: 'stepfun', model: 'step-5-preview', count: 220 },
              { provider: 'curi-gate', model: 'zcode/GLM-5.3', count: 120 },
            ],
            links: [
              { session: 'aaa', provider: 'curi-gate', model: 'workbuddy/deepseek-v4.1-flash', count: 400 },
              { session: 'bbb', provider: 'stepfun', model: 'step-5-preview', count: 180 },
              { session: 'ccc', provider: 'curi-gate', model: 'zcode/GLM-5.3', count: 90 },
            ],
            otherSessions: { count: 175, items: 1 },
            otherModels: { count: 190, items: 2 },
          },
          rows: [
            { time: Date.parse('2026-10-26T14:15:00+08:00'), count: 12, provider: 'curi-gate', model: 'workbuddy/deepseek-v4.1-flash', session: 'aaa', name: '喜鹊服务配置与插件安装' },
            { time: Date.parse('2026-10-26T09:02:00+08:00'), count: 1, provider: 'stepfun', model: 'step-5-preview', session: 'bbb', name: '馒头保号登录' },
            { time: Date.parse('2026-10-26T08:02:00+08:00'), count: 7, provider: null, model: null, session: 'ccc', name: '脱敏流水详情页与移动端优化' },
          ],
          // Three pages of bursts, the first one asked for. The page the host
          // answers with is the page the pager shows: it clamps the number, so
          // the client never formats a page it did not receive.
          ledger: { page: Number(args.page) === 2 ? 2 : 1, pages: 3, size: 40, total: 96 },
          index: { pending: 0, total: 194, scannedAt: Date.now(), sessions: 194 },
        },
      }),
    })
    const panel = await mountPanel(mod, {}, trailRpc)
    await flush()
    const root = () => panel.renderer.root
    const tabList = () => root().findAll((node) => node.props?.role === 'tablist')[0]
    const tabs = () => root().findAll((node) => node.props?.role === 'tab')
    const scrollArea = () => root().findAll((node) => node.props?.['data-scroll-area'] === '')[0]
    const bodyText = () => JSON.stringify(panel.renderer.toJSON())
    check('the panel offers two tabs', Boolean(tabList()) && tabs().length === 2, String(tabs().length))
    check('the tabs are the password list and the trail', tabs()[1].props.children.includes('脱敏轨迹'), JSON.stringify(tabs().map((node) => node.props.children)))
    check('the password list is the tab that opens', tabs()[0].props['aria-selected'] === true && tabs()[1].props['aria-selected'] === false)
    check("the tab strip names itself for a screen reader", tabList().props["aria-label"] === "密码库视图", String(tabList().props["aria-label"]))
    check('both tabs control the one surface', tabs()[0].props['aria-controls'] === tabs()[1].props['aria-controls'])
    check('the trail is not read while the list is open', trailRpc.calls.every((call) => call.method !== 'trail'))
    const container = scrollArea()
    check('the list page has the search box and the rail', bodyText().includes('data-vw-search') && root().findAll((node) => node.props?.['data-vw-nav'] !== undefined).length === 1)

    await act(async () => { tabs()[1].props.onClick() })
    await flush(120)
    check('the trail tab is now the selected one', tabs()[1].props['aria-selected'] === true && tabs()[1].props['data-active'] === 'true')
    check('switching pages keeps the scroll container mounted', scrollArea() === container, 'container remounted across the tab switch')
    check('the trail page asks the host for its numbers', trailRpc.calls.some((call) => call.method === 'trail' && call.args.days === 7))
    const trail = () => root().findAll((node) => node.props && Object.prototype.hasOwnProperty.call(node.props, 'data-vw-trail'))[0]
    check('the trail page is on screen', Boolean(trail()))
    check('the trail page carries the headline the host answered', trail().findAll((node) => node.props?.['data-vw-trail-count'] !== undefined)[0].props.children === '1,557')
    check("the trail page drops the search box and the rail", !bodyText().includes("data-vw-search") && root().findAll((node) => node.props?.['data-vw-nav'] !== undefined).length === 0)
    check('the trail page names the conversations that asked', bodyText().includes('喜鹊服务配置与插件安装'))
    // The board is data first: one bar per day of the window, then the three
    // busiest names on each side of the gate. More names must not sneak in —
    // the animation is specified to follow three, and a fourth label at 320px
    // would be a single ellipsis.
    check('the board draws one bar per day of the window', root().findAll((node) => node.props?.['data-vw-bar'] !== undefined).length === 7, String(root().findAll((node) => node.props?.['data-vw-bar'] !== undefined).length))
    check('the board names only the busiest three conversations', ['喜鹊服务配置与插件安装', '馒头保号登录', '脱敏流水详情页与移动端优化'].every((name) => bodyText().includes(name)) && !bodyText().includes('第四个会话不该上板'))
    check('the board draws one grey track for each real pair', root().findAll((node) => node.props?.['data-vw-trail-flow-link'] !== undefined).length === 3, String(root().findAll((node) => node.props?.['data-vw-trail-flow-link'] !== undefined).length))
    check('each of the three full lines gets one moving particle', root().findAll((node) => node.props?.['data-vw-trail-particle'] !== undefined).length === 3, String(root().findAll((node) => node.props?.['data-vw-trail-particle'] !== undefined).length))
    check('the gate line has a downward scan bar', root().findAll((node) => node.props?.['data-vw-gate-scan'] !== undefined).length === 1)
    check('the board says what is off the three names', bodyText().includes('另外 1 个会话') && bodyText().includes('另外 2 个模型'))
    check('the board carries the gate mark', root().findAll((node) => node.props?.['data-vw-trail-flow'] !== undefined)[0].findAll((node) => node.props?.title === '只放行脱敏后的请求').length === 1)
    check('the model names keep their provider in the tooltip', bodyText().includes('curi-gate') && bodyText().includes('workbuddy/deepseek-v4.1-flash'))
    check('a mask with no model is not dropped from the page', bodyText().includes('未记录模型'))
    const mask = (time) => `${String(new Date(time).getMonth() + 1).padStart(2, '0')}-${String(new Date(time).getDate()).padStart(2, '0')} ${String(new Date(time).getHours()).padStart(2, '0')}:${String(new Date(time).getMinutes()).padStart(2, '0')}`
    check('the ledger names the minute a mask happened', bodyText().includes(mask(Date.parse('2026-10-26T14:15:00+08:00'))), mask(Date.parse('2026-10-26T14:15:00+08:00')))
    // A burst is one row with its own size, so the ledger has to say how many
    // masks it stands for — and say "1" rather than nothing, because a blank
    // cell reads as "unknown", not as one.
    // A row is a button now — it opens the detail page — so the selector
    // takes either element and reads the fourth cell of each.
    const countCells = () =>
      root()
        .findAll((node) => node.props?.['data-vw-ledger'] !== undefined)[0]
        .findAll((node) => node.type === 'div' || node.type === 'button')
        // Four cells, the last of which is the count — a row, not the card
        // itself (the card's fourth child is the foot, whose own children are
        // elements and would stringify into a React fiber loop) and not the
        // head, whose fourth cell is the column's name.
        .filter((node) => Array.isArray(node.props.children) && node.props.children.length === 4 && typeof node.props.children[3]?.props?.children === 'string')
        .map((node) => node.props.children[3].props.children)
        .filter((cell) => cell !== '次数')
    check('the ledger says how many masks a row holds', countCells().includes('12') && countCells().includes('1'), JSON.stringify(countCells()))
    check('the ledger header names the count column', bodyText().includes('次数'))

    // ── the ledger's pager ──────────────────────────────────────────────────
    // Forty rows is more than one screen: a table that just stops looks
    // finished, and the reader cannot tell a quiet week from page one of four.
    // The foot states the whole length and offers the rest.
    const pagerButtons = () => root().findAll((node) => node.props?.['data-vw-pager-btn'] !== undefined)
    const pagerButton = (key) => pagerButtons().filter((node) => node.props['data-vw-pager-btn'] === key)[0]
    check('the ledger foot says how long the whole window is', bodyText().includes('共 96 条'), String(pagerButtons().length))
    check('the ledger offers every page', pagerButtons().filter((node) => /^[0-9]+$/.test(node.props['data-vw-pager-btn'])).map((node) => node.props['data-vw-pager-btn']).join(',') === '1,2,3', JSON.stringify(pagerButtons().map((node) => node.props['data-vw-pager-btn'])))
    check('the open page is the one the host answered', pagerButton('1').props['data-active'] === 'true' && pagerButton('1').props['aria-current'] === 'page' && pagerButton('2').props['data-active'] === undefined)
    check('there is no previous page from the first one', pagerButton('prev').props.disabled === true && pagerButton('next').props.disabled === false)
    await act(async () => { pagerButton('2').props.onClick() })
    await flush(120)
    check('turning the page asks the host for that page', trailRpc.calls.some((call) => call.method === 'trail' && call.args.page === 2), JSON.stringify(trailRpc.calls.filter((call) => call.method === 'trail').map((call) => call.args)))
    check('turning the page keeps the window', trailRpc.calls.some((call) => call.method === 'trail' && call.args.page === 2 && call.args.days === 7))
    check('the pager follows the host, not its own counter', pagerButton('2').props['data-active'] === 'true' && pagerButton('2').props['aria-current'] === 'page')
    check('a middle page has both steps', pagerButton('prev').props.disabled === false && pagerButton('next').props.disabled === false)
    check('the page number says which page it is for a screen reader', pagerButton('2').props['aria-label'] === '第 2 页', String(pagerButton('2').props['aria-label']))
    await act(async () => { pagerButton('next').props.onClick() })
    await flush(120)
    check('the next step asks for the next page', trailRpc.calls.some((call) => call.method === 'trail' && call.args.page === 3))
    // The last page is the end of the list, so the step stops there.
    await act(async () => { pagerButton('prev').props.onClick() })
    await flush(120)
    check('the previous step walks back', trailRpc.calls.some((call) => call.method === 'trail' && call.args.page === 2))

    const range = () => root().findAll((node) => node.props?.['data-vw-range-btn'] !== undefined)
    check('both windows are offered', range().length === 2 && range()[0].props['aria-pressed'] === true)
    await act(async () => { range()[1].props.onClick() })
    await flush(120)
    check('a wider window is re-read from the host', trailRpc.calls.some((call) => call.method === 'trail' && call.args.days === 30), JSON.stringify(trailRpc.calls.filter((call) => call.method === 'trail').map((call) => call.args)))
    check('the wider window is the selected one', range()[1].props['aria-pressed'] === true && range()[0].props['aria-pressed'] === false)
    check('the wider window draws thirty bars', root().findAll((node) => node.props?.['data-vw-bar'] !== undefined).length === 30, String(root().findAll((node) => node.props?.['data-vw-bar'] !== undefined).length))

    // Back to the list: the other page must still be there, still be the
    // list, and still be inside the same container.
    await act(async () => { tabs()[0].props.onClick() })
    await flush()
    check('switching back keeps the container too', scrollArea() === container)
    check('switching back restores the search box', bodyText().includes('data-vw-search'))
    await act(async () => { panel.renderer.unmount() })
  }

  // ── a ledger row opens a detail page ────────────────────────────────────
  // A row says when, which conversation, which model, and how many. Opening
  // one has to answer the question those four columns raise — which value,
  // where it sat, whether it came back — without pretending to know the value
  // itself, which the index never stored and the page must not invent.
  {
    const at = Date.parse('2026-10-26T14:15:00+08:00')
    const older = Date.parse('2026-10-26T09:02:00+08:00')
    const rows = [
      { time: at, count: 12, provider: 'curi-gate', model: 'workbuddy/deepseek-v4.1-flash', session: 'aaa', name: '喜鹊服务配置与插件安装' },
      { time: older, count: 1, provider: 'stepfun', model: 'step-5-preview', session: 'bbb', name: '馒头保号登录' },
    ]
    const detailRpc = makeRpc({
      trail: () => ({
        ok: true,
        value: {
          range: 7,
          total: 1557,
          distinct: 853,
          requests: 281,
          days: Array.from({ length: 7 }, (_, index) => ({ day: '2026-10-2' + index, count: index })),
          sessions: [{ key: '/sessions/aaa', id: 'aaa', name: '喜鹊服务配置与插件安装', count: 475 }],
          models: [{ provider: 'curi-gate', model: 'workbuddy/deepseek-v4.1-flash', count: 480 }],
          rows,
          ledger: { page: 1, pages: 1, size: 40, total: rows.length },
          index: { pending: 0, total: 194, scannedAt: Date.now(), sessions: 194 },
        },
      }),
      trailRow: (args) => ({
        ok: true,
        value: {
          ok: true,
          // The wire field is `sessionKey`, not `session`: a parameter named
          // `session` is claimed by the host's session lookup and resolved
          // against the live store, which a finished conversation's log would
          // fail. The value travelling is a log filename, not a live handle.
          session: args.sessionKey,
          time: at,
          name: '喜鹊服务配置与插件安装',
          provider: 'curi-gate',
          model: 'workbuddy/deepseek-v4.1-flash',
          count: 12,
          minutes: [{ time: at, count: 12, model: 'curi-gate/workbuddy/deepseek-v4.1-flash' }],
          values: [
            {
              fingerprint: 'PASSWORD:7kzaipdf',
              kind: 'PASSWORD',
              count: 12,
              // What the host adds when it can recompute the tag: which entry the
              // placeholder stood in for, and the first characters of the value.
              // The value itself never travels.
              origin: { itemId: 'item-1', itemName: '生产环境 API', kind: 'PASSWORD', field: 'password', preview: 'Adm1••••••…' },
              places: ['toolCall', 'toolResult', 'reply'],
              reply: true,
              firstAt: Date.parse('2026-10-26T14:14:40+08:00'),
              spots: [
                { type: 'tool/call', at: Date.parse('2026-10-26T14:14:40+08:00'), text: 'the apiKey is {{BW_PASSWORD_7kzaipdf}} and it is long', needle: '{{BW_PASSWORD_7kzaipdf}}', needleAt: 13 },
                { type: 'tool/result', at: Date.parse('2026-10-26T14:14:50+08:00'), text: '{"password":"{{BW_PASSWORD_7kzaipdf}}"}', needle: '{{BW_PASSWORD_7kzaipdf}}', needleAt: 13 },
                { type: 'assistant/message', at: Date.parse('2026-10-26T14:15:00+08:00'), text: 'the key came back as {{BW_PASSWORD_7kzaipdf}} in the reply', needle: '{{BW_PASSWORD_7kzaipdf}}', needleAt: 19 },
              ],
            },
            {
              fingerprint: 'M|9f3ab21c',
              kind: null,
              count: 1,
              places: ['input'],
              reply: false,
              firstAt: Date.parse('2026-10-26T14:14:30+08:00'),
              spots: [{ type: 'user/message', at: Date.parse('2026-10-26T14:14:30+08:00'), text: 'the key is [REDACTED:BW_PASSWORD]', needle: '[REDACTED:BW_PASSWORD]', needleAt: 11 }],
            },
          ],
          log: { missing: false, truncated: false, windowFrom: at - (at % 60000), windowTo: at - (at % 60000) + 60000 },
        },
      }),
    })
    const panel = await mountPanel(mod, {}, detailRpc)
    await flush()
    const root = () => panel.renderer.root
    const tab = () => root().findAll((node) => node.props?.role === 'tab')[1]
    await act(async () => { tab().props.onClick() })
    await flush(120)
    const rowButtons = () => root().findAll((node) => node.props?.['data-vw-trail-row'] !== undefined)
    check('a ledger row is a control, not a label', rowButtons().length === 2 && rowButtons()[0].props.type === 'button', String(rowButtons().length))
    check('a row says what opening it does', rowButtons()[0].props.title === '查看这条的详情', String(rowButtons()[0].props.title))
    check('a row is reachable by keyboard', rowButtons()[0].props['data-vw-trail-row-open'] === 'aaa@' + at, String(rowButtons()[0].props['data-vw-trail-row-open']))

    await act(async () => { rowButtons()[0].props.onClick() })
    await flush(120)
    const detail = () => root().findAll((node) => node.props?.['data-vw-trail-detail'] !== undefined)[0]
    const bodyText = () => JSON.stringify(panel.renderer.toJSON())
    check('the row opens a detail page in place of the ledger', Boolean(detail()) && rowButtons().length === 0, String(Boolean(detail())))
    check('the detail page asks the host for the row it was given', detailRpc.calls.some((call) => call.method === 'trailRow' && call.args.sessionKey === 'aaa' && call.args.time === at && call.args.days === 7), JSON.stringify(detailRpc.calls.filter((call) => call.method === 'trailRow')))
    check('the detail page says which row of the ledger it is', bodyText().includes('第 1/2 条'), '第 N/M 条')
    // Five steps, in order, each naming one thing that happened.
    const steps = () => detail().findAll((node) => node.props?.['data-vw-detail-step'] !== undefined)
    check('the burst is told as five steps', steps().length === 5, String(steps().length))
    check('the steps are numbered in order', steps().map((node) => node.props['data-vw-detail-step']).join(',') === '1,2,3,4,5', steps().map((node) => node.props['data-vw-detail-step']).join(','))
    check('the first step names the minute the row showed', bodyText().includes('接收请求'), '')
    check('the values and the places are two different numbers', bodyText().includes('识别 2 个敏感值') && bodyText().includes('完成 12 处脱敏'), '')
    check('the model step names the model the row named', bodyText().includes('转发至模型') && bodyText().includes('workbuddy/deepseek-v4.1-flash'), '')
    check('the last step says the value came back out', bodyText().includes('返回 1 处'), '')
    // The left column is a reading order, oldest first, with the mask marked.
    const ink = () => detail().findAll((node) => node.props?.['data-vw-detail-ink'] !== undefined)
    check('every occurrence is shown with the text around it', ink().length === 4, String(ink().length))
    const needles = () => detail().findAll((node) => node.props?.['data-vw-detail-needle'] !== undefined)
    check('the mask itself is marked inside its text', needles().length === 4 && needles()[0].props.children === '[REDACTED:BW_PASSWORD]', JSON.stringify(needles().map((node) => node.props.children)))
    // The left column is a reading order, so the marker the reader typed comes
    // before the value that replaced it, and the reply comes last.
    const inkPlaces = () => ink().map((node) => node.props.children[0].props.children[0].props.children)
    check('the occurrences run oldest first', inkPlaces().join(',') === '输入,工具调用,工具结果,回复', JSON.stringify(inkPlaces()))
    check('each occurrence says when it happened', ink().every((node) => /^\d\d-\d\d \d\d:\d\d$/.test(String(node.props.children[0].props.children[1].props.children))), JSON.stringify(ink().map((node) => node.props.children[0].props.children[1].props.children)))
    // A JSON log line must read as code — braces on their own lines, an
    // indented key, the mask where the value was — not as one escaped strip.
    const inkTexts = () => detail().findAll((node) => node.props?.['data-vw-detail-ink-text'] !== undefined)
    const jsonBlock = () =>
      inkTexts().find((node) => Array.isArray(node.props.children) && node.props.children.some((child) => typeof child === 'string' && child.includes('"password"')))
    check(
      'a JSON log slice is laid out as code, not line noise',
      Boolean(jsonBlock()) && typeof jsonBlock().props.children[0] === 'string' && jsonBlock().props.children[0].includes('{"password": "'),
      JSON.stringify(jsonBlock()?.props.children?.map?.((child) => (typeof child === 'string' ? child : '<mark>')) ?? null),
    )
    // The right column describes each value from what the index holds.
    const valueCards = () => detail().findAll((node) => node.props?.['data-vw-detail-value'] !== undefined)
    check('each value gets its own description', valueCards().length === 2, String(valueCards().length))
    // Three lines per value: what it was, the placeholder that stood in for it,
    // and where the trace appeared. The card used to carry five labelled fields
    // (kind, how it was found, where, reply, fingerprint) and read as a wall;
    // how and where now live in the other column, and the fingerprint survives
    // only as the tooltip, since it is the page's handle rather than something
    // a reader can act on.
    const cardLines = (node) => node.children.filter((child) => typeof child !== 'string')
    const countIn = (node, prop) => node.findAll((child) => child.props?.[prop] !== undefined).length
    check('each value card is three lines, not a field wall', valueCards().every((node) => cardLines(node).length === 3), JSON.stringify(valueCards().map((node) => cardLines(node).length)))
    const kinds = () => detail().findAll((node) => node.props?.['data-vw-detail-kind'] !== undefined)
    check('a value names its field in words', kinds()[0].props.children === '敏感类型：密码' && kinds()[1].props.children === '敏感类型：脱敏占位符', JSON.stringify(kinds().map((node) => node.props.children)))
    check('the field is named once, with no label in front of it', !bodyText().includes('发现方式') && !bodyText().includes('查找方式'), '')
    const codes = () => detail().findAll((node) => node.type === 'code')
    check('the placeholder is shown as it stood in the text', codes()[0].props.children === '{{BW_PASSWORD_7kzaipdf}}' && codes()[1].props.children === '[REDACTED:BW_PASSWORD]', JSON.stringify(codes().map((node) => node.props.children)))
    // The fingerprint is the page's handle for the value, not something a reader
    // can use, so it lives in the tooltip and never in the text of the page.
    const shownText = () => detail().findAll((node) => typeof node.props?.children === 'string').map((node) => node.props.children)
    check('the fingerprint is the tooltip, not a line of its own', codes()[0].props.title === 'PASSWORD:7kzaipdf' && codes()[1].props.title === 'M|9f3ab21c' && !shownText().some((text) => text === 'PASSWORD:7kzaipdf' || text === 'M|9f3ab21c'), JSON.stringify(codes().map((node) => node.props.title)))
    // 12 is how many spots the index counted for that value; the six windows
    // kept in the log are a sample of them, not the number itself.
    const counts = () => detail().findAll((node) => node.props?.['data-vw-detail-value-count'] !== undefined)
    check('a repeated value says how many spots it filled', counts().length === 1 && counts()[0].props.children === '匹配次数：12', JSON.stringify(counts().map((node) => node.props.children)))
    const countsIn = (card) => card.findAll((node) => node.props?.['data-vw-detail-value-count'] !== undefined)
    check('a value replaced once has no count to say', countsIn(valueCards()[1]).length === 0, String(countsIn(valueCards()[1]).length))
    // A card says where its trace appeared — the answer to "why is this on the
    // page". It must not say "did not appear": a negative there reads as if the
    // redaction never happened, which is exactly what a reader of a redaction
    // log cannot be left asking.
    const placeLines = () => detail().findAll((node) => node.props?.['data-vw-detail-places'] !== undefined)
    check(
      'each value card says where the trace appeared',
      placeLines().length === 2 && placeLines()[0].props.children === '工具调用、工具结果、回复' && placeLines()[1].props.children === '输入',
      JSON.stringify(placeLines().map((node) => node.props.children)),
    )
    check('no card claims something did not appear', !bodyText().includes('没出现'), '')
    // A placeholder the vault can still match comes back with the entry it stood
    // in for, so the card leads with the value's first characters and an arrow
    // into the placeholder — the reader's question is "which password was this",
    // and the entry name plus four characters answers it without printing it.
    const origins = () => detail().findAll((node) => node.props?.['data-vw-detail-origin'] !== undefined)
    check('a matchable placeholder shows the value it stood in for', origins().length === 1 && origins()[0].props.children === 'Adm1••••••…', JSON.stringify(origins().map((node) => node.props.children)))
    const arrows = () => detail().findAll((node) => node.props?.['data-vw-detail-arrow'] !== undefined)
    check('the value points at the placeholder it became', arrows().length === 1 && arrows()[0].props.children === '→', JSON.stringify(arrows().map((node) => node.props.children)))
    const originNames = () => detail().findAll((node) => node.props?.['data-vw-detail-origin-name'] !== undefined)
    check('the card also says which entry the value came from', originNames().length === 1 && originNames()[0].props.children === '生产环境 API', JSON.stringify(originNames().map((node) => node.props.children)))
    check('the value and the placeholder share one line', (() => {
      const row = detail().findAll((node) => node.props?.['data-vw-detail-code-row'] !== undefined)
      return row.length === 1 && row[0].props.children.length === 3 && row[0].props.children[1].props.children === '→'
    })())
    // A marker has no salt to recompute, so its card keeps the bare placeholder
    // and shows neither an arrow nor a preview — the miss has to look different
    // from the hit, or the page would be claiming a match it did not make.
    check('a marker gets no preview and no arrow', countIn(valueCards()[1], 'data-vw-detail-origin') === 0 && countIn(valueCards()[1], 'data-vw-detail-arrow') === 0)
    check('the old explainer paragraph is gone', !bodyText().includes('条目删了、改过'), '')
    check('the two columns are the request text and how it was masked', bodyText().includes('请求内容') && bodyText().includes('脱敏明细'), '')

    // ── stepping, and coming back ──────────────────────────────────────────
    const stepBtn = (key) => detail().findAll((node) => node.props?.['data-vw-detail-step-btn'] === key)[0]
    check('the first row has no previous one', stepBtn('prev').props.disabled === true && stepBtn('next').props.disabled === false)
    await act(async () => { stepBtn('next').props.onClick() })
    await flush(120)
    check('stepping asks the host for the next row', detailRpc.calls.some((call) => call.method === 'trailRow' && call.args.sessionKey === 'bbb'), JSON.stringify(detailRpc.calls.filter((call) => call.method === 'trailRow').map((call) => call.args.sessionKey)))
    check('the crumb follows the step', bodyText().includes('第 2/2 条'), '第 N/M 条')
    check('the last row has no next one', stepBtn('prev').props.disabled === false && stepBtn('next').props.disabled === true)
    await act(async () => { detail().findAll((node) => node.props?.['data-vw-detail-back'] !== undefined)[0].props.onClick() })
    await flush(120)
    check('the back step returns to the ledger it came from', rowButtons().length === 2 && !bodyText().includes('第 1/2 条'), String(rowButtons().length))

    // ── the five steps on a phone-width panel ──────────────────────────────
    // The wide arrangement is three max-content cells, a 1fr, and a
    // max-content. A phone panel has no spare width to give, so that 1fr
    // resolves to zero: the model step became a 423px column of single
    // characters and the fifth step hung off the right edge. The narrow
    // query has to re-flow the steps, and it has to sit in the 560px block.
    const stepsRule = '[data-vw-detail-steps] { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)) !important; row-gap: 12px !important }'
    check('the narrow-panel query re-flows the five steps', panelSheetText.includes(stepsRule), panelSheetText.includes(stepsRule) ? '' : 'rule missing from the injected sheet')
    const narrowAt = panelSheetText.indexOf('@container vw-panel (max-width: 560px)')
    const stepsAt = panelSheetText.indexOf(stepsRule)
    const railsAt = panelSheetText.indexOf('@container vw-panel (max-width: 420px)')
    check('the step re-flow lives in the 560px query, before the 420px one', narrowAt >= 0 && stepsAt > narrowAt && railsAt > stepsAt, 'narrow@' + narrowAt + ' steps@' + stepsAt + ' rails@' + railsAt)

    // ── the ledger keeps its place ─────────────────────────────────────────
    // One scroll container serves both pages. The detail page is shorter, so
    // the browser clamps scrollTop to its height; coming back therefore lands
    // wherever the clamp left it, which reads as 'the list jumped to the top'.
    // The trail page records the offset before opening a row and restores it
    // on the way out. react-test-renderer leaves refs null unless a test
    // supplies createNodeMock, so this is also the only way to see it happen.
    {
      const boxes = []
      const createNodeMock = (element) => {
        const node = { scrollTop: 0, scrollHeight: 2000, clientHeight: 600 }
        if (element && element.props && element.props['data-scroll-area'] === '') boxes.push(node)
        return node
      }
      const scrollPanel = await mountPanel(mod, {}, detailRpc, { createNodeMock })
      await flush()
      await act(async () => { scrollPanel.renderer.root.findAll((node) => node.props?.role === 'tab')[1].props.onClick() })
      await flush(120)
      const scroller = boxes[boxes.length - 1]
      check('the panel hands the trail page a scroll container to read', Boolean(scroller), String(boxes.length))
      scroller.scrollTop = 640
      await act(async () => { scrollPanel.renderer.root.findAll((node) => node.props?.['data-vw-trail-row'] !== undefined)[0].props.onClick() })
      await flush(120)
      check('opening a row starts the detail page at its top', scroller.scrollTop === 0, String(scroller.scrollTop))
      await act(async () => { scrollPanel.renderer.root.findAll((node) => node.props?.['data-vw-detail-back'] !== undefined)[0].props.onClick() })
      await flush(120)
      check('coming back puts the ledger back where it was', scroller.scrollTop === 640, String(scroller.scrollTop))
      await act(async () => { scrollPanel.renderer.unmount() })
    }

    // ── a row whose log is gone ────────────────────────────────────────────
    // The index still holds the burst, so the numbers are real; only the text
    // is missing. The page says which of the two it is, rather than showing an
    // empty column that reads as "there was nothing".
    const goneRpc = makeRpc({
      trail: () => ({
        ok: true,
        value: {
          range: 7,
          total: 1,
          distinct: 1,
          requests: 1,
          days: Array.from({ length: 7 }, () => ({ day: '2026-10-26', count: 1 })),
          sessions: [{ key: '/sessions/aaa', id: 'aaa', name: '喜鹊服务配置与插件安装', count: 1 }],
          models: [{ provider: 'curi-gate', model: 'workbuddy/deepseek-v4.1-flash', count: 1 }],
          rows: [rows[0]],
          ledger: { page: 1, pages: 1, size: 40, total: 1 },
          index: { pending: 0, total: 1, scannedAt: Date.now(), sessions: 1 },
        },
      }),
      trailRow: () => ({
        ok: true,
        value: {
          ok: true,
          session: 'aaa',
          time: at,
          name: '喜鹊服务配置与插件安装',
          provider: 'curi-gate',
          model: 'workbuddy/deepseek-v4.1-flash',
          count: 12,
          minutes: [{ time: at, count: 12, model: 'curi-gate/workbuddy/deepseek-v4.1-flash' }],
          values: [{ fingerprint: 'PASSWORD:abcdefgh', count: 12, kind: 'PASSWORD', places: [], reply: false, firstAt: null, spots: [] }],
          log: { missing: true, truncated: false, windowFrom: at, windowTo: at + 60000 },
        },
      }),
    })
    const gonePanel = await mountPanel(mod, {}, goneRpc)
    await flush()
    await act(async () => { gonePanel.renderer.root.findAll((node) => node.props?.role === 'tab')[1].props.onClick() })
    await flush(120)
    await act(async () => { gonePanel.renderer.root.findAll((node) => node.props?.['data-vw-trail-row'] !== undefined)[0].props.onClick() })
    await flush(120)
    const goneText = () => JSON.stringify(gonePanel.renderer.toJSON())
    check('a row with no log still shows its numbers', goneText().includes('完成 12 处脱敏') && goneText().includes('识别 1 个敏感值'), '')
    check('a missing log is said, not shown as an empty column', goneText().includes('对应的会话日志已经不在了，只剩下指纹'), '')
    check('a fingerprint-only value card is shown', goneText().includes('data-vw-detail-value') && goneText().includes('密码') && !goneText().includes('没有可显示的值'), '')
    check('the row still steps back to the ledger', gonePanel.renderer.root.findAll((node) => node.props?.['data-vw-trail-row'] !== undefined).length === 0, '')
    await act(async () => { gonePanel.renderer.unmount() })
  }

  // ── two values hidden in one sentence ─────────────────────────────────────
  // The host slices one window per log line, so two values hidden in the same
  // sentence arrive as two occurrences carrying the same text at two offsets.
  // Drawn per value the page shows the sentence twice; drawn per window it
  // shows it once with both marks in place, which is how the line read.
  {
    const at = Date.parse('2026-10-26T14:15:00+08:00')
    const pairText = 'the apiKey is {{BW_PASSWORD_bbbbbbbb}} and the token is {{BW_TOTP_cccccccc}} for this request'
    const spotAt = (needle) => ({ type: 'tool/call', at, text: pairText, needle, needleAt: pairText.indexOf(needle) })
    const pairRpc = makeRpc({
      trail: () => ({
        ok: true,
        value: {
          range: 7,
          total: 2,
          distinct: 2,
          requests: 1,
          days: Array.from({ length: 7 }, () => ({ day: '2026-10-26', count: 0 })),
          sessions: [{ key: '/sessions/aaa', id: 'aaa', name: '喜鹊服务配置与插件安装', count: 2 }],
          models: [],
          rows: [{ time: at, count: 2, provider: 'curi-gate', model: 'workbuddy/deepseek-v4.1-flash', session: 'aaa', name: '喜鹊服务配置与插件安装' }],
          ledger: { page: 1, pages: 1, size: 40, total: 1 },
          index: { pending: 0, total: 1, scannedAt: Date.now(), sessions: 1 },
        },
      }),
      trailRow: () => ({
        ok: true,
        value: {
          ok: true,
          session: 'aaa',
          time: at,
          name: '喜鹊服务配置与插件安装',
          provider: 'curi-gate',
          model: 'workbuddy/deepseek-v4.1-flash',
          count: 2,
          minutes: [{ time: at, count: 2, model: 'curi-gate/workbuddy/deepseek-v4.1-flash' }],
          values: [
            { fingerprint: 'PASSWORD:bbbbbbbb', kind: 'PASSWORD', places: ['toolCall'], reply: false, firstAt: at, spots: [spotAt('{{BW_PASSWORD_bbbbbbbb}}')] },
            { fingerprint: 'TOTP:cccccccc', kind: 'TOTP', places: ['toolCall'], reply: false, firstAt: at, spots: [spotAt('{{BW_TOTP_cccccccc}}')] },
          ],
          log: { missing: false, truncated: false, windowFrom: at - (at % 60000), windowTo: at - (at % 60000) + 60000 },
        },
      }),
    })
    const pairPanel = await mountPanel(mod, {}, pairRpc)
    await flush()
    await act(async () => { pairPanel.renderer.root.findAll((node) => node.props?.role === 'tab')[1].props.onClick() })
    await flush(120)
    await act(async () => { pairPanel.renderer.root.findAll((node) => node.props?.['data-vw-trail-row'] !== undefined)[0].props.onClick() })
    await flush(120)
    const pairRoot = () => pairPanel.renderer.root
    const pairInk = () => pairRoot().findAll((node) => node.props?.['data-vw-detail-ink'] !== undefined)
    const pairNeedles = () => pairRoot().findAll((node) => node.props?.['data-vw-detail-needle'] !== undefined)
    check('one sentence is drawn once, however many values it hid', pairInk().length === 1, String(pairInk().length))
    check('both marks are marked inside it', pairNeedles().map((node) => node.props.children).join('|') === '{{BW_PASSWORD_bbbbbbbb}}|{{BW_TOTP_cccccccc}}', JSON.stringify(pairNeedles().map((node) => node.props.children)))
    const runs = () => pairRoot().findAll((node) => node.props?.['data-vw-detail-ink-text'] !== undefined)[0].props.children
    check('the sentence is not repeated between the marks', runs().length === 5, String(runs().length))
    check('the marks sit in the order the line had them', runs()[0] === 'the apiKey is ' && runs()[2] === ' and the token is ' && runs()[4] === ' for this request', JSON.stringify(runs()[0]) + ' / ' + JSON.stringify(runs()[2]))
    check('both values still get their own description', pairRoot().findAll((node) => node.props?.['data-vw-detail-value'] !== undefined).length === 2, '')
    await act(async () => { pairPanel.renderer.unmount() })
  }

  // ── the trail page's three states outside 'ready' ─────────────────────────
  // A cold index answers partially and keeps filling in; a host that cannot
  // read the logs answers with an error. Both are pages, not spinners: the
  // numbers already known stay on screen in the first case, and the second
  // says so in words instead of showing a zero it did not measure.
  {
    const stateOf = (renderer) => renderer.root.findAll((node) => node.props?.['data-vw-trail-state'] !== undefined).map((node) => [node.props['data-vw-trail-state'], node.props.children])
    const countOf = (renderer) => renderer.root.findAll((node) => node.props?.['data-vw-trail-count'] !== undefined).map((node) => node.props.children)
    const open = async (route) => {
      const rpc = makeRpc({ trail: route })
      const panel = await mountPanel(mod, {}, rpc)
      await flush()
      const tab = panel.renderer.root.findAll((node) => node.props?.role === 'tab')[1]
      await act(async () => { tab.props.onClick() })
      await flush(120)
      return panel
    }

    const partial = await open(() => ({
      ok: true,
      value: { range: 7, total: 40, distinct: 12, requests: 3, days: [], sessions: [], models: [], rows: [], index: { pending: 150, total: 194, scannedAt: Date.now(), sessions: 194 } },
    }))
    check('a partly read index says so', stateOf(partial.renderer)[0]?.[0] === 'partial', JSON.stringify(stateOf(partial.renderer)))
    check('a partly read index still shows its numbers', countOf(partial.renderer)[0] === '40', JSON.stringify(countOf(partial.renderer)))
    await act(async () => { partial.renderer.unmount() })

    const failed = await open(() => ({ ok: false, error: { code: 'unreadable', message: 'nope' } }))
    check('an unreadable index says so', stateOf(failed.renderer)[0]?.[0] === 'error', JSON.stringify(stateOf(failed.renderer)))
    check('an unreadable index shows no invented zero', countOf(failed.renderer)[0] === '—', JSON.stringify(countOf(failed.renderer)))
    await act(async () => { failed.renderer.unmount() })

    // An empty vault is a real answer, and it is the one case where zero is
    // the truth: the numbers are zero, the rails say nothing was recorded,
    // and the ledger says so in words.
    const empty = await open(() => ({
      ok: true,
      value: { range: 7, total: 0, distinct: 0, requests: 0, days: [], sessions: [], models: [], rows: [], index: { pending: 0, total: 0, scannedAt: Date.now(), sessions: 0 } },
    }))
    check('an empty trail shows zero, not a dash', countOf(empty.renderer)[0] === '0', JSON.stringify(countOf(empty.renderer)))
    check('an empty trail has no state line', stateOf(empty.renderer).length === 0, JSON.stringify(stateOf(empty.renderer)))
    check('an empty trail says so in the ledger', JSON.stringify(empty.renderer.toJSON()).includes('还没有任何脱敏记录'))
    check('an empty trail draws no ribbons', empty.renderer.root.findAll((node) => node.props?.['data-vw-trail-flow-link'] !== undefined).length === 0)
    await act(async () => { empty.renderer.unmount() })
  }

  // ── the trail tab's keyboard contract ────────────────────────────────────
  // Left/Right cycle, Home/End jump. Both matter because the strip is a real
  // tablist: a reader who reaches it by keyboard must be able to leave it.
  {
    const panel = await mountPanel(mod, {}, makeRpc({ trail: () => ({ ok: true, value: { range: 7, total: 0, distinct: 0, requests: 0, days: [], sessions: [], models: [], rows: [], index: { pending: 0, total: 0, scannedAt: Date.now(), sessions: 0 } } }) }))
    await flush()
    const tabs = () => panel.renderer.root.findAll((node) => node.props?.role === 'tab')
    const press = async (key) => act(async () => { tabs()[0].props.onKeyDown({ key, preventDefault() {} }) })
    await press('ArrowRight')
    await flush(80)
    check('the right arrow opens the next tab', tabs()[1].props['aria-selected'] === true)
    await press('ArrowLeft')
    await flush(80)
    check('the left arrow comes back', tabs()[0].props['aria-selected'] === true)
    await press('ArrowLeft')
    await flush(80)
    check('the left arrow wraps to the last tab', tabs()[1].props['aria-selected'] === true)
    await press('End')
    await flush(80)
    check('End stays on the last tab', tabs()[1].props['aria-selected'] === true)
    await press('Home')
    await flush(80)
    check('Home jumps to the first tab', tabs()[0].props['aria-selected'] === true)
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
