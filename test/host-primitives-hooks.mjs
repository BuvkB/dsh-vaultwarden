/**
 * Node loader hooks that make the HOST's browser modules loadable offline.
 *
 * The native-row suite asserts against the real
 * `@deepseek-ai/dsh-client-ui-primitives` — the module the host's own tool rows
 * are built from — rather than a hand-written stub of it. A stub would only
 * re-state this repo's assumptions about the component (props, class names,
 * which DOM it draws), and a test whose double copies the implementation's
 * assumptions cannot catch the implementation being wrong about the host.
 *
 * Installing the real module needs three accommodations, all of them about
 * module FORMAT, none about behaviour:
 *
 *   1. `@deepseek-ai/*` packages are ESM and must keep their real format. They
 *      resolve by directory, which ESM refuses, so each is pointed at its
 *      `lib/index.js` entry.
 *   2. Third-party leaves (clsx, katex, shiki, anser, simple-icons, micromark,
 *      react-dom, …) are imported by the module but never reached by the
 *      components under test. They are stubbed. Because an ESM stub cannot
 *      invent named bindings, the names come from the IMPORTING file's own
 *      `import { … } from "<spec>"` line — the stub declares exactly what its
 *      consumer asks for.
 *   3. The stub proxy must answer `Symbol.toPrimitive` (the module builds
 *      object keys from imported constants) and return itself from `apply` /
 *      `construct` (it kicks off a background grammar warm-up whose result is
 *      discarded here).
 *
 * `.module.css` imports become an inert proxy: this suite asserts structure,
 * not colour, and the stylesheet itself is the host's own file.
 */
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const HOST_PKGS = "/home/tinyog/.dsh-runtime/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
const REACT_ROOT = "/home/tinyog/dsh/dsh-vaultwarden/node_modules"

/** Escape one specifier for use inside a RegExp. */
const reEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The names a stubbed module must declare, read from the file importing it.
 * @param specifier - the bare specifier being stubbed.
 * @param parentURL - the importing module's URL, from the resolve context.
 * @returns requested binding names, possibly empty.
 */
const namesRequestedBy = (specifier, parentURL) => {
  if (!parentURL) return []
  let source = ''
  try {
    source = readFileSync(new URL(parentURL), 'utf8')
  } catch {
    return []
  }
  const names = new Set()
  const pattern = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"\`]' + reEscape(specifier) + '[\'"\`]', 'g')
  for (const match of source.matchAll(pattern)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\\s+as\\s+/)[0].trim()
      if (name) names.add(name)
    }
  }
  return [...names]
}

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) {
    return { url: 'css:' + specifier, format: 'module', shortCircuit: true }
  }
  if (specifier === 'react') {
    return { url: pathToFileURL(REACT_ROOT + '/react/index.js').href, shortCircuit: true }
  }
  if (specifier === 'react/jsx-runtime') {
    return { url: pathToFileURL(REACT_ROOT + '/react/jsx-runtime.js').href, shortCircuit: true }
  }
  if (specifier.startsWith('@deepseek-ai/')) {
    const [scope, path] = [specifier.slice('@deepseek-ai/'.length).split('/')[0], specifier.slice('@deepseek-ai/'.length).split('/').slice(1).join('/')]
    const dir = scope.startsWith('dsh-') ? scope : 'dsh-' + scope
    return next(HOST_PKGS + '/' + dir + '/' + (path === '' ? 'lib/index.js' : path), context)
  }
  // A bare specifier is a package leaf. Anything addressed as a real location
  // — a relative path, an absolute path, or an explicit file:/data: URL — is a
  // module that actually exists and must be loaded, never stubbed.
  const bare = !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('file:') &&
    !specifier.startsWith('data:') &&
    !specifier.startsWith('node:') &&
    !specifier.startsWith('css:') &&
    !specifier.startsWith('stub:')
  if (bare) {
    const names = namesRequestedBy(specifier, context.parentURL)
    return { url: 'stub:' + specifier + '?names=' + encodeURIComponent(names.join(',')), format: 'module', shortCircuit: true }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.startsWith('css:')) {
    return { format: 'module', shortCircuit: true, source: 'export default new Proxy({}, { get: (t, key) => "css_" + String(key) })' }
  }
  if (url.startsWith('stub:')) {
    const names = decodeURIComponent(new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('names') ?? '')
      .split(',')
      .filter(Boolean)
    const source = [
      'const stub = function () {}',
      'const proxy = new Proxy(stub, {',
      "  get: (target, key) => key === Symbol.toPrimitive || key === 'toString' ? () => 'stub' : proxy,",
      '  apply: () => proxy,',
      '  construct: () => proxy,',
      '})',
      'export default proxy',
      ...names.map((name) => 'export const ' + name + ' = proxy'),
    ].join('\n')
    return { format: 'module', shortCircuit: true, source }
  }
  return next(url, context)
}
