/**
 * Cipher write-back for Vaultwarden / Bitwarden.
 *
 * Implements the mutation half of the client API, symmetric to the read path
 * in `vault.js`:
 *
 *   POST   /api/ciphers              create a user-owned cipher
 *   POST   /api/ciphers/create       create an org-owned cipher (cipher + collectionIds)
 *   PUT    /api/ciphers/{id}         update one (full replacement)
 *   PUT    /api/ciphers/{id}/delete  soft delete: into the trash
 *   DELETE /api/ciphers/{id}         permanent delete
 *   PUT    /api/ciphers/{id}/restore restore from the trash
 *
 * The delete verbs are NOT interchangeable. On Vaultwarden the delete route
 * maps method → semantics as (tag 1.37.3 src/api/core/ciphers.rs:1440-1500):
 * PUT → SoftSingle ("// soft delete"), POST → HardSingle ("// permanent
 * delete"), DELETE → HardSingle. Writing `POST` for a normal delete destroys
 * the cipher with nothing left to restore — which is what this module used to
 * do, while telling the caller it had gone to the trash.
 *
 * ## How a write is built
 *
 * Bitwarden never encrypts a cipher's fields with the account key. Each item
 * carries its own 64-byte key (`cipher.key`, wrapped with the user key — or,
 * for an organization item, with the organization key), and every other
 * ciphertext in the item is encrypted with that key.
 *
 * The server stores the type payload verbatim: for type 1 it is
 * `cipher.data = type_data.to_string()` (tag 1.37.3 :532), i.e. whatever the
 * request left out is gone from the database, and `password_history` /
 * `archived_date` follow the same rule (:533, :540-546). So regenerating the
 * item key on every write — the old behaviour — silently dropped every field
 * the request did not repeat: `login.fido2Credentials`, `passwordHistory`,
 * `login.passwordRevisionDate`, the legacy `login.uri`, `login.uris[].match`
 * and `archivedDate`.
 *
 * This module therefore starts from the server's own object (kept by
 * `decryptVault` as `vault.raw`), re-encrypts only the fields the caller
 * changed, and hands every other key back byte for byte. The item key is
 * reused, not rotated.
 *
 * Every mutation ends with a `syncNow()` so the in-memory vault the tools read
 * reflects the change immediately. A failed sync no longer fails the write —
 * the server has already accepted it, and a retry would create a duplicate.
 * The result carries `syncWarning` instead.
 */
import { randomBytes } from 'node:crypto'
import {
  VaultError,
  httpJson,
  authHeaders,
  decryptEncString,
  stretchKey,
  encryptString,
} from './vault.js'

const fail = (message, code, hint) => {
  throw new VaultError(message, { code, hint })
}

const enc = (value, key) => encryptString(value, key)

/** Own-property test: "the caller said something about this field". */
const has = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key)

/** Bitwarden CipherType numbers ←→ the names used in projections and tools. */
export const CIPHER_TYPES = { login: 1, secureNote: 2, card: 3, identity: 4, sshKey: 5 }
const TYPE_NAMES = { 1: 'login', 2: 'secureNote', 3: 'card', 4: 'identity', 5: 'sshKey' }
/** The object key the server reads the type payload from (`data.login`, …). */
const PAYLOAD_KEY = { 1: 'login', 2: 'secureNote', 3: 'card', 4: 'identity', 5: 'sshKey' }
/** Plaintext fields of a login payload (all encrypted with the item key). */
const LOGIN_FIELDS = ['username', 'password', 'totp']
// SecureNoteData is the one type payload whose field is plain JSON instead of an
// EncString: the server stores the object verbatim and official clients read
// `secureNote.type` as a number (Bitwarden's SecureNoteType, generic = 0), so
// encrypting it would hand every other client a garbage string.
const PLAIN_PAYLOAD_KEYS = { 2: new Set(['type']) }
/** Official clients keep at most five historical passwords (cipher.service.ts:1725-1729). */
const MAX_PASSWORD_HISTORY = 5

/** Accept 1-5 or a type name; anything else is a caller bug worth reporting. */
function typeNumberOf(value) {
  if (value === undefined || value === null || value === '') return 1
  const name = String(value).replace(/_/g, '')
  for (const [number, label] of Object.entries(TYPE_NAMES)) {
    if (label.toLowerCase() === name.toLowerCase()) return Number(number)
  }
  const number = Number(value)
  if (TYPE_NAMES[number]) return number
  fail(
    `不支持的条目类型：${value}`,
    'bad_request',
    'type 可用 1-5，或 login / secureNote / card / identity / sshKey',
  )
}

