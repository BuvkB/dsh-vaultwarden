/**
 * Session-log sweeper — the after-the-fact half of maskMode.
 *
 * Why this exists
 * ---------------
 * Even with maskMode on, plaintext still reaches the session log in two ways:
 * a bitwarden_reveal call (that is its job), and a caller that echoes a
 * secret into a message or an unrelated tool call afterwards. The host offers
 * no before-write hook for tool results, so the log cannot be prevented from
 * seeing the value — but it can be rewritten afterwards, and the rewrite is
 * the only way the promise 'secrets do not persist' can be kept at all.
 *
 * What it does
 * ------------
 * For each session.v*.jsonl.zstd under ~/.dsh/sessions:
 *  1. Skip logs whose session is still live (the host appends to them; see
 *     isIdle for how liveness is decided conservatively).
 *  2. Decode the frames, parse each line as JSON, and in tool/call +
 *     tool/result + tool/ptc-dispatch + tool/ptc-dispatch-start events for
 *     bitwarden_* tools replace credential-shaped values with a kinded marker
 *     — [REDACTED:BW_PASSWORD], [REDACTED:BW_TOTP], … — so a reader, and the
 *     trail index, can tell a sweep apart from prose quoting the pattern.
 *     Placeholders ({{BW_*}}) pass through untouched — they are tags, not
 *     secrets.
 *  3. Hunt echoes: the exact secret values harvested in step 2 are replaced
 *     wherever they reappear in ANY tool event's text-bearing fields — in
 *     code mode the run_code aggregate tool/result quotes its bitwarden
 *     sub-calls' output as free text under a run_code-named event, which
 *     step 2's name filter never sees.
 *  4. Rewrite only the frames whose plaintext changed, copying every other
 *     frame's bytes verbatim (see 'Incremental' below).
 *
 * Idempotent by construction: a redacted line no longer matches the secret
 * patterns, so sweeping twice does nothing the second time.
 *
 * Incremental by construction
 * ---------------------------
 * The host APPENDS to a log (open(path, 'a') in dsh-session-persistence-jsonl
 * appendLines) and never rewrites bytes it already wrote, so a log is an
 * immutable prefix plus a growing tail of zstd frames. This module exploits
 * that instead of decoding the whole file on every round:
 *
 *  - A per-file record (size, mtime, inode, harvest offset) lives in
 *    ~/.dsh/data/dsh-vaultwarden/sweep-state.json. A log whose size and
 *    mtime are unchanged is not read at all — measured steady state on a
 *    364-log corpus is ~1% of files changing per 30-minute round, so this
 *    turns a 42 s full-corpus decode into a few milliseconds.
 *  - The cross-log seed pass (learning plaintext values so echoes can be
 *    hunted by content) reads only the bytes appended since the previous
 *    round.
 *  - A rewrite recompresses ONLY the frames that actually changed; unchanged
 *    frames are copied byte for byte. That also preserves the host's
 *    invariant that the first frame is exactly the one-line session header.
 *
 * Skipping the already-scanned bytes of an unchanged log cannot hide an echo:
 * a value can only be echoed after it exists, and it is harvested (from busy
 * logs too, read-only) in the same round in which it appears, because the
 * harvest pass always runs over a log's new bytes before that log is swept.
 * The manual bitwarden_sweep tool still offers a full re-scan.
 *
 * Known limits (documented in the README, told to the user):
 *  - The window between a reveal and the next sweep still holds the plaintext
 *    on disk. Sweeping shrinks the exposure, it cannot close it.
 *  - Model thinking text and user prose that quote a secret are left intact
 *    on purpose: assistant/user events carry thinkingSignature material the
 *    host needs byte-exact for replay, so the sweep is restricted to tool
 *    events.
 *  - One frame is decoded into one JS string at a time, so cost is bounded by
 *    the largest single frame rather than by the size of the log.
 *  - Other persistence paths the plugin cannot see (~/.dsh/backups, plugin
 *    translator caches, the model's own context) are out of scope.
 *  - Rewriting the log does not change what the model already has in memory.
 */
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensurePrivateDir, writeFilePrivate } from './atomic-file.js'
import { redactionMarker } from './mask.js'
import { bufferHasAny, decodeFrameBuffer, encodeFrame, readRange, scanZstdFrames } from './zstd-log.js'

/** How old a session.lock must be before its log is treated as settled. The
 *  host touches the lock while the session is active; a lock untouched for
 *  this long means no turn is running. Deliberately generous — a false
 *  'idle' would race the host's appender. */
const DEFAULT_IDLE_SECONDS = 600

/** Decoded bytes one round may process before it stops and leaves the rest
 *  for the next round. Steady state uses a tiny fraction of this; the ceiling
 *  exists so the first run after an upgrade (an empty state file means every
 *  log looks new) cannot turn into an hour-long background burn. */
const DEFAULT_BYTE_BUDGET = 128 * 1024 * 1024

/** Wall-clock ceiling for one round. The byte budget bounds WORK, but work per
 *  byte varies by an order of magnitude (a frame full of tool traffic is parsed
 *  and rewritten, a prose frame is only scanned), so a byte budget alone lets a
 *  round run for an unbounded time on a fast disk. This is the limit that
 *  actually keeps a periodic maintenance task off the host's back: whatever is
 *  left over simply becomes next round's work, and the state book makes that
 *  resumption free to compute. */
const DEFAULT_TIME_BUDGET_MS = 2000

/** Per-file call-id memory cap. Only needed so an incremental harvest can
 *  still recognise a tool/result whose tool/call was in an earlier round's
 *  bytes (results carry no tool name). A session with more live calls than
 *  this is re-harvested from the start of the file instead. */
const MAX_TRACKED_CALLS = 4096

/** Pseudo frame index for the header frame's overflow lines (single-frame logs). */
const SPILL_INDEX = -1

/** Byte-level needles for the frame-level pre-filter. Every entry is ASCII, so
 *  comparing raw bytes to a latin1 encoding of the needle is exactly a utf8
 *  substring search. Keep this list a SUPERSET of the strings that
 *  isHarvestCandidate and isSweepCandidate look for — a needle missing here
 *  means the frame is skipped entirely, i.e. silently not swept. */
const HARVEST_NEEDLES = ['"tool/', '"plugin:translator', '"job/', '"tool-call"']

/** Keys whose values are credentials, wherever they appear in a bitwarden_*
 *  event. Kept in sync (by hand) with SECRET_KEY in client.js — this list is
 *  for what the LOG may contain, which is a superset of what the panel masks:
 *  tool arguments (bitwarden_create password=…) and results (bitwarden_get
 *  {"password": …}) both flow through here. */
const SECRET_KEY_RE =
  /^(password|passphrase|totp|totpsecret|secret|number|code|securitycode|ssn|socialsecuritynumber|passportnumber|licensenumber|privatekey|notes|notesvalue|value|cardnumber|cvv|cvc|pin|apikeyclientsecret|apikey|token|accesstoken|refreshtoken|clientsecret|masterpassword|masterkey|encryptedkey|securenote)$/i

