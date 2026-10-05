/**
 * KDF unit contract test (master key derivation).
 *
 * Bitwarden and Vaultwarden report Argon2id KDF memory in MiB; hash-wasm counts
 * KiB. Both sides of the old test suite confused the two in the same way, so an
 * argon2id account could not log in against a real server while every
 * mock-based test stayed green — the mock derived its expected key from the
 * same wrong number. This file pins the boundary instead of the pair:
 *
 *   - the master key must equal an Argon2id run at `memorySize: MiB * 1024`,
 *   - pinned digests fix that value independently of the implementation,
 *   - the client and test/mock-server.mjs must agree on it.
 *
 * A server that keeps the old unit now fails here on the next run, whichever
 * side is changed back.
 *
 * Run: node test/kdf-units.test.mjs
 */
import { pbkdf2Sync } from 'node:crypto'
import { deriveMasterKey } from '../lib/vault.js'
import { EMAIL as MOCK_EMAIL, PASSWORD as MOCK_PASSWORD, serverMasterKey } from './mock-server.mjs'

const PASSWORD = 'correct horse battery staple'
const EMAIL = 'user@example.com'
/** 64 MiB, 3 passes, 4 lanes — the shape a Vaultwarden prelogin reports. */
const ARGON2_DESCRIPTOR = { kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 }
/** Argon2id(PASSWORD, EMAIL, m=64 MiB, t=3, p=4), hex. */
const ARGON2_MIB_HEX = 'ecac1f67fed26d11ec06663d9f2b410a68d86d4a92d008429260143d6e1da507'
/** The same inputs read as 64 KiB — the old, wrong unit. */
const ARGON2_KIB_HEX = '7fe8f9ea6ff3a86816a80ed7be4685d45b280bfaa6aa726fbeea33969c45e278'
/** PBKDF2-SHA256(PASSWORD, EMAIL, 600000), hex. */
const PBKDF2_600K_HEX = '55dc4a94e4881ffd792d6cb4173d7145756cd95ddc9b2310bb0fc931123c8248'
/** PBKDF2-SHA256(PASSWORD, EMAIL, 1000), hex. */
const PBKDF2_1K_HEX = 'd4d7099169e75acb6253cbfa4646a56eac5f99a0afcbce1baf9c5beae15102f9'

let passed = 0
let failed = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

let hashWasm = null
try {
  hashWasm = (await import('hash-wasm')).argon2id
} catch {
  console.log('kdf-units: hash-wasm not installed — argon2id checks skipped')
}

console.log('kdf units test')

// ── PBKDF2-SHA256 (KDF 0) ─────────────────────────────────────────────────────
{
  const key = await deriveMasterKey(PASSWORD, EMAIL, 0, 600_000)
  check('PBKDF2 master key matches a pinned 600k digest', key.toString('hex') === PBKDF2_600K_HEX, key.toString('hex'))
  check('PBKDF2 key is 32 bytes', key.length === 32, String(key.length))
  const short = await deriveMasterKey(PASSWORD, EMAIL, 0, 1000)
  check('PBKDF2 iteration count is honoured, not fixed', short.toString('hex') === PBKDF2_1K_HEX, short.toString('hex'))
  check('PBKDF2 output equals node:crypto for the same inputs', short.toString('hex') === pbkdf2Sync(PASSWORD, EMAIL, 1000, 32, 'sha256').toString('hex'))
  const messy = await deriveMasterKey(PASSWORD, '  User@Example.COM ', 0, 1000)
  check('the salt is the trimmed, lowercased email', messy.toString('hex') === PBKDF2_1K_HEX, messy.toString('hex'))
}

// ── Argon2id (KDF 1): the memory unit is the whole point ─────────────────────
if (hashWasm) {
  const native = await hashWasm({
    password: PASSWORD.normalize('NFKC'),
    salt: EMAIL,
    parallelism: 4,
    iterations: 3,
    memorySize: 64 * 1024,
    hashLength: 32,
    outputType: 'hex',
  })
  check('the pinned digest is an Argon2id run at 64 MiB (65536 KiB)', native === ARGON2_MIB_HEX, native)
  const kibOnly = await hashWasm({
    password: PASSWORD.normalize('NFKC'),
    salt: EMAIL,
    parallelism: 4,
    iterations: 3,
    memorySize: 64,
    hashLength: 32,
    outputType: 'hex',
  })
  check('reading the same number as KiB yields a different key', kibOnly === ARGON2_KIB_HEX && kibOnly !== native, kibOnly)

  const client = await deriveMasterKey(PASSWORD, EMAIL, 1, 3, { memory: 64, parallelism: 4 })
  check('the client derives the master key from MiB of memory', client.toString('hex') === ARGON2_MIB_HEX, client.toString('hex'))
  check('the client no longer derives it from 64 KiB', client.toString('hex') !== ARGON2_KIB_HEX)

  // The pair that used to be wrong together: the mock's expected key and the
  // client's derived key. Equality here, plus the pinned digest above, means
  // reverting either side alone breaks a test.
  const server = await serverMasterKey(MOCK_PASSWORD, ARGON2_DESCRIPTOR)
  const serverClient = await deriveMasterKey(MOCK_PASSWORD, MOCK_EMAIL, 1, 3, { memory: 64, parallelism: 4 })
  check('the mock server derives the same master key as the client', server?.toString('hex') === serverClient.toString('hex'), server?.toString('hex'))
  check('the mock server reads the MiB memory value as KiB', server?.toString('hex') !== ARGON2_KIB_HEX, server?.toString('hex'))

  const shortened = await deriveMasterKey(PASSWORD, EMAIL, 1, 3, { memory: 64 })
  check('parallelism falls back to 4 when the server omits it', shortened.toString('hex') === client.toString('hex'))
  const messy = await deriveMasterKey(PASSWORD, '  User@Example.COM ', 1, 3, { memory: 64, parallelism: 4 })
  check('the Argon2 salt is normalized like the PBKDF2 one', messy.toString('hex') === ARGON2_MIB_HEX, messy.toString('hex'))
}

console.log(`
${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
