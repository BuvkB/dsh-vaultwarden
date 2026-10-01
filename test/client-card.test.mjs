/**
 * Structural + interaction test for the browser half (`lib/client.js`).
 *
 * Loads the client bundle exactly the way the browser module loader does
 * (`window.__ModuleLoader__.load({id, factory})`), runs `apply` against a fake
 * client context whose `connection.rpc.call` is stubbed, then mounts the
 * registered settings section with react-test-renderer and drives it: list,
 * debounced search, detail, password reveal, copy, the Bitwarden reprompt
 * gate, the TOTP countdown, and the empty / not-configured / no-connection
 * states.
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
  console.log('client-card: react / react-test-renderer not installed — skipping')
  console.log('  install them with: npm install --no-save --legacy-peer-deps react@18.3.1 react-test-renderer@18.3.1')
  process.exit(0)
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
const REVEALS = {
  'item-1': { id: 'item-1', name: 'GitHub 工作账号', type: 'login', username: 'octocat@example.com', password: 'gh-p@ssw0rd-42', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', uris: ['https://github.com/login'], notes: 'SSH 密钥在 CI 里', fields: [{ name: '租户', value: 'jindom' }], folder: '工作', collections: [] },
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
        const query = String(payload?.args?.query ?? '')
        const items = query ? ITEMS.filter((item) => `${item.name}${item.username ?? ''}`.includes(query)) : ITEMS
        return { ok: true, value: { query, matched: items.length, returned: items.length, vaultItems: ITEMS.length, items } }
      }
      if (method === 'reveal') {
        const args = payload?.args ?? {}
        if (args.id === 'item-3' && args.confirm) return { ok: true, value: CONFIRMED_REVEAL }
        return { ok: true, value: REVEALS[args.id] ?? { error: 'not_found' } }
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
  if (!options.keepCache) mod.__resetOpenCache?.()
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
  check('detail offers copy buttons', text().includes('复制'))

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
  const confirmButton = () => buttons().find((node) => node.props.children === '确认读取')
  await act(async () => {
    confirmButton().props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  check('confirm reads the reprompt entry through vw/reveal', text().includes('reprompt-pass-9'))
  check('confirm travels as a boolean', rpc.calls.some((call) => call.method === 'reveal' && call.args.confirm === true))
  await act(async () => {
    renderer.unmount()
  })

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
    const unknownMethod = { ok: false, error: { code: 'unknown_method', message: 'vw/boot is not a registered remote method' } }
    const rpc = makeRpc({
      boot: () => unknownMethod,
      config: () => ({ ok: true, value: CONFIG_VALUE }),
      session: () => ({ ok: true, value: AUTHED_SESSION }),
      // The list payload the default route builds; spell it out so this
      // scenario does not depend on the default list filter.
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

  void t
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exit(1)
})