const PLACEHOLDER_SCAN = /\{\{BW_[A-Z]+_[a-z2-7]{8}\}\}/

const isSecretKey = (key) => SECRET_KEY_RE.test(String(key ?? '').replace(/[_-]/g, ''))

/** The marker class a credential key names, in lib/mask.js's vocabulary. Keys
 *  the map does not name fall back to the generic VALUE class. */
const KEY_KINDS = [
  [/^(?:password|passphrase|masterpassword)$/, 'password'],
  [/^totp(?:secret)?$/, 'totp'],
  [/^(?:notes|notesvalue)$/, 'notes'],
  [/^(?:cardnumber|number|securitycode|cvv|cvc|pin)$/, 'card'],
  [/^(?:ssn|passportnumber|licensenumber)$/, 'identity'],
  [/^privatekey$/, 'sshKey'],
  [/^securenote$/, 'secureNote'],
]

function kindOfKey(key) {
  const normalized = String(key ?? '').replace(/[_-]/g, '')
  for (const [pattern, kind] of KEY_KINDS) if (pattern.test(normalized)) return kind
  return 'value'
}

/** The marker one credential key redacts to. Kinded markers are what makes a
 *  sweep tellable from prose: the bare form the older sweeper wrote is byte-
 *  identical to this file quoting itself, which is how the trail ended up
 *  counting its own documentation as redactions. */
function markerForKey(key) {
  return redactionMarker(kindOfKey(key))
}

/** Any sweep marker form, old or new. A redacted value is final: a re-sweep
 *  must neither re-mark it (kind migration would rewrite settled logs) nor
 *  harvest it — the bare marker used to join the echo hunt as a "secret" and
 *  quote itself wherever it appeared. */
const REDACTED_ANY_RE = /^\[REDACTED:BW(?:_[A-Z]+)?\]$/

/** Where a sweep marker may legitimately sit: as the ENTIRE value of a
 *  credential-shaped key — directly, or inside embedded JSON, which is why
 *  the quotes may be escaped. The trail index imports this to count only
 *  real sweeps: a marker anywhere else is the plugin's own text being logged
 *  (tool descriptions, read-in sources, prose quoting the pattern), not a
 *  redaction. Key names allow [_-] separators, matching isSecretKey's
 *  normalisation; keep the list in sync with SECRET_KEY_RE. The echo pass
 *  (phase 3) rewrites mid-string and has no key position of its own — those
 *  rewrites are not covered here, and the trail deliberately counts only
 *  keyed markers. */
export const MARKER_KEYED_RE =
  /\\?"(?:password|pass[_-]?phrase|master[_-]?password|totp(?:[_-]?secret)?|security[_-]?code|card[_-]?number|passport[_-]?number|license[_-]?number|private[_-]?key|notes(?:[_-]?value)?|api[_-]?key(?:[_-]?client[_-]?secret)?|access[_-]?token|refresh[_-]?token|client[_-]?secret|master[_-]?key|encrypted[_-]?key|secure[_-]?note|cvv|cvc|ssn|number|code|notes|value|pin|secret)\\?"\s*:\s*\\?"\[REDACTED:BW(?:_[A-Z]+)?\]/i

/**
 * Recursively replace credential-shaped values in a parsed JSON structure.
 * Returns the number of replacements made (0 = leave the line untouched).
 *
 * `marker` is how one redacted value is written. Undefined — the default —
 * is the kind-aware form: each key names its marker class via kindOfKey. A
 * string (older callers, tests) is used verbatim for every key; a function
 * receives the key.
 */
export function redactValue(value, marker, depth = 0, collected) {
  let hits = 0
  if (depth > 12 || value === null || typeof value !== 'object') return 0
  const markerFor = typeof marker === 'function' ? marker : marker ? () => marker : markerForKey
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (typeof child === 'string') {
      // An already-redacted value is final: markers in either form and
      // {{BW_*}} placeholders must survive re-sweeps byte-identically
      // (idempotence).
      if (
        isSecretKey(key) &&
        child !== '' &&
        child !== markerFor(key) &&
        !REDACTED_ANY_RE.test(child) &&
        !PLACEHOLDER_SCAN.test(child) &&
        child !== '<hidden>'
      ) {
        // Record the plaintext for phase 3 (echo hunting) before it is
        // destroyed; a Map collector also learns the key's marker kind.
        // Generic values are skipped — sweeping every 'true' through
        // unrelated tool output would corrupt more than it hides.
        if (collected && worthCollecting(child)) {
          if (typeof collected.set === 'function') collected.set(child, kindOfKey(key))
          else collected.add(child)
        }
        value[key] = markerFor(key)
        hits += 1
      } else if (
        (key === 'arguments' || key === 'text' || key === 'content' || key === 'card' || key === 'identity' || key === 'sshKey' || key === 'secureNote' || key === 'fields') &&
        (child[0] === '{' || child[0] === '[')
      ) {
        // The string may EMBED JSON (tool arguments and tool results are
        // JSON-encoded strings). Judge by shape, not length — a minimal
        // {"password":…} result is 26 chars and slipped under an old 40-char
        // minimum. JSON.parse rejects prose cheaply, so try and fall through
        // unchanged when it is not JSON.
        hits += redactEmbedded(child, value, key, marker, collected)
      }
    } else if (typeof child === 'object') {
      hits += redactValue(child, marker, depth + 1, collected)
    }
  }
  return hits
}

/** Redact secrets inside a string that is itself JSON (tool arguments). */
function redactEmbedded(text, container, key, marker, collected) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return 0
  }
  if (parsed === null || typeof parsed !== 'object') return 0
  const hits = redactValue(parsed, marker, 1, collected)
  if (hits > 0) container[key] = JSON.stringify(parsed)
  return hits
}

/** Values too generic to hunt by content. */
const COMMON_VALUE_RE = /^(true|false|null|none|undefined|yes|no|ok|n\/a|unknown|redacted)$/i

/** A secret worth hunting by content through non-bitwarden tool events:
 * long enough (6+) to be unlikely prose or a common word, not a template placeholder (the host's
 * {{SECRET_*}} transport tags and mneme's {{PASSWORD_*}} are masks, not
 * secrets), not a boolean-ish word, and not a short digit string. */
function worthCollecting(value) {
  return (
    value.length >= 6 &&
    !value.startsWith('{{') &&
    !PLACEHOLDER_SCAN.test(value) &&
    !COMMON_VALUE_RE.test(value) &&
    !(/^\d+$/.test(value) && value.length < 6)
  )
}

/** String fields where an echoed secret can hide: tool arguments, result
 * text, shell output. Structural fields (names, ids, types) are deliberately
 * absent — replacing 'zstd' everywhere because a password happens to be
 * 'zstd' would shred the log. */
const ECHO_KEY_RE = /^(arguments|text|content|summary|stdout|stderr|output|result|input|command|code|prompt|body|function|script|expression|value|fields|old_string|new_string|spec|viewport|oldText|newText|label)$/i

