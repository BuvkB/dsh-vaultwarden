/**
 * Access-mode tier test: readonly / ask / auto.
 *
 * The permission dial is the plugin's main safety surface, so each tier is
 * asserted against the real `apply()`:
 *   - `readonly` refuses every write tool before it can touch the network
 *   - `ask` registers a `tools/pre-execute` gate that returns `kind: 'ask'`
 *     for the write tools only (and leaves reads alone)
 *   - `auto` lets the write tools through to the mutation path
 *
 * It also pins the Config schema shape: schemastery 3.18 has no `enum`, so the
 * three tiers are a const union, and every tier must remain `.volatile()` or
 * the settings form stops rendering it.
 *
 * Run: node test/access-mode.test.mjs
 */
import { Config, apply } from '../lib/index.js'

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

/** Run apply() with a given accessMode and hand back what it registered. */
function boot(accessMode) {
  const tools = []
  const listeners = []
  const AVAILABLE = new Set(['settings', 'tools', 'systemPrompt', 'webServer', 'slots', 'locale'])
  const fakeCtx = {
    effect: (fn) => fn(),
    on: (event, handler) => {
      listeners.push({ event, handler })
      return () => {}
    },
    plugin: () => ({ name: 'VaultGateway' }),
    systemPrompt: { section: () => () => {} },
    tools: { register: (tool) => (tools.push(tool), () => {}) },
    inject: (services, callback) => {
      if (!services.every((service) => AVAILABLE.has(service))) return undefined
      return callback({
        effect: (fn) => fn(),
        settings: { update: async () => {}, describe: () => [] },
        slots: { inject: () => {}, register: () => () => {} },
        webServer: { register: () => { throw new Error('must not register an HTTP route') } },
      })
    },
  }
  const write = Symbol.for('cosmokit.volatile.write')
  const ref = (value) => Object.freeze({ get: () => value, [write]: () => {} })
  apply(fakeCtx, {
    serverUrl: ref('https://vault.example.com'),
    email: ref('me@example.com'),
    masterPassword: ref('secret'),
    accessMode: ref(accessMode),
  })
  return { tools, listeners }
}

/** Collect the tools whose execute() is callable without a live vault. */
const toolNamed = (tools, name) => tools.find((tool) => tool.name === name)

async function main() {
  console.log('access mode tiers (readonly / ask / auto)')

  // ── schema shape ───────────────────────────────────────────────────────────
  const accessField = Config?.dict?.accessMode
  check('accessMode is part of the Config schema', Boolean(accessField), Object.keys(Config?.dict ?? {}).join(','))
  check('accessMode is volatile (rendered by the settings form)', accessField?.meta?.volatile === true)
  // schemastery keeps the description text on `meta`, not on the accessor.
  const described = String(accessField?.meta?.description ?? '')
  check('accessMode documents all three tiers', ['readonly', 'ask', 'auto'].every((tier) => described.includes(tier)), described)
  // A const union validates by throwing on a mismatch; on success schemastery
  // reports the (empty) object shape rather than echoing the input.
  const tierSchema = Config?.dict?.accessMode
  check('the schema accepts all three tiers', ['readonly', 'ask', 'auto'].every((tier) => {
    try {
      tierSchema(tier)
      return true
    } catch {
      return false
    }
  }))
  check('the schema rejects an unknown tier', (() => {
    try {
      tierSchema('write-everything')
      return false
    } catch {
      return true
    }
  })())

  // ── readonly: every write tool refuses up front ────────────────────────────
  {
    const { tools } = boot('readonly')
    for (const name of ['bitwarden_create', 'bitwarden_update', 'bitwarden_delete', 'bitwarden_restore']) {
      const tool = toolNamed(tools, name)
      let result = null
      try {
        result = await tool.execute({ name: 'x', id: 'y' }, {})
      } catch (error) {
        result = `THREW: ${error.message}`
      }
      check(`readonly refuses ${name}`, typeof result === 'string' && result.includes('写回已停用'), String(result).slice(0, 80))
    }
    const reads = ['bitwarden_find', 'bitwarden_get', 'bitwarden_status', 'bitwarden_sync', 'bitwarden_folders']
    check('readonly still registers the read tools', reads.every((name) => Boolean(toolNamed(tools, name))), reads.filter((n) => !toolNamed(tools, n)).join(','))
  }

  // ── ask: a pre-execute gate routes write tools to approval ─────────────────
  {
    const { listeners } = boot('ask')
    const gate = listeners.find((entry) => entry.event === 'tools/pre-execute')
    check('ask registers a tools/pre-execute gate', Boolean(gate), listeners.map((l) => l.event).join(','))
    let reached = false
    const next = async () => {
      reached = true
      return { kind: 'allow' }
    }
    const forWrite = await gate.handler({ name: 'bitwarden_create' }, next)
    check('ask turns a write call into an approval request', forWrite?.kind === 'ask', JSON.stringify(forWrite))
    check('the approval prompt is localised (zh + en)', Boolean(forWrite?.displayReason?.zh && forWrite?.displayReason?.en), JSON.stringify(forWrite?.displayReason))
    check('ask does not run the write before approval', reached === false)
    const forRead = await gate.handler({ name: 'bitwarden_find' }, next)
    check('ask leaves read calls untouched', forRead?.kind === 'allow' && reached === true, JSON.stringify(forRead))
  }

  // ── auto: writes go straight through (the guard is the only gate) ──────────
  {
    const { listeners, tools } = boot('auto')
    const gate = listeners.find((entry) => entry.event === 'tools/pre-execute')
    let reached = false
    await gate.handler({ name: 'bitwarden_create' }, async () => ((reached = true), { kind: 'allow' }))
    check('auto does not ask for approval', reached === true)
    const tool = toolNamed(tools, 'bitwarden_create')
    let result = null
    try {
      result = await tool.execute({ name: 'x' }, {})
    } catch (error) {
      result = `THREW: ${error.message}`
    }
    // It may fail on the network, but it must get PAST the readonly refusal —
    // that distinction is exactly what the previously-missing guard decides.
    check('auto gets past the readonly refusal', typeof result === 'string' && !result.includes('写回已停用'), String(result).slice(0, 90))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exitCode = 1
})
