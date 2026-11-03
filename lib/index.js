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
import { readFileSync, statSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { VaultClient, VaultError, normalizeServerUrl } from './vault.js'
import { VaultMutations } from './mutations.js'
import { VaultGateway } from './gateway.js'
import { SessionStore, defaultSessionPath } from './session-store.js'
import { CacheStore, defaultCachePath } from './cache-store.js'
import { loadMaskKey, defaultMaskKeyPath, maskProjection, decorateMaskedProjection } from './mask.js'
import { defaultPasskeyExportDir, removePasskeyExports } from './passkey.js'
import { sweepAll } from './sweeper.js'
import { withSettingsLockRetry } from './settings-write.js'
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
    .description('写权限与敏感导出：readonly=只读（拒绝创建/修改/删除，也拒绝导出通行密钥）；ask=需用户在对话中确认后才写/导出；auto=直接写回、导出不再确认'),
  maskEnabled: z
    .boolean()
    .default(true)
    .volatile()
    .description(
      '插件脱敏（默认开启）：开启后 bitwarden_get 只返回 {{BW_*}} 占位符而不给明文，并在「密码库」显示脱敏轨迹页。关闭后密码、TOTP、卡号等会以明文进入模型上下文与会话日志，可能被其它插件、备份或读取日志的人看到，存在泄露风险；仅当你已使用其它本地脱敏服务时关闭。',
    ),
  // Legacy spelling kept parseable for existing profiles (the old switch
  // meant exactly this feature). It is deliberately NOT volatile: the host
  // form now presents the single maskEnabled master switch above, while a
  // stored maskMode still opts out on upgrade instead of silently coming
  // back on with the new default.
  maskMode: z
    .boolean()
    .default(true)
    .description('（兼容旧配置）占位符脱敏，等同于 maskEnabled；新配置请使用 maskEnabled'),
  sweepMode: z
    .boolean()
    .default(false)
    .volatile()
    .description('日志擦除：插件脱敏开启时，定时扫描本地 DSH 会话日志，把 bitwarden 相关事件里已落盘的明文（password/totp/卡号等）替换为带类别的标记（[REDACTED:BW_PASSWORD] 等）；只处理闲置会话，进行中的会话不动'),
  sweepIntervalMinutes: z
    .natural()
    .default(30)
    .volatile()
    .description('日志擦除的定时扫描间隔（分钟，最小 5；0=关闭定时，仍可手动 bitwarden_sweep）'),
})

