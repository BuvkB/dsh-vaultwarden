/**
 * Trail-index tests: the numbers the masking-trail page shows.
 *
 * The page reads no counter of its own — a mask is a placeholder the vault wrote
 * into a request or a redaction marker the sweeper left in a log it rewrote.
 * This suite builds those logs, index them, and asserts what the page would
 * say: the headline, the two rails that split it, the ledger, the date axis,
 * and the states (partial, empty, unreadable) it can be in.
 *
 * Two properties matter more than any single number here:
 *
 *  1. Counting a mask TWICE is the failure mode that makes the page useless,
 *     and it has two sources — a repeated event line, and a superseded log
 *     version sitting beside the current one. Both are covered below.
 *  2. Rescanning must not re-decode what was already read. A warm refresh is
 *     asserted to decode ZERO files, because the alternative is re-reading
 *     300 MB every time the panel opens (measured: 21 s cold).
 *
 * Run: node test/trail.test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync, renameSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFrame } from '../lib/zstd-log.js'
import { INDEX_VERSION, TrailIndex, aggregateTrail, trailRowDetail, trailReport, resetTrailIndex, TRAIL_RANGES } from '../lib/trail.js'

let passed = 0
let failed = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    passed++
    console.log('  ok ' + label)
  } else {
    failed++
    console.error('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

const DAY = 86400000
const NOW = Date.parse('2026-10-26T15:00:00+08:00')
const pad2 = (value) => (value < 10 ? '0' : '') + value
/** The page's day keys are LOCAL days (the axis is local), so the test computes
 *  its expectations with the same rule instead of a hard-coded string. */
const dayOf = (ms) => {
  const date = new Date(ms)
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

// ── fixtures: real event lines, compressed the way the host writes them ──────
const titleLine = (time, title) => JSON.stringify({ type: 'session/title', seq: 5, time, data: { title } })
const modelLine = (time, provider, model) => JSON.stringify({ type: 'model/selection', seq: 6, time, data: { provider, model } })
const headerLine = (time, provider = 'curi-gate', model = 'zcode/GLM-5.3') => JSON.stringify({ type: 'request/header', seq: 7, time, data: { header: { config: { provider, model } } } })
// The host writes request/header and request/context for the SAME request,
// adjacent seq and about 1 ms apart; the request count must not double.
const contextLine = (time, provider = 'curi-gate', model = 'zcode/GLM-5.3') => JSON.stringify({ type: 'request/context', seq: 8, time, data: { provider, model } })
// A masked vault result in the shape the PTC host actually writes: the tool
// NAME rides on the event itself (`data.name`), which is the positive
// allowlist the index counts by. A bare tool/result with no such name is text,
// however much it looks like a mask.
const maskLine = (time, callId, kind, tag) =>
  JSON.stringify({
    type: 'tool/ptc-dispatch',
    seq: 3,
    time,
    data: { name: 'bitwarden_get', subCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify({ password: '{{BW_' + kind + '_' + tag + '}}', _masked: true }) }] },
  })
/** The classic (non-PTC) shape: a tool/result carries only a call id, so the
 *  index resolves it against the bitwarden_* call it saw earlier in the log. */
const classicMaskLine = (time, callId, kind, tag) =>
  JSON.stringify({
    type: 'tool/result',
    seq: 3,
    time,
    data: { turn: 1, step: 1, callId, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify({ password: '{{BW_' + kind + '_' + tag + '}}', _masked: true }) }] } },
  })
// The shape the sweeper leaves behind: a marker as the whole value of a
// credential key in a vault event, with varying text nearby for the context
// fingerprint.
const markerLine = (time, callId, context) =>
  JSON.stringify({ type: 'tool/ptc-dispatch', seq: 8, time, data: { name: 'bitwarden_reveal', subCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify({ note: context, password: '[REDACTED:BW_PASSWORD]' }) }] } })
const legacyMaskLine = (time, callId, kind, tag) => maskLine(time, callId, kind, tag)
const plainLine = (time) => JSON.stringify({ type: 'user/message', seq: 9, time, data: { message: { role: 'user', content: [{ type: 'text', text: 'no secrets in this one' }] } } })
/** A tool call carrying a placeholder: the request side of the exchange. The
 *  call must name a bitwarden_* tool — placeholders elsewhere in a call are
 *  the model quoting the pattern, not the vault exchange. */
const callLine = (time, callId, note) =>
  JSON.stringify({ type: 'tool/call', seq: 4, time, data: { turn: 1, step: 1, callId, name: 'bitwarden_get', arguments: JSON.stringify({ note }) } })
/** A reply carrying the same placeholder back out: the "did it come back" side. */
const replyLine = (time, text) => JSON.stringify({ type: 'assistant/message', seq: 5, time, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })

const root = mkdtempSync(join(tmpdir(), 'bw-trail-'))
const indexPath = join(root, 'trail-index.json')
/** One session directory: its log file name is the version it carries. */
const writeLog = async (workspace, session, version, lines, mtimeMs, base = 'sessions') => {
  const dir = join(root, base, workspace, session)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v' + version + '.jsonl.zstd')
  const parts = []
  for (const line of lines) parts.push(await encodeFrame(line + String.fromCharCode(10)))
  writeFileSync(path, Buffer.concat(parts), { mode: 0o640 })
  const stamp = new Date(mtimeMs)
  utimesSync(path, stamp, stamp)
  return path
}

