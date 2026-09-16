/**
 * Structural + interaction test for the browser half (`lib/client.js`).
 *
 * Loads the client bundle exactly the way the browser module loader does
 * (`window.__ModuleLoader__.load({id, factory})`), runs `apply` against a fake
 * client context, then mounts the registered settings card with
 * react-test-renderer and drives it: typing, saving, clearing overrides.
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

async function main() {
  console.log('settings card (browser half) test')

  // ── load the bundle exactly like the browser module table ─────────────────
  // Script evaluation only REGISTERS the factory; materialization is
  // `factory(require) → exports` (the loader memoizes the RETURN VALUE), so the
  // bundle must return its exports — asserting that here is the whole point.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry
  const windowStub = { __ModuleLoader__: { load: (value) => (entry = value) } }
  new Function('window', source)(windowStub)
  check('bundle calls window.__ModuleLoader__.load with the package id', entry?.id === '@dsh-external/dsh-bitwarden', String(entry?.id))
  check('bundle exposes a factory', typeof entry?.factory === 'function')

  const mod = entry.factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require(${id})`)
  })
  check('materialization returns the exports object (loader contract)', Boolean(mod) && typeof mod === 'object')
  check('client module exports name/inject/apply', mod.name === '@dsh-external/dsh-bitwarden' && Array.isArray(mod.inject) && typeof mod.apply === 'function')
  check('client module injects slots + locale', mod.inject.includes('slots') && mod.inject.includes('locale'), JSON.stringify(mod.inject))

  // ── fake client context ───────────────────────────────────────────────────
  const calls = { locale: null, bound: null, slotInject: null, register: null, disposed: 0 }
  const setCalls = []
  const unsetCalls = []
  const snapshot = {
    status: 'ready',
    value: {
      serverUrl: 'https://bitwarden.jindom.cc',
      email: '',
      masterPassword: undefined, // secrets are redacted for browser surfaces
      apiKeyClientId: '',
      apiKeyClientSecret: undefined,
      cacheMinutes: 30,
    },
    base: { cacheMinutes: 30 },
    user: { serverUrl: 'https://bitwarden.jindom.cc' },
    revision: 4,
    writable: true,
    mode: 'host',
  }
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async (field, value) => setCalls.push([field, value]),
    unset: async (field) => unsetCalls.push(field),
    dispose: () => (calls.disposed += 1),
  }
  const scoped = {
    effect: (fn) => fn(),
    settingsScope: { bind: (spec) => (calls.bound = spec) && scope },
    slots: {
      inject: (name, callback) => {
        calls.slotInject = name
        callback()
      },
      register: (options, render) => {
        calls.register = { options, render }
        return () => {}
      },
    },
  }
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (ns, dicts) => {
        calls.locale = { ns, dicts }
        return () => {}
      },
      bind: () => (key) => key,
    },
    inject: (services, callback) => callback(scoped),
  }

  mod.apply(ctx)
  check('registers a locale dictionary (zh + en)', calls.locale?.ns === 'bitwarden' && Boolean(calls.locale?.dicts?.zh) && Boolean(calls.locale?.dicts?.en))
  check('binds the bitwarden settings namespace', calls.bound?.namespace === 'bitwarden', JSON.stringify(calls.bound))
  check('registers a card into settings.plugin.item keyed by the namespace', calls.slotInject === 'settings.plugin.item' && calls.register?.options?.key === 'bitwarden', JSON.stringify(calls.register?.options))

  // ── mount and drive the card ──────────────────────────────────────────────
  const t = (key) => calls.locale.dicts.zh[key] ?? key
  const face = calls.register.options.inject()
  check('card injects its settings scope', Boolean(face?.bitwardenScope))

  let renderer
  await act(async () => {
    renderer = create(calls.register.render({ t, ...face }))
  })
  const inputs = () => renderer.root.findAllByType('input')
  const byType = () => {
    const map = {}
    for (const node of inputs()) map[node.props.type ?? 'text'] = map[node.props.type ?? 'text'] ? [...map[node.props.type ?? 'text'], node] : [node]
    return map
  }
  check('renders one input per setting (6)', inputs().length === 6, `inputs=${inputs().length}`)
  check('server url renders the resolved host value', inputs()[0].props.value === 'https://bitwarden.jindom.cc', String(inputs()[0].props.value))
  check('secret fields render as password inputs and never carry a value', inputs()[2].props.type === 'password' && inputs()[2].props.value === '')
  check('secret fields show the keep-existing placeholder', /留空/.test(String(inputs()[2].props.placeholder ?? '')), String(inputs()[2].props.placeholder))

  const buttons = () => renderer.root.findAllByType('button')
  const saveButton = () => buttons()[0]
  const resetButton = () => buttons()[1]
  check('save is disabled until something changes', saveButton().props.disabled === true)

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
    JSON.stringify(setCalls) === JSON.stringify([['email', 'me@example.com'], ['masterPassword', 'super-secret-master-password']]),
    JSON.stringify(setCalls),
  )
  check('card reports the saved state', /已保存/.test(JSON.stringify(renderer.toJSON())))

  await act(async () => {
    await resetButton().props.onClick()
  })
  check('clear-overrides unsets only overridden fields', JSON.stringify(unsetCalls) === JSON.stringify(['serverUrl']), JSON.stringify(unsetCalls))

  // ── degraded surfaces ─────────────────────────────────────────────────────
  const unavailable = {
    ...scope,
    getSnapshot: () => ({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' }),
  }
  await act(async () => {
    renderer = create(calls.register.render({ t, bitwardenScope: unavailable }))
  })
  check('unavailable namespace renders an explanation instead of a broken form', /无法读写主机配置/.test(JSON.stringify(renderer.toJSON())))
  check('unavailable namespace disables every input and button', inputs().every((node) => node.props.disabled === true) && buttons().every((node) => node.props.disabled === true))

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exit(1)
})
