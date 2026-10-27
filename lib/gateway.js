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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { VaultMutations } from './mutations.js'
import { trailReport } from './trail.js'
import { VaultClient } from './vault.js'

/**
 * The installed package's own identity, read from its manifest.
 *
 * A browser bundle cannot read package.json, and the host does not hand a
 * plugin its own version through the client graph — so the node half, which
 * ships beside the manifest, is the only place this number can come from.
 * Reading it here rather than baking it into the bundle means the version the
 * panel shows can never drift from the package that is actually installed.
 *
 * Read once and cached: the file cannot change under a running process, and
 * the panel asks on every open.
 */
let identityCache
function pluginIdentity() {
  if (identityCache !== undefined) return identityCache
  try {
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    identityCache = {
      name: typeof manifest.name === 'string' ? manifest.name : null,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      repository: typeof manifest.repository?.url === 'string' ? manifest.repository.url : null,
    }
  } catch {
    // A tree without a readable manifest still has to render a panel.
    identityCache = { name: null, version: null, repository: null }
  }
  return identityCache
}

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

/**
 * Test hook: the identity `boot` reports.
 *
 * Exported so a suite can assert the resolved version equals the manifest's
 * without standing up a host context — the whole point of reading the number
 * from the manifest is that it cannot drift, and that claim is only worth
 * making if something checks it.
 */
export const pluginIdentityForTest = () => pluginIdentity()

