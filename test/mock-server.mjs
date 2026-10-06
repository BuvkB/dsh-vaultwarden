/**
 * Mock Vaultwarden/Bitwarden server used by the offline tests.
 *
 * Implements the server half of the protocol with Bitwarden's own crypto
 * (PBKDF2/Argon2 master key, HKDF-Expand stretch, AES-256-CBC + HMAC-SHA256
 * EncStrings, per-item organization keys, legacy type-0 cipher strings), so the
 * client under test talks to something that behaves like the real server —
 * including rejecting a wrong master password hash.
 *
 * `test/cli-interop.mjs` points the *official* Bitwarden CLI at this server,
 * which turns it into a cross-implementation check of the shared crypto.
 */
import {
  constants as cryptoConstants,
  createHash,
  createHmac,
  createCipheriv,
  generateKeyPairSync,
  pbkdf2Sync,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { hashMasterPassword, stretchKey } from '../lib/vault.js'

export const EMAIL = 'dsh-test@example.com'
export const PASSWORD = 'correct horse battery staple'
export const ITERATIONS = 600_000
// Bitwarden user ids are GUIDs; the official CLI validates that shape.
export const USER_ID = '7f3d9a1e-6c2b-4f5a-9d31-8b0c4e2a5f77'

// RFC 6238 reference secret ("12345678901234567890" in Base32), 8 digits.
export const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
export const RFC_URI = `otpauth://totp/RFC:test?secret=${RFC_SECRET}&issuer=RFC&algorithm=SHA1&digits=8&period=30`

/** Two-factor fixtures: the single-use token and the accepted code. */
export const TWO_FACTOR_TOKEN = 'mock-two-factor-token'
export const TWO_FACTOR_CODE = '123456'

// ── minimal SignalR-over-WebSocket server (test only) ─────────────────────────
// Enough of RFC 6455 + the SignalR JSON protocol for the client's live-sync
// channel: handshake, ping/pong keepalive, and server-pushed ReceiveMessage
// invocations. No dependency beyond node builtins.

const RS = '\u001e' // SignalR record separator
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Build one unmasked server→client text frame. */
function wsFrame(payload) {
  const data = Buffer.from(payload, 'utf8')
  let header
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  return Buffer.concat([header, data])
}

function hkdfExpand(prk, info, length) {
  let previous = Buffer.alloc(0)
  let okm = Buffer.alloc(0)
  for (let counter = 1; okm.length < length; counter++) {
    previous = createHmac('sha256', prk)
      .update(Buffer.concat([previous, Buffer.from(info, 'utf8'), Buffer.from([counter])]))
      .digest()
    okm = Buffer.concat([okm, previous])
  }
  return okm.subarray(0, length)
}

export function encryptBytes(plain, key, type = 2) {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key.enc, iv)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  const base = `${type}.${iv.toString('base64')}|${data.toString('base64')}`
  if (type === 0) return base
  const mac = createHmac('sha256', key.mac).update(Buffer.concat([iv, data])).digest('base64')
  return `${base}|${mac}`
}

export function encryptString(plain, key, type = 2) {
  if (plain === undefined || plain === null) return undefined
  return encryptBytes(Buffer.from(plain, 'utf8'), key, type)
}

