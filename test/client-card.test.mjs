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
const STATUS_REPORT = {
  configured: true,
  authMode: 'password',
  serverUrl: 'https://vault.example.com',
  email: 'me@example.com',
  cacheMinutes: 30,
  liveSync: { mode: 'websocket', connected: true, pollIntervalMs: 60000, lastSyncAt: new Date().toISOString(), lastError: null },
  unlocked: true,
  items: 3,
}
const ITEMS = [
  { id: 'item-1', name: 'GitHub 工作账号', type: 'login', username: 'octocat@example.com', uris: ['https://github.com/login'], folder: '工作', collections: [], hasTotp: true, hasNotes: true, customFields: ['租户'], favorite: true },
  { id: 'item-2', name: '生产数据库口令', type: 'secureNote', username: null, uris: [], folder: null, collections: [], hasTotp: false, hasNotes: false, customFields: [], favorite: false },
  { id: 'item-3', name: '需要重新验证的条目', type: 'login', username: 'reprompt-user', uris: [], folder: null, collections: [], hasTotp: false, hasNotes: false, customFields: [], favorite: false },
]
const REVEALS = {
  'item-1': { id: 'item-1', name: 'GitHub 工作账号', type: 'login', username: 'octocat@example.com', password: 'gh-p@ssw0rd-42', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', uris: ['https://github.com/login'], notes: 'SSH 密钥在 CI 里', fields: [{ name: '租户', value: 'jindom' }], folder: '工作', collections: [] },
  'item-3': { repromptRequired: true, id: 'item-3', name: '需要重新验证的条目', type: 'login' },
}
const CONFIRMED_REVEAL = { ...REVEALS['item-3'], repromptRequired: undefined, password: 'reprompt-pass-9', username: 'reprompt-user' }

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
      if (method === 'config') {
        return { ok: true, value: { serverUrl: 'https://vault.example.com', email: 'me@example.com', hasMasterPassword: true, hasApiKey: false, websocket: true, pollIntervalSeconds: 60, cacheMinutes: 30, accessMode: 'readonly' } }
      }
      if (method === 'configure') return { ok: true, value: { serverUrl: 'https://vault.example.com', email: 'me@example.com', hasMasterPassword: true } }
      if (method === 'twoFactor') return { ok: true, value: { pending: true, providers: [0], provider: 0 } }
      // Default: a session is already live, so the panel renders the vault.
      // Tests that need the sign-in screen override this.
      if (method === 'session') return { ok: true, value: { configured: true, authenticated: true, pendingTwoFactor: false, unlocked: true } }
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
  check('panel label comes from the dictionary', registration.options.label() === '凭据库')

  const text = () => JSON.stringify(renderer.toJSON())
  const buttons = () => renderer.root.findAllByType('button')
  const rows = () => buttons().filter((node) => node.props.role === 'option')

  check('panel loads the vault list over vw/list', text().includes('GitHub 工作账号') && text().includes('生产数据库口令'))
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
  check('panel shows the vault size', /共 3 条/.test(text()))
  check('list renders one option per entry', rows().length === 3, `rows=${rows().length}`)
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
  check('going back restores the list', rows().length === 3, `rows=${rows().length}`)
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
  const setupRpc = makeRpc({ config: () => unconfiguredConfig, list: () => notConfiguredError, status: () => notConfiguredError })
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
    const signedOut = { ok: true, value: { configured: true, authenticated: false, pendingTwoFactor: false, unlocked: false } }
    const rpc = makeRpc({ config: () => apiConfig, session: () => signedOut })
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
  const hardFail = await mountPanel(mod, {}, makeRpc({ config: () => ({ ok: true, value: { serverUrl: 'https://vault.example.com', email: 'me@example.com', hasMasterPassword: true, hasApiKey: false } }), list: () => hardFailError, status: () => hardFailError }))
  const hardFailText = JSON.stringify(hardFail.renderer.toJSON())
  check('a failed login explains the failure', hardFailText.includes('登录失败'))
  check('a failed login still offers a way back', hardFailText.includes('返回设置，重新填写'))
  await act(async () => {
    hardFail.renderer.unmount()
  })

  // ── a failing config RPC must not dead-end the panel ─────────────────────
  // The reported bug rendered "尚未配置完成" + 重试 when `config` rejected, and
  // 重试 re-ran the same failing call forever — the guided setup form, which is
  // the only way out, sat unreachable behind it. Whatever makes `config` fail,
  // the form has to stay on screen.
  {
    const failingConfig = { ok: false, error: { code: 'not_configured', message: '未配置 Vaultwarden 服务器地址' } }
    const rpc = makeRpc({ config: () => failingConfig, list: () => failingConfig, status: () => failingConfig })
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
    const rpc = makeRpc({ config: () => cfg, session: () => live })
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

  // ── sign-in flow: credentials first, code screen only after they verify ────
  const signedOutConfig = { ok: true, value: { serverUrl: 'https://vault.example.com', email: 'me@example.com', hasMasterPassword: true, hasApiKey: false } }
  const signedOut = { ok: true, value: { configured: true, authenticated: false, pendingTwoFactor: false, unlocked: false } }
  const twoFactorChallenge = { ok: true, value: { ok: true, authenticated: false, twoFactor: true, providers: [0], provider: 0, providerDescriptions: null } }

  // Opening with credentials stored but no session must ask to sign in — NOT
  // jump straight to the code screen (the reported bug).
  const signInRpc = makeRpc({ config: () => signedOutConfig, session: () => signedOut })
  const signedOutPanel = await mountPanel(mod, {}, signInRpc)
  const signInText = JSON.stringify(signedOutPanel.renderer.toJSON())
  check('a stored credential set lands on the sign-in form, not the code screen', signInText.includes('登录 Vaultwarden') && !signInText.includes('需要两步验证码'))
  check('opening the panel does not auto-login', !signInRpc.calls.some((call) => call.method === 'list'))

  // Submitting credentials that need 2FA advances to the code screen.
  const connectRpc = makeRpc({
    config: () => signedOutConfig,
    session: () => signedOut,
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
    config: () => signedOutConfig,
    session: () => signedOut,
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
  const empty = await mountPanel(mod, {}, makeRpc({ list: () => ({ ok: true, value: { query: 'zzz', matched: 0, returned: 0, vaultItems: 3, items: [] } }) }))
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