// The host budget for one plugin prompt section is 400 characters (the
// host-entry test enforces it). Keep this section policy-only and under that
// cap: per-tool mechanics — mask/reveal, passkey export and cleanup — live in
// the tool descriptions, which the model receives on every step anyway.
// English keeps the token cost far below the same rules written in Chinese.
const PROMPT_TEXT = [
  'Bitwarden/Vaultwarden vault: query it first for any password/account/API key/token/login; never ask the user first ("in Bitwarden" too).',
  'If unconfigured/unreachable/login fails, point the user to DSH Settings→Plugins→bitwarden.',
  'Plaintext: task-only; never echo, write or log.',
  'Never probe repromptRequired; only a user-entered master password in Settings→Vault unlocks.',
].join(' ')

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
  // The plugin-wide masking switch. A profile written before this setting
  // existed only has the old `maskMode` spelling, so it is the migration
  // source: an explicit false there stays off after upgrade. Everything else
  // (a fresh install, or a profile that never chose) starts masked.
  const maskEnabledRaw = field('maskEnabled')
  const maskModeRaw = field('maskMode')
  // A boolean is the real value. Schemastery's bare parse can hand back a
  // placeholder object for a volatile field outside the loader; treat that
  // as absent so a legacy profile's explicit maskMode:false still wins.
  const maskEnabled =
    typeof maskEnabledRaw === 'boolean'
      ? maskEnabledRaw
      : typeof maskModeRaw === 'boolean'
        ? maskModeRaw
        : true
  const sweepModeRaw = field('sweepMode')
  const sweepRequested = typeof sweepModeRaw === 'boolean' ? sweepModeRaw : false
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
    // A value below the floor is CLAMPED to it (the schema documents "最小
    // 30"), not silently replaced by the 300 s default.
    pollIntervalSeconds: Number.isFinite(pollRaw) ? Math.max(MIN_POLL_SECONDS, pollRaw) : DEFAULT_POLL_SECONDS,
    deviceIdentifier: String(field('deviceIdentifier') || env(['DSH_BITWARDEN_DEVICE_ID', 'BITWARDEN_DEVICE_ID']) || '').trim(),
    accessMode: (accessModeRaw => (ACCESS_MODES.includes(accessModeRaw) ? accessModeRaw : 'readonly'))(field('accessMode')),
    sessionDays: Number.isFinite(Number(field('sessionDays'))) ? Math.max(0, Number(field('sessionDays'))) : 30,
    repromptGrantMinutes: Number.isFinite(Number(field('repromptGrantMinutes')))
      ? Math.max(1, Number(field('repromptGrantMinutes')))
      : 5,
    maskEnabled,
    // Kept as an alias so every existing consumer (tools, status report,
    // VaultClient) keeps reading the same field. `maskEnabled` is the master
    // switch; there is no second placeholder switch any more.
    maskMode: maskEnabled,
    // Log scrubbing belongs to the same feature: turning plugin masking off
    // must also stop the timer, or secrets would keep disappearing from logs
    // while the masking trail page is hidden. The requested value is kept
    // separately so flipping the master back on restores the operator's
    // own sweep choice instead of leaving it off.
    sweepModeRequested: sweepRequested,
    sweepMode: maskEnabled && sweepRequested,
    sweepIntervalMinutes: Number.isFinite(Number(field('sweepIntervalMinutes')))
      ? Math.max(0, Math.round(Number(field('sweepIntervalMinutes'))))
      : 30,
    // Composition-only knobs (not in the user settings schema): without these
    // a custom path configured through the entry config was silently dropped
    // and every record landed on the default path instead.
    sessionPath: String(field('sessionPath') ?? '').trim(),
    cachePath: String(field('cachePath') ?? '').trim(),
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

  /**
   * Mirror a `.volatile()` config edit into the running plugin.
   *
   * DSH's settings form edits only volatile fields, and the loader commits
   * those values into the existing config reference objects without remounting
   * the plugin (see `cordis-plugin-loader`'s `_commitVolatile`). This closure
   * took its `settings` snapshot at `apply()` time, so without a listener the
   * host form would appear to save while the live gate, mask mode, sweep timer
   * and VaultClient kept the old values until a restart.
   */
  const applyVolatileSettings = () => {
    const next = resolveSettings(config)
    const previous = settings
    const accountChanged =
      previous.serverUrl !== next.serverUrl ||
      previous.email !== next.email ||
      previous.masterPassword !== next.masterPassword ||
      previous.deviceIdentifier !== next.deviceIdentifier ||
      previous.apiKeyClientId !== next.apiKeyClientId ||
      previous.apiKeyClientSecret !== next.apiKeyClientSecret
    settings = next
    if (!client) return
    if (accountChanged) {
      // A different server/account cannot reuse this client or its session.
      reconfigure(next)
      return
    }
    // Keep the live client's own settings fresh without invalidating its
    // token/vault: this is what makes `bitwarden_status` and the passkey audit
    // report the tier the gate actually uses.
    client.settings = { ...client.settings, ...next }
    if (previous.sessionDays !== next.sessionDays) {
      sessionStore.maxAgeDays = SessionStore.normalizeAge(next.sessionDays)
    }
    if (previous.localCache !== next.localCache || cachePathFor(previous) !== cachePathFor(next)) {
      const cachePath = cachePathFor(next)
      if (cachePath !== cacheStore.path) {
        cacheStore.clear()
        cacheStore.path = cachePath
      }
      cacheStore.enabled = next.localCache
      if (!next.localCache) cacheStore.clear()
    }
    if (previous.websocket !== next.websocket || previous.pollIntervalSeconds !== next.pollIntervalSeconds) {
      startLiveSync()
    }
    if (previous.sweepMode !== next.sweepMode || previous.sweepIntervalMinutes !== next.sweepIntervalMinutes) {
      scheduleSweep()
    }
  }

  // ── configuration ──────────────────────────────────────────────────────────
  // 0.2.0 has no settings-scope registration: the loader owns the entry config
  // (named by the entry id, which is also the id the settings form addresses).
  // `.volatile()` fields are committed into the running fiber's config
  // references without a remount, so the listener below mirrors them into the
  // live settings object instead of relying on a restart.
  let settingsService = null
  ctx.inject(['settings'], (sctx) => {
    settingsService = sctx.settings
  })

  /**
   * Panel-facing configuration surface for the gateway: the live resolved
   * settings, and a write that goes through the host settings service (the
   * same path the settings form uses) so both stay consistent. The host
   * commits `.volatile()` values into the running fiber without a restart;
   * the `loader/volatile-update` listener below mirrors them into this
   * plugin's live `settings`.
   */
  const configBridge = {
    getSettings: () => settings,
    /**
     * Change the access tier from the panel's permission card.
     *
     * This is deliberately separate from `update()`: the generic settings
     * writer ignores `accessMode` (a panel RPC must not raise the model's
     * write tier as a side effect of saving an unrelated field). Here the
     * request names that one field, and the panel asks the operator to confirm
     * before sending it. The live settings object is updated in place so a
     * permission change does not invalidate the vault session.
     */
    setAccessMode: async (mode) => {
      if (!settingsService || typeof settingsService.update !== 'function') {
        throw new VaultError('宿主设置服务不可用，请到 设置 → 插件 → dsh-vaultwarden 修改', { code: 'no_settings_service' })
      }
      // Retried: another profile write (the plugin market's install/update)
      // holds the same lock for a minute or more, and that contention is not
      // a reason to drop the tier change the operator just confirmed.
      await withSettingsLockRetry(() => settingsService.update(SETTINGS_NS, { accessMode: mode }))
      settings = { ...settings, accessMode: mode }
      // The panel's tier change must be visible to the live client at once:
      // statusReport() and the passkey audit read `client.settings`, not this
      // closure. A full reconfigure() would needlessly drop the vault session.
      client?.setAccessMode?.(mode)
      return settings
    },
    /**
     * Flip the plugin-wide masking switch from the panel’s security card.
     *
     * Separate from `update()` for the same reason as `setAccessMode`: one
     * named field, written after the operator passes the panel’s explicit
     * warning dialog. Both the resolved settings and the live client object
     * are updated in place, so statusReport() reflects the new state without
     * invalidating the vault session.
     */
    setMaskEnabled: async (enabled) => {
      if (!settingsService || typeof settingsService.update !== 'function') {
        throw new VaultError('宿主设置服务不可用，请到 设置 → 插件 → dsh-vaultwarden 修改', { code: 'no_settings_service' })
      }
      const next = Boolean(enabled)
      await withSettingsLockRetry(() => settingsService.update(SETTINGS_NS, { maskEnabled: next }))
      settings = { ...settings, maskEnabled: next, maskMode: next, sweepMode: next && Boolean(settings.sweepModeRequested) }
      client?.setMaskEnabled?.(next)
      client?.setSweepMode?.(settings.sweepMode)
      // The automatic log-scrubbing timer is part of this feature too:
      // turning the master off must stop it now, not at the next restart.
      scheduleSweep()
      return settings
    },
    update: async (patch) => {
      if (!settingsService || typeof settingsService.update !== 'function') {
        throw new VaultError('宿主设置服务不可用，请到 设置 → 插件 → dsh-vaultwarden 修改', { code: 'no_settings_service' })
      }
      await withSettingsLockRetry(() => settingsService.update(SETTINGS_NS, patch))
      // Apply eagerly as well: a caller that reads the status right after the
      // write must not wait for the loader restart to observe the change.
      reconfigure({ ...settings, ...patch })
    },
  }

  ctx.effect(
    () => ctx.on('loader/volatile-update', () => applyVolatileSettings()),
    'dsh-vaultwarden: live settings sync',
  )

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
  // A masked read is not a plaintext read. A model that copies a value from
  // bitwarden_get into bitwarden_create / bitwarden_update would otherwise
  // store the placeholder as the credential — the vault would then hold a
  // string that can never log in, and the next attempt looks like a wrong
  // password rather than a bad write. Reject it at the tool boundary,
  // before the mutation layer encrypts anything.
  const PLACEHOLDER_VALUE_RE = /\{\{BW_[A-Z]+_[a-z2-7]{8}\}\}/
  const rejectMaskedValue = (value, label) => {
    if (typeof value === 'string' && PLACEHOLDER_VALUE_RE.test(value)) {
      throw new VaultError(`不能把脱敏占位符写回密码库（${label}）`, {
        code: 'masked_value',
        hint: '这个值是 bitwarden_get 返回的占位符，不是真实凭据；请先用 bitwarden_reveal 按条目+字段取明文，或不要提交该字段。',
      })
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => rejectMaskedValue(child, `${label}[${index}]`))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) rejectMaskedValue(child, `${label}.${key}`)
    }
  }
  const guardWriteArgs = (args, tool) => {
    for (const key of ['password', 'totp', 'notes']) rejectMaskedValue(args[key], `${tool}.${key}`)
    for (const key of ['fields', 'card', 'identity', 'sshKey', 'secureNote']) {
      const raw = args[key]
      if (typeof raw !== 'string' || raw === '') continue
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue // the existing parameter parsers report the malformed JSON
      }
      rejectMaskedValue(parsed, `${tool}.${key}`)
    }
  }

  // ── proactive guidance in every session ────────────────────────────────────
  /** Static on purpose: settings changes must not rewrite the prompt, and every
   *  per-tool detail is already in that tool's description. */
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PROMPT_SECTION,
        order: PROMPT_ORDER,
        text: PROMPT_TEXT,
        // Keep the section literal: prompt text is model-facing policy, never a
        // template. An accidental `{{…}}` must not abort host assembly.
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
    // A reconfigure that lands after the dispose effect ran (the host may
    // resolve the settings write while it tears the plugin down) must not
    // resurrect an interval nothing will ever clear again.
    if (sweepDisposed) return
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
  ctx.plugin(VaultGateway, { getClient, createClient: newClient, owner: configBridge, guard: writeGuard, maskKey: maskKeyFor })

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
          description: '取出某条凭据的密码、用户名、当前 TOTP 码或自定义字段（id 或名称定位）。默认 field=all 只回常用字段；卡号、身份信息、安全笔记、SSH 私钥与隐藏型自定义字段必须点名各自的 field。maskMode 开启时 password/TOTP/卡号等字段返回 {{BW_*}} 占位符而非明文：占位符只可引用与比较，不能作为密码、令牌或验证码提交给任何服务；确需明文（登录、填表、派生 token）时按条目+字段调用 bitwarden_reveal 取一次。若占位符被目标拒绝（如提示用户名或密码错误），先调 bitwarden_reveal 取明文再重试，不要换条目、改用户名或反复重试，以免触发账号锁定。',
          parameters: {
            id: { type: 'string', description: '条目 id（来自 bitwarden_find）' },
            name: { type: 'string', description: '或条目名称（需唯一匹配）' },
            field: {
              type: 'string',
              enum: ['all', 'password', 'username', 'totp', 'notes', 'fields', 'card', 'identity', 'sshKey', 'secureNote', 'passwordHistory', 'passkeys'],
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
                if (!key) {
                  throw new VaultError('脱敏模式已开启，但掩码密钥不可用，拒绝返回明文', {
                    code: 'mask_unavailable',
                    hint: '请检查 DSH 数据目录（data/dsh-vaultwarden/mask.key）的权限、磁盘空间与文件状态；修复前不要关闭 maskMode 来绕过这条保护。',
                  })
                }
                try {
                  const projected = JSON.parse(raw)
                  maskProjection(projected, key, projected?.id ?? String(ref ?? ''))
                  decorateMaskedProjection(projected)
                  return JSON.stringify(projected, null, 2)
                } catch (error) {
                  throw new VaultError('脱敏处理失败，拒绝返回明文', {
                    code: 'mask_failed',
                    hint: '这是脱敏层的故障，不是密码库里的密码错误；请检查 mask.key 与日志后重试，不要改用其他条目继续登录。',
                  })
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

  // -- passkeys: metadata in the vault, private key only through a proven export --
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_passkey_list',
          description:
            '列出一条凭据保存的通行密钥（passkey）元数据：站点 rpId、用户名、是否可发现、创建时间、算法。只返回元数据，不返回私钥。',
          parameters: {
            id: { type: 'string', description: '条目 id（来自 bitwarden_find）' },
            name: { type: 'string', description: '或条目名称（需唯一匹配）' },
            includeTrashed: { type: 'boolean', description: '该条目在回收站里时也照读' },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              const ref = args.id || args.name
              if (!ref) return '需要 id 或 name 来定位条目。'
              return JSON.stringify(
                await getClient().passkeyList(ref, exec?.signal, { includeTrashed: Boolean(args.includeTrashed) }),
                null,
                2,
              )
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_passkey_list',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_passkey_export',
          description:
            '把一条通行密钥导出为 0600 权限的 WebAuthn 凭据文件（CDP 形状：credentialId/privateKey/rpId/userHandle/signCount），返回文件路径而不是私钥本身。受 accessMode 控制：readonly 拒绝，ask 会在对话里请求用户批准，auto 直接执行。文件内含私钥；用完后调用 bitwarden_passkey_cleanup 立即删除。',
          parameters: {
            id: { type: 'string', description: '条目 id（来自 bitwarden_find）' },
            name: { type: 'string', description: '或条目名称（需唯一匹配）' },
            credentialId: { type: 'string', description: '要导出的通行密钥 id（来自 bitwarden_passkey_list 的 credentialId）；缺省第一条' },
            includeTrashed: { type: 'boolean', description: '该条目在回收站里时也照读' },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              const ref = args.id || args.name
              if (!ref) return '需要 id 或 name 来定位条目。'
              if (settings.accessMode === 'readonly') {
                return '导出通行密钥已停用：当前 accessMode 为 readonly。请在插件设置里改为 ask（对话确认）或 auto（直接执行）。'
              }
              return JSON.stringify(
                await getClient().exportPasskey(ref, args.credentialId, exec?.signal, {
                  includeTrashed: Boolean(args.includeTrashed),
                  surface: 'tool',
                }),
                null,
                2,
              )
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_passkey_export',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_passkey_cleanup',
          description:
            '删除由 bitwarden_passkey_export 生成的通行密钥临时文件；省略 path 时清理导出目录内全部 .json。只处理插件自己的 passkeys 目录，不读取私钥，不需要审批。用于登录/验证完成后立即清除落盘私钥。',
          parameters: {
            path: { type: 'string', description: '要删除的导出文件路径（bitwarden_passkey_export 返回的 path）；省略则清理全部导出文件' },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args) {
            try {
              const result = removePasskeyExports(defaultPasskeyExportDir(), args.path ? String(args.path) : null)
              return JSON.stringify({ ok: true, ...result }, null, 2)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_passkey_cleanup',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_passkey_import',
          description:
            '把一份 WebAuthn 凭据加密后保存进某条登录条目（需要 accessMode=ask/auto）。参数是文件路径（通常是 bitwarden_passkey_export 导出的文件，或一份 CDP Credential JSON），私钥必须能从文件里解析为 PKCS#8 的 EC P-256。私钥不会出现在对话里。',
          parameters: {
            id: { type: 'string', description: '条目 id（必须是登录条目）' },
            name: { type: 'string', description: '或条目名称（需唯一匹配）' },
            file: { type: 'string', required: true, description: '通行密钥 JSON 文件的绝对路径（CDP Credential，或本插件导出的 {format,cdp} 包装）' },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              const ref = args.id || args.name
              if (!ref) return '需要 id 或 name 来定位条目。'
              const path = String(args.file ?? '').trim()
              if (!path) return '需要 file（通行密钥 JSON 文件的绝对路径）。'
              let raw
              try {
                const stat = statSync(path)
                if (!stat.isFile() || stat.size > 1024 * 1024) return 'file 必须是一个不超过 1MB 的普通文件。'
                raw = readFileSync(path, 'utf8')
              } catch (error) {
                return '无法读取 file：' + String(error?.message ?? error)
              }
              let credential
              try {
                credential = JSON.parse(raw)
              } catch {
                return 'file 不是合法 JSON。'
              }
              return JSON.stringify(await getMutations().importPasskey(ref, credential, exec?.signal), null, 2)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_passkey_import',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_passkey_remove',
          description: '从登录条目移除一条通行密钥（需要 accessMode=ask/auto）。credentialId 来自 bitwarden_passkey_list；缺省移除第一条。',
          parameters: {
            id: { type: 'string', description: '条目 id（必须是登录条目）' },
            name: { type: 'string', description: '或条目名称（需唯一匹配）' },
            credentialId: { type: 'string', description: '要移除的通行密钥 id（来自 bitwarden_passkey_list）' },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              const ref = args.id || args.name
              if (!ref) return '需要 id 或 name 来定位条目。'
              return JSON.stringify(await getMutations().removePasskey(ref, args.credentialId, exec?.signal), null, 2)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_passkey_remove',
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
                return '插件脱敏未开启（maskMode=off）：bitwarden_get 本来就返回明文，无需 reveal。若想默认脱敏，请到 设置 → 插件 → bitwarden 打开「插件脱敏」。'
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
            '立即扫描本地 DSH 会话日志并擦除 bitwarden 相关事件里已落盘的明文（password/totp/卡号等 → [REDACTED:BW_类别]；占位符保留）。进行中的会话跳过。该操作不需要审批，属于安全清理。通常无需调用：开启「日志擦除」后有定时扫描。',
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
            '密码库状态：配置是否完整、服务器是否可达、是否已解锁、缓存条目数、插件脱敏（maskEnabled/maskMode）与 sweepMode 是否开启，以及回收站与归档条目数（trashed / archived）；refresh=true 会丢弃当前会话并重新登录，不要连续调用。',
          parameters: {
            refresh: { type: 'boolean', description: 'true 时丢弃当前会话并重新登录同步；会触发一次登录，失败后有 60 秒冷却，不要连续调用' },
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
          description: '强制重新同步并解密保险库（通常不必调用：WebSocket/轮询会自动同步；会话失效时会触发重新登录，不要连续调用）。',
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
              guardWriteArgs(args, 'bitwarden_create')
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
              guardWriteArgs(args, 'bitwarden_update')
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
  // Returns `{ kind: 'ask' }` only for the write-back tools and passkey export.
  // It asks when the plugin tier is `ask`, or when the host session itself is
  // in an approval-asking preset (workspace-write / read-only) even if the
  // plugin tier is `auto`: the host mode is the outer boundary the user chose.
  // DSH resolves the ask against the composed ApprovalService: `allowed-once`
  // proceeds, and a deployment with no approval channel denies (safe direction).
  const WRITE_TOOLS = new Set([
    'bitwarden_create',
    'bitwarden_update',
    'bitwarden_delete',
    'bitwarden_restore',
    'bitwarden_passkey_import',
    'bitwarden_passkey_remove',
  ])
  // Exporting a passkey hands out a private key, so it needs the same
  // conversation approval as a write under `ask` — but it is not a write, so
  // it has its own branch below.
  const APPROVAL_TOOLS = new Set([...WRITE_TOOLS, 'bitwarden_passkey_export'])
  // Read paths (bitwarden_find/get/reveal/status/totp), log sweeping and
  // passkey cleanup are deliberately outside this set: entering a password or
  // fetching a TOTP must never ask, and deleting an exported secret is a
  // safety action that must run forcefully rather than wait for approval.
  // An unrecoverable delete is spelled out in the prompt itself: the operator
  // about to approve a write deserves to know that this one has no undo, and
  // the guard above already limits `purge` to this tier for the same reason.
  const isPurge = (exec) => exec?.name === 'bitwarden_delete' && exec?.arguments?.permanent === true
  /** The site a passkey export is for, without exposing the private key path. */
  const passkeySiteForApproval = (exec) => {
    const id = String(exec?.arguments?.id ?? '').trim()
    const named = String(exec?.arguments?.name ?? '').trim()
    try {
      const item = id ? getClient().vault?.byId?.get(id) : null
      const uri = item?.uris?.[0]
      if (uri) {
        try {
          const host = new URL(String(uri)).hostname.replace(/^www\./i, '')
          if (host) return host
        } catch {
          /* a malformed URI: fall back to the entry name below */
        }
      }
      if (item?.name) return item.name
    } catch {
      /* vault not loaded: the caller's name is still useful */
    }
    return named || '密码库条目'
  }
  /** True when the host session's approval policy is `ask` for this agent. */
  const hostApprovalAsks = (exec) => {
    try {
      const approval = typeof ctx.get === 'function' ? ctx.get('approval') : null
      const session = exec?.agent?.session
      if (!approval || !session || typeof approval.effectivePolicy !== 'function') return false
      return approval.effectivePolicy(session) === 'ask'
    } catch {
      return false
    }
  }
  ctx.effect(
    () =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        if (!APPROVAL_TOOLS.has(exec?.name)) return next()
        // A readonly vault refuses in the tool body; no useful approval exists.
        if (settings.accessMode === 'readonly') return next()
        // Host presets with `approval: ask` must prompt even in the auto tier.
        if (settings.accessMode !== 'ask' && !hostApprovalAsks(exec)) return next()
        if (exec?.name === 'bitwarden_passkey_export') {
          const site = passkeySiteForApproval(exec)
          return {
            kind: 'ask',
            reason: `调用密码库通行密钥登录（accessMode=ask，${site}）`,
            displayReason: {
              en: `Allow the vault tool to sign in with the ${site} passkey?`,
              zh: `允许调用密码库工具，使用 ${site} 的通行密钥完成登录吗？`,
            },
          }
        }
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
