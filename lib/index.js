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
import { API_PREFIX, createApiHandler } from './api.js'

export const name = 'dsh-vaultwarden'
export const inject = ['tools', 'systemPrompt']

const SETTINGS_NS = 'bitwarden'
// No default server: a fork must not point at somebody else's instance. An
// empty value keeps the plugin inert until the user fills it in.
const DEFAULT_SERVER = ''
const PROMPT_SECTION = 'bitwarden-vault'
const PROMPT_ORDER = 2950 // after the first-party tool sections, before the SDK section

/** User-editable settings (rendered by the DSH plugin-settings UI). */
export const Config = z.object({
  serverUrl: z.string().default(DEFAULT_SERVER).description('Vaultwarden/Bitwarden 服务器地址'),
  email: z.string().default('').description('登录邮箱（KDF 盐值，必须与账号一致）'),
  masterPassword: z.string().role('secret').default('').description('主密码（仅存本机 settings.yaml，用于解密保险库）'),
  apiKeyClientId: z.string().default('').description('可选：API 密钥 client_id（user.<uuid>），填了就走 API 密钥登录（可绕过两步验证）'),
  apiKeyClientSecret: z.string().role('secret').default('').description('可选：API 密钥 client_secret'),
  cacheMinutes: z.natural().default(30).description('解锁后的保险库内存缓存时长（分钟）'),
  websocket: z.boolean().default(true).description('启用 WebSocket 实时通知（/notifications/hub）；关闭则始终轮询同步'),
  pollIntervalSeconds: z.natural().default(60).description('WebSocket 不可用时的轮询同步间隔（秒，最小 5）'),
  deviceIdentifier: z.string().default('').description('可选：设备标识。官方客户端会持久化一个稳定值；留空按「服务器+邮箱」确定性派生，不写盘'),
  accessMode: z.enum(['readonly', 'auto']).default('readonly').description('写权限：readonly=只读（拒绝创建/修改/删除），auto=允许写回 Vaultwarden'),
})

const PROMPT_TEXT = [
  '凭据库（Bitwarden/Vaultwarden）已全局接入：bitwarden_find 检索条目、bitwarden_get 取密码/用户名/TOTP/自定义字段、bitwarden_status 查状态、bitwarden_sync 强制同步。',
  '密码库通过 WebSocket 实时同步：别处增删改后本地自动更新（WebSocket 不通时自动降级为轮询），bitwarden_status 可看同步模式与最近同步时间。',
  '任务中任何需要密码、账号、API key、token、数据库口令或登录信息的地方，先自己查凭据库再动手，不要先问用户；用户说"密码在 Bitwarden 里"时同理。',
  '只有当 bitwarden_status 显示未配置、不可达或登录失败时，才请用户在 DSH 设置 → 插件 → bitwarden 中补全 serverUrl/email/主密码。',
  '取到的明文凭据只用于完成任务，不要回显、不要写入文件或日志。',
  '遇到 repromptRequired 的条目（Bitwarden 里对该条目开了「重新验证」）时不要反复试探，转告用户到官方客户端查看。',
  '写入（bitwarden_create/update/delete）默认关闭；只有当设置里 accessMode 为 auto 时才可写回，且只能操作个人条目（组织条目会明确报错）。',
].join('')

const env = (names) => {
  for (const key of names) {
    const value = process.env[key]
    if (value) return value
  }
  return undefined
}

/** Merge composition entry config, environment fallbacks, and defaults. */
function resolveSettings(source = {}) {
  const value = source ?? {}
  const cacheRaw = Number(value.cacheMinutes)
  const pollRaw = Number(value.pollIntervalSeconds)
  return {
    // Kept raw (trimmed) here; `VaultClient.server` normalizes on first use,
    // so an unconfigured value never throws during activation.
    serverUrl: String(value.serverUrl || env(['DSH_BITWARDEN_SERVER', 'BITWARDEN_SERVER']) || DEFAULT_SERVER).trim(),
    email: String(value.email || env(['DSH_BITWARDEN_EMAIL', 'BITWARDEN_EMAIL']) || '').trim(),
    masterPassword: String(value.masterPassword || env(['DSH_BITWARDEN_MASTER_PASSWORD', 'BITWARDEN_PASSWORD']) || ''),
    apiKeyClientId: String(value.apiKeyClientId || env(['DSH_BITWARDEN_CLIENT_ID', 'BITWARDEN_CLIENT_ID']) || '').trim(),
    apiKeyClientSecret: String(
      value.apiKeyClientSecret || env(['DSH_BITWARDEN_CLIENT_SECRET', 'BITWARDEN_CLIENT_SECRET']) || '',
    ),
    cacheMinutes: Number.isFinite(cacheRaw) && cacheRaw >= 0 ? cacheRaw : 30,
    websocket: value.websocket === undefined || value.websocket === null ? true : Boolean(value.websocket),
    pollIntervalSeconds: Number.isFinite(pollRaw) && pollRaw >= 5 ? pollRaw : 60,
    deviceIdentifier: String(value.deviceIdentifier || env(['DSH_BITWARDEN_DEVICE_ID', 'BITWARDEN_DEVICE_ID']) || '').trim(),
    accessMode: ['readonly', 'auto'].includes(value.accessMode) ? value.accessMode : 'readonly',
  }
}

const asText = (_args, value) => [{ type: 'text', text: String(value) }]

/** Turn any thrown value into an actionable message for the model. */
function failure(error) {
  if (error instanceof VaultError) {
    return error.hint ? `${error.message}\n提示：${error.hint}` : error.message
  }
  return `凭据库操作失败：${error?.message ?? error}`
}

