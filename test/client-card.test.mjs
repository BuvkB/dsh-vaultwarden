/**
 * Structural + interaction test for the browser half (`lib/client.js`).
 *
 * Loads the client bundle exactly the way the browser module loader does
 * (`window.__ModuleLoader__.load({id, factory})`), runs `apply` against a fake
 * client context, then mounts the registered surfaces with react-test-renderer
 * and drives them: the settings card (typing, saving, clearing overrides, the
 * sync-status row) and the entry panel (list, search, detail, copy, the
 * Bitwarden reprompt gate, the TOTP countdown). `fetch` is stubbed, so the
 * whole loop runs offline against canned `/dsh-vaultwarden/api` payloads.
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

// ── canned API payloads ───────────────────────────────────────────────────────
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
  'item-3': { repromptRequired: true, id: 'item-3', name: '需要重新验证的条目', type: 'login', hint: '该条目开启了重新验证' },
}
const CONFIRMED_REVEAL = { ...REVEALS['item-3'], repromptRequired: undefined, password: 'reprompt-pass-9', username: 'reprompt-user' }

/** Install a fetch stub that answers the plugin's same-origin API. */
function stubFetch(overrides = {}) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('/dsh-vaultwarden/api', '')
    const key = `${init.method ?? 'GET'} ${path.split('?')[0]}`
    const route = overrides[key]
    const payload =
      route !== undefined
        ? route
        : key === 'GET /status'
          ? { ok: true, body: STATUS_REPORT }
          : key === 'GET /list'
            ? (() => {
                const query = new URL('http://x' + path).searchParams.get('query') ?? ''
                const items = query ? ITEMS.filter((item) => `${item.name}${item.username ?? ''}`.includes(query)) : ITEMS
                return { ok: true, body: { query, matched: items.length, returned: items.length, vaultItems: ITEMS.length, items } }
              })()
            : key === 'POST /reveal'
              ? (() => {
                  const body = JSON.parse(init.body ?? '{}')
                  if (body.id === 'item-3' && body.confirm) return { ok: true, body: CONFIRMED_REVEAL }
                  return { ok: true, body: REVEALS[body.id] ?? { error: 'not_found', code: 'not_found' } }
                })()
              : key === 'POST /totp'
                ? { ok: true, body: { id: 'item-1', name: 'GitHub 工作账号', totp: { code: '123456', digits: 6, period: 30, secondsRemaining: 20, remaining: 20, algorithm: 'SHA1' } } }
                : key === 'POST /sync'
                  ? { ok: true, body: { ok: true, items: 3 } }
                  : { ok: false, status: 404, body: { error: 'not_found', code: 'not_found' } }
    const status = payload.ok === false ? payload.status ?? 400 : 200
    return { ok: payload.ok !== false, status, json: async () => payload.body ?? {} }
  }
  return () => {
    globalThis.fetch = realFetch
  }
}