/**
 * Turn a server error body into something an agent can act on. Returns null
 * when the message is not one this module knows how to explain.
 */
function translateWriteError(detail) {
  const text = String(detail ?? '')
  if (/out of date/i.test(text)) {
    return {
      message: '条目已被其他客户端修改，请重新读取后再试',
      code: 'stale_revision',
      hint: '本次修改未生效：先用 bitwarden_get 取回最新内容，再决定怎么改',
    }
  }
  if (/Invalid user cipher/i.test(text)) {
    return {
      message: '服务端拒绝了写入（encryptedFor 校验不通过）',
      code: 'protocol_mismatch',
      hint: '服务端版本比插件预期的更新，请升级 dsh-vaultwarden 插件',
    }
  }
  if (/Invalid folder/i.test(text)) {
    return {
      message: 'folderId 无效：该文件夹不存在或不属于本账户',
      code: 'bad_folder',
      hint: '用 bitwarden_folders 取有效的文件夹 id，或用 folderId: null 移出文件夹',
    }
  }
  if (/personal ownership/i.test(text)) {
    return {
      message: '组织策略禁止向个人库写入条目（Personal Ownership 政策）',
      code: 'policy_denied',
      hint: '该账户属于启用了个人所有权政策的组织，写入个人库被管理员禁用',
    }
  }
  if (/permission to add cipher|not write accessible|No rights to modify/i.test(text)) {
    return {
      message: '没有权限修改该条目（组织/集合权限不足）',
      code: 'forbidden',
      hint: '确认该账户是该组织的成员，并且对目标集合有写权限',
    }
  }
  if (/Organization mismatch/i.test(text)) {
    return {
      message: '条目的组织归属已变化，请重新同步后再试',
      code: 'stale_revision',
      hint: '本次修改未生效：条目可能已被转移到组织或个人库',
    }
  }
  if (/Data missing/i.test(text)) {
    return {
      message: '写入被拒绝：该类型的载荷为空',
      code: 'bad_request',
      hint: '服务端要求请求里带上与 type 对应的载荷对象',
    }
  }
  return null
}

/**
 * Build the cipher body for a create/update request.
 *
 * @param {object} options
 * @param {object|null} options.raw - the server's own cipher object (null on create)
 * @param {number|string} options.type - 1-5 or a type name
 * @param {object} options.plain - plaintext values; only the keys present are
 *   re-encrypted, everything else is carried over from `raw`
 * @param {{enc: Buffer, mac: Buffer}} options.itemKey - the (reused or fresh) item key
 * @param {string|undefined} options.cipherKey - the wrapped item key to send
 * @param {string|undefined} options.encryptedFor - current user uuid
 * @param {string|undefined} options.lastKnownRevisionDate - optimistic lock
 * @returns {object} the body, ready to POST/PUT
 */