/** Phase 3: replace occurrences of already-harvested secret values inside
 * text-bearing fields of any tool event. This is the echo channel the name
 * filter cannot see — in code mode the run_code aggregate tool/result quotes
 * its bitwarden sub-calls' output as free text. Substring replacement on the
 * parsed value: a secret containing JSON-escaped characters (quotes, control
 * chars) may slip past when embedded inside another JSON string — phase 2
 * already covers that case for bitwarden events proper. */
export function replaceKnownValues(value, secrets, marker, depth = 0) {
  let hits = 0
  if (depth > 12 || value === null || typeof value !== 'object') return 0
  // One marker per SECRET, not per field: the echo pass rewrites a value
  // wherever it reappears, and a Map of secrets carries the kind its source
  // key named. Undefined marker = kind-aware; a string (older callers, tests)
  // is used verbatim.
  const markerFor =
    typeof marker === 'function'
      ? marker
      : marker
        ? () => marker
        : (secret) => redactionMarker(secrets instanceof Map ? (secrets.get(secret) ?? 'value') : 'value')
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (typeof child === 'string') {
      if (ECHO_KEY_RE.test(key)) {
        let replaced = child
        // keys(), not entries: secrets may be a Map (plaintext -> kind) and the
        // echo pass must hunt the plaintext, not the pair. Set.keys() yields
        // values, so older callers are unaffected.
        for (const secret of secrets.keys()) {
          if (!replaced.includes(secret)) continue
          const parts = replaced.split(secret)
          hits += parts.length - 1
          replaced = parts.join(markerFor(secret))
        }
        if (replaced !== child) value[key] = replaced
      }
      // An ECHO field can itself embed JSON (a code-dispatch 'arguments'
      // string holding nested arguments whose keys are not echo keys, or a
      // text quoting a tool result). Descend into it the same way phase 2
      // does, rewriting the serialized form on hit.
      if (hits === 0 && (child.startsWith('{') || child.startsWith('['))) {
        let parsed
        try { parsed = JSON.parse(child) } catch { parsed = null }
        if (parsed !== null && typeof parsed === 'object') {
          const inner = replaceKnownValues(parsed, secrets, marker, depth + 1)
          if (inner > 0) { value[key] = JSON.stringify(parsed); hits += inner }
        }
      }
    } else if (typeof child === 'object') {
      hits += replaceKnownValues(child, secrets, marker, depth + 1)
    }
  }
  return hits
}
/** True when the event belongs to a bitwarden_* tool. A tool/result line
 *  carries only the callId (no tool name), so the caller must first learn
 *  the bitwarden callIds from the tool/call lines of the same log. PTC
 *  events carry the tool name themselves: in code/PTC mode the host routes
 *  tool arguments through tool/ptc-dispatch-start and results through
 *  tool/ptc-dispatch (content[].text embeds the result JSON) — tool/call
 *  and tool/result stay empty, so the classic path alone never saw these
 *  lines. */
function isBwToolEvent(event, bwCalls) {
  const type = event?.type
  const name = event?.data?.name
  const isBwCall = type === 'tool/call' && typeof name === 'string' && name.startsWith('bitwarden_')
  const isBwResult = type === 'tool/result' && bwCalls.has(event?.data?.message?.toolCallId)
  const isBwPtc = (type === 'tool/ptc-dispatch' || type === 'tool/ptc-dispatch-start') && typeof name === 'string' && name.startsWith('bitwarden_')
  // Code mode uses the same dispatch shape under a different event name.
  const isBwCode =
    (type === 'tool/code-dispatch' || type === 'tool/code-dispatch-start') && typeof name === 'string' && name.startsWith('bitwarden_')
  return isBwCall || isBwResult || isBwPtc || isBwCode
}

/** Event types whose tool payload the sweep is willing to touch. Structural
 *  state (session header, user/assistant prose) is never rewritten. */
const CANDIDATE_TYPES = new Set([
  'tool/call',
  'tool/result',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/code-dispatch',
  'tool/code-dispatch-start',
  'plugin:translator/request',
  'plugin:translator/result',
  'job/registered',
  'job/settled',
])

/** Fast pre-filter: most lines are prose and contain none of these. */
// Note the missing closing quote on the dispatch names: the events come in
// pairs, tool/ptc-dispatch AND tool/ptc-dispatch-start (same for code-dispatch),
// and '"tool/ptc-dispatch"' with its quote does not match the -start variant.
// Getting this wrong leaves every dispatch-start line unswept — which is where
// the tool ARGUMENTS live in code/PTC mode.
const isHarvestCandidate = (line) =>
  line.includes('"tool/call"') || line.includes('"tool/result"') || line.includes('"tool/ptc-dispatch') || line.includes('"tool/code-dispatch')

const isSweepCandidate = (line) => isHarvestCandidate(line) || line.includes('"plugin:translator') || line.includes('"job/')

/** Split decompressed frame text into lines, dropping only the trailing
 *  empty segment a final newline produces. */
function splitLines(text) {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Count lines in a frame's plaintext, judged on BYTES.
 *
 *  Used for the header-frame check, which must not cost a string: frame 0 of a
 *  118 MB single-frame log would otherwise be converted to UTF-8 just to learn
 *  whether it holds one line.
 */
function countTextLines(bytes) {
  let newlines = 0
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) newlines += 1
  return bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? newlines + 1 : newlines
}

/** Rejoin lines mutated in place, preserving exactly whether the chunk ended
 *  with a newline. Every frame the host writes does; a decoded copy may not. */
function rejoinText(original, lines) {
  const body = lines.join('\n')
  return original.endsWith('\n') ? body + '\n' : body
}

/** Phase 1: learn the bitwarden_* callIds in lines and harvest the plaintext
 *  values their events carry into 'into'. Harvesting parses throwaway copies —
 *  it never mutates the caller's data. */
function harvestLines(lines, marker, into, bwCalls) {
  for (const line of lines) {
    if (!line || !isHarvestCandidate(line)) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // a torn line is not ours to judge
      continue
    }
    if (event?.type === 'tool/call' && typeof event?.data?.name === 'string' && event.data.name.startsWith('bitwarden_')) {
      bwCalls.add(event.data.callId)
    }
    if (isBwToolEvent(event, bwCalls)) redactValue(event.data, marker, 0, into)
  }
}

/** Public form of phase 1, kept for callers that already hold the lines. */
export function collectSecrets(lines, marker, into = new Set()) {
  const bwCalls = new Set()
  harvestLines(lines, marker, into, bwCalls)
  return { bwCalls, secrets: into }
}

/** Phases 2+3 in place over one frame's lines. Records the arguments every
 *  tool/call ended up with, so phase 4 can make the advertised copy agree. */
