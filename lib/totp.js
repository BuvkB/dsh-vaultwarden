/**
 * TOTP (RFC 6238) helpers for Bitwarden `login.totp` values.
 *
 * Bitwarden stores either a full `otpauth://totp/...` URI or a bare Base32
 * secret. Both are accepted here.
 */
import { createHmac } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode an RFC 4648 Base32 string (padding and separators tolerated). */
export function base32Decode(input) {
  const clean = String(input ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  if (!clean) throw new Error('empty base32 secret')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

const ALGORITHMS = new Set(['SHA1', 'SHA256', 'SHA512'])

/** Parse an `otpauth://` URI (or a bare secret) into TOTP parameters. */
export function parseTotp(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('empty TOTP value')
  if (!/^otpauth:\/\//i.test(text)) {
    return { secret: text, digits: 6, period: 30, algorithm: 'SHA1', issuer: undefined, account: undefined }
  }
  const url = new URL(text)
  const params = url.searchParams
  const algorithm = String(params.get('algorithm') ?? 'SHA1').toUpperCase()
  const digits = Number(params.get('digits') ?? 6)
  const period = Number(params.get('period') ?? 30)
  const secret = params.get('secret')
  if (!secret) throw new Error('otpauth URI has no secret parameter')
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  const [issuerPart, accountPart] = label.includes(':') ? label.split(':', 2) : [undefined, label]
  return {
    secret,
    digits: Number.isFinite(digits) && digits >= 6 && digits <= 10 ? digits : 6,
    period: Number.isFinite(period) && period > 0 ? period : 30,
    algorithm: ALGORITHMS.has(algorithm) ? algorithm : 'SHA1',
    issuer: params.get('issuer') ?? issuerPart ?? undefined,
    account: accountPart || undefined,
  }
}

/**
 * Compute the current TOTP code for a stored secret/URI.
 * @param {string} raw - otpauth URI or bare Base32 secret.
 * @param {number} [at] - epoch milliseconds to evaluate (defaults to now).
 * @returns {{code: string, digits: number, period: number, remaining: number, algorithm: string}}
 */
export function generateTotp(raw, at = Date.now()) {
  const { secret, digits, period, algorithm } = parseTotp(raw)
  const counter = Math.floor(at / 1000 / period)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac(algorithm.toLowerCase(), base32Decode(secret)).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  const code = String(binary % 10 ** digits).padStart(digits, '0')
  const remaining = period - (Math.floor(at / 1000) % period)
  return { code, digits, period, remaining, algorithm }
}