async function main() {
  console.log('settings card + entry panel (browser half) test')

  // ── load the bundle exactly like the browser module table ─────────────────
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry
  // The bundle's top-level `window.__ModuleLoader__.load(...)` resolves against
  // this stub in the test (the browser's real window carries the loader), so
  // the stub also provides the listener surface the panel's "/" shortcut uses.
  const windowStub = {
    __ModuleLoader__: { load: (value) => (entry = value) },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  new Function('window', source)(windowStub)
  check('bundle calls window.__ModuleLoader__.load with the package id', entry?.id === 'dsh-vaultwarden', String(entry?.id))
  check('bundle exposes a factory', typeof entry?.factory === 'function')

  const mod = entry.factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require(${id})`)
  })
  check('materialization returns the exports object (loader contract)', Boolean(mod) && typeof mod === 'object')
  check('client module exports name/inject/apply', mod.name === 'dsh-vaultwarden' && Array.isArray(mod.inject) && typeof mod.apply === 'function')
  check('client module injects slots + locale', mod.inject.includes('slots') && mod.inject.includes('locale'), JSON.stringify(mod.inject))

  // ── fake client context ───────────────────────────────────────────────────
  const registrations = []
  const setCalls = []
  const unsetCalls = []
  const snapshot = {
    status: 'ready',
    value: {
      serverUrl: 'https://vault.example.com',
      email: '',
      masterPassword: undefined, // secrets are redacted for browser surfaces
      apiKeyClientId: '',
      apiKeyClientSecret: undefined,
      websocket: true,
      cacheMinutes: 30,
      pollIntervalSeconds: 60,
      deviceIdentifier: '',
    },
    base: { cacheMinutes: 30, websocket: true, pollIntervalSeconds: 60 },
    user: { serverUrl: 'https://vault.example.com' },
    revision: 6,
    writable: true,
    mode: 'host',
  }
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async (field, value) => setCalls.push([field, value]),
    unset: async (field) => unsetCalls.push(field),
    dispose: () => {},
  }
  const scoped = {
    effect: (fn) => fn(),
    settingsScope: { bind: () => scope },
    slots: {
      inject: (name, callback) => {
        callback()
      },
      register: (options, render) => {
        registrations.push({ options, render })
        return () => {}
      },
    },
  }
  const dictionaries = {}
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (ns, dicts) => {
        dictionaries.zh = dicts.zh
        dictionaries.en = dicts.en
        return () => {}
      },
      bind: () => (key) => key,
    },
    inject: (services, callback) => callback(scoped),
  }

  mod.apply(ctx)
  const t = (key) => dictionaries.zh[key] ?? key
  const cardEntry = registrations.find((entry) => entry.options.key === 'bitwarden')
  const panelEntry = registrations.find((entry) => entry.options.name === 'settings.section')
  check('registers the card into settings.plugin.item keyed by the namespace', Boolean(cardEntry))
  check('registers the entry panel as a settings page', Boolean(panelEntry) && panelEntry.options.id === 'vaultwarden' && typeof panelEntry.options.label === 'function', JSON.stringify(panelEntry?.options))
  check('panel label comes from the dictionary', panelEntry.options.label() === 'panelNav')

  const restoreFetch = stubFetch()
  let renderer
  await act(async () => {
    renderer = create(cardEntry.render({ t, bitwardenScope: scope }))
  })
  const inputs = () => renderer.root.findAllByType('input')
  const buttons = () => renderer.root.findAllByType('button')
  check('renders one input per text/number setting (8)', inputs().length === 8, `inputs=${inputs().length}`)
  check('secret fields render as password inputs and never carry a value', inputs()[2].props.type === 'password' && inputs()[2].props.value === '')
  check('secret fields show the keep-existing placeholder', /留空/.test(String(inputs()[2].props.placeholder ?? '')), String(inputs()[2].props.placeholder))
  check('sections render in order', /连接/.test(JSON.stringify(renderer.toJSON())) && /认证/.test(JSON.stringify(renderer.toJSON())) && /同步/.test(JSON.stringify(renderer.toJSON())))

  const switches = () => renderer.root.findAllByType('button').filter((node) => node.props.role === 'switch')
  const saveButton = () => buttons().find((node) => node.props.children === '保存')
  const resetButton = () => buttons().find((node) => node.props.children === '清除本机覆盖')
  check('save is disabled until something changes', saveButton().props.disabled === true)
  check('websocket renders as a host-shaped switch', switches().length === 1 && switches()[0].props['aria-checked'] === 'true', `switches=${switches().length}`)
  await act(async () => {
    switches()[0].props.onClick()
  })
  check('the switch toggles its aria state', switches()[0].props['aria-checked'] === 'false')
  await act(async () => {
    inputs()[1].props.onChange({ target: { value: 'me@example.com' } })
  })
  check('editing enables save', saveButton().props.disabled === false)
  await act(async () => {
    inputs()[2].props.onChange({ target: { value: 'super-secret-master-password' } })
  })
  await act(async () => {
    await saveButton().props.onClick()
  })
  check(
    'save writes only the changed fields',
    JSON.stringify(setCalls) === JSON.stringify([['email', 'me@example.com'], ['masterPassword', 'super-secret-master-password'], ['websocket', false]]),
    JSON.stringify(setCalls),
  )
  check('card reports the saved state', /已保存/.test(JSON.stringify(renderer.toJSON())))

  await act(async () => {
    await resetButton().props.onClick()
  })
  check('clear-overrides unsets only overridden fields', JSON.stringify(unsetCalls) === JSON.stringify(['serverUrl']), JSON.stringify(unsetCalls))

  await act(async () => {
    renderer.unmount()
  })

  // sync status row renders from the stubbed /api/status
  await act(async () => {
    renderer = create(cardEntry.render({ t, bitwardenScope: scope }))
  })
  check('card shows the live-sync chip from /api/status', /实时同步/.test(JSON.stringify(renderer.toJSON())), JSON.stringify(renderer.toJSON()).slice(0, 200))
  await act(async () => {
    renderer.unmount()
  })

  // degraded surface
  const unavailable = {
    ...scope,
    getSnapshot: () => ({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' }),
  }
  await act(async () => {
    renderer = create(cardEntry.render({ t, bitwardenScope: unavailable }))
  })
  check('unavailable namespace renders an explanation instead of a broken form', /无法读写主机配置/.test(JSON.stringify(renderer.toJSON())))
  check('unavailable namespace disables every input and button', inputs().every((node) => node.props.disabled === true) && buttons().every((node) => node.props.disabled === true))
  await act(async () => {
    renderer.unmount()
  })

  // ── the entry panel ───────────────────────────────────────────────────────
  await act(async () => {
    renderer = create(panelEntry.render({ t }))
  })
  await act(async () => {
    await sleep(50)
  })
  const text = () => JSON.stringify(renderer.toJSON())
  check('panel loads the vault list from /api/list', text().includes('GitHub 工作账号') && text().includes('生产数据库口令'))
  check('panel shows the sync chip', text().includes('实时同步'))
  check('panel shows the vault size', /共 3 条/.test(text()))

  // search: debounced reload
  const search = () => renderer.root.findByType('input')
  await act(async () => {
    search().props.onChange({ target: { value: '数据库' } })
  })
  await act(async () => {
    await sleep(350)
  })
  check('search filters through the API', text().includes('生产数据库口令') && !text().includes('GitHub 工作账号'))
  await act(async () => {
    search().props.onChange({ target: { value: '' } })
  })
  await act(async () => {
    await sleep(350)
  })

  // selection → detail
  const rows = () => renderer.root.findAllByType('button').filter((node) => node.props.role === 'option')
  check('list renders one option per entry', rows().length === 3, `rows=${rows().length}`)
  check('selected state is exposed via aria-selected', rows()[0].props['aria-selected'] === 'false')
  await act(async () => {
    rows()[0].props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  check('selecting a row loads its detail', text().includes('octocat@example.com'))
  check('password is masked until revealed', text().includes('●●●●●●●●') && !text().includes('gh-p@ssw0rd-42'))
  check('TOTP countdown renders the code', /\b123456\b/.test(text()))
  check('detail offers copy buttons', text().includes('复制'))

  const revealToggle = () => renderer.root.findAllByType('button').filter((node) => node.props.children === '显示')
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
  const confirmButton = () => renderer.root.findAllByType('button').find((node) => node.props.children === '确认读取')
  await act(async () => {
    confirmButton().props.onClick()
  })
  await act(async () => {
    await sleep(50)
  })
  check('confirm reads the reprompt entry through the API', text().includes('reprompt-pass-9'))

  await act(async () => {
    renderer.unmount()
  })

  // empty + error states
  const restoreFetch2 = stubFetch({ 'GET /list': { ok: true, body: { query: 'zzz', matched: 0, returned: 0, vaultItems: 3, items: [] } } })
  await act(async () => {
    renderer = create(panelEntry.render({ t }))
  })
  await act(async () => {
    await sleep(50)
  })
  check('no-match list renders an actionable empty state', text().includes('没有匹配的条目'))
  await act(async () => {
    renderer.unmount()
  })
  restoreFetch2()

  const restoreFetch3 = stubFetch({ 'GET /status': { ok: false, status: 409, body: { error: '凭据库尚未配置完整', code: 'not_configured', hint: '补全 serverUrl/email/主密码' } }, 'GET /list': { ok: false, status: 409, body: { error: '凭据库尚未配置完整', code: 'not_configured', hint: '补全 serverUrl/email/主密码' } } })
  await act(async () => {
    renderer = create(panelEntry.render({ t }))
  })
  await act(async () => {
    await sleep(50)
  })
  check('not-configured state explains what to fill in', text().includes('尚未配置完成') || text().includes('补全 serverUrl/email/主密码'))
  await act(async () => {
    renderer.unmount()
  })
  restoreFetch3()
  restoreFetch()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exit(1)
})
