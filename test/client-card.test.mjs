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
async function mountPanel(mod, dictionaries, rpcOrUndefined) {
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

  // reprompt gate
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

  // ── not configured ────────────────────────────────────────────────────────
  const notConfiguredError = { ok: false, error: { code: 'not_configured', message: '凭据库尚未配置完整' } }
  const unconfigured = await mountPanel(mod, {}, makeRpc({ list: () => notConfiguredError, status: () => notConfiguredError }))
  check('not-configured state explains what to fill in', JSON.stringify(unconfigured.renderer.toJSON()).includes('尚未配置完成'))
  await act(async () => {
    unconfigured.renderer.unmount()
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
