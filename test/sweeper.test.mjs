/**
 * Log-sweep tests against a synthetic session directory.
 *
 * Builds a sessions root that mirrors the real layout
 * (<ws>/session-<uuid>/session.v4.jsonl.zstd + session.lock), runs the
 * sweeper, and asserts: secrets in bitwarden tool events are replaced,
 * placeholders and non-bitwarden lines survive, idle gating works, and the
 * rewrite is atomic with permissions preserved.
 *
 * Run: node test/sweeper.test.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { listSessionLogs, isIdle, sweepLog, sweepAll } from '../lib/sweeper.js'

let passed = 0
let failed = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    passed++
    console.log('  ✓ ' + label)
  } else {
    failed++
    console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''))
  }
}

// Plaintext built by concatenation so the fixture itself never carries the
// secret as a literal (the host masks password-shaped strings in flight).
const SECRET_PW = ['Su', 'per', 'Se', 'cr', 'et', '1!'].join('')
const SECRET_TOTP = ['65', '43', '21'].join('')
const PLACEHOLDER = '{{BW_PASSWORD_stmdbpbt}}'

const zstdCompress = (text) => {
  const proc = spawnSync('zstd', ['-q', '-19', '-T0', '-c'], { input: text, maxBuffer: 1 << 28 })
  if (proc.status !== 0) throw new Error('zstd compress failed: ' + proc.stderr)
  return proc.stdout
}
const zstdDecompress = (bytes) => {
  const proc = spawnSync('zstd', ['-d', '-c'], { input: bytes, maxBuffer: 1 << 28 })
  if (proc.status !== 0) throw new Error('zstd decompress failed: ' + proc.stderr)
  return proc.stdout.toString('utf8')
}

const makeSession = (root, uuid, events, { ageSeconds = 3600, withLock = true } = {}) => {
  const dir = join(root, 'ws--x', 'session-' + uuid)
  mkdirSync(dir, { recursive: true })
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const logPath = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(logPath, zstdCompress(lines), { mode: 0o640 })
  const stamp = new Date(Date.now() - ageSeconds * 1000)
  utimesSync(logPath, stamp, stamp)
  if (withLock) writeFileSync(join(dir, 'session.lock'), '', { mode: 0o640 })
  utimesSync(join(dir, 'session.lock'), stamp, stamp)
  return logPath
}

// event builders mirroring the host's session.v4 shape
const sessionHeader = { type: 'session', version: 4, id: 's1', startedAt: 1 }
const toolCall = (name, args) => ({ type: 'tool/call', seq: 2, time: 1, data: { turn: 1, step: 1, callId: 'c1', name, arguments: JSON.stringify(args) } })
const toolResult = (text) => ({ type: 'tool/result', seq: 3, time: 1, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text }] } } })
const userMessage = (text) => ({ type: 'user/message', seq: 4, time: 1, data: { message: { role: 'user', content: [{ type: 'text', text }] } } })

const root = mkdtempSync(join(tmpdir(), 'bw-sweep-'))
try {
  const idleLog = makeSession(root, 'aaa', [
    sessionHeader,
    toolCall('bitwarden_create', { name: 'n', password: SECRET_PW, totp: SECRET_TOTP }),
    toolResult(JSON.stringify({ password: SECRET_PW, notes: 'fine to keep structure' }, null, 2)),
    toolResult(JSON.stringify({ password: PLACEHOLDER })),
    toolCall('run_code', { code: 'const pw = ' + JSON.stringify(SECRET_PW) + '; use(pw)' }),
    userMessage('the password ' + SECRET_PW + ' is in my notes'),
  ])
  const busyLog = makeSession(root, 'bbb', [sessionHeader, toolCall('bitwarden_get', { name: 'n', field: 'password' })], { ageSeconds: 30 })
  const plainLog = makeSession(root, 'ccc', [sessionHeader, toolCall('bitwarden_find', { query: 'n' }), toolResult('[]')])

  // ── discovery & idle gating ────────────────────────────────────────────────
  const logs = listSessionLogs(root)
  check('all three session logs are discovered', logs.length === 3, String(logs.length))
  check('the idle log is idle', isIdle(idleLog, { idleSeconds: 600 }))
  check('the busy log is not idle', !isIdle(busyLog, { idleSeconds: 600 }))
  const noLockDir = mkdtempSync(join(tmpdir(), 'bw-sweep-nolock-'))
  try {
    const exported = join(noLockDir, 'session.v4.jsonl.zstd')
    writeFileSync(exported, zstdCompress(JSON.stringify(sessionHeader) + '\n'), { mode: 0o644 })
    check('a log without a lock (export copy) counts as idle', isIdle(exported, { idleSeconds: 0 }))
  } finally {
    rmSync(noLockDir, { recursive: true, force: true })
  }

  // ── single-log sweep ────────────────────────────────────────────────────────
  const result = sweepLog(idleLog, { skipIdleCheck: false })
  check('idle log reports redacted', result.status === 'redacted' && result.redacted > 0, JSON.stringify(result))
  const raw = readFileSync(idleLog)
  const after = zstdDecompress(raw)
  const afterEvents = after.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const bwCallsAfter = afterEvents.filter((ev) => ev.type === 'tool/call' && String(ev.data?.name ?? '').startsWith('bitwarden_'))
  const bwResultsAfter = afterEvents.filter((ev) => ev.type === 'tool/result' && ev.data?.message?.toolCallId === 'c1')
  check('bitwarden call arguments carry no plaintext', bwCallsAfter.every((ev) => !String(ev.data?.arguments ?? '').includes(SECRET_PW) && !String(ev.data?.arguments ?? '').includes(SECRET_TOTP)))
  check('bitwarden result text carries no plaintext (callId matching)', bwResultsAfter.every((ev) => !JSON.stringify(ev.data?.message?.content ?? []).includes(SECRET_PW)))
  check('plaintext totp is gone from the log', !after.includes(SECRET_TOTP))
  check('placeholder result survives untouched', after.includes(PLACEHOLDER))
  // phase 3 hunts harvested values through any tool event's text fields,
  // so run_code arguments quoting the secret are swept too; the tool name
  // and event structure survive.
  check('non-bitwarden tool names survive', after.includes('"run_code"'))
  const runCodeCallAfter = afterEvents.find((ev) => ev.type === 'tool/call' && ev.data?.name === 'run_code')
  check('run_code arguments echoing the secret are swept too', !!runCodeCallAfter && !String(runCodeCallAfter.data?.arguments ?? '').includes(SECRET_PW))
  check('user prose is never rewritten even when it names a secret', after.includes('is in my notes'))
  check('session header line survives', after.includes('"type":"session"'))
  check('permissions are preserved across the rewrite', (statSync(idleLog).mode & 0o777) === 0o640)

  // The host reads the header via readFirstZstdLine(): it decompresses ONLY the
  // first complete frame and requires exactly one line ending in a newline
  // (assertZstdHeaderFrame). A sweep that re-encodes the whole log as one frame
  // makes the host call the file corrupt — SessionPersistenceCorruptionError —
  // and the session silently vanishes from the workspace index. Guard the frame
  // layout, not just the textual content.
  const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const frameOffsets = []
  for (let i = raw.indexOf(ZSTD_MAGIC); i !== -1; i = raw.indexOf(ZSTD_MAGIC, i + 4)) frameOffsets.push(i)
  check('a swept log keeps at least two zstd frames', frameOffsets.length >= 2, 'frames=' + frameOffsets.length)
  if (frameOffsets.length >= 2) {
    const firstFrame = raw.subarray(frameOffsets[0], frameOffsets[1])
    const firstPlain = zstdDecompress(firstFrame)
    check('the first frame decodes to exactly one header line', firstPlain.endsWith('\n') && firstPlain.indexOf('\n') === firstPlain.length - 1, JSON.stringify(firstPlain.slice(0, 80)))
    check('the first frame is the session header', firstPlain.startsWith('{"type":"session"'))
  }

  // idempotence: a second sweep finds nothing to do
  const second = sweepLog(idleLog)
  check('second sweep is clean', second.status === 'clean', JSON.stringify(second))

  // busy log untouched
  const busy = sweepLog(busyLog)
  check('busy log is skipped', busy.status === 'busy', JSON.stringify(busy))

  // ── sweepAll ───────────────────────────────────────────────────────────────
  const report = sweepAll(root)
  check('sweepAll scans every log', report.scanned === 3, JSON.stringify(report))
  check('sweepAll reports the busy one', report.busy === 1)
  check('sweepAll with nothing left is all clean', report.redactedFiles === 0 && report.errors.length === 0)

  // non-bitwarden log content is byte-identical after a sweep that touches it zero times
  const plainBefore = readFileSync(plainLog)
  sweepLog(plainLog)
  check('a bitwarden log without secrets is not rewritten', readFileSync(plainLog).equals(plainBefore))

  // ── code/PTC channel + discovery gaps (regressions fixed after audit) ────
  // Real shapes captured from a live dsh 0.2.1-rc.3 host: in code/PTC mode
  // bitwarden plaintext travels on tool/ptc-dispatch(-start) only, and
  // tool/call + tool/result never appear for these tools.
  const ptcDispatchStart = (name, args) => ({ type: 'tool/ptc-dispatch-start', seq: 2, time: 1, data: { name, subCallId: 'sc1', rootCallId: 'rc1', parentCallId: 'pc1', arguments: JSON.stringify(args) } })
  const ptcDispatch = (name, resultObj) => ({ type: 'tool/ptc-dispatch', seq: 3, time: 1, data: { name, subCallId: 'sc1', rootCallId: 'rc1', parentCallId: 'pc1', isError: false, content: [{ type: 'text', text: JSON.stringify(resultObj) }] } })

  const ptcLog = makeSession(root, 'ddd', [
    sessionHeader,
    ptcDispatchStart('bitwarden_get', { name: 'n', field: 'password' }),
    ptcDispatch('bitwarden_get', { base: { id: 'e1', name: 'n', username: 'u@example.com' }, password: SECRET_PW }),
    ptcDispatchStart('bitwarden_create', { name: 'n2', password: SECRET_PW, notes: 'x'.repeat(30) }),
    ptcDispatch('bitwarden_get', { base: { id: 'e1', name: 'n' }, totp: { code: SECRET_TOTP, period: 30, remaining: 15 } }),
  ])
  const ptc = sweepLog(ptcLog)
  const ptcAfter = zstdDecompress(readFileSync(ptcLog))
  check('ptc-dispatch result plaintext is swept', ptc.status === 'redacted' && ptcAfter.includes('[REDACTED:BW]'), JSON.stringify(ptc))
  check('ptc-dispatch-start arguments are swept', !ptcAfter.includes(SECRET_PW))
  check('ptc totp code is swept', !ptcAfter.includes(SECRET_TOTP))
  check('ptc sweep is idempotent', sweepLog(ptcLog).status === 'clean')

  // a bare (non session-*) directory and a superseded v3 log are both found
  const bareDir = join(root, 'ws--x', 'plain-uuid-no-prefix')
  mkdirSync(bareDir, { recursive: true })
  const bareLog = join(bareDir, 'session.v4.jsonl.zstd')
  writeFileSync(bareLog, zstdCompress(JSON.stringify(ptcDispatch('bitwarden_get', { password: SECRET_PW })) + '\n'), { mode: 0o640 })
  const oldStamp = new Date(Date.now() - 3600 * 1000)
  utimesSync(bareLog, oldStamp, oldStamp)
  const v3Log = join(dirname(idleLog), 'session.v3.jsonl.zstd')
  writeFileSync(v3Log, zstdCompress(JSON.stringify(ptcDispatch('bitwarden_reveal', { password: SECRET_PW })) + '\n'), { mode: 0o640 })
  utimesSync(v3Log, oldStamp, oldStamp)
  sweepAll(root)
  check('bare directory log is discovered and swept', !zstdDecompress(readFileSync(bareLog)).includes(SECRET_PW))
  check('superseded v3 log is discovered and swept', !zstdDecompress(readFileSync(v3Log)).includes(SECRET_PW))

  // a minimal embedded-JSON result (below any length threshold) is still swept
  const shortLog = makeSession(root, 'eee', [
    sessionHeader,
    toolCall('bitwarden_get', { name: 'n', field: 'password' }),
    toolResult(JSON.stringify({ password: SECRET_PW })),
  ])
  sweepLog(shortLog)
  check('short embedded JSON result is swept', !zstdDecompress(readFileSync(shortLog)).includes(SECRET_PW))

  // ── phase 3: echo hunting through non-bitwarden tool events ────────────
  // In code mode the run_code aggregate tool/result quotes its bitwarden
  // sub-calls' output as free text under a run_code-named event; the name
  // filter never sees that, so harvested values must be hunted by content.
  const echoLog = makeSession(root, 'fff', [
    sessionHeader,
    ptcDispatchStart('bitwarden_get', { name: 'n', field: 'password' }),
    ptcDispatch('bitwarden_get', { base: { id: 'e1', name: 'n' }, password: SECRET_PW }),
    toolCall('run_code', { code: 'const x = 1' }),
    toolResult('aggregate: password is ' + SECRET_PW + ' per bitwarden_get'),
  ])
  sweepLog(echoLog)
  const echoAfter = zstdDecompress(readFileSync(echoLog))
  check('run_code aggregate echo of a harvested secret is swept', !echoAfter.includes(SECRET_PW), echoAfter.slice(0, 200))
  check('echo replacement uses the marker', echoAfter.includes('password is [REDACTED:BW]'))
  check('echo sweep is idempotent', sweepLog(echoLog).status === 'clean')

  // a log with no bitwarden events harvests nothing on its own, so a bare
  // per-log sweepLog does not hunt there; cross-log hunting is sweepAll's
  // job (global seed) and is covered below.
  const noBwLog = makeSession(root, 'ggg', [
    sessionHeader,
    toolCall('run_code', { code: 'const x = 1' }),
    toolResult('just text that happens to contain ' + SECRET_PW),
  ])
  sweepLog(noBwLog)
  check('no bitwarden source means no value hunting', zstdDecompress(readFileSync(noBwLog)).includes(SECRET_PW))

  // ── cross-log echo: sweepAll seeds every hunt with the global harvest ──
  // A value revealed in log A and echoed by bash in log B: a per-log
  // sweepLog is blind to it (covered above); sweepAll pass 1 harvests the
  // union across all logs and hunts it everywhere.
  const srcLog = makeSession(root, 'hhh', [
    sessionHeader,
    ptcDispatchStart('bitwarden_get', { name: 'n', field: 'password' }),
    ptcDispatch('bitwarden_get', { base: { id: 'e1', name: 'n' }, password: SECRET_PW }),
  ])
  const dstLog = makeSession(root, 'iii', [
    sessionHeader,
    toolCall('bash', { command: 'echo pw' }),
    toolResult('the password is ' + SECRET_PW + ' ok'),
  ])
  const crossReport = sweepAll(root)
  check('sweepAll hunts cross-log echoes', !zstdDecompress(readFileSync(dstLog)).includes(SECRET_PW))
  check('sweepAll reports harvested values', crossReport.harvested > 0, JSON.stringify(crossReport))
  check('cross-log sweep is idempotent', sweepAll(root).redactedFiles === 0)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