function sweepLines(lines, bwCalls, secrets, marker, settledArgs, changedCalls, from = 0, to = lines.length) {
  let hits = 0
  for (let i = from; i < to; i++) {
    const line = lines[i]
    if (!line || !isSweepCandidate(line)) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!CANDIDATE_TYPES.has(event?.type)) continue
    let local = 0
    if (isBwToolEvent(event, bwCalls)) local += redactValue(event.data, marker)
    if (secrets.size > 0) local += replaceKnownValues(event.data, secrets, marker)
    if (event.type === 'tool/call' && typeof event.data?.callId === 'string') {
      // Recorded even when nothing changed: a log swept by an older version
      // may still carry two disagreeing copies of a call, and phase 4 is the
      // repair path for exactly that.
      settledArgs.set(event.data.callId, event.data.arguments)
      // Only a call whose arguments this run actually rewrote can have been
      // left disagreeing with its advertised copy, so only those need the
      // phase-4 search. This is what keeps a steady-state round from parsing
      // every assistant message in the log.
      if (local > 0 && changedCalls) changedCalls.add(event.data.callId)
    }
    if (local > 0) {
      lines[i] = JSON.stringify(event)
      hits += local
    }
  }
  return hits
}

/** Long logs must not own the event loop.
 *
 *  The plugin runs on the HOST MAIN THREAD, so every millisecond spent in a
 *  JSON.parse or a JSON.stringify is a millisecond the UI cannot paint. A
 *  single session log can hold one 118 MB frame; parsing its 7000 candidate
 *  lines in one go blocks for over a second, which reads as a hitch. Working in
 *  batches and handing the loop back between them keeps the same total CPU but
 *  bounds each uninterrupted stretch, so the host stays responsive while the
 *  backlog drains.
 *
 *  2 MB, not more: the worst uninterrupted stretch is one chunk's conversion
 *  plus its parse, and measured on the largest log a 2 MB chunk keeps every
 *  stretch under ~120 ms while 4 MB lets it reach ~210 ms. Smaller than 2 MB
 *  buys nothing — the remaining cost is per-frame decompression, not the walk —
 *  and only multiplies the number of setImmediate hops.
 */
const BYTE_CHUNK = 2 * 1024 * 1024
const yieldToHost = () => new Promise((resolve) => setImmediate(resolve))

/** Cut a decoded frame into newline-aligned [start, end) ranges.
 *
 *  Why chunk at all: turning a Buffer into a JS string is the most expensive
 *  SYNCHRONOUS step in a sweep — measured 641 ms for the corpus's largest frame
 *  (118 MB of plaintext) — and once started it cannot be interrupted. Cutting
 *  the BYTES first keeps every conversion small. 0x0A never occurs inside a
 *  multi-byte UTF-8 sequence, so a cut at a newline can never split a
 *  character, and every chunk therefore holds whole lines.
 */
function* chunkRanges(bytes) {
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(start + BYTE_CHUNK, bytes.length)
    if (end < bytes.length) {
      const newline = bytes.indexOf(10, end)
      end = newline === -1 ? bytes.length : newline + 1
    }
    yield [start, end]
    start = end
  }
}

/** Walk the chunks of a frame, handing the event loop back between them. */
async function forEachChunk(bytes, visit) {
  let remaining = false
  for (const range of chunkRanges(bytes)) {
    if (remaining) await yieldToHost()
    await visit(range[0], range[1])
    remaining = true
  }
}

/** Rebuild a frame's plaintext with some chunks replaced.
 *
 *  Works on bytes end to end: replaced chunks are encoded, everything else is
 *  a subarray of the original, so rewriting a 118 MB frame that changed in one
 *  place never materializes a second 118 MB string.
 */
function materialiseFrame(bytes, replaced) {
  if (!replaced || replaced.size === 0) return bytes
  const parts = []
  for (const [start, end] of chunkRanges(bytes)) {
    const text = replaced.get(start)
    parts.push(text === undefined ? bytes.subarray(start, end) : Buffer.from(text, 'utf8'))
  }
  return Buffer.concat(parts)
}

/** List session log files under the sessions root (all directories, all
 *  versions), newest first. */
export function listSessionLogs(sessionsRoot) {
  if (!existsSync(sessionsRoot)) return []
  const logPaths = []
  let incomplete = false
  const readdirSoft = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
    } catch {
      // A directory can vanish between readdir calls, or be unreadable
      // temporarily. Skipping it must not make the caller prune every record
      // it held from that subtree.
      incomplete = true
      return []
    }
  }
  for (const workspace of readdirSoft(sessionsRoot)) {
    if (!workspace.isDirectory()) continue
    for (const session of readdirSoft(join(sessionsRoot, workspace.name))) {
      if (!session.isDirectory()) continue
      const dir = join(sessionsRoot, workspace.name, session.name)
      // Every version in every directory: superseded logs (v3 beside v4) and
      // lockless exports (directories without the session- prefix) hold the
      // same plaintext the current log does — a session-* prefix filter left
      // 68 real directories permanently unswept.
      let files
      try {
        files = readdirSync(dir)
      } catch {
        incomplete = true
        continue
      }
      for (const file of files) {
        if (/^session\.v\d+\.jsonl\.zstd$/.test(file)) logPaths.push(join(dir, file))
      }
    }
  }
  // One stat per file instead of one per comparison: the sort key is fetched
  // once and reused.
  const stamped = logPaths.map((path) => {
    try {
      return { path, mtimeMs: statSync(path).mtimeMs }
    } catch {
      return { path, mtimeMs: 0 }
    }
  })
  const result = stamped.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.path)
  // Array with a side-channel flag: existing callers keep using length/map;
  // trail uses it to avoid pruning records whose directories were unreadable.
  result.incomplete = incomplete
  return result
}

/**
 * Conservative liveness test for one session directory: a log is idle only
 * when its lock file has not been touched for idleSeconds AND the log
 * itself has not grown in that window. The host holds the lock open for the
 * lifetime of the session and touches it as turns run, so a fresh lock mtime
 * means the session may still append.
 */
export function isIdle(logPath, { idleSeconds = DEFAULT_IDLE_SECONDS, now = Date.now } = {}) {
  const lockPath = join(logPath, '..', 'session.lock')
  try {
    const lockStat = statSync(lockPath)
    const logStat = statSync(logPath)
    const cutoff = now() - idleSeconds * 1000
    return lockStat.mtimeMs < cutoff && logStat.mtimeMs < cutoff
  } catch {
    // No lock file at all (an exported/copy log) — nothing is appending.
    return true
  }
}
/**
 * Read, sweep and (only if something changed) rewrite one log.
 *
 * Frames are handled one at a time so memory stays proportional to the largest
 * single frame rather than to the whole log, and unchanged frames are copied
 * verbatim — which is what keeps the host's first-frame-is-the-header
 * invariant intact without recompressing anything that did not change.
 */
