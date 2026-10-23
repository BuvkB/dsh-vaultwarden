/**
 * On-disk session store: keeps a signed-in session across plugin restarts.
 *
 * Why this exists
 * ---------------
 * Tokens used to live only in memory, so every plugin restart (a settings
 * write, a harness restart) threw the session away and the next use had to log
 * in again. For an account with two-factor enabled that means fetching a fresh
 * code every single time — the most annoying possible failure mode.
 *
 * What is stored
 * --------------
 * The access token, the refresh token (which renews the access token without
 * the master password and WITHOUT two-factor), the protected user key the
 * server returned, and the derived master key needed to unwrap it. Taken
 * together that is enough to reopen the vault after a restart with no prompts.
 *
 * Security posture
 * ----------------
 * The file is written 0600 inside the DSH data directory. It is deliberately
 * treated as being as sensitive as the master password itself: anyone who can
 * read it can decrypt the vault. That is not a new exposure for this plugin —
 * `masterPassword` already persists in the profile config so the plugin can
 * unlock unattended — and it is the same trade-off the official clients make
 * for "unlock with PIN" / "remember me".
 *
 * Sessions expire on IDLE, not on age: `touch()` on every successful use moves
 * the deadline, so a session that is used regularly never expires, while one
 * left alone past `maxAgeDays` is dropped.
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFilePrivate } from './atomic-file.js'

/** File format version; a mismatch discards the stored session. */
const STORE_VERSION = 1

/** Never keep a session longer than this, even if a caller asks for more. */
const MAX_ALLOWED_AGE_DAYS = 3650

export class SessionStore {
  /**
   * @param {string} path absolute path of the session file
   * @param {{maxAgeDays?: number, now?: () => number}} [options]
   */
  constructor(path, options = {}) {
    this.path = path
    this.now = options.now ?? Date.now
    this.maxAgeDays = SessionStore.normalizeAge(options.maxAgeDays)
    /** @type {null | {at: number, code: string|null, message: string}} why the last save failed */
    this.lastError = null
  }

  /** Clamp an age to a sane range (fractions of a day are allowed). */
  static normalizeAge(days) {
    const value = Number(days)
    if (!Number.isFinite(value) || value <= 0) return 0
    return Math.min(value, MAX_ALLOWED_AGE_DAYS)
  }

  /** True when persistence is switched off (age 0). */
  get disabled() {
    return this.maxAgeDays <= 0
  }

  /** Drop the stored session. Safe to call when nothing is stored. */
  clear() {
    try {
      rmSync(this.path, { force: true })
    } catch {
      /* a session that cannot be deleted is not fatal — it will expire */
    }
  }

  /**
   * Read the stored session.
   * @param {{serverUrl?: string, email?: string}} [expect]
   *   A session belonging to another account or server is discarded: it would
   *   decrypt the wrong vault, or fail confusingly.
   * @returns {object|null} the session record, or null when absent/invalid/expired
   */
  load(expect = {}) {
    if (this.disabled) return null
    let raw
    try {
      if (!existsSync(this.path)) return null
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return null
    }
    let record
    try {
      record = JSON.parse(raw)
    } catch {
      this.clear() // truncated or hand-edited: start over rather than retry forever
      return null
    }
    if (!record || typeof record !== 'object' || record.version !== STORE_VERSION) {
      this.clear()
      return null
    }
    if (!record.refreshToken && !record.accessToken) {
      this.clear()
      return null
    }
    if (expect.serverUrl && record.serverUrl && record.serverUrl !== expect.serverUrl) return null
    if (expect.email && record.email && record.email.toLowerCase() !== String(expect.email).toLowerCase()) return null
    if (this.expired(record)) {
      this.clear()
      return null
    }
    return record
  }

  /** Whether a record has been idle longer than the configured window. */
  expired(record) {
    if (this.disabled) return true
    const lastUsed = Number(record?.lastUsedAt)
    if (!Number.isFinite(lastUsed)) return true
    return this.now() - lastUsed > this.maxAgeDays * 86_400_000
  }

  /**
   * Write the session. The write is atomic and durable (exclusive-create temp
   * file, fsync, rename, directory fsync) so a crash cannot leave a
   * half-written file that fails to parse on the next boot — see
   * lib/atomic-file.js for why each step is there.
   *
   * Serializing two writers is still NOT done here: this method can be
   * overtaken by another process doing its own read-modify-write. Tracked in
   * `.research/atomic-audit.md` (cross-process lock).
   * @returns {boolean} whether the session was persisted
   */
  save(record) {
    if (this.disabled) {
      this.clear()
      return false
    }
    if (!record || (!record.refreshToken && !record.accessToken)) return false
    const payload = JSON.stringify({ ...record, version: STORE_VERSION, lastUsedAt: record.lastUsedAt ?? this.now() }, null, 2)
    try {
      writeFilePrivate(this.path, payload, { mode: 0o600 })
      this.lastError = null
      return true
    } catch (error) {
      // Kept, not swallowed: a caller that cannot persist the session has to
      // be able to say so (a full disk or a read-only HOME otherwise looks
      // exactly like "remembered", and the next start asks for the password
      // again with no explanation). The boolean stays for compatibility; the
      // reason rides along for `describe()`.
      this.lastError = { at: this.now(), code: error?.code ?? null, message: error?.message ?? String(error) }
      return false
    }
  }

  /** Mark the session as used now, so the idle deadline slides forward. */
  touch(record) {
    if (!record) return record
    record.lastUsedAt = this.now()
    return record
  }

  /** Human-readable status for the settings panel / `bitwarden_status`. */
  describe(record) {
    if (this.disabled) return { enabled: false, stored: false }
    let present = false
    try {
      present = existsSync(this.path) && statSync(this.path).size > 0
    } catch {
      present = false
    }
    return {
      enabled: true,
      stored: present,
      maxAgeDays: this.maxAgeDays,
      path: this.path,
      // Present only when the last write failed; the panel can then say why
      // the remembered device will not actually be remembered.
      lastError: this.lastError,
      lastUsedAt: record?.lastUsedAt ? new Date(record.lastUsedAt).toISOString() : null,
      expiresAt:
        present && record?.lastUsedAt ? new Date(record.lastUsedAt + this.maxAgeDays * 86_400_000).toISOString() : null,
    }
  }
}

/** Default location: the DSH data directory, one folder per plugin. */
export function defaultSessionPath(home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')) {
  return join(home, 'data', 'dsh-vaultwarden', 'session.json')
}
