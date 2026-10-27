/**
 * dsh-vaultwarden — Bitwarden/Vaultwarden credentials for every DSH session.
 *
 * What it installs (global, workspace-independent):
 *  1. Three model tools — `bitwarden_find`, `bitwarden_get`, `bitwarden_status` —
 *     registered on the plugin fiber, so every new session sees them.
 *  2. A system-prompt section telling the model to consult the vault on its own
 *     whenever credentials are needed (no user reminder required).
 *  3. A `bitwarden` user-settings namespace (DSH 设置 → 插件 → bitwarden), with
 *     the master password / API key marked as secret fields, so credentials are
 *     entered once in the UI instead of being pasted into a chat.
 *
 * Configuration precedence: user settings (settings.yaml / UI) → composition
 * entry config → `DSH_BITWARDEN_*` environment variables → built-in defaults.
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { VaultClient, VaultError, normalizeServerUrl } from './vault.js'
import { VaultMutations } from './mutations.js'
import { VaultGateway } from './gateway.js'
import { SessionStore, defaultSessionPath } from './session-store.js'
import { CacheStore, defaultCachePath } from './cache-store.js'
import { loadMaskKey, defaultMaskKeyPath, maskProjection } from './mask.js'
import { sweepAll } from './sweeper.js'
import { join } from 'node:path'

export const name = 'dsh-vaultwarden'
export const inject = ['tools', 'systemPrompt']

const SETTINGS_NS = 'dsh-vaultwarden'
// No default server: a fork must not point at somebody else's instance. An
// empty value keeps the plugin inert until the user fills it in.
const DEFAULT_SERVER = ''
const PROMPT_SECTION = 'bitwarden-vault'
const PROMPT_ORDER = 2950 // after the first-party tool sections, before the SDK section

/**
 * User-editable settings. `.volatile()` is what makes a field editable from
 * the host's plugin-settings form (only volatile fields are rendered) and
 * persistable through the profile patch; `.role('secret')` keeps a value from
 * being returned to the browser.
 */
export const Config = z.object({
  serverUrl: z.string().default(DEFAULT_SERVER).volatile().description('Vaultwarden/Bitwarden 服务器地址'),
  email: z.string().default('').volatile().description('登录邮箱（KDF 盐值，必须与账号一致）'),
  masterPassword: z.string().role('secret').default('').volatile().description('主密码（仅存本机 settings.yaml，用于解密保险库）'),
  apiKeyClientId: z.string().default('').volatile().description('可选：API 密钥 client_id（user.<uuid>），填了就走 API 密钥登录（可绕过两步验证）'),
  apiKeyClientSecret: z.string().role('secret').default('').volatile().description('可选：API 密钥 client_secret'),
  cacheMinutes: z.natural().default(30).volatile().description('解锁后的保险库内存缓存时长（分钟）'),
  localCache: z
    .boolean()
    .default(true)
    .volatile()
    .description('本地密文缓存：把上次同步的密文写到本机（0600），下次启动先出列表，再用 13 字节的账号修订号探针校验。关闭则每次启动都重新全量下载'),
  websocket: z.boolean().default(true).volatile().description('启用 WebSocket 实时通知（/notifications/hub）；关闭则始终轮询同步'),
  pollIntervalSeconds: z.natural().default(300).volatile().description('WebSocket 不可用时的兜底轮询间隔（秒，最小 30）。WebSocket 正常时用不到；徽标可点击手动同步'),
  deviceIdentifier: z.string().default('').volatile().description('可选：设备标识。官方客户端会持久化一个稳定值；留空按「服务器+邮箱」确定性派生，不写盘'),
  sessionDays: z
    .natural()
    .default(30)
    .volatile()
    .description('登录会话保留天数（0=每次都重新登录）。按「闲置」计时：期间只要用过一次密码库就自动续期，闲置超过该天数才失效'),
  repromptGrantMinutes: z
    .natural()
    .default(5)
    .volatile()
    .description('重新验证（reprompt）条目解锁后记住主密码的分钟数。验证一次后这段时间内不必重复输入；与登录会话无关，插件重启或会话失效即作废'),
  // schemastery 3.18 has no `enum`; a const union is the equivalent form.
  accessMode: z
    .union([z.const('readonly'), z.const('ask'), z.const('auto')])
    .default('readonly')
    .volatile()
    .description('写权限：readonly=只读（拒绝创建/修改/删除）；ask=需用户在对话中确认后才写；auto=直接写回 Vaultwarden'),
  maskMode: z
    .boolean()
    .default(false)
    .volatile()
    .description('占位符脱敏：开启后 bitwarden_get 只返回 {{BW_*}} 占位符而不给明文，模型需要明文时调用 bitwarden_reveal 单次取回；保险库本身始终是权威来源'),
  sweepMode: z
    .boolean()
    .default(false)
    .volatile()
    .description('日志擦除：开启后定时扫描本地 DSH 会话日志，把 bitwarden 相关事件里已落盘的明文（password/totp/卡号等）替换为 [REDACTED:BW]；只处理闲置会话，进行中的会话不动'),
  sweepIntervalMinutes: z
    .natural()
    .default(30)
    .volatile()
    .description('日志擦除的定时扫描间隔（分钟，最小 5；0=关闭定时，仍可手动 bitwarden_sweep）'),
})

