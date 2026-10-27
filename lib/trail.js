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
 *  incomplete; only a re-read produces the folded rows. */
export const INDEX_VERSION = 4

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
const MAX_ROWS_PER_FILE = 200
const MAX_DAYS_PER_FILE = MAX_RANGE_DAYS + SCAN_SLACK_DAYS + 2

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
  '"type":"session/title"',
]

const MARKER_RE = /\[REDACTED:BW(?:_([A-Z]+))?\]/g
const PLACEHOLDER_RE = /\{\{BW_([A-Z]+)_([a-z2-7]{8})\}\}/g
const TYPE_RE = /^\{"type":"([^"]*)","seq":\d+,"time":(\d+)/
const CALL_RE = /"(?:callId|rootCallId|parentCallId)":"([^"]+)"/
const TITLE_RE = /"title":"((?:[^"\\]|\\.)*)"/
const PROVIDER_RE = /"provider":"([^"]*)"/
const MODEL_NAME_RE = /"model":"([^"]*)"/

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

/** Count one spot into the record's minute row, adding the row if needed. */
function addRow(record, at, model) {
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
    return
  }
  const row = { t: at, n: 1, m: model }
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
  if (type === 'request/header') {
    // A request that actually left the machine. Masks are counted against it
    // so the hero can say "n requests" beside "m spots" — two numbers that
    // only make sense together.
    const at = time || record.lastTime
    if (at > 0) {
      const day = dayKey(at)
      const bucket = record.days[day] ?? (record.days[day] = { n: 0, r: 0, m: {} })
      bucket.r += 1
    }
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
    addRow(record, at, model)
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
    addRow(record, at, model)
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
        record.ino === entry.stat.ino
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

    for (const key of Object.keys(state.files)) {
      if (!live.has(key)) {
        delete state.files[key]
        changed = true
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
export function aggregateTrail(state, options = {}) {
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
      rows.push({ t: row.t, n: row.n ?? 1, model: row.m ?? null, session: id, name: record.title ?? null })
    }
  }

  rows.sort((left, right) => right.t - left.t)
  const splitModel = (value) => {
    const cut = value.indexOf('/')
    return cut > 0 ? { provider: value.slice(0, cut), model: value.slice(cut + 1) } : { provider: null, model: value }
  }

  // Fold each clump into one row. The walk is newest-first, so a burst is grown
  // from its most recent mask backwards: the first row of a clump keeps the
  // latest timestamp (the time a reader will look for) and inherits the count
  // of everything within the gap behind it.
  const bursts = []
  for (const row of rows) {
    const current = bursts[bursts.length - 1]
    const sameThread = current && current.session === row.session && current.model === row.model
    if (sameThread && current.time - row.t <= BURST_GAP_MS) {
      current.count += row.n ?? 1
      continue
    }
    bursts.push({ time: row.t, count: row.n ?? 1, model: row.model, session: row.session, name: row.name })
  }

  // Masks seen before the session picked a model have nothing to attribute to.
  // They get their own row instead of vanishing: the rails are read as a split
  // of the headline, and a split that silently sums low reads as a bug.
  const attributed = [...perModel.values()].reduce((sum, value) => sum + value, 0)
  const modelRows = [...perModel.entries()].map(([value, count]) => ({ ...splitModel(value), count }))
  if (total - attributed > 0) modelRows.push({ provider: null, model: null, count: total - attributed })

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
    sessions: [...perSession.values()].sort((left, right) => right.count - left.count).slice(0, RAIL_ROWS),
    models: modelRows.sort((left, right) => right.count - left.count).slice(0, RAIL_ROWS),
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
