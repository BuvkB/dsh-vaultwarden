/**
 * Masking trail index — the data behind the panel's 脱敏轨迹 page.
 *
 * Why an index exists at all
 * --------------------------
 * Nothing records a "mask happened" event. There are only two on-disk traces,
 * both inside session logs:
 *
 *  1. a placeholder ({{BW_<KIND>_<tag>}}) — maskMode replaced a value before it
 *     reached the transcript, so the plaintext never landed on disk;
 *  2. a marker ([REDACTED:BW]) — plaintext DID land and the sweeper rewrote it
 *     afterwards.
 *
 * Together they answer the page's question: how much of the vault left this
 * machine, said to which conversation and which model. Reading them means
 * decompressing every frame of every log — measured on the dev corpus, 313 MB
 * of frames take ~15 s even though only 1442 of them contain anything. That is
 * far too slow for an RPC, so the page reads a PERSISTED index and the index is
 * built incrementally, newest log first, under a per-call time budget. A cold
 * corpus answers with partial numbers plus a pending count and the panel polls
 * until it reaches zero; a warm one costs a few stat calls and no decode.
 *
 * Deduplication
 * -------------
 * One reveal is recorded several times: tool/call carries the arguments,
 * tool/result carries the answer, and in code mode tool/ptc-dispatch and
 * tool/ptc-dispatch-start each quote the same payload. Counting lines inflates
 * the truth 2-4x, so a spot is identified by (callId, kind, context) and
 * counted once per session log. The first occurrence wins, which is also the
 * one whose timestamp is the real moment of the mask.
 *
 * Known limits (told to the reader in the page's own note)
 * -------------------------------------------------------
 *  - A marker does not say WHICH field was redacted (the sweeper writes the
 *    bare marker), so redactions are counted as one class; placeholders are not.
 *  - "Distinct values" for a marker is a context fingerprint, not the value:
 *    the plaintext is gone by the time this module reads the line.
 *  - Logs are selected by mtime, so a session that ran inside the window but
 *    has not been touched since is not read, and its older events are missed.
 *  - Assistant and user prose is scanned too (the marker really does appear
 *    there), but prose carries no callId, so its spots dedupe on context alone.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ensurePrivateDir, writeFilePrivate } from './atomic-file.js'
import { bufferHasAny, decodeFrameBuffer, readRange, scanZstdFrames } from './zstd-log.js'
import { listSessionLogs } from './sweeper.js'

/** Bumped whenever the record shape changes; a mismatch discards the index.
 *  v3 raised the per-log row cap, and a v2 record's rows were already trimmed
 *  to 24 — the corpus has to be read again for those pages to exist.
 *  v4 folds a log's rows by the minute they landed in. A v3 record kept one row
 *  per spot and hit the cap on a busy log, so its rows were both crowded and
 *  incomplete; only a re-read produces the folded rows.
 *  v5 keeps, on each folded row, the fingerprints of the values it counted.
 *  The ledger's row is the handle the detail page opens by, and without the
 *  fingerprints the detail could only be rebuilt by re-reading the log — which
 *  fails the moment the log is gone, and costs a full decode when it is not.
 *  v6 reads the model a request actually carried, from the request/header and
 *  request/context events, instead of only the model/selection event — which is
 *  written when a reader picks a model in the UI, and so is absent for most
 *  requests. Every v5 row that a settled log produced kept a null model, and a
 *  settled log is never read again: without the bump, those rows keep saying
 *  "no model recorded" forever. A v5 index re-read in full shows nine. */
export const INDEX_VERSION = 7

/** The ranges the panel offers. Anything else falls back to 7. */
export const TRAIL_RANGES = [7, 30]

/** Widest range, which also bounds how far back the index keeps day buckets. */
const MAX_RANGE_DAYS = 30

/**
 * Logs are picked by mtime, so allow a couple of idle days of slack: a session
 * touched yesterday can still hold events from a week ago.
 */
const SCAN_SLACK_DAYS = 2

const DAY_MS = 24 * 60 * 60 * 1000

/** Per-file caps. They bound the index file, not the counts: a spot already
 *  counted keeps its day bucket after its dedup key is evicted. */
const MAX_SEEN_PER_FILE = 8192
const MAX_VALUES_PER_FILE = 1024
// Rows are what the ledger pages through, so this cap used to decide whether an
// old page existed at all. It did not survive contact with the corpus: at 24 a
// busy session kept only its newest spots, and at 200 the four busiest logs
// still overflowed — 822 of 2545 masks had no row, so paging to the end of the
// ledger still showed less than the headline claimed. Rows are folded by the
// minute now (see addRow), which turns the busiest log measured (568 masks)
// into 57 rows and the whole corpus into ~415; the cap no longer binds, and is
// kept only as a guard against a log whose clock is broken.
const MAX_ROWS_PER_FILE = 1000
const MAX_DAYS_PER_FILE = MAX_RANGE_DAYS + SCAN_SLACK_DAYS + 2
/** How many distinct values one folded row may name. A minute of agent work
 *  holds a handful; the cap is a guard against a log that emits thousands of
 *  placeholders inside one minute, which would otherwise put a thousand
 *  fingerprints on one ledger row. */
const MAX_VALUES_PER_ROW = 24

/** One page of the ledger: forty rows is more than a screen, so a page that
 *  scrolls is not a page. The rest is what the pager is for. */
const LEDGER_PAGE_SIZE = 40

/**
 * How close two masks have to be to read as one burst.
 *
 * The ledger is ordered by time and a session at work emits its masks in
 * clumps: one tool call can leave five placeholders inside the same second,
 * and the next step half a minute later leaves five more. Printed one per
 * line, a busy afternoon is forty identical rows and the reader cannot see
 * that anything else ever happened. Folded into a burst, the same afternoon is
 * six rows with a count on each — which is the question the ledger is asked
 * ("where did it go, and how much at a time"), not "list every placeholder".
 *
 * Five minutes, because that is about one turn of agent work: long enough to
 * swallow a step's worth of retries and tool calls, short enough that two
 * separate tasks in one conversation stay two rows.
 */
const BURST_GAP_MS = 5 * 60 * 1000

/** The two rails show the top talkers, not every one of them. */
const RAIL_ROWS = 6

/** The gate animation only follows the three busiest names on each side. Three
 *  ribbons crossing is a picture; six is a cat's cradle, and on a phone the
 *  labels would be nothing but ellipses. */
const FLOW_ROWS = 3

/** Per-RPC scanning budget: long enough to make progress, short enough that
 *  the host answers within a frame or two the reader will notice. */
export const DEFAULT_TRAIL_BUDGET_MS = 1500