async function processLog(logPath, options = {}) {
  // Undefined = the kind-aware marker each credential key resolves to; a
  // string or function override (tests, older callers) passes through.
  const marker = options.marker
  let before
  try {
    before = statSync(logPath)
  } catch (error) {
    return { status: 'error', error: String(error?.message ?? error), redacted: 0 }
  }
  let buffer
  try {
    buffer = readFileSync(logPath)
  } catch (error) {
    return { status: 'error', error: String(error?.message ?? error), redacted: 0 }
  }
  let frames
  let tornStart
  try {
    ;({ frames, tornStart } = scanZstdFrames(buffer))
  } catch (error) {
    // An undecodable frame table means frames cannot be delimited safely;
    // leave the bytes alone and report — a wrong guess here is data loss.
    return { status: 'error', error: 'zstd 帧结构损坏：' + String(error?.message ?? error), redacted: 0 }
  }
  if (frames.length === 0) return { status: 'error', error: 'empty or header-less Zstandard session log', redacted: 0 }

  const frameSlice = (index) => buffer.subarray(frames[index].start, frames[index].end)

  // ── the header frame ─────────────────────────────────────────────────
  // readFirstZstdLine + assertZstdHeaderFrame require the FIRST frame to hold
  // exactly one line. A file written by an old (single-frame) writer violates
  // that; normalising it here is what lets those logs load again.
  let frameZeroBytes
  let decodedBytes = 0
  try {
    // Decoded through the buffer path so the header's bytes are COUNTED. A log
    // written as a single frame keeps everything except line 0 in this frame,
    // and leaving it out of the tally made such a log cost zero budget forever
    // — a corpus of them could never exhaust a round, so the chained catch-up
    // would spin without ever reporting progress.
    frameZeroBytes = await decodeFrameBuffer(frameSlice(0))
    decodedBytes += frameZeroBytes.length
  } catch (error) {
    return { status: 'error', error: 'header 帧解压失败：' + String(error?.message ?? error), redacted: 0 }
  }
  const layoutValid = countTextLines(frameZeroBytes) === 1
  const bodyIndexes = []
  for (let i = 1; i < frames.length; i++) bodyIndexes.push(i)

  // Frame 0 is treated as sweepable content, not as an untouchable header.
  // Two real shapes need that:
  //  - a log written as ONE frame (older writer, or an export) keeps every
  //    event in frame 0's tail;
  //  - an exported/embedded log may not carry a session header at all, so its
  //    first line is an ordinary event.
  // Sweeping line 0 is harmless for a real header: its keys (type, version, id,
  // startedAt) match neither the secret-key nor the echo-key patterns.
  // Reassembly still emits line 0 alone in frame 0, which is exactly what the
  // host's readFirstZstdLine + assertZstdHeaderFrame require.

  // ── phase 1: decode every frame ONCE, chunk by chunk ─────────────────
  // Each frame is decompressed a single time and kept as BYTES. A frame with
  // no tool, translator or job event in it is dropped without ever becoming a
  // JS string — which is the point: on the corpus's largest frame, converting
  // to a string costs ~640 ms of uninterrupted main-thread time and parsing
  // the result another ~700 ms, while a byte-level miss costs far less and a
  // hit is found in a fraction of a millisecond. Frames that stay are walked
  // in newline-aligned chunks, so a 118 MB frame becomes ~30 short steps
  // instead of one long one.
  // plaintext -> the marker kind its source key named, so the echo pass can
  // write the same class it harvested. Seed values from earlier rounds arrive
  // as bare strings and take the generic class.
  const secrets = new Map()
  const bwCalls = new Set()
  /** frame index -> { bytes, replaced: Map<chunkStart, text> } */
  const live = new Map()

  const stageFrame = async (index, bytes) => {
    if (!bufferHasAny(bytes, HARVEST_NEEDLES)) return
    await forEachChunk(bytes, (start, end) => {
      harvestLines(splitLines(bytes.toString('utf8', start, end)), marker, secrets, bwCalls)
    })
    live.set(index, { bytes, replaced: new Map() })
  }

  await stageFrame(SPILL_INDEX, frameZeroBytes)
  for (const index of bodyIndexes) {
    let bytes
    try {
      bytes = await decodeFrameBuffer(frameSlice(index))
    } catch (error) {
      return { status: 'error', error: 'body 帧解压失败：' + String(error?.message ?? error), redacted: 0 }
    }
    decodedBytes += bytes.length
    await stageFrame(index, bytes)
  }
  if (options.knownSecrets) {
    for (const value of options.knownSecrets) if (!secrets.has(value)) secrets.set(value, 'value')
  }
  const harvested = [...secrets.keys()]

  // ── phases 2+3: redact, chunk by chunk ───────────────────────────────
  const settledArgs = new Map()
  /** callIds whose arguments this run rewrote: the only ones that can still
   *  disagree with their advertised copy in an assistant message. */
  const changedCalls = new Set()
  /** Where the chunks holding a tool-call block live, so phase 4 can go
   *  straight to them. Only the POSITION is kept, never the text: on a long
   *  session the assistant messages are ~100 MB of a 118 MB frame, and holding
   *  those strings alive across the phases turned into multi-hundred-
   *  millisecond garbage collections — longer than the conversions the chunk
   *  walk exists to bound. Phase 4 re-decodes the few chunks it must. */
  const callChunks = []
  let redacted = 0
  for (const [index, frame] of live) {
    await forEachChunk(frame.bytes, (start, end) => {
      const original = frame.bytes.toString('utf8', start, end)
      const lines = splitLines(original)
      const local = sweepLines(lines, bwCalls, secrets, marker, settledArgs, changedCalls)
      if (local > 0) {
        frame.replaced.set(start, rejoinText(original, lines))
        redacted += local
      }
      if (original.includes('"tool-call"')) callChunks.push({ index, start, end })
    })
  }

  // ── phase 4: keep the assistant/message copy of every tool call in sync ──
  //
  // The host writes a call's arguments TWICE: once in the assistant message's
  // tool-call content block and once in the dedicated tool/call event. On
  // load, dsh-session-format-v3-to-v4 replays both and requires
  //
  //     pending.name === data.name && pending.arguments === data.arguments
  //
  // as a strict string comparison, throwing otherwise:
  //   SessionFormatError: tool/call <id> does not match one advertised tool call
  // and the whole session becomes unreadable ('stored log is corrupt').
  //
  // A call is advertised BEFORE it is made, so this pass necessarily runs
  // after phases 2+3 have settled what the tool/call event ended up saying.
  // Only the argument STRING is replaced, with the exact string already
  // written into tool/call, so the pair agrees by construction; rewriting it
  // is safe for replay because the byte-exact requirement the file header
  // warns about applies to thinkingSignature, not to arguments.
  //
  // A full sweep (bitwarden_sweep) also repairs logs written by older versions,
  // whose two copies may disagree even though this run changed nothing. A
  // routine round only has to look when it rewrote a call itself — and that is
  // the difference between parsing every assistant message in a 118 MB frame
  // and parsing none of them, because assistant prose dominates a long
  // session's bytes while being irrelevant to the sweep.
  const targeted = options.full ? settledArgs : changedCalls
  if (targeted.size > 0) {
    let stepped = false
    for (const { index, start, end } of callChunks) {
      const frame = live.get(index)
      if (frame === undefined) continue
      // Hand the loop back between chunks: a full sweep walks every assistant
      // message in the log, and without this the whole pass ran as one
      // uninterrupted stretch (measured 1141 ms on the largest log).
      if (stepped) await yieldToHost()
      stepped = true
      // Re-decoded here rather than carried across the phases: keeping ~100 MB
      // of assistant-message strings alive between phases cost more in garbage
      // collection than this conversion does.
      const text = frame.replaced.get(start) ?? frame.bytes.toString('utf8', start, end)
      const lines = splitLines(text)
      let fixes = 0
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line || !line.includes('"tool-call"')) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event?.type !== 'assistant/message') continue
        const content = event?.data?.message?.content
        if (!Array.isArray(content)) continue
        let local = 0
        for (const block of content) {
          if (block?.type !== 'tool-call' || typeof block.id !== 'string') continue
          if (!targeted.has(block.id)) continue
          const settled = settledArgs.get(block.id)
          if (block.arguments === settled) continue
          block.arguments = settled
          local += 1
        }
        if (local > 0) {
          lines[i] = JSON.stringify(event)
          fixes += local
        }
      }
      if (fixes > 0) {
        frame.replaced.set(start, rejoinText(text, lines))
        redacted += fixes
      }
    }
  }

  // ── rebuild only if something actually changed ───────────────────────
  const changedFrames = new Map()
  for (const [index, frame] of live) if (frame.replaced.size > 0) changedFrames.set(index, frame)
  const needsRebuild = changedFrames.size > 0 || !layoutValid
  // A rebuild with no replacement at all is a pure layout repair: the log was
  // one big frame (an older writer, or an export) and is being re-laid as
  // header-frame + body-frame, which is the shape the host's reader requires.
  // Worth doing — and worth reporting separately from actual redaction, so a
  // "redacted" count always means plaintext was destroyed.
  const layoutRepairOnly = changedFrames.size === 0 && !layoutValid
  if (!needsRebuild) {
    // Nothing changed: the file is not touched at all (no write, no utimes),
    // so its mtime stays the signal the next round compares against.
    return { status: 'clean', redacted: 0, harvested, bytes: decodedBytes, size: before.size, mtimeMs: before.mtimeMs, ino: before.ino }
  }

  const chunks = []
  // Frame 0 must end up holding exactly one line. When it already has the
  // right shape and nothing in it changed, its BYTES are reused untouched —
  // that alone guarantees the host's 'first frame is exactly one header line'
  // check keeps passing, without recompressing anything.
  const sweptFrameZero = changedFrames.get(SPILL_INDEX)
  if (layoutValid && sweptFrameZero === undefined) {
    chunks.push(frameSlice(0))
  } else {
    const plain = sweptFrameZero === undefined
      ? frameZeroBytes
      : materialiseFrame(sweptFrameZero.bytes, sweptFrameZero.replaced)
    const cut = plain.indexOf(10)
    // No newline at all: a degenerate one-line log. Emit it as a single header
    // frame with the newline the host's reader expects.
    const header = cut === -1 ? Buffer.concat([plain, Buffer.from(LF, 'utf8')]) : plain.subarray(0, cut + 1)
    chunks.push(await encodeFrame(header))
    const rest = cut === -1 ? undefined : (cut + 1 < plain.length ? plain.subarray(cut + 1) : undefined)
    if (rest !== undefined && rest.length > 0) chunks.push(await encodeFrame(rest))
  }
  for (const index of bodyIndexes) {
    const frame = changedFrames.get(index)
    if (frame === undefined) chunks.push(frameSlice(index))
    else chunks.push(await encodeFrame(materialiseFrame(frame.bytes, frame.replaced)))
  }
  // A crash tail is not ours to judge: copy those bytes through verbatim so a
  // sweep never truncates an event the host may still be able to recover.
  if (tornStart !== undefined) chunks.push(buffer.subarray(tornStart))
  const encoded = Buffer.concat(chunks)

  // The idle check is only a hint: a session can resume between it and the
  // rewrite. Re-stat immediately before replacing the path and abandon this
  // round if any byte or inode changed — otherwise the atomic rename would
  // drop an append the host made while we were decoding the old file.
  let beforeWrite
  try {
    beforeWrite = statSync(logPath)
  } catch (error) {
    return { status: 'error', error: String(error?.message ?? error), redacted: 0 }
  }
  if (beforeWrite.ino !== before.ino || beforeWrite.size !== before.size || beforeWrite.mtimeMs !== before.mtimeMs) {
    return { status: 'busy', redacted: 0, bytes: decodedBytes, harvested }
  }
  try {
    // Preserve the original permission bits and timestamps: the host created
    // the log, and a sweep must not widen what it already allows — nor reset
    // its mtime, which is the idle signal the next sweep relies on.
    writeFilePrivate(logPath, encoded, { mode: before.mode & 0o777 })
    utimesSync(logPath, before.atime, before.mtime)
  } catch (error) {
    return { status: 'error', error: String(error?.message ?? error), redacted: 0 }
  }
  // Record the BYTES WE WROTE, not a post-write stat: a host append that lands
  // after the rename would make a post-write size look processed when only the
  // prefix was. The next round sees the larger file and reads its tail.
  let ino = before.ino
  try {
    ino = statSync(logPath).ino
  } catch {
    /* keep the pre-write inode; the next round re-stats anyway */
  }
  return {
    status: redacted > 0 ? 'redacted' : 'normalised',
    redacted,
    harvested,
    bytes: decodedBytes,
    size: encoded.length,
    mtimeMs: before.mtimeMs,
    ino,
  }
}