export class VaultGateway extends TypertRemoteService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ getClient: () => import('./vault.js').VaultClient, createClient?: (override?: object) => import('./vault.js').VaultClient, owner: { getSettings: () => object, update: (patch: object) => Promise<void> } }} config
   */
  constructor(ctx, config) {
    super(ctx, 'vw')
    this.getClient = config.getClient
    // Builds a client sharing the plugin's session store. `override` lets the
    // sign-in probe try CANDIDATE credentials before they are written, while
    // still persisting a successful session the normal way.
    this.createClient = config.createClient ?? (() => config.getClient())
    this.owner = config.owner
    // The write-permission gate is injected from the host half. The RPCs below
    // reach the same mutation layer the model tools do, so the gate has to sit
    // next to the request instead of in the tool wrappers.
    this.guard = config.guard ?? null
    this.mutations = null
  }

  /** The live VaultClient (plain method: the RPC receiver is a proxy, and
   *  #private members reject proxy receivers). */
  vaultClient() {
    const client = this.getClient()
    if (!client) throw new Error('密码库尚未初始化')
    return client
  }

  /** Lazily built mutation helper, sharing the same client. */
  vaultMutations() {
    if (!this.mutations) this.mutations = new VaultMutations(this.vaultClient(), { guard: this.guard })
    return this.mutations
  }

  /** Configuration / connectivity / unlock / live-sync report. */
  async status() {
    return await this.vaultClient().statusReport()
  }

  /**
   * Entry summaries — never passwords. An empty query lists everything.
   * `offset` walks the ranked list in pages: the panel reads a small first
   * page and asks for the next one as the reader scrolls. Optional for
   * callers that predate paging.
   * Signature note: the gateway's source-mode validation requires plain
   * identifier parameters (no defaults, destructuring or rest), so optional
   * arguments are defaulted in the body instead of the parameter list.
   */
  async list(query, limit, offset, includeArchived, includeTrashed, section, sectionValue) {
    // The panel read keeps archived entries by default (the row says so):
    // hiding them sent a retired credential out of sight of the person who
    // filed it. The archive filter can ask for the opposite, and the trash
    // view adds the soft-deleted rows. The model-facing tools decide the
    // other way, in lib/index.js.
    //
    // `section`/`sectionValue` name one sidebar section ("type:card",
    // "folder:<id>", …): the host narrows the pool before ranking and paging,
    // so the panel's counter and its next page both describe the place the
    // reader is actually in.
    return this.vaultClient().findEntries(String(query ?? ''), Number(limit) || 200, Number(offset) || 0, undefined, {
      includeArchived: includeArchived === undefined ? true : Boolean(includeArchived),
      includeTrashed: Boolean(includeTrashed),
      section: section === undefined ? 'all' : String(section),
      sectionValue: sectionValue === undefined ? null : String(sectionValue),
    })
  }

  /**
   * One entry's fields. `includeTrashed` lets the panel open a row from its
   * trash view.
   *
   * There is no `confirm` argument on purpose: a reprompt entry is opened by
   * `authorizeReprompt` (the user typing the master password), never by the
   * caller waving a boolean. `reveal` only reports the grant's current state
   * so the panel can render the countdown.
   */
  async reveal(id, field, includeTrashed) {
    const ref = String(id ?? '').trim()
    if (!ref) throw new Error('需要条目 id')
    return this.vaultClient().revealEntry(ref, String(field || 'all'), undefined, { includeTrashed: Boolean(includeTrashed) })
  }

  /**
   * The editable plaintext of one entry, for the panel's editor.
   *
   * `reveal` answers one field at a time so that a caller who only wanted the
   * username is never handed the card number. The editor needs the whole
   * record to fill a form, and a round trip per control would make opening it
   * crawl — so the host assembles the draft here instead. Same gates as
   * `reveal`: a trashed entry needs `includeTrashed`, and a `reprompt` entry
   * stays locked until the user proves the master password.
   */
  async draft(id, includeTrashed) {
    const ref = String(id ?? '').trim()
    if (!ref) throw new Error('需要条目 id')
    return this.vaultClient().draftEntry(ref, undefined, { includeTrashed: Boolean(includeTrashed) })
  }

  /**
   * Verify a master password the user typed and open the short window in which
   * reprompt entries can be read. Panel-only: the tool surface has no way to
   * call it (see bitwarden_get in lib/index.js).
   * @param {string} password master password typed by the user
   */
  async authorizeReprompt(password, id, includeTrashed) {
    const client = this.vaultClient()
    // The proof is bound to the entry the user was looking at. Passing the id
    // down is what makes that binding real: the host resolves it to the entry
    // and records it with the grant, so the window opens for THIS entry only.
    // Sending just the password would have left every gated entry in the
    // account readable for the rest of the window, which is not what the
    // "ask me again" flag asks for.
    const ref = String(id ?? '').trim()
    const result = await client.authorizeReprompt(password, undefined, ref ? { id: ref } : {})
    if (!result.authorized) return result
    // Hand back the entry that was just unlocked so the panel does not need a
    // second round trip to show the thing the user just proved they may see.
    if (ref) {
      result.view = await client.revealEntry(ref, 'all', undefined, { includeTrashed: Boolean(includeTrashed) })
    }
    return result
  }

  /** Whether a master-password proof is currently in force, plus its left-over time. */
  async repromptGrant() {
    const client = this.vaultClient()
    return { granted: client.repromptGranted, remainingMs: client.repromptGrantRemainingMs }
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

  /**
   * Soft-delete one entry into the trash. A permanent purge is not on this
   * wire at all.
   *
   * The signature carries ONE parameter, and that is the point. It used to
   * carry `permanent` + `confirm`: two booleans the same caller passed in the
   * same call, so "irreversible, confirmed by a human" was really "confirmed by
   * itself" — the same self-signed checkbox the reprompt gate removed from
   * reads. Dropping them is stronger than ignoring them, because the RPC
   * descriptor is derived from this parameter list: a request that still tries
   * to purge is refused outright as `gateway/arguments-invalid` (verified
   * against a live host) instead of being quietly downgraded. Permanent
   * deletion is reachable only through the `bitwarden_delete` tool, where
   * accessMode=ask puts a real approval in front of it.
   */
  async remove(id) {
    const ref = String(id ?? '').trim()
    if (!ref) throw new Error('需要条目 id')
    return this.vaultMutations().remove(ref, {}, undefined)
  }

  /** Restore a trashed entry by id. */
  async restore(id) {
    return this.vaultMutations().restore(String(id ?? ''), undefined)
  }

  /** Folders as `{id, name, count}`, plus the number of unfiled entries. */
  async folders() {
    return await this.vaultClient().folderListData()
  }

  /**
   * The sidebar's counts in one read: every section the panel can open, with
   * the same numbers the matching `list` call will report. The panel builds
   * its navigation from this and caches it, so switching sections is a list
   * read at most — never a fresh scan of the vault.
   */
  async overview() {
    return this.vaultClient().overview()
  }

  /**
   * The masking trail: how much of the vault left this machine, said to which
   * conversation and which model.
   *
   * Reads the vault not at all — the numbers come from the session logs, which
   * is why this answer appears even while the vault is locked. Rebuilding the
   * index is budgeted per call (see lib/trail.js), so a cold machine returns
   * partial numbers with `index.pending > 0` and the panel asks again.
   */
  async trail(days, page) {
    return await trailReport({ days, page })
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
      sessionDays: s.sessionDays ?? 30,
      // The store's own report, minus `path`: the absolute location of the
      // session file is a map for anyone reading this payload (it names the
      // data directory and, on a shared box, the account the drop-in lives
      // under). Nothing in the panel needs it — enabling/disabling and the
      // idle deadline are all it renders — so it does not travel.
      session: (() => {
        const { path: _unusedPath, ...rest } = this.vaultClient().sessionPersistence ?? {}
        return rest
      })(),
    }
  }

  /**
   * Everything the panel needs on open, in one round trip.
   *
   * Opening used to cost two sequential RPCs (`config`, then `session`) before
   * a single row could be drawn, and neither of them tried to revive a stored
   * session: the `session` getter reports the in-memory token only, so after a
   * restart it is gone and a remembered device (two-factor “Remember”) lands on
   * the sign-in form again. An access token one hour old looked exactly like
   * “signed out” for the same reason.
   *
   * `resumeSession()` fixes that half: it restores the stored file and, when
   * the access token has aged out, swaps the refresh token in silence. It
   * never performs a password grant, so a two-factor account can never be
   * challenged by a mere panel open. The return value tells the caller which
   * of two situations it is in: no stored session (ask for credentials) or a
   * live one (draw the list).
   *
   * A dead session is re-established here only for API-key accounts: that
   * grant needs no prompt and no code. A password account is left to
   * `connect()`, where the operator decides to spend a code on it.
   *
   * @param {AbortSignal} [signal] - optional, for in-process callers only:
   *   the RPC wire carries plain JSON, so the panel never sends one and a
   *   newer boot would simply finish first.
   */
  async boot(signal) {
    const config = await this.config()
    let resumed = false
    try {
      resumed = await this.vaultClient().resumeSession(signal)
    } catch {
      resumed = false // a dead session must not break the panel itself
    }
    if (!resumed && signal?.aborted !== true) {
      const s = this.owner.getSettings() ?? {}
      if (String(s.apiKeyClientId ?? '').trim() !== '' && String(s.apiKeyClientSecret ?? '').trim() !== '') {
        try {
          resumed = Boolean(await this.vaultClient().ensureToken(signal))
        } catch {
          resumed = false
        }
      }
    }
    // The build identity rides along with the rest of the panel's opening
    // state — the same round trip the panel already makes, so showing a
    // version costs no extra call.
    return { config, resumed, session: this.vaultClient().session, plugin: pluginIdentity() }
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
    // accessMode is NOT writable from here, on purpose. This RPC is the most
    // reachable surface the plugin has (any authenticated panel page, any
    // script holding that session), and the tier it would set is the gate the
    // MODEL write tools obey: the same live settings closure feeds writeGuard
    // in lib/index.js. Accepting it here let one panel call raise the vault
    // from readonly to auto and hand the agent unattended write access to
    // every credential in the account, which is a privilege escalation across
    // principals. The argument is ignored rather than rejected so an older
    // panel keeps working (it reads the tier from config() and never depends
    // on setting it); operators change it in DSH settings, the one surface
    // allowed to say what the agent may do.
    void accessMode
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
   *  2. Every config field is `.volatile()`, so a write does not restart the
   *     plugin (the loader commits volatile values into the running fiber).
   *     What does drop the session is this plugin's own eager `reconfigure()`
   *     on write, which invalidates the live client — so the write still has to
   *     happen BEFORE the session that is meant to survive it.
   *  3. Re-signing-in with unchanged values must not disturb anything, so
   *     only genuinely changed fields are written.
   *
   * @param {string} apiKeyClientId - `user.<uuid>`; empty string clears it
   * @param {string} apiKeyClientSecret - omitted keeps the stored secret
   *
   * Returns `{ twoFactor: true, providers }` when the password was accepted but
   * the account needs a code; the code screen is reached only after the
   * credentials proved correct.
   */
  async connect(serverUrl, email, masterPassword, apiKeyClientId, apiKeyClientSecret) {
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
    // An explicit empty string clears the API key (switching back to the
    // password method); undefined leaves whatever is stored alone.
    if (typeof apiKeyClientId === 'string' && apiKeyClientId.trim() !== stored.apiKeyClientId) {
      patch.apiKeyClientId = apiKeyClientId.trim()
    }
    if (typeof apiKeyClientSecret === 'string' && apiKeyClientSecret !== '' && apiKeyClientSecret !== stored.apiKeyClientSecret) {
      patch.apiKeyClientSecret = apiKeyClientSecret
    }

    // Nothing changed: sign in on the live client, no write, no restart.
    if (Object.keys(patch).length === 0) {
      const client = this.vaultClient()
      // Drop the in-memory token only. `invalidate()` without the flag also
      // deletes the stored file, and this branch was the usual path: the
      // sign-in form is submitted with its stored values, so re-connecting the
      // same account threw the remembered session away and forced a fresh
      // password grant - for a two-factor account that means typing a code
      // every time, and the deleted file is why session.json kept going
      // missing. Keeping the store makes "already signed in" the cheapest
      // outcome.
      client.invalidate({ keepStored: true })
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
    const probe = this.createClient(patch)
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

    if (challenge) {
      // The write invalidated the live client, so hand it the challenge: the
      // background guard must keep polling from starting fresh logins.
      client.adoptChallenge(challenge)
      return this.challenge(challenge)
    }

    // No two-factor step: the probe's session did not survive the write, so
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
for (const method of [
  'status', 'list', 'reveal', 'authorizeReprompt', 'repromptGrant', 'totp', 'sync', 'create', 'update', 'remove', 'config', 'configure',
  'connect', 'twoFactor', 'submitTwoFactor', 'reset', 'session', 'discardChallenge',
  'boot', 'restore', 'folders', 'overview', 'draft', 'trail',
]) {
  markRemote(VaultGateway.prototype, method, method)
}
