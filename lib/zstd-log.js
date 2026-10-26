/**
 * Zstandard frame plumbing for session logs.
 *
 * Why this file exists
 * --------------------
 * A DSH session log is a CONCATENATION of independent zstd frames: the host
 * writes one frame for the header line and one frame per append batch
 * (dsh-session-persistence-jsonl: encodeMaterialization / encodeEventBatch),
 * and it never rewrites the bytes it already wrote — appends only. Two
 * consequences drive this module:
 *
 *  1. Node's public zstd API is SINGLE-FRAME: `zstdDecompress(buf)` stops at
 *     the first frame boundary. Measured on a real 13.7 MB log (70,987,095
 *     bytes of plaintext, 3437 frames) it returned 191 bytes — the header
 *     alone. Feeding a whole log to it would silently truncate the session.
 *     Multi-frame containers must be delimited by the caller, frame by frame.
 *  2. Because appends never rewrite history, a frame is immutable once
 *     written — so a rewrite only has to recompress the frames whose plaintext
 *     actually changed and can copy every other frame's bytes verbatim.
 *
 * `scanZstdFrames` is a faithful port of the host's own delimiters
 * (dsh-session-persistence-jsonl lib/index.js:1305), including its refusal of
 * reserved descriptor/block bits and its torn-tail reporting, so both sides
 * agree on frame boundaries.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

/** Little-endian 0xFD2FB528: the zstd frame magic as a uint32. */
export const ZSTD_MAGIC = 4247762216

/** Node >= 22.15 ships zstd in zlib; older 22.x only has the CLI. Feature
 *  detection (not a version check) keeps the fallback honest. */
export const hasNativeZstd = typeof zlib.zstdCompress === 'function' && typeof zlib.zstdDecompress === 'function'

const compressAsync = hasNativeZstd ? promisify(zlib.zstdCompress) : null
const decompressAsync = hasNativeZstd ? promisify(zlib.zstdDecompress) : null

/** Checksum flag the host's writer always sets; matching it keeps rewritten
 *  frames indistinguishable from host-written ones. */
export const CHECKSUM_OPTIONS = (() => {
  const flag = zlib.constants?.ZSTD_c_checksumFlag
  return typeof flag === 'number' ? { params: { [flag]: 1 } } : {}
})()

/**
 * Walk the frames of one buffer without decompressing them.
 *
 * @param {Buffer} buffer bytes to scan
 * @param {number} [maxFrames] stop after this many frames
 * @returns {{frames: {start: number, end: number}[], tornStart?: number}}
 *   complete frame ranges, plus the offset of an incomplete trailing frame
 *   (a crash tail the host itself repairs by truncation).
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid frame magic at byte ' + offset)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // Reserved bits must be zero: trusting them would desynchronize the scan.
    if ((descriptor & 24) !== 0) throw new Error('reserved frame header bit at byte ' + (offset - 1))
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('reserved block type at byte ' + (offset - 3))
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * Decompress ONE frame to text. The caller must have delimited it with
 * scanZstdFrames — passing a multi-frame buffer here returns only its first
 * frame, which is exactly the truncation trap described in the header.
 *
 * Native zstdCompress/zstdDecompress run on libuv's threadpool, so awaiting
 * them keeps the host's main thread free; the CLI fallback blocks, but only on
 * Node too old to have the builtin.
 */
export async function decodeFrame(frame) {
  return (await decodeFrameBuffer(frame)).toString('utf8')
}

/**
 * Decompress ONE frame to bytes.
 *
 * Kept separate from decodeFrame because decoding to a STRING is the expensive
 * half on the host's main thread: measured on the corpus's largest frame
 * (10.5 MB compressed, 118 MB of plaintext, 9480 lines) decompression runs on
 * the libuv threadpool for ~1 s, but Buffer.toString('utf8') costs another
 * ~480 ms ON THE MAIN THREAD, and the JSON.parse pass after it another ~700 ms.
 * A caller that can decide from the bytes alone whether the frame is worth
 * looking at should never pay the string cost at all.
 */
export async function decodeFrameBuffer(frame) {
  if (hasNativeZstd) return decompressAsync(frame)
  const proc = spawnSync('zstd', ['-d', '-c'], { input: frame, maxBuffer: 1 << 30 })
  if (proc.status !== 0 || !proc.stdout) throw new Error('zstd 解压失败：' + (proc.stderr?.toString().trim() || 'no output'))
  return proc.stdout
}

/**
 * True when the plaintext bytes contain any of the given literals.
 *
 * Deliberately scans the Buffer rather than a decoded string: the needles are
 * pure ASCII, so a latin1 byte comparison is equivalent to a utf8 substring
 * search, and it avoids materializing a multi-megabyte JS string for a frame
 * that turns out to hold nothing of interest. A full miss on the corpus's
 * largest frame costs ~500 ms versus ~1200 ms for the string route, and a hit
 * short-circuits after 0.1 ms.
 */
export function bufferHasAny(buffer, needles) {
  for (const needle of needles) {
    if (buffer.includes(Buffer.from(needle, 'latin1'))) return true
  }
  return false
}

/** Compress text into ONE frame carrying the host's checksum flag. */
export async function encodeFrame(text) {
  const input = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8')
  if (hasNativeZstd) return compressAsync(input, CHECKSUM_OPTIONS)
  const proc = spawnSync('zstd', ['-q', '-c'], { input, maxBuffer: 1 << 30 })
  if (proc.status !== 0 || !proc.stdout) throw new Error('zstd 压缩失败：' + (proc.stderr?.toString().trim() || 'no output'))
  return proc.stdout
}

/** Read [start, end) of a file without pulling the whole thing into memory
 *  twice. Used for the incremental tail read. */
export function readRange(path, start, end) {
  const length = Math.max(0, end - start)
  const buffer = Buffer.allocUnsafe(length)
  const fd = openSync(path, 'r')
  try {
    let read = 0
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read)
      if (n === 0) break
      read += n
    }
    return read === length ? buffer : buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}
