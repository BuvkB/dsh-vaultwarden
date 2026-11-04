/**
 * Post-release verification, without downloading anything.
 *
 * The old check downloaded the published tarball, unpacked it and compared
 * files with the source tree. Every one of those steps re-proves something the
 * hashes already state: GitHub records a sha256 per asset, and npm records a
 * sha512 for the tarball it accepted. Downloading only adds a transport check
 * (a good CDN does not corrupt a file) at the cost of unpacking and a source
 * diff that no longer means anything:
 *
 *   npm normalises a tarball's metadata differently across npm versions, so a
 *   local `npm pack` and a CI `npm pack` of IDENTICAL files produce different
 *   bytes. Measured: v0.15.0 local npm 10.9.8 -> 4790db5f…, CI npm 11.x ->
 *   b80b21cb…, while `diff -r` of the two unpacked trees was empty.
 *
 * So the checks that still mean something are the ones about AGREEMENT between
 * the places a release is published, and they are all hash reads:
 *
 *   1. the release exists, is published, and carries both asset names;
 *   2. the two assets are the same bytes (same digest) — the marketplace
 *      downloads the stable name while humans download the versioned one, and
 *      a release where they differ ships two different packages;
 *   3. npm serves this version and marks it `latest` (stable) or `rc`
 *      (release candidate), so the marketplace's update probe sees it.
 *
 * Usage: node scripts/verify-release.mjs [vX.Y.Z]
 * Exit code 1 when any check fails.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tag = process.argv[2] && !process.argv[2].startsWith('-') ? String(process.argv[2]) : 'v' + pkg.version
const version = tag.replace(/^v/, '')

let failed = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined || ok ? '' : ' — ' + detail}`)
  if (!ok) failed += 1
}
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

console.log('release verification: ' + pkg.name + ' ' + tag)
console.log('')

// ── the release page ────────────────────────────────────────────────────────
let release = null
try {
  release = JSON.parse(run('gh', ['release', 'view', tag, '--json', 'isDraft,isPrerelease,assets,url']))
} catch (error) {
  check('the GitHub release can be read', false, String(error.stderr ?? error.message).split('\n')[0])
}
if (release) {
  check('the release is published (not a draft)', release.isDraft === false)
  if (version.includes('-')) check('the release is a prerelease', release.isPrerelease === true)
  const assets = Array.isArray(release.assets) ? release.assets : []
  const byName = new Map(assets.map((asset) => [asset.name, asset]))
  const versioned = byName.get(`${pkg.name}-${version}.tgz`)
  const stable = byName.get(`${pkg.name}.tgz`)
  check('the versioned asset exists', Boolean(versioned), [...byName.keys()].join(', '))
  check('the stable asset exists', Boolean(stable), [...byName.keys()].join(', '))
  if (versioned && stable) {
    // The whole point of the hash read: both names must be one package.
    check('both assets carry a digest', Boolean(versioned.digest) && Boolean(stable.digest), `${versioned.digest} / ${stable.digest}`)
    check('the two assets are the same bytes', versioned.digest === stable.digest, `${versioned.digest} != ${stable.digest}`)
    check('the assets are not empty', versioned.size > 0 && stable.size > 0, `${versioned.size} / ${stable.size}`)
    console.log(`       ${versioned.name}: ${versioned.digest} (${versioned.size} bytes)`)
  }
}

// ── npm, where the marketplace's update probe looks ─────────────────────────
let npmVersion = ''
try {
  npmVersion = run('npm', ['view', `${pkg.name}@${version}`, 'version']).trim().replace(/^'|'$/g, '')
} catch (error) {
  check('npm serves this version', false, String(error.stderr ?? error.message).split('\n')[0])
}
check('npm serves this version', npmVersion === version, npmVersion || 'not found')

const distTag = version.includes('-') ? 'rc' : 'latest'
let tagged = ''
try {
  tagged = run('npm', ['view', pkg.name, `dist-tags.${distTag}`]).trim().replace(/^'|'$/g, '')
} catch {
  /* reported below */
}
check(`npm marks it ${distTag}`, tagged === version, tagged || 'unknown')

console.log('')
if (failed > 0) {
  console.log(`release verification: ${failed} check(s) failed.`)
  process.exit(1)
}
console.log('release verification: all checks passed — no download needed.')
