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
    const { useCallback, useEffect, useRef, useState } = react

    const NS = 'bitwarden'
    const SECTION_ID = 'vaultwarden'
    const SECTION_ORDER = 30

    // ── dictionaries (zh first; en mirrors the same keys) ─────────────────────
    const DICT_ZH = {
      panelTitle: 'Bitwarden / Vaultwarden 凭据库',
      panelNav: '凭据库',
      search: '搜索条目',
      searchPlaceholder: '名称、用户名、网址…（“/” 聚焦，Esc 清空）',
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
      syncPolling: '轮询同步',
      syncOff: '未同步',
      syncLoading: '正在读取…',
      syncError: '同步状态不可用',
      // setup form
      setupTitle: '连接 Vaultwarden',
      setupHint: '填入服务器地址、登录邮箱与主密码即可开始同步；保存后立即生效。',
      setupServer: '服务器地址',
      setupServerPlaceholder: 'https://vault.example.com 或 http://192.168.1.10',
      setupEmail: '登录邮箱',
      setupMaster: '主密码',
      setupMasterPlaceholder: '已保存则留空表示不修改',
      setupSave: '保存并连接',
      setupSaving: '正在连接…',
      setupSaved: '已保存，正在同步…',
      setupFailed: '保存失败',
      twoFactorTitle: '需要两步验证码',
      twoFactorHint: '该账户启用了两步验证。请打开你的验证器（或邮箱/恢复码），填入验证码继续登录。',
      twoFactorCode: '验证码',
      twoFactorPlaceholder: '6 位动态码或恢复码',
      twoFactorSubmit: '提交验证码',
      twoFactorSubmitting: '正在验证…',
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
      panelTitle: 'Bitwarden / Vaultwarden vault',
      panelNav: 'Vault',
      search: 'Search entries',
      searchPlaceholder: 'Name, username, URL… (“/” focuses, Esc clears)',
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
      syncPolling: 'Polling',
      syncOff: 'Not syncing',
      syncLoading: 'Loading…',
      syncError: 'Sync status unavailable',
      setupTitle: 'Connect to Vaultwarden',
      setupHint: 'Enter the server URL, login email and master password to start syncing; saving applies immediately.',
      setupServer: 'Server URL',
      setupServerPlaceholder: 'https://vault.example.com or http://192.168.1.10',
      setupEmail: 'Login email',
      setupMaster: 'Master password',
      setupMasterPlaceholder: 'Leave empty to keep the saved value',
      setupSave: 'Save and connect',
      setupSaving: 'Connecting…',
      setupSaved: 'Saved, syncing…',
      setupFailed: 'Save failed',
      twoFactorTitle: 'Two-factor code required',
      twoFactorHint: 'This account uses two-factor authentication. Enter the code from your authenticator (or a recovery code) to finish signing in.',
      twoFactorCode: 'Code',
      twoFactorPlaceholder: '6-digit code or recovery code',
      twoFactorSubmit: 'Submit code',
      twoFactorSubmitting: 'Verifying…',
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

    // ── shared style fragments: one spacing scale (4/8/12/16/24), 30px inputs,
    //    6px radii, 13px body / 12px secondary ─────────────────────────────────
    const S = {
      panel: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 24px', color: TOKEN.text },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      panelBody: { display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 12, alignItems: 'start' },
      list: { border: `1px solid ${TOKEN.border}`, borderRadius: 8, background: TOKEN.bg, overflow: 'hidden' },
      listRow: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', border: 0, background: 'transparent', color: TOKEN.text, cursor: 'pointer', textAlign: 'left', fontSize: 13 },
      listRowActive: { background: TOKEN.bg2 },
      listName: { fontSize: 13, color: TOKEN.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      listMeta: { fontSize: 11.5, color: TOKEN.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      avatar: { width: 26, height: 26, borderRadius: '50%', background: TOKEN.bg2, border: `1px solid ${TOKEN.border}`, color: TOKEN.text, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 },
      detail: { border: `1px solid ${TOKEN.border}`, borderRadius: 8, background: TOKEN.bg, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 220 },
      fieldRow: { display: 'grid', gridTemplateColumns: '88px 1fr auto', gap: 10, alignItems: 'center', fontSize: 13 },
      fieldLabel: { fontSize: 12, color: TOKEN.text2 },
      fieldValue: { fontSize: 13, color: TOKEN.text, wordBreak: 'break-all' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5 },
      progressTrack: { height: 4, borderRadius: 999, background: TOKEN.bg2, overflow: 'hidden', width: 120 },
      progressFill: { height: '100%', background: TOKEN.accent },
      empty: { padding: '24px 12px', textAlign: 'center', color: TOKEN.text2, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' },
      note: { fontSize: 12, color: TOKEN.text2, lineHeight: 1.6 },
      button: { height: 30, padding: '0 14px', borderRadius: 6, border: `1px solid ${TOKEN.borderStrong}`, background: 'transparent', color: TOKEN.text, cursor: 'pointer', fontSize: 13 },
      buttonPrimary: { height: 30, padding: '0 16px', borderRadius: 6, border: '1px solid transparent', background: TOKEN.accent, color: TOKEN.onAccent, cursor: 'pointer', fontSize: 13 },
      ok: { fontSize: 12, color: TOKEN.ok },
      error: { fontSize: 12, color: TOKEN.err },
      dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: TOKEN.text, border: `1px solid ${TOKEN.border}`, borderRadius: 999, padding: '3px 10px' },
      badge: { fontSize: 11, color: TOKEN.text2, border: `1px solid ${TOKEN.border}`, borderRadius: 999, padding: '1px 8px' },
      input: {
        boxSizing: 'border-box',
        height: 30,
        padding: '0 9px',
        borderRadius: 6,
        border: `1px solid ${TOKEN.borderStrong}`,
        background: TOKEN.bg,
        color: TOKEN.text,
        fontSize: 13,
        outline: 'none',
      },
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

    /** Sync-status chip: mode dot + relative last-sync time. */
    function SyncChip({ report, t }) {
      const live = report?.liveSync ?? {}
      const mode = live.mode ?? 'off'
      const tone = mode === 'websocket' ? (live.connected ? 'ok' : 'warn') : mode === 'polling' ? 'warn' : 'idle'
      const label = mode === 'websocket' ? t('syncWebsocket') : mode === 'polling' ? t('syncPolling') : t('syncOff')
      return h(
        'span',
        { style: { ...S.chip, borderColor: TOKEN[tone] }, 'aria-live': 'polite' },
        h('span', { style: { ...S.dot, background: TOKEN[tone] } }),
        label,
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
    function SetupForm({ t, invoke, initial, onDone, onCancel }) {
      const [form, setForm] = useState({ serverUrl: initial?.serverUrl ?? '', email: initial?.email ?? '', masterPassword: '' })
      const [state, setState] = useState({ status: 'idle' })

      const save = async () => {
        setState({ status: 'saving' })
        try {
          await invoke('configure', {
            serverUrl: form.serverUrl.trim(),
            email: form.email.trim(),
            ...(form.masterPassword ? { masterPassword: form.masterPassword } : {}),
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
          { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 }, key },
          h('span', { style: { color: TOKEN.text } }, label),
          h('input', {
            style: S.input,
            type,
            value: form[key],
            placeholder,
            autoComplete: type === 'password' ? 'new-password' : 'off',
            onChange: (event) => setForm((previous) => ({ ...previous, [key]: event.target.value })),
          }),
          hint ? h('span', { style: { fontSize: 11.5, color: TOKEN.text2 } }, hint) : null,
        )

      const busy = state.status === 'saving'
      const ready = form.serverUrl.trim() !== '' && form.email.trim() !== ''

      return h(
        'div',
        { style: { ...S.detail, maxWidth: 520 } },
        h('span', { style: { fontSize: 14, fontWeight: 600 } }, t('setupTitle')),
        h('span', { style: S.note }, t('setupHint')),
        field('serverUrl', t('setupServer'), t('setupServerPlaceholder')),
        field('email', t('setupEmail'), 'you@example.com'),
        field('masterPassword', t('setupMaster'), t('setupMasterPlaceholder'), 'password'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' } },
          h(
            'button',
            { type: 'button', style: busy ? { ...S.buttonPrimary, opacity: 0.7 } : S.buttonPrimary, disabled: busy || !ready, onClick: save },
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
     * Two-factor step: the account answered the password grant with
     * `two_factor_required`; the code finishes that same login attempt.
     *
     * The continuation `token` travels with the form: saving the setup form
     * restarts the host plugin and clears its memory, so a token kept only on
     * the Host would be gone by the time the user types the code.
     *
     * Escape hatches: a challenge can expire (Bitwarden's token is short-lived)
     * or belong to the wrong account. Without them the panel is a dead end —
     * the user can neither retry nor get back to the setup form.
     */
    function TwoFactorForm({ t, invoke, pending, onDone, onRestart }) {
      const [code, setCode] = useState('')
      const [provider, setProvider] = useState(pending?.provider ?? 0)
      const [remember, setRemember] = useState('yes')
      const [state, setState] = useState({ status: 'idle' })

      const submit = async () => {
        setState({ status: 'submitting' })
        try {
          // 记住此设备 is the server's "remember this device" flag; the stricter
          // choices send false. The plugin stores nothing in the browser either
          // way — no cookie, no localStorage, only React state for this view.
          await invoke('submitTwoFactor', {
            code: code.trim(),
            provider,
            remember: remember === 'yes',
            token: pending?.token ?? undefined,
          })
          setState({ status: 'ok' })
          onDone?.()
        } catch (failure) {
          const message = failure?.message ?? String(failure)
          setState({ status: 'failed', error: message })
          // An expired or already-consumed challenge cannot be recovered by
          // retyping a code: drop the half-finished session and go back to the
          // setup form instead of leaving the user on a dead screen.
          if (/失效|过期|expired|重新登录|two_factor_expired|re-?login/i.test(message)) {
            try {
              await invoke('reset')
            } catch {
              /* the fallback must happen even if the reset call fails */
            }
            onRestart?.()
          }
        }
      }

      /**
       * Go back to the setup form: clear the half-finished session (and any
       * stale challenge) and let the user re-enter the address, account and
       * password. Deliberately NOT a re-login — retrying with the same stored
       * credentials would just land on this same screen again.
       */
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
        h('span', { style: { fontSize: 14, fontWeight: 600 } }, t('twoFactorTitle')),
        h('span', { style: S.note }, t('twoFactorHint')),
        providers.length > 1
          ? h(
              'label',
              { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 } },
              h('span', null, t('twoFactorProviders').replace('{n}', String(providers.length))),
              h(
                'select',
                { style: S.input, value: String(provider), onChange: (event) => setProvider(Number(event.target.value)) },
                providers.map((id) => h('option', { key: id, value: String(id) }, providerLabel(id))),
              ),
            )
          : null,
        h(
          'label',
          { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 } },
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
          { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 } },
          h('span', null, t('twoFactorRemember')),
          h(
            'select',
            { style: S.input, value: remember, onChange: (event) => setRemember(event.target.value) },
            h('option', { value: 'yes' }, t('twoFactorRememberYes')),
            h('option', { value: 'once' }, t('twoFactorRememberOnce')),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' } },
          h(
            'button',
            { type: 'button', style: busy ? { ...S.buttonPrimary, opacity: 0.7 } : S.buttonPrimary, disabled: busy || !code.trim(), onClick: submit },
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
      const searchRef = useRef(null)

      const load = useCallback(
        async (nextQuery) => {
          setState((previous) => ({ ...previous, status: 'loading' }))
          // Read the configuration first: the setup form is chosen by what is
          // configured, not by an error code — business error codes do not
          // survive the RPC boundary (only a message does).
          let config = null
          try {
            config = await invoke('config')
            setSetup({ status: 'ready', config })
          } catch (failure) {
            setSetup({ status: 'error', error: failure?.message ?? String(failure) })
          }
          const configured = Boolean(config?.serverUrl && config?.email && (config?.hasMasterPassword || config?.hasApiKey))
          if (!configured) {
            setState({ status: 'unconfigured' })
            return
          }
          try {
            const list = await invoke('list', { query: nextQuery ?? '', limit: 200 })
            const report = await invoke('status')
            setState({ status: 'ready', list, report })
          } catch (failure) {
            // A login that needs a two-factor code surfaces as a pending state
            // instead of a dead end; every other failure keeps its message.
            const message = String(failure?.message ?? failure)
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
            setState({ status: 'error', error: message, code: failure?.code })
          }
        },
        [invoke],
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

      const items = state.status === 'ready' ? state.list.items ?? [] : []
      const move = (delta) => {
        if (!items.length) return
        const index = items.findIndex((item) => item.id === selectedId)
        const next = index < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, index + delta))
        setSelectedId(items[next].id)
      }

      const toolbar = h(
        'div',
        { style: S.toolbar },
        h('input', {
          ref: searchRef,
          style: { ...S.input, maxWidth: 320, width: '100%' },
          type: 'search',
          value: query,
          placeholder: t('searchPlaceholder'),
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
        state.status === 'ready' ? h(SyncChip, { report: state.report, t }) : null,
        h('span', { style: S.note }, state.status === 'ready' ? t('itemsCount').replace('{n}', String(state.list.vaultItems ?? items.length)) : ''),
        h('button', { type: 'button', style: { ...S.button, marginLeft: 'auto' }, onClick: () => setShowSetup(true) }, t('openSetup')),
        h('button', { type: 'button', style: S.button, onClick: () => load(query) }, t('refresh')),
      )

      const list = h(
        'div',
        { style: S.list, role: 'listbox', 'aria-label': t('panelTitle') },
        state.status === 'ready' && items.length === 0
          ? h('div', { style: S.empty }, h('span', null, t('listEmpty')), h('span', { style: S.note }, t('listHint')))
          : items.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  role: 'option',
                  'aria-selected': item.id === selectedId ? 'true' : 'false',
                  style: item.id === selectedId ? { ...S.listRow, ...S.listRowActive } : S.listRow,
                  onClick: () => setSelectedId(item.id),
                },
                h('span', { style: S.avatar }, (item.name ?? '?').slice(0, 1).toUpperCase()),
                h(
                  'span',
                  { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                  h('span', { style: S.listName }, item.name || '(未命名)'),
                  h('span', { style: S.listMeta }, [item.username, item.uris?.[0]].filter(Boolean).join(' · ')),
                ),
                item.favorite ? h('span', { style: { ...S.listMeta, color: TOKEN.warn }, title: t('favorite') }, '★') : null,
                item.hasTotp ? h('span', { style: S.badge }, 'TOTP') : null,
              ),
            ),
      )

      const detailPane = () => {
        if (!selectedId) return h('div', { style: { ...S.detail, ...S.empty } }, h('span', null, t('selectPrompt')))
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
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, value.name),
            h('span', { style: S.note }, t('repromptLocked')),
            h('span', { style: S.note }, t('repromptHint')),
            h('button', { type: 'button', style: S.buttonPrimary, onClick: confirmReveal }, t('confirmRead')),
          )
        }
        const row = (label, content, copyValue) =>
          h(
            'div',
            { style: S.fieldRow, key: label },
            h('span', { style: S.fieldLabel }, label),
            h('span', { style: S.fieldValue }, content ?? '—'),
            copyValue ? h(CopyButton, { value: copyValue, t }) : null,
          )
        return h(
          'div',
          { style: S.detail },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' } },
            h('span', { style: { fontSize: 14, fontWeight: 600 } }, value.name),
            h('span', { style: S.badge }, value.type ?? ''),
          ),
          row(t('username'), value.username, value.username),
          row(t('password'), revealed ? h('span', { style: S.mono }, value.password ?? '') : '●●●●●●●●', value.password),
          h(
            'div',
            { style: S.fieldRow },
            h('span', { style: S.fieldLabel }, t('password')),
            h('span', null),
            h('button', { type: 'button', style: S.button, onClick: () => setRevealed((previous) => !previous) }, revealed ? t('hide') : t('show')),
          ),
          h('div', { style: S.fieldRow }, h('span', { style: S.fieldLabel }, t('totp')), value.totpSecret ? h(TotpValue, { id: value.id, invoke, t }) : h('span', { style: S.listMeta }, '—'), null),
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
                    { style: S.fieldRow, key: `field-${index}` },
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
        if (state.status === 'two_factor') {
          return h(TwoFactorForm, {
            t,
            invoke,
            pending: twoFactor ?? { pending: true },
            onDone: () => load(query),
            onRestart: backToSetup,
          })
        }
        // Guided setup instead of a dead end: fill the three fields and the
        // plugin connects (and asks for a two-factor code when required).
        // Chosen by configuration state — error codes do not cross the RPC.
        if (state.status === 'unconfigured' || state.report?.configured === false) {
          if (setup.status === 'ready') {
            return h(SetupForm, { t, invoke, initial: setup.config, onDone: () => load(query) })
          }
          return h(
            'div',
            { style: { ...S.detail, ...S.empty } },
            h('span', null, t('notConfigured')),
            h('span', { style: S.note }, setup.status === 'error' ? setup.error : t('notConfiguredHint')),
            h('button', { type: 'button', style: S.button, onClick: () => load(query) }, t('retry')),
          )
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
        return h('div', { style: S.panelBody }, list, detailPane())
      }

      // The search toolbar only makes sense once there is a vault to search.
      const showToolbar = state.status === 'ready' && state.report?.configured !== false
      return h('div', { style: S.panel }, h('span', { style: { fontSize: 15, fontWeight: 600 } }, t('panelTitle')), showToolbar ? toolbar : null, body())
    }

    // ── plugin wiring ─────────────────────────────────────────────────────────

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-vaultwarden: dictionaries')
      const t = ctx.locale.bind(NS)
      const connection = ctx.get('connection')
      const invoke = makeInvoke(connection)

      // The entry browser as the plugin's own settings page. Configuration is
      // the host-derived form over the plugin's Config schema.
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: () => t('panelNav'),
            inject: () => ({ t, invoke }),
          },
          (props) => h(VaultPanel, props),
        ),
      )
    }

    module.exports = { name: 'dsh-vaultwarden', inject: ['slots', 'locale', 'connection'], apply, VaultPanel }
    return module.exports
  },
})
