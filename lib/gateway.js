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
   * @param {{ getClient: () => import('./vault.js').VaultClient }} config
   */
  constructor(ctx, config) {
    super(ctx, 'vw')
    this.getClient = config.getClient
    this.mutations = null
  }

  #client() {
    const client = this.getClient()
    if (!client) throw new Error('凭据库尚未初始化')
    return client
  }

  #mutations() {
    if (!this.mutations) this.mutations = new VaultMutations(this.#client())
    return this.mutations
  }

  /** Configuration / connectivity / unlock / live-sync report. */
  async status() {
    return JSON.parse(await this.#client().status())
  }

  /** Entry summaries — never passwords. An empty query lists everything. */
  async list(query = '', limit = 200) {
    return this.#client().findEntries(String(query ?? ''), Number(limit) || 200)
  }

  /** One entry's fields. `confirm` unlocks Bitwarden reprompt entries. */
  async reveal(id, field = 'all', confirm = false) {
    const ref = String(id ?? '').trim()
    if (!ref) throw new Error('需要条目 id')
    return this.#client().revealEntry(ref, String(field || 'all'), undefined, { confirm: Boolean(confirm) })
  }

  /** Current TOTP code + countdown for one entry. */
  async totp(id) {
    const ref = String(id ?? '').trim()
    if (!ref) throw new Error('需要条目 id')
    return this.#client().totpEntry(ref)
  }

  /** Force a sync + decrypt; returns the item count. */
  async sync() {
    const vault = await this.#client().syncNow()
    return { ok: true, items: vault.items.length }
  }

  /** Create a login entry (the config keeps write-back opt-in). */
  async create(input) {
    return this.#mutations().create(input ?? {}, undefined)
  }

  /** Update one login entry; only provided fields change. */
  async update(id, input) {
    return this.#mutations().update(String(id ?? ''), input ?? {}, undefined)
  }

  /** Soft-delete (trash) or permanently purge one entry. */
  async remove(id, permanent = false) {
    return this.#mutations().remove(String(id ?? ''), { permanent: Boolean(permanent) }, undefined)
  }
}

// Wire names equal method names; list them explicitly so the wire surface is
// reviewable in one place.
for (const method of ['status', 'list', 'reveal', 'totp', 'sync', 'create', 'update', 'remove']) {
  markRemote(VaultGateway.prototype, method, method)
}