/**
 * Sweep one log file completely. Returns a report; never throws (a log that
 * cannot be read is reported and skipped, not fatal for the batch).
 *
 * @param {string} logPath path to session.v*.jsonl.zstd
 * @param {{marker?: string | ((key: string) => string), idleSeconds?: number, now?: () => number, skipIdleCheck?: boolean, knownSecrets?: Iterable<string>}} [options]
 */
export async function sweepLog(logPath, options = {}) {
  if (!options.skipIdleCheck && !isIdle(logPath, options)) return { path: logPath, status: 'busy', redacted: 0 }
  const result = await processLog(logPath, options)
  return { path: logPath, ...result }
}
/**
 * Cross-round seed store: values already swept out of the logs. Once a
 * source log is redacted the plaintext exists nowhere on disk, so a later
 * sweep cannot re-learn it — yet a log that was busy during that sweep
 * (this session's own log, typically) may still echo it. Persisting the
 * seeds keeps the hunt alive across rounds.
 *
 * Entries expire: each value carries the moment it was last harvested and is
 * dropped once that is SEED_TTL_DAYS old. The hunt window is "a log that was
 * busy during the sweep", i.e. hours to days; a value kept for months is no
 * longer useful and turns the file into a second, unencrypted password store.
 * v1 files (a bare list) age by their own mtime and are rewritten as v2.
 */
export function seedStorePath() {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  return join(home, 'data', 'dsh-vaultwarden', 'swept-secrets.json')
}

