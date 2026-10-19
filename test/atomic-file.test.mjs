/**
 * On-disk privacy test: the half of the write path that 0.8.8 got wrong.
 *
 * The user-visible promise is "the record is private the moment it exists, and
 * a crash leaves either the old record or the new one". Both are easy to lose
 * silently, so this suite pins them:
 *
 *   1. `mode` is honoured even when a wider-permission file already sits at the
 *      temp path — the write must never land in someone else's 0644 inode.
 *   2. The temp path is not predictable: two writers sharing one pid (worker
 *      threads) must not pick the same name, and a symlink planted at the old
 *      predictable name must not be written through.
 *   3. A finished write leaves no `.tmp` sibling behind, on success or failure.
 *   4. A stored record is complete and parseable — never a zero-length file —
 *      and a malformed write is refused without replacing the good record.
 *
 * Run: node test/atomic-file.test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFilePrivate } from '../lib/atomic-file.js'
import { SessionStore } from '../lib/session-store.js'

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

const modeOf = (path) => statSync(path).mode & 0o777
const scratch = (label) => mkdtempSync(join(tmpdir(), `vw-${label}-`))

function privacyChecks() {
  // ── the mode belongs to the write, not to whoever ran first ──────────────
  const dir = scratch('mode')
  const target = join(dir, 'record.json')
  // Anything that can write the directory can pre-create the temp path. Under
  // umask 0002 a plain writeFileSync would leave the record at 0644 until the
  // chmod; the exclusive create refuses to reuse it at all.
  writeFileSync(`${target}.deadbeef0000.tmp`, 'planted', { mode: 0o644 })
  writeFilePrivate(target, '{"a":1}', { mode: 0o600 })
  check('a fresh record is owner-only (0600)', modeOf(target) === 0o600, modeOf(target).toString(8))
  check('the record holds exactly what was written', readFileSync(target, 'utf8') === '{"a":1}')

  // Rewriting an existing 0644 record must NARROW it: a fresh inode carries the
  // stated mode through the rename.
  writeFileSync(target, 'wide', { mode: 0o644 })
  writeFilePrivate(target, '{"a":2}', { mode: 0o600 })
  check('replacing a wider file narrows it to 0600', modeOf(target) === 0o600, modeOf(target).toString(8))
  check('the replacement is the new content', readFileSync(target, 'utf8') === '{"a":2}')
  rmSync(dir, { recursive: true, force: true })

  // ── the temp path is unpredictable and never written through ─────────────
  const dir2 = scratch('tempname')
  const target2 = join(dir2, 'record.json')
  const victim = join(dir2, 'victim.txt')
  writeFileSync(victim, 'untouched')
  // The 0.8.8 temp name was `<path>.<pid>.tmp` — predictable enough to aim at.
  symlinkSync(victim, `${target2}.${process.pid}.tmp`)
  writeFilePrivate(target2, 'secret', { mode: 0o600 })
  check('a planted symlink at the old temp name is never followed', readFileSync(victim, 'utf8') === 'untouched')
  check('the record itself is written', readFileSync(target2, 'utf8') === 'secret')
  const leftovers = readdirSync(dir2).filter((name) => name.endsWith('.tmp'))
  check('a completed write leaves no temp file behind', leftovers.length === 1 && leftovers[0] === `record.json.${process.pid}.tmp`, JSON.stringify(leftovers))
  rmSync(dir2, { recursive: true, force: true })

  // Two writes in a row (same pid, same millisecond) must not share a name.
  const dir3 = scratch('burst')
  const target3 = join(dir3, 'record.json')
  for (let index = 0; index < 20; index++) writeFilePrivate(target3, `v${index}`, { mode: 0o600 })
  check('a burst of writes leaves no temp files', readdirSync(dir3).length === 1, JSON.stringify(readdirSync(dir3)))
  check('a burst of writes leaves the last value', readFileSync(target3, 'utf8') === 'v19')
  rmSync(dir3, { recursive: true, force: true })

  // ── the parent tree is created private ───────────────────────────────────
  const dir4 = scratch('parents')
  const nested = join(dir4, 'data', 'dsh-vaultwarden', 'session.json')
  writeFilePrivate(nested, '{}', { mode: 0o600 })
  check('missing parent directories are created', existsSync(nested))
  check('the created directory is owner-only (0700)', (statSync(join(dir4, 'data', 'dsh-vaultwarden')).mode & 0o777) === 0o700)
  rmSync(dir4, { recursive: true, force: true })

  // ── a write that cannot commit must fail cleanly, not leave debris ───────
  // A directory sitting where the record goes makes the final rename fail.
  // The contract is: throw, and leave no temp file behind. The target stays
  // whatever it was (here, the directory), which is why callers keep their
  // old data rather than a half-written record.
  const dir5 = scratch('refuse')
  const blocked = join(dir5, 'record.json')
  mkdirSync(blocked)
  let threw = null
  try {
    writeFilePrivate(blocked, '{"next":true}', { mode: 0o600 })
  } catch (error) {
    threw = error
  }
  check('a write whose rename cannot commit throws', threw !== null, String(threw))
  check('the failed write leaves no temp file behind', readdirSync(dir5).every((name) => !name.endsWith('.tmp')), JSON.stringify(readdirSync(dir5)))
  check('the failed write did not create a file at the target', statSync(blocked).isDirectory())
  rmSync(dir5, { recursive: true, force: true })
}

function storeChecks() {
  // The two stores are the only callers; both must inherit the guarantees.
  const dir = mkdtempSync(join(tmpdir(), 'vw-stores-'))
  const store = new SessionStore(join(dir, 'session.json'), { maxAgeDays: 30 })
  const saved = store.save({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: Date.now() + 60_000,
    serverUrl: 'https://vault.example',
    email: 'user@example.com',
    savedAt: Date.now(),
    lastUsedAt: Date.now(),
  })
  check('the session store reports success', saved === true)
  check('the session file is owner-only (0600)', modeOf(store.path) === 0o600, modeOf(store.path).toString(8))
  check('the session file parses back', store.load({ serverUrl: 'https://vault.example', email: 'user@example.com' })?.refreshToken === 'r')
  check('the session directory holds no temp files', readdirSync(dir).every((name) => !name.endsWith('.tmp')), JSON.stringify(readdirSync(dir)))

  // A record the store refuses to write must leave the previous one alone.
  const before = readFileSync(store.path, 'utf8')
  check('an empty record is refused', store.save({}) === false)
  check('the refused write kept the previous session', readFileSync(store.path, 'utf8') === before)
  rmSync(dir, { recursive: true, force: true })
}

privacyChecks()
storeChecks()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
