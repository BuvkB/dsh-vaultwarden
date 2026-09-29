/**
 * Host-side Remote gateway for the browser half.
 *
 * The settings page (lib/client.js) talks to these methods through the
 * `/api` connection RPC channel — the same trusted path `dsh-vault` uses.
 * That channel carries the operator's authenticated session, so the gateway
 * needs no request policy of its own; a plugin-owned HTTP route would bypass
 * that authentication entirely, which is why this plugin serves none.
 *
 * Wire namespace: `vw`, so the client calls
 * `connection.rpc.call('/api', 'vw/<method>', { args })` and receives the RPC
 * envelope `{ ok: true, value } | { ok: false, error }`. Argument keys match
 * the method parameter names.
 *
 * Markers are attached by `markRemote()` at the bottom of this file rather
 * than with TypeScript decorator syntax: this package ships plain ESM
 * JavaScript, and Node does not parse decorators. `Remote(exportName)`
 * returns a standard method decorator, so the helper hands it the same
 * method-context shape the compiler would build.
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { VaultMutations } from './mutations.js'
import { VaultClient } from './vault.js'

/**
 * Attach one Remote marker to a prototype method without decorator syntax.
 * @param {object} prototype - the class prototype owning the method
 * @param {string} method - public instance method name
 * @param {string} [exportName] - wire name; defaults to the method name
 */
function markRemote(prototype, method, exportName = method) {
  Remote(exportName)(prototype[method], {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    // The protocol's own initializer resolves `Object.getPrototypeOf(this)`,
    // so hand it a throwaway instance of the class being marked.
    addInitializer(initializer) {
      initializer.call(Object.create(prototype))
    },
  })
}

