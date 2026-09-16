/**
 * Browser half of @dsh-external/dsh-bitwarden.
 *
 * Renders the `bitwarden` settings card in 设置 → 插件 → 插件配置. The settings
 * section dispatches `settings.plugin.item` by settings namespace and renders
 * whatever card claims that key — without this half the namespace is served but
 * draws nothing.
 *
 * The bundle is a hand-written CJS module in the client module-loader format:
 * `require('react')` comes from the platform seed table, everything else is
 * plain DOM, so no bundler or build step is involved.
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-bitwarden',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const h = react.createElement

    const NS = 'bitwarden'

    const DICT_ZH = {
      title: 'Bitwarden / Vaultwarden 凭据库',
      description: '任何新会话都会自动知道可以从凭据库读取密码；这里填一次即可。',
      serverUrl: '服务器地址',
      email: '登录邮箱',
      masterPassword: '主密码',
      apiKeyClientId: 'API 密钥 client_id（可选）',
      apiKeyClientSecret: 'API 密钥 client_secret（可选）',
      cacheMinutes: '缓存时长（分钟）',
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
    }
    const DICT_EN = {
      title: 'Bitwarden / Vaultwarden vault',
      description: 'Every new session knows it may read credentials from the vault; configure it once here.',
      serverUrl: 'Server URL',
      email: 'Login email',
      masterPassword: 'Master password',
      apiKeyClientId: 'API key client_id (optional)',
      apiKeyClientSecret: 'API key client_secret (optional)',
      cacheMinutes: 'Cache (minutes)',
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
    }

    const FIELDS = [
      { key: 'serverUrl', label: 'serverUrl', type: 'text' },
      { key: 'email', label: 'email', type: 'text' },
      { key: 'masterPassword', label: 'masterPassword', type: 'password', secret: true },
      { key: 'apiKeyClientId', label: 'apiKeyClientId', type: 'text' },
      { key: 'apiKeyClientSecret', label: 'apiKeyClientSecret', type: 'password', secret: true },
      { key: 'cacheMinutes', label: 'cacheMinutes', type: 'number' },
    ]

    const styles = {
      card: { border: '1px solid var(--dsh-border, #3a3a3a)', borderRadius: 10, padding: '14px 16px', margin: '10px 0' },
      head: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      title: { fontSize: 15, fontWeight: 600 },
      desc: { opacity: 0.7, fontSize: 12, marginTop: 4, lineHeight: 1.5 },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(190px, 240px) 1fr', gap: '8px 12px', alignItems: 'center', marginTop: 12 },
      label: { fontSize: 12.5, opacity: 0.85, display: 'flex', flexDirection: 'column', gap: 2 },
      code: { opacity: 0.5, fontSize: 11 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 9px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border, #444)',
        background: 'var(--dsh-input-bg, transparent)',
        color: 'inherit',
        fontSize: 13,
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' },
      button: { padding: '6px 14px', borderRadius: 6, border: '1px solid var(--dsh-border, #444)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 },
      buttonPrimary: { padding: '6px 16px', borderRadius: 6, border: '1px solid transparent', background: 'var(--dsh-accent, #4c6ef5)', color: '#fff', cursor: 'pointer', fontSize: 13 },
      note: { fontSize: 12, opacity: 0.72 },
      error: { fontSize: 12, color: '#e03131' },
      ok: { fontSize: 12, color: '#2f9e44' },
      badge: { fontSize: 11, opacity: 0.6, border: '1px solid currentColor', borderRadius: 999, padding: '1px 7px' },
    }

    /** Read one field's effective value out of a scope snapshot. */
    const snapshotValue = (snapshot, key) => {
      const value = snapshot && snapshot.value ? snapshot.value[key] : undefined
      if (value === undefined || value === null) return ''
      return value
    }

    const isOverridden = (snapshot, key) =>
      Boolean(snapshot && snapshot.user && typeof snapshot.user === 'object' && key in snapshot.user)

    function BitwardenCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => DICT_ZH[key] ?? key
      const scope = props.bitwardenScope
      const [snapshot, setSnapshot] = react.useState(() => (scope ? scope.getSnapshot() : undefined))
      const [draft, setDraft] = react.useState({})
      const [state, setState] = react.useState('idle')
      const [error, setError] = react.useState('')

      react.useEffect(() => {
        if (!scope) return undefined
        setSnapshot(scope.getSnapshot())
        return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
      }, [scope])

      const status = snapshot ? snapshot.status : 'loading'
      const writable = Boolean(snapshot && snapshot.writable && status === 'ready')
      const currentValue = (key) => {
        if (key in draft) return draft[key]
        const value = snapshotValue(snapshot, key)
        return value === undefined || value === null ? '' : String(value)
      }
      const dirtyFields = FIELDS.filter((field) => {
        if (!(field.key in draft)) return false
        const draftValue = draft[field.key]
        const saved = snapshotValue(snapshot, field.key)
        if (field.secret && String(draftValue).length === 0) return false
        if (field.type === 'number') return String(saved) !== String(draftValue)
        return String(saved ?? '') !== String(draftValue ?? '')
      })

      const save = async () => {
        if (!scope || dirtyFields.length === 0) return
        setState('saving')
        setError('')
        try {
          for (const field of dirtyFields) {
            const raw = draft[field.key]
            const value = field.type === 'number' ? Number(raw) : String(raw)
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
        if (status === 'loading') return h('span', { style: styles.note }, t('statusLoading'))
        if (status === 'unavailable') return h('span', { style: styles.note }, t('statusUnavailable'))
        if (!writable) return h('span', { style: styles.note }, t('statusReadonly'))
        if (state === 'saving') return h('span', { style: styles.note }, t('saving'))
        if (state === 'saved') return h('span', { style: styles.ok }, t('saved'))
        if (state === 'failed') return h('span', { style: styles.error }, `${t('failed')}: ${error}`)
        return h('span', { style: styles.note }, t('hint'))
      }

      return h(
        'section',
        { style: styles.card, 'data-dsh-plugin': NS },
        h(
          'div',
          { style: styles.head },
          h('span', { style: styles.title }, t('title')),
          h('span', { style: styles.badge }, NS),
        ),
        h('div', { style: styles.desc }, t('description')),
        h(
          'div',
          { style: styles.grid },
          FIELDS.map((field) =>
            h(
              'label',
              { key: field.key, style: styles.label },
              h('span', null, t(field.key), ' ', h('span', { style: styles.code }, field.label)),
              isOverridden(snapshot, field.key)
                ? h('span', { style: styles.code }, t('overridden'))
                : null,
            ),
          ).flatMap((labelNode, index) => {
            const field = FIELDS[index]
            const input = h('input', {
              key: `${field.key}-input`,
              style: styles.input,
              type: field.type === 'number' ? 'number' : field.type,
              value: currentValue(field.key),
              disabled: !writable && status !== 'loading',
              placeholder: field.secret ? t('secretPlaceholder') : '',
              autoComplete: field.secret ? 'new-password' : 'off',
              onChange: (event) => setDraft((previous) => ({ ...previous, [field.key]: event.target.value })),
            })
            return [labelNode, input]
          }),
        ),
        h(
          'div',
          { style: styles.row },
          h(
            'button',
            {
              type: 'button',
              style: styles.buttonPrimary,
              disabled: !writable || dirtyFields.length === 0 || state === 'saving',
              onClick: save,
            },
            t('save'),
          ),
          h(
            'button',
            { type: 'button', style: styles.button, disabled: !writable || state === 'saving', onClick: reset },
            t('reset'),
          ),
          statusLine(),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-bitwarden: dictionaries')

      ctx.inject(['settingsScope'], (scoped) => {
        const binder = scoped.settingsScope
        if (!binder || typeof binder.bind !== 'function') return
        const scope = binder.bind({ namespace: NS })
        scoped.effect(() => () => scope.dispose(), 'dsh-bitwarden: settings scope')
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
      })
    }

    module.exports = { name: '@dsh-external/dsh-bitwarden', inject: ['slots', 'locale'], apply, BitwardenCard }
    return module.exports
  },
})
