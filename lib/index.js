/**
 * @dsh-external/dsh-bitwarden — Bitwarden/Vaultwarden credentials for every DSH session.
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

export const name = '@dsh-external/dsh-bitwarden'
export const inject = ['tools', 'systemPrompt']

const SETTINGS_NS = 'bitwarden'
const DEFAULT_SERVER = 'https://bitwarden.jindom.cc'
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
})

const PROMPT_TEXT = [
  '凭据库（Bitwarden/Vaultwarden）已全局接入：bitwarden_find 检索条目、bitwarden_get 取密码/用户名/TOTP/自定义字段、bitwarden_status 查状态。',
  '任务中任何需要密码、账号、API key、token、数据库口令或登录信息的地方，先自己查凭据库再动手，不要先问用户；用户说"密码在 Bitwarden 里"时同理。',
  '只有当 bitwarden_status 显示未配置、不可达或登录失败时，才请用户在 DSH 设置 → 插件 → bitwarden 中补全 serverUrl/email/主密码。',
  '取到的明文凭据只用于完成任务，不要回显、不要写入文件或日志。',
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
  return {
    serverUrl: normalizeServerUrl(
      value.serverUrl || env(['DSH_BITWARDEN_SERVER', 'BITWARDEN_SERVER']) || DEFAULT_SERVER,
    ),
    email: String(value.email || env(['DSH_BITWARDEN_EMAIL', 'BITWARDEN_EMAIL']) || '').trim(),
    masterPassword: String(value.masterPassword || env(['DSH_BITWARDEN_MASTER_PASSWORD', 'BITWARDEN_PASSWORD']) || ''),
    apiKeyClientId: String(value.apiKeyClientId || env(['DSH_BITWARDEN_CLIENT_ID', 'BITWARDEN_CLIENT_ID']) || '').trim(),
    apiKeyClientSecret: String(
      value.apiKeyClientSecret || env(['DSH_BITWARDEN_CLIENT_SECRET', 'BITWARDEN_CLIENT_SECRET']) || '',
    ),
    cacheMinutes: Number.isFinite(cacheRaw) && cacheRaw >= 0 ? cacheRaw : 30,
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

  const getClient = () => {
    if (!client) client = new VaultClient(settings)
    return client
  }
  const reconfigure = (next) => {
    settings = resolveSettings(next)
    if (client) client.reconfigure(settings)
    else client = new VaultClient(settings)
  }

  // ── configuration ──────────────────────────────────────────────────────────
  // The settings provider owns the user-editable section; its resolved value
  // layers schema defaults → composition base → settings.yaml/UI overrides.
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NS, Config, { base: config })
    reconfigure(scope.get())
    scope.watch((next) => reconfigure(next))
  })

  // ── proactive guidance in every session ────────────────────────────────────
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PROMPT_SECTION,
        order: PROMPT_ORDER,
        text: PROMPT_TEXT,
      }),
    '@dsh-external/dsh-bitwarden: vault guidance section',
  )

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
    '@dsh-external/dsh-bitwarden: bitwarden_find',
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
          },
          output: { schema: { type: 'string' }, render: asText },
          async execute(args, exec) {
            try {
              const ref = args.id || args.name
              return await getClient().get(ref, args.field ?? 'all', exec?.signal)
            } catch (error) {
              return failure(error)
            }
          },
        }),
      ),
    '@dsh-external/dsh-bitwarden: bitwarden_get',
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
    '@dsh-external/dsh-bitwarden: bitwarden_status',
  )
}

export default { name, inject, Config, apply }