const main = async () => {
  console.log('trail index test')

  // alpha: one session with a title, a model, one request, and two masks — one
  // of which the log repeats verbatim in a later frame (the host re-emits a
  // tool result when a step is retried, and counting that twice would inflate
  // every number on the page).
  const alphaMask = maskLine(NOW - 3600000, 'c1', 'PASSWORD', 'abcdefgh')
  await writeLog('ws', 'session-alpha', 4, [
    titleLine(NOW - 4000000, '会话甲'),
    modelLine(NOW - 3900000, 'curi-gate', 'zcode/GLM-5.3'),
    headerLine(NOW - 3700000),
    contextLine(NOW - 3699900),
    alphaMask,
    maskLine(NOW - 3500000, 'c2', 'TOTP', 'bcdefghi'),
    alphaMask,
  ], NOW - 600000)

  // beta: two masks that carry no model selection at all, and a superseded v3
  // beside the v4 that repeats the same two events.
  const betaLines = [titleLine(NOW - 7300000, '会话乙'), maskLine(NOW - 7200000, 'b1', 'PASSWORD', 'cdefghij'), maskLine(NOW - 7100000, 'b2', 'NOTES', 'defghijk')]
  await writeLog('ws', 'session-beta', 4, betaLines, NOW - 800000)
  await writeLog('ws', 'session-beta', 3, betaLines, NOW - 900000)

  // gamma: ten days back — inside the 30-day window, outside the 7-day one.
  await writeLog('ws', 'session-gamma', 4, [titleLine(NOW - 10 * DAY, '会话丙'), modelLine(NOW - 10 * DAY, 'stepfun', 'step-5-preview'), headerLine(NOW - 10 * DAY + 1000, 'stepfun', 'step-5-preview'), maskLine(NOW - 10 * DAY + 2000, 'g1', 'CARD', 'efghijkl')], NOW - 10 * DAY)

  // delta: the reader picked one model and the request went out on another.
  // The header is what the mask was sent inside, so the header wins — otherwise
  // the ledger names a model that never saw the request.
  await writeLog('ws', 'session-delta', 4, [
    titleLine(NOW - 4 * DAY, '会话丁二'),
    modelLine(NOW - 4 * DAY - 5000, 'curi-gate', 'zcode/GLM-5.3'),
    headerLine(NOW - 4 * DAY, 'stepfun', 'step-5-preview'),
    maskLine(NOW - 4 * DAY + 1000, 'd1', 'HISTORY', 'uvwxyzab'),
  ], NOW - 4 * DAY)

  // stale: outside even the 30-day window. Its mtime is old, so the index must
  // not spend budget on it — and it must not appear in any total.
  await writeLog('ws', 'session-stale', 4, [titleLine(NOW - 40 * DAY, '会话丁'), maskLine(NOW - 40 * DAY, 's1', 'PASSWORD', 'fghijklm')], NOW - 40 * DAY)

  const index = new TrailIndex({ sessionsRoot: join(root, 'sessions'), path: indexPath, now: () => NOW })
  const first = await index.refresh({ budgetMs: 60000 })
  check('the cold scan reads every fresh session', first.scanned === 4, JSON.stringify(first))
  check('the cold scan finishes inside its budget', first.pending === 0, JSON.stringify(first))
  check('a stale session is not counted as pending work', first.total === 4, JSON.stringify(first))

  // v5 carries the fingerprints a row counted. Without them a ledger row
  // is only a session name and a minute, and opening the detail page would
  // have to re-derive which values were behind it from a log that may be gone.
  check('the index version is the one that counts by the positive vault allowlist', INDEX_VERSION === 9, String(INDEX_VERSION))

  const state = index._load()
  check('the index keeps one record per session directory', Object.keys(state.files).length === 4, JSON.stringify(Object.keys(state.files)))
  // alpha contributes two (its repeat of the first mask adds nothing), beta two.
  check('the repeated event line is counted once', aggregateTrail(state, { days: 7, now: NOW }).total === 5, JSON.stringify(aggregateTrail(state, { days: 7, now: NOW }).total))
  check('a superseded log version is not counted beside its replacement', Object.values(state.files).every((record) => !record.log.includes('session.v3')), JSON.stringify(Object.values(state.files).map((record) => record.log)))

  // ── what the page shows ────────────────────────────────────────────────────
  const week = aggregateTrail(state, { days: 7, now: NOW })
  check('the 7-day headline counts alpha, beta and delta', week.total === 5, String(week.total))
  check('distinct values count the masks, not the events', week.distinct === 5, String(week.distinct))
  check('requests count the frames that actually left', week.requests === 2, String(week.requests))
  check('the axis has one point per day, oldest first', week.days.length === 7 && week.days[6].day === dayOf(NOW) && week.days[0].day === dayOf(NOW - 6 * DAY), JSON.stringify(week.days))
  check('today carries today', week.days[6].count === 4, JSON.stringify(week.days[6]))
  check('a middle day with no masks is a real zero', week.days[3].count === 0, JSON.stringify(week.days[3]))
  check('the session rail names the conversation', week.sessions.some((row) => row.name === '会话甲' && row.count === 2), JSON.stringify(week.sessions))
  check('the session rail is ordered by count', week.sessions[0].count >= week.sessions[week.sessions.length - 1].count, JSON.stringify(week.sessions))
  check('the model rail splits provider from model at the first slash', week.models.some((row) => row.provider === 'curi-gate' && row.model === 'zcode/GLM-5.3' && row.count === 2), JSON.stringify(week.models))
  check('masks with no model selection get their own row', week.models.some((row) => row.provider === null && row.model === null && row.count === 2), JSON.stringify(week.models))
  check('the model the request carried outranks the model picked in the UI', week.models.some((row) => row.provider === 'stepfun' && row.model === 'step-5-preview' && row.count === 1), JSON.stringify(week.models))
  check('the rails add up to the headline', week.models.reduce((sum, row) => sum + row.count, 0) === week.total, JSON.stringify(week.models))

  // ── the board's flow ──────────────────────────────────────────────────────
  // The board draws three conversations through a gate to three models. The
  // pair counts have to be the real ones: a ribbon is a claim that THIS
  // conversation sent THIS many masks to THAT model, not a product of two
  // marginal totals. The fixture has one such pair (alpha → zcode, twice), one
  // delta → stepfun pair, and beta's masks with no model at all, which must
  // never become a ribbon.
  check('the flow carries at most three conversations', week.flows.sessions.length <= 3, JSON.stringify(week.flows.sessions))
  check('the flow carries at most three models', week.flows.models.length <= 3, JSON.stringify(week.flows.models))
  check('the flow names the busiest conversation first', week.flows.sessions[0].name === '会话甲' && week.flows.sessions[0].count === 2, JSON.stringify(week.flows.sessions))
  const alphaLink = week.flows.links.find((link) => link.session === 'session-alpha' && link.model === 'zcode/GLM-5.3')
  check('a ribbon carries the real pair count', alphaLink?.count === 2, JSON.stringify(week.flows.links))
  const deltaLink = week.flows.links.find((link) => link.session === 'session-delta' && link.model === 'step-5-preview')
  check('a second pair is its own ribbon', deltaLink?.count === 1, JSON.stringify(week.flows.links))
  check('masks with no model make no ribbon', week.flows.links.every((link) => link.provider !== null && link.model !== null), JSON.stringify(week.flows.links))
  check('the flow accounts for everyone it leaves out', week.flows.otherSessions.count === week.total - week.flows.sessions.reduce((sum, row) => sum + row.count, 0) && week.flows.otherModels.count === week.total - week.flows.models.reduce((sum, row) => sum + row.count, 0), JSON.stringify(week.flows))
  const flowMonth = aggregateTrail(state, { days: 30, now: NOW })
  check('the 30-day board keeps the same three-row rule', flowMonth.flows.sessions.length === 3 && flowMonth.flows.models.length === 3 && flowMonth.flows.links.every((link) => link.count > 0), JSON.stringify(flowMonth.flows))
  check('the board counts the conversations it did not name', flowMonth.flows.otherSessions.items === 1 && flowMonth.flows.sessions.length === 3, JSON.stringify(flowMonth.flows.otherSessions))
  check('the ledger is newest first', week.rows.length > 1 && week.rows[0].time >= week.rows[1].time, JSON.stringify(week.rows.map((row) => row.time)))
  check('the ledger names the conversation and the model', week.rows.every((row) => row.session && typeof row.name === 'string'), JSON.stringify(week.rows))
  // A step writes several placeholders at once and the next step writes more,
  // so one conversation produces a wall of nearly identical lines. Each clump
  // is one row carrying its own size; otherwise forty rows name one session.
  const clumped = aggregateTrail(
    {
      version: 2,
      files: {
        '/sessions/ws/session-clump': {
          title: '会话群',
          days: { [dayOf(NOW)]: { n: 5, r: 1, m: { 'curi-gate/zcode/GLM-5.3': 4, 'stepfun/step-5-preview': 1 } } },
          values: {},
          rows: [
            { t: NOW - 1000, n: 1, m: 'curi-gate/zcode/GLM-5.3' },
            { t: NOW - 2000, n: 1, m: 'curi-gate/zcode/GLM-5.3' },
            { t: NOW - 3000, n: 1, m: 'curi-gate/zcode/GLM-5.3' },
            { t: NOW - 3600000, n: 1, m: 'curi-gate/zcode/GLM-5.3' },
            { t: NOW - 3700000, n: 1, m: 'stepfun/step-5-preview' },
          ],
        },
      },
      meta: {},
    },
    { days: 7, now: NOW },
  )
  check('masks that land together become one ledger row', clumped.rows.length === 3, JSON.stringify(clumped.rows))
  check('the burst carries how many masks it holds', clumped.rows[0].count === 3, JSON.stringify(clumped.rows[0]))
  check('a burst keeps the newest time in the clump', clumped.rows[0].time === NOW - 1000, JSON.stringify(clumped.rows[0]))
  check('a quiet hour splits the same conversation into two rows', clumped.rows[1].time === NOW - 3600000 && clumped.rows[1].count === 1, JSON.stringify(clumped.rows[1]))
  check('a different model is never folded into the burst', clumped.rows[2].model === 'step-5-preview', JSON.stringify(clumped.rows[2]))
  check('folding leaves the headline alone', clumped.rows.reduce((sum, row) => sum + row.count, 0) === clumped.total, JSON.stringify({ rows: clumped.rows, total: clumped.total }))

  const month = aggregateTrail(state, { days: 30, now: NOW })
  check('the 30-day window adds the older session', month.total === 6, String(month.total))
  check('the 30-day window has 30 axis points', month.days.length === 30, String(month.days.length))
  check('the 30-day window counts the older request too', month.requests === 3, String(month.requests))
  check('the 30-day window shows the older model', month.models.some((row) => row.model === 'step-5-preview'), JSON.stringify(month.models))
  // The older session's day is not merely zero in the narrow window — it is not
  // on the axis at all, which is the difference between "none that day" and
  // "not asked about that day".
  check('the older session is off the narrow axis entirely', !week.days.some((point) => point.day === dayOf(NOW - 10 * DAY)), JSON.stringify(week.days.map((point) => point.day)))
  check('only the two published ranges are offered', TRAIL_RANGES.length === 2 && TRAIL_RANGES.includes(7) && TRAIL_RANGES.includes(30), JSON.stringify(TRAIL_RANGES))
  check('an unknown range falls back to the narrow one', aggregateTrail(state, { days: 999, now: NOW }).range === 7, String(aggregateTrail(state, { days: 999, now: NOW }).range))

  // ── no re-decoding on a warm refresh ──────────────────────────────────────
  const warm = await index.refresh({ budgetMs: 60000 })
  check('a warm refresh decodes nothing', warm.scanned === 0, JSON.stringify(warm))
  check('a warm refresh keeps every record', Object.keys(index._load().files).length === 4, String(Object.keys(index._load().files).length))

  // ── appends are picked up, not recounted ──────────────────────────────────
  const alphaPath = join(root, 'sessions', 'ws', 'session-alpha', 'session.v4.jsonl.zstd')
  const appended = await encodeFrame(maskLine(NOW - 600000, 'c3', 'FIELD', 'ghijklmn') + String.fromCharCode(10))
  writeFileSync(alphaPath, Buffer.concat([readFileSync(alphaPath), appended]))
  const stamped = new Date(NOW - 300000)
  utimesSync(alphaPath, stamped, stamped)
  const grown = await index.refresh({ budgetMs: 60000 })
  check('an appended frame is read on the next refresh', grown.scanned === 1, JSON.stringify(grown))
  const afterAppend = aggregateTrail(index._load(), { days: 7, now: NOW })
  check('the appended mask lands in the headline', afterAppend.total === 6, String(afterAppend.total))
  check('the earlier masks are not recounted', afterAppend.distinct === 6, String(afterAppend.distinct))

  // ── a rewrite invalidates the offset ──────────────────────────────────────
  // The sweeper replaces a log wholesale (atomic rename: new inode, sometimes
  // the same size). Resuming from a byte offset into DIFFERENT content would
  // silently attribute one session's masks to another, so the record restarts.
  const betaDir = join(root, 'sessions', 'ws', 'session-beta', '')
  const betaPath = join(betaDir, 'session.v4.jsonl.zstd')
  const replacement = Buffer.concat([await encodeFrame(maskLine(NOW - 700000, 'b9', 'PASSWORD', 'hijklmno') + String.fromCharCode(10))])
  const temp = join(betaDir, 'session.v4.jsonl.zstd.tmp')
  writeFileSync(temp, replacement, { mode: 0o640 })
  renameSync(temp, betaPath)
  const rewritten = await index.refresh({ budgetMs: 60000 })
  check('a rewritten log is re-read from the start', rewritten.scanned === 1, JSON.stringify(rewritten))
  const afterRewrite = aggregateTrail(index._load(), { days: 7, now: NOW })
  check('the rewrite replaces that session instead of adding to it', afterRewrite.total === 5, String(afterRewrite.total))
  check('the stale masks of the rewritten session are gone', afterRewrite.sessions.every((row) => row.name !== '会话乙' || row.count === 1), JSON.stringify(afterRewrite.sessions))


  // ── dedup inside one log ──────────────────────────────────────────────────
  await writeLog('ws', 'session-dedup', 4, [
    titleLine(NOW - 1000, '会话戊'),
    // Same call, same surrounding text, twice: one mask.
    markerLine(NOW - 900, 'd1', 'the key is'),
    markerLine(NOW - 800, 'd1', 'the key is'),
    // Same call, different surrounding text: two different secrets.
    markerLine(NOW - 700, 'd2', 'first value'),
    markerLine(NOW - 700, 'd2', 'second value'),
    // A placeholder-shaped string whose kind lib/mask.js never emits.
    maskLine(NOW - 600, 'd3', 'BOGUS', 'ijklmnop'),
    plainLine(NOW - 500),
  ], NOW - 2000)
  const dedupRefresh = await index.refresh({ budgetMs: 60000 })
  check('a new session is read', dedupRefresh.scanned === 1, JSON.stringify(dedupRefresh))
  const dedup = aggregateTrail(index._load(), { days: 7, now: NOW })
  check('an identical redaction in the same call counts once', dedup.total === week.total + 3, String(dedup.total))
  check('distinct redactions in the same call count apart', dedup.distinct === week.total + 3, String(dedup.distinct))

  // ── a disappearing session is dropped ─────────────────────────────────────
  rmSync(join(root, 'sessions', 'ws', 'session-dedup'), { recursive: true, force: true })
  const pruned = await index.refresh({ budgetMs: 60000 })
  check('a deleted session stops being indexed', !Object.keys(index._load().files).some((key) => key.includes('session-dedup')), JSON.stringify(Object.keys(index._load().files)))
  check('a deleted session leaves the totals', aggregateTrail(index._load(), { days: 7, now: NOW }).total === week.total, String(aggregateTrail(index._load(), { days: 7, now: NOW }).total))

  // ── the gate: markers that are text, not sweeps ───────────────────────────
  // The pattern also appears where no sweep put it — the system prompt's own
  // tool descriptions, prose quoting the marker, a source file read into the
  // log — and counting those made the ledger mostly fiction. None of them may
  // move the totals.
  const proseLine = (time) =>
    JSON.stringify({ type: 'user/message', seq: 8, time, data: { message: { role: 'user', content: [{ type: 'text', text: 'the sweeper writes [REDACTED:BW_PASSWORD] into logs' }] } } })
  const promptLine = (time) =>
    JSON.stringify({ type: 'system/message', seq: 8, time, data: { message: { role: 'system', content: [{ type: 'text', text: 'bitwarden_sweep: Record<string, JsonValue> — password/totp/卡号等 → [REDACTED:BW_PASSWORD]' }] } } })
  const looseLine = (time) =>
    JSON.stringify({ type: 'tool/result', seq: 8, time, data: { callId: 'd4', message: { role: 'tool', toolCallId: 'd4', content: [{ type: 'text', text: 'the sweeper writes [REDACTED:BW_PASSWORD] here' }] } } })
  const unknownLine = (time) =>
    JSON.stringify({ type: 'tool/result', seq: 8, time, data: { callId: 'd5', message: { role: 'tool', toolCallId: 'd5', content: [{ type: 'text', text: JSON.stringify({ password: '[REDACTED:BW_BOGUS]' }) }] } } })
  // Placeholders get the same gate: a report ABOUT masking quoting one as an
  // example — the 10-28 case the user flagged, four ledger spots from one
  // sentence — rides a bash dispatch that names no bitwarden tool, and an
  // assistant echo of the handle is not a second mask.
  const bashDispatchLine = (time) =>
    JSON.stringify({ type: 'tool/ptc-dispatch', seq: 8, time, data: { name: 'bash', content: [{ type: 'text', text: 'a report quoting {"password": "{{BW_PASSWORD_vfvyvkan}}"} as an example' }] } })
  // The 10-30 leak, exactly: a bash dispatch whose ARGUMENTS are a probe
  // script containing both the literal "name":"bitwarden_get" and a
  // placeholder. A string-matching gate saw the tool name and counted it; the
  // structural one reads data.name === 'bash' and counts nothing.
  const probeScriptLine = (time) =>
    JSON.stringify({ type: 'tool/ptc-dispatch', seq: 8, time, data: { name: 'bash', content: [{ type: 'text', text: 'const bwDispatch = JSON.stringify({ type: "tool/ptc-dispatch", data: { name: "bitwarden_get", content: [{ type: "text", text: JSON.stringify({ password: "{{BW_PASSWORD_zzzzzzzz}}" }) }] } })' }] } })
  const echoLine = (time) =>
    JSON.stringify({ type: 'assistant/message', seq: 8, time, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'the reply echoed {{BW_PASSWORD_vfvyvkan}} back' }] } } })
  await writeLog('ws', 'session-gate', 4, [
    titleLine(NOW - 400, '会话闸'),
    proseLine(NOW - 390),
    promptLine(NOW - 380),
    looseLine(NOW - 370),
    unknownLine(NOW - 360),
    bashDispatchLine(NOW - 355),
    probeScriptLine(NOW - 350),
    echoLine(NOW - 345),
  ], NOW - 350)
  await index.refresh({ budgetMs: 60000 })
  const gateAgg = aggregateTrail(index._load(), { days: 7, now: NOW })
  check('markers and placeholders that are text (prose, prompt, unkeyed, unknown kind, quoted examples, echo) count nothing', gateAgg.total === week.total, String(gateAgg.total) + ' vs ' + week.total)
  // ...then the gate session leaves again, so the persistence counts below hold
  rmSync(join(root, 'sessions', 'ws', 'session-gate'), { recursive: true, force: true })
  await index.refresh({ budgetMs: 60000 })

  // ── persistence ───────────────────────────────────────────────────────────
  const saved = JSON.parse(readFileSync(indexPath, 'utf8'))
  check('the index is persisted with a version gate', saved.version === INDEX_VERSION, String(saved.version))
  check('the index is written private', (statSync(indexPath).mode & 0o777) === 0o600, (statSync(indexPath).mode & 0o777).toString(8))
  check('the index stores one record per session directory', Object.keys(saved.files).length === 4, JSON.stringify(Object.keys(saved.files)))
  check('the index remembers the sweep cursor', Object.values(saved.files).every((record) => typeof record.offset === 'number' && record.offset > 0), JSON.stringify(Object.values(saved.files).map((record) => record.offset)))

  // ── a budget that runs out mid-scan says so ───────────────────────────────
  // The clock advances on every read, so the second log is already past the
  // deadline: what matters is that the index reports the rest as pending
  // instead of presenting a partial total as final.
  const slowRoot = join(root, 'sessions')
  let ticks = 0
  const ticking = () => NOW + ticks++ * 10
  const slow = new TrailIndex({ sessionsRoot: slowRoot, path: join(root, 'slow-index.json'), now: ticking })
  const partial = await slow.refresh({ budgetMs: 1 })
  check('a spent budget leaves work pending', partial.pending > 0, JSON.stringify(partial))
  check('the partial scan still reports the window size', partial.total === 4, JSON.stringify(partial))
  const partialReport = aggregateTrail(slow._load(), { days: 7, now: NOW })
  check('a partial index is marked in the report', partialReport.index.pending > 0, JSON.stringify(partialReport.index))
  check('a partial index still shows the numbers it has', partialReport.total >= 0, String(partialReport.total))
  // The next refresh must resume from the offset that stopped mid-file, not
  // mistake the recorded file size for "already scanned".
  const resumed = await slow.refresh({ budgetMs: 60000 })
  check('a budget-stopped scan resumes to EOF', resumed.pending === 0, JSON.stringify(resumed))
  check(
    'the resumed scan has every mask the full scan had',
    aggregateTrail(slow._load(), { days: 7, now: NOW }).total === week.total,
    String(aggregateTrail(slow._load(), { days: 7, now: NOW }).total),
  )

  // ── the RPC ────────────────────────────────────────────────────────────────
  resetTrailIndex()
  const report = await trailReport({ sessionsRoot: slowRoot, path: join(root, 'rpc-index.json'), now: () => NOW, days: 30, budgetMs: 60000 })
  check('the RPC answers with the page shape', typeof report.total === 'number' && Array.isArray(report.days) && Array.isArray(report.sessions) && Array.isArray(report.models) && Array.isArray(report.rows), JSON.stringify(Object.keys(report)))
  check('the RPC honours the requested window', report.range === 30 && report.days.length === 30, JSON.stringify(report.range))
  check('the RPC counts the whole window', report.total === 6, String(report.total))

  const emptyRoot = join(root, 'no-sessions')
  const empty = await trailReport({ sessionsRoot: emptyRoot, path: join(root, 'empty-index.json'), now: () => NOW, days: 7, budgetMs: 60000 })
  check('a machine with no logs has an empty trail, not an error', empty.total === 0 && empty.rows.length === 0 && empty.days.length === 7, JSON.stringify(empty.total))
  check('an empty trail still describes its window', empty.index.pending === 0 && empty.index.total === 0, JSON.stringify(empty.index))

  // ── caps ──────────────────────────────────────────────────────────────────
  const flood = []
  for (let index = 0; index < 60; index += 1) flood.push(maskLine(NOW - 1000 - index, 'f' + index, 'PASSWORD', 'klmnopqr'))
  await writeLog('ws', 'session-flood', 4, [titleLine(NOW - 100, '会话己'), ...flood], NOW - 500)
  resetTrailIndex()
  const floodReport = await trailReport({ sessionsRoot: slowRoot, path: join(root, 'flood-index.json'), now: () => NOW, days: 7, budgetMs: 90000 })
  check('the ledger is capped', floodReport.rows.length <= 40, String(floodReport.rows.length))
  check('the ledger cap does not cap the headline', floodReport.total >= 60, String(floodReport.total))
  check('a rail is capped', floodReport.models.length <= 6, String(floodReport.models.length))

  // ── pages ─────────────────────────────────────────────────────────────────
  // Forty rows is more than one screen, so the ledger is paged — and the rows
  // after the first page are the whole point. Each burst here is its own
  // conversation, an hour apart, so nothing folds: 60 bursts, 40 to a page.
  const paged = { version: 2, files: {}, meta: {} }
  const burstRows = []
  for (let index = 0; index < 60; index += 1) {
    burstRows.push({ t: NOW - 1000 - index * 3600000, n: 1, m: 'curi-gate/zcode/GLM-5.3' })
  }
  // Newest first once sorted, so give each its own conversation by writing
  // sixty session records — one row each, so no folding can merge them.
  for (let index = 0; index < 60; index += 1) {
    paged.files['/sessions/ws/session-p' + index] = {
      title: '会话' + index,
      days: { [dayOf(NOW)]: { n: 1, r: 1, m: { 'curi-gate/zcode/GLM-5.3': 1 } } },
      values: {},
      rows: [burstRows[index]],
    }
  }
  const pageOne = aggregateTrail(paged, { days: 7, now: NOW })
  check('the ledger says how many pages it has', pageOne.ledger.pages === 2, JSON.stringify(pageOne.ledger))
  check('the first page is page one', pageOne.ledger.page === 1, JSON.stringify(pageOne.ledger))
  check('a full page is as long as a page', pageOne.rows.length === 40, String(pageOne.rows.length))
  check('the ledger knows its whole length, not the page length', pageOne.ledger.total === 60, String(pageOne.ledger.total))
  const pageTwo = aggregateTrail(paged, { days: 7, now: NOW, page: 2 })
  check('the second page holds the rest', pageTwo.rows.length === 20, String(pageTwo.rows.length))
  check('the second page is not the first one', JSON.stringify(pageTwo.rows.map((row) => row.name)) !== JSON.stringify(pageOne.rows.map((row) => row.name)), JSON.stringify(pageTwo.rows.map((row) => row.name).slice(0, 3)))
  check('paging does not change the headline', pageTwo.total === pageOne.total && pageTwo.ledger.total === pageOne.ledger.total, JSON.stringify([pageOne.total, pageTwo.total]))
  check('the pages do not overlap and do not leave a gap', new Set([...pageOne.rows, ...pageTwo.rows].map((row) => row.time)).size === 60, String(new Set([...pageOne.rows, ...pageTwo.rows].map((row) => row.time)).size))
  // The page is clamped on the host because the client cannot know the page
  // count: the window shrinks under a reader as old sessions slide out.
  const past = aggregateTrail(paged, { days: 7, now: NOW, page: 99 })
  check('a page past the end lands on the last one', past.ledger.page === 2 && past.rows.length === 20, JSON.stringify(past.ledger))
  const before = aggregateTrail(paged, { days: 7, now: NOW, page: 0 })
  check('a page before the start lands on the first one', before.ledger.page === 1, JSON.stringify(before.ledger))
  const nonsense = aggregateTrail(paged, { days: 7, now: NOW, page: 'yesterday' })
  check('a page that is not a number is the first one', nonsense.ledger.page === 1, JSON.stringify(nonsense.ledger))
  // ── the ledger window is the axis window ──────────────────────────────────
  // "Seven days" is seven DAYS as the axis draws them — midnight to midnight —
  // not "now minus 168 hours". Filtering the rows by a rolling instant instead
  // put masks from the morning of the oldest day in the ledger while their day
  // bucket was already out of the axis, so the pages summed to more than the
  // headline they sat under.
  const axisStart = Date.parse(dayOf(NOW - 6 * DAY) + 'T00:00:00')
  const edge = aggregateTrail(
    {
      version: 2,
      files: {
        '/sessions/ws/session-edge': {
          title: '会话边',
          days: { [dayOf(NOW - 6 * DAY)]: { n: 1, r: 0, m: {} } },
          values: {},
          rows: [
            { t: axisStart + 3600000, n: 1, m: null },
            { t: axisStart - 3600000, n: 1, m: null },
          ],
        },
      },
      meta: {},
    },
    { days: 7, now: NOW },
  )
  check('a mask on the morning of the oldest day is in the ledger', edge.rows.length === 1 && edge.rows[0].time === axisStart + 3600000, JSON.stringify(edge.rows))
  check('a mask just before the axis is in neither the ledger nor the headline', edge.total === 1 && edge.rows.reduce((sum, row) => sum + row.count, 0) === edge.total, JSON.stringify({ rows: edge.rows, total: edge.total }))

  const quiet = aggregateTrail({ version: 2, files: {}, meta: {} }, { days: 7, now: NOW })
  check('an empty ledger still has one page', quiet.ledger.pages === 1 && quiet.ledger.page === 1 && quiet.ledger.total === 0, JSON.stringify(quiet.ledger))

  // ── rows are folded by the minute ─────────────────────────────────────────
  // The per-log row cap was silently a data cap: the four busiest logs on the
  // dev corpus each overflowed it, and 822 of 2545 masks had no row at all, so
  // paging to the end of the ledger still showed less than the headline. One
  // row per minute per model puts every log measured well under the cap — the
  // count on the row carries the volume now. This section owns its corpus so
  // the counts asserted above stay put.
  const foldRoot = join(root, 'fold-sessions')
  const bunch = []
  for (let index = 0; index < 30; index += 1) bunch.push(maskLine(NOW - 40000 + index * 1000, 'm' + index, 'PASSWORD', 'lmnopqrs'))
  await writeLog('ws', 'session-bunch', 4, [titleLine(NOW - 90000, '会话庚'), modelLine(NOW - 85000, 'curi-gate', 'zcode/GLM-5.3'), ...bunch], NOW - 30000, 'fold-sessions')
  const foldIndex = new TrailIndex({ sessionsRoot: foldRoot, path: join(root, 'fold-index.json'), now: () => NOW })
  await foldIndex.refresh({ budgetMs: 60000 })
  const bunchRecord = () => Object.values(foldIndex._load().files)[0]
  // Thirty masks inside thirty seconds were thirty rows at the old grain and
  // are ONE minute row now.
  check('masks inside one minute share one row', bunchRecord().rows.length === 1, JSON.stringify(bunchRecord().rows))
  check('the shared row keeps the count, so nothing is lost', bunchRecord().rows[0].n === 30, JSON.stringify(bunchRecord().rows[0]))
  check('the shared row keeps the newest instant in its minute', bunchRecord().rows[0].t === NOW - 40000 + 29 * 1000, JSON.stringify(bunchRecord().rows[0]))

  // A mask in another minute is another row: the grain is the minute, not the
  // log. Here the new log version replaces the old one wholesale.
  await writeLog('ws', 'session-bunch', 5, [titleLine(NOW - 90000, '会话庚'), modelLine(NOW - 85000, 'curi-gate', 'zcode/GLM-5.3'), maskLine(NOW - 120000, 'm90', 'PASSWORD', 'mnopqrst'), ...bunch], NOW - 30000, 'fold-sessions')
  await foldIndex.refresh({ budgetMs: 60000 })
  check('a mask in another minute is its own row', bunchRecord().rows.length === 2, JSON.stringify(bunchRecord().rows.map((row) => row.t)))
  check('the earlier minute row carries its own count', bunchRecord().rows[0].n === 1 && bunchRecord().rows[1].n === 30, JSON.stringify(bunchRecord().rows))

  // The model is part of the grain: the ledger names the model, so two models
  // in the same minute cannot share a row.
  await writeLog(
    'ws',
    'session-bunch',
    6,
    [titleLine(NOW - 90000, '会话庚'), modelLine(NOW - 85000, 'curi-gate', 'zcode/GLM-5.3'), ...bunch, modelLine(NOW - 14000, 'stepfun', 'step-5-preview'), maskLine(NOW - 13000, 'm91', 'TOTP', 'nopqrstu')],
    NOW - 30000,
    'fold-sessions',
  )
  await foldIndex.refresh({ budgetMs: 60000 })
  const foldState = foldIndex._load()
  check('two models in one minute keep two rows', bunchRecord().rows.length === 2, JSON.stringify(bunchRecord().rows.map((row) => row.m)))
  check('the second model line carries only its own masks', bunchRecord().rows.filter((row) => row.m === 'stepfun/step-5-preview')[0]?.n === 1, JSON.stringify(bunchRecord().rows))
  // Opening one model's row must not include the other model's value from the
  // same minute: `trailRow` already carries the burst's fingerprints.
  const foldAgg = aggregateTrail(foldState, { days: 7, now: NOW })
  const curiDetailRow = foldAgg.rows.find((row) => row.session === 'session-bunch' && row.provider === 'curi-gate' && row.model === 'zcode/GLM-5.3')
  const twoModelDetail = await trailRowDetail({
    sessionsRoot: foldRoot,
    path: join(root, 'fold-index.json'),
    now: () => NOW,
    days: 7,
    session: curiDetailRow.session,
    time: curiDetailRow.time,
  })
  check(
    'a two-model minute opens only the clicked model\'s values',
    twoModelDetail.ok === true && twoModelDetail.values.length === 1 && twoModelDetail.values[0].kind === 'PASSWORD',
    JSON.stringify(twoModelDetail.values.map((value) => value.fingerprint)),
  )

  // And a folded log still reconciles with itself: the rows of the window add
  // up to that window's headline, which is the property the ledger is read for.
  const folded = aggregateTrail(foldState, { days: 7, now: NOW })
  check('the folded rows still add up to the headline', folded.rows.reduce((sum, row) => sum + row.count, 0) === folded.total, JSON.stringify({ rows: folded.rows, total: folded.total }))
  check('the folded headline counts every mask', folded.total === 31, String(folded.total))

  // ── a row remembers what it counted ─────────────────────────────────────
  // The ledger row is the only handle a reader has on a burst: a session name
  // and a minute. Opening the detail page needs to know WHICH values were in
  // it, so each row keeps their fingerprints — thirty copies of one tag are one
  // entry with a count, not thirty entries.
  const [curiRow, stepRow] = bunchRecord().rows.filter((row) => row.m === 'curi-gate/zcode/GLM-5.3' || row.m === 'stepfun/step-5-preview')
  check('a row keeps the fingerprints it counted', curiRow?.v?.['PASSWORD:lmnopqrs'] === 30, JSON.stringify(curiRow))
  check('the row\'s fingerprint counts agree with its size', Object.values(curiRow.v).reduce((sum, n) => sum + n, 0) === curiRow.n, JSON.stringify(curiRow))
  check('the other model row keeps its own fingerprint', stepRow?.v?.['TOTP:nopqrstu'] === 1, JSON.stringify(stepRow))
  check('a row with nothing counted keeps no fingerprint map', Object.values(foldState.files).every((record) => (record.rows ?? []).every((row) => row.n === 0 || Object.keys(row.v ?? {}).length > 0)), JSON.stringify(Object.values(foldState.files).flatMap((record) => record.rows)))

  // ── the detail page ─────────────────────────────────────────────────────
  // One burst, taken apart. The page can say which value sat where, what text
  // surrounded it, and whether it came back out in the reply — and it can say
  // nothing at all about the value itself, because the tag is an HMAC and the
  // marker's context is a hash. What is asserted here is the honest limit, not
  // a recovery.
  const detailRoot = join(root, 'detail-sessions')
  const detailIndexPath = join(root, 'detail-index.json')
  await writeLog(
    'ws',
    'session-detail',
    4,
    [
      titleLine(NOW - 90000, '会话详'),
      modelLine(NOW - 89000, 'curi-gate', 'zcode/GLM-5.3'),
      headerLine(NOW - 88000),
      callLine(NOW - 60000, 'k1', 'the apiKey is {{BW_PASSWORD_aaaaaaaa}} and it is long'),
      classicMaskLine(NOW - 55000, 'k1', 'PASSWORD', 'aaaaaaaa'),
      replyLine(NOW - 50000, 'the key came back as {{BW_PASSWORD_aaaaaaaa}} in the reply'),
    ],
    NOW - 10000,
    'detail-sessions',
  )
  // A marker-only session: the sweeper left it, and it names no field.
  await writeLog('ws', 'session-marker', 4, [titleLine(NOW - 95000, '会话擦'), markerLine(NOW - 45000, 'r1', 'the key is')], NOW - 11000, 'detail-sessions')
  const detailIndex = new TrailIndex({ sessionsRoot: detailRoot, path: detailIndexPath, now: () => NOW })
  await detailIndex.refresh({ budgetMs: 60000 })
  const detailAgg = aggregateTrail(detailIndex._load(), { days: 7, now: NOW })
  const detailRow = detailAgg.rows.find((row) => row.session === 'session-detail')
  check('the detail corpus has a row to open', Boolean(detailRow), JSON.stringify(detailAgg.rows.map((row) => row.session)))
  // The call and its result are one exchange: the dedup folds them into a
  // single spot, and the reply no longer adds a count of its own.
  check('the vault exchange counts once — call and deduped result', detailRow.count === 1, JSON.stringify(detailRow))

  resetTrailIndex()
  const detail = await trailRowDetail({
    sessionsRoot: detailRoot,
    path: detailIndexPath,
    now: () => NOW,
    days: 7,
    session: detailRow.session,
    time: detailRow.time,
  })
  check('the detail page opens the row the ledger showed', detail.ok === true && detail.session === 'session-detail' && detail.time === detailRow.time, JSON.stringify({ ok: detail.ok, time: detail.time, row: detailRow.time }))
  check('the detail page repeats the row\'s own numbers', detail.count === detailRow.count && detail.name === detailRow.name && detail.model === detailRow.model, JSON.stringify(detail))
  check('the detail page lists the minutes the burst swallowed', detail.minutes.length === 1 && detail.minutes[0].count === 1, JSON.stringify(detail.minutes))
  check('one value, however often it was counted', detail.values.length === 1, JSON.stringify(detail.values.map((value) => value.fingerprint)))
  const one = detail.values[0]
  check('the placeholder names its kind', one.kind === 'PASSWORD', one.kind)
  check('the value is found in every part of the exchange', one.places.join(',') === 'toolCall,toolResult,reply', JSON.stringify(one.places))
  check('the page says whether it came back out', one.reply === true, String(one.reply))
  check('every occurrence is a spot with text around it', one.spots.length === 3 && one.spots.every((spot) => typeof spot.text === 'string' && spot.text.length > 0), JSON.stringify(one.spots.length))
  // The log is JSON, so the raw slice is double-escaped. The display form is the
  // string value the mask actually sat in, opened up as code: braces on their
  // own lines, two-space indent, and the same needle at an offset into it.
  const resultSpot = one.spots.find((spot) => spot.type === 'tool/result')
  check(
    'the display text opens the logged JSON up, with the mask at its own offset',
    typeof resultSpot.displayText === 'string' &&
      resultSpot.displayText.startsWith('{') &&
      resultSpot.displayText.includes('"password": "{{BW_PASSWORD_aaaaaaaa}}"') &&
      resultSpot.displayText.slice(resultSpot.displayNeedleAt, resultSpot.displayNeedleAt + resultSpot.needle.length) === resultSpot.needle,
    JSON.stringify(resultSpot.displayText),
  )
  // The ink is a slice of the log line, not a tokenisation: the part a reader
  // wants is the key the value sat under, which a tokeniser would drop.
  const replySpot = one.spots.find((spot) => spot.type === 'assistant/message')
  check('the ink slice puts the needle back where it came from', replySpot.text.slice(replySpot.needleAt, replySpot.needleAt + replySpot.needle.length) === replySpot.needle, JSON.stringify(replySpot))
  check('the ink keeps the words beside the value', replySpot.text.includes('the key came back as') && replySpot.text.includes('in the reply'), replySpot.text)
  check('the ink window is bounded on both sides', replySpot.text.length <= 240 + replySpot.needle.length, String(replySpot.text.length))
  check('the window is the minute the row names', detail.log.windowFrom === detailRow.time - (detailRow.time % 60000) && detail.log.windowTo === detail.log.windowFrom + 60000, JSON.stringify(detail.log))
  check('a log that is there is not reported missing', detail.log.missing === false && detail.log.truncated === false, JSON.stringify(detail.log))

  const markerAgg = aggregateTrail(detailIndex._load(), { days: 7, now: NOW })
  const markerRow = markerAgg.rows.find((row) => row.session === 'session-marker')
  const marker = await trailRowDetail({ sessionsRoot: detailRoot, path: detailIndexPath, now: () => NOW, days: 7, session: markerRow.session, time: markerRow.time })
  check('the marker row opens too', marker.ok === true, JSON.stringify(marker))
  check('a marker names no kind, and the page says so rather than guessing', marker.values.every((value) => value.kind === null), JSON.stringify(marker.values.map((value) => value.kind)))
  check('a marker still shows the text it was found in', marker.values[0]?.spots?.[0]?.text?.includes('the key is') === true, JSON.stringify(marker.values[0]?.spots?.[0]?.text))

  // ── two values hidden in one sentence ───────────────────────────────────
  // One log line can hide a password and a token at once. The page shows the
  // line, not the values: two windows sliced around two masks in the same
  // sentence covered almost the same characters three times over, and the page
  // drew the same paragraph again for each. Both occurrences therefore carry the
  // same slice, each with its own offset into it, and the slice spans the two
  // masks rather than one of them twice.
  const pairText = 'the apiKey is {{BW_PASSWORD_bbbbbbbb}} and the token is {{BW_TOTP_cccccccc}} for this request'
  await writeLog(
    'ws',
    'session-pair',
    4,
    [titleLine(NOW - 80000, '会话双'), headerLine(NOW - 78000), callLine(NOW - 30000, 'p1', pairText)],
    NOW - 9000,
    'detail-sessions',
  )
  const pairIndex = new TrailIndex({ sessionsRoot: detailRoot, path: detailIndexPath, now: () => NOW })
  await pairIndex.refresh({ budgetMs: 60000 })
  const pairAgg = aggregateTrail(pairIndex._load(), { days: 7, now: NOW })
  const pairRow = pairAgg.rows.find((row) => row.session === 'session-pair')
  check('a line that hid two values counts both', pairRow.count === 2, JSON.stringify(pairRow))
  const pair = await trailRowDetail({ sessionsRoot: detailRoot, path: detailIndexPath, now: () => NOW, days: 7, session: pairRow.session, time: pairRow.time })
  check('both values are listed', pair.values.length === 2, JSON.stringify(pair.values.map((value) => value.fingerprint)))
  const pairSpots = pair.values.map((value) => value.spots[0])
  check('each value points at the same sentence', pairSpots.every((spot) => spot.text === pairSpots[0].text), JSON.stringify(pairSpots.map((spot) => spot.text.length)))
  check('the shared slice carries both values', pairSpots[0].text.includes('{{BW_PASSWORD_bbbbbbbb}}') && pairSpots[0].text.includes('{{BW_TOTP_cccccccc}}'), pairSpots[0].text)
  check('and it is one sentence, not one per value', pairSpots[0].text.length <= 240 + '{{BW_PASSWORD_bbbbbbbb}}{{BW_TOTP_cccccccc}}'.length, String(pairSpots[0].text.length))
  check('the two marks sit at different offsets', pairSpots[0].needleAt !== pairSpots[1].needleAt, JSON.stringify(pairSpots.map((spot) => spot.needleAt)))
  check('each mark still reads back at its own offset', pairSpots.every((spot) => spot.text.slice(spot.needleAt, spot.needleAt + spot.needle.length) === spot.needle), JSON.stringify(pairSpots.map((spot) => spot.needle)))

  // ── two values at opposite ends of one line ─────────────────────────────
  // The other shape the same rule meets: a tool call whose arguments quote a
  // whole file, with one mask near the start and one near the end. Sharing a
  // window there is not a sentence shown once, it is two hundred lines of
  // argument blob drawn to show two placeholders — so masks further apart than
  // their windows are read as two sightings and the page draws two slices.
  const farText = 'first {{BW_PASSWORD_dddddddd}}' + ' filler'.repeat(60) + ' last {{BW_TOTP_eeeeeeee}}'
  await writeLog(
    'ws',
    'session-far',
    4,
    [titleLine(NOW - 80000, '会话远'), headerLine(NOW - 78000), callLine(NOW - 20000, 'f1', farText)],
    NOW - 9000,
    'detail-sessions',
  )
  const farIndex = new TrailIndex({ sessionsRoot: detailRoot, path: detailIndexPath, now: () => NOW })
  await farIndex.refresh({ budgetMs: 60000 })
  const farRow = aggregateTrail(farIndex._load(), { days: 7, now: NOW }).rows.find((row) => row.session === 'session-far')
  const far = await trailRowDetail({ sessionsRoot: detailRoot, path: detailIndexPath, now: () => NOW, days: 7, session: farRow.session, time: farRow.time })
  const farSpots = far.values.map((value) => value.spots[0])
  check('a line with two far-apart values still counts both', farRow.count === 2 && farSpots.length === 2, JSON.stringify({ count: farRow.count, spots: farSpots.length }))
  check('the two sightings do not share a slice', farSpots[0].text !== farSpots[1].text, JSON.stringify(farSpots.map((spot) => spot.text.length)))
  check('neither slice drags the whole line in', farSpots.every((spot) => spot.text.length <= 240 + spot.needle.length), JSON.stringify(farSpots.map((spot) => spot.text.length)))
  check('each far-apart mark reads back at its own offset', farSpots.every((spot) => spot.text.slice(spot.needleAt, spot.needleAt + spot.needle.length) === spot.needle), JSON.stringify(farSpots.map((spot) => spot.needleAt)))

  // ── a log that is no longer there ───────────────────────────────────────
  // The index survives on a stale sibling: the newer log is gone, the older one
  // is out of the scan window, so the record is neither re-read nor pruned and
  // still holds the burst. The page then has the numbers and no text, and it
  // must say so instead of throwing or inventing.
  const detailDir = join(detailRoot, 'ws', 'session-detail')
  rmSync(join(detailDir, 'session.v4.jsonl.zstd'), { force: true })
  await writeLog('ws', 'session-detail', 3, [titleLine(NOW - 40 * DAY, '会话详')], NOW - 40 * DAY, 'detail-sessions')
  const goneLog = await trailRowDetail({ sessionsRoot: detailRoot, path: detailIndexPath, now: () => NOW, days: 7, session: detailRow.session, time: detailRow.time })
  check('a deleted log degrades to the fingerprints, not an error', goneLog.ok === true && goneLog.log.missing === true, JSON.stringify(goneLog.log))
  check('the numbers survive their log', goneLog.count === detailRow.count && goneLog.minutes.length === 1, JSON.stringify({ count: goneLog.count, minutes: goneLog.minutes }))
  check(
    'with no log the fingerprints and their counts still come back',
    goneLog.values.length === 1 && goneLog.values[0].count === 1 && goneLog.values[0].spots.length === 0,
    JSON.stringify(goneLog.values),
  )
  const notFound = await trailRowDetail({ sessionsRoot: detailRoot, path: detailIndexPath, now: () => NOW, days: 7, session: detailRow.session, time: NOW - 12345 })
  check('a row that was never folded answers not-found', notFound.ok === false && notFound.reason === 'not-found', JSON.stringify(notFound))
  const noSuch = await trailRowDetail({ sessionsRoot: detailRoot, path: detailIndexPath, now: () => NOW, days: 7, session: 'session-nobody', time: detailRow.time })
  check('a session that never existed answers not-found too', noSuch.ok === false && noSuch.reason === 'not-found', JSON.stringify(noSuch))
  const emptyDetail = await trailRowDetail({ sessionsRoot: join(root, 'no-sessions'), path: join(root, 'empty-detail-index.json'), now: () => NOW, days: 7, session: 'session-detail', time: detailRow.time })
  check('a machine with no logs has no row to open either', emptyDetail.ok === false && emptyDetail.reason === 'not-found', JSON.stringify(emptyDetail))
}

try {
  await main()
} finally {
  rmSync(root, { recursive: true, force: true })
  resetTrailIndex()
}
console.log('')
if (failed > 0) {
  console.error('trail: ' + failed + ' failed, ' + passed + ' passed')
  process.exit(1)
}
console.log('trail: ' + passed + ' passed, 0 failed')