export function apply(ctx, config = {}) {
  let settings = resolveSettings(config)
  /** @type {VaultClient | null} */
  let client = null
  /** Live sync runs for the plugin's lifetime; restarted when settings change. */
  let liveRunning = false

  const getClient = () => {
    if (!client) client = new VaultClient(settings)
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
    if (client) client.reconfigure(settings)
    else client = new VaultClient(settings)
    startLiveSync() // the server URL may have changed: rebuild the channel
  }

  // ── configuration ──────────────────────────────────────────────────────────
  // The settings provider owns the user-editable section; its resolved value
  // layers schema defaults → composition base → settings.yaml/UI overrides.
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NS, Config, { base: config })
    reconfigure(scope.get())
    scope.watch((next) => reconfigure(next))
  })

  /** @type {VaultMutations | null} */
  let mutations = null
  const getMutations = () => {
    if (!mutations) mutations = new VaultMutations(getClient())
    return mutations
  }
  /** Write-back is opt-in: readonly (the default) refuses every mutation. */
  const writeRefusal = () =>
    '写回已停用：当前 accessMode 为 readonly。确认要写入 Vaultwarden，请在 DSH 设置 → 插件 → bitwarden 把 accessMode 改为 auto（仅支持个人条目）。'
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

  // ── proactive guidance in every session ────────────────────────────────────
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PROMPT_SECTION,
        order: PROMPT_ORDER,
        text: PROMPT_TEXT,
      }),
    'dsh-vaultwarden: vault guidance section',
  )

  // ── live sync (WebSocket notifications, polling fallback) ───────────────────
  ctx.effect(() => {
    liveRunning = true
    startLiveSync()
    return () => {
      liveRunning = false
      client?.stopLiveSync()
    }
  }, 'dsh-vaultwarden: live sync')

  // ── same-origin HTTP API for the browser half ──────────────────────────────
  // `inject` keeps the plugin inert where no web server exists (headless);
  // the handler itself enforces the loopback-only request policy.
  ctx.inject(['webServer'], (wctx) => {
    const dispose = wctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: createApiHandler(getClient),
    })
    wctx.effect(() => dispose, 'dsh-vaultwarden: http api route')
  })

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
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              return await getClient().find(args.query, args.limit ?? 8, exec?.signal)
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
          description: '取出某条凭据的密码、用户名、当前 TOTP 码或自定义字段（id 或名称定位）。',
          parameters: {
            id: { type: 'string', description: '条目 id（来自 bitwarden_find）' },
            name: { type: 'string', description: '或条目名称（需唯一匹配）' },
            field: {
              type: 'string',
              enum: ['all', 'password', 'username', 'totp', 'notes', 'fields'],
              description: '取哪个字段，默认 all',
            },
            confirm: {
              type: 'boolean',
              description: '条目在 Bitwarden 中开启了「重新验证」(reprompt) 时，确认仍要读取明文',
            },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              const ref = args.id || args.name
              return await getClient().get(ref, args.field ?? 'all', exec?.signal, { confirm: Boolean(args.confirm) })
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_get',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_status',
          description: '凭据库状态：配置是否完整、服务器是否可达、是否已解锁、缓存条目数。',
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

  // ── write-back (accessMode=auto only, personal items only) ──────────────────
  const WRITE_FIELDS = {
    username: { type: 'string', description: '用户名' },
    password: { type: 'string', description: '密码' },
    totp: { type: 'string', description: 'TOTP：otpauth:// URI 或 Base32 密钥' },
    uris: { type: 'string', description: '网址，多个用逗号分隔' },
    notes: { type: 'string', description: '备注' },
    fields: { type: 'string', description: '自定义字段 JSON 数组，如 [{"name":"环境","value":"prod"}]' },
    folderId: { type: 'string', description: '文件夹 id' },
    favorite: { type: 'boolean', description: '收藏' },
    reprompt: { type: 'boolean', description: '开启 Bitwarden「重新验证」（读取时需确认）' },
  }

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bitwarden_create',
          description: '在 Vaultwarden 创建一条登录条目（需要 accessMode=auto；仅个人条目）。',
          parameters: { name: { type: 'string', required: true, description: '条目名称' }, ...WRITE_FIELDS },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            if (!writesEnabled()) return writeRefusal()
            try {
              const created = await getMutations().create(
                {
                  name: args.name,
                  username: args.username,
                  password: args.password,
                  totp: args.totp,
                  uris: parseUris(args.uris),
                  notes: args.notes,
                  fields: parseFields(args.fields),
                  folderId: args.folderId,
                  favorite: args.favorite,
                  reprompt: args.reprompt ? 1 : 0,
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
          description: '修改一条登录条目（需要 accessMode=auto；仅个人条目；未传的字段保持原值）。',
          parameters: { id: { type: 'string', required: true, description: '条目 id（来自 bitwarden_find）' }, name: { type: 'string', description: '条目名称' }, ...WRITE_FIELDS },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            if (!writesEnabled()) return writeRefusal()
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
          description: '删除一条条目（需要 accessMode=auto；仅个人条目）。默认软删除进回收站，permanent 彻底删除。',
          parameters: {
            id: { type: 'string', required: true, description: '条目 id（来自 bitwarden_find）' },
            permanent: { type: 'boolean', description: 'true = 彻底删除（不进回收站）' },
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            if (!writesEnabled()) return writeRefusal()
            try {
              const removed = await getMutations().remove(args.id, { permanent: Boolean(args.permanent) }, exec?.signal)
              return JSON.stringify(removed, null, 2)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    'dsh-vaultwarden: bitwarden_delete',
  )
}

export default { name, inject, Config, apply }
