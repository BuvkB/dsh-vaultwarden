/**
 * Local half of a release: prove the tree is the one that should ship, then
 * let CI do the building.
 *
 * The package builds nothing (plain ESM, no compile step), so "did the build
 * change the files" is not the question here. The questions that do bite are
 * the ones a tag cannot fix after the fact:
 *
 *   - does the tree have uncommitted work that the tag would not contain?
 *   - do package.json, the browser bundle's stamped version and the CHANGELOG
 *     heading agree on ONE number?
 *   - will npm actually ship the files the plugin needs at runtime?
 *
 * Everything this script checks is local and offline. Anything that needs the
 * network belongs to CI, where the tag already exists and a failure is visible
 * next to the publish.
 *
 * Usage: node scripts/preflight-release.mjs [--tag vX.Y.Z]
 * Exit code 1 when any check fails; every check prints so a failure names
 * itself instead of leaving a bare stack trace.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(pkg.version ?? '')
const tagArgIndex = process.argv.indexOf('--tag')
const expectedTag = tagArgIndex >= 0 ? String(process.argv[tagArgIndex + 1] ?? '') : `v${version}`

let failed = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined || ok ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

console.log('release preflight: ' + pkg.name + '@' + version)
console.log('')

// ── the tag and the manifest must name the same release ──────────────────────
check('package.json carries a version', /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version), JSON.stringify(version))
check('the tag matches package.json', expectedTag === 'v' + version, `tag=${expectedTag} package=${version}`)

// ── nothing uncommitted may ride along invisibly ─────────────────────────────
let status = ''
try {
  status = run('git', ['status', '--porcelain']).trim()
} catch (error) {
  check('git status can be read', false, error.message)
}
check('the working tree is clean', status === '', status === '' ? undefined : status.split('\n').slice(0, 5).join(' | '))

let branch = ''
try {
  branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
} catch {
  /* the clean check above already reported an unreadable tree */
}
check('the release is cut from main', branch === 'main', branch)

// ── one version number everywhere the reader can see it ──────────────────────
const stamped = readFileSync(join(root, 'lib', 'client.js'), 'utf8').match(/const BUILD_VERSION = '([^']*)'/)
check('the browser bundle is stamped with this version', stamped?.[1] === version, `stamp=${stamped?.[1]} package=${version}`)
if (stamped?.[1] !== version) {
  console.log('       fix: node scripts/stamp-build.mjs')
}

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const sectionPattern = new RegExp('^## \\[' + version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]', 'm')
const sectionStart = changelog.search(sectionPattern)
check('CHANGELOG has a section for this version', sectionStart >= 0, `no "## [${version}]" heading`)
if (sectionStart >= 0) {
  const rest = changelog.slice(sectionStart)
  const nextHeading = rest.slice(4).search(/^## \[/m)
  const body = (nextHeading >= 0 ? rest.slice(4, 4 + nextHeading) : rest).replace(/^## \[[^\]]*\][^\n]*\n?/, '')
  const entries = body.split('\n').filter((line) => /^[-*] /.test(line.trim()))
  check('the CHANGELOG section has entries', entries.length > 0, String(entries.length) + ' entries')
}

// ── what npm will actually ship ──────────────────────────────────────────────
let packed = null
try {
  const output = run('npm', ['pack', '--dry-run', '--json'])
  packed = JSON.parse(output)[0]
} catch (error) {
  check('npm pack --dry-run succeeds', false, error.message)
}
if (packed) {
  const files = new Set((packed.files ?? []).map((file) => file.path))
  for (const required of ['package.json', 'lib/index.js', 'lib/client.js', 'lib/gateway.js', 'CHANGELOG.md', 'README.md']) {
    check('the tarball carries ' + required, files.has(required))
  }
  // `scripts/` is part of the published package on purpose (build.sh documents
  // how the tree is prepared); the test corpus is not.
  const leaked = [...files].filter((path) => /^test\//.test(path))
  check('the tarball carries no tests', leaked.length === 0, leaked.slice(0, 5).join(', '))
}

// ── every shipped module must parse on the runtime that will load it ─────────
const modules = ['lib/index.js', 'lib/client.js', 'lib/gateway.js', 'lib/vault.js', 'lib/mutations.js', 'lib/trail.js', 'lib/settings-write.js']
for (const module of modules) {
  try {
    run('node', ['--check', module])
    check('parses: ' + module, true)
  } catch (error) {
    check('parses: ' + module, false, String(error.stderr ?? error.message).split('\n')[0])
  }
}

console.log('')
if (failed > 0) {
  console.log(`release preflight: ${failed} check(s) failed — fix them before tagging.`)
  process.exit(1)
}
console.log('release preflight: all checks passed. Push the tag; CI builds and publishes.')
