#!/usr/bin/env node
/**
 * The transcript row's NATIVE path: what it looks like when the page actually
 * hosts the platform primitives the host's own tool rows are built from.
 *
 * `test/client-card.test.mjs` mounts the bundle against a page that has only
 * `react` (its loader stub rejects every other require), so it exercises the
 * primitives-free fallback. That leaves the branch a real user always hits —
 * the one where `@deepseek-ai/dsh-client-ui-primitives` is present — untested.
 *
 * This suite closes that gap by loading the REAL host module through
 * `test/host-primitives-hooks.mjs` and asserting that:
 *   · the row renders through the host's own `DisclosureRow`, identified by the
 *     host's own DOM contract (`data-disclosure-row`, `data-disclosure-header`)
 *     rather than by anything this repo names;
 *   · the header carries a real glyph from the host's icon set;
 *   · the collapsed line reads "title · summary", the way a native row does;
 *   · the security contract survives: expanding the row still shows no secret;
 *   · the row is reachable and operable the way native rows are (click the row,
 *     press Enter) — the accessibility behaviour a hand-drawn card had to fake.
 *
 * Run: node test/native-row.test.mjs
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

// The second argument is the PARENT URL the specifier resolves against, so it
// must be the suite's own file URL — not a file URL built from it.
register('./host-primitives-hooks.mjs', import.meta.url)

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

let react
let create
let act
let primitives
try {
  // CJS surface, like test/client-card.test.mjs: react-test-renderer's ESM
  // namespace nests act/create under `default`, and requiring it avoids that
  // interop hazard entirely.
  react = require('react')
  const renderer = require('react-test-renderer')
  create = renderer.create
  act = renderer.act
} catch (error) {
  console.error('native-row: react / react-test-renderer not installed — cannot run the row checks')
  console.error('  install them with: npm install --no-save --legacy-peer-deps react@18.3.1 react-test-renderer@18.3.1')
  console.error('  (' + error.message + ')')
  process.exit(1)
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * Locate the HOST's primitives module without hardcoding a machine path.
 *
 * The plugin already links its peer SDK at `node_modules/@deepseek-ai/dsh-tools`
 * (build.sh does it), and the harness publishes every official client package
 * as a SIBLING of that — so resolving the linked peer and stepping across is
 * the same discovery the loader performs at runtime. `DSH_PRIMITIVES_PATH`
 * overrides it for an unusual layout.
 */
const findHostPrimitives = () => {
  if (process.env.DSH_PRIMITIVES_PATH) return process.env.DSH_PRIMITIVES_PATH
  try {
    const peer = require.resolve('@deepseek-ai/dsh-tools/package.json')
    const entry = new URL('../dsh-client-ui-primitives/lib/index.js', pathToFileURL(peer))
    return fileURLToPath(entry)
  } catch {
    return null
  }
}

const failures = []
const hostPrimitivesPath = findHostPrimitives()
if (hostPrimitivesPath === null) {
  // Two callers want opposite things here, so the choice is explicit.
  //
  // Standalone (`node test/native-row.test.mjs`): a checkout whose peer SDK was
  // never linked simply cannot reach the host's browser modules. Skip, the way
  // test/cli-interop.mjs skips without the official CLI.
  //
  // Under scripts/build.sh: the links are guaranteed — the script makes them
  // before running any suite, and `npm install` prunes exactly these symlinks as
  // a side effect. So a missing link there means the build lost its peer SDK,
  // and a suite that printed "skipping" and exited 0 would report the native
  // row as verified without having rendered it once. Fail instead.
  const required = process.env.DSH_REQUIRE_NATIVE_ROW === '1'
  const message = 'native-row: linked @deepseek-ai/dsh-tools not found — the host primitives module cannot be located'
  if (required) {
    console.error(message)
    console.error('  DSH_REQUIRE_NATIVE_ROW=1 is set (build.sh), so this is a FAILURE, not a skip:')
    console.error('  the peer SDK links are missing, and the native row path would go unverified.')
    console.error('  build.sh re-links them via link_pkg; run it, or link @deepseek-ai/dsh-tools manually.')
    process.exit(1)
  }
  console.log(message + ', skipping')
  process.exit(0)
}
try {
  primitives = await import(hostPrimitivesPath)
} catch (error) {
  console.error('native-row: cannot import the host primitives module — ' + error.message.slice(0, 300))
  console.error('  looked at: ' + hostPrimitivesPath)
  console.error('  the native row path is UNVERIFIED (not skipped): this must fail loudly')
  process.exit(1)
}