export class VaultGateway extends TypertRemoteService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ getClient: () => import('./vault.js').VaultClient, owner: { getSettings: () => object, update: (patch: object) => Promise<void> } }} config
   */
  constructor(ctx, config) {
    super(ctx, 'vw')
    this.getClient = config.getClient
    this.owner = config.owner
    this.mutations = null
  }

  /** The live VaultClient (plain method: the RPC receiver is a proxy, and
   *  #private members reject proxy receivers). */
  vaultClient() {
    const client = this.getClient()
    if (!client) throw new Error('凭据库尚未初始化')
    return client
  }

  /** Lazily built mutation helper, sharing the same client. */
  vaultMutations() {
    if (!this.mutations) this.mutations = new VaultMutations(this.vaultClient())
    return this.mutations
  }

  /** Configuration / connectivity / unlock / live-sync report. */
  async status() {
    return JSON.parse(await this.vaultClient().status())
  }

  /**
   * Entry summaries — never passwords. An empty query lists everything.
   * Signature note: the gateway's source-mode validation requires plain
   * identifier parameters (no defaults, destructuring or rest), so optional
   * arguments are defaulted in the body instead of the parameter list.
   */
  async list(query, limit) {
    return this.vaultClient().findEntries(String(query ?? ''), Number(limit) || 200)
  }

  /** One entry's fields. `confirm` unlocks Bitwarden reprompt entries. */
  async reveal(id, field, confirm) {
    const ref = String(id ?? '').trim()
    if (!ref) throw new Error('需要条目 id')
    return this.vaultClient().revealEntry(ref, String(field || 'all'), undefined, { confirm: Boolean(confirm) })
  }

  /** Current TOTP code + countdown for one entry. */
  async totp(id) {
    const ref = String(id ?? '').trim()
    if (!ref) throw new Error('需要条目 id')
    return this.vaultClient().totpEntry(ref)
  }

  /**
   * Sign-in state without side effects: whether credentials are stored and
   * whether a session is currently live. The panel decides what to render from
   * this; it must never auto-start a login on open.
   */
  async session() {
    return this.vaultClient().session
  }

  /** Force a sync + decrypt; returns the item count. */
  async sync() {
    const vault = await this.vaultClient().syncNow()
    return { ok: true, items: vault.items.length }
  }

  /**
   * Drop cached credentials and any pending two-factor challenge.
   * The panel's escape hatch: when a challenge expired (or the wrong account
   * was used), this returns the UI to a clean sign-in instead of a dead end.
   */
  async reset() {
    this.vaultClient().invalidate()
    return { ok: true }
  }

  /**
   * Abandon a half-finished two-factor challenge without touching a live
   * session. The code screen calls this when it goes away, so an incomplete
   * sign-in never lingers while a signed-in user is not forced to re-enter
   * the master password just because the panel was closed.
   */
  async discardChallenge() {
    this.vaultClient().discardChallenge()
    return { ok: true }
  }

  /** Create a login entry (the config keeps write-back opt-in). */
  async create(input) {
    return this.vaultMutations().create(input ?? {}, undefined)
  }

  /** Update one login entry; only provided fields change. */
  async update(id, input) {
    return this.vaultMutations().update(String(id ?? ''), input ?? {}, undefined)
  }

  /** Soft-delete (trash) or permanently purge one entry. */
  async remove(id, permanent) {
    return this.vaultMutations().remove(String(id ?? ''), { permanent: Boolean(permanent) }, undefined)
  }

  /**
   * Current configuration for the panel's setup form. Secrets are reported as
   * booleans (`hasMasterPassword`), never as values.
   */
  async config() {
    const s = this.owner.getSettings() ?? {}
    return {
      serverUrl: s.serverUrl ?? '',
      email: s.email ?? '',
      hasMasterPassword: Boolean(s.masterPassword),
      hasApiKey: Boolean(s.apiKeyClientId && s.apiKeyClientSecret),
      apiKeyClientId: s.apiKeyClientId ?? '',
      websocket: s.websocket !== false,
      pollIntervalSeconds: s.pollIntervalSeconds ?? 60,
      cacheMinutes: s.cacheMinutes ?? 30,
      deviceIdentifier: s.deviceIdentifier ?? '',
      accessMode: s.accessMode ?? 'readonly',
    }
  }

  /**
   * Persist configuration from the panel's setup form and apply it at once.
   * Empty `masterPassword` keeps the stored secret (the browser never sees it).
   * Writes go through the host settings service, the same path the settings
   * form uses, so both surfaces stay consistent.
   *
   * Parameters are named exactly as the client sends them: the gateway matches
   * wire args against the parameter list and rejects unexpected fields, so a
   * single `patch` object would never receive its payload.
   */
  async configure(serverUrl, email, masterPassword, apiKeyClientId, apiKeyClientSecret, websocket, pollIntervalSeconds, cacheMinutes, deviceIdentifier, accessMode) {
    const next = {}
    for (const [key, value] of Object.entries({ serverUrl, email, apiKeyClientId, apiKeyClientSecret, deviceIdentifier })) {
      if (typeof value === 'string') next[key] = value.trim()
    }
    if (typeof masterPassword === 'string' && masterPassword !== '') next.masterPassword = masterPassword
    if (websocket !== undefined) next.websocket = Boolean(websocket)
    for (const [key, value] of Object.entries({ pollIntervalSeconds, cacheMinutes })) {
      if (value !== undefined && Number.isFinite(Number(value))) next[key] = Number(value)
    }
    if (accessMode === 'readonly' || accessMode === 'auto') next.accessMode = accessMode
    if (Object.keys(next).length === 0) return this.config()

    await this.owner.update(next)
    return this.config()
  }

  /**
   * Verify credentials and, when they are new, store them — the sign-in
   * form's action.
   *
   * Three properties have to hold at once, and they pull in different
   * directions:
   *  1. A typo must never overwrite a working configuration, so the new values
   *     are proved against the server FIRST, using a throwaway probe client.
   *  2. A settings write makes the loader dispose and re-apply this plugin
   *     (`entry.update()` → `fiber.dispose()`), which destroys any session
   *     established beforehand — so the write happens BEFORE the session that
   *     is meant to survive it.
   *  3. Re-signing-in with unchanged values must not restart anything, so
   *     only genuinely changed fields are written.
   *
   * Returns `{ twoFactor: true, providers }` when the password was accepted but
   * the account needs a code; the code screen is reached only after the
   * credentials proved correct.
   */
  async connect(serverUrl, email, masterPassword) {
    const stored = this.owner.getSettings() ?? {}
    const patch = {}
    if (typeof serverUrl === 'string' && serverUrl.trim() !== '' && serverUrl.trim() !== stored.serverUrl) {
      patch.serverUrl = serverUrl.trim()
    }
    if (typeof email === 'string' && email.trim() !== '' && email.trim() !== stored.email) {
      patch.email = email.trim()
    }
    if (typeof masterPassword === 'string' && masterPassword !== '' && masterPassword !== stored.masterPassword) {
      patch.masterPassword = masterPassword
    }

    // Nothing changed: sign in on the live client, no write, no restart.
    if (Object.keys(patch).length === 0) {
      const client = this.vaultClient()
      client.invalidate()
      try {
        const vault = await client.unlock()
        return { ok: true, authenticated: true, items: vault.items.length }
      } catch (error) {
        const pending = client.twoFactorPending
        if (!pending) throw error
        return this.challenge(pending)
      }
    }

    // Changed: prove the values first so a typo cannot overwrite a working
    // configuration. A challenge here already means the password was accepted.
    const probe = new VaultClient({ ...stored, ...patch })
    let challenge = null
    try {
      await probe.unlock()
    } catch (error) {
      const pending = probe.twoFactorPending
      if (!pending) throw error
      challenge = pending
    }

    // Now persist, and only now: this restarts the plugin, so the session
    // below is created on the client that comes back from the restart.
    await this.owner.update(patch)
    const client = this.vaultClient()

    if (challenge) return this.challenge(challenge)

    // No two-factor step: the probe's session died with the write, so
    // establish one on the live client.
    const vault = await client.unlock()
    return { ok: true, authenticated: true, items: vault.items.length }
  }

  /** Shape a pending two-factor challenge for the client.
   *  Plain method on purpose: the RPC receiver is a proxy and #private
   *  members reject proxy receivers. */
  challenge(pending) {
    return {
      ok: true,
      authenticated: false,
      twoFactor: true,
      providers: pending.providers ?? [],
      provider: pending.provider ?? 0,
      providerDescriptions: pending.providerDescriptions ?? null,
    }
  }

  /** Whether a login attempt is waiting for a two-factor code. */
  /**
   * Two-factor challenge state for the UI: which providers the account has.
   * The server issues no continuation token — submitting a code simply
   * re-runs the password grant — so there is nothing else to hand over.
   */
  async twoFactor() {
    const pending = this.vaultClient().twoFactorPending
    if (!pending) return { pending: false }
    return {
      pending: true,
      providers: pending.providers ?? [],
      provider: pending.provider ?? 0,
      providerDescriptions: pending.providerDescriptions ?? null,
    }
  }

  /**
   * Submit a two-factor code to finish a pending login.
   * @param {string} code - 6-digit TOTP or a recovery code
   * @param {number} provider - provider id from the pending state
   * @param {boolean} remember - remember this device
   */
  async submitTwoFactor(code, provider, remember) {
    // Credentials were stored by `connect()` before the challenge, so this
    // always completes against the live client. No state has to survive from
    // the challenge, which is what makes a restart mid-flow harmless.
    const client = this.vaultClient()
    await client.loginWithTwoFactor({ code, provider, remember }, undefined)
    const vault = await client.unlock()
    return { ok: true, items: vault.items.length }
  }
}

// Wire names equal method names; list them explicitly so the wire surface is
// reviewable in one place.
for (const method of ['status', 'list', 'reveal', 'totp', 'sync', 'create', 'update', 'remove', 'config', 'configure', 'connect', 'twoFactor', 'submitTwoFactor', 'reset', 'session', 'discardChallenge']) {
  markRemote(VaultGateway.prototype, method, method)
}
