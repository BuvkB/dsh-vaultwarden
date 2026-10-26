/**
 * Session-log sweeper — the after-the-fact half of maskMode.
 *
 * Why this exists
 * ---------------
 * Even with maskMode on, plaintext still reaches the session log in two ways:
 * a `bitwarden_reveal` call (that is its job), and a caller that echoes a
 * secret into a message or an unrelated tool call afterwards. The host offers
 * no before-write hook for tool results, so the log cannot be prevented from
 * seeing the value — but it can be rewritten afterwards, and the rewrite is
 * the only way the promise "secrets do not persist" can be kept at all.
 *
 * What it does
 * ------------
 * For each `session.v*.jsonl.zstd` under `~/.dsh/sessions`:
 *  1. Skip logs whose session is still live (the host appends to them; see
 *     `isIdle` for how liveness is decided conservatively).
 *  2. Decompress (system `zstd` binary; Node 22 has no built-in zstd), parse
 *     each line as JSON, and in `tool/call` + `tool/result` +
 *     `tool/ptc-dispatch` + `tool/ptc-dispatch-start` events for
 *     `bitwarden_*` tools replace credential-shaped values with
 *     `[REDACTED:BW_*]`. Placeholders (`{{BW_*}}`) pass through untouched —
 *     they are tags, not secrets.
 *  3. Hunt echoes: the exact secret values harvested in step 2 are replaced
 *     wherever they reappear in ANY tool event's text-bearing fields — in
 *     code mode the run_code aggregate tool/result quotes its bitwarden
 *     sub-calls' output as free text under a run_code-named event, which
 *     step 2's name filter never sees.
 *     sweepAll goes further: it harvests across ALL logs first (pass 1,
 *     busy ones read-only) and seeds every per-log hunt with the union
 *     (pass 2), because a value revealed in session A is routinely echoed
 *     by bash in session B — a per-log hunt is blind to that.
 *  4. Recompress and atomically replace the file (writeFilePrivate).
 *
 * Idempotent by construction: a redacted line no longer matches the secret
 * patterns, so sweeping twice does nothing the second time.
 *
 * Known limits (documented in the README, told to the user):
 *  - The window between a reveal and the next sweep still holds the plaintext
 *    on disk. Sweeping shrinks the exposure, it cannot close it.
 *  - Model thinking text and user prose that quote a secret are left intact
 *    on purpose: assistant/user events carry thinkingSignature material the
 *    host needs byte-exact for replay, so the sweep is restricted to tool
 *    events.
 *  - Other persistence paths the plugin cannot see (~/.dsh/backups, plugin
 *    translator caches, the model's own context) are out of scope.
 *  - Rewriting the log does not change what the model already has in memory.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFilePrivate } from './atomic-file.js'

/** How old a session.lock must be before its log is treated as settled. The
 *  host touches the lock while the session is active; a lock untouched for
 *  this long means no turn is running. Deliberately generous — a false
 *  "idle" would race the host's appender. */
const DEFAULT_IDLE_SECONDS = 600

/** Keys whose values are credentials, wherever they appear in a bitwarden_*
 *  event. Kept in sync (by hand) with SECRET_KEY in client.js — this list is
 *  for what the LOG may contain, which is a superset of what the panel masks:
 *  tool arguments (bitwarden_create password=…) and results (bitwarden_get
 *  {"password": …}) both flow through here. */
const SECRET_KEY_RE =
  /^(password|passphrase|totp|totpsecret|secret|number|code|securitycode|ssn|socialsecuritynumber|passportnumber|licensenumber|privatekey|notes|notesvalue|cardnumber|cvv|cvc|pin|apikeyclientsecret|apikey|token|accesstoken|refreshtoken|clientsecret|masterpassword|masterkey|encryptedkey|securenote)$/i

const PLACEHOLDER_SCAN = /\{\{BW_[A-Z]+_[a-z2-7]{8}\}\}/

const isSecretKey = (key) => SECRET_KEY_RE.test(String(key ?? '').replace(/[_-]/g, ''))

/**
 * Recursively replace credential-shaped values in a parsed JSON structure.
 * Returns the number of replacements made (0 = leave the line untouched).
 */