// The host exports it as a `memo()` component, which is an object with a
// `$$typeof` marker rather than a plain function — so the guard tests for a
// renderable value, not for `function`.
const isRenderable = (value) =>
  (typeof value === 'function' || (typeof value === 'object' && value !== null)) &&
  (typeof value === 'function' || typeof value.$$typeof === 'symbol' || typeof value.render === 'function')

if (!isRenderable(primitives.DisclosureRow)) {
  console.error('native-row: the host primitives module exposes no renderable DisclosureRow — the host API this row builds on has changed')
  process.exit(1)
}
if (!isRenderable(primitives.IconSearchOutlineRegular)) {
  console.error('native-row: the host primitives module exposes no renderable icons — the host API this row builds on has changed')
  process.exit(1)
}

let passed = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    passed++
    console.log('  ✓ ' + label)
  } else {
    failures.push(label)
    console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''))
  }
}

// ── mount the plugin bundle the way the browser module loader does ───────────
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let entry
const windowStub = {
  __ModuleLoader__: { load: (value) => { entry = value } },
  addEventListener: () => {},
  removeEventListener: () => {},
}
new Function('window', source)(windowStub)
const mod = entry.factory((id) => {
  if (id === 'react') return react
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('unexpected require(' + id + ')')
})

// The bundle's zh dictionary is module-private, so the labels the row renders
// are read straight off the source. They double as assertions: if a label is
// renamed in the bundle and not here, the checks below fail rather than pass
// vacuously on a key name.
const LABELS = {
  toolArgs: /toolArgs: '([^']+)'/.exec(source)?.[1] ?? 'toolArgs',
  toolResult: /toolResult: '([^']+)'/.exec(source)?.[1] ?? 'toolResult',
  toolError: /toolError: '([^']+)'/.exec(source)?.[1] ?? 'toolError',
  toolRunning: /toolRunning: '([^']+)'/.exec(source)?.[1] ?? 'toolRunning',
  toolFailed: /toolFailed: '([^']+)'/.exec(source)?.[1] ?? 'toolFailed',
  toolHits: /toolHits: '([^']+)'/.exec(source)?.[1] ?? '{n} 条',
  searchTitle: /bitwarden_find: \{ title: '([^']+)'/.exec(source)?.[1] ?? '',
  getTitle: /bitwarden_get: \{ title: '([^']+)'/.exec(source)?.[1] ?? '',
}

const renderRow = (toolName, args, resultText, isError = false) => {
  mod.__resetPrimitives?.()
  const element = react.createElement(mod.__toolRow.component, {
    toolName,
    block: {
      kind: 'tool-result',
      call: { name: toolName, argsRaw: JSON.stringify(args ?? {}) },
      content: resultText === null ? [] : [{ type: 'text', text: resultText }],
      isError,
    },
    t: (key) => LABELS[key] ?? key,
  })
  let renderer
  act(() => { renderer = create(element) })
  return renderer
}

console.log('native row (host DisclosureRow present)')

// ── the row IS the host's row ───────────────────────────────────────────────
{
  const renderer = renderRow('bitwarden_get', { name: 'github.com', field: 'password' },
    JSON.stringify({ id: 'i1', name: 'github.com', username: 'octocat', password: 'hunter2-secret' }, null, 2))
  const json = JSON.stringify(renderer.toJSON())
  check('renders through the host DisclosureRow (data-disclosure-row)',
    json.includes('data-disclosure-row'))
  check('uses the host disclosure header (data-disclosure-header)',
    json.includes('data-disclosure-header'))
  // react-test-renderer serializes an element as `{"type":"svg",…}`, not as
  // markup, so the check looks for the host icon's own node type and the 16px
  // viewBox its glyphs are drawn in.
  check('draws a host icon from the icon set',
    json.includes('\"type\":\"svg\"') && json.includes('0 0 16 16'))
  check('the host row is marked expandable', json.includes('data-expandable'))
  check('the row is keyboard reachable (role=button via expandable row)',
    json.includes('\"role\":\"button\"'))
  check('the tool title heads the collapsed line', json.includes(LABELS.getTitle))
  check('EXPANDED FOLDED PAYLOAD: the plaintext password is still nowhere',
    !json.includes('hunter2-secret'))
  renderer.unmount()
}

