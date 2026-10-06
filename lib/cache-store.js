/**
 * On-disk vault cache: the server's own ciphertext, kept so a cold start can
 * paint the list before the network answers.
 *
 * Why this exists
 * ---------------
 * Every cold start used to re-download the whole vault (/api/sync, ~660 KB and
 * 2.5-3.7 s on a real account) even when nothing had changed - the download is
 * the slow half of 'the panel takes seconds to open'. This cache keeps the raw
 * sync payload so the next start decrypts it locally, then verifies freshness
 * with a single 13-byte probe of the account revision date: unchanged means
 * nothing is downloaded at all.
 *
 * What is stored
 * --------------
 * The exact JSON payload /api/sync returned - still the server's ciphertext,
 * never decrypted material - plus the account it belongs to, the revision
 * date it corresponds to, and when it was saved. gzip, because the payload is
 * text that compresses to roughly a third of its size.
 *
 * Integrity
 * ---------
 * The envelope carries a SHA-256 HMAC keyed by a 32-byte local key file
 * (cache.key, 0600, written beside the cache). The payload is server
 * ciphertext, so the MAC is not about confidentiality - it is about the cache
 * being *right*: a truncated copy, a file restored from another machine, a
 * hand-edit, or a stale copy planted to make the agent read an old password as
 * the current one. Without the key file no record can be verified, and an
 * unverifiable record is discarded, never served.
 *
 * Security posture
 * ----------------
 * Written 0600 inside the DSH data directory, the same care as the session
 * store. It adds no new exposure: whatever decrypts it (session.json, or the
 * master password in the profile config) already lives on this machine, and
 * the cache alone is useless without it.
 *
 * Trust window
 * ------------
 * A revision probe vouches for the cache for MAX_TRUST_MS only. Past that the
 * vault is re-downloaded even when the probe says 'unchanged': the account
 * revision is believed to cover every sync-visible change, and a periodic full
 * read is the cheap guarantee that nothing can hide behind a probe bug.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

/** File format version; a mismatch discards the stored cache. */
const CACHE_VERSION = 2

/** How long a revision probe may vouch for a cached vault. */
export const MAX_TRUST_MS = 7 * 86_400_000

/** Refuse to inflate a corrupt (or hostile) file beyond this. */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024

/** Length of the local MAC key, in bytes. */
const KEY_BYTES = 32

export class CacheStore {
  /**
   * @param {string} path absolute path of the cache file
   * @param {{enabled?: boolean, now?: () => number, keyPath?: string}} [options]
   */
  constructor(path, options = {}) {
    this.path = path
    this.now = options.now ?? Date.now
    this.enabled = options.enabled ?? true
    this.#keyPath = options.keyPath ?? null
  }

  #keyPath

  /** Where the MAC key lives: beside the cache unless overridden. */
  get keyPath() {
    return this.#keyPath ?? join(dirname(this.path), 'cache.key')
  }

  /** True when caching is switched off. */
  get disabled() {
    return !this.enabled
  }

  /** Drop the stored cache. Safe to call when nothing is stored. */
  clear() {
    try {
      rmSync(this.path, { force: true })
    } catch {
      /* a cache that cannot be deleted is replaced by the next sync */
    }
  }

