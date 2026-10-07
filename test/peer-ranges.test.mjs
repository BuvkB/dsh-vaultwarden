/**
 * Peer-range regression test: the manifest must admit the harness builds that
 * actually exist on npm.
 *
 * Background — npm's prerelease rule (node-semver): a range admits a
 * prerelease version only when some comparator carries the *same*
 * major.minor.patch tuple AND a prerelease tag itself. Every published
 * `@deepseek-ai/dsh-tools` / `dsh-typert-protocol` build is a prerelease, so a
 * range such as `>=0.1.0-rc.1 <0.3.0-0` silently admits 5 of the 30 published
 * builds and rejects the very harness that is running, which reaches users as
 * an npm ERESOLVE. The harness loader checks peers with
 * `{ includePrerelease: true }`, so a broken range does not fail loading — it
 * fails `npm install`, the path the marketplace falls back to.
 *
 * The manifest also used to declare a peer literally named `cordis`; no such
 * package exists in the runtime (it is `@deepseek-ai/cordis`), so that
 * declaration could never resolve to anything.
 *
 * The version lists below are the `npm view <pkg> versions` fixtures for the
 * packages the plugin imports; they are intentionally hard-coded so the guard
 * keeps working offline. Update them when the harness publishes a release.
 *
 * Run: node test/peer-ranges.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const peers = manifest.peerDependencies ?? {}

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

/**
 * Everything the harness has published for the packages we import, split by
 * whether the plugin is meant to support it. The 0.0.1 line predates the
 * services the plugin needs and stays refused on purpose.
 */
const PUBLISHED = {
  '@deepseek-ai/dsh-tools': [
    '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
    '0.1.1-rc.1', '0.1.1-rc.2',
    '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
    '0.1.6-alpha.1', '0.1.6-alpha.2',
    '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2',
    '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1',
  ],
  '@deepseek-ai/dsh-typert-protocol': [
    '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
    '0.1.1-rc.1', '0.1.1-rc.2',
    '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
    '0.1.6-alpha.1', '0.1.6-alpha.2',
    '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2',
    '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1',
  ],
  '@deepseek-ai/schemastery': [
    '3.18.1-rc.1', '3.18.1-rc.4',
    '3.18.1', '3.18.2', '3.18.3', '3.18.4',
    '3.18.5-alpha.1',
  ],
  '@deepseek-ai/cordis': [
    '4.0.1-rc.1', '4.0.1-rc.4',
    '4.0.1', '4.0.2', '4.0.3', '4.0.4',
    '4.0.5-alpha.1',
  ],
}

/**
 * Load the same semver copy the host resolves. The plugin deliberately has no
 * runtime dependency on semver, so the test borrows one from the harness
 * installation and skips itself when none is reachable.
 */
function loadSemver() {
  const roots = [
    process.env.DSH_SEMVER_ROOT,
    join(homedir(), '.dsh/profiles/node_modules/semver'),
    join(homedir(), '.dsh/profiles/web/node_modules/semver'),
    join(homedir(), '.dsh-runtime/lib/node_modules/@deepseek-ai/dsh/node_modules/semver'),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const root of roots) {
    const entry = existsSync(join(root, 'index.js')) ? join(root, 'index.js') : root
    if (existsSync(entry) || existsSync(join(root, 'package.json'))) {
      try {
        return { semver: require(root), source: root }
      } catch {
        // try the next candidate
      }
    }
  }
  try {
    return { semver: require('semver'), source: 'semver (bare specifier)' }
  } catch {
    return null
  }
}

/** Versions of a published package that the declared range actually admits. */
const admitted = (semver, range, all) => all.filter((version) => semver.satisfies(version, range))

const included = (semver, range, version) => semver.satisfies(version, range)

