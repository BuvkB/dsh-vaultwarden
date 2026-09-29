/**
 * Browser half of dsh-vaultwarden.
 *
 * Two surfaces, both rendered in slots the host already allocates:
 *
 *  1. The `bitwarden` settings card (设置 → 插件 → 插件配置): server, account,
 *     secrets, and the live-sync controls, grouped into 连接 / 认证 / 同步 with
 *     a sync-status row underneath. Secret fields are write-only: the saved
 *     value never comes back to the browser.
 *
 *  2. The entry browser (设置 → Vaultwarden, a `settings.section` page): a
 *     searchable list of the synced vault with a detail pane, copy buttons,
 *     a live TOTP countdown, and Bitwarden's reprompt gate. It reads the
 *     same-origin HTTP API the host serves at `/dsh-vaultwarden/api`
 *     (see lib/api.js) — no credentials travel further than that route,
 *     which answers loopback peers only.
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
    const API = '/dsh-vaultwarden/api'
    const SECTION_ID = 'vaultwarden'
    const SECTION_ORDER = 30

    // ── dictionaries (zh first; en mirrors the same keys) ─────────────────────
    const DICT_ZH = {
      title: 'Bitwarden / Vaultwarden 凭据库',
      description: '任何新会话都会自动知道可以从凭据库读取密码；这里填一次即可。',
      sectionConnect: '连接',
      sectionAuth: '认证',
      sectionSync: '同步',
      serverUrl: '服务器地址',
      email: '登录邮箱',
      masterPassword: '主密码',
      apiKeyClientId: 'API 密钥 client_id（可选）',
      apiKeyClientSecret: 'API 密钥 client_secret（可选）',
      websocket: 'WebSocket 实时通知',
      cacheMinutes: '缓存时长（分钟）',
      pollIntervalSeconds: '轮询间隔（秒）',
      deviceIdentifier: '设备标识',
      websocketHint: '关闭后始终按轮询间隔同步；开启时服务器有变更即推送（Vaultwarden ≥ 1.29 默认支持）',
      secretPlaceholder: '留空表示不修改（已保存的值不回显）',
      save: '保存',
      reset: '清除本机覆盖',
      saved: '已保存',
      saving: '保存中…',
      failed: '保存失败',
      statusLoading: '正在读取配置…',
      statusUnavailable: '此页面无法读写主机配置（远程浏览器或未连接）。',
      statusReadonly: '主机配置为只读。',
      overridden: '已在设置中覆盖',
      hint: '保存后立即生效，无需重启。主密码只存在本机 settings.yaml，且不会回传到浏览器。',
      syncTitle: '同步状态',
      syncWebsocket: '实时同步',
      syncPolling: '轮询同步',
      syncOff: '未同步',
      syncLoading: '正在读取同步状态…',
      syncError: '同步状态不可用',
      syncItems: '条目',
      timeJustNow: '刚刚',
      timeMinutes: '{n} 分钟前',
      timeHours: '{n} 小时前',
      timeDays: '{n} 天前',
      // panel
      panelTitle: 'Bitwarden / Vaultwarden 凭据库',
      panelNav: '凭据库',
      search: '搜索条目',
      searchPlaceholder: '名称、用户名、网址…（“/” 聚焦，Esc 清空）',
      refresh: '刷新',
      listEmpty: '没有匹配的条目',
      listHint: '换个关键词，或确认条目存在于该账户',
      notConfigured: '尚未配置完成',
      notConfiguredHint: '请先在上方「Bitwarden / Vaultwarden 凭据库」卡片里补全 serverUrl、邮箱与主密码。',
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
    }
    const DICT_EN = {
      title: 'Bitwarden / Vaultwarden vault',
      description: 'Every new session knows it may read credentials from the vault; configure it once here.',
      sectionConnect: 'Connection',
      sectionAuth: 'Authentication',
      sectionSync: 'Live sync',
      serverUrl: 'Server URL',
      email: 'Login email',
      masterPassword: 'Master password',
      apiKeyClientId: 'API key client_id (optional)',
      apiKeyClientSecret: 'API key client_secret (optional)',
      websocket: 'WebSocket notifications',
      cacheMinutes: 'Cache (minutes)',
      pollIntervalSeconds: 'Poll interval (seconds)',
      deviceIdentifier: 'Device identifier',
      websocketHint: 'When off, the vault is polled at the interval below; when on, the server pushes changes (Vaultwarden ≥ 1.29 by default).',
      secretPlaceholder: 'Leave empty to keep the saved value',
      save: 'Save',
      reset: 'Clear local overrides',
      saved: 'Saved',
      saving: 'Saving…',
      failed: 'Save failed',
      statusLoading: 'Loading configuration…',
      statusUnavailable: 'This page cannot read or write host settings (remote browser or offline).',
      statusReadonly: 'Host settings are read-only.',
      overridden: 'Overridden in settings',
      hint: 'Applies immediately, no restart needed. The master password stays in this machine’s settings.yaml and is never sent back to the browser.',
      syncTitle: 'Sync status',
      syncWebsocket: 'Live sync',
      syncPolling: 'Polling',
      syncOff: 'Not syncing',
      syncLoading: 'Loading sync status…',
      syncError: 'Sync status unavailable',
      syncItems: 'entries',
      timeJustNow: 'just now',
      timeMinutes: '{n} min ago',
      timeHours: '{n} h ago',
      timeDays: '{n} d ago',
      panelTitle: 'Bitwarden / Vaultwarden vault',
      panelNav: 'Vault',
      search: 'Search entries',
      searchPlaceholder: 'Name, username, URL… (“/” focuses, Esc clears)',
      refresh: 'Refresh',
      listEmpty: 'No matching entries',
      listHint: 'Try another keyword, or confirm the entry exists in this account',
      notConfigured: 'Not configured yet',
      notConfiguredHint: 'Fill in serverUrl, email and the master password in the card above first.',
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
    }

    // ── theme tokens (the only color source; fallbacks keep the page readable
    //    outside the harness) ──────────────────────────────────────────────────
    // `--vw-*` are plugin-local semantic aliases over the host theme, in the
    // shape dsh-vault uses (`--v-text: var(--dsw-alias-label-primary, …)`):
    // the alias follows the host, the literal is only the fallback.
    const TOKEN = {
      text: 'var(--vw-text, var(--dsw-alias-label-primary, #1f2328))',
      text2: 'var(--vw-text-2, var(--dsw-alias-label-secondary, #57606a))',
      border: 'var(--vw-border, var(--dsw-alias-border-l1, #d9d9d9))',
      borderStrong: 'var(--vw-border-strong, var(--dsw-alias-border-l2, #afb1b3))',
      bg: 'var(--vw-bg, var(--dsw-alias-bg-layer-1, #ffffff))',
      bg2: 'var(--vw-bg-2, var(--dsw-alias-bg-layer-2, #f5f5f5))',
      accent: 'var(--vw-accent, var(--dsw-alias-brand-primary, #4c6ef5))',
      onAccent: 'var(--vw-on-accent, #ffffff)',
      switchKnob: 'var(--vw-switch-knob, #ffffff)',
      ok: 'var(--vw-ok, var(--dsw-alias-state-success-primary, #2f9e44))',
      warn: 'var(--vw-warn, var(--dsw-alias-state-warn-primary, #b8830f))',
      err: 'var(--vw-err, var(--dsw-alias-state-error-primary, #c0392b))',
      idle: 'var(--vw-idle, var(--dsw-alias-state-idle-primary, #8b949e))',
    }

    // ── shared style fragments: one spacing scale (4/8/12/16/24), 30px inputs,
    //    6px radii, 13px body / 12px secondary ─────────────────────────────────
    const S = {
      card: { border: `1px solid ${TOKEN.border}`, borderRadius: 10, padding: '16px 20px', margin: '10px 0', background: TOKEN.bg, color: TOKEN.text },
      head: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      title: { fontSize: 15, fontWeight: 600, color: TOKEN.text },
      badge: { fontSize: 11, color: TOKEN.text2, border: `1px solid ${TOKEN.border}`, borderRadius: 999, padding: '1px 8px' },
      desc: { color: TOKEN.text2, fontSize: 12, marginTop: 4, lineHeight: 1.6 },
      sectionTitle: { fontSize: 12, fontWeight: 600, color: TOKEN.text2, letterSpacing: 0.2, margin: '16px 0 4px' },
      divider: { border: 0, borderTop: `1px solid ${TOKEN.border}`, margin: '4px 0 8px' },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(200px, 240px) 1fr', gap: '10px 14px', alignItems: 'center' },
      label: { fontSize: 12.5, color: TOKEN.text, display: 'flex', flexDirection: 'column', gap: 2 },
      code: { color: TOKEN.text2, fontSize: 11 },
      input: {
        width: '100%',
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
      switch: {
        position: 'relative',
        width: 36,
        height: 20,
        borderRadius: 999,
        border: `1px solid ${TOKEN.borderStrong}`,
        padding: 0,
        cursor: 'pointer',
        flexShrink: 0,
      },
      switchKnob: {
        position: 'absolute',
        top: 2,
        left: 2,
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: TOKEN.switchKnob,
        transition: 'transform 120ms ease',
        boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
      },
      note: { fontSize: 12, color: TOKEN.text2, lineHeight: 1.6 },
      row: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' },
      button: { height: 30, padding: '0 14px', borderRadius: 6, border: `1px solid ${TOKEN.borderStrong}`, background: 'transparent', color: TOKEN.text, cursor: 'pointer', fontSize: 13 },
      buttonPrimary: { height: 30, padding: '0 16px', borderRadius: 6, border: '1px solid transparent', background: TOKEN.accent, color: TOKEN.onAccent, cursor: 'pointer', fontSize: 13 },
      buttonDisabled: { opacity: 0.55, cursor: 'not-allowed' },
      ok: { fontSize: 12, color: TOKEN.ok },
      error: { fontSize: 12, color: TOKEN.err },
      dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: TOKEN.text, border: `1px solid ${TOKEN.border}`, borderRadius: 999, padding: '3px 10px' },
      // panel
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
    }

    // ── same-origin API helper (see lib/api.js on the host) ────────────────────
    const api = async (path, options = {}) => {
      const init = { method: options.method ?? 'GET', headers: { accept: 'application/json' } }
      if (options.body !== undefined) {
        init.method = options.method ?? 'POST'
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      const response = await fetch(API + path, init)
      const json = await response.json().catch(() => null)
      if (!response.ok || (json && json.error)) {
        const error = new Error(json?.error ?? `HTTP ${response.status}`)
        error.code = json?.code ?? 'http_error'
        error.hint = json?.hint
        throw error
      }
      return json ?? {}
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

    /** A switch in the host's shape: role="switch" + aria-checked. */
    function SwitchControl({ checked, onChange, disabled, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          disabled,
          onClick: () => onChange(!checked),
          style: {
            ...S.switch,
            background: checked ? TOKEN.accent : TOKEN.bg2,
            borderColor: checked ? TOKEN.accent : TOKEN.borderStrong,
          },
        },
        h('span', { style: { ...S.switchKnob, transform: checked ? 'translateX(16px)' : 'translateX(0)' } }),
      )
    }

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

    /** Live TOTP code with a countdown bar (one request per second). */
    function TotpValue({ id, t }) {
      const [state, setState] = useState({ status: 'loading' })
      useEffect(() => {
        let alive = true
        const tick = () =>
          api('/totp', { body: { id } })
            .then((value) => alive && setState({ status: 'ready', value }))
            .catch(() => alive && setState({ status: 'error' }))
        tick()
        const timer = setInterval(tick, 1000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [id])
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

    // ── settings card ─────────────────────────────────────────────────────────

    const FIELDS = [
      { key: 'serverUrl', label: 'serverUrl', type: 'text' },
      { key: 'email', label: 'email', type: 'text' },
      { key: 'masterPassword', label: 'masterPassword', type: 'password', secret: true },
      { key: 'apiKeyClientId', label: 'apiKeyClientId', type: 'text' },
      { key: 'apiKeyClientSecret', label: 'apiKeyClientSecret', type: 'password', secret: true },
      { key: 'websocket', label: 'websocket', type: 'switch' },
      { key: 'cacheMinutes', label: 'cacheMinutes', type: 'number' },
      { key: 'pollIntervalSeconds', label: 'pollIntervalSeconds', type: 'number' },
      { key: 'deviceIdentifier', label: 'deviceIdentifier', type: 'text' },
    ]
    const FIELD_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]))
    const SECTIONS = [
      { title: 'sectionConnect', fields: ['serverUrl', 'email'] },
      { title: 'sectionAuth', fields: ['masterPassword', 'apiKeyClientId', 'apiKeyClientSecret'] },
      { title: 'sectionSync', fields: ['websocket', 'cacheMinutes', 'pollIntervalSeconds', 'deviceIdentifier'] },
    ]

    function BitwardenCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => DICT_ZH[key] ?? key
      const scope = props.bitwardenScope
      const [snapshot, setSnapshot] = useState(() => (scope ? scope.getSnapshot() : undefined))
      const [draft, setDraft] = useState({})
      const [state, setState] = useState('idle')
      const [error, setError] = useState('')
      const [sync, setSync] = useState({ status: 'loading' })

      useEffect(() => {
        if (!scope) return undefined
        setSnapshot(scope.getSnapshot())
        return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
      }, [scope])

      useEffect(() => {
        let alive = true
        api('/status')
          .then((report) => alive && setSync({ status: 'ready', report }))
          .catch((failure) => alive && setSync({ status: 'error', error: failure?.message ?? String(failure) }))
        return () => {
          alive = false
        }
      }, [])

      const status = snapshot ? snapshot.status : 'loading'
      const writable = Boolean(snapshot && snapshot.writable && status === 'ready')
      const currentValue = (key) => {
        if (key in draft) return draft[key]
        const value = snapshotValue(snapshot, key)
        return value === undefined || value === null ? '' : value
      }
      const dirtyFields = FIELDS.filter((field) => {
        if (!(field.key in draft)) return false
        const draftValue = draft[field.key]
        const saved = snapshotValue(snapshot, field.key)
        if (field.secret && String(draftValue ?? '').length === 0) return false
        if (field.type === 'switch') return Boolean(saved) !== Boolean(draftValue)
        return String(saved ?? '') !== String(draftValue ?? '')
      })

      const save = async () => {
        if (!scope || dirtyFields.length === 0) return
        setState('saving')
        setError('')
        try {
          for (const field of dirtyFields) {
            const raw = draft[field.key]
            const value = field.type === 'number' ? Number(raw) : field.type === 'switch' ? Boolean(raw) : String(raw)
            await scope.set(field.key, value)
          }
          setDraft({})
          setState('saved')
        } catch (failure) {
          setState('failed')
          setError(String((failure && failure.message) || failure))
        }
      }

      const reset = async () => {
        if (!scope) return
        setState('saving')
        setError('')
        try {
          for (const field of FIELDS) {
            if (isOverridden(snapshot, field.key)) await scope.unset(field.key)
          }
          setDraft({})
          setState('saved')
        } catch (failure) {
          setState('failed')
          setError(String((failure && failure.message) || failure))
        }
      }

      const statusLine = () => {
        if (status === 'loading') return h('span', { style: S.note }, t('statusLoading'))
        if (status === 'unavailable') return h('span', { style: S.note }, t('statusUnavailable'))
        if (!writable) return h('span', { style: S.note }, t('statusReadonly'))
        if (state === 'saving') return h('span', { style: S.note }, t('saving'))
        if (state === 'saved') return h('span', { style: S.ok }, t('saved'))
        if (state === 'failed') return h('span', { style: S.error }, `${t('failed')}: ${error}`)
        return h('span', { style: S.note }, t('hint'))
      }

      const renderField = (field) => {
        const disabled = !writable && status !== 'loading'
        if (field.type === 'switch') {
          return h(SwitchControl, {
            key: `${field.key}-switch`,
            checked: Boolean(currentValue(field.key)),
            disabled,
            label: t(field.key),
            onChange: (next) => setDraft((previous) => ({ ...previous, [field.key]: next })),
          })
        }
        return h('input', {
          key: `${field.key}-input`,
          style: S.input,
          type: field.type === 'number' ? 'number' : field.type,
          value: String(currentValue(field.key) ?? ''),
          disabled,
          placeholder: field.secret ? t('secretPlaceholder') : '',
          autoComplete: field.secret ? 'new-password' : 'off',
          onChange: (event) => setDraft((previous) => ({ ...previous, [field.key]: event.target.value })),
        })
      }

      const fieldNodes = SECTIONS.flatMap((section) => [
        h('div', { key: `title-${section.title}`, style: { ...S.sectionTitle, gridColumn: '1 / -1' } }, t(section.title)),
        h('hr', { key: `rule-${section.title}`, style: { ...S.divider, gridColumn: '1 / -1' } }),
        ...section.fields.map((key) => {
          const field = FIELD_BY_KEY.get(key)
          return [
            h(
              'label',
              { key: `${field.key}-label`, style: S.label },
              h('span', null, t(field.key), ' ', h('span', { style: S.code }, field.label)),
              isOverridden(snapshot, field.key) ? h('span', { style: S.code }, t('overridden')) : null,
            ),
            renderField(field),
          ]
        }),
      ])

      return h(
        'section',
        { style: S.card, 'data-dsh-plugin': NS },
        h('div', { style: S.head }, h('span', { style: S.title }, t('title')), h('span', { style: S.badge }, NS)),
        h('div', { style: S.desc }, t('description')),
        h('div', { style: { ...S.grid, marginTop: 12 } }, fieldNodes),
        h('div', { style: { ...S.sectionTitle, gridColumn: '1 / -1' } }, t('websocketHint')),
        h('div', { style: { ...S.row, marginTop: 4 } }, h('span', { style: S.note }, t('syncTitle')), sync.status === 'ready' ? h(SyncChip, { report: sync.report, t }) : h('span', { style: S.note }, sync.status === 'loading' ? t('syncLoading') : t('syncError'))),
        h(
          'div',
          { style: S.row },
          h('button', { type: 'button', style: { ...S.buttonPrimary, ...(disabledSave() ? S.buttonDisabled : {}) }, disabled: disabledSave(), onClick: save }, t('save')),
          h('button', { type: 'button', style: { ...S.button, ...(!writable || state === 'saving' ? S.buttonDisabled : {}) }, disabled: !writable || state === 'saving', onClick: reset }, t('reset')),
          statusLine(),
        ),
      )

      function disabledSave() {
        return !writable || dirtyFields.length === 0 || state === 'saving'
      }
    }

    // ── entry browser (settings.section page) ─────────────────────────────────

    function VaultPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => DICT_ZH[key] ?? key
      const [state, setState] = useState({ status: 'loading' })
      const [query, setQuery] = useState('')
      const [selectedId, setSelectedId] = useState(null)
      const [detail, setDetail] = useState({ status: 'idle' })
      const [revealed, setRevealed] = useState(false)
      const searchRef = useRef(null)

      const load = useCallback(async (nextQuery) => {
        setState((previous) => ({ ...previous, status: 'loading' }))
        try {
          const list = await api(`/list?query=${encodeURIComponent(nextQuery ?? '')}&limit=200`)
          const report = await api('/status')
          setState({ status: 'ready', list, report })
        } catch (failure) {
          setState({ status: 'error', error: failure?.message ?? String(failure), hint: failure?.hint })
        }
      }, [])

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
        api('/reveal', { body: { id: selectedId } })
          .then((value) => alive && setDetail({ status: 'ready', value }))
          .catch((failure) => alive && setDetail({ status: 'error', error: failure?.message, hint: failure?.hint }))
        return () => {
          alive = false
        }
      }, [selectedId])

      const confirmReveal = async () => {
        setDetail({ status: 'loading' })
        try {
          const value = await api('/reveal', { body: { id: selectedId, confirm: true } })
          setDetail({ status: 'ready', value })
          setRevealed(true)
        } catch (failure) {
          setDetail({ status: 'error', error: failure?.message, hint: failure?.hint })
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
          style: { ...S.input, maxWidth: 320 },
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
        h('button', { type: 'button', style: { ...S.button, marginLeft: 'auto' }, onClick: () => load(query) }, t('refresh')),
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
          return h('div', { style: S.detail }, h('span', { style: S.error }, detail.error), detail.hint ? h('span', { style: S.note }, detail.hint) : null, h('button', { type: 'button', style: S.button, onClick: () => setSelectedId(null) }, t('retry')))
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
          h('div', { style: { ...S.head, justifyContent: 'space-between' } }, h('span', { style: { fontSize: 14, fontWeight: 600 } }, value.name), h('span', { style: S.badge }, value.type ?? '')),
          row(t('username'), value.username, value.username),
          row(t('password'), revealed ? h('span', { style: S.mono }, value.password ?? '') : '●●●●●●●●', value.password),
          h(
            'div',
            { style: S.fieldRow },
            h('span', { style: S.fieldLabel }, t('password')),
            h('span', null),
            h('button', { type: 'button', style: S.button, onClick: () => setRevealed((previous) => !previous) }, revealed ? t('hide') : t('show')),
          ),
          h('div', { style: S.fieldRow }, h('span', { style: S.fieldLabel }, t('totp')), value.totpSecret ? h(TotpValue, { id: value.id, t }) : h('span', { style: S.listMeta }, '—'), null),
          row(t('uris'), (value.uris ?? []).join(', ')),
          row(t('folder'), [value.folder, (value.collections ?? []).join(', ')].filter(Boolean).join(' · ')),
          row(t('notes'), value.notes ? h('span', { style: { whiteSpace: 'pre-wrap' } }, value.notes) : null, value.notes),
          (value.fields ?? []).length
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
                h('span', { style: S.sectionTitle }, t('customFields')),
                ...(value.fields ?? []).map((field, index) =>
                  h('div', { style: S.fieldRow, key: `field-${index}` }, h('span', { style: S.fieldLabel }, field.name), h('span', { style: S.fieldValue }, field.value), h(CopyButton, { value: field.value, t })),
                ),
              )
            : null,
        )
      }

      const body = () => {
        if (state.status === 'loading') return h('div', { style: { ...S.detail, ...S.empty } }, h('span', { style: S.note }, t('syncLoading')))
        if (state.status === 'error') {
          return h(
            'div',
            { style: S.detail },
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, t('loadFailed')),
            h('span', { style: S.error }, state.error),
            state.hint ? h('span', { style: S.note }, state.hint) : null,
            state.report?.configured === false || state.error?.code === 'not_configured'
              ? h('span', { style: S.note }, t('notConfiguredHint'))
              : null,
            h('button', { type: 'button', style: S.button, onClick: () => load(query) }, t('retry')),
          )
        }
        if (state.report?.configured === false) {
          return h('div', { style: { ...S.detail, ...S.empty } }, h('span', null, t('notConfigured')), h('span', { style: S.note }, t('notConfiguredHint')))
        }
        return h('div', { style: S.panelBody }, list, detailPane())
      }

      return h('div', { style: S.panel }, h('span', { style: { fontSize: 15, fontWeight: 600 } }, t('panelTitle')), toolbar, body())
    }

    // ── plugin wiring ─────────────────────────────────────────────────────────

    function snapshotValue(snapshot, key) {
      const value = snapshot && snapshot.value ? snapshot.value[key] : undefined
      if (value === undefined || value === null) return ''
      return value
    }

    const isOverridden = (snapshot, key) =>
      Boolean(snapshot && snapshot.user && typeof snapshot.user === 'object' && key in snapshot.user)

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-vaultwarden: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.inject(['settingsScope'], (scoped) => {
        const binder = scoped.settingsScope
        if (!binder || typeof binder.bind !== 'function') return
        const scope = binder.bind({ namespace: NS })
        scoped.effect(() => () => scope.dispose(), 'dsh-vaultwarden: settings scope')

        // 1. the configuration card inside the plugins settings section
        scoped.slots.inject('settings.plugin.item', () =>
          scoped.slots.register(
            {
              name: 'settings.plugin.item',
              key: NS,
              locale: NS,
              inject: () => ({ bitwardenScope: scope }),
            },
            (props) => h(BitwardenCard, props),
          ),
        )

        // 2. the entry browser as the plugin's own settings page
        scoped.slots.inject('settings.section', () =>
          scoped.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: SECTION_ORDER,
              label: () => t('panelNav'),
              inject: () => ({ t }),
            },
            (props) => h(VaultPanel, props),
          ),
        )
      })
    }

    module.exports = { name: 'dsh-vaultwarden', inject: ['slots', 'locale'], apply, BitwardenCard, VaultPanel }
    return module.exports
  },
})
