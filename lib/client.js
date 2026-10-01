/**
 * Browser half of dsh-vaultwarden.
 *
 * One surface: the entry browser (设置 → 凭据库), registered into the host's
 * `settings.section` slot. It reads the vault through the `/api` connection
 * RPC channel — `connection.rpc.call('/api', 'vw/<method>', { args })` — which
 * carries the operator's authenticated session; the plugin serves no HTTP
 * route of its own.
 *
 * The configuration form is not drawn here: the host derives it from the
 * plugin's `Config` schema (serverUrl / email / master password / API key /
 * sync options / accessMode), so this half only builds the vault browser.
 *
 * The bundle is a hand-written CJS module in the client module-loader format:
 * `require('react')` comes from the platform seed table, everything else is
 * plain DOM, so no bundler or build step is involved. Styling uses only
 * `--dsw-alias-*` theme tokens (with literal fallbacks), so light and dark
 * both follow the host; text is never dimmed with opacity, and the `state-*`
 * tokens are used for dots and borders rather than body text.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vaultwarden',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const h = react.createElement
    const { useCallback, useEffect, useLayoutEffect, useRef, useState } = react

    /**
     * Cache that outlives the component.
     *
     * The host unmounts the panel whenever the settings dialog closes, so
     * reopening it used to re-run the whole chain — config, session, list and a
     * status probe that costs a network round trip. Holding the last successful
     * result here lets a reopen paint immediately and refresh in the background.
     * It lives at module scope because component state dies with the unmount.
     */
    const openCache = {
      /** @type {{key: string, list: object, report: object, at: number} | null} */
      vault: null,
      /** @type {{config: object, at: number} | null} */
      config: null,
    }
    /** Identity a cached vault belongs to; anything else must not reuse it. */
    const cacheKey = (config) => `${config?.serverUrl ?? ''}\u0000${config?.email ?? ''}`

    /**
     * Did a call fail because the host simply does not have that remote
     * method? That is the one failure a fallback can act on: every other
     * failure means the host answered and rejected the request, so the panel
     * must show that instead of pretending the call never happened.
     */
    const missingMethod = (failure) => {
      const code = String(failure?.code ?? '')
      const message = String(failure?.message ?? '')
      // The gateway's own words for "this host has no such method" (a host
      // older than this bundle). It names them `gateway/*-unavailable` and
      // never says "unknown", so prose alone would miss all three.
      if (/^gateway\/(invocation|method|definition)-unavailable$/.test(code)) return true
      // Anything else that reports it in prose: a different transport, or a
      // test double.
      return /unknown|unregistered|not found|no such|method.*missing|missing.*method|not defined|is not a function/i.test(`${code} ${message}`)
    }

    /** Test hook: drop everything remembered across mounts. */
    const resetOpenCache = () => {
      openCache.vault = null
      openCache.config = null
      forgetSnapshot()
    }
    /** How long a reopen may paint from cache before refreshing anyway. */
    const REOPEN_CACHE_MS = 5 * 60_000
    /** First page size: small enough to paint a large vault quickly. */
    const PAGE_SIZE = 50
    /** The full-read fallback, matching the old single read's ceiling. */
    const FULL_LIMIT = 200
    /** Distance from the bottom that triggers loading the next page. */
    const SCROLL_TRIGGER_PX = 240
    /**
     * Where the next page starts, according to the host. A page reports the
     * window it actually served (`offset` plus the rows it returned), which is
     * not always the window that was asked for: an overlapping page would
     * otherwise make the overlap permanent and skip rows behind it. Hosts that
     * predate paging omit both fields, so the fallback stands for them.
     */
    /**
 * Set once a host has refused a page read (`gateway/arguments-invalid`): a host
 * that predates paging rejects the extra `offset` field outright, and it will
 * do so for every read, so later opens go straight for the whole vault instead
 * of paying for a page that cannot be served. Session-scoped: a host restart
 * brings a new bundle.
 */
let pagingRefused = false