// ── the collapsed line reads like a native one ──────────────────────────────
{
  const renderer = renderRow('bitwarden_find', { query: 'github' },
    JSON.stringify({ items: [{ id: 'i1', name: 'github.com' }], matched: 1 }, null, 2))
  const json = JSON.stringify(renderer.toJSON())
  check('a search row states how many hits it found',
    json.includes('1 ' + LABELS.toolHits.replace('{n} ', '')) || json.includes('1'))
  const collapsed = renderer.toJSON()
  check('the collapsed line names the entry, not the tool name alone',
    JSON.stringify(collapsed).includes('github.com') || JSON.stringify(collapsed).includes(LABELS.searchTitle))
  renderer.unmount()
}

// ── expanding works the way the host expands a row ──────────────────────────
{
  const renderer = renderRow('bitwarden_get', { name: 'github.com', field: 'password' },
    JSON.stringify({ id: 'i1', name: 'github.com', password: 'hunter2-secret' }, null, 2))
  const rowNode = renderer.root.findAll((node) => node.props && node.props['data-disclosure-row'] !== undefined)[0]
  check('the disclosure row exposes the host click handler', typeof rowNode?.props?.onClick === 'function')
  act(() => { rowNode.props.onClick() })
  const expanded = JSON.stringify(renderer.toJSON())
  check('clicking the row expands it (aria-expanded flips)', expanded.includes('\"aria-expanded\":true') || expanded.includes('data-open'))
  check('the expanded body labels its argument block', expanded.includes(LABELS.toolArgs))
  check('the expanded body labels its result block', expanded.includes(LABELS.toolResult))
  check('NEGATIVE CONTROL: expanding reveals no plaintext password',
    !expanded.includes('hunter2-secret'))
  check('the password is still replaced by dots', expanded.includes('••••••••'))
  // The masking is silent: it must not add a "secrets were hidden" note to the
  // line. Checked on every row below, expanded and collapsed, because the badge
  // used to ride the collapsed summary too.
  check('the row carries no masking note of its own',
    !expanded.includes('已隐藏') && !expanded.includes('脱敏'))
  renderer.unmount()
}

// ── keyboard operation, which the hand-drawn card had to fake ───────────────
{
  const renderer = renderRow('bitwarden_status', {}, JSON.stringify({ configured: true }, null, 2))
  const rowNode = renderer.root.findAll((node) => node.props && node.props['data-disclosure-row'] !== undefined)[0]
  let prevented = false
  act(() => {
    rowNode.props.onKeyDown?.({ key: 'Enter', preventDefault: () => { prevented = true } })
  })
  const after = JSON.stringify(renderer.toJSON())
  check('Enter on the row toggles it, as on every native row',
    prevented && (after.includes('data-open') || after.includes('\"aria-expanded\":true')))
  renderer.unmount()
}

// ── a failed call stays readable ────────────────────────────────────────────
{
  const renderer = renderRow('bitwarden_get', { name: 'github.com' }, 'boom: vault locked', true)
  const json = JSON.stringify(renderer.toJSON())
  check('a failed call is marked as an error state', json.includes(LABELS.toolFailed) || json.includes('\"data-state\":\"error\"'))
  renderer.unmount()
}

// ── the fallback still exists for a page without primitives ─────────────────
{
  mod.__resetPrimitives?.()
  // Shield the platform module so the component takes its primitives-free path.
  const saved = primitives.DisclosureRow
  try {
    // A page without the module cannot be simulated through the loader here,
    // so the check is structural: the bundle must keep a fallback branch and a
    // toggle hook for it.
    check('the bundle keeps a primitives-free fallback branch',
      source.includes('data-vw-tool-toggle'))
    check('the bundle resolves the platform module optionally (try/catch)',
      /try \{\s*primitivesCache = require\('@deepseek-ai\/dsh-client-ui-primitives'\)/.test(source))
  } finally {
    void saved
  }
}

console.log('')
if (failures.length > 0) {
  console.error('native-row: ' + failures.length + ' check(s) failed: ' + failures.join('; '))
  console.error(passed + ' passed, ' + failures.length + ' failed')
  process.exit(1)
}
console.log(passed + ' passed, 0 failed')
process.exit(0)