/**
 * Frame pre-filter. Every needle is ASCII, so a latin1 byte search is exact,
 * and a frame that misses all of them never becomes a string.
 */
const NEEDLES = [
  '{{BW_',
  '[REDACTED:BW',
  '"type":"request/header"',
  '"type":"model/selection"',
  '"type":"request/context"',
  '"type":"session/title"',
]

const MARKER_RE = /\[REDACTED:BW(?:_([A-Z]+))?\]/g
const PLACEHOLDER_RE = /\{\{BW_([A-Z]+)_([a-z2-7]{8})\}\}/g
const TYPE_RE = /^\{"type":"([^"]*)","seq":\d+,"time":(\d+)/
const CALL_RE = /"(?:callId|rootCallId|parentCallId)":"([^"]+)"/
const TITLE_RE = /"title":"((?:[^"\\]|\\.)*)"/
const PROVIDER_RE = /"provider":"([^"]*)"/
const MODEL_NAME_RE = /"model":"([^"]*)"/
/**
 * The model a request actually carried, read off the request itself.
 *
 * `model/selection` is written when the reader picks a model in the UI, which
 * is not every request: measured over this machine's corpus it fires at most
 * once per session, while two fifths of the counted masks sit in requests that
 * never emitted one — so their ledger rows read "no model recorded" and the
 * model rail's biggest slice is the one that says "unknown". The request header
 * carries the pair on every request instead.
 *
 * The header line also carries the whole tool list, so the match is anchored to
 * the config object at the front of the header: the first `"model":"` in that
 * line belongs to whichever tool schema comes first, and would name the session
 * after a tool.
 */