export function redactValue(value, marker = '[REDACTED:BW]', depth = 0, collected) {
  let hits = 0
  if (depth > 12 || value === null || typeof value !== 'object') return 0
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (typeof child === 'string') {
      // An already-redacted value is final: markers and {{BW_*}} placeholders
      // must survive re-sweeps byte-identically (idempotence).
      if (isSecretKey(key) && child !== '' && child !== marker && !PLACEHOLDER_SCAN.test(child) && child !== '<hidden>') {
        // Record the plaintext for phase 3 (echo hunting) before it is
        // destroyed. Generic values are skipped — sweeping every "true"
        // through unrelated tool output would corrupt more than it hides.
        if (collected && worthCollecting(child)) collected.add(child)
        value[key] = marker
        hits += 1
      } else if ((key === 'arguments' || key === 'text' || key === 'content') && (child[0] === '{' || child[0] === '[')) {
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
 * absent — replacing "zstd" everywhere because a password happens to be
 * "zstd" would shred the log. */
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
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (typeof child === 'string') {
      if (ECHO_KEY_RE.test(key)) {
        let replaced = child
        for (const secret of secrets) {
          if (!replaced.includes(secret)) continue
          const parts = replaced.split(secret)
          hits += parts.length - 1
          replaced = parts.join(marker)
        }
        if (replaced !== child) value[key] = replaced
      }
      // An ECHO field can itself embed JSON (a code-dispatch "arguments"
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
  return isBwCall || isBwResult || isBwPtc
}

/** Phase 1 of a sweep, shared by sweepLog and sweepAll’s global pass:
 *  learn the bitwarden_* callIds of this log and harvest the plaintext
 *  values their events carry into `into` (harvesting parses throwaway
 *  copies — it never mutates the caller’s data). */
export function collectSecrets(lines, marker = '[REDACTED:BW]', into = new Set()) {
  const bwCalls = new Set()
  for (const line of lines) {
    if (!line || (!line.includes('"tool/call"') && !line.includes('"tool/result"') && !line.includes('"tool/ptc-dispatch"') && !line.includes('"tool/code-dispatch"'))) continue
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
  return { bwCalls, secrets: into }
}

/** Decompress a session log into lines, or null when zstd fails. */
function decodeLines(logPath, options = {}) {
  const decoded = spawnSync(options.zstd ?? 'zstd', ['-d', '-c', logPath], { maxBuffer: 1 << 30 })
  if (decoded.status !== 0 || !decoded.stdout) return null
  return decoded.stdout.toString('utf8').split('\n')
}


/** List session log files under the sessions root (all directories, all
 * versions), newest first. */
export function listSessionLogs(sessionsRoot) {
  if (!existsSync(sessionsRoot)) return []
  const logs = []
  for (const workspace of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    for (const session of readdirSync(join(sessionsRoot, workspace.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(sessionsRoot, workspace.name, session.name)
      // Every version in every directory: superseded logs (v3 beside v4) and
      // lockless exports (directories without the session- prefix) hold the
      // same plaintext the current log does — a session-* prefix filter left
      // 68 real directories permanently unswept.
      for (const file of readdirSync(dir)) {
        if (/^session\.v\d+\.jsonl\.zstd$/.test(file)) logs.push(join(dir, file))
      }
    }
  }
  return logs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

/**
 * Conservative liveness test for one session directory: a log is idle only
 * when its lock file has not been touched for `idleSeconds` AND the log
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
 * Sweep one log file. Returns a report; never throws (a log that cannot be
 * read is reported and skipped, not fatal for the batch).
 *
 * @param {string} logPath path to session.v*.jsonl.zstd
 * @param {{zstd?: string, marker?: string, idleSeconds?: number, now?: () => number, skipIdleCheck?: boolean}} [options]
 */
export function sweepLog(logPath, options = {}) {
  const marker = options.marker ?? '[REDACTED:BW]'
  if (!options.skipIdleCheck && !isIdle(logPath, options)) return { path: logPath, status: 'busy', redacted: 0 }
  const zstd = options.zstd ?? 'zstd'
  const decoded = spawnSync(zstd, ['-d', '-c', logPath], { maxBuffer: 1 << 30 })
  if (decoded.status !== 0 || !decoded.stdout) {
    return { path: logPath, status: 'error', error: `zstd 解压失败（${decoded.stderr?.toString().trim() || 'no output'}）`, redacted: 0 }
  }
  const lines = decoded.stdout.toString('utf8').split('\n')
  // Phase 1 — learn which callIds belong to bitwarden_* tools and harvest
  // the plaintext values their events carry, so phase 3 can hunt echoes of
  // them by content (collectSecrets above parses throwaway copies; a
  // tool/call always precedes its result). options.knownSecrets seeds the
  // hunt with values harvested from OTHER logs by sweepAll pass 1: a
  // value revealed in session A is routinely echoed by bash in session B,
  // and a per-log hunt is blind to that.
  const secrets = new Set()
  const { bwCalls } = collectSecrets(lines, marker, secrets)
  if (options.knownSecrets) for (const value of options.knownSecrets) secrets.add(value)
  // Phase 2+3 — bitwarden events lose every secret-keyed value (phase 2);
  // every tool event additionally loses echoes of the harvested values
  // (phase 3 — a run_code aggregate result quotes its bitwarden sub-calls'
  // output as free text under a run_code-named event, which the name filter
  // above never sees). assistant and user messages are never rewritten:
  // their thinkingSignature must stay byte-exact for replay.
  let redacted = 0
  let touched = false
  // callId -> the arguments a `tool/call` event ended up with, so phase 4 can
  // make the assistant/message copy agree byte for byte.
  const settledArgs = new Map()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // fast path: only tool events are candidates, most lines are prose
    if (!line || (!line.includes('"tool/call"') && !line.includes('"tool/result"') && !line.includes('"tool/ptc-dispatch') && !line.includes('"tool/code-dispatch') && !line.includes('"plugin:translator') && !line.includes('"job/'))) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!['tool/call', 'tool/result', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start', 'tool/code-dispatch', 'tool/code-dispatch-start', 'plugin:translator/request', 'plugin:translator/result', 'job/registered', 'job/settled'].includes(event?.type)) continue
    let hits = 0
    if (isBwToolEvent(event, bwCalls)) hits += redactValue(event.data, marker)
    if (secrets.size > 0) hits += replaceKnownValues(event.data, secrets, marker)
    if (event.type === 'tool/call' && typeof event.data?.callId === 'string') {
      settledArgs.set(event.data.callId, event.data.arguments)
    }
    if (hits > 0) {
      lines[i] = JSON.stringify(event)
      redacted += hits
      touched = true
    }
  }
  // Phase 4 — keep the assistant/message copy of every tool call in sync.
  //
  // The host writes a call's arguments TWICE: once in the assistant message's
  // `tool-call` content block and once in the dedicated `tool/call` event. On
  // load, dsh-session-format-v3-to-v4 replays both and requires
  //
  //     pending.name === data.name && pending.arguments === data.arguments
  //
  // as a strict string comparison, throwing otherwise:
  //   SessionFormatError: tool/call <id> does not match one advertised tool call
  // and the whole session becomes unreadable ("stored log is corrupt").
  //
  // Phases 2 and 3 rewrote only the tool/call copy, so every swept session
  // with a redacted bitwarden call carried two disagreeing copies and failed
  // to load. Rewriting the assistant copy is safe for replay: the byte-exact
  // requirement the file header warns about applies to `thinkingSignature`
  // (a sibling field the model provider signs), not to `arguments`.
  //
  // Only the argument STRING is replaced, and the new string is the exact one
  // already written into tool/call, so the pair agrees by construction.
  if (settledArgs.size > 0) {
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
      let hits = 0
      for (const block of content) {
        if (block?.type !== 'tool-call' || typeof block.id !== 'string') continue
        if (!settledArgs.has(block.id)) continue
        const settled = settledArgs.get(block.id)
        if (block.arguments === settled) continue
        block.arguments = settled
        hits += 1
      }
      if (hits > 0) {
        lines[i] = JSON.stringify(event)
        redacted += hits
        touched = true
      }
    }
  }
  if (!touched) return { path: logPath, status: 'clean', redacted: 0 }
  // Encode as TWO independent zstd frames — the session header in its own
  // frame, every event line in a second one. This mirrors what the host's
  // own writer does (encodeMaterialization: `compressZstdFrame(header)`
  // concatenated with `compressZstdFrame(body)`), and it is not cosmetic:
  // the host reads the header with readFirstZstdLine(), which scans the file
  // for the FIRST complete frame, decompresses only that frame, and requires
  // the plaintext to be exactly one line (`assertZstdHeaderFrame`). Feeding
  // the whole log to `zstd -c` yields a single frame whose plaintext is every
  // line at once, so the host throws
  //   SessionPersistenceCorruptionError: corrupt Zstandard session log:
  //   header frame failed validation: first frame is not exactly one header line
  // and silently drops the session from the workspace index — the session
  // disappears from the UI and is pruned from workspace.json on the next
  // write. Compressing the two halves separately keeps the file readable.
  const headerLine = lines[0] ?? ''
  const bodyText = lines.slice(1).join('\n')
  const headerFrame = spawnSync(zstd, ['-q', '-19', '-T0', '-c'], { input: headerLine + '\n', maxBuffer: 1 << 20 })
  if (headerFrame.status !== 0 || !headerFrame.stdout) {
    return { path: logPath, status: 'error', error: 'zstd 压缩失败（header 帧）', redacted: 0 }
  }
  // An untouched tail is empty only when the log is a bare header; then the
  // header frame alone is the whole file, which the host reads back fine.
  let encoded = headerFrame.stdout
  if (bodyText.length > 0) {
    const bodyFrame = spawnSync(zstd, ['-q', '-19', '-T0', '-c'], { input: bodyText, maxBuffer: 1 << 30 })
    if (bodyFrame.status !== 0 || !bodyFrame.stdout) {
      return { path: logPath, status: 'error', error: 'zstd 压缩失败（body 帧）', redacted: 0 }
    }
    encoded = Buffer.concat([headerFrame.stdout, bodyFrame.stdout])
  }
  try {
    // Preserve the original permission bits and timestamps: the host created
    // the log, and a sweep must not widen what it already allows — nor reset
    // its mtime, which is the idle signal the next sweep relies on.
    const before = statSync(logPath)
    writeFilePrivate(logPath, encoded, { mode: before.mode & 0o777 })
    utimesSync(logPath, before.atime, before.mtime)
    return { path: logPath, status: 'redacted', redacted }
  } catch (error) {
    return { path: logPath, status: 'error', error: String(error?.message ?? error), redacted: 0 }
  }
}

/**
 * Sweep every idle session log under the root. Two passes: pass 1 harvests
 * the union of plaintext secret values from every log (busy ones read-only,
 * since their values can be echoed in idle logs even though the busy log
 * itself cannot be rewritten yet); pass 2 sweeps each idle log seeded with
 * that union, so echoes that crossed session boundaries are hunted too.
 * Returns a summary; backs both the manual `bitwarden_sweep` tool and
 * the periodic timer.
 */
/**
 * Cross-round seed store: values already swept out of the logs. Once a
 * source log is redacted the plaintext exists nowhere on disk, so a later
 * sweep cannot re-learn it — yet a log that was busy during that sweep
 * (this session's own log, typically) may still echo it. Persisting the
 * seeds keeps the hunt alive across rounds. The file lives beside the
 * vault cache and holds only the secret values it exists to erase.
 */
export function seedStorePath() {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  return join(home, 'data', 'dsh-vaultwarden', 'swept-secrets.json')
}

function loadSeedSeeds(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(parsed?.values)) return parsed.values.filter((v) => typeof v === 'string')
  } catch {
    // absent or unreadable — start empty
  }
  return []
}

function saveSeedSeeds(path, values) {
  try {
    writeFileSync(path, JSON.stringify({ version: 1, values: [...values] }, null, 0) + String.fromCharCode(10), { mode: 0o600 })
  } catch {
    // best effort — the in-round hunt still works without persistence
  }
}

export function sweepAll(sessionsRoot, options = {}) {
  const logs = listSessionLogs(sessionsRoot)
  const marker = options.marker ?? '[REDACTED:BW]'
  const report = { scanned: logs.length, redactedFiles: 0, redactedValues: 0, busy: 0, harvested: 0, errors: [] }
  const known = new Set()
  // Cross-round seeds: values swept in earlier rounds whose source logs are
  // now redacted (phase 1 cannot re-harvest them) but whose echoes may still
  // surface in logs that were busy back then.
  const seedPath = options.seedPath ?? seedStorePath()
  for (const value of loadSeedSeeds(seedPath)) known.add(value)
  for (const logPath of logs) {
    const lines = decodeLines(logPath, options)
    if (lines === null) continue
    collectSecrets(lines, marker, known)
  }
  report.harvested = known.size
  for (const logPath of logs) {
    const result = sweepLog(logPath, { ...options, knownSecrets: known })
    if (result.status === 'redacted') {
      report.redactedFiles += 1
      report.redactedValues += result.redacted
    } else if (result.status === 'busy') report.busy += 1
    else if (result.status === 'error') report.errors.push({ path: logPath, error: result.error })
  }
  // Persist the union so the next round can seed logs that were busy now.
  if (report.busy > 0 || known.size > 0) saveSeedSeeds(seedPath, known)
  return report
}