/** RSA-2048 OAEP-SHA1 wrapping, i.e. Bitwarden EncString type 4. */
export function rsaWrap(plain, publicKeyObject) {
  const data = publicEncrypt(
    { key: publicKeyObject, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    plain,
  )
  return `4.${data.toString('base64')}`
}

export async function argon2idOrNull() {
  try {
    return (await import('hash-wasm')).argon2id
  } catch {
    return null
  }
}

/** A decode-able (not verified) JWT, as the official clients expect for access tokens. */
export function makeAccessToken({ userId = USER_ID, clientId = 'cli', email = EMAIL, deviceId = 'mock-device' } = {}) {
  const b64u = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const issuedAt = Math.floor(Date.now() / 1000)
  return [
    b64u({ alg: 'HS256', typ: 'JWT' }),
    b64u({
      nbf: issuedAt - 10,
      exp: issuedAt + 3600,
      iss: 'mock-vaultwarden',
      sub: userId,
      premium: true, // TOTP generation is a premium feature in the official client
      email,
      email_verified: true,
      amr: ['Application'],
      client_id: clientId,
      device: deviceId,
      scope: ['api', 'offline_access'],
      security_stamp: 'mock-security-stamp',
    }),
    Buffer.from('mock-signature').toString('base64url'),
  ].join('.')
}

export async function serverMasterKey(password, kdf) {
  if (Number(kdf.kdf) === 1) {
    const argon2id = await argon2idOrNull()
    if (!argon2id) return null
    return Buffer.from(
      await argon2id({
        password,
        salt: EMAIL,
        parallelism: kdf.kdfParallelism ?? 4,
        iterations: kdf.kdfIterations ?? 3,
        // Server side of the same unit: MiB in, KiB to hash-wasm. Keeping this
        // wrong here would make the mock agree with a broken client.
        memorySize: (kdf.kdfMemory ?? 64) * 1024,
        hashLength: 32,
        outputType: 'binary',
      }),
    )
  }
  return pbkdf2Sync(password, EMAIL, kdf.kdfIterations, 32, 'sha256')
}

/** Build the encrypted vault the mock serves, plus the keys it used. */
export async function buildFixtures(options = {}) {
  const kdf = {
    kdf: options.kdf ?? 0,
    kdfIterations: options.kdfIterations ?? ITERATIONS,
    kdfMemory: options.kdfMemory ?? null,
    kdfParallelism: options.kdfParallelism ?? null,
  }
  const password = options.password ?? PASSWORD
  const masterKey = await serverMasterKey(password, kdf)
  if (!masterKey) return null
  const masterStretch = stretchKey(masterKey)

  const userKeyRaw = options.userKeyV2 ? randomBytes(32) : randomBytes(64)
  const userKey = stretchKey(userKeyRaw)
  const encryptedUserKey = encryptBytes(userKeyRaw, masterStretch, 2)

  // Organizations: the org symmetric key is RSA-OAEP wrapped with the account's
  // public key, and each org cipher wraps its own item key with the org key.
  const orgKeyRaw = randomBytes(64)
  const orgKey = stretchKey(orgKeyRaw)
  const { publicKey: rsaPublicKey, privateKey: rsaPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyDer = rsaPrivateKey.export({ type: 'pkcs8', format: 'der' })
  const publicKeyDer = rsaPublicKey.export({ type: 'pkcs1', format: 'der' })
  const orgItemKeyRaw = randomBytes(64)
  const orgItemKey = stretchKey(orgItemKeyRaw)
  const legacyKey = { enc: userKey.enc, mac: null }

  const ciphers = [
    {
      id: 'cipher-github',
      type: 1,
      name: encryptString('GitHub 工作账号', userKey),
      notes: encryptString('SSH 部署密钥在 CI 里', userKey),
      favorite: true,
      folderId: 'folder-work',
      login: {
        username: encryptString('octocat@jindom.cc', userKey),
        password: encryptString('gh-p@ssw0rd-42', userKey),
        totp: encryptString(RFC_URI, userKey),
        uris: [{ uri: encryptString('https://github.com/login', userKey) }],
      },
      fields: [
        { name: encryptString('租户', userKey), value: encryptString('jindom', userKey), type: 0 },
        { name: encryptString('API Token', userKey), value: encryptString('tok_live_abc123', userKey), type: 1 },
      ],
      revisionDate: '2026-01-02T03:04:05.000Z',
    },
    {
      id: 'cipher-db',
      type: 2,
      name: encryptString('生产数据库口令', userKey),
      notes: encryptString('postgres://app:S3cret-DB-Pass@10.0.0.7:5432/prod', userKey),
      login: null,
      fields: [],
      revisionDate: '2026-01-03T03:04:05.000Z',
    },
    {
      id: 'cipher-org',
      type: 1,
      organizationId: 'org-1',
      collectionIds: ['col-1'],
      key: encryptBytes(orgItemKeyRaw, orgKey),
      name: encryptString('共享部署账号', orgItemKey),
      login: {
        username: encryptString('deploy-bot', orgItemKey),
        password: encryptString('deploy-secret-9', orgItemKey),
        uris: [{ uri: encryptString('https://deploy.jindom.cc', orgItemKey) }],
      },
      fields: [{ name: encryptString('环境', orgItemKey), value: encryptString('prod', orgItemKey), type: 0 }],
      revisionDate: '2026-01-04T03:04:05.000Z',
    },
    {
      id: 'cipher-legacy',
      type: 1,
      name: encryptString('老式加密条目', userKey),
      login: {
        username: encryptString('legacy-user', legacyKey, 0),
        password: encryptString('legacy-pass', legacyKey, 0),
      },
      fields: [],
      revisionDate: '2026-01-05T03:04:05.000Z',
    },
  ]

  const folders = [
    { id: 'folder-work', name: encryptString('工作', userKey), revisionDate: '2026-01-01T00:00:00.000Z' },
  ]

  // Truly legacy type-0 (AES-CBC without MAC) cipher strings: our client still
  // reads them, while modern official clients dropped support, so the interop
  // fixture turns them off.
  if (options.legacyCipher === false) {
    const index = ciphers.findIndex((cipher) => cipher.id === 'cipher-legacy')
    if (index >= 0) ciphers.splice(index, 1)
  }

  if (options.orphanCipher) {
    // A cipher from an organization whose key this account cannot unwrap.
    ciphers.push({
      id: 'cipher-orphan-org',
      type: 1,
      organizationId: 'org-unreachable',
      collectionIds: [],
      key: encryptBytes(randomBytes(64), stretchKey(randomBytes(64))),
      name: encryptString('外部组织条目', stretchKey(randomBytes(64))),
      login: { username: null, password: null, uris: [] },
      fields: [],
      revisionDate: '2026-01-06T03:04:05.000Z',
    })
  }

  if (options.repromptCipher) {
    // An item with Bitwarden's "re-prompt" flag: clients must not auto-reveal it.
    ciphers.push({
      id: 'cipher-reprompt',
      type: 1,
      reprompt: 1,
      name: encryptString('需要重新验证的条目', userKey),
      login: {
        username: encryptString('reprompt-user', userKey),
        password: encryptString('reprompt-pass-9', userKey),
      },
      fields: [],
      revisionDate: '2026-01-07T03:04:05.000Z',
    })
  }

  if (options.richCipher) {
    // An item carrying every field a whole-cipher replace can silently drop:
    // passkeys, password history, the URI match policy, an attachment, a
    // password-revision date and the singular legacy `login.uri`. It starts
    // archived so the archive flag is exercised too.
    // The singular legacy `login.uri` holds the very same EncString as
    // `uris[0].uri` on a real account (measured: 433/433 identical), so the
    // fixture shares the ciphertext instead of re-encrypting the plaintext.
    const richLoginUri = encryptString('https://spa.jindom.cc/login', userKey)
    ciphers.push({
      id: 'cipher-rich',
      type: 1,
      name: encryptString('SPA 管理后台', userKey),
      notes: encryptString('单点登录入口', userKey),
      folderId: 'folder-work',
      login: {
        username: encryptString('rich-user', userKey),
        password: encryptString('rich-pass-1', userKey),
        passwordRevisionDate: '2026-01-08T00:00:00.000Z',
        fido2Credentials: [{ credentialId: 'cred-1', rpId: 'spa.jindom.cc' }],
        uri: richLoginUri,
        uris: [
          { uri: richLoginUri, match: 3, uriChecksum: 'checksum-1' },
          { uri: encryptString('https://spa.jindom.cc/sso', userKey), match: 0, uriChecksum: 'checksum-2' },
        ],
      },
      fields: [{ name: encryptString('区域', userKey), value: encryptString('cn-east', userKey), type: 0 }],
      passwordHistory: [
        { password: encryptString('rich-pass-0', userKey), lastUsedDate: '2025-12-01T00:00:00.000Z' },
      ],
      archivedDate: '2026-02-01T00:00:00.000Z',
      attachments: [
        {
          id: 'att-1',
          fileName: encryptString('部署说明.txt', userKey),
          size: '129',
          sizeName: '129 bytes',
          url: 'https://example.invalid/attachments/att-1',
        },
      ],
      revisionDate: '2026-01-08T03:04:05.000Z',
    })
  }

  // A folder renamed *after* the client cached its vault: the entries keep the
  // same folderId, so a snapshot that is not re-read reports the old name.
  if (options.renameFolder) folders[0].name = encryptString(options.renameFolder, userKey)

  return {
    kdf,
    password,
    masterKey,
    masterPasswordHash: hashMasterPassword(masterKey, password),
    encryptedUserKey,
    apiClientId: options.apiClientId ?? `user.${randomUUID()}`,
    apiClientSecret: options.apiClientSecret ?? 'mock-api-secret',
    syncPayload: {
      profile: {
        id: USER_ID,
        name: 'DSH Test',
        email: EMAIL,
        emailVerified: true,
        premium: true,
        premiumFromOrganization: false,
        culture: 'zh-CN',
        twoFactorEnabled: false,
        securityStamp: 'mock-security-stamp',
        forcePasswordReset: false,
        providers: [],
        key: encryptedUserKey,
        privateKey: encryptBytes(privateKeyDer, userKey),
        publicKey: publicKeyDer.toString('base64'),
        kdf: kdf.kdf,
        kdfIterations: kdf.kdfIterations,
        organizations: [
          {
            id: 'org-1',
            name: encryptString('Jindom 运维', userKey),
            key: rsaWrap(orgKeyRaw, rsaPublicKey),
            status: 2,
            type: 0,
            enabled: true,
            usePolicies: true,
            useGroups: false,
            useDirectory: false,
            useEvents: false,
            useTotp: true,
            use2fa: true,
            useApi: true,
            useResetPassword: false,
            usersGetPremium: false,
            selfHost: true,
            seats: 5,
            maxCollections: null,
            maxStorageGb: 1,
            hasPublicAndPrivateKeys: true,
            providerId: null,
            providerName: null,
          },
        ],
      },
      ciphers,
      folders,
      collections: [{ id: 'col-1', organizationId: 'org-1', name: encryptString('运维', userKey) }],
    },
  }
}

/**
 * Start the mock server.
 * @param {object} [options] - KDF / key-shape options forwarded to {@link buildFixtures}.
 * @param {number} [options.port] - fixed port (defaults to an ephemeral one).
 * @param {{key: string, cert: string}} [options.tls] - serve HTTPS (the official CLI refuses http).
 * @returns {Promise<null | {url: string, port: number, stats: object, fixtures: object, close: () => Promise<void>}>}
 */
export async function startMockServer(options = {}) {
  const fixtures = await buildFixtures(options)
  if (!fixtures) return null
  const { kdf, masterPasswordHash, encryptedUserKey, syncPayload, apiClientId, apiClientSecret } = fixtures

  const stats = { tokenGrants: [], refreshes: 0, syncs: 0, tokenIssued: 0, paths: [], deviceIdentifiers: [], created: 0, mutations: [], twoFactorChallenges: 0, twoFactorAccepted: 0, revisionChecks: 0, lastWrite: null }
  // The account revision the vault cache probes. Real Vaultwarden bumps
  // `users.updated_at` whenever a cipher or folder is written, so the mutations
  // below move it too — that is what makes the probe worth trusting.
  let revision = Date.parse('2026-01-01T00:00:00.000Z')
  let revisionFails = false
  const bumpRevision = () => {
    revision = Math.max(Date.now(), revision + 1)
    return revision
  }
  const tokens = new Map()
  const hubSockets = new Set()
  const hubStats = { connections: 0, messages: 0, notifications: 0 }

  const handler = (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      stats.paths.push(`${req.method} ${req.url}`)
      if (process.env.MOCK_TRACE) console.error(`[mock] ${req.method} ${req.url} ${body.slice(0, 160)}`)
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const form = new URLSearchParams(body)

      if (req.url.startsWith('/api/config')) {
        return send(200, { version: 'mock-2026.6.0', server: { name: 'MockVaultwarden' }, environment: {} })
      }

      // SignalR negotiate: the hub also accepts a bare access token, but real
      // clients always negotiate first.
      if (req.url.startsWith('/notifications/hub/negotiate')) {
        return send(200, {
          negotiateVersion: 1,
          connectionToken: 'mock-connection-token',
          connectionId: 'mock-connection-id',
          availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text'] }],
        })
      }

      // Both the legacy path and the newer `/password` path answer identically.
      if (req.url.startsWith('/identity/accounts/prelogin')) {
        let requested = EMAIL
        try {
          if (body) requested = JSON.parse(body).email ?? EMAIL
        } catch {
          requested = form.get('email') ?? EMAIL
        }
        if (String(requested).toLowerCase() !== EMAIL) return send(404, { message: 'not found' })
        return send(200, {
          ...kdf,
          kdfSettings: { iterations: kdf.kdfIterations, kdfType: kdf.kdf },
          // Newer SDK prelogin shape.
          kdfConfig: { kdfType: kdf.kdf, iterations: kdf.kdfIterations },
        })
      }

      if (req.url.startsWith('/identity/connect/token') && req.method === 'POST') {
        const grant = form.get('grant_type')
        stats.tokenGrants.push(grant)
        const issue = (clientId = 'cli') => {
          stats.tokenIssued++
          const deviceId = form.get('deviceIdentifier') ?? 'mock-device'
          stats.deviceIdentifiers.push(deviceId)
          const accessToken = makeAccessToken({ clientId, deviceId })
          const refreshToken = `refresh-${stats.tokenIssued}`
          tokens.set(accessToken, refreshToken)
          return send(200, {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 3600,
            token_type: 'Bearer',
            Key: encryptedUserKey,
            Kdf: kdf.kdf,
            KdfIterations: kdf.kdfIterations,
            KdfMemory: kdf.kdfMemory,
            KdfParallelism: kdf.kdfParallelism,
            // Newer clients require the master-password unlock data.
            UserDecryptionOptions: {
              Object: 'userDecryptionOptions',
              HasMasterPassword: true,
              MasterPasswordUnlock: {
                Salt: EMAIL,
                Kdf: {
                  KdfType: kdf.kdf,
                  Iterations: kdf.kdfIterations,
                  Memory: kdf.kdfMemory,
                  Parallelism: kdf.kdfParallelism,
                },
                MasterKeyEncryptedUserKey: encryptedUserKey,
              },
            },
          })
        }
        if (grant === 'password') {
          if (String(form.get('username')).toLowerCase() !== EMAIL) {
            return send(400, { error: 'invalid_grant', error_description: 'Username or password is incorrect' })
          }
          if (form.get('password') !== masterPasswordHash) {
            return send(400, { error: 'invalid_grant', error_description: 'Username or password is incorrect' })
          }
          if (!form.get('client_id') || !form.get('deviceIdentifier')) {
            return send(400, { error: 'invalid_request', error_description: 'missing client_id/deviceIdentifier' })
          }
          // Two-factor accounts, mirroring vaultwarden's `twofactor_auth`:
          // the refused grant answers with the provider list ONLY (no
          // server-issued token); the retry re-sends the whole password grant
          // with the user's code in `two_factor_token`.
          if (options.twoFactor) {
            const code = form.get('twoFactorToken')
            if (!code) {
              stats.twoFactorChallenges++
              return send(400, {
                error: 'invalid_grant',
                error_description: 'Two factor required.',
                TwoFactorProviders: [0],
                TwoFactorProviders2: { 0: null },
              })
            }
            if (code !== TWO_FACTOR_CODE) {
              return send(400, { error: 'invalid_grant', error_description: 'Two factor code is invalid' })
            }
            stats.twoFactorAccepted++
          }
          return issue(form.get('client_id') ?? 'cli')
        }
        if (grant === 'client_credentials') {
          if (form.get('client_id') !== apiClientId || form.get('client_secret') !== apiClientSecret) {
            return send(400, { error: 'invalid_client', error_description: 'client_id or client_secret is incorrect' })
          }
          return issue(form.get('client_id') ?? 'cli')
        }
        if (grant === 'refresh_token') {
          if (![...tokens.values()].includes(form.get('refresh_token'))) {
            return send(400, { error: 'invalid_grant', error_description: 'refresh token is invalid' })
          }
          stats.refreshes++
          return issue(form.get('client_id') ?? 'cli')
        }
        return send(400, { error: 'unsupported_grant_type' })
      }

      if (req.url.startsWith('/api/accounts/profile')) {
        const auth = req.headers.authorization ?? ''
        if (!tokens.has(auth.replace(/^Bearer /, ''))) return send(401, { message: 'Unauthorized' })
        return send(200, syncPayload.profile)
      }

      // A cold start asks for the account revision first: 13 bytes instead of
      // the whole vault.
      if (req.url.startsWith('/api/accounts/revision-date')) {
        const auth = req.headers.authorization ?? ''
        if (!tokens.has(auth.replace(/^Bearer /, ''))) return send(401, { message: 'Unauthorized' })
        stats.revisionChecks++
        if (revisionFails) return send(500, { message: 'revision unavailable' })
        return send(200, revision)
      }

      if (req.url.startsWith('/api/sync')) {
        const auth = req.headers.authorization ?? ''
        if (!tokens.has(auth.replace(/^Bearer /, ''))) return send(401, { message: 'Unauthorized' })
        stats.syncs++
        return send(200, syncPayload)
      }

      // ── cipher mutations (create / update / delete / restore / purge) ──────
      // The mock stores the encrypted bodies verbatim, so a write-back test
      // exercises the real encrypt → transport → sync → decrypt round trip.
      if (req.url.startsWith('/api/ciphers')) {
        const auth = req.headers.authorization ?? ''
        if (!tokens.has(auth.replace(/^Bearer /, ''))) return send(401, { message: 'Unauthorized' })
        const ciphers = fixtures.syncPayload.ciphers
        const folders = fixtures.syncPayload.folders
        // Guard rails the real server also has, so a regression in the plugin
        // shows up here instead of only on the wire. `lastKnownRevisionDate`
        // is request-only and `encryptedFor` is a wire field the 1.37.x
        // server does not know; neither belongs in the stored row, but the
        // tests want to see what was sent.
        const remember = (method, path, incoming) => {
          stats.lastWrite = { method, path, body: incoming }
          const { lastKnownRevisionDate, encryptedFor, ...rest } = incoming
          return rest
        }
        if (req.method === 'POST' && req.url === '/api/ciphers/create') {
          // ShareCipherData: { cipher, collectionIds } — the organization create path.
          const incoming = JSON.parse(body || '{}')
          if (!incoming.cipher?.type || !incoming.cipher?.name) return send(400, { message: 'Data missing' })
          if (!incoming.cipher.organizationId) {
            return send(400, { message: 'Organization mismatch. Please resync the client before updating the cipher' })
          }
          stats.created++
          const created = {
            ...remember('POST', req.url, incoming.cipher),
            id: `cipher-created-${stats.created}`,
            collectionIds: incoming.collectionIds ?? [],
            revisionDate: new Date().toISOString(),
          }
          ciphers.push(created)
          bumpRevision()
          stats.mutations.push('create')
          return send(200, created)
        }
        if (req.method === 'POST' && req.url === '/api/ciphers') {
          const incoming = JSON.parse(body || '{}')
          // Real Vaultwarden stores the cipher body as sent and derives the
          // row from it; a body that forgets the type/name is rejected there
          // too (tag 1.37.3 :507-526 "Invalid type" / "Data missing").
          if (!incoming.type) return send(400, { message: 'Data missing' })
          if (!incoming.name) return send(400, { message: 'Data missing' })
          stats.created++
          const created = {
            ...remember('POST', req.url, incoming),
            id: `cipher-created-${stats.created}`,
            revisionDate: new Date().toISOString(),
          }
          ciphers.push(created)
          bumpRevision()
          stats.mutations.push('create')
          return send(200, created)
        }
        const match = req.url.match(/^\/api\/ciphers\/([^/]+)(\/(delete|restore))?$/)
        if (match) {
          const id = decodeURIComponent(match[1])
          const action = match[2]
          const index = ciphers.findIndex((cipher) => cipher.id === id)
          if (index < 0) return send(404, { message: 'Cipher not found' })
          if (req.method === 'PUT' && !action) {
            const incoming = JSON.parse(body || '{}')
            // Optimistic concurrency, same rule as the real server: a stale
            // `lastKnownRevisionDate` is rejected with 400 (tag 1.37.3
            // src/api/core/ciphers.rs:420-432, 1s tolerance).
            if (incoming.lastKnownRevisionDate) {
              const known = Date.parse(incoming.lastKnownRevisionDate)
              const current = Date.parse(ciphers[index].revisionDate)
              if (Number.isFinite(known) && Number.isFinite(current) && Math.abs(current - known) > 1000) {
                return send(400, { message: 'The client copy of this cipher is out of date. Resync the client and try again.' })
              }
            }
            if (incoming.folderId && !folders.some((folder) => folder.id === incoming.folderId)) {
              return send(400, { message: 'Invalid folder' })
            }
            // The real API replaces the whole cipher; merging would leave
            // stale fields encrypted under the previous per-item key. A body
            // without `folderId` moves the item out of its folder — the server
            // reads folder_id through `deser_opt_nonempty_str` and then calls
            // move_to_folder(None) (tag 1.37.3 src/api/core/ciphers.rs:475-479,
            // :537), so the stored row has no folder_id at all.
            const updated = { ...remember('PUT', req.url, incoming), id, revisionDate: new Date().toISOString() }
            if (!updated.folderId) delete updated.folderId
            // Attachments live in their own table on the real server and a
            // cipher PUT never removes one — it only rewrites a key when the
            // request carries `attachments2` (tag 1.37.3
            // src/api/core/ciphers.rs:482-505). Carrying the row's attachments
            // over keeps the mock honest about that.
            if (ciphers[index].attachments && !updated.attachments) {
              updated.attachments = ciphers[index].attachments
            }
            ciphers[index] = updated
            bumpRevision()
            stats.mutations.push('update')
            return send(200, updated)
          }
          if (req.method === 'POST' && action === '/delete') {
            // Real Vaultwarden: POST /ciphers/{id}/delete is the *permanent*
            // hard delete (tag 1.37.3 src/api/core/ciphers.rs:1455-1465,
            // "// permanent delete"); PUT is the soft delete. The mock used to
            // soft-delete here, which is what let the plugin's wrong-endpoint
            // bug stay green for a whole release.
            ciphers.splice(index, 1)
            bumpRevision()
            stats.mutations.push('purge')
            return send(200, {})
          }
          if (req.method === 'PUT' && action === '/delete') {
            ciphers[index] = { ...ciphers[index], deletedDate: new Date().toISOString() }
            bumpRevision()
            stats.mutations.push('delete')
            return send(200, ciphers[index])
          }
          if (req.method === 'PUT' && action === '/restore') {
            const { deletedDate, ...rest } = ciphers[index]
            ciphers[index] = { ...rest, revisionDate: new Date().toISOString() }
            bumpRevision()
            stats.mutations.push('restore')
            return send(200, ciphers[index])
          }
          if (req.method === 'DELETE' && !action) {
            ciphers.splice(index, 1)
            bumpRevision()
            stats.mutations.push('purge')
            return send(200, {})
          }
          return send(405, { message: 'method not allowed' })
        }
        return send(404, { message: 'not found' })
      }

      // Anything else a real client might ask for: answer emptily instead of 404,
      // so the CLI's post-login bookkeeping does not abort the interop run.
      if (req.url.startsWith('/api/')) return send(200, {})

      send(404, { message: 'not found' })
    })
  }

  const server = options.tls
    ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handler)
    : createHttpServer(handler)

  // ── /notifications/hub WebSocket endpoint ──────────────────────────────────
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/notifications/hub')) {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${WS_GUID}`).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    )
    hubStats.connections++
    hubSockets.add(socket)

    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        const opcode = buffer[0] & 0x0f
        const masked = (buffer[1] & 0x80) !== 0
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        const maskOffset = offset
        if (masked) offset += 4
        if (buffer.length < offset + length) return
        let payload = buffer.subarray(offset, offset + length)
        if (masked) {
          const mask = buffer.subarray(maskOffset, maskOffset + 4)
          const unmasked = Buffer.alloc(length)
          for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ mask[i % 4]
          payload = unmasked
        }
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x8) {
          socket.end()
          return
        }
        if (opcode !== 0x1) continue // binary/continuation frames are unused here
        hubStats.messages++
        const frame = payload.toString('utf8').split(RS)[0]
        let message
        try {
          message = JSON.parse(frame)
        } catch {
          continue
        }
        if (message?.protocol === 'json') {
          socket.write(wsFrame('{}' + RS)) // SignalR handshake ack
        } else if (message?.type === 6) {
          socket.write(wsFrame(JSON.stringify({ type: 6 }) + RS)) // keepalive ping → pong
        }
      }
    })
    const drop = () => hubSockets.delete(socket)
    socket.on('close', drop)
    socket.on('error', drop)
  })

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    stats,
    hubStats,
    /** The account revision the mock currently reports. */
    revision: () => revision,
    /** Move the account revision the way a real write would. */
    bumpRevision,
    /** Make the revision endpoint fail, to exercise the cache's fallback. */
    failRevision: (flag = true) => {
      revisionFails = Boolean(flag)
    },
    fixtures,
    /** Push a Bitwarden NotificationType to every connected hub client. */
    notify: (type = 1, extra = {}) => {
      hubStats.notifications++
      const message = JSON.stringify({ type: 1, target: 'ReceiveMessage', arguments: [{ Type: type, ...extra }] }) + RS
      for (const socket of hubSockets) socket.write(wsFrame(message))
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