const HEADER_MODEL_RE = /"config":\{"provider":"([^"]*)","model":"([^"]*)"/
/** `request/context` repeats the same pair on one small line, after the header. */
const CONTEXT_MODEL_RE = /"data":\{"provider":"([^"]*)","model":"([^"]*)"/

/** The kinds lib/mask.js can emit. Anything else is sample text in a document
 *  or a test fixture that happened to be written to a log, not a mask. */
const KNOWN_KINDS = new Set(['PASSWORD', 'TOTP', 'NOTES', 'FIELD', 'CARD', 'IDENTITY', 'SSHKEY', 'SECURENOTE', 'HISTORY', 'VALUE'])

const pad2 = (value) => (value < 10 ? '0' : '') + value

/** Local calendar day, because the page's axis and its "today" are local. */
const dayKey = (ms) => {
  const date = new Date(ms)
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

/** djb2. Only used to fingerprint context, never as a secret. */
const h32 = (text) => {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  return hash.toString(16).padStart(8, '0')
}

export function defaultSessionsRoot() {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  return join(home, 'sessions')
}

export function trailIndexPath() {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  return join(home, 'data', 'dsh-vaultwarden', 'trail-index.json')
}

/** Version/layout gate. An unreadable or stale file just means a cold scan. */
function loadIndex(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version === INDEX_VERSION && parsed.files && typeof parsed.files === 'object') {
      return { version: INDEX_VERSION, files: parsed.files, meta: parsed.meta ?? {} }
    }
  } catch {
    // absent, torn or from an older build — start over
  }
  return { version: INDEX_VERSION, files: {}, meta: {} }
}

function saveIndex(path, state) {
  try {
    ensurePrivateDir(dirname(path))
    writeFilePrivate(path, JSON.stringify(state) + String.fromCharCode(10), { mode: 0o600 })
  } catch {
    // Best effort: losing the index costs one cold scan, never correctness.
  }
}

/**
 * The log version a path holds.
 *
 * The host keeps superseded logs beside the current one (v3 next to v4) and
 * they carry the SAME events: measured over the corpus, a v3/v4 pair shares
 * 155 of 155 event sequence numbers. Scanning both would count every mask of
 * that session twice, so a session directory is represented by its highest
 * version and the older files are ignored.
 */
const LOG_VERSION_RE = /[.]v([0-9]+)[.]jsonl[.]zstd$/

const versionOf = (logPath) => {
  const match = LOG_VERSION_RE.exec(logPath)
  return match ? Number(match[1]) : 0
}

function emptyRecord(stat, log) {
  return {
    log,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
    offset: 0,
    title: null,
    lastTime: 0,
    currentModel: null,
    days: {},
    values: {},
    seen: [],
    rows: [],
  }
}

/**
 * The row grain: one row per minute per model.
 *
 * A row used to mean one spot, which is the wrong grain twice over. Too fine:
 * a single tool call leaves five placeholders in the same second and the next
 * step leaves five more, so a busy session produced hundreds of rows that all
 * said the same thing — and the per-log cap then cut the old ones, leaving a
 * ledger that showed less than the headline above it. One minute is the
 * smallest slice a reader can act on ("this conversation, at 21:36") and it
 * collapses the corpus about four to one, which puts every log measured well
 * under the cap.
 */
const MINUTE_MS = 60 * 1000

/**
 * Where each folded row lives, keyed "minute|model".
 *
 * It is a WeakMap rather than a field on the record because the record is
 * persisted: a Map would serialise to an empty object on every row of the
 * index file. A record rebuilt from disk simply loses its entry and re-indexes
 * from its own rows.
 */
const rowIndexes = new WeakMap()

function rowKey(at, model) {
  return Math.floor(at / MINUTE_MS) * MINUTE_MS + '|' + (model ?? '')
}

/**
 * Count one spot into the record's minute row, adding the row if needed.
 *
 * The fingerprint of the counted value rides along (row.v), because the row is
 * the handle the detail page opens by: given a row it can name the values it
 * stands for without re-reading the log, and a log that has since been deleted
 * still opens with a fingerprint-only summary rather than failing.
 */
function addRow(record, at, model, fingerprint) {
  let index = rowIndexes.get(record)
  if (!index) {
    index = new Map()
    for (const row of record.rows) index.set(rowKey(row.t, row.m ?? null), row)
    rowIndexes.set(record, index)
  }
  const key = rowKey(at, model)
  const found = index.get(key)
  if (found) {
    found.n += 1
    // The newest instant inside the minute wins: the ledger is read newest
    // first, and a row stamped :07 when the minute's last mask landed at :41
    // would sit out of order against its own neighbours.
    if (at > found.t) found.t = at
    if (fingerprint) {
      const counts = (found.v ??= {})
      counts[fingerprint] = (counts[fingerprint] ?? 0) + 1
      if (Object.keys(counts).length > MAX_VALUES_PER_ROW) {
        // Evict the OLDEST fingerprint, not the one just inserted: deleting
        // the new key made the row's v-map disagree with row.n and made the
        // value impossible to open from the detail page.
        delete counts[Object.keys(counts)[0]]
      }
    }
    return
  }
  const row = { t: at, n: 1, m: model }
  if (fingerprint) row.v = { [fingerprint]: 1 }
  index.set(key, row)
  record.rows.push(row)
}

/**
 * Fold one decoded event line into the record.
 *
 * Returns the number of NEW spots the line contributed (0 when everything it
 * carried was already counted elsewhere in the same log).
 */
function readLine(line, record, seen) {
  const typeMatch = TYPE_RE.exec(line)
  const type = typeMatch ? typeMatch[1] : ''
  const time = typeMatch ? Number(typeMatch[2]) : 0
  if (time > 0) record.lastTime = time

  if (type === 'session/title') {
    const match = TITLE_RE.exec(line)
    if (match) {
      try {
        record.title = JSON.parse('"' + match[1] + '"')
      } catch {
        record.title = match[1]
      }
    }
    return 0
  }
  if (type === 'model/selection') {
    const provider = PROVIDER_RE.exec(line)
    const model = MODEL_NAME_RE.exec(line)
    if (model && model[1]) record.currentModel = (provider ? provider[1] + '/' : '') + model[1]
    return 0
  }
  if (type === 'request/header' || type === 'request/context') {
    // A request that actually left the machine. Masks are counted against it
    // so the hero can say "n requests" beside "m spots" — two numbers that
    // only make sense together. The host writes TWO events per request
    // (`request/header` then `request/context`, adjacent seq); only the header
    // may increment the counter or every request is reported twice. The
    // context line is still read for its model pair below.
    const at = time || record.lastTime
    if (type === 'request/header' && at > 0) {
      const day = dayKey(at)
      const bucket = record.days[day] ?? (record.days[day] = { n: 0, r: 0, m: {} })
      bucket.r += 1
    }
    // The model this request went out on, which is the model the masks inside
    // it belong to. It outranks the last UI selection: the selection says what
    // the reader picked, the header says what the request actually carried.
    const carried = (type === 'request/header' ? HEADER_MODEL_RE : CONTEXT_MODEL_RE).exec(line)
    if (carried && carried[2]) record.currentModel = (carried[1] ? carried[1] + '/' : '') + carried[2]
    return 0
  }
  if (!line.includes('{{BW_') && !line.includes('[REDACTED:BW')) return 0

  const call = CALL_RE.exec(line)
  const callId = call ? call[1] : ''
  const model = record.currentModel ?? null
  const at = time || record.lastTime || record.mtimeMs
  const day = dayKey(at)
  let added = 0

  for (const match of line.matchAll(MARKER_RE)) {
    const index = match.index ?? 0
    const context = line.slice(Math.max(0, index - 40), index)
    const fingerprint = 'M|' + h32(context)
    const key = callId + '|' + fingerprint
    if (seen.has(key)) continue
    seen.add(key)
    const bucket = record.days[day] ?? (record.days[day] = { n: 0, r: 0, m: {} })
    bucket.n += 1
    if (model) bucket.m[model] = (bucket.m[model] ?? 0) + 1
    record.values[fingerprint] = day
    addRow(record, at, model, fingerprint)
    added += 1
  }

  for (const match of line.matchAll(PLACEHOLDER_RE)) {
    if (!KNOWN_KINDS.has(match[1])) continue
    const fingerprint = match[1] + ':' + match[2]
    const key = callId + '|P|' + fingerprint
    if (seen.has(key)) continue
    seen.add(key)
    const bucket = record.days[day] ?? (record.days[day] = { n: 0, r: 0, m: {} })
    bucket.n += 1
    if (model) bucket.m[model] = (bucket.m[model] ?? 0) + 1
    record.values[fingerprint] = day
    addRow(record, at, model, fingerprint)
    added += 1
  }

  return added
}

/** Keep a record inside its caps, dropping the oldest material first. */
function trimRecord(record) {
  if (record.seen.length > MAX_SEEN_PER_FILE) record.seen = record.seen.slice(-MAX_SEEN_PER_FILE)
  if (record.rows.length > MAX_ROWS_PER_FILE) {
    record.rows = record.rows.slice(-MAX_ROWS_PER_FILE)
    // The surviving rows are the same objects, so the lookup still points at
    // rows that exist — but it also still holds the evicted ones, which would
    // swallow later masks for those minutes. Rebuild from what is left.
    rowIndexes.delete(record)
  }
  const valueKeys = Object.keys(record.values)
  if (valueKeys.length > MAX_VALUES_PER_FILE) {
    valueKeys.sort((left, right) => String(record.values[left]).localeCompare(String(record.values[right])))
    for (const key of valueKeys.slice(0, valueKeys.length - MAX_VALUES_PER_FILE)) delete record.values[key]
  }
  const dayKeys = Object.keys(record.days)
  if (dayKeys.length > MAX_DAYS_PER_FILE) {
    dayKeys.sort()
    for (const key of dayKeys.slice(0, dayKeys.length - MAX_DAYS_PER_FILE)) delete record.days[key]
  }
}

/**
 * Fold the frames appended since the record's offset into it.
 *
 * Never advances past a frame that failed to decode, so a torn tail is retried
 * on the next pass instead of being skipped forever. The deadline is checked
 * per frame: one 13 MB log must not swallow the whole budget.
 */
async function scanLog(logPath, record, seen, deadline, now) {
  const buffer = readRange(logPath, record.offset, record.size)
  if (buffer.length === 0) return { added: 0, stopped: false }
  let frames
  try {
    ;({ frames } = scanZstdFrames(buffer))
  } catch {
    // Cannot delimit frames; leave the offset alone and retry next pass.
    return { added: 0, stopped: true }
  }
  let added = 0
  let offset = record.offset
  let stopped = false
  for (const frame of frames) {
    if (now() > deadline) {
      stopped = true
      break
    }
    let plain
    try {
      plain = await decodeFrameBuffer(buffer.subarray(frame.start, frame.end))
    } catch {
      stopped = true
      break
    }
    if (bufferHasAny(plain, NEEDLES)) {
      const text = plain.toString('utf8')
      for (const line of text.split(String.fromCharCode(10))) {
        if (line === '' || line.charCodeAt(0) !== 123) continue
        added += readLine(line, record, seen)
      }
    }
    offset = record.offset + frame.end
  }
  record.offset = offset
  return { added, stopped }
}

/**
 * The index: a persisted map of session directory -> what it contributed.
 *
 * Refresh is newest-first and budgeted, and refreshes are serialised: two
 * panels open (or a poll racing a manual reload) must not decode the same log
 * twice.
 */
export class TrailIndex {
  constructor(options = {}) {
    this.sessionsRoot = options.sessionsRoot ?? defaultSessionsRoot()
    this.path = options.path ?? trailIndexPath()
    this.now = options.now ?? Date.now
    this.state = null
    this.chain = Promise.resolve()
  }

  _load() {
    if (!this.state) this.state = loadIndex(this.path)
    return this.state
  }

  /**
   * The logs worth reading, one per session, newest first.
   *
   * A session that was migrated from v3 to v4 keeps both files; the newer one
   * alone represents it (see versionOf).
   */
  _enumerate() {
    const cutoff = this.now() - (MAX_RANGE_DAYS + SCAN_SLACK_DAYS) * DAY_MS
    let all = []
    try {
      all = listSessionLogs(this.sessionsRoot)
    } catch {
      all = []
    }
    // A directory that could not be read must not be treated as "deleted":
    // pruning its records would make the next successful scan lose history.
    const incomplete = Boolean(all.incomplete)
    const newest = new Map()
    for (const logPath of all) {
      const key = dirname(logPath)
      const version = versionOf(logPath)
      const known = newest.get(key)
      if (!known || version > known.version) newest.set(key, { key, path: logPath, version })
    }
    const found = []
    for (const session of newest.values()) {
      let stat
      try {
        stat = statSync(session.path)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      found.push({ key: session.key, path: session.path, version: session.version, stat, fresh: stat.mtimeMs >= cutoff })
    }
    // Newest first: a cold index must show this morning's activity before it
    // spends its budget on a session from three weeks ago.
    found.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
    found.incomplete = incomplete
    return found
  }

  refresh(options = {}) {
    const budgetMs = Number(options.budgetMs) > 0 ? Number(options.budgetMs) : DEFAULT_TRAIL_BUDGET_MS
    const run = () => this._refresh(budgetMs)
    const next = this.chain.then(run, run)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async _refresh(budgetMs) {
    const state = this._load()
    const started = this.now()
    const deadline = started + budgetMs
    const entries = this._enumerate()
    const live = new Set()
    let scanned = 0
    let pending = 0
    let changed = false

    for (const entry of entries) {
      live.add(entry.key)
      if (!entry.fresh) continue
      const record = state.files[entry.key]
      const settled =
        record &&
        record.log === entry.path &&
        record.size === entry.stat.size &&
        record.mtimeMs === entry.stat.mtimeMs &&
        record.ino === entry.stat.ino &&
        record.offset >= entry.stat.size
      if (settled) continue
      if (this.now() > deadline) {
        pending += 1
        continue
      }
      // A different file (a version migration) or a rewrite (the sweeper
      // replaces the log) invalidates the offset: those bytes are not the ones
      // that were counted, so the session starts over rather than resuming
      // from a position that now means something else.
      const reusable =
        record && record.log === entry.path && record.ino === entry.stat.ino && entry.stat.size >= record.offset
          ? record
          : emptyRecord(entry.stat, entry.path)
      const next = { ...reusable, log: entry.path, size: entry.stat.size, mtimeMs: entry.stat.mtimeMs, ino: entry.stat.ino }
      next.days = { ...(reusable.days ?? {}) }
      next.values = { ...(reusable.values ?? {}) }
      next.seen = [...(reusable.seen ?? [])]
      next.rows = [...(reusable.rows ?? [])]
      const seen = new Set(next.seen)
      let stopped = false
      try {
        ;({ stopped } = await scanLog(entry.path, next, seen, deadline, this.now))
      } catch {
        pending += 1
        continue
      }
      next.seen = [...seen]
      trimRecord(next)
      state.files[entry.key] = next
      scanned += 1
      changed = true
      if (stopped) pending += 1
    }

    if (!entries.incomplete) {
      for (const key of Object.keys(state.files)) {
        if (!live.has(key)) {
          delete state.files[key]
          changed = true
        }
      }
    }

    state.meta = { scannedAt: started, total: entries.filter((entry) => entry.fresh).length, pending }
    if (changed) saveIndex(this.path, state)
    return { scanned, pending, total: state.meta.total, at: started }
  }
}

/** One shared index per sessions root: the panel polls it from several places. */
let sharedIndex = null

export function trailIndexFor(options = {}) {
  const sessionsRoot = options.sessionsRoot ?? defaultSessionsRoot()
  const path = options.path ?? trailIndexPath()
  if (!sharedIndex || sharedIndex.sessionsRoot !== sessionsRoot || sharedIndex.path !== path) {
    sharedIndex = new TrailIndex({ sessionsRoot, path, now: options.now })
  }
  return sharedIndex
}

/** Test hook: drop the module-level index so a suite can point at its own root. */
export function resetTrailIndex() {
  sharedIndex = null
}

/**
 * Turn the index into the page's numbers.
 *
 * Everything is filtered by the range here, not at scan time, because the same
 * records answer both the 7-day and the 30-day view.
 */
/**
 * Fold the raw minute rows into the ledger's bursts.
 *
 * The walk is newest-first, so a burst is grown from its most recent mask
 * backwards: the first row of a clump keeps the latest timestamp (the time a
 * reader will look for) and inherits the count of everything within the gap
 * behind it.
 *
 * Each burst also keeps the rows it swallowed. The ledger call strips them —
 * forty bursts times their rows times a fingerprint map is not a payload — but
 * the detail page needs them, and it must arrive at the SAME burst the reader
 * clicked. Deriving the fold twice (once for the ledger, once for the detail)
 * would be two implementations of one rule that could drift apart, so both
 * callers share this one.
 */
function foldBursts(rows) {
  const bursts = []
  for (const row of rows) {
    const current = bursts[bursts.length - 1]
    const sameThread = current && current.session === row.session && current.model === row.model
    if (sameThread && current.time - row.t <= BURST_GAP_MS) {
      current.count += row.n ?? 1
      current.rows.push(row)
      continue
    }
    bursts.push({
      time: row.t,
      count: row.n ?? 1,
      model: row.model,
      session: row.session,
      name: row.name,
      rows: [row],
    })
  }
  return bursts
}

/**
 * Gather the page's numbers out of the index.
 *
 * Everything is filtered by the range here, not at scan time, because the same
 * records answer both the 7-day and the 30-day view.
 */
function collectTrail(state, options) {
  const requested = Number(options.days)
  const span = TRAIL_RANGES.includes(requested) ? requested : 7
  // `now` travels as a CLOCK, not an instant, because the index uses it to
  // decide what is stale. Accepting either here keeps the two call shapes
  // identical: a function means "ask the clock", and a number means "this is
  // the instant". Comparing days against a function silently produces NaN,
  // which matches no day key and reads as an empty trail.
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now()
  const windowDays = []
  for (let back = span - 1; back >= 0; back -= 1) windowDays.push(dayKey(now - back * DAY_MS))
  const windowStart = windowDays[0]

  const perDay = new Map(windowDays.map((day) => [day, 0]))
  const perSession = new Map()
  const perModel = new Map()
  // The flow across the gate needs the pair, not two separate totals: a
  // conversation that asked once and a model that answered a thousand times
  // are not the same story as both doing five hundred. The key is
  // `sessionId\u0000provider/model` — the two halves never contain a NUL.
  const perPair = new Map()
  const values = new Map()
  const rows = []
  let total = 0
  let requests = 0

  for (const [key, record] of Object.entries(state.files)) {
    if (!record?.days) continue
    const id = basename(key)
    let sessionCount = 0
    for (const [day, bucket] of Object.entries(record.days)) {
      if (day < windowStart || !perDay.has(day)) continue
      if (!bucket?.n) continue
      perDay.set(day, perDay.get(day) + bucket.n)
      sessionCount += bucket.n
      total += bucket.n
      requests += bucket.r ?? 0
      for (const [model, count] of Object.entries(bucket.m ?? {})) {
        perModel.set(model, (perModel.get(model) ?? 0) + count)
        const pairKey = id + '\u0000' + model
        perPair.set(pairKey, (perPair.get(pairKey) ?? 0) + count)
      }
    }
    if (sessionCount > 0) {
      perSession.set(key, { key, id, name: record.title ?? null, count: sessionCount })
    }
    for (const [value, day] of Object.entries(record.values ?? {})) {
      if (day < windowStart) continue
      const seen = values.get(value)
      if (!seen || seen < day) values.set(value, day)
    }
    for (const row of record.rows ?? []) {
      // The row window is the AXIS, not "now minus N days": the axis starts at
      // midnight of the oldest day it shows, so a mask from that morning is on
      // the axis (and in the headline) while one from the day before is in
      // neither. Filtering rows by the same day keys is what keeps the ledger's
      // counts reconciling with the number above it.
      if (!row || !perDay.has(dayKey(row.t))) continue
      // `values` is the row's fingerprint map. It rides only as far as the
      // fold — the ledger call strips it — but the detail page needs it to know
      // which values a burst stands for without re-reading the log.
      rows.push({
        t: row.t,
        n: row.n ?? 1,
        model: row.m ?? null,
        session: id,
        name: record.title ?? null,
        values: row.v ?? null,
      })
    }
  }

  rows.sort((left, right) => right.t - left.t)
  return {
    span,
    now,
    windowDays,
    perDay,
    perSession,
    perModel,
    perPair,
    values,
    total,
    requests,
    rows,
    bursts: foldBursts(rows),
  }
}

/** 'provider/model' is how a mask's model is stored, but a reader reads the two
 *  apart: the ledger's column names the model and the rails split the provider.
 *  Both callers split it here so a row and its detail page cannot disagree
 *  about which model a burst was sent to. */
function splitModel(value) {
  const cut = value.indexOf('/')
  return cut > 0 ? { provider: value.slice(0, cut), model: value.slice(cut + 1) } : { provider: null, model: value }
}

export function aggregateTrail(state, options = {}) {
  const { span, windowDays, perDay, perSession, perModel, perPair, values, total, requests, bursts } = collectTrail(state, options)

  // Masks seen before the session picked a model have nothing to attribute to.
  // They get their own row instead of vanishing: the rails are read as a split
  // of the headline, and a split that silently sums low reads as a bug.
  const attributed = [...perModel.values()].reduce((sum, value) => sum + value, 0)
  // `key` is the raw provider/model string the index stores. It stays on the
  // row only long enough to find the pairs among the top three, then leaves:
  // the reply's model list is the same shape it has always been.
  const allModelRows = [...perModel.entries()].map(([value, count]) => ({ ...splitModel(value), key: value, count }))
  if (total - attributed > 0) allModelRows.push({ provider: null, model: null, key: null, count: total - attributed })
  allModelRows.sort((left, right) => right.count - left.count)
  const allSessionRows = [...perSession.values()].sort((left, right) => right.count - left.count)

  // The board draws the top three conversations through the gate to the top
  // three models. Both lists are truncated here, not in the browser, because
  // only the host can rank every conversation in the window — the reply will
  // never carry more than RAIL_ROWS of them. The pair counts are what make a
  // ribbon a fact rather than an average of two unrelated shares.
  const topSessions = allSessionRows.slice(0, FLOW_ROWS)
  const topModels = allModelRows.slice(0, FLOW_ROWS)
  const topSessionIds = new Set(topSessions.map((row) => row.id))
  const topModelKeys = new Set(topModels.map((row) => row.key).filter(Boolean))
  const links = []
  for (const [pairKey, count] of perPair) {
    const cut = pairKey.indexOf('\u0000')
    if (cut < 0) continue
    const session = pairKey.slice(0, cut)
    const rawModel = pairKey.slice(cut + 1)
    if (!topSessionIds.has(session) || !topModelKeys.has(rawModel)) continue
    links.push({ session, ...splitModel(rawModel), count })
  }
  links.sort((left, right) => right.count - left.count)
  const topSessionSum = topSessions.reduce((sum, row) => sum + row.count, 0)
  const topModelSum = topModels.reduce((sum, row) => sum + row.count, 0)
  const flows = {
    sessions: topSessions.map(({ id, name, count }) => ({ id, name, count })),
    models: topModels.map(({ provider, model, count }) => ({ provider, model, count })),
    links,
    // What the three names leave out, so the board can say "another N" instead
    // of quietly showing a subset as if it were the whole window.
    otherSessions: { count: total - topSessionSum, items: allSessionRows.length - topSessions.length },
    otherModels: { count: total - topModelSum, items: allModelRows.length - topModels.length },
  }

  // The ledger is paged rather than capped: the cap tells the reader there is
  // more (a pager) instead of dropping the tail silently. A page outside the
  // range is clamped here, because the client cannot know the count in advance
  // — the newest page grows while the reader is looking at it, and a page can
  // also disappear when an old session ages out of the window.
  const pageCount = Math.max(1, Math.ceil(bursts.length / LEDGER_PAGE_SIZE))
  const requestedPage = Math.floor(Number(options.page))
  const page = Number.isFinite(requestedPage) ? Math.min(Math.max(1, requestedPage), pageCount) : 1
  const from = (page - 1) * LEDGER_PAGE_SIZE

  return {
    range: span,
    total,
    distinct: values.size,
    requests,
    days: windowDays.map((day) => ({ day, count: perDay.get(day) ?? 0 })),
    // The rail needs an id, a name and a count. `key` is the absolute log
    // directory, and handing it to a browser RPC leaks the host's data layout
    // the same way config() deliberately strips the session path.
    sessions: allSessionRows.slice(0, RAIL_ROWS).map(({ id, name, count }) => ({ id, name, count })),
    models: allModelRows.slice(0, RAIL_ROWS).map(({ provider, model, count }) => ({ provider, model, count })),
    flows,
    // One page of clumps. Each row is one burst of masks that reached one
    // conversation on one model — the ledger's columns plus how many landed at
    // once, which is what tells a burst from a single mask.
    rows: bursts.slice(from, from + LEDGER_PAGE_SIZE).map((burst) => ({
      time: burst.time,
      count: burst.count,
      ...(burst.model ? splitModel(burst.model) : { provider: null, model: null }),
      session: burst.session,
      name: burst.name,
    })),
    ledger: { page, pages: pageCount, size: LEDGER_PAGE_SIZE, total: bursts.length },
    index: {
      pending: state.meta?.pending ?? 0,
      total: state.meta?.total ?? 0,
      scannedAt: state.meta?.scannedAt ?? 0,
      sessions: Object.keys(state.files).length,
    },
  }
}

/**
 * The RPC's whole job: refresh what is stale within the budget, then aggregate.
 *
 * Throws nothing for a missing sessions directory — an empty trail is a
 * legitimate state (a fresh install has no logs).
 */
export async function trailReport(options = {}) {
  const index = trailIndexFor(options)
  await index.refresh(options)
  return aggregateTrail(index._load(), {
    days: options.days,
    page: options.page,
    now: options.now ?? Date.now(),
  })
}

/**
 * One mask, in the words the detail page uses.
 *
 * The index deliberately stores no text: a value's tag is an HMAC, the marker's
 * context is a hash, and neither can be turned back into what was hidden. What
 * CAN be recovered is the log line the mask sits in, and the page's job is to
 * show as much of that as exists — which event carried it, what sat beside it,
 * and whether it came back out in the reply.
 */
const INK_CHARS = 120

/** Occurrences of one value carried to the page. A log repeats the same spot
 *  in tool/call, tool/result and (in code mode) tool/ptc-dispatch, so the first
 *  few already tell the whole story; the cap keeps one busy minute from
 *  becoming a megabyte of context. */
const MAX_SPOTS_PER_VALUE = 6

/** The budget for reading one log window. The index's 1500 ms guards the whole
 *  corpus; this guards a single log, which is allowed to cost more because the
 *  reader asked for it by name — but not to hang the RPC. */
const DETAIL_BUDGET_MS = 2500

/** Which part of the exchange a spot landed in, mapped to the page's wording. */
const PLACE_LABELS = {
  'user/message': 'input',
  'tool/call': 'toolCall',
  'tool/result': 'toolResult',
  'assistant/message': 'reply',
  'tool/ptc-dispatch': 'toolCall',
  'tool/ptc-dispatch-start': 'toolCall',
}

function placeOf(type) {
  return PLACE_LABELS[type] ?? (type.startsWith('tool/') ? 'toolCall' : 'other')
}

/** The stretches of one log line worth showing, one per clump of masks.
 *
 *  A sentence can hide three things at once, and one window per mask drew that
 *  sentence three times over — a thousand characters of context for one line of
 *  prose. So masks close enough that their windows would touch share a window,
 *  and the page shows the sentence once with every one of its marks in place.
 *
 *  Sharing has a limit, though: a single log line can also be a whole tool call
 *  whose arguments quote a file, with one mask at either end. Merging those two
 *  draws the entire argument blob — six thousand pixels of it — to show two
 *  placeholders. Masks that are further apart than their windows are therefore
 *  read as separate sightings, which is what they are: two values that happened
 *  to be written on the same line, not two values in one sentence.
 *
 *  Sliced, not tokenised: the log line is JSON, and the interesting part is
 *  usually the key the value sat under ("apiKey":"..."), which a tokeniser
 *  would throw away.
 *
 *  @returns {{masks: object[], text: string, start: number}[]} one entry per
 *  clump: the masks in it, the slice covering them, and where that slice began
 *  so a caller can turn a mask's index into an offset inside it. */
function inkSpans(line, masks) {
  const spans = []
  let clump = []
  let from = 0
  let to = 0
  masks.forEach((mask) => {
    const start = Math.max(0, mask.index - INK_CHARS)
    const end = Math.min(line.length, mask.index + mask.length + INK_CHARS)
    // Overlapping or touching windows read as one sighting; a wider gap does not.
    if (clump.length > 0 && start <= to) {
      clump.push(mask)
      to = Math.max(to, end)
      return
    }
    if (clump.length > 0) spans.push({ masks: clump, text: line.slice(from, to), start: from })
    clump = [mask]
    from = start
    to = end
  })
  if (clump.length > 0) spans.push({ masks: clump, text: line.slice(from, to), start: from })
  return spans
}

/** The first line's time in one decoded frame, or 0 when it carries none.
 *  Frames are append batches written in time order, so a frame's first line is
 *  its earliest moment — which is all the search needs to place a frame
 *  against the window, without turning the whole frame into a string. */
function frameFirstTime(plain) {
  const head = plain.toString('utf8', 0, Math.min(plain.length, 240))
  const match = TYPE_RE.exec(head)
  return match ? Number(match[2]) : 0
}

/**
 * The log's own text, made readable.
 *
 * A session log line is JSON, so the text around a mask arrives double-escaped:
 * \n is the two characters backslash-n, quotes are \", and a JSON result is one
 * long string inside another. Drawn raw it reads as a wall of punctuation. The
 * page keeps the raw slice for the index's accounting, and adds a display form
 * built from the parsed event: the string value that actually carried the mask,
 * pretty-printed when it is itself JSON, clipped to the lines around the mask.
 *
 * The index never keeps a log line; this is done while the detail window is read
 * and only for the handful of lines that carry a mask.
 */
const DISPLAY_MAX_CHARS = 2400
const DISPLAY_BEFORE_LINES = 4
const DISPLAY_AFTER_LINES = 10

/** One-line JSON with a space after its punctuation, so it wraps at
 *  key/value boundaries instead of anywhere. Compact is the point: a pretty
 *  object with one key per line was taller than the dialog it lived in. */
const compactJson = (value) => {
  const text = JSON.stringify(value)
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      out += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      out += character
      continue
    }
    out += character === ',' || character === ':' ? character + ' ' : character
  }
  return out
}

const asJsonCode = (value) => {
  const text = String(value)
  const trimmed = text.trim()
  const looksJson = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  if (!looksJson) return text
  try {
    return compactJson(JSON.parse(trimmed))
  } catch {
    return text
  }
}

/** Every string value under one parsed event that contains the needle. */
const stringsWith = (value, needle, out = []) => {
  if (typeof value === 'string') {
    if (value.includes(needle)) out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsWith(item, needle, out)
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) stringsWith(item, needle, out)
  }
  return out
}

/** One readable window around a needle, with the needle's offset into it. */
const displayWindow = (text, needle) => {
  const at = text.indexOf(needle)
  if (at < 0) return null
  if (text.length <= DISPLAY_MAX_CHARS) return { text, needleAt: at }
  /** Last-resort character window: some log lines are one enormous line (a
   *  dispatch script, a minified page), and a line-based window around their
   *  needle would still be tens of thousands of characters wide. */
  const clipAround = () => {
    const from = Math.max(0, at - 600)
    const to = Math.min(text.length, at + needle.length + 1200)
    let shown = text.slice(from, to)
    if (from > 0) shown = '…' + shown
    if (to < text.length) shown += '…'
    return { text: shown, needleAt: shown.indexOf(needle) }
  }
  const lines = text.split(String.fromCharCode(10))
  const lineIndex = lines.findIndex((line) => line.includes(needle))
  if (lineIndex >= 0 && lines.length > 1) {
    const start = Math.max(0, lineIndex - DISPLAY_BEFORE_LINES)
    const end = Math.min(lines.length, lineIndex + DISPLAY_AFTER_LINES + 1)
    let shown = lines.slice(start, end).join(String.fromCharCode(10))
    if (start > 0) shown = '…\n' + shown
    if (end < lines.length) shown += '\n…'
    if (shown.length <= DISPLAY_MAX_CHARS) return { text: shown, needleAt: shown.indexOf(needle) }
  }
  return clipAround()
}

/** The display text for one mask in one parsed event. */
const displayForMask = (event, needle) => {
  for (const candidate of stringsWith(event, needle)) {
    const shown = displayWindow(asJsonCode(candidate), needle)
    if (shown !== null) return shown
  }
  return null
}

/** Every mask occurrence in one decoded frame that lands inside the window.
 *  Kept apart from the walk so the window's frames are read by one piece of
 *  code no matter which way the search arrived at them. */
function occurrencesOf(plain, from, to) {
  const out = []
  if (!bufferHasAny(plain, NEEDLES)) return out
  const text = plain.toString('utf8')
  for (const line of text.split(String.fromCharCode(10))) {
    if (line === '' || line.charCodeAt(0) !== 123) continue
    const head = TYPE_RE.exec(line)
    const type = head ? head[1] : ''
    const time = head ? Number(head[2]) : 0
    // Half-open window: `to` is the first instant of the next minute, so an
    // event exactly on it belongs to the next row, not this one.
    if (time > 0 && (time < from || time >= to)) continue

    // Found first, sliced once. A line can carry several masks — one sentence
    // can hide a password, a token and a path — and a window per mask produced
    // windows that overlapped so heavily the page showed the same paragraph
    // three times over. One window around all of them is the same information
    // on one screen, and it is how the masks actually sat in the line, which is
    // what the reader came to see.
    const masks = []
    for (const match of line.matchAll(MARKER_RE)) {
      const index = match.index ?? 0
      masks.push({ fingerprint: 'M|' + h32(line.slice(Math.max(0, index - 40), index)), index, length: match[0].length })
    }
    for (const match of line.matchAll(PLACEHOLDER_RE)) {
      if (!KNOWN_KINDS.has(match[1])) continue
      masks.push({ fingerprint: match[1] + ':' + match[2], index: match.index ?? 0, length: match[0].length })
    }
    if (masks.length === 0) continue
    masks.sort((left, right) => left.index - right.index)
    // Parsed once per line, and only for a line that carries a mask. The raw
    // slice stays on `text`; the readable form is an extra field so an older
    // client keeps working and the detail page can say which form it is using.
    let event = null
    try {
      event = JSON.parse(line)
    } catch {
      event = null
    }
    for (const span of inkSpans(line, masks)) {
      for (const mask of span.masks) {
        const needle = line.slice(mask.index, mask.index + mask.length)
        const shown = event === null ? null : displayForMask(event, needle)
        out.push({
          fingerprint: mask.fingerprint,
          type,
          time,
          text: span.text,
          needle,
          needleAt: mask.index - span.start,
          displayText: shown === null ? null : shown.text,
          displayNeedleAt: shown === null ? null : shown.needleAt,
        })
      }
    }
  }
  return out
}

/**
 * Read one minute-window of one log for context, WITHOUT touching the index.
 *
 * The record's offset is where the index stopped reading, which is the END of
 * the log — so the row a reader clicks sits almost always behind a long stretch
 * of frames that have nothing to do with it. Decoding all of them is what used
 * to break this page: the newest row of a busy session sat behind 4426 frames
 * (7.6 MB) and the walk ran out of budget before reaching it, so the page came
 * back empty exactly when a reader was most likely to click. Nothing was wrong
 * with the window — the scan never got there.
 *
 * So the window is now FOUND before it is read. Frame times are monotone (the
 * host appends frames in order and never rewrites them), which makes the frame
 * holding a given moment findable by bisection: a dozen single-frame probes
 * instead of thousands of decodes, after which only the frames of the window
 * are read in full. The same search serves both ends of the log — a row from
 * today lands near the last frame, one from last week lands in the middle.
 *
 * Nothing here mutates the record, so a failed or missing log degrades the page
 * to the fingerprints the index already holds instead of corrupting the index
 * or throwing.
 */
async function scanWindow(logPath, from, to, wanted, deadline, now) {
  const occurrences = []
  let size
  try {
    size = statSync(logPath).size
  } catch {
    return { occurrences, missing: true }
  }
  const buffer = readRange(logPath, 0, size)
  if (buffer.length === 0) return { occurrences, missing: false }
  let frames
  try {
    ;({ frames } = scanZstdFrames(buffer))
  } catch {
    return { occurrences, missing: false }
  }
  if (frames.length === 0) return { occurrences, missing: false }

  // First frame that starts at or after `from`. A frame with no time of its own
  // (the header) counts as "could be early", so it pulls the search earlier
  // rather than letting the walk start past the window.
  let low = 0
  let high = frames.length
  while (low < high) {
    if (now() > deadline) return { occurrences, missing: false, truncated: true }
    const mid = (low + high) >>> 1
    let plain = null
    try {
      plain = await decodeFrameBuffer(buffer.subarray(frames[mid].start, frames[mid].end))
    } catch {
      // An unreadable frame cannot be placed in time; treat it as early so the
      // walk still covers everything after it.
      plain = null
    }
    const time = plain ? frameFirstTime(plain) : 0
    if (time > 0 && time < from) low = mid + 1
    else high = mid
  }

  // Start a couple of frames early: a frame whose own first line is older than
  // the window can still carry lines inside it, and backing up costs nothing
  // because every occurrence is filtered by the window on the way out.
  for (let index = Math.max(0, low - 2); index < frames.length; index += 1) {
    if (now() > deadline) return { occurrences, missing: false, truncated: true }
    let plain
    try {
      plain = await decodeFrameBuffer(buffer.subarray(frames[index].start, frames[index].end))
    } catch {
      // A torn tail ends the read; the window is behind it anyway. Say so:
      // the page distinguishes a complete minute from a partial one.
      return { occurrences, missing: false, truncated: true }
    }
    if (frameFirstTime(plain) >= to) break
    for (const occurrence of occurrencesOf(plain, from, to)) {
      // The window can contain another model's row from the same minute; only
      // the fingerprints this burst actually counted belong to this detail.
      if (!wanted || wanted.has(occurrence.fingerprint)) occurrences.push(occurrence)
    }
  }
  return { occurrences, missing: false }
}

/**
 * Everything the detail page can honestly say about one ledger row.
 *
 * The ledger row is the only handle the reader has: it names a session and a
 * minute, and that is all the index was ever asked to keep. From it we re-derive
 * the same burst the ledger folded (through the same foldBursts, so the two can
 * never disagree about which burst was clicked), take the fingerprints that
 * burst counted, and re-read the log window behind them for context.
 *
 * Two honest limits, both returned rather than hidden:
 *  - the log is gone or unreadable, so there is only the fingerprint summary;
 *  - the value itself is gone by construction (the tag is an HMAC, the marker's
 *    context is a hash), so no page built on this module can show the original.
 */
export async function trailRowDetail(options = {}) {
  const index = trailIndexFor(options)
  await index.refresh(options)
  const state = index._load()
  const { bursts } = collectTrail(state, {
    days: options.days,
    now: options.now ?? Date.now(),
  })

  const session = String(options.session ?? '')
  const time = Number(options.time)
  const burst = bursts.find((entry) => entry.session === session && entry.time === time)
  if (!burst) return { ok: false, reason: 'not-found', session, time }

  // The fingerprints the burst's rows counted, with how often each was seen.
  const counted = new Map()
  for (const row of burst.rows) {
    for (const [fingerprint, n] of Object.entries(row.values ?? {})) {
      counted.set(fingerprint, (counted.get(fingerprint) ?? 0) + n)
    }
  }

  // The window to re-read: from the oldest minute the burst swallowed to the
  // end of its newest one.
  //
  // A row's instant is the NEWEST mask in its minute — that is the time a
  // reader looks for — so the window starts by flooring it back to the minute.
  // Starting at the instant instead would begin up to a minute late and drop
  // the masks that landed first: the tool call carrying the value before the
  // result echoed it is the whole reason the page has three spots to show.
  const minutes = burst.rows.map((row) => row.t - (row.t % MINUTE_MS))
  const from = Math.min(...minutes)
  const to = Math.max(...minutes) + MINUTE_MS

  // The record behind the session id. Keyed by directory, and a session id is a
  // basename, so match on that — but prefer a record that actually holds a row
  // in the window, in case two directories ever share a basename.
  let log = null
  for (const [key, record] of Object.entries(state.files)) {
    if (!record?.log || basename(key) !== session) continue
    if (!log) log = record.log
    if ((record.rows ?? []).some((row) => row.t >= from && row.t < to)) {
      log = record.log
      break
    }
  }

  const scanned = log
    ? await scanWindow(log, from, to, new Set(counted.keys()), Date.now() + DETAIL_BUDGET_MS, Date.now)
    : { occurrences: [], missing: true }

  // Start from the fingerprints the INDEX counted, not from what the window
  // happened to decode. A deleted log or a truncated minute has no occurrences
  // but still has real fingerprints; returning an empty list made the page say
  // "no values" about a burst it could still count. Occurrences only decorate
  // those entries with spots.
  const valuesByFingerprint = new Map()
  for (const [fingerprint, count] of counted) {
    valuesByFingerprint.set(fingerprint, {
      fingerprint,
      count,
      // A marker says nothing about which field it replaced, so its kind is
      // null and the page says so rather than guessing.
      kind: fingerprint.startsWith('M|') ? null : fingerprint.slice(0, fingerprint.indexOf(':')),
      places: [],
      reply: false,
      firstAt: null,
      spots: [],
    })
  }
  for (const occurrence of scanned.occurrences) {
    const value = valuesByFingerprint.get(occurrence.fingerprint)
    if (!value) continue
    const place = placeOf(occurrence.type)
    if (!value.places.includes(place)) value.places.push(place)
    if (place === 'reply') value.reply = true
    if (value.firstAt === null) value.firstAt = occurrence.time || null
    if (value.spots.length < MAX_SPOTS_PER_VALUE) {
      value.spots.push({
        type: occurrence.type,
        at: occurrence.time,
        text: occurrence.text,
        needle: occurrence.needle,
        needleAt: occurrence.needleAt,
        displayText: occurrence.displayText ?? null,
        displayNeedleAt: occurrence.displayNeedleAt ?? null,
      })
    }
  }
  const values = [...valuesByFingerprint.values()]
  // Placeholders name their kind and sort first; markers, which name nothing,
  // sort last.
  values.sort((left, right) => (left.kind ? 0 : 1) - (right.kind ? 0 : 1) || (left.firstAt ?? 0) - (right.firstAt ?? 0))

  return {
    ok: true,
    session,
    time: burst.time,
    name: burst.name ?? null,
    // The same split the ledger row carries, so the detail page names the model
    // the reader clicked rather than the joined string the index stored.
    ...(burst.model ? splitModel(burst.model) : { provider: null, model: null }),
    count: burst.count,
    minutes: burst.rows.map((row) => ({ time: row.t, count: row.n ?? 1, model: row.model ?? null })),
    values,
    log: {
      missing: Boolean(scanned.missing),
      truncated: Boolean(scanned.truncated),
      windowFrom: from,
      windowTo: to,
    },
  }
}