  /**
   * Read the stored cache.
   * @param {{serverUrl?: string, email?: string}} [expect]
   *   A cache belonging to another account or server is ignored: it would
   *   decrypt to the wrong vault, and the caller's full sync will replace it.
   *   When an expectation is given, the record must state that exact value -
   *   a record with the field missing is refused, not grandfathered in.
   * @returns {object|null} the cache record, or null when absent/invalid
   */
  load(expect = {}) {
    if (this.disabled) return null
    let raw
    try {
      if (!existsSync(this.path)) return null
      raw = readFileSync(this.path)
    } catch {
      return null
    }
    let record
    try {
      record = JSON.parse(gunzipSync(raw, { maxOutputLength: MAX_INFLATED_BYTES }).toString('utf8'))
    } catch {
      this.clear() // corrupt or truncated: start over rather than retry forever
      return null
    }
    if (!record || typeof record !== 'object' || record.version !== CACHE_VERSION) {
      this.clear()
      return null
    }
    if (!record.payload || typeof record.payload !== 'object') {
      this.clear()
      return null
    }
    // The envelope must be signed by this machine's key before anything in it
    // is believed: an unsigned or altered record is a *wrong* record.
    if (!this.#verify(record)) {
      this.clear()
      return null
    }
    if (expect.serverUrl && record.serverUrl !== expect.serverUrl) return null
    if (expect.email && String(record.email ?? '').toLowerCase() !== String(expect.email).toLowerCase()) return null
    return record
  }
  /**
   * Write the cache. The write is atomic (temp file + rename) so a crash
   * cannot leave a half-written file that fails to inflate on the next boot.
   * @returns {boolean} whether the cache was persisted
   */
  save(record) {
    if (this.disabled) {
      this.clear()
      return false
    }
    if (!record || !record.payload || typeof record.payload !== 'object') return false
    const canonical = this.#canonical({ ...record, version: CACHE_VERSION, savedAt: record.savedAt ?? this.now() })
    const mac = this.#sign(canonical)
    if (!mac) return false // without a key the record could never be verified
    const temporary = `${this.path}.${process.pid}.tmp`
    try {
      const payload = gzipSync(JSON.stringify({ ...canonical, mac }))
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, payload, { mode: 0o600 })
      // writeFileSync's mode is masked by umask, so set it explicitly.
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.path)
      return true
    } catch {
      try {
        rmSync(temporary, { force: true })
      } catch {
        /* nothing else to do */
      }
      return false
    }
  }

  /** Whether a revision probe may still vouch for this record. */
  trusted(record) {
    if (this.disabled || !record) return false
    const savedAt = Number(record.savedAt)
    return Number.isFinite(savedAt) && this.now() - savedAt <= MAX_TRUST_MS
  }

  /** Human-readable status for the status tool / the settings panel. */
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
      path: this.path,
      maxTrustDays: MAX_TRUST_MS / 86_400_000,
      savedAt: record?.savedAt ? new Date(record.savedAt).toISOString() : null,
      revision: record?.revision ?? null,
    }
  }
  // -- envelope signing ------------------------------------------------------

  /**
   * Canonical view of a record: the exact fields (and order) the MAC covers.
   * Signing and verifying both go through here, so the two can never drift.
   */
  #canonical(record) {
    return {
      version: record.version ?? null,
      serverUrl: record.serverUrl ?? null,
      email: record.email ?? null,
      savedAt: record.savedAt ?? null,
      revision: record.revision ?? null,
      payload: record.payload ?? null,
    }
  }

  /** Read the MAC key; null when absent or unusable. */
  #readKey() {
    try {
      const key = readFileSync(this.keyPath)
      return key.length === KEY_BYTES ? key : null
    } catch {
      return null
    }
  }

  /** Read the MAC key, creating it on first use. Null when it cannot be stored. */
  #ensureKey() {
    const existing = this.#readKey()
    if (existing) return existing
    const key = randomBytes(KEY_BYTES)
    const temporary = `${this.keyPath}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.keyPath), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, key, { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.keyPath)
      return key
    } catch {
      try {
        rmSync(temporary, { force: true })
      } catch {
        /* nothing else to do */
      }
      return null
    }
  }

  /** Hex MAC for a canonical record, or null when no key is available. */
  #sign(canonical) {
    const key = this.#ensureKey()
    if (!key) return null
    return createHmac('sha256', key).update(JSON.stringify(canonical)).digest('hex')
  }

  /** Constant-time MAC check. A missing key means the record cannot be trusted. */
  #verify(record) {
    const key = this.#readKey()
    if (!key) return false
    const mac = typeof record.mac === 'string' ? record.mac : ''
    if (!/^[0-9a-f]{64}$/.test(mac)) return false
    const expected = createHmac('sha256', key).update(JSON.stringify(this.#canonical(record))).digest('hex')
    return timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))
  }
}

/** Default location: the DSH data directory, one folder per plugin. */
export function defaultCachePath(home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')) {
  return join(home, 'data', 'dsh-vaultwarden', 'vault-cache.json.gz')
}