export function buildCipherBody({
  raw = null,
  type,
  plain = {},
  itemKey,
  cipherKey,
  encryptedFor,
  lastKnownRevisionDate,
}) {
  const number = typeNumberOf(type)
  const payloadKey = PAYLOAD_KEY[number]
  const rawPayload =
    raw && raw[payloadKey] && typeof raw[payloadKey] === 'object' ? raw[payloadKey] : {}

  const body = {
    type: number,
    name: enc(plain.name, itemKey),
    favorite: Boolean(plain.favorite),
    reprompt: Number(plain.reprompt ?? 0),
  }
  if (plain.notes !== undefined) body.notes = enc(plain.notes, itemKey)
  if (cipherKey) body.key = cipherKey

  // ── the type payload: carry the server's copy, replace what changed --------
  /** @type {Record<string, unknown>} */
  const payload = { ...rawPayload }
  const plainKeys = PLAIN_PAYLOAD_KEYS[number]
  for (const [field, value] of Object.entries(plain.payload ?? {})) {
    if (plainKeys?.has(field)) {
      if (value === null || value === undefined) delete payload[field]
      else payload[field] = Number(value)
      continue
    }
    // `encryptString` maps ''/null to undefined: an explicitly empty value
    // means "remove this key", which is the only way the server drops it.
    const cipher = Object.is(value, null) ? undefined : enc(value, itemKey)
    if (cipher === undefined) delete payload[field]
    else payload[field] = cipher
  }
  if (has(plain, 'uris')) {
    const previous = Array.isArray(rawPayload.uris) ? rawPayload.uris : []
    const uris = (plain.uris ?? [])
      .map((uri, index) => {
        // Keep the untouched keys of the entry (`match`, `uriChecksum`): the
        // match policy is the user's choice, not something to reset to null.
        const kept = previous[index] && typeof previous[index] === 'object' ? { ...previous[index] } : {}
        kept.uri = enc(String(uri), itemKey)
        if (!has(kept, 'match')) kept.match = null
        return kept
      })
      .filter((entry) => entry.uri)
    if (uris.length) payload.uris = uris
    else delete payload.uris
    // Vaultwarden-era clients kept a second copy of the first URI in the
    // singular `login.uri`; keep the two in step whenever the list changes.
    if (has(payload, 'uri')) {
      if (uris.length) payload.uri = uris[0].uri
      else delete payload.uri
    }
  }
  body[payloadKey] = payload

  // ── fields: verbatim unless the caller replaced the list ------------------
  if (has(plain, 'fields')) {
    body.fields = (plain.fields ?? [])
      .filter((field) => field && (field.name || field.value))
      .map((field) => ({
        name: enc(field.name ?? '', itemKey),
        value: enc(field.value ?? '', itemKey),
        type: Number(field.type ?? 0),
      }))
  } else if (Array.isArray(raw?.fields)) {
    body.fields = raw.fields
  }

  // ── the rest of the cipher: pass through, never drop ----------------------
  if (has(plain, 'folderId')) {
    // null (and '') means "move out of the folder": the server reads
    // folder_id through `deser_opt_nonempty_str`, so both arrive as None,
    // and `move_to_folder(None)` is the removal (tag 1.37.3 :475-479, :537).
    body.folderId = plain.folderId === null || plain.folderId === '' ? null : String(plain.folderId)
  } else if (raw && has(raw, 'folderId')) {
    body.folderId = raw.folderId
  }
  const history = plain.passwordHistory ?? raw?.passwordHistory
  if (history) body.passwordHistory = history
  const archived = has(plain, 'archivedDate') ? plain.archivedDate : raw?.archivedDate
  if (archived) body.archivedDate = archived
  if (raw && raw.organizationId) body.organizationId = raw.organizationId
  if (encryptedFor) body.encryptedFor = encryptedFor
  if (lastKnownRevisionDate) body.lastKnownRevisionDate = lastKnownRevisionDate
  return body
}

/**
 * Build a brand new personal login cipher (the P0-2/P0-5 path without a raw
 * object to start from). Kept as a named export for the write-back tests.
 */
export function buildLoginCipher(input, userKey) {
  if (!input?.name) fail('缺少条目名称', 'bad_request', '创建条目至少需要 name')
  const itemKeyRaw = randomBytes(64)
  const itemKey = stretchKey(itemKeyRaw)
  const payload = {}
  for (const field of LOGIN_FIELDS) if (input[field]) payload[field] = input[field]
  const plain = {
    name: input.name,
    notes: input.notes,
    favorite: Boolean(input.favorite),
    reprompt: Number(input.reprompt ?? 0),
    fields: input.fields,
    payload,
  }
  if (has(input, 'uris')) plain.uris = input.uris
  if (input.folderId) plain.folderId = String(input.folderId)
  return buildCipherBody({ type: 1, plain, itemKey, cipherKey: encryptString(itemKeyRaw, userKey) })
}

export class VaultMutations {
  /**
   * @param {import('./vault.js').VaultClient} client
   * @param {{guard?: (action: string) => ({message: string, code: string, hint?: string}|null)}} [options]
   *   `guard` runs before every state-changing call. The write-permission gate
   *   belongs here, next to the request, because the model tools are not the
   *   only caller — the gateway RPCs reach the same code.
   */
  constructor(client, options = {}) {
    this.client = client
    this.guard = options.guard ?? null
  }