/** Per-file incremental state, beside the seed store. */
export function stateStorePath() {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  return join(home, 'data', 'dsh-vaultwarden', 'sweep-state.json')
}

/** How long a harvested value stays in the echo-hunt seed store. */
const SEED_TTL_DAYS = 30
const SEED_TTL_MS = SEED_TTL_DAYS * 24 * 60 * 60 * 1000
/** Hard cap, so a pathological corpus cannot grow the file without bound. */
const MAX_SEEDS = 4096

/**
 * Read the seed store. Values are `{ v, at }` — the moment the value was last
 * harvested. A v1 file (a bare list of strings, written by older builds) has
 * no timestamps of its own, so its own mtime is the best available age.
 *
 * Expired entries are dropped on the way in. A seed exists only so a later
 * sweep can recognise the same plaintext in a log that was busy when it was
 * first seen, and that window is days, not months: keeping every secret ever
 * swept forever made this file a second, unencrypted password store.
 */
function loadSeedSeeds(path, now = Date.now()) {
  let values = []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(parsed?.values)) {
      if (parsed.version === 2 || (parsed.values.length > 0 && typeof parsed.values[0] === 'object')) {
        values = parsed.values
          .filter((entry) => entry && typeof entry.v === 'string' && Number.isFinite(entry.at))
          .map((entry) => [entry.v, entry.at])
      } else {
        // v1: a bare list. The file's mtime is when it was last written, which
        // is the closest thing to "last refreshed" it carries.
        let at = now
        try {
          at = statSync(path).mtimeMs
        } catch {
          // unreadable stat — treat as just refreshed rather than expired
        }
        values = parsed.values.filter((v) => typeof v === 'string').map((v) => [v, at])
      }
    }
  } catch {
    // absent or unreadable — start empty
  }
  return pruneSeeds(new Map(values), now)
}

/** Drop expired seeds and, if still over the cap, the oldest ones. */
function pruneSeeds(seeds, now) {
  const cutoff = now - SEED_TTL_MS
  for (const [value, at] of seeds) if (!(at >= cutoff)) seeds.delete(value)
  if (seeds.size > MAX_SEEDS) {
    const oldest = [...seeds.entries()].sort((left, right) => left[1] - right[1])
    for (const entry of oldest.slice(0, seeds.size - MAX_SEEDS)) seeds.delete(entry[0])
  }
  return seeds
}

function saveSeedSeeds(path, seeds) {
  try {
    ensurePrivateDir(dirname(path))
    // Atomic + private: mode on a pre-existing file is not a permission change,
    // and a crash mid-write must not leave a truncated seed list behind.
    const values = [...seeds.entries()]
      .sort((left, right) => left[1] - right[1])
      .map(([v, at]) => ({ v, at }))
    writeFilePrivate(path, JSON.stringify({ version: 2, values }, null, 0) + String.fromCharCode(10), { mode: 0o600 })
  } catch {
    // best effort — the in-round hunt still works without persistence
  }
}

function loadState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version === 1 && parsed.files && typeof parsed.files === 'object') return parsed
  } catch {
    // A missing or unreadable state file just means every log looks new; the
    // round is then a full sweep, which is the safe direction to fail in.
  }
  return { version: 1, files: {} }
}

function saveState(path, state) {
  try {
    ensurePrivateDir(dirname(path))
    writeFilePrivate(path, JSON.stringify(state) + String.fromCharCode(10), { mode: 0o600 })
  } catch {
    // best effort — losing the state costs one full sweep, never correctness
  }
}

/**
 * Harvest the plaintext values carried by frames appended since start.
 * Read-only: nothing in this path writes to the log.
 *
 * @returns {Promise<{offset: number, bytes: number, calls: string[]}>} the byte
 *   offset through which frames have been harvested (never past a torn tail),
 *   the decoded byte count, and the live call ids to carry into the next round.
 */
async function harvestRange(logPath, start, end, marker, into, carryCalls) {
  const buffer = readRange(logPath, start, end)
  if (buffer.length === 0) return { offset: start, bytes: 0, calls: carryCalls }
  let frames
  try {
    ;({ frames } = scanZstdFrames(buffer))
  } catch {
    // Cannot delimit frames: do not advance, and retry next round.
    return { offset: start, bytes: 0, calls: carryCalls }
  }
  const bwCalls = new Set(carryCalls)
  let offset = start
  let bytes = 0
  for (const frame of frames) {
    let plain
    try {
      plain = await decodeFrameBuffer(buffer.subarray(frame.start, frame.end))
    } catch {
      break
    }
    bytes += plain.length
    // Same byte-level pre-filter as the sweep path: a frame with no candidate
    // event never becomes a string here either. What passes is walked in
    // newline-aligned chunks, so one huge frame cannot own the event loop.
    if (bufferHasAny(plain, HARVEST_NEEDLES)) {
      await forEachChunk(plain, (chunkStart, chunkEnd) => {
        harvestLines(splitLines(plain.toString('utf8', chunkStart, chunkEnd)), marker, into, bwCalls)
      })
    }
    offset = start + frame.end
  }
  return { offset, bytes, calls: [...bwCalls] }
}

/** Serialize sweep runs: the periodic timer and the manual tool must never
 *  read and rewrite the same log at the same time. */
let sweepChain = Promise.resolve()