function main() {
  const loaded = loadSemver()
  if (loaded === null) {
    console.log('no semver copy found next to a DSH installation — skipping peer-range checks')
    return
  }
  const { semver } = loaded
  console.log(`semver ${semver.version ?? ''} from ${loaded.source}\n`)

  console.log('peer declarations')
  for (const name of Object.keys(PUBLISHED)) {
    check(`${name} is declared as a peer`, name in peers, `peers: ${Object.keys(peers).join(', ')}`)
  }
  check(
    'every peer is optional (the host supplies them, npm must not fetch them)',
    Object.keys(peers).every((name) => manifest.peerDependenciesMeta?.[name]?.optional === true),
  )
  check(
    'no peer is declared under a name the harness does not provide',
    !('cordis' in peers),
    'the runtime package is @deepseek-ai/cordis; a bare "cordis" peer resolves to nothing',
  )

  console.log('\nprerelease coverage (npm view fixtures)')
  for (const [name, versions] of Object.entries(PUBLISHED)) {
    const range = peers[name]
    const ok = admitted(semver, range, versions)
    check(
      `${name}: admits every supported published build`,
      ok.length === versions.length,
      `${ok.length}/${versions.length} admitted by "${range}" — missing: ${versions.filter((v) => !ok.includes(v)).join(', ')}`,
    )
  }

  console.log('\nspecific builds the plugin must stay installable against')
  // The harness the plugin is developed and verified against. 0.2.1-alpha.1 is
  // the build the local ~/.dsh-runtime ships; the string comparisons above pin
  // every published build, this block pins the ones we actually open a session
  // against by name, so a range edit that drops one of them fails loudly here.
  for (const version of ['0.1.0-rc.6', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1']) {
    check(
      `@deepseek-ai/dsh-tools ${version} is admitted`,
      included(semver, peers['@deepseek-ai/dsh-tools'], version),
      `range: ${peers['@deepseek-ai/dsh-tools']}`,
    )
  }
  check(
    '@deepseek-ai/schemastery 3.18.1-rc.1 is admitted',
    included(semver, peers['@deepseek-ai/schemastery'], '3.18.1-rc.1'),
    `range: ${peers['@deepseek-ai/schemastery']}`,
  )
  check(
    '@deepseek-ai/schemastery 3.18.5-alpha.1 is admitted',
    included(semver, peers['@deepseek-ai/schemastery'], '3.18.5-alpha.1'),
    `range: ${peers['@deepseek-ai/schemastery']}`,
  )
  check(
    '@deepseek-ai/cordis 4.0.1-rc.1 is admitted',
    included(semver, peers['@deepseek-ai/cordis'], '4.0.1-rc.1'),
    `range: ${peers['@deepseek-ai/cordis']}`,
  )
  check(
    '@deepseek-ai/cordis 4.0.5-alpha.1 is admitted',
    included(semver, peers['@deepseek-ai/cordis'], '4.0.5-alpha.1'),
    `range: ${peers['@deepseek-ai/cordis']}`,
  )

  console.log('\nfuture versions must not be swallowed')
  const REFUSED = {
    '@deepseek-ai/dsh-tools': ['0.0.1-rc.1', '0.0.1-rc.5', '0.3.0-0', '0.3.0', '0.4.0', '1.0.0'],
    '@deepseek-ai/dsh-typert-protocol': ['0.0.1-rc.3', '0.3.0', '1.0.0'],
    '@deepseek-ai/schemastery': ['3.17.9', '4.0.0'],
    '@deepseek-ai/cordis': ['4.0.0-rc.10', '5.0.0'],
  }
  for (const [name, versions] of Object.entries(REFUSED)) {
    for (const version of versions) {
      check(
        `${name} ${version} is refused`,
        !included(semver, peers[name], version),
        `range: ${peers[name]}`,
      )
    }
  }

  console.log('\nnpm and the harness loader must agree on the running build')
  // app-boot validates peers with { includePrerelease: true }; anything it
  // loads must also be installable by npm, or `npm install` breaks on a
  // combination that the loader is happy with.
  const strict = peers['@deepseek-ai/dsh-tools']
  check(
    'a range strict enough for npm still admits the latest published build (includePrerelease)',
    included(semver, strict, '0.2.0-rc.2'),
    `range: ${strict}`,
  )

  console.log('\ninstalled runtime (if reachable)')
  const cordisRoots = [
    process.env.DSH_CORDIS_ROOT,
    join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/cordis/package.json'),
    join(homedir(), '.dsh/profiles/web/node_modules/@deepseek-ai/cordis/package.json'),
    join(homedir(), '.dsh-runtime/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/package.json'),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  const cordisPath = cordisRoots.find((candidate) => existsSync(candidate))
  if (cordisPath === undefined) {
    console.log('  (no installed @deepseek-ai/cordis found — skipped)')
  } else {
    const version = JSON.parse(readFileSync(cordisPath, 'utf8')).version
    check(
      `the installed @deepseek-ai/cordis ${version} is admitted`,
      included(semver, peers['@deepseek-ai/cordis'], version),
      `range: ${peers['@deepseek-ai/cordis']}`,
    )
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

try {
  main()
} catch (error) {
  console.error('test crashed:', error)
  process.exitCode = 1
}
