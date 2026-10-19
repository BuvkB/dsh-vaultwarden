/**
 * Private atomic file writes: the one place every on-disk record goes through.
 *
 * Why this exists
 * ---------------
 * `renameSync` already made readers safe — they see the old inode or the new
 * one, never half a file. The writer side was the weak half, for three reasons
 * 0.8.8 shipped with:
 *
 *  1. The temp name was `${path}.${pid}.tmp`, and `writeFileSync`'s `mode` is
 *     ignored for a file that already exists. A leftover 0644 temp file (from a
 *     crash, or from anything else that can write the directory) kept its 0644
 *     while the complete record — master key included — was written into it,
 *     until the following `chmodSync` narrowed it. An `wx` open refuses an
 *     existing path outright instead of reusing it, and a fresh inode takes the
 *     stated mode even under a permissive umask, so that window is gone.
 *  2. worker_threads share one `process.pid`, so two threads could pick the
 *     same temp path. The suffix is random now.
 *  3. A rename still in the page cache can land before its data, so a power cut
 *     could leave a zero-length target — which `load()` reads as "corrupt",
 *     deletes, and the operator is silently signed out. fsync before the rename
 *     (and on the directory after it) is what makes the rename a promise
 *     instead of a hope.
 *
 * Note on scope: this file makes a completed write atomic and durable. It does
 * NOT serialize two writers. That is the remaining gap — `touchSession()` does
 * a lock-free read-modify-write (`vault.js`), and two DSH instances sharing
 * `~/.dsh` can resurrect a rotated refresh token over each other's session.
 * Closing that needs a cross-process lock (`withFileLock` from
 * `@deepseek-ai/dsh-atomic-write`); see `.research/atomic-audit.md`.
 */
import { randomBytes } from 'node:crypto'
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** Default bits for a record that must stay readable only by its owner. */
const PRIVATE_MODE = 0o600

/** Create the parent tree privately. Existing directories keep their mode. */
export function ensurePrivateDir(path, dirMode = 0o700) {
  mkdirSync(dirname(path), { recursive: true, mode: dirMode })
}

/**
 * Replace `path` with `content` in one atomic, durable step: exclusive-create
 * a random-suffix sibling, flush it, rename it over the target, then flush the
 * directory entry.
 *
 * @param {string} path final path receiving the content
 * @param {string|Buffer} content complete next content
 * @param {{mode?: number}} [options] permission bits for the replacement inode
 */
export function writeFilePrivate(path, content, options = {}) {
  const mode = options.mode ?? PRIVATE_MODE
  ensurePrivateDir(path)
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  let fd = null
  try {
    // `wx` is the point: it refuses to reuse — or follow — whatever sits at the
    // temp path. fchmod then pins the exact bits, so the record is never wider
    // than asked, not even for the duration of one syscall.
    fd = openSync(temporary, 'wx', mode)
    fchmodSync(fd, mode)
    writeSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* a temp file that cannot be removed is replaced by the next write */
    }
    throw error
  }
  // The rename is only durable once the directory entry itself is on disk.
  // A filesystem that refuses to fsync a directory costs durability, not
  // correctness, so this stays best-effort.
  try {
    const dir = openSync(dirname(path), 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } catch {
    /* platforms that cannot open or sync a directory */
  }
}
