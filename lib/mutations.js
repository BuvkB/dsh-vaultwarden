/**
 * Cipher write-back for Vaultwarden / Bitwarden.
 *
 * Implements the mutation half of the client API, symmetric to the read path
 * in `vault.js`:
 *
 *   POST /api/ciphers              create a login cipher
 *   PUT  /api/ciphers/{id}         update one
 *   POST /api/ciphers/{id}/delete  soft delete (moves to trash)
 *   PUT  /api/ciphers/{id}/restore restore from trash
 *   DELETE /api/ciphers/{id}       purge permanently
 *
 * Bitwarden wraps every cipher in its own per-item key (a fresh 64-byte key
 * stretched to enc/mac, itself encrypted with the account's user key), so a
 * created or updated cipher carries `key` plus type-2 EncStrings. Personal
 * items only: an organization cipher is encrypted with its organization's key,
 * and v1 refuses those with a clear error instead of writing something the
 * server would reject.
 *
 * Every mutation ends with a `syncNow()` so the in-memory vault (and the live
 * sync cache the UI and tools read) reflects the change immediately — the hub
 * notification would arrive too, but a local write must not wait for it.
 */
import { randomBytes } from 'node:crypto'
import { VaultError, httpJson, authHeaders, stretchKey, encryptString } from './vault.js'

const fail = (message, code, hint) => {
  throw new VaultError(message, { code, hint })
}

const enc = (value, key) => encryptString(value, key)

/**
 * Build the encrypted login cipher the API expects.
 * @param {object} input - plaintext fields (`name` is required)
 * @param {{enc: Buffer, mac: Buffer}} userKey - the account user key
 * @returns {object} the cipher body, ready to POST/PUT
 */
export function buildLoginCipher(input, userKey) {
  if (!input?.name) fail('缺少条目名称', 'bad_request', '创建条目至少需要 name')
  // A fresh per-item key: Bitwarden never encrypts fields with the user key.
  const itemKeyRaw = randomBytes(64)
  const itemKey = stretchKey(itemKeyRaw)
  const cipher = {
    type: 1, // CipherType.Login
    name: enc(input.name, itemKey),
    favorite: Boolean(input.favorite),
    reprompt: Number(input.reprompt ?? 0),
    key: encryptString(itemKeyRaw, userKey),
  }
  if (input.notes) cipher.notes = enc(input.notes, itemKey)
  if (input.folderId) cipher.folderId = String(input.folderId)
  const login = {}
  if (input.username) login.username = enc(input.username, itemKey)
  if (input.password) login.password = enc(input.password, itemKey)
  if (input.totp) login.totp = enc(input.totp, itemKey)
  const uris = (input.uris ?? [])
    .map((uri) => ({ uri: enc(String(uri), itemKey), match: null }))
    .filter((entry) => entry.uri)
  if (uris.length) login.uris = uris
  if (Object.keys(login).length) cipher.login = login
  const fields = (input.fields ?? [])
    .filter((field) => field && (field.name || field.value))
    .map((field) => ({
      name: enc(field.name ?? '', itemKey),
      value: enc(field.value ?? '', itemKey),
      type: Number(field.type ?? 0),
    }))
  if (fields.length) cipher.fields = fields
  return cipher
}

export class VaultMutations {
  /** @param {import('./vault.js').VaultClient} client */
  constructor(client) {
    this.client = client
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
      fail(`写回失败：${detail}`, status === 401 ? 'unauthorized' : 'http_error', '检查权限与网络后重试')
    }
    return json ?? {}
  }

  /** v1 writes personal ciphers only; organization items need org-key handling. */
  static #requirePersonal(item) {
    if (item?.organizationId) {
      fail(
        '该条目属于组织，暂不支持写回',
        'unsupported_org_item',
        'v1 只支持个人条目的创建/修改/删除；组织条目的写回需要组织密钥管理',
      )
    }
  }

  async #locate(id, signal) {
    const vault = await this.client.unlock(signal)
    const item = vault.byId.get(String(id))
    if (!item) fail(`凭据库中没有 id 为 ${id} 的条目`, 'not_found', '先 bitwarden_find 取 id；回收站中的条目不在列表内')
    VaultMutations.#requirePersonal(item)
    return item
  }

  /** Create a login entry. Returns `{ id, name, created, revisionDate }`. */
  async create(input, signal) {
    // Build first so a validation error costs no request.
    const { userKey } = await this.client.unlockKeys(signal)
    const cipher = buildLoginCipher(input, userKey)
    const created = await this.#send('POST', '/api/ciphers', cipher, signal)
    await this.client.syncNow(signal)
    return { id: created.id ?? null, name: input.name, created: true, revisionDate: created.revisionDate ?? null }
  }

  /**
   * Update one entry. Only provided fields change; the rest are re-encrypted
   * from the cached plaintext, so the server always receives a full cipher.
   */
  async update(id, input, signal) {
    const existing = await this.#locate(id, signal)
    if (existing.type !== 'login') {
      fail(`暂不支持修改 ${existing.type} 类型的条目`, 'unsupported_type', 'v1 的写回只支持登录（login）类型条目')
    }
    const merged = {
      name: input.name ?? existing.name,
      username: input.username ?? existing.username,
      password: input.password ?? existing.password,
      totp: input.totp ?? existing.totpSecret,
      notes: input.notes ?? existing.notes,
      uris: input.uris ?? existing.uris,
      favorite: input.favorite ?? existing.favorite,
      reprompt: input.reprompt ?? existing.reprompt,
      folderId: input.folderId ?? existing.folderId ?? undefined,
      // The server replaces the whole cipher, so every field must be re-sent.
      fields: input.fields ?? existing.fields,
    }
    const { userKey } = await this.client.unlockKeys(signal)
    const cipher = buildLoginCipher(merged, userKey)
    cipher.folderId = merged.folderId ?? null
    const updated = await this.#send('PUT', `/api/ciphers/${encodeURIComponent(id)}`, cipher, signal)
    await this.client.syncNow(signal)
    return { id, name: merged.name, updated: true, revisionDate: updated.revisionDate ?? null }
  }

  /** Soft-delete (trash) or permanently purge one entry. */
  async remove(id, { permanent = false } = {}, signal) {
    await this.#locate(id, signal)
    if (permanent) {
      await this.#send('DELETE', `/api/ciphers/${encodeURIComponent(id)}`, undefined, signal)
    } else {
      await this.#send('POST', `/api/ciphers/${encodeURIComponent(id)}/delete`, undefined, signal)
    }
    await this.client.syncNow(signal)
    return { id, deleted: true, permanent: Boolean(permanent) }
  }

  /**
   * Restore a trashed entry by id. Trashed items are not in the vault list,
   * so this does not require the entry to be present locally — keep the id
   * from the delete result.
   */
  async restore(id, signal) {
    const restored = await this.#send('PUT', `/api/ciphers/${encodeURIComponent(id)}/restore`, undefined, signal)
    await this.client.syncNow(signal)
    return { id, restored: true, revisionDate: restored.revisionDate ?? null }
  }
}
