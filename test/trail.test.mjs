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
import { INDEX_VERSION, TrailIndex, aggregateTrail, trailReport, resetTrailIndex, TRAIL_RANGES } from '../lib/trail.js'

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
const headerLine = (time) => JSON.stringify({ type: 'request/header', seq: 7, time, data: { header: { config: { provider: 'curi-gate', model: 'zcode/GLM-5.3' } } } })
const maskLine = (time, callId, kind, tag) =>
  JSON.stringify({
    type: 'tool/result',
    seq: 3,
    time,
    data: { turn: 1, step: 1, callId, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify({ password: '{{BW_' + kind + '_' + tag + '}}' }) }] } },
  })
const markerLine = (time, callId, context) =>
  JSON.stringify({ type: 'user/message', seq: 8, time, data: { callId, message: { role: 'user', content: [{ type: 'text', text: context + ' [REDACTED:BW_PASSWORD]' }] } } })
const plainLine = (time) => JSON.stringify({ type: 'user/message', seq: 9, time, data: { message: { role: 'user', content: [{ type: 'text', text: 'no secrets in this one' }] } } })

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
  await writeLog('ws', 'session-gamma', 4, [titleLine(NOW - 10 * DAY, '会话丙'), modelLine(NOW - 10 * DAY, 'stepfun', 'step-5-preview'), headerLine(NOW - 10 * DAY + 1000), maskLine(NOW - 10 * DAY + 2000, 'g1', 'CARD', 'efghijkl')], NOW - 10 * DAY)

  // stale: outside even the 30-day window. Its mtime is old, so the index must
  // not spend budget on it — and it must not appear in any total.
  await writeLog('ws', 'session-stale', 4, [titleLine(NOW - 40 * DAY, '会话丁'), maskLine(NOW - 40 * DAY, 's1', 'PASSWORD', 'fghijklm')], NOW - 40 * DAY)

  const index = new TrailIndex({ sessionsRoot: join(root, 'sessions'), path: indexPath, now: () => NOW })
  const first = await index.refresh({ budgetMs: 60000 })
  check('the cold scan reads every fresh session', first.scanned === 3, JSON.stringify(first))
  check('the cold scan finishes inside its budget', first.pending === 0, JSON.stringify(first))
  check('a stale session is not counted as pending work', first.total === 3, JSON.stringify(first))

  const state = index._load()
  check('the index keeps one record per session directory', Object.keys(state.files).length === 3, JSON.stringify(Object.keys(state.files)))
  // alpha contributes two (its repeat of the first mask adds nothing), beta two.
  check('the repeated event line is counted once', aggregateTrail(state, { days: 7, now: NOW }).total === 4, JSON.stringify(aggregateTrail(state, { days: 7, now: NOW }).total))
  check('a superseded log version is not counted beside its replacement', Object.values(state.files).every((record) => !record.log.includes('session.v3')), JSON.stringify(Object.values(state.files).map((record) => record.log)))

  // ── what the page shows ────────────────────────────────────────────────────
  const week = aggregateTrail(state, { days: 7, now: NOW })
  check('the 7-day headline counts alpha and beta only', week.total === 4, String(week.total))
  check('distinct values count the masks, not the events', week.distinct === 4, String(week.distinct))
  check('requests count the frames that actually left', week.requests === 1, String(week.requests))
  check('the axis has one point per day, oldest first', week.days.length === 7 && week.days[6].day === dayOf(NOW) && week.days[0].day === dayOf(NOW - 6 * DAY), JSON.stringify(week.days))
  check('today carries today', week.days[6].count === 4, JSON.stringify(week.days[6]))
  check('a middle day with no masks is a real zero', week.days[3].count === 0, JSON.stringify(week.days[3]))
  check('the session rail names the conversation', week.sessions.some((row) => row.name === '会话甲' && row.count === 2), JSON.stringify(week.sessions))
  check('the session rail is ordered by count', week.sessions[0].count >= week.sessions[week.sessions.length - 1].count, JSON.stringify(week.sessions))
  check('the model rail splits provider from model at the first slash', week.models.some((row) => row.provider === 'curi-gate' && row.model === 'zcode/GLM-5.3' && row.count === 2), JSON.stringify(week.models))
  check('masks with no model selection get their own row', week.models.some((row) => row.provider === null && row.model === null && row.count === 2), JSON.stringify(week.models))
  check('the rails add up to the headline', week.models.reduce((sum, row) => sum + row.count, 0) === week.total, JSON.stringify(week.models))
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
  check('the 30-day window adds the older session', month.total === 5, String(month.total))
  check('the 30-day window has 30 axis points', month.days.length === 30, String(month.days.length))
  check('the 30-day window counts the older request too', month.requests === 2, String(month.requests))
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
  check('a warm refresh keeps every record', Object.keys(index._load().files).length === 3, String(Object.keys(index._load().files).length))

  // ── appends are picked up, not recounted ──────────────────────────────────
  const alphaPath = join(root, 'sessions', 'ws', 'session-alpha', 'session.v4.jsonl.zstd')
  const appended = await encodeFrame(maskLine(NOW - 600000, 'c3', 'FIELD', 'ghijklmn') + String.fromCharCode(10))
  writeFileSync(alphaPath, Buffer.concat([readFileSync(alphaPath), appended]))
  const stamped = new Date(NOW - 300000)
  utimesSync(alphaPath, stamped, stamped)
  const grown = await index.refresh({ budgetMs: 60000 })
  check('an appended frame is read on the next refresh', grown.scanned === 1, JSON.stringify(grown))
  const afterAppend = aggregateTrail(index._load(), { days: 7, now: NOW })
  check('the appended mask lands in the headline', afterAppend.total === 5, String(afterAppend.total))
  check('the earlier masks are not recounted', afterAppend.distinct === 5, String(afterAppend.distinct))

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
  check('the rewrite replaces that session instead of adding to it', afterRewrite.total === 4, String(afterRewrite.total))
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
  check('an identical redaction in the same call counts once', dedup.total === 4 - 1 + 4, String(dedup.total))
  check('distinct redactions in the same call count apart', dedup.distinct === 4 - 1 + 4, String(dedup.distinct))

  // ── a disappearing session is dropped ─────────────────────────────────────
  rmSync(join(root, 'sessions', 'ws', 'session-dedup'), { recursive: true, force: true })
  const pruned = await index.refresh({ budgetMs: 60000 })
  check('a deleted session stops being indexed', !Object.keys(index._load().files).some((key) => key.includes('session-dedup')), JSON.stringify(Object.keys(index._load().files)))
  check('a deleted session leaves the totals', aggregateTrail(index._load(), { days: 7, now: NOW }).total === 4, String(aggregateTrail(index._load(), { days: 7, now: NOW }).total))

  // ── persistence ───────────────────────────────────────────────────────────
  const saved = JSON.parse(readFileSync(indexPath, 'utf8'))
  check('the index is persisted with a version gate', saved.version === INDEX_VERSION, String(saved.version))
  check('the index is written private', (statSync(indexPath).mode & 0o777) === 0o600, (statSync(indexPath).mode & 0o777).toString(8))
  check('the index stores one record per session directory', Object.keys(saved.files).length === 3, JSON.stringify(Object.keys(saved.files)))
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
  check('the partial scan still reports the window size', partial.total === 3, JSON.stringify(partial))
  const partialReport = aggregateTrail(slow._load(), { days: 7, now: NOW })
  check('a partial index is marked in the report', partialReport.index.pending > 0, JSON.stringify(partialReport.index))
  check('a partial index still shows the numbers it has', partialReport.total >= 0, String(partialReport.total))

  // ── the RPC ────────────────────────────────────────────────────────────────
  resetTrailIndex()
  const report = await trailReport({ sessionsRoot: slowRoot, path: join(root, 'rpc-index.json'), now: () => NOW, days: 30, budgetMs: 60000 })
  check('the RPC answers with the page shape', typeof report.total === 'number' && Array.isArray(report.days) && Array.isArray(report.sessions) && Array.isArray(report.models) && Array.isArray(report.rows), JSON.stringify(Object.keys(report)))
  check('the RPC honours the requested window', report.range === 30 && report.days.length === 30, JSON.stringify(report.range))
  check('the RPC counts the whole window', report.total === 5, String(report.total))

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

  // And a folded log still reconciles with itself: the rows of the window add
  // up to that window's headline, which is the property the ledger is read for.
  const folded = aggregateTrail(foldState, { days: 7, now: NOW })
  check('the folded rows still add up to the headline', folded.rows.reduce((sum, row) => sum + row.count, 0) === folded.total, JSON.stringify({ rows: folded.rows, total: folded.total }))
  check('the folded headline counts every mask', folded.total === 31, String(folded.total))
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