  /** Throws when the configured write permission forbids this action. */
  #authorize(action) {
    if (!this.guard) return
    const refusal = this.guard(action)
    if (refusal) fail(refusal.message, refusal.code, refusal.hint)
  }

  /** One authenticated JSON call against `/api/*`. */
  async #send(method, path, body, signal) {
    const { token } = await this.client.unlockKeys(signal)
    const headers = { ...authHeaders(token.accessToken), 'content-type': 'application/json' }
    const { ok, status, json } = await httpJson(this.client.fetch, `${this.client.server}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    if (!ok) {
      const detail = json?.message ?? json?.error ?? `HTTP ${status}`
      const translated = translateWriteError(detail)
      if (translated) fail(translated.message, translated.code, translated.hint)
      fail(
        `写回失败：${detail}`,
        status === 401 ? 'unauthorized' : 'http_error',
        status === 401 ? '会话已失效，请重新登录凭据库' : '检查权限与网络后重试',
      )
    }
    return json ?? {}
  }

  /**
   * Refresh the in-memory vault. Returns an error message instead of throwing:
   * the write already landed, and reporting it as a failure invites a retry
   * that would create a second copy.
   */
  async #sync(signal) {
    try {
      await this.client.syncNow(signal)
      return null
    } catch (error) {
      return error.message
    }
  }

  /** The vault object, or a clear error when the session predates `raw`. */
  async #vault(signal) {
    const vault = await this.client.unlock(signal)
    if (!vault.raw) {
      fail(
        '会话缺少原始密文（vault.raw），无法安全写回',
        'internal',
        '请先 bitwarden_sync 重新同步一次',
      )
    }
    return vault
  }

  /** The server's own object for one cipher, trashed entries included. */
  #raw(vault, id) {
    return vault.raw.get(String(id)) ?? null
  }

  /** The key the item's own key is wrapped with: org key, or the user key. */
  #baseKey(vault, raw, userKey) {
    const organizationId = raw?.organizationId
    if (!organizationId) return userKey
    const orgKey = vault.orgKeys?.get(organizationId)
    if (!orgKey) {
      fail(
        `组织 ${organizationId} 的组织密钥不可用，无法解密/加密该条目`,
        'missing_org_key',
        '该账户可能不是该组织的成员，或服务端没有下发组织密钥',
      )
    }
    return orgKey
  }

  /**
   * The item key to encrypt with. Reuses the existing one — rotating it would
   * make every ciphertext the request does not repeat unreadable, which is
   * exactly the silent field loss this module exists to avoid.
   */
  #itemKeyOf(raw, baseKey) {
    if (!raw?.key) {
      // A cipher written before per-item keys: its fields were encrypted with
      // the account key directly. Keep that scheme instead of inventing a
      // half-migration we cannot complete for unknown fields.
      return { itemKey: baseKey, cipherKey: undefined }
    }
    let itemKeyRaw
    try {
      itemKeyRaw = decryptEncString(raw.key, baseKey.enc, baseKey.mac)
    } catch (error) {
      fail(
        `无法解开条目的 item key，写回已中止：${error.message}`,
        'bad_item_key',
        '该条目可能属于另一个账户，或用本插件不支持的加密方式保存',
      )
    }
    if (itemKeyRaw.length !== 64 && itemKeyRaw.length !== 32) {
      fail(`条目 item key 长度异常（${itemKeyRaw.length} 字节），写回已中止`, 'bad_item_key')
    }
    return { itemKey: stretchKey(itemKeyRaw), cipherKey: raw.key }
  }

  /** Locate a live cipher: its projection (plaintext) and its raw object. */
  async #locate(id, signal) {
    const vault = await this.#vault(signal)
    const item = vault.byId.get(String(id))
    if (!item) {
      fail(
        `凭据库中没有 id 为 ${id} 的条目`,
        'not_found',
        '先 bitwarden_find 取 id；回收站里的条目要用 includeTrashed 才看得到',
      )
    }
    const raw = this.#raw(vault, id)
    if (!raw) fail(`服务端载荷里没有 id 为 ${id} 的条目`, 'not_found')
    return { vault, item, raw }
  }

  /** Locate by raw object only (delete/restore work on trashed entries too). */
  async #locateAny(id, signal) {
    const vault = await this.#vault(signal)
    const raw = this.#raw(vault, id)
    if (!raw) {
      fail(
        `凭据库中没有 id 为 ${id} 的条目`,
        'not_found',
        'id 可能已过期（条目被彻底删除），先用 bitwarden_find 确认',
      )
    }
    return { vault, raw, item: vault.byId.get(String(id)) ?? null }
  }

  /** Plaintext payload overrides for a create request. */
  #createPayload(type, input) {
    const kind = TYPE_NAMES[type]
    const payload = {}
    if (kind === 'login') {
      for (const field of LOGIN_FIELDS) if (has(input, field)) payload[field] = input[field]
    } else if (kind === 'secureNote') {
      if (input.secureNote && typeof input.secureNote === 'object' && has(input.secureNote, 'type')) {
        payload.type = Number(input.secureNote.type ?? 0)
      }
    } else if (input[kind] && typeof input[kind] === 'object') {
      for (const [field, value] of Object.entries(input[kind])) payload[field] = value
    }
    return payload
  }

  /**
   * Create one cipher (login / secureNote / card / identity / sshKey).
   * Returns `{ id, name, type, created, revisionDate, syncWarning? }`.
   *
   * An organization item is created through `POST /api/ciphers/create`
   * (ShareCipherData) with its item key wrapped by the organization key;
   * posting an organizationId to `/api/ciphers` is refused unless the caller
   * already has full access to the organization (tag 1.37.3 :446-473).
   */
  async create(input = {}, signal) {
    this.#authorize('create')
    const type = typeNumberOf(input.type)
    const name = String(input.name ?? '').trim()
    if (!name) fail('缺少条目名称', 'bad_request', '创建条目至少需要 name')
    const vault = await this.#vault(signal)
    const organizationId = input.organizationId ? String(input.organizationId) : null
    const userKey = organizationId ? null : (await this.client.unlockKeys(signal)).userKey
    const baseKey = this.#baseKey(vault, organizationId ? { organizationId } : null, userKey)
    const itemKeyRaw = randomBytes(64)
    const itemKey = stretchKey(itemKeyRaw)
    const plain = {
      name,
      notes: input.notes ?? undefined,
      favorite: Boolean(input.favorite),
      reprompt: Number(input.reprompt ?? 0),
      fields: has(input, 'fields') ? input.fields : undefined,
      payload: this.#createPayload(type, input),
    }
    if (type === 1 && has(input, 'uris')) plain.uris = input.uris
    if (input.folderId !== undefined && input.folderId !== null) plain.folderId = String(input.folderId)
    const body = buildCipherBody({
      type,
      plain,
      itemKey,
      cipherKey: encryptString(itemKeyRaw, baseKey),
      encryptedFor: vault.profileId ?? undefined,
    })
    let created
    if (organizationId) {
      body.organizationId = organizationId
      created = await this.#send(
        'POST',
        '/api/ciphers/create',
        { cipher: body, collectionIds: (input.collectionIds ?? []).map(String) },
        signal,
      )
    } else {
      created = await this.#send('POST', '/api/ciphers', body, signal)
    }
    const syncWarning = await this.#sync(signal)
    return {
      id: created.id ?? null,
      name,
      type: TYPE_NAMES[type],
      created: true,
      revisionDate: created.revisionDate ?? null,
      ...(syncWarning ? { syncWarning } : {}),
    }
  }

  /**
   * Update one cipher. Only the fields the caller names change; everything
   * else — including keys this module does not know about — is carried over
   * from the server's copy.
   *
   * `folderId` is tri-state: absent leaves the folder alone, `null` moves the
   * item out of its folder, an id moves it in. `archived` toggles the archive
   * flag (the server un-archives whenever `archivedDate` is absent, so an
   * unrelated edit would otherwise drag the item back into the main list).
   */
  async update(id, input = {}, signal) {
    this.#authorize('update')
    const { vault, item, raw } = await this.#locate(id, signal)
    const type = typeNumberOf(item.type)
    const kind = TYPE_NAMES[type]
    const name = has(input, 'name') ? String(input.name ?? '') : item.name
    if (!name) fail('条目名称不能为空', 'bad_request', '要清空名称请改用其他字段表达')

    const auth = await this.client.unlockKeys(signal)
    const baseKey = this.#baseKey(vault, raw, auth.userKey)
    const { itemKey, cipherKey } = this.#itemKeyOf(raw, baseKey)

    const plain = {
      name,
      notes: has(input, 'notes') ? (input.notes ?? null) : item.notes,
      favorite: has(input, 'favorite') ? Boolean(input.favorite) : Boolean(item.favorite),
      reprompt: has(input, 'reprompt') ? Number(input.reprompt) : Number(item.reprompt ?? 0),
      payload: {},
    }
    if (has(input, 'fields')) plain.fields = input.fields
    plain.folderId = has(input, 'folderId')
      ? input.folderId === null || input.folderId === ''
        ? null
        : String(input.folderId)
      : (item.folderId ?? null)
    if (has(input, 'archived')) {
      plain.archivedDate = input.archived
        ? (raw.archivedDate ?? new Date(this.client.now()).toISOString())
        : null
    }
    if (has(input, 'uris')) plain.uris = input.uris ?? []

    if (kind === 'login') {
      for (const field of LOGIN_FIELDS) if (has(input, field)) plain.payload[field] = input[field]
      if (has(input, 'password') && input.password && input.password !== item.password) {
        plain.payload.passwordRevisionDate = new Date(this.client.now()).toISOString()
        // Keep the outgoing password, the way official clients do, so
        // "what was the old password" still has an answer afterwards.
        const previous = raw.login?.password
        if (previous && cipherKey === raw.key) {
          const history = Array.isArray(raw.passwordHistory) ? raw.passwordHistory : []
          plain.passwordHistory = [
            { password: previous, lastUsedDate: plain.payload.passwordRevisionDate },
            ...history,
          ].slice(0, MAX_PASSWORD_HISTORY)
        }
      }
    } else if (input[kind] && typeof input[kind] === 'object') {
      // The secure-note payload too: `buildCipherBody` sends its single
      // `type` field as plain JSON (see PLAIN_PAYLOAD_KEYS).
      for (const [field, value] of Object.entries(input[kind])) plain.payload[field] = value
    }

    const body = buildCipherBody({
      raw,
      type,
      plain,
      itemKey,
      cipherKey,
      encryptedFor: vault.profileId ?? undefined,
      lastKnownRevisionDate: raw.revisionDate,
    })
    const updated = await this.#send('PUT', `/api/ciphers/${encodeURIComponent(id)}`, body, signal)
    const syncWarning = await this.#sync(signal)
    return {
      id,
      name,
      updated: true,
      revisionDate: updated.revisionDate ?? null,
      ...(syncWarning ? { syncWarning } : {}),
    }
  }

  /**
   * Soft delete (into the trash) or permanent delete.
   *
   * `permanent` additionally requires `confirm: true`: the irreversible call
   * must not ride along on a single approval meant for a reversible one.
   */
  async remove(id, { permanent = false, confirm = false } = {}, signal) {
    this.#authorize(permanent ? 'purge' : 'delete')
    await this.#locateAny(id, signal)
    if (permanent && !confirm) {
      fail(
        '彻底删除需要显式确认',
        'confirmation_required',
        '彻底删除不可恢复：确认后请用 permanent: true, confirm: true 重新调用；只想删除请省略 permanent（进回收站，可用 bitwarden_restore 恢复）',
      )
    }
    if (permanent) {
      await this.#send('DELETE', `/api/ciphers/${encodeURIComponent(id)}`, undefined, signal)
    } else {
      await this.#send('PUT', `/api/ciphers/${encodeURIComponent(id)}/delete`, undefined, signal)
    }
    const syncWarning = await this.#sync(signal)
    return {
      id,
      deleted: true,
      permanent: Boolean(permanent),
      ...(permanent ? {} : { hint: '条目已进入回收站，可用 bitwarden_restore 恢复' }),
      ...(syncWarning ? { syncWarning } : {}),
    }
  }

  /**
   * Restore a trashed entry by id. Trashed items are not in the vault list, so
   * this only needs the id — the one returned by `remove` or listed by
   * `find … includeTrashed`.
   */
  async restore(id, signal) {
    this.#authorize('restore')
    await this.#locateAny(id, signal)
    const restored = await this.#send(
      'PUT',
      `/api/ciphers/${encodeURIComponent(id)}/restore`,
      undefined,
      signal,
    )
    const syncWarning = await this.#sync(signal)
    return {
      id,
      restored: true,
      revisionDate: restored.revisionDate ?? null,
      ...(syncWarning ? { syncWarning } : {}),
    }
  }
}
