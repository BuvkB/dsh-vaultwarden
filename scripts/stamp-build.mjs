#!/usr/bin/env node
/**
 * Stamp the build identity into the browser bundle.
 *
 * The panel's heading shows the version and the repo. A browser bundle cannot
 * read package.json, and asking the host for it means changing the node half —
 * which only takes effect after a restart, so a freshly-built bundle would
 * show nothing until then. Stamping the values in here closes that gap AND
 * makes the fallback impossible to hand-maintain: it is rewritten from
 * package.json on every build.
 *
 * Both values are declared in lib/client.js as:
 *   const BUILD_VERSION = '…'
 *   const BUILD_REPOSITORY = '…'
 * The rewrite is idempotent, so a second build produces the same bytes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const repo = String(pkg.repository?.url ?? '')
  .replace(/^git\+/, '')
  .replace(/#.*$/, '')
  .replace(/\.git$/, '')

const file = join(root, 'lib', 'client.js')
const before = readFileSync(file, 'utf8')
let src = before
  .replace(/const BUILD_VERSION = '[^']*'/, `const BUILD_VERSION = '${pkg.version}'`)
  .replace(/const BUILD_REPOSITORY = '[^']*'/, `const BUILD_REPOSITORY = '${repo}'`)

if (src === before && !before.includes(`const BUILD_VERSION = '${pkg.version}'`)) {
  console.error('stamp-build: could not find the BUILD_VERSION / BUILD_REPOSITORY literals')
  process.exit(1)
}
writeFileSync(file, src)
console.log('  version ' + pkg.version + ' · ' + repo)
