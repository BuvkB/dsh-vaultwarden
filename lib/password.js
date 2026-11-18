/**
 * Strong-password generation for create/update writes.
 *
 * The point is not to expose a password to the model: the generator runs in
 * the host process and the generated value is encrypted straight into the
 * cipher body. The tool result says only that a password was generated, so a
 * create/rotate can happen without a credential entering the conversation or
 * the session log. When the caller genuinely needs the new password for a
 * sign-up form, it goes through the normal bitwarden_reveal path afterwards.
 *
 * Uses crypto.randomInt, never Math.random. Every selected character class is
 * guaranteed at least one member, and the final string is shuffled with a
 * cryptographic Fisher-Yates so the guaranteed characters do not sit at fixed
 * positions.
 */
import { randomInt } from 'node:crypto'

const CLASSES = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  // Quotes/backslash are omitted: they are the characters most likely to be
  // rejected or mangled by a site's password form, and a strong password that
  // cannot be submitted is not useful.
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
}

const AMBIGUOUS = new Set('O0Il1|')

const DEFAULT_LENGTH = 20
const MIN_LENGTH = 8
const MAX_LENGTH = 128

/**
 * @param {{length?: number, upper?: boolean, lower?: boolean, digits?: boolean, symbols?: boolean, avoidAmbiguous?: boolean}} [options]
 * @returns {string}
 */
export function generatePassword(options = {}) {
  const requestedLength = Number(options.length)
  const length = Number.isFinite(requestedLength)
    ? Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.floor(requestedLength)))
    : DEFAULT_LENGTH
  const selected = []
  if (options.lower !== false) selected.push('lower')
  if (options.upper !== false) selected.push('upper')
  if (options.digits !== false) selected.push('digits')
  if (options.symbols !== false) selected.push('symbols')
  if (selected.length === 0) selected.push('lower')
  const avoidAmbiguous = options.avoidAmbiguous !== false
  const pools = selected.map((name) => {
    const chars = [...CLASSES[name]]
    return avoidAmbiguous ? chars.filter((char) => !AMBIGUOUS.has(char)) : chars
  })
  // Every class contributes one character, so a length smaller than the class
  // count is raised rather than silently dropping a requested class.
  const effectiveLength = Math.max(length, pools.length)
  const chars = []
  for (const pool of pools) chars.push(pool[randomInt(0, pool.length)])
  const all = pools.join('')
  while (chars.length < effectiveLength) chars.push(all[randomInt(0, all.length)])
  // Fisher-Yates with a CSPRNG.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1)
    const swap = chars[i]
    chars[i] = chars[j]
    chars[j] = swap
  }
  return chars.join('')
}

/** Parse and validate the optional JSON options argument of the tools. */
export function parseGeneratorOptions(raw) {
  if (raw === undefined || raw === null || raw === '') return {}
  let value
  try {
    value = JSON.parse(String(raw))
  } catch {
    throw new Error('passwordOptions 不是合法 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('passwordOptions 必须是 JSON 对象')
  }
  return value
}