const PROMPT_TEXT = [
  '密码库（Bitwarden/Vaultwarden）已接入。任何需要密码、账号、API key、token 或登录信息的地方，先自己查密码库再动手，不要先问用户；用户说"密码在 Bitwarden 里"时同理。',
  '只有当 bitwarden_status 显示未配置、不可达或登录失败时，才请用户在 DSH 设置 → 插件 → bitwarden 中补全 serverUrl/email/主密码。',
  '取到的明文凭据只用于完成任务，不要回显、不要写入文件或日志。',
  '遇到 repromptRequired 的条目不要反复试探：没有参数能绕开这道门，请用户在「设置 → 密码库」里输入主密码验证，短时间内可读取，或到官方客户端查看。',
].join('')

const env = (names) => {
  for (const key of names) {
    const value = process.env[key]
    if (value) return value
  }
  return undefined
}

/**
 * Unwrap a config value. Fields declared `.volatile()` reach the plugin as a
 * reference object (`{ get(), [cosmokit.volatile.write]() }`) rather than a
 * bare value — reading one without `get()` stringifies to "[object Object]".
 */
function readConfigValue(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** The write-permission tiers, weakest first. Kept in one place so the schema,
 *  the resolver and the approval gate cannot drift apart. */
const ACCESS_MODES = ['readonly', 'ask', 'auto']

/** Polling is only a fallback for an unavailable WebSocket, so the default is
 *  deliberately slow; the sync chip offers an immediate manual sync. */
const DEFAULT_POLL_SECONDS = 300
const MIN_POLL_SECONDS = 30

/** Merge composition entry config, environment fallbacks, and defaults. */
/** Where the persisted session lives: an explicit path, else the DSH data dir. */
function sessionPathFor(settings) {
  const configured = String(settings?.sessionPath ?? '').trim()
  return configured !== '' ? configured : defaultSessionPath()
}

/** Where the vault cache lives: an explicit path, else next to the session. */
function cachePathFor(settings) {
  const configured = String(settings?.cachePath ?? '').trim()
  return configured !== '' ? configured : defaultCachePath()
}

function resolveSettings(source = {}) {
  const value = source ?? {}
  const field = (key) => readConfigValue(value[key])
  const cacheRaw = Number(field('cacheMinutes'))
  const pollRaw = Number(field('pollIntervalSeconds'))
  const websocketRaw = field('websocket')
  const localCacheRaw = field('localCache')
  return {
    // Kept raw (trimmed) here; `VaultClient.server` normalizes on first use,
    // so an unconfigured value never throws during activation.
    serverUrl: String(field('serverUrl') || env(['DSH_BITWARDEN_SERVER', 'BITWARDEN_SERVER']) || DEFAULT_SERVER).trim(),
    email: String(field('email') || env(['DSH_BITWARDEN_EMAIL', 'BITWARDEN_EMAIL']) || '').trim(),
    masterPassword: String(field('masterPassword') || env(['DSH_BITWARDEN_MASTER_PASSWORD', 'BITWARDEN_PASSWORD']) || ''),
    apiKeyClientId: String(field('apiKeyClientId') || env(['DSH_BITWARDEN_CLIENT_ID', 'BITWARDEN_CLIENT_ID']) || '').trim(),
    apiKeyClientSecret: String(
      field('apiKeyClientSecret') || env(['DSH_BITWARDEN_CLIENT_SECRET', 'BITWARDEN_CLIENT_SECRET']) || '',
    ),
    cacheMinutes: Number.isFinite(cacheRaw) && cacheRaw >= 0 ? cacheRaw : 30,
    localCache: localCacheRaw === undefined || localCacheRaw === null ? true : Boolean(localCacheRaw),
    websocket: websocketRaw === undefined || websocketRaw === null ? true : Boolean(websocketRaw),
    pollIntervalSeconds: Number.isFinite(pollRaw) && pollRaw >= MIN_POLL_SECONDS ? pollRaw : DEFAULT_POLL_SECONDS,
    deviceIdentifier: String(field('deviceIdentifier') || env(['DSH_BITWARDEN_DEVICE_ID', 'BITWARDEN_DEVICE_ID']) || '').trim(),
    accessMode: ACCESS_MODES.includes(field('accessMode')) ? field('accessMode') : 'readonly',
    sessionDays: Number.isFinite(Number(field('sessionDays'))) ? Math.max(0, Number(field('sessionDays'))) : 30,
    repromptGrantMinutes: Number.isFinite(Number(field('repromptGrantMinutes')))
      ? Math.max(1, Number(field('repromptGrantMinutes')))
      : 5,
    maskMode: field('maskMode') === undefined || field('maskMode') === null ? false : Boolean(field('maskMode')),
    sweepMode: field('sweepMode') === undefined || field('sweepMode') === null ? false : Boolean(field('sweepMode')),
    sweepIntervalMinutes: Number.isFinite(Number(field('sweepIntervalMinutes')))
      ? Math.max(0, Math.round(Number(field('sweepIntervalMinutes'))))
      : 30,
  }
}

const asText = (_args, value) => [{ type: 'text', text: String(value) }]

/** Turn any thrown value into an actionable message for the model. */
function failure(error) {
  if (error instanceof VaultError) {
    return error.hint ? `${error.message}\n提示：${error.hint}` : error.message
  }
  return `密码库操作失败：${error?.message ?? error}`
}

export function apply(ctx, config = {}) {
  let settings = resolveSettings(config)
  /** @type {VaultClient | null} */
  let client = null
  /** Live sync runs for the plugin's lifetime; restarted when settings change. */
  let liveRunning = false
  // The HMAC key behind {{BW_*}} placeholders. Loaded lazily so an unreadable
  // key never blocks activation; a null key makes get reads pass through
  // unmasked rather than emitting unstable tags.
  /** @type {Buffer | null} */
  let maskKey = null
  const maskKeyFor = () => {
    if (!maskKey) maskKey = loadMaskKey(defaultMaskKeyPath())
    return maskKey
  }
  /** Where session logs live: $DSH_HOME/sessions by default. */
  const sessionsRootFor = () => join(process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh'), 'sessions')

  // One store per plugin instance: it owns the on-disk session file whose
  // retention window comes from the `sessionDays` setting.
  const sessionStore = new SessionStore(sessionPathFor(settings), { maxAgeDays: settings.sessionDays })
  // The vault cache keeps the last sync payload (the server's own ciphertext, a
  // third of its size once gzipped) so a cold start can draw the list before the
  // network answers. Turning it off deletes the file rather than leaving it
  // behind, so the setting means what it says on disk.
  const cacheStore = new CacheStore(cachePathFor(settings), { enabled: settings.localCache })
  if (!settings.localCache) cacheStore.clear()
  const newClient = (override) =>
    new VaultClient(override ? { ...settings, ...override } : settings, {
      sessionStore,
      cacheStore,
      // Route background-path failures (syncSoon, applyCipher re-projection)
      // somewhere visible instead of a silent unhandled rejection.
      log: (level, message) => {
        const line = typeof message === 'string' ? message : String(message)
        try {
          console[level === 'error' ? 'error' : 'log']('[dsh-vaultwarden] ' + line)
        } catch {
          // A broken console must not break the vault.
        }
      },
    })
  const getClient = () => {
    if (!client) {
      client = newClient()
      // The live-sync effect runs during activation, before anything has asked
      // for a client, so this is the first moment a channel can be built. Without
      // this the subscription would never start and sync would stay `off`.
      startLiveSync()
    }
    return client
  }
  const startLiveSync = () => {
    if (!client || !liveRunning) return
    client.startLiveSync({
      pollIntervalMs: settings.pollIntervalSeconds * 1000,
      websocket: settings.websocket,
    })
  }
  const reconfigure = (next) => {
    settings = resolveSettings(next)
    sessionStore.maxAgeDays = SessionStore.normalizeAge(settings.sessionDays)
    // A narrowed retention window takes effect now, not at the next login:
    // the load below discards a record the new policy already rejects (and
    // wipes it from disk), and the in-memory token goes with it — otherwise
    // the panel would keep serving the old session until the next restart.
    if (sessionStore.disabled) {
      sessionStore.clear() // persistence switched off: the file must not linger
    } else {
      const stored = sessionStore.load()
      if (!stored && client) client.invalidate({ keepStored: true })
    }
    const cachePath = cachePathFor(settings)
    if (cachePath !== cacheStore.path) {
      cacheStore.clear() // moving the cache must not strand the previous file
      cacheStore.path = cachePath
    }
    cacheStore.enabled = settings.localCache
    if (!settings.localCache) cacheStore.clear()
    if (client) client.reconfigure(settings)
    else client = newClient()
    startLiveSync() // the server URL may have changed: rebuild the channel
    scheduleSweep() // interval / on-off may have changed
  }

  // ── configuration ──────────────────────────────────────────────────────────
  // 0.2.0 has no settings-scope registration: the loader owns the entry config
  // (named by the entry id, which is also the id the settings form addresses)
  // and restarts this plugin when a form writes it, so `apply(ctx, config)`
  // always sees the current values. The settings service is needed only to
  // write from the panel's setup form.
  let settingsService = null
  ctx.inject(['settings'], (sctx) => {
    settingsService = sctx.settings
  })

  /**
   * Panel-facing configuration surface for the gateway: the live resolved
   * settings, and a write that goes through the host settings service (the
   * same path the settings form uses) so both stay consistent. The write
   * triggers a loader restart, which re-runs `apply` with the new config.
   */
  const configBridge = {
    getSettings: () => settings,
    update: async (patch) => {
      if (!settingsService || typeof settingsService.update !== 'function') {
        throw new VaultError('宿主设置服务不可用，请到 设置 → 插件 → dsh-vaultwarden 修改', { code: 'no_settings_service' })
      }
      await settingsService.update(SETTINGS_NS, patch)
      // Apply eagerly as well: a caller that reads the status right after the
      // write must not wait for the loader restart to observe the change.
      reconfigure({ ...settings, ...patch })
    },
  }

  /**
   * Write-back is opt-in, in three tiers:
   *  - `readonly` (default): every mutation is refused up front.
   *  - `ask`: allowed only after the user approves the call through DSH's
   *    approval seam (see the `tools/pre-execute` hook near the tool
   *    registrations); with no approval channel composed, `ask` denies.
   *  - `auto`: writes go straight through.
   *
   * The refusal lives here, next to the tier it enforces, and is handed to the
   * mutation layer as a `guard` so the model tools, the gateway RPCs and any
   * future caller all pass through the same gate — the tool wrappers alone used
   * to carry it, which left the RPC channel unguarded.
   *
   * The guard reads the action, because one action is not like the others:
   * `purge` (the unrecoverable delete) is refused unless the tier is `ask`.
   * Under `auto` the ordinary writes go through unattended by design, but an
   * irreversible one must still have a human in front of it, and `ask` is the
   * only tier that puts one there (the `tools/pre-execute` hook below). The
   * previous guard ignored its argument, so one `bitwarden_delete` call with
   * `permanent: true, confirm: true` under `auto` destroyed a credential with
   * no prompt at all — a model-supplied boolean standing in for the operator.
   */
  const writeRefusal = () =>
    '写回已停用：当前 accessMode 为 readonly。确认要写入 Vaultwarden，请在 DSH 设置 → 插件 → bitwarden 把 accessMode 改为 ask（每次询问）或 auto（直接写入）。'
  const purgeRefusal = () =>
    '彻底删除需要人工逐次确认，当前 accessMode 不允许：请在 DSH 设置 → 插件 → bitwarden 把 accessMode 改为 ask（每次询问）后再调用；只想删除请省略 permanent（进回收站，可用 bitwarden_restore 恢复）。'
  const writeGuard = (action) => {
    const tier = settings.accessMode
    if (tier === 'readonly') return { message: writeRefusal(), code: 'write_disabled' }
    if (action === 'purge' && tier !== 'ask') {
      return { message: purgeRefusal(), code: 'purge_needs_approval', hint: 'permanent 删除不可恢复，只在 ask 档（逐次人工确认）可用' }
    }
    return null
  }
  /** @type {VaultMutations | null} */
  let mutations = null
  const getMutations = () => {
    if (!mutations) mutations = new VaultMutations(getClient(), { guard: writeGuard })
    return mutations
  }
  const parseUris = (raw) =>
    String(raw ?? '')
      .split(/[,，]/)
      .map((value) => value.trim())
      .filter(Boolean)
  const parseFields = (raw) => {
    if (!raw) return undefined
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      throw new VaultError('fields 不是合法 JSON', { code: 'bad_request', hint: '形如 [{"name":"环境","value":"prod"}]' })
    }
    if (!Array.isArray(value)) throw new VaultError('fields 必须是 JSON 数组', { code: 'bad_request' })
    return value
  }
  /** Parse an optional JSON-object parameter (card / identity / sshKey / secureNote). */
  const parseJsonObject = (raw, label) => {
    if (raw === undefined || raw === null || raw === '') return undefined
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      throw new VaultError(`${label} 不是合法 JSON`, { code: 'bad_request', hint: `形如 {"key":"value"} 的 JSON 对象` })
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new VaultError(`${label} 必须是 JSON 对象`, { code: 'bad_request' })
    }
    return value
  }
  /** Parse an optional JSON-array parameter (collectionIds). */
  const parseJsonArray = (raw, label) => {
    if (raw === undefined || raw === null || raw === '') return undefined
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      throw new VaultError(`${label} 不是合法 JSON`, { code: 'bad_request', hint: '形如 ["col-1","col-2"] 的 JSON 数组' })
    }
    if (!Array.isArray(value)) throw new VaultError(`${label} 必须是 JSON 数组`, { code: 'bad_request' })
    return value
  }

  // ── proactive guidance in every session ────────────────────────────────────
  /** The base guidance plus the maskMode line, so the model knows the reveal
   *  protocol before it sees its first {{BW_*}} placeholder. */
  const promptText = () => {
    const lines = [PROMPT_TEXT]
    if (settings.maskMode) {
      lines.push(
        '脱敏模式开启：bitwarden_get 返回 {{BW_<类型>_<标签>}} 占位符而不是明文。占位符稳定（同一条目同一字段同值恒同标签），可以直接引用与比较；只有确需明文完成任务（填表/登录/派生 token）时才调用 bitwarden_reveal 按条目+字段取一次，取到的明文不要回显、不要写盘。',
      )
    }
    return lines.join('')
  }
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PROMPT_SECTION,
        order: PROMPT_ORDER,
        text: promptText(),
        // The mask guidance quotes a literal `{{BW_<类型>_<标签>}}` placeholder.
        // dsh-system-prompt interpolates every section by default and treats
        // `{{…}}` as a variable reference, so an unescaped one aborts prompt
        // assembly ("malformed prompt variable reference"). The host has no
        // inline escape syntax, so opt this whole section out instead.
        interpolate: false,
      }),
    'dsh-vaultwarden: vault guidance section',
  )

  // ── live sync (WebSocket notifications, polling fallback) ───────────────────
  /**
   * Warm the session and the vault cache in the background at activation.
   *
   * `resumeSession()` only restores a stored file and swaps a refresh token,
   * so a two-factor account is never challenged here; the unlock that follows
   * fills the cache the list read hits. Without it the first panel open after
   * a restart pays for a full sync plus decryption, which is the other half
   * of "not instant".
   */
  const warmUp = () => {
    try {
      const target = getClient()
      target
        .resumeSession()
        .then((resumed) => (resumed ? target.unlock() : null))
        .catch(() => {})
    } catch {
      // Warming is best effort: a failure here must not break activation.
    }
  }
  ctx.effect(() => {
    liveRunning = true
    startLiveSync()
    warmUp()
    return () => {
      liveRunning = false
      client?.stopLiveSync()
    }
  }, 'dsh-vaultwarden: live sync')

  // ── periodic log sweep (sweepMode) ───────────────────────────────────────────
  // A setInterval (not ctx.setInterval: the sweep is deliberately untraced —
  // it is maintenance, not a plugin-visible side effect) over idle logs only.
  // See lib/sweeper.js for what "idle" means and what gets replaced.
  let sweepTimer = null
  // The sweep decodes and re-encodes logs off the main thread, so a tick can
  // still be running when the next one fires — on a slow disk one round can
  // outlast the interval. Skip the overlap instead of queueing a backlog.
  let sweepRunning = false
  // After an upgrade the state book is empty, so every log looks new and the
  // backlog takes many budgeted rounds to clear. Chaining those rounds back to
  // back finishes the catch-up in minutes instead of a whole interval per
  // round, without ever exceeding one round's time slice: the budget is what
  // bounds the work, not the timer. Chaining stops as soon as a round has
  // nothing pending or the plugin is disposed.
  let sweepDisposed = false
  // Two independent caps on the chain: a round count and a wall-clock total.
  // The state book means a half-finished catch-up costs nothing to resume at
  // the next interval, so stopping early is always safe — these exist purely
  // so a slow disk cannot turn one tick into minutes of sustained CPU.
  const SWEEP_CHAIN_LIMIT = 100
  const SWEEP_CHAIN_BUDGET_MS = 120_000
  // The catch-up that follows an upgrade is a one-off backlog, but it lands
  // exactly when the host is still bringing plugins up. Give that first run a
  // small slice and start it later, so the remaining backlog drains over the
  // following intervals instead of competing with startup. The state book makes
  // stopping early free: the next tick resumes from where this one left off.
  const SWEEP_BOOT_DELAY_MS = 60_000
  const SWEEP_BOOT_BUDGET_MS = 20_000
  const sweepTick = async ({ boot = false } = {}) => {
    if (!settings.sweepMode || sweepRunning) return
    sweepRunning = true
    const chainStart = Date.now()
    const chainBudget = boot ? SWEEP_BOOT_BUDGET_MS : SWEEP_CHAIN_BUDGET_MS
    try {
      for (let round = 0; round < SWEEP_CHAIN_LIMIT; round++) {
        const report = await sweepAll(sessionsRootFor())
        if (report.redactedValues > 0 || report.errors.length > 0) {
          console.log('[dsh-vaultwarden] 日志擦除：' + JSON.stringify(report))
        }
        if (!report.pending || sweepDisposed || !settings.sweepMode) break
        if (Date.now() - chainStart > chainBudget) break
        // Yield to the event loop between rounds so timer and RPC work interleaves.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } catch (error) {
      console.error('[dsh-vaultwarden] 日志擦除失败：' + (error?.message ?? error))
    } finally {
      sweepRunning = false
    }
  }
  const scheduleSweep = () => {
    if (sweepTimer) clearInterval(sweepTimer)
    sweepTimer = null
    const minutes = Math.max(5, Number(settings.sweepIntervalMinutes) || 30)
    if (!settings.sweepMode || settings.sweepIntervalMinutes === 0) return
    sweepTimer = setInterval(sweepTick, minutes * 60_000)
  }
  ctx.effect(() => {
    scheduleSweep()
    // Run once after activation, but deliberately late and on a short leash: a
    // restart right after a reveal-heavy session should not wait a whole
    // interval for the first cleanup, yet the sweep must not compete with the
    // host's own plugin start-up.
    const early = setTimeout(() => sweepTick({ boot: true }), SWEEP_BOOT_DELAY_MS)
    return () => {
      sweepDisposed = true
      clearInterval(sweepTimer)
      clearTimeout(early)
    }
  }, 'dsh-vaultwarden: log sweep timer')

  // ── Remote gateway for the browser half ────────────────────────────────────
  // The settings page reads the vault through the `/api` connection RPC
  // channel, which carries the operator's authenticated session. A plugin-owned
  // HTTP route would bypass that authentication, so we deliberately serve none.
  ctx.plugin(VaultGateway, { getClient, createClient: newClient, owner: configBridge, guard: writeGuard })

  // ── tools ──────────────────────────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_find',
          description: '检索 Bitwarden/Vaultwarden 凭据条目（只返回元信息，不含密码）；需要任何账号/密码时先调用。',
          parameters: {
            query: { type: 'string', required: true, description: '关键词：名称、用户名、网址或备注，可多词' },
            limit: { type: 'integer', description: '返回条数上限，默认 8，最大 25' },
            includeArchived: { type: 'boolean', description: '连归档条目一起检索（默认不列）' },
            includeTrashed: { type: 'boolean', description: '连回收站条目一起检索（默认不列）' },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              return await getClient().find(args.query, args.limit ?? 8, exec?.signal, {
                includeArchived: Boolean(args.includeArchived),
                includeTrashed: Boolean(args.includeTrashed),
              })
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_find',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_get',
          description: '取出某条凭据的密码、用户名、当前 TOTP 码或自定义字段（id 或名称定位）。默认 field=all 只回常用字段；卡号、身份信息、安全笔记、SSH 私钥与隐藏型自定义字段必须点名各自的 field。maskMode 开启时 password/TOTP/卡号等字段返回 {{BW_*}} 占位符而非明文：占位符只可引用与比较，不能作为凭据值提交；确需明文（登录、填表、派生 token）时先调 bitwarden_reveal 取回。',
          parameters: {
            id: { type: 'string', description: '条目 id（来自 bitwarden_find）' },
            name: { type: 'string', description: '或条目名称（需唯一匹配）' },
            field: {
              type: 'string',
              enum: ['all', 'password', 'username', 'totp', 'notes', 'fields', 'card', 'identity', 'sshKey', 'secureNote', 'passwordHistory'],
              description: '取哪个字段，默认 all。all 不含 TOTP 验证码（30 秒即失效）、卡号/身份信息/安全笔记正文/SSH 私钥/历史密码，以及「隐藏」型自定义字段的值（占位 <hidden>，需 field=fields 显式取），只用 hasTotp/hasCard 等布尔位与 passwordHistoryCount 告知存在',
            },
            includeTrashed: {
              type: 'boolean',
              description: '该条目在回收站里时也照读（默认拒绝，提示先恢复）',
            },
            waitFresh: {
              type: 'boolean',
              description: '仅用于 field=totp：当前验证码剩余时间不足 minRemaining 时，等到下一个 30 秒窗口再返回，保证交出去的不是一个刚要过期的码。默认 false',
            },
            minRemaining: {
              type: 'number',
              description: '配合 waitFresh 使用：至少还需要多少秒才用得上（默认 20，上限 59）',
            },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              const ref = args.id || args.name
              const raw = await getClient().get(ref, args.field ?? 'all', exec?.signal, {
                includeTrashed: Boolean(args.includeTrashed),
                waitFresh: Boolean(args.waitFresh),
                minRemaining: args.minRemaining,
                // This is the model-facing call: hidden custom field values are
                // withheld here and only here. The panel reveal (vw/reveal)
                // keeps them so it can render them masked.
                maskHiddenFields: true,
              })
              // maskMode: the model gets stable placeholders, not plaintext.
              // The vault stays the authority; bitwarden_reveal is the door.
              if (settings.maskMode) {
                const key = maskKeyFor()
                if (key) {
                  try {
                    const projected = JSON.parse(raw)
                    maskProjection(projected, key, projected?.id ?? String(ref ?? ''))
                    return JSON.stringify(projected, null, 2)
                  } catch {
                    // a non-JSON get result passes through as-is
                  }
                }
              }
              return raw
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_get',
  )

  // -- reveal: the one deliberate plaintext read (maskMode) --------------------
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_reveal',
          description:
            '取回占位符背后的明文（maskMode 开启时才有意义）。bitwarden_get 在脱敏模式下只给占位符；确因任务需要明文（填表、登录、派生 token）时用本工具按条目+字段取一次，用完即弃，不要回显或写入文件。',
          parameters: {
            id: { type: 'string', description: '条目 id（来自 bitwarden_find）' },
            name: { type: 'string', description: '或条目名称（需唯一匹配）' },
            field: {
              type: 'string',
              enum: ['password', 'username', 'totp', 'notes', 'fields', 'card', 'identity', 'sshKey', 'secureNote', 'passwordHistory'],
              description: '要取回的字段；与产生占位符的那次 bitwarden_get 的 field 对应（all 不在此列：需要哪个字段就点名哪个）',
            },
            includeTrashed: { type: 'boolean', description: '该条目在回收站里时也照读' },
            waitFresh: { type: 'boolean', description: '仅 field=totp：等下一个 30 秒窗口取新码' },
            minRemaining: { type: 'number', description: '配合 waitFresh：至少还需剩余秒数（默认 20，上限 59）' },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              if (!settings.maskMode) {
                return 'maskMode 未开启：bitwarden_get 本来就返回明文，无需 reveal。若想默认脱敏，请到 设置 → 插件 → bitwarden 打开「占位符脱敏」。'
              }
              const ref = args.id || args.name
              if (!ref) return '需要 id 或 name 来定位条目。'
              return await getClient().get(ref, args.field ?? 'password', exec?.signal, {
                includeTrashed: Boolean(args.includeTrashed),
                waitFresh: Boolean(args.waitFresh),
                minRemaining: args.minRemaining,
                maskHiddenFields: false,
              })
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_reveal',
  )

  // -- sweep: manual log redaction run ----------------------------------------
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_sweep',
          description:
            '立即扫描本地 DSH 会话日志并擦除 bitwarden 相关事件里已落盘的明文（password/totp/卡号等 → [REDACTED:BW]；占位符保留）。进行中的会话跳过。通常无需调用：开启「日志擦除」后有定时扫描。',
          parameters: {},
          output: { schema: { type: 'string' }, render: asText },
          async execute(_args, exec) {
            try {
              const root = sessionsRootFor()
              // An explicit request overrides the incremental heuristics: rescan
              // every log in full, ignoring the byte budget and the unchanged
              // fast path, so this is always a trustworthy "check everything".
              const report = await sweepAll(root, { full: true })
              return JSON.stringify({ root, ...report, at: new Date().toISOString() }, null, 2)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_sweep',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_status',
          description:
            '密码库状态：配置是否完整、服务器是否可达、是否已解锁、缓存条目数，以及回收站与归档条目数（trashed / archived）。',
          parameters: {
            refresh: { type: 'boolean', description: 'true 时丢弃缓存并重新登录同步' },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              return await getClient().status({ refresh: Boolean(args.refresh), signal: exec?.signal })
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_status',
  )

  // ── force a sync ───────────────────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_sync',
          description: '强制重新同步并解密保险库（通常不必调用：WebSocket/轮询会自动同步）。',
          parameters: {},
          output: { schema: { type: 'string' }, render: asText },
          async execute(_args, exec) {
            try {
              const vault = await getClient().syncNow(exec?.signal)
              return JSON.stringify({ ok: true, items: vault.items.length, syncedAt: new Date().toISOString() }, null, 2)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_sync',
  )

  // ── folders: names are not ids ─────────────────────────────────────────────
  // `bitwarden_find` reports a folder's NAME; every write takes its ID. Without
  // this list a model that wants to file an entry has to guess an id, which is
  // both wrong and silent.
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_folders',
          description: '列出密码库的文件夹（id、名字、条目数）与未归档条目的数量；folderId 参数要用这里的 id。',
          parameters: {},
          output: { schema: { type: 'string' }, render: asText },
          async execute(_args, exec) {
            try {
              return await getClient().folderList(exec?.signal)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_folders',
  )

  // ── write-back (accessMode=ask/auto; personal and organization items) ──────
  const WRITE_FIELDS = {
    username: { type: 'string', description: '用户名' },
    password: { type: 'string', description: '密码' },
    totp: { type: 'string', description: 'TOTP：otpauth:// URI 或 Base32 密钥' },
    uris: { type: 'string', description: '网址，多个用逗号分隔' },
    notes: { type: 'string', description: '备注' },
    fields: { type: 'string', description: '自定义字段 JSON 数组，如 [{"name":"环境","value":"prod"}]' },
    folderId: { type: 'string', description: '文件夹 id（来自 bitwarden_folders）；传空字符串移出文件夹' },
    favorite: { type: 'boolean', description: '收藏' },
    reprompt: { type: 'boolean', description: '开启 Bitwarden「重新验证」（读取时需确认）' },
  }

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_create',
          description:
            '在 Vaultwarden 创建一条条目（需要 accessMode=ask/auto）：type 默认 login，也支持 secureNote/card/identity/sshKey；个人条目直接创建，组织条目传 organizationId + collectionIds。',
          parameters: {
            name: { type: 'string', required: true, description: '条目名称' },
            type: {
              type: 'string',
              enum: ['login', 'secureNote', 'card', 'identity', 'sshKey'],
              description: '条目类型，默认 login',
            },
            notes: { type: 'string', description: '备注' },
            card: { type: 'string', description: '银行卡字段 JSON，如 {"cardholderName":"张三","brand":"Visa","number":"4111...","expMonth":"09","expYear":"2030","code":"123"}' },
            identity: { type: 'string', description: '身份字段 JSON，如 {"firstName":"三","lastName":"张","email":"a@b.c"}' },
            secureNote: { type: 'string', description: '安全笔记 JSON（可选）：{"type":0}' },
            sshKey: { type: 'string', description: 'SSH 密钥字段 JSON，如 {"privateKey":"...","publicKey":"...","keyFingerprint":"..."}' },
            organizationId: { type: 'string', description: '组织 id（创建组织条目时必传）' },
            collectionIds: { type: 'string', description: '组织集合 id JSON 数组，如 ["col-1"]' },
            ...WRITE_FIELDS,
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              const created = await getMutations().create(
                {
                  name: args.name,
                  type: args.type ?? 'login',
                  username: args.username,
                  password: args.password,
                  totp: args.totp,
                  uris: args.uris === undefined ? undefined : parseUris(args.uris),
                  notes: args.notes,
                  fields: parseFields(args.fields),
                  folderId: args.folderId,
                  favorite: args.favorite,
                  reprompt: args.reprompt ? 1 : 0,
                  card: parseJsonObject(args.card, 'card'),
                  identity: parseJsonObject(args.identity, 'identity'),
                  secureNote: parseJsonObject(args.secureNote, 'secureNote'),
                  sshKey: parseJsonObject(args.sshKey, 'sshKey'),
                  organizationId: args.organizationId,
                  collectionIds: parseJsonArray(args.collectionIds, 'collectionIds'),
                },
                exec?.signal,
              )
              return JSON.stringify(created, null, 2)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_create',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_update',
          description:
            '修改一条条目（需要 accessMode=ask/auto；个人与组织条目都可；未传的字段保持原值，包括 fido2、附件、密码历史等本工具不认识的服务端字段）。',
          parameters: {
            id: { type: 'string', required: true, description: '条目 id（来自 bitwarden_find）' },
            name: { type: 'string', description: '条目名称' },
            archived: { type: 'boolean', description: 'true=归档（默认列表不显示），false=取消归档' },
            card: { type: 'string', description: '银行卡字段 JSON（同 bitwarden_create）' },
            identity: { type: 'string', description: '身份字段 JSON（同 bitwarden_create）' },
            sshKey: { type: 'string', description: 'SSH 密钥字段 JSON（同 bitwarden_create）' },
            ...WRITE_FIELDS,
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              const updated = await getMutations().update(
                args.id,
                {
                  name: args.name,
                  username: args.username,
                  password: args.password,
                  totp: args.totp,
                  uris: args.uris === undefined ? undefined : parseUris(args.uris),
                  notes: args.notes,
                  fields: parseFields(args.fields),
                  folderId: args.folderId,
                  favorite: args.favorite,
                  reprompt: args.reprompt === undefined ? undefined : args.reprompt ? 1 : 0,
                  archived: args.archived,
                  card: parseJsonObject(args.card, 'card'),
                  identity: parseJsonObject(args.identity, 'identity'),
                  sshKey: parseJsonObject(args.sshKey, 'sshKey'),
                },
                exec?.signal,
              )
              return JSON.stringify(updated, null, 2)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_update',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_delete',
          description:
            '删除一条条目（需要 accessMode=ask/auto）。默认软删除进回收站，可用 bitwarden_restore 恢复；仅在用户明确要求彻底删除时才用 permanent: true，且必须同时传 confirm: true。彻底删除只在 accessMode=ask（逐次人工确认）下可用，auto/readonly 会拒绝。',
          parameters: {
            id: { type: 'string', required: true, description: '条目 id（来自 bitwarden_find）' },
            permanent: { type: 'boolean', description: 'true = 彻底删除（不可恢复，必须同时传 confirm: true；仅 accessMode=ask 允许）' },
            confirm: { type: 'boolean', description: '对 permanent 删除的显式确认；没有它 permanent 会被拒绝' },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              const removed = await getMutations().remove(
                args.id,
                { permanent: Boolean(args.permanent), confirm: Boolean(args.confirm) },
                exec?.signal,
              )
              return JSON.stringify(removed, null, 2)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_delete',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_restore',
          description:
            '把回收站中的条目恢复出来（需要 accessMode=ask/auto）；id 用 bitwarden_find 传 includeTrashed: true 查。',
          parameters: {
            id: { type: 'string', required: true, description: '条目 id（来自 bitwarden_find，回收站中的条目需传 includeTrashed: true）' },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              const restored = await getMutations().restore(args.id, exec?.signal)
              return JSON.stringify(restored, null, 2)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_restore',
  )

  // ── accessMode=ask: approve each write through DSH's approval seam ─────────
  // Returns `{ kind: 'ask' }` only for the write-back tools, and only in the
  // `ask` tier; any other call falls through untouched. DSH resolves the ask
  // against the composed ApprovalService: `allowed-once` proceeds, and a
  // deployment with no approval channel denies (the safe direction).
  const WRITE_TOOLS = new Set(['bitwarden_create', 'bitwarden_update', 'bitwarden_delete', 'bitwarden_restore'])
  // An unrecoverable delete is spelled out in the prompt itself: the operator
  // about to approve a write deserves to know that this one has no undo, and
  // the guard above already limits `purge` to this tier for the same reason.
  const isPurge = (exec) => exec?.name === 'bitwarden_delete' && exec?.arguments?.permanent === true
  ctx.effect(
    () =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        if (settings.accessMode !== 'ask' || !WRITE_TOOLS.has(exec?.name)) return next()
        if (isPurge(exec)) {
          return {
            kind: 'ask',
            reason: '彻底删除 Vaultwarden 条目（不可恢复）',
            displayReason: {
              en: 'Permanently delete this Vaultwarden entry? This cannot be undone.',
              zh: '彻底删除这条 Vaultwarden 条目吗？此操作不可恢复。',
            },
          }
        }
        return {
          kind: 'ask',
          reason: '写入 Vaultwarden（accessMode=ask）',
          displayReason: {
            en: `Allow this write to Vaultwarden? (${exec.name})`,
            zh: `允许这次写入 Vaultwarden 吗？（${exec.name}）`,
          },
        }
      }),
    'dsh-vaultwarden: accessMode=ask approval gate',
  )
}

export default { name, inject, Config, apply }
