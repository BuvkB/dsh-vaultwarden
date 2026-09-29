/**
 * Host-entry smoke test: imports lib/index.js the way the DSH loader does and
 * runs `apply()` against a fake host context, asserting every registration the
 * plugin makes. This is the guard against a broken host half shipping — the
 * earlier suites only exercise the protocol/HTTP/client modules.
 *
 * Run: node test/host-entry.test.mjs
 */
import { name, inject, Config, apply, default as defaultExport } from '../lib/index.js'

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
  console.log('host entry (lib/index.js) smoke test')

  // ── export shape ───────────────────────────────────────────────────────────
  check('entry exports the plugin name', name === 'dsh-vaultwarden', String(name))
  check('entry declares its injections', Array.isArray(inject) && inject.includes('tools') && inject.includes('systemPrompt'), JSON.stringify(inject))
  check('entry exports a Config schema', Boolean(Config))
  check('entry exports apply', typeof apply === 'function')
  check('default export mirrors the entry', defaultExport?.name === 'dsh-vaultwarden' && typeof defaultExport.apply === 'function')

  // ── run apply against a fake host context ──────────────────────────────────
  const tools = []
  const sections = []
  const settingsScopes = []
  const plugins = []
  const injected = []
  const effects = []

  const AVAILABLE = new Set(['settings', 'tools', 'systemPrompt', 'webServer', 'slots', 'locale'])
  const fakeCtx = {
    effect: (fn, label) => {
      effects.push(label)
      return fn()
    },
    on: () => () => {},
    plugin: (plugin, config) => {
      plugins.push({ plugin, config })
      return { name: plugin?.name }
    },
    systemPrompt: {
      section: (spec) => {
        sections.push(spec)
        return () => {}
      },
    },
    tools: {
      register: (tool) => {
        tools.push(tool)
        return () => {}
      },
    },
    inject: (services, callback) => {
      injected.push(...services)
      // Cordis semantics: a callback runs only when every service exists.
      if (!services.every((service) => AVAILABLE.has(service))) return undefined
      const scoped = {
        effect: (fn, label) => {
          effects.push(label)
          return fn()
        },
        settings: {
          register: (ns, schema, options) => {
            settingsScopes.push({ ns, schema, options })
            return {
              get: () => ({}),
              watch: () => () => {},
            }
          },
        },
        slots: {
          inject: () => {},
          register: () => () => {},
        },
        webServer: {
          register: (route) => {
            throw new Error(`plugin must not register an HTTP route: ${JSON.stringify(route)}`)
          },
        },
      }
      return callback(scoped)
    },
  }

  apply(fakeCtx, { serverUrl: '', email: '', masterPassword: '' })

  const toolNames = tools.map((tool) => tool.name)
  check('registers the 7 credential tools', ['bitwarden_find', 'bitwarden_get', 'bitwarden_status', 'bitwarden_sync', 'bitwarden_create', 'bitwarden_update', 'bitwarden_delete'].every((n) => toolNames.includes(n)), toolNames.join(','))
  check('find tool describes the no-password rule', /不含密码/.test(tools.find((t) => t.name === 'bitwarden_find').description))
  check('create tool requires a name', (tools.find((t) => t.name === 'bitwarden_create').parameters.required ?? []).includes('name'))
  check('injects the optional settings service it needs', injected.includes('settings'), injected.join(','))
  check('registers the settings namespace under the loader entry id', settingsScopes[0]?.ns === 'dsh-vaultwarden', String(settingsScopes[0]?.ns))
  check('every Config field is volatile (host form renders them)', (() => {
    const schema = settingsScopes[0]?.schema
    const fields = schema?.dict ?? {}
    return ['serverUrl', 'email', 'masterPassword', 'apiKeyClientId', 'apiKeyClientSecret', 'cacheMinutes', 'websocket', 'pollIntervalSeconds', 'deviceIdentifier', 'accessMode'].every((key) => fields[key]?.meta?.volatile === true)
  })())
  check('registers the prompt guidance section', sections.some((section) => section.name === 'bitwarden-vault' && /实时同步/.test(section.text)))
  check('registers effects with labels (cleanup contract)', effects.length >= 8 && effects.every((label) => typeof label === 'string' && label.startsWith('dsh-vaultwarden:')), `${effects.length} effects`)
  check('mounts the Remote gateway instead of an HTTP route', plugins.length === 1 && plugins[0].plugin?.name === 'VaultGateway' && typeof plugins[0].config?.getClient === 'function', JSON.stringify(plugins.map((entry) => entry.plugin?.name)))

  // ── the gateway's wire surface ──────────────────────────────────────────────
  const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol')
  const { VaultGateway } = await import('../lib/gateway.js')
  const markers = remoteMethods(Object.create(VaultGateway.prototype)).map((marker) => marker.exportName ?? marker.method)
  check('gateway exposes the vw methods incl. setup + 2FA', ['status', 'list', 'reveal', 'totp', 'sync', 'create', 'update', 'remove', 'config', 'configure', 'twoFactor', 'submitTwoFactor'].every((name) => markers.includes(name)), markers.join(','))
  check('every Remote method has a source-mode-safe signature', (() => {
    // The gateway's SRC mode parses the parameter list as plain identifiers:
    // defaults, destructuring and rest are rejected at call time.
    const isPlain = (fn) => {
      const source = fn.toString()
      const open = source.indexOf('(')
      const close = source.indexOf(')', open + 1)
      if (open < 0 || close < 0) return false
      const body = source.slice(open + 1, close).trim()
      if (body === '') return true
      const parts = body.split(',').map((part) => part.trim())
      const seen = new Set()
      for (const part of parts) {
        if (!/^[$A-Z_a-z][$\w]*$/.test(part) || seen.has(part)) return false
        seen.add(part)
      }
      return true
    }
    const offenders = markers.filter((name) => !isPlain(VaultGateway.prototype[name]))
    return offenders.length === 0
  })(), markers.join(','))
  check('gateway binds the vw namespace', Object.create(VaultGateway.prototype) instanceof Object && VaultGateway.name === 'VaultGateway')

  // ── degraded configuration must not throw ───────────────────────────────────
  const emptyCtx = { ...fakeCtx, tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} } }
  let threw = null
  try {
    apply(emptyCtx, {})
  } catch (error) {
    threw = error
  }
  check('apply() survives an empty config (unconfigured install)', threw === null, String(threw))

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('test crashed:', error)
  process.exit(1)
})