const nextOffsetOf = (payload, fallback) => {
      const start = Number(payload?.offset)
      const count = Array.isArray(payload?.items) ? payload.items.length : 0
      return Number.isFinite(start) ? start + count : fallback
    }
    /** Where the last successful read survives a page reload. */
    const SNAPSHOT_KEY = 'dsh-vaultwarden:snapshot'

    /**
     * A reload costs the module scope (the bundle is re-evaluated), and that is
     * the common case here: the settings dialog shells out to a host that
     * remounts the app when it closes. So the last read is also kept in
     * localStorage, and the next open paints it before any round trip.
     *
     * What is stored is what the host's `summary()` already returns for the
     * list — name, type, username, URIs, folder, favourite/totp/notes flags —
     * and never a password or a TOTP secret, so the snapshot exposes nothing
     * the panel does not already show. It is dropped the moment the host says
     * the session is gone.
     */
    const readSnapshot = () => {
      try {
        const raw = globalThis.localStorage?.getItem(SNAPSHOT_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed?.list || !parsed?.report) return null
        if (!Number.isFinite(parsed.at) || Date.now() - parsed.at > REOPEN_CACHE_MS) return null
        return parsed
      } catch {
        return null // no storage (private mode): the module cache still works
      }
    }

    const writeSnapshot = (snapshot) => {
      try {
        globalThis.localStorage?.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
      } catch {
        // Storage blocked or full: painting simply falls back to the network.
      }
    }

    /** Drop the cached read: a signed-out panel must show nothing. */
    const forgetSnapshot = () => {
      openCache.vault = null
      try {
        globalThis.localStorage?.removeItem(SNAPSHOT_KEY)
      } catch {
        // Nothing to remove, or storage is unreachable: either way it is gone.
      }
    }

    /**
     * Which read to paint right now, newest first: the module cache (same
     * page) then localStorage (after a reload). The caller compares the
     * snapshot's key with the live config, because only the host knows which
     * account is signed in — a snapshot from a different account is dropped
     * rather than shown.
     */
    const freshSnapshot = () => {
      if (openCache.vault && Date.now() - openCache.vault.at < REOPEN_CACHE_MS) return openCache.vault
      return readSnapshot()
    }

    const NS = 'bitwarden'
    const SECTION_ID = 'vaultwarden'
    const SECTION_ORDER = 30

    // ── dictionaries (zh first; en mirrors the same keys) ─────────────────────
    const DICT_ZH = {
      panelTitle: 'Bitwarden 凭据库',
      // Sits next to the title in small type: the panel is built on the
      // Bitwarden protocol, and a Vaultwarden server speaks the same one.
      panelTitleNote: '（支持 Bitwarden / Vaultwarden）',
      panelNav: '凭据库',
      search: '搜索条目',
      // Short on purpose: the long version was truncated mid-word on a phone.
      searchPlaceholder: '搜索名称、用户名或网址',
      // The keyboard shortcuts moved out of the placeholder into the tooltip.
      searchHint: '按 / 聚焦搜索框，Esc 清空，↑↓ 移动选中',
      refresh: '刷新',
      listEmpty: '没有匹配的条目',
      listHint: '换个关键词，或确认条目存在于该账户',
      notConfigured: '尚未配置完成',
      notConfiguredHint: '请先在 设置 → 插件 → bitwarden 里补全 serverUrl、邮箱与主密码。',
      loadFailed: '读取失败',
      retry: '重试',
      selectPrompt: '从左侧选择一条凭据',
      username: '用户名',
      password: '密码',
      totp: '动态码',
      notes: '备注',
      customFields: '自定义字段',
      folder: '目录',
      collections: '收藏集',
      uris: '网址',
      copy: '复制',
      copied: '已复制',
      show: '显示',
      hide: '隐藏',
      repromptLocked: '该条目在 Bitwarden 中开启了「重新验证」',
      repromptHint: '自动返回明文不符合官方客户端约定；确认仍要读取请点下方按钮。',
      confirmRead: '确认读取',
      favorite: '收藏',
      itemsCount: '共 {n} 条',
      matchedCount: '匹配 {n} 条',
      syncTitle: '同步状态',
      syncWebsocket: '实时同步',
      untitled: '（未命名）',
      noMeta: '无用户名/网址',
      backToList: '返回列表',
      loadMore: '还有 {n} 条，点击继续显示',
      moreBlocked: '本机只同步到 {shown}/{total} 条，其余 {n} 条请在 Bitwarden 网页端查看',
      loadingMore: '正在加载…',
      hasTotp: '该条目包含两步验证码',
      syncNow: '同步中…',
      syncTipClick: '点击立即同步一次',
      syncTipMode: '同步方式：{mode}',
      syncTipConnected: 'WebSocket 已连接：{state}',
      syncTipInterval: '轮询间隔：{seconds} 秒',
      syncTipLastSync: '上次同步：{time}',
      syncTipLastSignal: '上次收到变更信号：{time}',
      syncTipError: '上次错误：{error}',
      syncTipSession: '登录已保存：闲置 {days} 天内免密登录',
      syncTipYes: '是',
      syncTipNo: '否',
      syncPolling: '轮询同步',
      syncOff: '未同步',
      syncLoading: '正在读取…',
      syncError: '同步状态不可用',
      // setup form
      setupTitle: '连接 Vaultwarden',
      setupHint: '填入服务器地址、登录邮箱与主密码即可开始同步；保存后立即生效。',
      setupMethod: '登录方式',
      setupMethodPassword: '主密码（推荐，两步验证账号需动态码）',
      setupMethodApiKey: 'API 密钥（可绕过两步验证）',
      setupMethodPasswordHint: '用邮箱 + 主密码登录；账户若启用两步验证，登录时会要求动态码。',
      setupApiKeyHint: 'API 密钥登录不需要动态码；主密码仍需填写，用于解密保险库。密钥在 Vaultwarden 网页端「设置 → 安全 → 密钥」获取。',
      setupApiKeyId: 'API 密钥 client_id',
      setupApiKeySecret: 'API 密钥 client_secret',
      setupApiKeySecretPlaceholder: '粘贴 client_secret',
      setupApiKeyKeep: '留空表示不修改已保存的密钥',
      setupApiKeySecretHint: '权限等同账号且绕过两步验证，请勿泄露；只保存在本机，界面不回显。',
      setupMasterHint: '仅存本机，用于解密保险库；API 密钥模式下同样必填。',
      setupServer: '服务器地址',
      setupServerPlaceholder: 'https://vault.example.com 或 http://192.168.1.10',
      setupEmail: '登录邮箱',
      setupMaster: '主密码',
      setupMasterPlaceholder: '已保存则留空表示不修改',
      setupSave: '保存并连接',
      setupSaving: '正在连接…',
      setupSaved: '已保存，正在同步…',
      setupFailed: '保存失败',
      setupConfigFailed: '未能读取已保存的配置，请手动填写',
      twoFactorTitle: '需要两步验证码',
      twoFactorHint: '该账户启用了两步验证。请打开你的验证器（或邮箱/恢复码），填入验证码继续登录。',
      twoFactorCode: '验证码',
      twoFactorPlaceholder: '6 位动态码或恢复码',
      twoFactorSubmit: '提交验证码',
      twoFactorSubmitting: '正在验证…',
      signInTitle: '登录 Vaultwarden',
      signInHint: '先用账号与主密码验证身份；该账户若启用两步验证，验证通过后再输入动态码。',
      signInSubmit: '验证并登录',
      signInConnecting: '正在验证…',
      twoFactorRestart: '返回设置，重新填写',
      backToSetup: '返回设置，重新填写',
      openSetup: '设置',
      setupCancel: '返回凭据列表',
      twoFactorRemember: '记住此设备',
      twoFactorRememberYes: '是（本机信任一段时间）',
      twoFactorRememberOnce: '否，每次都验证',
      restartHint: '验证码过期或账号填错时，点此清除会话重新登录。',
      twoFactorProviders: '可用方式：{n}',
      retryLater: '稍后再试',
      timeJustNow: '刚刚',
      timeMinutes: '{n} 分钟前',
      timeHours: '{n} 小时前',
      timeDays: '{n} 天前',
    }
    const DICT_EN = {
      panelTitle: 'Bitwarden credentials',
      panelTitleNote: '(Vaultwarden supported)',
      panelNav: 'Credentials',
      search: 'Search entries',
      searchPlaceholder: 'Name, username or URL',
      searchHint: 'Press / to focus, Esc to clear, ↑↓ to move the selection',
      refresh: 'Refresh',
      listEmpty: 'No matching entries',
      listHint: 'Try another keyword, or confirm the entry exists in this account',
      notConfigured: 'Not configured yet',
      notConfiguredHint: 'Fill in serverUrl, email and the master password under Settings → Plugins → bitwarden first.',
      loadFailed: 'Load failed',
      retry: 'Retry',
      selectPrompt: 'Select a credential from the list',
      username: 'Username',
      password: 'Password',
      totp: 'TOTP',
      notes: 'Notes',
      customFields: 'Custom fields',
      folder: 'Folder',
      collections: 'Collections',
      uris: 'URLs',
      copy: 'Copy',
      copied: 'Copied',
      show: 'Show',
      hide: 'Hide',
      repromptLocked: 'This entry has Bitwarden’s re-prompt enabled',
      repromptHint: 'Auto-revealing plaintext would break the official client convention; confirm below to read it anyway.',
      confirmRead: 'Confirm read',
      favorite: 'Favorite',
      itemsCount: '{n} entries',
      matchedCount: '{n} matched',
      syncTitle: 'Sync status',
      syncWebsocket: 'Live sync',
      untitled: '(untitled)',
      noMeta: 'No username or URL',
      backToList: 'Back to list',
      loadMore: 'Show {n} more',
      moreBlocked: 'Only {shown} of {total} entries synced · the other {n} are only in the Bitwarden web vault',
      loadingMore: 'Loading more…',
      hasTotp: 'This entry has a two-factor code',
      syncNow: 'Syncing…',
      syncTipClick: 'Click to sync now',
      syncTipMode: 'Sync mode: {mode}',
      syncTipConnected: 'WebSocket connected: {state}',
      syncTipInterval: 'Poll interval: {seconds}s',
      syncTipLastSync: 'Last sync: {time}',
      syncTipLastSignal: 'Last change signal: {time}',
      syncTipError: 'Last error: {error}',
      syncTipSession: 'Session saved: no password needed for {days} idle days',
      syncTipYes: 'yes',
      syncTipNo: 'no',
      syncPolling: 'Polling',
      syncOff: 'Not syncing',
      syncLoading: 'Loading…',
      syncError: 'Sync status unavailable',
      setupTitle: 'Connect to Vaultwarden',
      setupHint: 'Enter the server URL, login email and master password to start syncing; saving applies immediately.',
      setupMethod: 'Sign-in method',
      setupMethodPassword: 'Master password (two-factor accounts need a code)',
      setupMethodApiKey: 'API key (skips two-factor)',
      setupMethodPasswordHint: 'Sign in with email + master password; a two-factor account is asked for a code.',
      setupApiKeyHint: 'An API key needs no code; the master password is still required to decrypt the vault. Find the key in Vaultwarden under Settings → Security → Keys.',
      setupApiKeyId: 'API key client_id',
      setupApiKeySecret: 'API key client_secret',
      setupApiKeySecretPlaceholder: 'Paste the client_secret',
      setupApiKeyKeep: 'Leave empty to keep the stored key',
      setupApiKeySecretHint: 'Equivalent to your account and skips two-factor — keep it secret; stored locally only, never shown again.',
      setupMasterHint: 'Stored locally to decrypt the vault; required in API-key mode too.',
      setupServer: 'Server URL',
      setupServerPlaceholder: 'https://vault.example.com or http://192.168.1.10',
      setupEmail: 'Login email',
      setupMaster: 'Master password',
      setupMasterPlaceholder: 'Leave empty to keep the saved value',
      setupSave: 'Save and connect',
      setupSaving: 'Connecting…',
      setupSaved: 'Saved, syncing…',
      setupFailed: 'Save failed',
      setupConfigFailed: 'Could not read the saved configuration — fill it in manually',
      twoFactorTitle: 'Two-factor code required',
      twoFactorHint: 'This account uses two-factor authentication. Enter the code from your authenticator (or a recovery code) to finish signing in.',
      twoFactorCode: 'Code',
      twoFactorPlaceholder: '6-digit code or recovery code',
      twoFactorSubmit: 'Submit code',
      twoFactorSubmitting: 'Verifying…',
      signInTitle: 'Sign in to Vaultwarden',
      signInHint: 'Credentials are verified first; when the account uses two-step login you are asked for the code afterwards.',
      signInSubmit: 'Verify and sign in',
      signInConnecting: 'Verifying…',
      twoFactorRestart: 'Back to settings',
      backToSetup: 'Back to settings',
      openSetup: 'Settings',
      setupCancel: 'Back to the list',
      twoFactorRemember: 'Remember this device',
      twoFactorRememberYes: 'Yes (trust this machine for a while)',
      twoFactorRememberOnce: 'No, ask every time',
      restartHint: 'When a code expired or the account is wrong, clear the session here and sign in again.',
      twoFactorProviders: 'Available methods: {n}',
      retryLater: 'Retry later',
      timeJustNow: 'just now',
      timeMinutes: '{n} min ago',
      timeHours: '{n} h ago',
      timeDays: '{n} d ago',
    }

    // ── theme tokens (the only color source; fallbacks keep the page readable
    //    outside the harness). `--vw-*` are plugin-local semantic aliases over
    //    the host theme, in the shape dsh-vault uses. ──────────────────────────
    const TOKEN = {
      text: 'var(--vw-text, var(--dsw-alias-label-primary, #1f2328))',
      text2: 'var(--vw-text-2, var(--dsw-alias-label-secondary, #57606a))',
      border: 'var(--vw-border, var(--dsw-alias-border-l1, #d9d9d9))',
      borderStrong: 'var(--vw-border-strong, var(--dsw-alias-border-l2, #afb1b3))',
      bg: 'var(--vw-bg, var(--dsw-alias-bg-layer-1, #ffffff))',
      bg2: 'var(--vw-bg-2, var(--dsw-alias-bg-layer-2, #f5f5f5))',
      // `brand-primary` is the host's ink colour (near-black on light, near-white
      // on dark) and is NOT a blue accent; a primary button must pair the
      // host's button fill with its matching foreground token or the label
      // disappears (white-on-white in dark theme).
      accent: 'var(--vw-accent, var(--dsw-alias-button-primary-fill, #1f2328))',
      onAccent: 'var(--vw-on-accent, var(--dsw-alias-label-primary-foreground, #ffffff))',
      switchKnob: 'var(--vw-switch-knob, var(--dsw-alias-switch-thumb, #ffffff))',
      ok: 'var(--vw-ok, var(--dsw-alias-state-success-primary, #2f9e44))',
      warn: 'var(--vw-warn, var(--dsw-alias-state-warn-primary, #b8830f))',
      err: 'var(--vw-err, var(--dsw-alias-state-error-primary, #c0392b))',
      idle: 'var(--vw-idle, var(--dsw-alias-state-idle-primary, #8b949e))',
    }

    // ── shared style fragments ────────────────────────────────────────────────
    // The scale follows the host's own design tokens: radii come from the
    // `--dsw-radius-*` family (xs 4 / sm 8 / md 12 / lg 16 / panel 28) rather
    // than ad-hoc pixel values, so cards match the surrounding settings UI.
    const RADIUS = {
      xs: 'var(--dsw-radius-xs, 4px)',
      sm: 'var(--dsw-radius-sm, 8px)',
      md: 'var(--dsw-radius-md, 12px)',
      lg: 'var(--dsw-radius-lg, 16px)',
      pill: '999px',
    }
    /** Row height shared by inputs and buttons, matching the host's medium control. */
    const CONTROL_HEIGHT = 32

    const S = {
      panel: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0 12px', color: TOKEN.text, minHeight: 0 },
      // The host dialog grows to fit its content, so rendering hundreds of
      // entries unbounded stretched it past the viewport and clipped the tail.
      // The list/detail region gets its own height budget and scrolls, which
      // keeps the title and toolbar visible while the content moves.
      scrollArea: {
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        maxHeight: 'min(58vh, 560px)',
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
        paddingRight: 4,
        marginRight: -4,
      },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      /** Title + the small compatibility note; wraps together on a phone. */
      titleRow: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      titleText: { fontSize: 16, fontWeight: 600, letterSpacing: 0.1 },
      titleNote: { fontSize: 12, color: TOKEN.text2 },
      /** Keeps 设置/刷新 together and right-aligned when the row wraps. */
      toolbarActions: { display: 'flex', gap: 8, marginLeft: 'auto', flexShrink: 0 },
      // Single column on purpose: the list and the detail are separate levels,
      // never side by side. A two-column grid floors its `1fr` track at
      // min-content, so one long URL used to push the detail card out of the
      // dialog. One column also gives the detail the full width it needs.
      panelBody: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },

      // The list and the detail pane are cards in the host's sense: one hairline
      // border, a soft surface, and a generous radius.
      card: { border: `1px solid ${TOKEN.border}`, borderRadius: RADIUS.lg, background: TOKEN.bg, overflow: 'hidden' },
      list: { border: `1px solid ${TOKEN.border}`, borderRadius: RADIUS.lg, background: TOKEN.bg, overflow: 'hidden' },
      listRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '12px 14px',
        border: 0,
        background: 'transparent',
        color: TOKEN.text,
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 13.5,
        minWidth: 0,
      },
      listRowActive: { background: TOKEN.bg2 },
      listName: { fontSize: 13.5, color: TOKEN.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      listMeta: { fontSize: 12, color: TOKEN.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

      avatar: {
        width: 30,
        height: 30,
        borderRadius: RADIUS.sm,
        background: TOKEN.bg2,
        border: `1px solid ${TOKEN.border}`,
        color: TOKEN.text2,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12.5,
        fontWeight: 600,
        flexShrink: 0,
      },

      detail: {
        border: `1px solid ${TOKEN.border}`,
        borderRadius: RADIUS.lg,
        background: TOKEN.bg,
        padding: '20px 20px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        minHeight: 200,
        minWidth: 0,
      },
      /** Section heading inside a card: quiet, not shouty. */
      cardTitle: { fontSize: 15, fontWeight: 600, letterSpacing: 0.1 },
      cardSubtitle: { fontSize: 12.5, color: TOKEN.text2, lineHeight: 1.6 },
      /** A label + control pair, the shape every form field takes. */
      formRow: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5 },

      // `minmax(0, 1fr)` is essential: a bare `1fr` floors at min-content, so a
      // long URL would widen the whole card and overflow the host dialog.
      fieldRow: { display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr) auto', gap: 12, alignItems: 'center', fontSize: 13 },
      fieldLabel: { fontSize: 12, color: TOKEN.text2 },
      fieldValue: { fontSize: 13.5, color: TOKEN.text, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5 },
      progressTrack: { height: 4, borderRadius: RADIUS.pill, background: TOKEN.bg2, overflow: 'hidden', width: 120 },
      progressFill: { height: '100%', background: TOKEN.accent },
      empty: { padding: '32px 16px', textAlign: 'center', color: TOKEN.text2, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' },
      note: { fontSize: 12.5, color: TOKEN.text2, lineHeight: 1.6 },
      hint: { fontSize: 11.5, color: TOKEN.text2, lineHeight: 1.5 },

      button: {
        height: CONTROL_HEIGHT,
        padding: '0 14px',
        borderRadius: RADIUS.md,
        border: `1px solid ${TOKEN.borderStrong}`,
        background: 'transparent',
        color: TOKEN.text,
        cursor: 'pointer',
        fontSize: 13,
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        height: CONTROL_HEIGHT,
        padding: '0 18px',
        borderRadius: RADIUS.md,
        border: '1px solid transparent',
        background: TOKEN.accent,
        color: TOKEN.onAccent,
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      },

      ok: { fontSize: 12.5, color: TOKEN.ok },
      error: { fontSize: 12.5, color: TOKEN.err, lineHeight: 1.5 },
      dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: TOKEN.text, border: `1px solid ${TOKEN.border}`, borderRadius: RADIUS.pill, padding: '4px 11px' },
      badge: { fontSize: 11, color: TOKEN.text2, border: `1px solid ${TOKEN.border}`, borderRadius: RADIUS.pill, padding: '2px 9px' },

      input: {
        boxSizing: 'border-box',
        height: CONTROL_HEIGHT,
        padding: '0 11px',
        borderRadius: RADIUS.md,
        border: `1px solid ${TOKEN.borderStrong}`,
        background: TOKEN.bg,
        color: TOKEN.text,
        fontSize: 13,
        outline: 'none',
        width: '100%',
      },
      select: {
        boxSizing: 'border-box',
        height: CONTROL_HEIGHT,
        padding: '0 8px',
        borderRadius: RADIUS.md,
        border: `1px solid ${TOKEN.borderStrong}`,
        background: TOKEN.bg,
        color: TOKEN.text,
        fontSize: 13,
        outline: 'none',
        width: '100%',
      },
    }

    /**
     * Pseudo-class styling (hover, focus, active row) cannot be expressed with
     * inline styles, so the panel installs one scoped stylesheet. Every rule is
     * namespaced under `.vw-root` to stay clear of host styles, and colors come
     * from the same tokens the inline styles use.
     */
    const STYLE_ID = 'dsh-vaultwarden-panel-style'
    const ensureStyles = () => {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.vw-root button { transition: background-color .12s ease, border-color .12s ease, opacity .12s ease }
.vw-root button:disabled { opacity: .45; cursor: not-allowed }
.vw-root button:not(:disabled):hover { border-color: ${TOKEN.text2} }
.vw-root button[data-variant="primary"]:not(:disabled):hover { opacity: .88; border-color: transparent }
.vw-root input:focus, .vw-root select:focus { border-color: ${TOKEN.accent}; box-shadow: 0 0 0 3px color-mix(in srgb, ${TOKEN.accent} 18%, transparent) }
.vw-root [data-row]:not([aria-selected="true"]):hover { background: ${TOKEN.bg2} }
.vw-root [data-row][aria-selected="true"] { background: ${TOKEN.bg2} }
.vw-root [data-row] + [data-row] { border-top: 1px solid ${TOKEN.border} }
.vw-root ::placeholder { color: ${TOKEN.text2}; opacity: .75 }
.vw-root { scrollbar-width: thin }
/* ── the settings nav row's own glyph ──────────────────────────────────
   The host's settings nav hands every plugin section the generic gear; a
   plugin cannot register an icon there, so the label (VaultNavLabel) draws
   the glyph itself and hides that gear. The glyph simply takes the gear's
   place in the row's own flex flow, so the text keeps landing exactly where
   every other row's text sits — no measured offsets, no negative margins
   that could push the label out of its cell on a tight layout. */
.vw-nav-label { display: inline-flex; align-items: center; gap: 8px; min-width: 0 }
.vw-nav-glyph { flex: none; width: 16px; height: 16px; color: inherit }
.vw-nav-text { white-space: nowrap }
/* ── narrow screens (phones) ──────────────────────────────────────────
   Inline styles cannot be reached by a media query, so the declarations
   below override them with !important. They only re-flow what is already
   there: no colour, no size, nothing that would differ between themes. */
@media (max-width: 560px) {
  /* The search box owns its row instead of competing with the controls. */
  .vw-root [data-vw-search] { max-width: none !important; flex: 1 1 100% }
  /* Field rows stack: a fixed 92px label column left too little room for
     long URLs and notes on a phone. The label gets its own line and the
     value keeps the full width, with its copy button beside it. */
  .vw-root [data-vw-field] { grid-template-columns: minmax(0, 1fr) auto !important; gap: 4px 8px !important }
  .vw-root [data-vw-field] > *:first-child { grid-column: 1 / -1 }
  /* Reclaim vertical space: the host dialog is short on a phone. */
  .vw-root { gap: 12px !important }
  .vw-root [data-vw-detail] { padding: 16px !important }
  .vw-root [data-row] { padding: 10px 12px !important; gap: 10px !important }
  /* The settings nav becomes a tight tab strip here (dsh-web-mobile packs
     its cells at padding 6px 8px, gap 6px, 14px icons); the glyph follows
     the host's metrics so the row keeps its rhythm. */
  .vw-nav-label { gap: 6px }
  .vw-nav-glyph { width: 14px; height: 14px }
}
`
      document.head.appendChild(style)
    }

    /**
     * The vault glyph: the plugin-list icon as line art.
     *
     * Same drawing as icon.svg — a hollow shield with a solid keyhole — but in
     * `currentColor` at the sizes the host chrome uses, so it follows the
     * label colour instead of being painted blue everywhere.
     */
    const VaultGlyph = ({ className, size = 16 }) =>
      h(
        'svg',
        {
          className,
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M8 1.7 13.8 3.7V8c0 3.3-2.4 5.6-5.8 6.5C4.6 13.6 2.2 11.3 2.2 8V3.7L8 1.7Z' }),
        h('circle', { cx: 8, cy: 6.3, r: 1.5, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M7.2 7.8h1.6l-.25 2.5H7.45l-.25-2.5Z', fill: 'currentColor', stroke: 'none' }),
      )

    /**
     * The settings nav row's label, drawn with the plugin's own glyph.
     *
     * The host's settings nav gives five built-in section ids their own icon
     * and hands every other section the generic gear; a plugin has no way to
     * register an icon there. So this label carries the glyph itself and hides
     * the gear beside it: the glyph joins the label's own flex flow, so the
     * row keeps the host's exact rhythm — the gear's slot, the host's gap —
     * and the text lands exactly where every other row's text sits, in the
     * desktop column and in the mobile tab strip alike (the strip's tighter
     * metrics come from the stylesheet's narrow-screen block, not from
     * measured offsets that a hidden gear can no longer report). When the
     * host renders no gear sibling the glyph simply joins the label, so the
     * row degrades to an ordinary labelled row.
     */
    const VaultNavLabel = ({ text }) => {
      const labelRef = useRef(null)
      useLayoutEffect(() => {
        // The settings nav is the host's surface: this label can mount before
        // anything of ours ever rendered, so the stylesheet has to exist by
        // now — the row's gap and glyph size live in it.
        ensureStyles()
        const cell = labelRef.current?.closest('button')
        const gear = cell?.querySelector(':scope > svg')
        // Our own glyph is a descendant of the label, never a direct child of
        // the cell, so this only ever hits the host's generic gear.
        if (gear) gear.style.display = 'none'
      }, [text])
      return h(
        'span',
        { className: 'vw-nav-label', ref: labelRef },
        h(VaultGlyph, { className: 'vw-nav-glyph' }),
        h('span', { className: 'vw-nav-text' }, text),
      )
    }

    /**
     * First glyph of an entry name, for the list's monogram tile.
     *
     * A leading digit identifies nothing: entries named after an IP address or
     * a port ("10.0.0.10", "…:9443") tiled the whole list with the same
     * "1". So prefer the first letter or CJK character, fall back to the
     * username for the same reason, and only then use a bare digit.
     */
    const monogram = (item) => {
      const letterIn = (text) => String(text ?? '').trim().match(/[A-Za-z\u4e00-\u9fff]/)?.[0] ?? ''
      // A digit carries no identity here, so every source is checked for a
      // letter before any digit is considered — including the URI host, which
      // is the only name-like field left when both name and username are
      // numeric (an entry named "10.0.0.10" with username "demo-user" should
      // read as D, not as a fifth identical "1").
      const candidates = [item?.name, item?.username, ...(item?.uris ?? []).map((uri) => hostOf(uri))]
      for (const candidate of candidates) {
        const letter = letterIn(candidate)
        if (letter) return letter.toUpperCase()
      }
      for (const candidate of candidates) {
        const digit = String(candidate ?? '').trim().match(/[0-9]/)?.[0]
        if (digit) return digit
      }
      return '?'
    }

    /** Show just the host of a URI: full URLs make list rows unreadable. */
    const hostOf = (uri) => {
      const raw = String(uri ?? '').trim()
      if (!raw) return ''
      try {
        return new URL(/^\w+:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
      } catch {
        return raw
      }
    }

    /** Build the RPC caller over the authenticated `/api` channel. */
    const makeInvoke = (connection) => async (method, args = {}) => {
      if (!connection || typeof connection.rpc?.call !== 'function') {
        const error = new Error('连接通道不可用（请刷新页面）')
        error.code = 'no_connection'
        throw error
      }
      const result = await connection.rpc.call('/api', `vw/${method}`, { args })
      if (!result || !result.ok) {
        const error = new Error(result?.error?.message ?? `vw.${method} 调用失败`)
        error.code = result?.error?.code ?? 'rpc_error'
        throw error
      }
      return result.value
    }

    const relativeTime = (iso, t) => {
      const then = Date.parse(iso ?? '')
      if (!Number.isFinite(then)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
      if (seconds < 60) return t('timeJustNow')
      if (seconds < 3600) return t('timeMinutes').replace('{n}', String(Math.floor(seconds / 60)))
      if (seconds < 86400) return t('timeHours').replace('{n}', String(Math.floor(seconds / 3600)))
      return t('timeDays').replace('{n}', String(Math.floor(seconds / 86400)))
    }

    /** Absolute local timestamp for tooltips, where "3 分钟前" is not enough. */
    const absoluteTime = (iso) => {
      const then = Date.parse(iso ?? '')
      if (!Number.isFinite(then)) return '—'
      const date = new Date(then)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    // ── small controls ────────────────────────────────────────────────────────

    /** Copy-to-clipboard button with a short "copied" confirmation. */
    function CopyButton({ value, t }) {
      const [copied, setCopied] = useState(false)
      useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
      }, [copied])
      return h(
        'button',
        {
          type: 'button',
          style: copied ? { ...S.button, color: TOKEN.ok, borderColor: TOKEN.ok } : S.button,
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(String(value ?? ''))
              setCopied(true)
            } catch {
              /* clipboard unavailable (insecure context): nothing to confirm */
            }
          },
          'aria-label': t('copy'),
        },
        copied ? t('copied') : t('copy'),
      )
    }

    /**
     * Sync-status chip: mode dot + relative last-sync time.
     *
     * It doubles as the manual-sync control — clicking it runs `vw/sync` once,
     * which is the escape hatch when a user does not want to wait for the next
     * poll tick. The hover tooltip carries the full report (mode, connection
     * state, interval, last signal/sync, and the error that caused a fall back
     * to polling), because the chip is the only place that state is visible.
     */
    function SyncChip({ report, t, invoke, onSynced }) {
      const session = report?.session ?? null
      const [state, setState] = useState({ status: 'idle' })
      const live = report?.liveSync ?? {}
      const mode = live.mode ?? 'off'
      const busy = state.status === 'syncing'
      const tone = busy ? 'idle' : mode === 'websocket' ? (live.connected ? 'ok' : 'warn') : mode === 'polling' ? 'warn' : 'idle'
      const label = mode === 'websocket' ? t('syncWebsocket') : mode === 'polling' ? t('syncPolling') : t('syncOff')
      const detail = [
        t('syncTipClick'),
        t('syncTipMode').replace('{mode}', label),
        t('syncTipConnected').replace('{state}', live.connected ? t('syncTipYes') : t('syncTipNo')),
        live.pollIntervalMs ? t('syncTipInterval').replace('{seconds}', String(Math.round(live.pollIntervalMs / 1000))) : null,
        live.lastSyncAt ? t('syncTipLastSync').replace('{time}', absoluteTime(live.lastSyncAt)) : null,
        live.lastSignalAt ? t('syncTipLastSignal').replace('{time}', absoluteTime(live.lastSignalAt)) : null,
        session?.enabled && session.stored ? t('syncTipSession').replace('{days}', String(session.maxAgeDays)) : null,
        live.lastError ? t('syncTipError').replace('{error}', live.lastError) : null,
        state.status === 'failed' ? t('syncTipError').replace('{error}', state.error) : null,
      ]
        .filter(Boolean)
        .join('\n')
      const sync = async () => {
        if (busy) return
        setState({ status: 'syncing' })
        try {
          const result = await invoke('sync')
          setState({ status: 'idle' })
          onSynced?.(result)
        } catch (failure) {
          setState({ status: 'failed', error: failure?.message ?? String(failure) })
        }
      }
      return h(
        'button',
        {
          type: 'button',
          style: busy ? { ...S.chip, borderColor: TOKEN[tone], background: 'transparent', cursor: 'progress', opacity: 0.8 } : { ...S.chip, borderColor: TOKEN[tone], background: 'transparent', cursor: 'pointer' },
          title: detail,
          'aria-live': 'polite',
          'aria-label': detail.replace(/\n/g, '，'),
          onClick: sync,
        },
        h('span', { style: { ...S.dot, background: TOKEN[tone] } }),
        busy ? t('syncNow') : label,
        live.lastSyncAt ? h('span', { style: { color: TOKEN.text2 } }, relativeTime(live.lastSyncAt, t)) : null,
      )
    }

    /** Live TOTP code with a countdown bar (one RPC call per second). */
    function TotpValue({ id, invoke, t }) {
      const [state, setState] = useState({ status: 'loading' })
      useEffect(() => {
        let alive = true
        const tick = () =>
          invoke('totp', { id })
            .then((value) => alive && setState({ status: 'ready', value }))
            .catch(() => alive && setState({ status: 'error' }))
        tick()
        const timer = setInterval(tick, 1000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [id, invoke])
      if (state.status !== 'ready' || !state.value?.totp) return h('span', { style: S.listMeta }, '—')
      const { code, secondsRemaining, period } = state.value.totp
      if (code === undefined) return h('span', { style: S.listMeta }, '—')
      const percent = Math.max(0, Math.min(100, Math.round((secondsRemaining / period) * 100)))
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
        h('span', { style: { ...S.mono, fontSize: 14, letterSpacing: 1 } }, code),
        h('span', { style: S.progressTrack }, h('span', { style: { ...S.progressFill, width: `${percent}%` } })),
        h('span', { style: { ...S.listMeta, width: 20, textAlign: 'right' } }, String(secondsRemaining)),
      )
    }

    // ── setup form (connection + two-factor) ──────────────────────────────────

    /**
     * Guided setup: server URL, login email and master password, written
     * through `vw/configure`. The master password is never read back — an
     * empty field keeps the stored one.
     */
    function SetupForm({ t, invoke, initial, notice, onDone, onCancel }) {
      // Two sign-in methods share one form. Bitwarden's master password is
      // always required (the vault is encrypted with a key derived from it),
      // but an API key can replace the interactive login — and, because the
      // server's api-key grant never runs the two-factor step, it also removes
      // the code prompt entirely.
      const [mode, setMode] = useState(initial?.hasApiKey ? 'apikey' : 'password')
      const [form, setForm] = useState({
        serverUrl: initial?.serverUrl ?? '',
        email: initial?.email ?? '',
        masterPassword: '',
        apiKeyClientId: initial?.apiKeyClientId ?? '',
        apiKeyClientSecret: '',
      })
      const [state, setState] = useState({ status: 'idle' })

      const save = async () => {
        setState({ status: 'saving' })
        try {
          await invoke('configure', {
            serverUrl: form.serverUrl.trim(),
            email: form.email.trim(),
            ...(form.masterPassword ? { masterPassword: form.masterPassword } : {}),
            // Only write API key fields in API-key mode, so switching back to
            // the password method clears them instead of leaving a bypass
            // credential behind.
            apiKeyClientId: mode === 'apikey' ? form.apiKeyClientId.trim() : '',
            ...(mode === 'apikey' && form.apiKeyClientSecret ? { apiKeyClientSecret: form.apiKeyClientSecret } : {}),
          })
          setState({ status: 'saved' })
          onDone?.()
        } catch (failure) {
          setState({ status: 'failed', error: failure?.message ?? String(failure), code: failure?.code })
        }
      }

      const field = (key, label, placeholder, type = 'text', hint) =>
        h(
          'label',
          { style: S.formRow, key },
          h('span', { style: { color: TOKEN.text } }, label),
          h('input', {
            style: S.input,
            type,
            value: form[key],
            placeholder,
            autoComplete: type === 'password' ? 'new-password' : 'off',
            onChange: (event) => setForm((previous) => ({ ...previous, [key]: event.target.value })),
          }),
          hint ? h('span', { style: S.hint }, hint) : null,
        )

      const busy = state.status === 'saving'
      const needsApiKey = mode === 'apikey'
      const ready =
        form.serverUrl.trim() !== '' &&
        form.email.trim() !== '' &&
        // The master password is always needed to decrypt the vault, but an
        // already-stored one need not be retyped.
        (form.masterPassword !== '' || initial?.hasMasterPassword === true) &&
        (!needsApiKey || (form.apiKeyClientId.trim() !== '' && (form.apiKeyClientSecret !== '' || initial?.hasApiKey)))

      return h(
        'div',
        { style: { ...S.detail, maxWidth: 520 } },
        h('span', { style: S.cardTitle }, t('setupTitle')),
        h('span', { style: S.cardSubtitle }, t('setupHint')),
        // Shown only when the saved configuration could not be read: the form
        // is still usable, and this explains why it came up empty.
        notice ? h('span', { style: S.note }, notice) : null,
        field('serverUrl', t('setupServer'), t('setupServerPlaceholder')),
        field('email', t('setupEmail'), 'you@example.com'),
        field('masterPassword', t('setupMaster'), t('setupMasterPlaceholder'), 'password', t('setupMasterHint')),
        h(
          'label',
          { style: S.formRow },
          h('span', { style: { color: TOKEN.text } }, t('setupMethod')),
          h(
            'select',
            { style: S.select, value: mode, onChange: (event) => setMode(event.target.value) },
            h('option', { value: 'password' }, t('setupMethodPassword')),
            h('option', { value: 'apikey' }, t('setupMethodApiKey')),
          ),
          h('span', { style: S.hint }, needsApiKey ? t('setupApiKeyHint') : t('setupMethodPasswordHint')),
        ),
        needsApiKey ? field('apiKeyClientId', t('setupApiKeyId'), 'user.xxxxxxxx-…') : null,
        needsApiKey
          ? field(
              'apiKeyClientSecret',
              t('setupApiKeySecret'),
              initial?.hasApiKey ? t('setupApiKeyKeep') : t('setupApiKeySecretPlaceholder'),
              'password',
              t('setupApiKeySecretHint'),
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' } },
          h(
            'button',
            { type: 'button', style: busy ? { ...S.buttonPrimary, opacity: 0.7 } : S.buttonPrimary, 'data-variant': 'primary', disabled: busy || !ready, onClick: save },
            busy ? t('setupSaving') : t('setupSave'),
          ),
          // The form is also reachable from the toolbar; when it is open on top
          // of a working vault the user needs a way back without saving.
          typeof onCancel === 'function'
            ? h('button', { type: 'button', style: busy ? { ...S.button, opacity: 0.7 } : S.button, disabled: busy, onClick: () => onCancel() }, t('setupCancel'))
            : null,
          state.status === 'saved' ? h('span', { style: S.ok }, t('setupSaved')) : null,
          state.status === 'failed' ? h('span', { style: S.error }, `${t('setupFailed')}：${state.error}`) : null,
        ),
      )
    }

    /**
     * Sign-in form: the panel's entry point once credentials are stored.
     *
     * Submitting verifies the password (and address/account if edited) against
     * the server; the code screen appears only after the credentials are
     * accepted, so "password wrong" and "code wrong" never look alike.
     */
    function SignInForm({ t, invoke, initial, onConnected, onTwoFactor, onSetup }) {
      // Same two methods as the setup form, so an API-key account never sees
      // the code screen: the server's api-key grant skips two-factor entirely.
      const [mode, setMode] = useState(initial?.hasApiKey ? 'apikey' : 'password')
      const [form, setForm] = useState({
        serverUrl: initial?.serverUrl ?? '',
        email: initial?.email ?? '',
        masterPassword: '',
        apiKeyClientId: initial?.apiKeyClientId ?? '',
        apiKeyClientSecret: '',
      })
      const [state, setState] = useState({ status: 'idle' })

      const submit = async () => {
        setState({ status: 'connecting' })
        try {
          // An API-key sign-in writes the key (and clears the password method's
          // leftover fields) through `connect`, which persists only on success.
          const result = await invoke('connect', {
            serverUrl: form.serverUrl.trim(),
            email: form.email.trim(),
            ...(form.masterPassword ? { masterPassword: form.masterPassword } : {}),
            ...(mode === 'apikey'
              ? {
                  apiKeyClientId: form.apiKeyClientId.trim(),
                  ...(form.apiKeyClientSecret ? { apiKeyClientSecret: form.apiKeyClientSecret } : {}),
                }
              : { apiKeyClientId: '' }),
          })
          if (result?.twoFactor) {
            setState({ status: 'idle' })
            onTwoFactor?.(result)
            return
          }
          setState({ status: 'ok' })
          onConnected?.()
        } catch (failure) {
          setState({ status: 'failed', error: failure?.message ?? String(failure) })
        }
      }

      const busy = state.status === 'connecting'
      const needsApiKey = mode === 'apikey'
      // The master password is required even in API-key mode: it decrypts the
      // vault, which the server can never do for us. An already-stored secret
      // means the field may be left empty.
      const needsPassword = initial?.hasMasterPassword !== true
      const ready =
        form.serverUrl.trim() !== '' &&
        form.email.trim() !== '' &&
        (!needsPassword || form.masterPassword !== '') &&
        (!needsApiKey || (form.apiKeyClientId.trim() !== '' && (form.apiKeyClientSecret !== '' || initial?.hasApiKey)))

      const field = (key, label, placeholder, type) =>
        h(
          'label',
          { style: S.formRow },
          h('span', null, label),
          h('input', {
            style: S.input,
            type: type ?? 'text',
            value: form[key],
            placeholder,
            autoComplete: type === 'password' ? 'current-password' : 'off',
            onChange: (event) => setForm((previous) => ({ ...previous, [key]: event.target.value })),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && ready) submit()
            },
          }),
        )

      return h(
        'div',
        { style: { ...S.detail, maxWidth: 520 } },
        h('span', { style: S.cardTitle }, t('signInTitle')),
        h('span', { style: S.cardSubtitle }, t('signInHint')),
        field('serverUrl', t('setupServer'), t('setupServerPlaceholder')),
        field('email', t('setupEmail'), 'you@example.com'),
        field('masterPassword', t('setupMaster'), t('setupMasterPlaceholder'), 'password'),
        h(
          'label',
          { style: S.formRow },
          h('span', null, t('setupMethod')),
          h(
            'select',
            { style: S.select, value: mode, onChange: (event) => setMode(event.target.value) },
            h('option', { value: 'password' }, t('setupMethodPassword')),
            h('option', { value: 'apikey' }, t('setupMethodApiKey')),
          ),
          h('span', { style: S.hint }, needsApiKey ? t('setupApiKeyHint') : t('setupMethodPasswordHint')),
        ),
        needsApiKey ? field('apiKeyClientId', t('setupApiKeyId'), 'user.xxxxxxxx-…') : null,
        needsApiKey
          ? field(
              'apiKeyClientSecret',
              t('setupApiKeySecret'),
              initial?.hasApiKey ? t('setupApiKeyKeep') : t('setupApiKeySecretPlaceholder'),
              'password',
              t('setupApiKeySecretHint'),
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' } },
          h(
            'button',
            { type: 'button', style: busy ? { ...S.buttonPrimary, opacity: 0.7 } : S.buttonPrimary, 'data-variant': 'primary', disabled: busy || !ready, onClick: submit },
            busy ? t('signInConnecting') : t('signInSubmit'),
          ),
          h('button', { type: 'button', style: busy ? { ...S.button, opacity: 0.7 } : S.button, disabled: busy, onClick: () => onSetup?.() }, t('openSetup')),
          state.status === 'failed' ? h('span', { style: S.error }, state.error) : null,
        ),
      )
    }

    /**
     * Two-factor step: the account answered the password grant with
     * `two_factor_required`; the code finishes that same login attempt.
     *
     * Behaviour (as specified):
     *  - This screen is reached only after the credentials were verified, so a
     *    failure here always means the code, never the password.
     *  - It stays put while the user retries: a wrong code shows an inline
     *    error and a fresh code can be submitted immediately — a submit never
     *    throws the user back to the credential form.
     *  - "返回设置" is the deliberate way back, and it drops the session.
     */
    function TwoFactorForm({ t, invoke, pending, onDone, onRestart, onRefresh }) {
      const [code, setCode] = useState('')
      const [provider, setProvider] = useState(pending?.provider ?? 0)
      const [remember, setRemember] = useState('yes')
      const [state, setState] = useState({ status: 'idle' })

      const submit = async () => {
        setState({ status: 'submitting' })
        try {
          // The server issues no continuation token: this re-runs the password
          // grant with the code, so a restart between challenge and submission
          // (or a wrong code) is fully recoverable.
          // 记住此设备 is the server's "remember this device" flag; the stricter
          // choices send false. The plugin stores nothing in the browser either
          // way — no cookie, no localStorage, only React state for this view.
          await invoke('submitTwoFactor', {
            code: code.trim(),
            provider,
            remember: remember === 'yes',
          })
          setState({ status: 'ok' })
          onDone?.()
        } catch (failure) {
          const message = failure?.message ?? String(failure)
          setState({ status: 'failed', error: message })
          // An expired challenge cannot accept any code, but this is still not a
          // reason to eject the user: ask the host for a fresh challenge and
          // stay on this screen so the next code can be submitted here.
          if (/失效|过期|expired|two_factor_expired|re-?login|重新登录/i.test(message)) {
            onRefresh?.()
          }
        }
      }

      /** Deliberate way back to the credential form (drops the session). */
      const restart = async () => {
        setState({ status: 'restarting' })
        try {
          await invoke('reset')
        } catch {
          /* a failed reset must still return the user to a usable state */
        }
        onRestart?.()
      }

      const providers = pending?.providers ?? []
      const busy = state.status === 'submitting' || state.status === 'restarting'
      return h(
        'div',
        { style: { ...S.detail, maxWidth: 520 } },
        h('span', { style: S.cardTitle }, t('twoFactorTitle')),
        h('span', { style: S.cardSubtitle }, t('twoFactorHint')),
        providers.length > 1
          ? h(
              'label',
              { style: S.formRow },
              h('span', null, t('twoFactorProviders').replace('{n}', String(providers.length))),
              h(
            'select',
            { style: S.select, value: String(provider), onChange: (event) => setProvider(Number(event.target.value)) },
                providers.map((id) => h('option', { key: id, value: String(id) }, providerLabel(id))),
              ),
            )
          : null,
        h(
          'label',
          { style: S.formRow },
          h('span', null, t('twoFactorCode')),
          h('input', {
            style: { ...S.input, letterSpacing: 2, fontFamily: S.mono.fontFamily },
            value: code,
            placeholder: t('twoFactorPlaceholder'),
            autoComplete: 'one-time-code',
            onChange: (event) => setCode(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && code.trim()) submit()
            },
          }),
        ),
        h(
          'label',
          { style: S.formRow },
          h('span', null, t('twoFactorRemember')),
          h(
            'select',
            { style: S.select, value: remember, onChange: (event) => setRemember(event.target.value) },
            h('option', { value: 'yes' }, t('twoFactorRememberYes')),
            h('option', { value: 'once' }, t('twoFactorRememberOnce')),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' } },
          h(
            'button',
            { type: 'button', style: busy ? { ...S.buttonPrimary, opacity: 0.7 } : S.buttonPrimary, 'data-variant': 'primary', disabled: busy || !code.trim(), onClick: submit },
            busy ? t('twoFactorSubmitting') : t('twoFactorSubmit'),
          ),
          h('button', { type: 'button', style: busy ? { ...S.button, opacity: 0.7 } : S.button, disabled: busy, onClick: restart }, t('twoFactorRestart')),
          state.status === 'failed' ? h('span', { style: S.error }, state.error) : null,
        ),
      )
    }

    /** Provider id → label, mirroring Bitwarden's TwoFactorProviderType. */
    const providerLabel = (id) => {
      const names = {
        0: '验证器 App（TOTP）',
        1: '邮箱验证码',
        2: 'Duo',
        3: 'YubiKey OTP',
        4: 'U2F',
        5: '记住的设备',
        6: '组织 Duo',
        7: 'WebAuthn',
        8: '恢复码',
      }
      return names[id] ?? `方式 ${id}`
    }

    // ── entry browser (settings.section page) ─────────────────────────────────

    function VaultPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => DICT_ZH[key] ?? key
      const invoke = props.invoke
      const [state, setState] = useState({ status: 'loading' })
      const [query, setQuery] = useState('')
      const [selectedId, setSelectedId] = useState(null)
      const [detail, setDetail] = useState({ status: 'idle' })
      const [revealed, setRevealed] = useState(false)
      const [setup, setSetup] = useState({ status: 'loading' })
      const [twoFactor, setTwoFactor] = useState(null)
      // The setup form is reachable at any time (not only when unconfigured):
      // it is the "previous level" a failed or half-finished login returns to.
      const [showSetup, setShowSetup] = useState(false)
      // Progressive paging: `loadingMore` marks a page fetch in flight, and
      // `manualMore` is the explicit fallback control — it appears when the
      // reader outruns the host (or paging cannot continue), so the list never
      // stalls silently short of the vault.
      const [loadingMore, setLoadingMore] = useState(false)
      const [manualMore, setManualMore] = useState(false)
      // True once the host has shown that it cannot page: it serves one capped
      // answer (FULL_LIMIT, the same ceiling lib/vault.js clamps to), so rows
      // beyond that answer are out of reach from here — not a paging stall.
      const [hostCapped, setHostCapped] = useState(false)
      const searchRef = useRef(null)
      /** Latest status, readable from callbacks without adding a dependency. */
      const statusRef = useRef('loading')
      statusRef.current = state.status
      /** Paging bookkeeping: one page at a time, tied to a list generation. */
      const pagingRef = useRef({ busy: false, gen: 0 })
      /** The scroll container, for the post-page bottom check. */
      const scrollRef = useRef(null)
      /** Newest list values, readable from async page loads. */
      const itemsRef = useRef([])
      const morePagesRef = useRef(false)
      const manualMoreRef = useRef(false)
      /** Where the next page starts, as told by the host rather than by rows. */
      const offsetRef = useRef(0)
      /** The keep-going timer, so a closed panel can cancel it. */
      const followUpRef = useRef(null)

      /** Fetch entries for a live session (never logs in by itself). */
      const readVault = useCallback(
        async (nextQuery, options = {}) => {
          const identity = options.identity ?? cacheKey(openCache.config?.config)
          if (!options.quiet) setState({ status: 'loading' })
          // A fresh read starts a new paging generation: a page still in
          // flight for the previous list must not append into this one.
          pagingRef.current.gen += 1
          pagingRef.current.busy = false
          // A follow-up queued by the previous list is moot now, and it must not
          // fire into this generation's list.
          if (followUpRef.current) {
            clearTimeout(followUpRef.current)
            followUpRef.current = null
          }
          setLoadingMore(false)
          setManualMore(false)
          setHostCapped(false)
          try {
            // Two independent host calls that used to queue behind each other:
            // status waited for the whole list to come back. Firing them
            // together halves the wait before the rows appear, and status is
            // only the sync badge, so its failure costs nothing but that.
            // The list read is one small page — the rest arrive as the reader
            // scrolls (see loadMorePage). No `offset` field on this first
            // call, so a host that predates paging still answers it.
            //
            // A host that has already refused a page read goes straight for the
            // whole vault: paging it cannot do would only paint 50 rows and
            // replace them with the full answer a moment later.
            // Hoisted out of the call: the RPC contract test reads field names
            // out of the argument object, and a ternary there would look like
            // one (the host-entry suite greps for `name:` patterns).
            const firstLimit = pagingRefused ? FULL_LIMIT : PAGE_SIZE
            const [list, report] = await Promise.all([
              invoke('list', { query: nextQuery ?? '', limit: firstLimit }),
              invoke('status').catch(() => null),
            ])
            if (pagingRefused) {
              setHostCapped(true)
              if ((Array.isArray(list.items) ? list.items.length : 0) < Number(list.matched ?? 0)) setManualMore(true)
            }
            // Start paging where the host says its answer ends: a host that
            // predates paging reports no window, and the first page is the
            // whole answer it gave, so its length is the same number.
            offsetRef.current = nextOffsetOf(list, Array.isArray(list.items) ? list.items.length : 0)
            // Remember the successful result so the next open can paint at
            // once: in memory for a reopen, and in localStorage for a reload.
            if (!nextQuery) {
              const snapshot = { key: identity, list, report, at: Date.now() }
              openCache.vault = snapshot
              writeSnapshot(snapshot)
            }
            setState({ status: 'ready', list, report })
          } catch (failure) {
            const message = String(failure?.message ?? failure)
            // A live session that now requires a code (rare) still shows the
            // code screen; anything else keeps its message.
            if (failure?.code === 'two_factor_required' || /两步验证|two.?factor/i.test(message)) {
              try {
                const pending = await invoke('twoFactor')
                setTwoFactor(pending?.pending ? pending : { pending: true })
              } catch {
                setTwoFactor({ pending: true })
              }
              setState({ status: 'two_factor', error: message, code: failure?.code })
              return
            }
            // A background refresh that fails keeps the cached view on screen:
            // the user did not ask for anything, so a transient network blip
            // must not wipe out what they are looking at.
            if (options.quiet && statusRef.current === 'ready') return
            setState({ status: 'error', error: message, code: failure?.code })
          }
        },
        [invoke],
      )

      /**
       * Open the panel: paint whatever is remembered, then ask the host what
       * is true.
       *
       * Deliberately does NOT start a login. With a stored credential set that
       * answers `two_factor_required` an auto-login would drop the user on the
       * code screen on every visit, so the way back into a session is either
       * `boot`'s silent `resumeSession()` — restore the stored session, swap
       * the refresh token — or an explicit sign-in. A live session shows the
       * entries; otherwise the credential form does.
       */
      const load = useCallback(
        async (nextQuery) => {
          // Paint first, ask later. Whatever the last successful read for this
          // server and account was, it goes on screen now — including after a
          // reload, where the module cache is gone — and the host call below
          // decides whether it was the right one.
          let painted = nextQuery ? null : freshSnapshot()
          if (painted) {
            setState({ status: 'ready', list: painted.list, report: painted.report })
          } else {
            setState({ status: 'loading' })
          }

          // One round trip instead of two, and it revives a stored session
          // while it is in there.
          let boot = null
          try {
            boot = await invoke('boot')
            if (boot?.config) {
              setSetup({ status: 'ready', config: boot.config })
              openCache.config = { config: boot.config, at: Date.now() }
            }
          } catch (failure) {
            // The host half is older than this bundle (a stale page after a
            // plugin upgrade): fall back to the pre-boot path so the panel
            // still opens instead of claiming the vault is unconfigured.
            // Only an unknown \`vw/boot\` means "old host"; a host that answered
            // and failed (a thrown VaultError inside boot) must keep reaching
            // the credential/setup screens, not the sign-in form.
            if (!missingMethod(failure)) {
              setSetup({ status: 'error', error: failure?.message ?? String(failure) })
            } else {
            const [legacyConfig, legacySession] = await Promise.all([
              invoke('config').catch(() => null),
              invoke('session').catch(() => null),
            ])
            if (legacyConfig) {
              // The old host could not restore anything by itself, so its
              // `session` answer was the best it had: a live in-memory token.
              // Treat that as a live session; a token-less one (or an empty
              // config) still falls through to the credential form.
              boot = {
                config: legacyConfig,
                resumed: Boolean(legacyConfig.serverUrl && legacyConfig.email && legacySession?.authenticated === true),
              }
              setSetup({ status: 'ready', config: legacyConfig })
              openCache.config = { config: legacyConfig, at: Date.now() }
            } else {
              setSetup({ status: 'error', error: failure?.message ?? String(failure) })
            }
            }
          }
          const config = boot?.config ?? null
          const identity = cacheKey(config)

          // A snapshot painted before the config arrived may belong to another
          // account: drop it rather than show the wrong entries.
          if (painted && painted.key !== identity) {
            painted = null
            setState({ status: 'loading' })
          }
          const configured = Boolean(config?.serverUrl && config?.email && (config?.hasMasterPassword || config?.hasApiKey))
          if (!configured) {
            forgetSnapshot()
            setState({ status: 'unconfigured' })
            return
          }
          // `boot` revived the stored session when there was one; reaching here
          // means there is none, so the credential form is the only way forward.
          // The snapshot goes with it: a signed-out panel must show nothing.
          if (!boot?.resumed) {
            forgetSnapshot()
            setState({ status: 'signin' })
            return
          }
          await readVault(nextQuery, { quiet: Boolean(painted), identity })
        },
        [invoke, readVault],
      )

      /** The rows on screen (empty until a read succeeded). */
      const items = () => (state.status === 'ready' ? state.list.items ?? [] : [])
      /**
       * Is what is on screen a prefix of a longer answer? Every page reports
       * `hasMore`; a host that predates paging omits it, and there the count
       * the host matched is the next best signal.
       */
      const morePages = () =>
        state.status === 'ready' &&
        // A host that cannot page has already handed over everything it will:
        // asking again would only spin the control (see `cappedNotice`).
        !hostCapped &&
        (state.list.hasMore === true || (state.list.hasMore === undefined && items().length < Number(state.list.matched ?? 0)))
      /**
       * Rows the host is holding back — its answer was clamped (FULL_LIMIT) and
       * it cannot page, so they are unreachable from the panel. Said in place,
       * as a notice, rather than offered as a control that does nothing.
       */
      const cappedNotice = hostCapped && state.status === 'ready' && Number(state.list.matched ?? 0) > items().length
      // The async page loads read the newest list and the newest answer through
      // refs: depending on `state` would rebuild those callbacks on every
      // keystroke and on every arrived page.
      itemsRef.current = items()
      morePagesRef.current = morePages()
      manualMoreRef.current = manualMore

      /** Is the reader close enough to the bottom to want the next page? */
      const atBottom = (node) => {
        const target = node ?? scrollRef.current
        if (!target) return false
        const remaining = Number(target.scrollHeight) - Number(target.scrollTop) - Number(target.clientHeight)
        // No layout to measure (a synthetic event, an unrendered container):
        // nothing to act on. Guessing "at the bottom" here would turn a
        // measurement-less container into a pager that drains the whole vault.
        if (!Number.isFinite(remaining)) return false
        return remaining <= SCROLL_TRIGGER_PX
      }

      /**
       * Read the rest of the vault in one call — the last resort, for a host
       * that cannot serve pages.
       *
       * Two ways in: an older host *refuses* a page read (its descriptor
       * declares `list(query, limit)` and nothing else, so the gateway rejects
       * the extra `offset` field outright), or a page came back adding no rows.
       * One failure here is not fatal: the rows already on screen stay, and the
       * "还有 N 条" control keeps offering another try.
       */
      const completeList = useCallback(
        async (generation) => {
          if (pagingRef.current.gen !== generation) return
          try {
            const full = await invoke('list', { query, limit: FULL_LIMIT })
            if (pagingRef.current.gen !== generation) return
            // `limit` is a ceiling, not a promise: a vault with more entries
            // than the host is willing to serve in one answer comes back short
            // of its own count. Claiming "complete" there would strand the
            // reader at the ceiling with no way on, so answer with what was
            // actually served and leave the count honest.
            const served = Array.isArray(full.items) ? full.items.length : 0
            const truncated = served < Number(full.matched ?? 0)
            // A short answer here is the host's own ceiling, not a stalled
            // page: the rows behind it cannot be read from this side at all.
            if (truncated) {
              setManualMore(true)
              setHostCapped(true)
            }
            setState((previous) => (previous.status === 'ready' ? { ...previous, list: { ...full, offset: 0, hasMore: truncated } } : previous))
          } catch {
            if (pagingRef.current.gen !== generation) return
            setManualMore(true)
          }
        },
        [invoke, query],
      )

      /**
       * Append the next page. Driven by the scroll handler when the reader
       * nears the bottom, and by the fallback control when they outrun it.
       *
       * One page at a time: a scroll that lands while a page is in flight does
       * not queue another read behind it — it raises the explicit control
       * instead, so a fast flick through a large vault cannot turn into a
       * burst of overlapping reads.
       */
      const loadMorePage = useCallback(
        async (fromButton) => {
          const paging = pagingRef.current
          if (paging.busy) return
          if (!morePagesRef.current) return
          // Paging is driven by what the host reported, not by how many rows
          // ended up on screen: the two agree unless a page was deduplicated.
          const offset = offsetRef.current || itemsRef.current.length
          const generation = paging.gen
          paging.busy = true
          setLoadingMore(true)
          if (fromButton) setManualMore(false)
          try {
            const page = await invoke('list', { query, limit: PAGE_SIZE, offset })
            if (paging.gen !== generation) return
            const seen = new Set(itemsRef.current.map((item) => item.id))
            const fresh = (page.items ?? []).filter((item) => !seen.has(item.id))
            if (!fresh.length) {
              // Nothing new came back: either this host ignores `offset` and
              // repeats the leading rows, or the window it served was already
              // on screen. Paging on would only repeat, so read the rest once.
              await completeList(generation)
              return
            }
            // Trust the window the host says it served over the one that was
            // asked for: a shifted or overlapping page would otherwise pull the
            // next read inside it and leave rows unseen.
            offsetRef.current = nextOffsetOf(page, offset + fresh.length)
            // `manualMore` is deliberately left alone here: a reader who
            // outran a page keeps the explicit control until they use it (or a
            // fresh read resets the list), instead of the page landing under
            // their cursor and leaving them at a silent bottom.
            setState((previous) =>
              previous.status === 'ready'
                ? { ...previous, list: { ...page, offset: previous.list.offset ?? 0, items: [...(previous.list.items ?? []), ...fresh] } }
                : previous,
            )
            // A short page can still leave the reader inside the trigger zone
            // (a tall window, a page that barely filled it). They are asking
            // to keep going, so keep going — until the rows push them out of
            // it, which is what stops this from running away. A reader who
            // outran the page is not on this path: they get the control.
            if (!manualMoreRef.current && morePagesRef.current && atBottom()) {
              // Held in a ref: a reader who closes the panel between the page
              // landing and this tick would otherwise leave a read running.
              followUpRef.current = setTimeout(() => {
                followUpRef.current = null
                void loadMorePage()
              }, 0)
            }
          } catch (failure) {
            if (paging.gen !== generation) return
            // An older host declares `list(query, limit)` and the gateway
            // refuses any field the descriptor does not name, so every page
            // read fails the same way — retrying it can never succeed. Read
            // the whole vault in one call instead.
            if (failure?.code === 'gateway/arguments-invalid') {
              pagingRefused = true
              await completeList(generation)
              return
            }
            // A failed page is not a failed panel: the rows on screen stay,
            // and the reader gets an explicit control rather than a list that
            // quietly stops short of its own count.
            setManualMore(true)
          } finally {
            if (paging.gen === generation) {
              paging.busy = false
              setLoadingMore(false)
            }
          }
        },
        [completeList, invoke, query],
      )

      /**
       * Scroll handler for the one scrolling region: ask for the next page
       * once the reader is a screenful-and-a-bit from the bottom.
       */
      const onListScroll = (event) => {
        if (!morePagesRef.current) return
        if (!atBottom(event?.currentTarget)) return
        if (pagingRef.current.busy) {
          // Outrun: a page is already on its way, so show the explicit control
          // rather than stacking reads behind it.
          setManualMore(true)
          return
        }
        void loadMorePage()
      }

      // Pseudo-class rules (hover / focus) live in one injected stylesheet.
      useEffect(() => {
        ensureStyles()
      }, [])

      // A queued follow-up page belongs to the mounted panel; unmounting drops
      // it rather than reading on behalf of a closed settings pane.
      useEffect(
        () => () => {
          if (followUpRef.current) clearTimeout(followUpRef.current)
          followUpRef.current = null
        },
        [],
      )

      // search is debounced; the first (empty) query loads immediately
      useEffect(() => {
        const timer = setTimeout(() => load(query), query ? 250 : 0)
        return () => clearTimeout(timer)
      }, [query, load])

      // "/" focuses the search box from anywhere in the panel
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== '/' || event.metaKey || event.ctrlKey) return
          const target = event.target
          if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
          event.preventDefault()
          searchRef.current?.focus()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [])

      // selection loads the full reveal once; reprompt entries stay gated
      useEffect(() => {
        if (!selectedId) {
          setDetail({ status: 'idle' })
          setRevealed(false)
          return undefined
        }
        let alive = true
        setDetail({ status: 'loading' })
        setRevealed(false)
        invoke('reveal', { id: selectedId })
          .then((value) => alive && setDetail({ status: 'ready', value }))
          .catch((failure) => alive && setDetail({ status: 'error', error: failure?.message }))
        return () => {
          alive = false
        }
      }, [selectedId, invoke])

      const confirmReveal = async () => {
        setDetail({ status: 'loading' })
        try {
          const value = await invoke('reveal', { id: selectedId, confirm: true })
          setDetail({ status: 'ready', value })
          setRevealed(true)
        } catch (failure) {
          setDetail({ status: 'error', error: failure?.message })
        }
      }

      const move = (delta) => {
        const rows = items()
        if (!rows.length) return
        const index = rows.findIndex((item) => item.id === selectedId)
        const next = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + delta))
        setSelectedId(rows[next].id)
      }

      const toolbar = h(
        'div',
        { style: S.toolbar },
        h('input', {
          ref: searchRef,
          'data-vw-search': '',
          style: { ...S.input, maxWidth: 320, width: '100%' },
          type: 'search',
          value: query,
          placeholder: t('searchPlaceholder'),
          // The shortcuts used to sit in the placeholder and were the first
          // thing truncated on a phone; a tooltip keeps them reachable.
          title: t('searchHint'),
          'aria-label': t('search'),
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') setQuery('')
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              move(1)
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              move(-1)
            }
          },
        }),
        state.status === 'ready' ? h(SyncChip, { report: state.report, t, invoke, onSynced: () => readVault(query) }) : null,
        h('span', { style: S.note }, state.status === 'ready' ? t('itemsCount').replace('{n}', String(state.list.vaultItems ?? items().length)) : ''),
        h(
          'div',
          { style: S.toolbarActions },
          h('button', { type: 'button', style: S.button, onClick: () => setShowSetup(true) }, t('openSetup')),
          h('button', { type: 'button', style: S.button, onClick: () => load(query) }, t('refresh')),
        ),
      )

      const list = h(
        'div',
        { style: S.list, role: 'listbox', 'aria-label': t('panelTitle') },
        state.status === 'ready' && items().length === 0
          ? h('div', { style: S.empty }, h('span', null, t('listEmpty')), h('span', { style: S.note }, t('listHint')))
          : items().map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  role: 'option',
                  'aria-selected': item.id === selectedId ? 'true' : 'false',
                  'data-row': '',
                  style: S.listRow,
                  onClick: () => setSelectedId(item.id),
                },
                // A monogram tile instead of a bare letter: it reads as an icon
                // slot, so rows line up whether or not an entry has a favicon.
                h('span', { style: S.avatar, 'aria-hidden': 'true' }, monogram(item)),
                h(
                  'span',
                  { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
                  h('span', { style: S.listName }, item.name || t('untitled')),
                  h('span', { style: S.listMeta }, [item.username, hostOf(item.uris?.[0])].filter(Boolean).join(' · ')),
                ),
                item.hasTotp ? h('span', { style: S.badge, title: t('hasTotp') }, 'TOTP') : null,
                item.favorite ? h('span', { style: { ...S.listMeta, color: TOKEN.warn, fontSize: 13 }, title: t('favorite') }, '★') : null,
                h('span', { style: { ...S.listMeta, fontSize: 15, flexShrink: 0 }, 'aria-hidden': 'true' }, '›'),
              ),
            ),
        // The tail: the capped notice (rows this side cannot reach), the
        // explicit "还有 N 条" control (the reader outran the host, or a page
        // could not be read), or a quiet line while the next page is on its
        // way. The remaining count comes from the host's own total, so the
        // control is honest even when paging stalled.
        cappedNotice
          ? h(
              'div',
              {
                'data-list-capped': '',
                style: { ...S.note, padding: '10px 4px 2px', textAlign: 'center', lineHeight: 1.6 },
              },
              t('moreBlocked')
                .replace('{shown}', String(items().length))
                .replace('{total}', String(Number(state.list.matched ?? 0)))
                .replace('{n}', String(Math.max(0, Number(state.list.matched ?? 0) - items().length))),
            )
          : null,
        morePages()
          ? manualMore
            ? h(
                'button',
                {
                  type: 'button',
                  'data-row': '',
                  'data-load-more': '',
                  disabled: loadingMore,
                  style: { ...S.listRow, justifyContent: 'center', color: TOKEN.text2, fontSize: 12.5 },
                  onClick: () => void loadMorePage(true),
                },
                t('loadMore').replace('{n}', String(Math.max(1, Number(state.list.matched ?? 0) - items().length))),
              )
            : loadingMore
              ? h(
                  'div',
                  {
                    'data-loading-more': '',
                    'aria-live': 'polite',
                    style: { ...S.listRow, justifyContent: 'center', color: TOKEN.text2, fontSize: 12.5, cursor: 'default' },
                  },
                  t('loadingMore'),
                )
              : null
          : null,
      )

      const detailPane = () => {
        if (detail.status === 'loading') return h('div', { style: { ...S.detail, ...S.empty } }, h('span', { style: S.note }, t('syncLoading')))
        if (detail.status === 'error') {
          return h(
            'div',
            { style: S.detail },
            h('span', { style: S.error }, detail.error),
            h('button', { type: 'button', style: S.button, onClick: () => setSelectedId(null) }, t('retry')),
          )
        }
        const value = detail.value ?? {}
        if (value.repromptRequired) {
          return h(
            'div',
            { style: S.detail },
            h('span', { style: S.cardTitle }, value.name || t('untitled')),
            h('span', { style: S.note }, t('repromptLocked')),
            h('span', { style: S.note }, t('repromptHint')),
            h('button', { type: 'button', style: S.buttonPrimary, onClick: confirmReveal }, t('confirmRead')),
          )
        }
        const row = (label, content, copyValue) =>
          h(
            'div',
            { 'data-vw-field': '', style: S.fieldRow, key: label },
            h('span', { style: S.fieldLabel }, label),
            h('span', { style: S.fieldValue }, content ?? '—'),
            copyValue ? h(CopyButton, { value: copyValue, t }) : null,
          )
        return h(
          'div',
          { 'data-vw-detail': '', style: S.detail },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12 } },
            h('span', { style: { ...S.avatar, width: 36, height: 36, fontSize: 14 }, 'aria-hidden': 'true' }, monogram(value)),
            h(
              'div',
              { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
              h('span', { style: S.cardTitle }, value.name || t('untitled')),
              h('span', { style: S.listMeta }, [value.username, hostOf(value.uris?.[0])].filter(Boolean).join(' · ') || t('noMeta')),
            ),
            value.type ? h('span', { style: S.badge }, value.type) : null,
          ),
          h('div', { style: { height: 1, background: TOKEN.border } }),
          row(t('username'), value.username, value.username),
          // One row for the password: masked value, a show/hide toggle and a
          // copy button. Rendering the toggle as a second row made the label
          // repeat and pushed the controls out of the card.
          h(
            'div',
            { 'data-vw-field': '', style: S.fieldRow, key: 'password' },
            h('span', { style: S.fieldLabel }, t('password')),
            h('span', { style: revealed ? S.mono : S.fieldValue }, revealed ? value.password ?? '' : '●●●●●●●●'),
            h(
              'div',
              { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
              h('button', { type: 'button', style: { ...S.button, height: 28, padding: '0 10px' }, onClick: () => setRevealed((previous) => !previous) }, revealed ? t('hide') : t('show')),
              value.password ? h(CopyButton, { value: value.password, t }) : null,
            ),
          ),
          h('div', { 'data-vw-field': '', style: S.fieldRow }, h('span', { style: S.fieldLabel }, t('totp')), value.totpSecret ? h(TotpValue, { id: value.id, invoke, t }) : h('span', { style: S.listMeta }, '—'), null),
          row(t('uris'), (value.uris ?? []).join(', ')),
          row(t('folder'), [value.folder, (value.collections ?? []).join(', ')].filter(Boolean).join(' · ')),
          row(t('notes'), value.notes ? h('span', { style: { whiteSpace: 'pre-wrap' } }, value.notes) : null, value.notes),
          (value.fields ?? []).length
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
                h('span', { style: { fontSize: 12, fontWeight: 600, color: TOKEN.text2 } }, t('customFields')),
                ...(value.fields ?? []).map((field, index) =>
                  h(
                    'div',
                    { 'data-vw-field': '', style: S.fieldRow, key: `field-${index}` },
                    h('span', { style: S.fieldLabel }, field.name),
                    h('span', { style: S.fieldValue }, field.value),
                    h(CopyButton, { value: field.value, t }),
                  ),
                ),
              )
            : null,
        )
      }

      /**
       * Re-issue the two-factor challenge without leaving this screen.
       * A login attempt that answers `two_factor_required` mints a new token,
       * so the user can keep typing codes right here after one expired.
       */
      const refreshChallenge = useCallback(async () => {
        try {
          await invoke('list', { query: '', limit: 1 })
        } catch {
          /* expected: the attempt ends on the challenge itself */
        }
        try {
          const pending = await invoke('twoFactor')
          if (pending?.pending) setTwoFactor(pending)
        } catch {
          /* keep whatever challenge we already show */
        }
      }, [invoke])

      /**
       * Leaving this view (switching settings pages, closing the dialog)
       * deactivates a half-finished sign-in, so the next visit starts from the
       * credential form again. A live session is deliberately kept: closing the
       * panel must not sign the user out of a vault they already unlocked.
       */
      useEffect(
        () => () => {
          invoke('discardChallenge').catch(() => {})
        },
        [invoke],
      )

      /**
       * Leave the two-factor screen for the setup form.
       * Also drops the half-finished session: once the user goes back to edit
       * the address/account/password, the stale challenge must not survive and
       * the next connect starts clean.
       */
      const backToSetup = async () => {
        try {
          await invoke('reset')
        } catch {
          /* opening the form must succeed even if the reset call fails */
        }
        // The host dropped its session as well, so the remembered entries
        // must not outlive it: the next open would paint them from memory.
        forgetSnapshot()
        setShowSetup(true)
      }

      const body = () => {
        // The setup form wins whenever it is open: after "back to settings" the
        // user must be able to edit the address/account/password in peace.
        if (showSetup) {
          return h(SetupForm, {
            t,
            invoke,
            initial: setup.status === 'ready' ? setup.config : undefined,
            onDone: () => {
              setShowSetup(false)
              load(query)
            },
            onCancel: () => {
              setShowSetup(false)
              load(query)
            },
          })
        }
        if (state.status === 'loading') return h('div', { style: { ...S.detail, ...S.empty } }, h('span', { style: S.note }, t('syncLoading')))
        // Opening the panel lands here whenever no session is live: the user
        // signs in explicitly instead of being auto-logged-in (and, for a
        // 2FA account, dropped onto the code screen every time).
        if (state.status === 'signin') {
          return h(SignInForm, {
            t,
            invoke,
            initial: setup.status === 'ready' ? setup.config : undefined,
            onConnected: () => readVault(query),
            onTwoFactor: (pending) => {
              setTwoFactor({ pending: true, providers: pending.providers, provider: pending.provider, providerDescriptions: pending.providerDescriptions })
              setState({ status: 'two_factor' })
            },
            onSetup: () => setShowSetup(true),
          })
        }
        if (state.status === 'two_factor') {
          return h(TwoFactorForm, {
            t,
            invoke,
            pending: twoFactor ?? { pending: true },
            onDone: () => load(query),
            onRestart: backToSetup,
            onRefresh: refreshChallenge,
          })
        }
        // Guided setup instead of a dead end: fill the three fields and the
        // plugin connects (and asks for a two-factor code when required).
        // Chosen by configuration state — error codes do not cross the RPC.
        if (state.status === 'unconfigured' || state.report?.configured === false) {
          // The form is the way out of a fresh install, so it must not depend
          // on the config read having succeeded: a "尚未配置完成" wall with only
          // a 重试 button re-ran the same failing call forever, which is
          // exactly how a first install got stuck before it could be set up.
          // The form needs no payload to work — an empty config just means the
          // fields start blank, with the cause shown above them.
          if (setup.status === 'loading') {
            return h('div', { style: { ...S.detail, ...S.empty } }, h('span', { style: S.note }, t('syncLoading')))
          }
          return h(SetupForm, {
            t,
            invoke,
            initial: setup.status === 'ready' ? setup.config : undefined,
            notice: setup.status === 'error' ? t('setupConfigFailed') + '：' + setup.error : null,
            onDone: () => load(query),
          })
        }
        if (state.status === 'error') {
          // Always leave a way out: retry, or clear the session and sign in
          // again (a wrong password or an expired challenge must not be a dead end).
          const restart = async () => {
            try {
              await invoke('reset')
            } catch {
              /* still open the form so the user is not stuck */
            }
            forgetSnapshot()
            setShowSetup(true)
          }
          return h(
            'div',
            { style: S.detail },
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, t('loadFailed')),
            h('span', { style: S.error }, state.error),
            h('span', { style: S.note }, t('restartHint')),
            h(
              'div',
              { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', { type: 'button', style: S.button, onClick: () => load(query) }, t('retry')),
              h('button', { type: 'button', style: S.button, onClick: restart }, t('backToSetup')),
            ),
          )
        }
        // Two levels, one at a time: the list, or the opened entry. Keeping them
        // in separate views is what gives the detail the full width for long
        // values, and it removes the need to scroll a second column.
        if (!selectedId) return h('div', { style: S.panelBody }, list)
        return h(
          'div',
          { style: S.panelBody },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('button', { type: 'button', style: { ...S.button, padding: '0 12px' }, onClick: () => setSelectedId(null) }, `‹ ${t('backToList')}`),
          ),
          detailPane(),
        )
      }

      // The search toolbar only makes sense once there is a vault to search.
      const showToolbar = state.status === 'ready' && state.report?.configured !== false
      return h(
        'div',
        { className: 'vw-root', style: S.panel },
        h(
          'div',
          { style: S.titleRow },
          h('span', { style: S.titleText }, t('panelTitle')),
          // The compatibility note is secondary information, so it rides
          // along in small type rather than lengthening the title itself.
          h('span', { style: S.titleNote }, t('panelTitleNote')),
        ),
        showToolbar ? toolbar : null,
        h('div', { ref: scrollRef, style: S.scrollArea, 'data-scroll-area': '', onScroll: onListScroll }, body()),
      )
    }

    // ── plugin wiring ─────────────────────────────────────────────────────────

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-vaultwarden: dictionaries')
      const t = ctx.locale.bind(NS)
      const connection = ctx.get('connection')
      const invoke = makeInvoke(connection)

      // The entry browser as the plugin's own settings page. Configuration is
      // the host-derived form over the plugin's Config schema. The label
      // carries the vault glyph because the host's settings nav draws a
      // generic gear for every section id it does not know (see VaultNavLabel).
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: () => h(VaultNavLabel, { text: t('panelNav') }),
            inject: () => ({ t, invoke }),
          },
          (props) => h(VaultPanel, props),
        ),
      )
    }

    module.exports = { name: 'dsh-vaultwarden', inject: ['slots', 'locale', 'connection'], apply, VaultPanel, __resetOpenCache: resetOpenCache, __resetPagingRefusal: () => { pagingRefused = false } }
    return module.exports
  },
})