export function sweepAll(sessionsRoot, options = {}) {
  const run = sweepChain.then(
    () => sweepAllRun(sessionsRoot, options),
    () => sweepAllRun(sessionsRoot, options),
  )
  sweepChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Sweep every idle session log under the root, incrementally.
 *
 * Two passes, because a value revealed in session A is routinely echoed by
 * bash in session B — a per-log hunt is blind to that:
 *   pass 1 harvests the values carried by every log's NEW bytes. Read-only, and
 *          it covers busy logs too: their bytes cannot be rewritten yet, but a
 *          value revealed there is echoed by idle logs;
 *   pass 2 rewrites each idle log that is not settled against that union.
 *
 * Pass 1 must finish before pass 2 rewrites anything, and a round whose harvest
 * the budget cut short rewrites NOTHING. A log rewritten with a union that is
 * missing a value revealed a moment earlier would keep that value's echo, and
 * being unchanged afterwards it would never be reconsidered. Deferring costs
 * one round; the harvest offsets make the next round resume for free.
 *
 * Paying for that ordering is cheap: pass 1 reads only the bytes past each
 * log's harvest offset, which in steady state is the growth of a handful of
 * sessions rather than the corpus.
 *
 * The same invariant is why the settled test is only "unchanged since a sweep
 * that saw the complete union". Comparing against the SIZE of the union looks
 * safer but is wrong in the expensive direction: a value can only be echoed by
 * bytes written after it was learned, so a new value invalidates logs that
 * changed, never every log that merely happens to be older.
 */
async function sweepAllRun(sessionsRoot, options = {}) {
  const marker = options.marker
  const logs = listSessionLogs(sessionsRoot)
  const report = { scanned: logs.length, redactedFiles: 0, redactedValues: 0, normalised: 0, busy: 0, unchanged: 0, harvested: 0, pending: 0, errors: [], bytes: 0 }
  const budget = options.full ? Number.POSITIVE_INFINITY : (options.byteBudget ?? DEFAULT_BYTE_BUDGET)
  const deadline = options.full
    ? Number.POSITIVE_INFINITY
    : Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS)
  const statePath = options.statePath ?? stateStorePath()
  const persistState = options.persistState ?? true
  const previous = loadState(statePath)
  const next = { version: 1, files: {} }
  // Cross-round seeds: values swept in earlier rounds whose source logs are
  // now redacted (phase 1 cannot re-harvest them) but whose echoes may still
  // surface in logs that were busy back then.
  const seedPath = options.seedPath ?? seedStorePath()
  // Value -> when it was last harvested. The timestamp is what the TTL runs on;
  // a Set of bare strings had no way to age anything out.
  const roundAt = Date.now()
  const known = loadSeedSeeds(seedPath, roundAt)
  let spent = 0
  /** True once either budget is exhausted: the remaining logs are left for the
   *  next round, which resumes them from the state book at no extra cost. */
  const outOfBudget = () => spent >= budget || Date.now() >= deadline

  // ── pass 1: harvest every log's new bytes ────────────────────────────
  const idle = []
  let harvestPending = 0
  let harvestFailed = 0
  for (const logPath of logs) {
    let current
    try {
      current = statSync(logPath)
    } catch {
      // Vanished between the listing and the stat: drop its record.
      continue
    }
    const prior = previous.files[logPath]
    const same = prior && prior.ino === current.ino
    const record = {
      ino: current.ino,
      size: current.size,
      mtimeMs: current.mtimeMs,
      harvested: same ? prior.harvested ?? 0 : 0,
      calls: same && Array.isArray(prior.calls) ? prior.calls : [],
      swept: same ? prior.swept ?? -1 : -1,
      sweptMtimeMs: same ? prior.sweptMtimeMs ?? -1 : -1,
      // Whether the last rewrite of this log ran against a COMPLETE union. A
      // sweep made while another log's harvest was still pending is not final:
      // the value it was missing may already be echoed here. Absent (a state
      // file from an older build) reads as false, so such a log is re-swept
      // once and then settles.
      trusted: same ? prior.trusted === true : false,
    }
    next.files[logPath] = record
    // A truncated or replaced log cannot be trusted to keep its offsets.
    if (!(record.harvested >= 0) || record.harvested > current.size) record.harvested = 0
    if (options.skipIdleCheck || !isIdle(logPath, options)) {
      report.busy += 1
    } else {
      // Priority 0: its bytes changed, so it needs a real harvest+sweep and
      // may contribute new values. Priority 1: unchanged, but its last sweep
      // predates the complete union. Doing every priority-0 log first keeps
      // union growth at the front of the round.
      const dirty =
        record.swept !== current.size ||
        record.sweptMtimeMs !== current.mtimeMs ||
        record.swept < 0
      idle.push({ logPath, priority: dirty ? 0 : 1 })
    }
    if (record.harvested >= current.size) continue
    if (outOfBudget()) {
      harvestPending += 1
      report.pending += 1
      continue
    }
    const harvestedNow = new Set()
    const harvested = await harvestRange(logPath, record.harvested, current.size, marker, harvestedNow, record.calls)
    // Fresh values enter the union stamped with this round's time; a value
    // seen again refreshes its stamp, which is what keeps a still-relevant
    // seed alive for another TTL.
    for (const value of harvestedNow) known.set(value, roundAt)
    spent += harvested.bytes
    report.bytes += harvested.bytes
    if (harvested.offset <= record.harvested) {
      // Frames could not be delimited (a write is in flight). Nothing read is
      // nothing lost: the bytes stay unharvested and are retried next round.
      harvestFailed += 1
      continue
    }
    record.harvested = harvested.offset
    // Too many live calls to remember across rounds: re-harvest from the top
    // next time so no tool/result loses its callId.
    if (harvested.calls.length > MAX_TRACKED_CALLS) {
      record.harvested = 0
      record.calls = []
    } else {
      record.calls = harvested.calls
    }
  }

  // ── pass 2: rewrite the idle logs against the complete union ──────────
  // Sweeping on a partial union is the one ordering that silently keeps a
  // secret's echo, so a short harvest defers the sweep of the whole round.
  const unionAtSweep = known.size
  const rewritten = []
  if (harvestPending === 0) {
    idle.sort((a, b) => a.priority - b.priority)
    for (const { logPath } of idle) {
      const record = next.files[logPath]
      if (!record) continue
      const settled =
        !options.full &&
        record.trusted === true &&
        record.swept === record.size &&
        record.sweptMtimeMs === record.mtimeMs
      if (settled) {
        report.unchanged += 1
        continue
      }
      if (outOfBudget()) {
        report.pending += 1
        continue
      }
      const result = await processLog(logPath, { ...options, marker, knownSecrets: known.keys() })
      spent += result.bytes ?? record.size
      report.bytes += result.bytes ?? 0
      if (result.status === 'redacted') {
        report.redactedFiles += 1
        report.redactedValues += result.redacted
      } else if (result.status === 'normalised') {
        report.normalised += 1
      } else if (result.status === 'error') {
        report.errors.push({ path: logPath, error: result.error })
        // Keep the previous record: an unreadable log must be retried, not
        // remembered as settled.
        if (previous.files[logPath]) next.files[logPath] = previous.files[logPath]
        continue
      }
      // Values this log turned out to carry join the union, so later logs in
      // this round hunt them immediately and every log settles against them.
      if (Array.isArray(result.harvested)) for (const value of result.harvested) known.set(value, roundAt)
      if (typeof result.size === 'number') {
        record.size = result.size
        record.mtimeMs = result.mtimeMs
        record.ino = result.ino
        record.swept = result.size
        record.sweptMtimeMs = result.mtimeMs
        record.harvested = result.size
        record.trusted = harvestFailed === 0
        rewritten.push(record)
      }
    }
  }
  // A value appended to a log between pass 1 and pass 2 enters the union from
  // inside pass 2, i.e. after some logs were already rewritten: those sweeps
  // did not see it, so this round's work is not final for them either.
  if (known.size !== unionAtSweep) for (const record of rewritten) record.trusted = false
  // Age out before persisting: a round that swept nothing must still be able
  // to shrink the store, or an idle machine would keep every secret forever.
  pruneSeeds(known, roundAt)
  report.harvested = known.size

  // Persist both stores: the union so the next round can seed logs that were
  // busy now, and the per-file offsets that make the next round incremental.
  // Saving when the file exists (even with zero seeds) is what makes an
  // all-expired store actually shrink on disk; an empty v1 file would
  // otherwise stay behind with its plaintext list.
  if (report.busy > 0 || known.size > 0 || existsSync(seedPath)) saveSeedSeeds(seedPath, known)
  if (persistState) saveState(statePath, next)
  return report
}
