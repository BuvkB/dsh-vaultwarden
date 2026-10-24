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
      /**
       * The sidebar's own read: one call gives every section's count, so the
       * navigation is drawn from the host's numbers rather than from guesses
       * about the vault.
       * @type {{key: string, overview: object, at: number} | null}
       */
      overview: null,
      /**
       * What each section's list looked like when it was last read, keyed by
       * account and section. Stepping back into a section the reader just left
       * must not go back to the host for the same rows — that is the whole
       * point of the menu (see openSection).
       * @type {Map<string, {list: object, offset: number, at: number}>}
       */
      sections: new Map(),
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
    /**
     * Forget the account a cached config belongs to.
     *
     * Called wherever the panel deliberately drops a session — sign-out, a
     * credential change, the manual reset. The config cache exists so a
     * section switch does not re-ask the host what it already knows, and that
     * shortcut is only sound while the account behind it is still the one
     * signed in.
     */
    const forgetConfig = () => {
      openCache.config = null
    }
    const resetOpenCache = () => {
      openCache.vault = null
      openCache.config = null
      openCache.overview = null
      openCache.sections.clear()
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
    // @vw-mark: constants the browser test reads, so it can never drift from
    // the bundle by hard-coding a sentinel of its own.
    /**
     * The sidebar's places, one per host `section` kind.
     *
     * A section is a place in the vault, not a refinement of a list: the host
     * narrows the pool before it scores and pages, so the count on a row and the
     * rows behind it are the same number by construction. That is why they
     * travel to the read (section / sectionValue) rather than filtering a served
     * window here — a folder narrowed on this side would make the badge and the
     * pager describe a list nobody is looking at.
     */
    const SECTION_ALL = 'all'
    const SECTION_TOTP = 'totp'
    const SECTION_TYPE = 'type'
    const SECTION_FOLDER = 'folder'
    const SECTION_UNFILED = 'unfiled'
    const SECTION_FAVORITES = 'favorites'
    const SECTION_ARCHIVE = 'archive'
    const SECTION_TRASH = 'trash'
    /** Where the panel opens, and where a place it cannot name falls back to. */
    const DEFAULT_SECTION = { kind: SECTION_ALL, value: '' }
    /** A section's identity: the cache key, and the row's own attribute. */
    const sectionKeyOf = (section) => {
      const kind = section?.kind ?? SECTION_ALL
      if (kind === SECTION_TYPE || kind === SECTION_FOLDER) return `${kind}:${section?.value ?? ''}`
      return kind
    }
    /** Field-wise comparison, so a fresh object never causes a re-render. */
    const sameSection = (left, right) => sectionKeyOf(left) === sectionKeyOf(right)
    /** What the host has to be told for a section: its kind, and its id. */
    const sectionFields = (section) => ({ section: section?.kind ?? SECTION_ALL, sectionValue: String(section?.value ?? '') })
    /** The server's "no icon" answer is a 19px globe: anything smaller is none. */
    const ICON_MIN_PX = 24
    /** How long a place the reader left keeps painting before it re-reads. */
    const SECTION_CACHE_MS = 5 * 60_000
    /** `lastSessionEvent.kind` → dictionary key (see lib/vault.js #noteSessionEvent). */
    const SESSION_EVENT_KEYS = {
      relogin: 'sessionEventRelogin',
      login_failed: 'sessionEventReloginFailed',
      refresh_rejected: 'sessionEventRejected',
      two_factor_required: 'sessionEventTwoFactor',
    }
    /** The host's entry `type` → dictionary key, for the detail badge. */
    const TYPE_LABEL_KEYS = {
      login: 'typeLogin',
      secureNote: 'typeSecureNote',
      card: 'typeCard',
      identity: 'typeIdentity',
      sshKey: 'typeSshKey',
    }
    /**
     * Which identity fields are folded into which labelled row. Whatever the
     * server sent but this list does not name is still shown, under its own key
     * name — an identity card must not lose a field just because the panel had
     * no translation for it.
     */
    const IDENTITY_LABELS = [
      ['identityName', ['firstName', 'middleName', 'lastName']],
      ['identityEmail', ['email']],
      ['identityPhone', ['phone']],
      ['identityAddress', ['address1', 'address2', 'address3', 'city', 'state', 'postalCode', 'country']],
    ]
    // The same set, built once. It was rebuilt inside the detail pane on every
    // render — an eight-element array flattened into a Set, for a question
    // ("is this field already labelled?") whose answer never changes.
    const IDENTITY_FIELD_NAMES = new Set(IDENTITY_LABELS.flatMap(([, fieldNames]) => fieldNames))
    // Which sentence a "this class of secret exists but has not been fetched"
    // placeholder row uses. Hoisted for the same reason: it is a constant that
    // was being allocated on every render of the detail pane.
    const HINT_KEYS = { card: 'hasCardHint', identity: 'hasIdentityHint', sshKey: 'hasSshKeyHint', secureNote: 'hasSecureNoteHint' }
    /**
     * What the host has to be told besides the section: whether archived rows
     * come along, and whether this read means to see soft-deleted ones.
     *
     * Archived entries are retired credentials and they already have a place of
     * their own: they belong to the 归档 row, whose count is exactly them, so
     * folding them into every other list would put a badge out of step with the
     * rows under it. The trash is the one place whose pool *is* the deleted
     * half, so that read has to say it meant to read them.
     */
    const listFieldsFor = (section) => {
      const fields = sectionFields(section)
      return {
        section: fields.section,
        sectionValue: fields.sectionValue,
        includeArchived: false,
        includeTrashed: fields.section === SECTION_TRASH,
      }
    }
    // @vw-mark-end
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
const PAGING_REFUSAL_TTL_MS = 10 * 60_000
/** When the refusal was recorded; a stale one is retried rather than kept. */
let pagingRefusedAt = 0
const markPagingRefused = () => {
  pagingRefused = true
  pagingRefusedAt = Date.now()
}
/**
 * Has a page read been refused recently?
 *
 * This used to be permanent for the life of the page, which turned one refusal
 * into a whole session's worth of limit=FULL_LIMIT reads: a host that cannot
 * page serves a full answer on every open — more bytes, more rows to render and
 * a heavier first paint — because of a single failure earlier on. A refusal is
 * a fact about the host, so it is remembered, but only for long enough to spare
 * the reader a doomed read on the next few opens.
 */
const pagingIsRefused = () => pagingRefused && Date.now() - pagingRefusedAt < PAGING_REFUSAL_TTL_MS

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
     *
     * A record that has aged out is ERASED, not merely ignored: localStorage
     * outlives the tab, the browser and the reboot, so an expired snapshot
     * left in place is a list of the reader's account names and usernames
     * sitting on disk indefinitely — readable from the profile of a stolen
     * laptop without any password. It names its account (`key`), and a caller
     * that knows a different one erases it instead of painting it.
     */
    const readSnapshot = () => {
      try {
        const raw = globalThis.localStorage?.getItem(SNAPSHOT_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed?.list || !parsed?.report) {
          forgetSnapshot()
          return null
        }
        if (!Number.isFinite(parsed.at) || Date.now() - parsed.at > REOPEN_CACHE_MS) {
          forgetSnapshot()
          return null
        }
        // The sidebar's counts travel with it: a reload that painted the rows
        // but not the menu would make the reader wait a round trip to see the
        // places those rows came from.
        return parsed
      } catch {
        return null // no storage (private mode): the module cache still works
      }
    }

    // The last payload handed to storage, so a refresh that changed nothing
    // (a poll tick answering the same list) skips the serialize-and-write.
    let lastSnapshotPayload = null
    const writeSnapshot = (snapshot) => {
      try {
        const stable = JSON.stringify({ key: snapshot.key, overview: snapshot.overview, list: snapshot.list, report: snapshot.report })
        if (stable === lastSnapshotPayload) return
        lastSnapshotPayload = stable
        globalThis.localStorage?.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
      } catch {
        // Storage blocked or full: painting simply falls back to the network.
      }
    }

    /** Drop the cached read: a signed-out panel must show nothing. */
    const forgetSnapshot = () => {
      lastSnapshotPayload = null
      openCache.vault = null
      // The per-section and overview caches describe the same dropped read;
      // left behind they repainted the old account's rows and counts on the
      // next open straight from memory, after the snapshot itself was gone.
      openCache.overview = null
      openCache.sections.clear()
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

    /**
     * The sidebar's own read, remembered across mounts.
     *
     * The panel is unmounted whenever the settings dialog closes, so without
     * this every reopen would spend a round trip on numbers that describe a
     * vault the reader may not have touched. Same age rule as the rows: past it
     * the answer is only good enough to paint while the fresh one is read.
     */
    const freshOverview = (identity) => {
      if (!openCache.overview || openCache.overview.key !== identity) return null
      if (Date.now() - openCache.overview.at > REOPEN_CACHE_MS) return null
      return openCache.overview.overview
    }

    /**
     * Which icon the server has for a host, once asked.
     *
     * `null` means "not asked yet", 'ok' keeps the URL in the row for good, and
     * 'none' keeps the letter tile — so a host without a favicon is asked about
     * exactly once per page load, not once per render.
     */
    const iconCache = new Map()
    /**
     * Bumped whenever a probe answers. It is what re-renders the rows: the map
     * lives at module scope, where React cannot see it change, so the version
     * is read on every render and the answer arrives as a re-render instead.
     */
    let iconVersion = 0
    /** A queued icon notification, so a burst of answers costs one re-render (see bumpIcons). */
    let iconFlush = null
    /**
     * Announce that a probe answered.
     *
     * The version alone is not enough: React cannot see a module-scope
     * variable change, so a row that asked about a host would keep the letter
     * tile it was rendered with until something unrelated re-rendered it —
     * the icon only appeared when the reader happened to type. The
     * subscribers are the panels currently mounted; notifying them is what
     * turns the probe's answer into a re-render.
     */
    const bumpIcons = () => {
      iconVersion += 1
      // Batched into one microtask on purpose. A first page carries up to 50
      // rows and roughly as many hosts, and every answer used to re-render the
      // whole panel on the spot: 50 favicons arriving together meant 50 full
      // list re-renders while the reader was already reading it. The answers
      // land in the same tick anyway, so one re-render shows all of them.
      if (iconFlush !== null) return
      iconFlush = Promise.resolve().then(() => {
        iconFlush = null
        iconSubscribers.forEach((notify) => notify())
      })
    }
    /**
     * Wipe what the probes learned. A bump is part of it: the rows that asked
     * earlier are only holding the answer they were rendered with, so they have
     * to be rendered again for the new map to mean anything.
     */
    const resetIconCache = () => {
      iconCache.clear()
      probedIconHosts.clear()
      pendingIconHosts.clear()
      // Straight through, not batched: the caller has already changed what the
      // rows should draw and expects the next render to show it.
      iconVersion += 1
      iconFlush = null
      iconSubscribers.forEach((notify) => notify())
    }
    /** Panels currently rendered, to wake them when the hooks above change. */
    const iconSubscribers = new Set()
    /** Test hook: preset what the probe would have found. */
    const setIcons = (entries) => {
      resetIconCache()
      for (const [host, state] of Object.entries(entries ?? {})) iconCache.set(host, state === 'ok' ? 'ok' : 'none')
    }

    const NS = 'bitwarden'
    const SECTION_ID = 'vaultwarden'
    const SECTION_ORDER = 30

    /** Shown if the host cannot report the manifest's repository field. */
    const REPO_FALLBACK = 'https://github.com/BuvkB/dsh-vaultwarden'
    /**
     * The build this bundle was packed from, and the repo it lives in.
     *
     * Two sources, on purpose. A browser bundle cannot read package.json, and
     * asking the host means changing the NODE half — which only takes effect
     * after a restart. So the heading must survive both states: an older host
     * that never reports `plugin` on `boot` still shows a correct version
     * here, and a current host overrides it with the manifest's own value.
     *
     * `scripts/build.sh` stamps both constants from package.json on every
     * build, so this fallback is never hand-maintained and cannot drift.
     */
    const BUILD_VERSION = '0.9.7'
    const BUILD_REPOSITORY = 'https://github.com/BuvkB/dsh-vaultwarden'
    /**
     * Turn a package.json repository url into something a browser can open.
     *
     * The manifest holds npm's shorthand (`git+https://github.com/owner/repo.git`),
     * which a browser treats as an unknown scheme. Strip the `git+` prefix, the
     * trailing `.git`, and anything after a `#` fragment, and leave a plain
     * https URL behind.
     */
    const normalizeRepoUrl = (url) => {
      const text = String(url ?? '').trim()
      if (!text) return REPO_FALLBACK
      const cleaned = text.replace(/^git\+/, '').replace(/#.*$/, '').replace(/\.git$/, '')
      return /^https?:\/\//.test(cleaned) ? cleaned : REPO_FALLBACK
    }

    // ── dictionaries (zh first; en mirrors the same keys) ─────────────────────
    const DICT_ZH = {
      panelTitle: '凭据库',
      // The heading is now three parts: a 凭据库 badge (its own key, shared with
      // the settings nav), the package name, then the version and repo link in
      // small type.
      packageLabel: 'dsh-vaultwarden',
      versionLabel: 'v{version}',
      repoLabel: 'GitHub',
      repoTitle: '在 GitHub 上查看源码',
      panelNav: '凭据库',
      search: '搜索条目',
      // Short on purpose: the long version was truncated mid-word on a phone.
      searchPlaceholder: '搜索名称、用户名或网址',
      // The keyboard shortcuts moved out of the placeholder into the tooltip.
      searchHint: '按 / 或 ⌘K 聚焦搜索框，Esc 清空或退出，↑↓ 移动选中',
      refresh: '刷新',
      listEmpty: '没有匹配的条目',
      listHint: '换个关键词，或确认条目存在于该账户',
      loadFailed: '读取失败',
      retry: '重试',
      username: '用户名',
      password: '密码',
      totp: '动态码',
      totpRingTip: '动态码剩余 {seconds} 秒',
      // v0.6.0: the sidebar's places, and the code list
      navSections: '凭据库分区',
      sectionAll: '全部条目',
      sectionFavorites: '收藏',
      sectionTotp: '验证码',
      sectionTypes: '类型',
      sectionFolders: '文件夹',
      sectionUnfiled: '未归类',
      sectionArchive: '归档',
      sectionTrash: '回收站',
      totpCopyTip: '复制动态码',
      // The code list is a read surface too, so a gated entry must say why it
      // shows a dash instead of a code rather than looking broken.
      totpGated: '需重新验证',
      totpGatedTip: '该条目开启了重新验证：到「全部条目」里打开它并输入主密码后才能读取动态码。',
      notes: '备注',
      customFields: '自定义字段',
      folder: '目录',
      uris: '网址',
      copy: '复制',
      copied: '已复制',
      // The row island's two controls. They copy a value the panel does not
      // show, so the tooltip has to name which one, not just say 复制.
      copyUsername: '复制用户名',
      copyPassword: '复制密码',
      show: '显示',
      hide: '隐藏',
      repromptLocked: '该条目在 Bitwarden 中开启了「重新验证」',
      repromptHint: '读取明文需要本人在此输入主密码；验证一次后短时间内不必重复输入。',
      confirmRead: '输入主密码解锁',
      repromptPasswordPlaceholder: '主密码',
      repromptGrantedBadge: '已解锁 {n} 分钟',
      repromptWrong: '主密码不对',
      revealThisField: '读取这一项',
      hasCardHint: '含银行卡',
      hasIdentityHint: '含身份信息',
      hasSshKeyHint: '含 SSH 私钥',
      hasSecureNoteHint: '含安全笔记',
      favorite: '收藏',
      itemsCount: '共 {n} 条',
      syncWebsocket: '实时同步',
      untitled: '（未命名）',
      noMeta: '无用户名/网址',
      backToList: '返回列表',
      loadMore: '还有 {n} 条，点击继续显示',
      moreBlocked: '本机只同步到 {shown}/{total} 条，其余 {n} 条请在 Bitwarden 网页端查看',
      loadingMore: '正在加载…',
      hasTotp: '该条目包含两步验证码',
      archived: '已归档',
      archivedTip: '该条目已归档；搜索时默认不返回，可用 includeArchived 查看',
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
      refreshing: '正在刷新…',
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
      timeJustNow: '刚刚',
      timeMinutes: '{n} 分钟前',
      timeHours: '{n} 小时前',
      timeDays: '{n} 天前',
      // The list subtitle closes with when the entry last moved. Its tooltip
      // carries the exact stamp: the relative form is what the eye scans, but
      // the timestamp is what a person actually wants when two entries share
      // a name.
      listMetaTimeTip: '最后更新：{time}',
      // v0.5.0: trash
      trashTip: '显示回收站条目（软删除，可恢复）',
      trashBadge: '回收站',
      trashEmpty: '回收站是空的',
      // Still used by the move step and a row with no folder.
      folderUnfiled: '未归类',
      // v0.5.0: entry types
      typeLogin: '登录',
      typeSecureNote: '安全笔记',
      typeCard: '银行卡',
      typeIdentity: '身份信息',
      typeSshKey: 'SSH 密钥',
      secureNoteBody: '笔记内容',
      cardNumber: '卡号',
      cardholderName: '持卡人',
      cardBrand: '品牌',
      cardExpiry: '有效期',
      cardCode: '安全码',
      identityName: '姓名',
      identityEmail: '邮箱',
      identityPhone: '电话',
      identityAddress: '地址',
      sshPublicKey: '公钥',
      sshFingerprint: '指纹',
      sshPrivateKey: '私钥',
      // v0.5.0: extra projections
      hasFido2: '含通行密钥',
      hasFido2Tip: '该条目包含通行密钥（Passkey）；写回时会原样保留',
      attachments: '附件（{n}）',
      attachmentNoDownload: '面板只显示附件信息，不下载内容',
      passwordHistory: '历史密码（{n}）',
      historyLastUsed: '最近使用：{time}',
      trashedBanner: '该条目在回收站中（软删除）',
      // v0.8.0: editor
      newEntry: '新建条目',
      edit: '编辑',
      editTitle: '编辑条目',
      createTitle: '新建条目',
      editorType: '类型',
      editorName: '名称',
      editorNamePlaceholder: '例如：GitHub 工作账号',
      editorNameRequired: '请填写条目名称',
      editorUsername: '用户名',
      editorPassword: '密码',
      editorTotpSeed: '验证码密钥（otpauth:// 或 Base32）',
      editorTotpHint: '当前条目已有验证码；此项留空即保留原设置。',
      editorUris: '网址',
      editorNotes: '备注',
      editorFavorite: '收藏',
      editorReprompt: '需要重新验证',
      editorRepromptHint: '开启后读取该条目前必须输入主密码。',
      editorFolder: '文件夹',
      editorFolderNone: '未归类',
      editorCustomFields: '自定义字段',
      editorFieldName: '字段名',
      editorFieldValue: '值',
      editorAddField: '添加字段',
      editorRemoveField: '删除字段',
      editorCard: '银行卡',
      editorCardholderName: '持卡人',
      editorBrand: '品牌',
      editorNumber: '卡号',
      editorExpMonth: '到期月',
      editorExpYear: '到期年',
      editorCode: '安全码',
      editorIdentity: '身份信息',
      editorIdentityTitle: '称谓',
      editorFirstName: '名',
      editorMiddleName: '中间名',
      editorLastName: '姓',
      editorIdentityEmail: '邮箱',
      editorIdentityPhone: '电话',
      editorCompany: '公司',
      editorSsn: '身份证号',
      editorPassportNumber: '护照号',
      editorLicenseNumber: '驾照号',
      editorAddress1: '地址行 1',
      editorAddress2: '地址行 2',
      editorAddress3: '地址行 3',
      editorCity: '城市',
      editorState: '省/州',
      editorPostalCode: '邮编',
      editorCountry: '国家/地区',
      editorSshKey: 'SSH 密钥',
      editorPrivateKey: '私钥',
      editorPublicKey: '公钥',
      editorKeyFingerprint: '指纹',
      editorSave: '保存',
      editorSaving: '正在保存…',
      editorCancel: '取消',
      editorSaved: '已保存',
      editorSaveFailed: '保存失败',
      // A write that never reached the host looks the same as one the host
      // refused, but the reader can act differently: a dropped connection only
      // means "try again". Said in the reader's own terms.
      editorSaveOffline: '保存未送达：与 DSH 的连接中断了，条目没有改动，请重试。',
      editorSynced: '已同步到服务器',
      // The old wording ("已保存，但同步未完成") had the meaning backwards: the
      // write did reach the server — it is the panel's own list that has not
      // been read again yet.
      editorSyncWarning: '已保存到服务器；本地列表尚未刷新：{reason}',
      editorNoChanges: '没有改动',
      editorStale: '该条目已被其他客户端修改，请重新打开编辑器。',
      // ── the transcript's bitwarden_* rows (see BitwardenToolRow) ──────────
      // The row exists to show WHAT was asked and answered without putting the
      // answer's secrets on screen. It does not announce that it hid anything:
      // the dots in the expanded body say it, and a badge on every row would be
      // noise on the rows that had nothing to hide.
      toolRunning: '调用中…',
      toolFailed: '调用失败',
      toolArgs: '参数',
      toolResult: '输出',
      toolError: '错误',
      toolDone: '已完成',
      toolHits: '{n} 条',
      editorRepromptLocked: '该条目开启了「重新验证」，需要先输入主密码解锁。',
      editorUnmodelled: '以下内容本表单不处理，保存时会原样保留：通行密钥、附件、密码历史。',
      editorFido2Note: '该条目含通行密钥（Passkey），保存时原样保留。',
      // v0.5.0: write actions
      actionArchive: '归档',
      actionUnarchive: '取消归档',
      actionRestore: '恢复',
      actionTrash: '移入回收站',
      actionMoveFolder: '移动到文件夹',
      // The badges carry a glyph and a word; the tooltip is where the action's
      // consequence is spelled out, since the label can only name it.
      actionEditTip: '编辑条目：改名称、用户名、密码、网址与备注',
      actionArchiveTip: '归档：条目留在库里，但模型搜索默认不再返回它',
      actionUnarchiveTip: '取消归档：让该条目重新参与模型搜索',
      actionRestoreTip: '恢复：把条目从回收站放回列表',
      actionTrashTip: '移入回收站：软删除，之后仍可恢复',
      actionMoveFolderTip: '移动到文件夹：把条目归到另一个目录下',
      moveNone: '不移动',
      confirmArchive: '确认归档该条目？归档后模型搜索默认不再返回它。',
      confirmUnarchive: '取消归档，让该条目重新参与搜索？',
      confirmRestore: '确认从回收站恢复该条目？',
      confirmTrash: '确认把该条目移入回收站？可在回收站中恢复。',
      writeNote: '面板操作不受 accessMode 门禁保护，请谨慎操作。',
      writeBlockedReadonly: '当前为只读模式（accessMode=readonly），面板不显示写操作。',
      confirmMoveFolder: '把该条目移动到「{folder}」？',
      writeSaving: '正在写入…',
      writeDone: '已完成，正在刷新…',
      writeFailed: '操作失败',
      cancel: '取消',
      confirm: '确认',
      // v0.5.0: session events
      syncTipSessionEvent: '最近会话事件：{event}',
      sessionEventRelogin: '后台重新登录成功',
      sessionEventReloginFailed: '后台重新登录失败',
      sessionEventRejected: '后台重新登录被拒绝',
      sessionEventTwoFactor: '后台重新登录需要两步验证',
    }
    const DICT_EN = {
      panelTitle: 'Credentials',
      packageLabel: 'dsh-vaultwarden',
      versionLabel: 'v{version}',
      repoLabel: 'GitHub',
      repoTitle: 'View the source on GitHub',
      panelNav: 'Credentials',
      search: 'Search entries',
      searchPlaceholder: 'Name, username or URL',
      searchHint: 'Press / or ⌘K to focus, Esc to clear or step back, ↑↓ to move the selection',
      refresh: 'Refresh',
      listEmpty: 'No matching entries',
      listHint: 'Try another keyword, or confirm the entry exists in this account',
      loadFailed: 'Load failed',
      retry: 'Retry',
      username: 'Username',
      password: 'Password',
      totp: 'TOTP',
      totpRingTip: 'Code expires in {seconds}s',
      // v0.6.0: the sidebar's places, and the code list
      navSections: 'Vault sections',
      sectionAll: 'All items',
      sectionFavorites: 'Favorites',
      sectionTotp: 'TOTP',
      sectionTypes: 'Types',
      sectionFolders: 'Folders',
      sectionUnfiled: 'Unfiled',
      sectionArchive: 'Archive',
      sectionTrash: 'Trash',
      totpCopyTip: 'Copy code',
      // The code list is a read surface too, so a gated entry must say why it
      // shows a dash instead of a code rather than looking broken.
      totpGated: 'Re-auth needed',
      totpGatedTip: 'This entry has re-prompt enabled: open it under All items and enter the master password before its code can be read.',
      notes: 'Notes',
      customFields: 'Custom fields',
      folder: 'Folder',
      uris: 'URLs',
      copy: 'Copy',
      copied: 'Copied',
      copyUsername: 'Copy username',
      copyPassword: 'Copy password',
      show: 'Show',
      hide: 'Hide',
      repromptLocked: 'This entry has Bitwarden’s re-prompt enabled',
      repromptHint: 'Reading the plaintext needs your master password here; one check covers the next few minutes.',
      confirmRead: 'Unlock with master password',
      repromptPasswordPlaceholder: 'Master password',
      repromptGrantedBadge: 'Unlocked for {n} min',
      repromptWrong: 'That master password is not right',
      revealThisField: 'Read this one',
      hasCardHint: 'holds a bank card',
      hasIdentityHint: 'holds an identity',
      hasSshKeyHint: 'holds an SSH private key',
      hasSecureNoteHint: 'holds a secure note',
      favorite: 'Favorite',
      itemsCount: '{n} entries',
      syncWebsocket: 'Live sync',
      untitled: '(untitled)',
      noMeta: 'No username or URL',
      backToList: 'Back to list',
      loadMore: 'Show {n} more',
      moreBlocked: 'Only {shown} of {total} entries synced · the other {n} are only in the Bitwarden web vault',
      loadingMore: 'Loading more…',
      hasTotp: 'This entry has a two-factor code',
      archived: 'Archived',
      archivedTip: 'This entry is archived; searches skip it unless includeArchived is set',
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
      refreshing: 'Refreshing…',
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
      timeJustNow: 'just now',
      timeMinutes: '{n} min ago',
      timeHours: '{n} h ago',
      timeDays: '{n} d ago',
      listMetaTimeTip: 'Last updated: {time}',
      // v0.5.0: trash
      trashTip: 'Show soft-deleted entries (restorable)',
      trashBadge: 'Trash',
      trashEmpty: 'The trash is empty',
      // Still used by the move step and a row with no folder.
      folderUnfiled: 'Unfiled',
      // v0.5.0: entry types
      typeLogin: 'Login',
      typeSecureNote: 'Secure note',
      typeCard: 'Card',
      typeIdentity: 'Identity',
      typeSshKey: 'SSH key',
      secureNoteBody: 'Note',
      cardNumber: 'Number',
      cardholderName: 'Cardholder',
      cardBrand: 'Brand',
      cardExpiry: 'Expires',
      cardCode: 'Security code',
      identityName: 'Name',
      identityEmail: 'Email',
      identityPhone: 'Phone',
      identityAddress: 'Address',
      sshPublicKey: 'Public key',
      sshFingerprint: 'Fingerprint',
      sshPrivateKey: 'Private key',
      // v0.5.0: extra projections
      hasFido2: 'Passkey',
      hasFido2Tip: 'This entry holds a passkey; write-back keeps it intact',
      attachments: 'Attachments ({n})',
      attachmentNoDownload: 'The panel lists attachment metadata only; it never downloads content',
      passwordHistory: 'Password history ({n})',
      historyLastUsed: 'Last used: {time}',
      trashedBanner: 'This entry is in the trash (soft-deleted)',
      // v0.5.0: write actions
      actionArchive: 'Archive',
      actionUnarchive: 'Unarchive',
      actionRestore: 'Restore',
      actionTrash: 'Move to trash',
      actionMoveFolder: 'Move to folder',
      actionEditTip: 'Edit this entry: name, username, password, URIs and notes',
      actionArchiveTip: 'Archive: stays in the vault, but model searches stop returning it',
      actionUnarchiveTip: 'Unarchive: let model searches return this entry again',
      actionRestoreTip: 'Restore: put this entry back from the trash',
      actionTrashTip: 'Move to trash: a soft delete, still recoverable',
      actionMoveFolderTip: 'Move to folder: file this entry under another folder',
      moveNone: 'Do not move',
      confirmArchive: 'Archive this entry? Model searches will stop returning it by default.',
      confirmUnarchive: 'Unarchive this entry so it takes part in searches again?',
      confirmRestore: 'Restore this entry from the trash?',
      confirmTrash: 'Move this entry to the trash? It can be restored from there.',
      writeNote: 'Panel actions are not covered by the accessMode gate — take care.',
      writeBlockedReadonly: 'Read-only mode (accessMode=readonly): the panel hides write actions.',
      confirmMoveFolder: 'Move this entry into "{folder}"?',
      writeSaving: 'Writing…',
      writeDone: 'Done, refreshing…',
      writeFailed: 'Action failed',
      cancel: 'Cancel',
      confirm: 'Confirm',
      // v0.8.0: editor
      newEntry: 'New entry',
      edit: 'Edit',
      editTitle: 'Edit entry',
      createTitle: 'New entry',
      editorType: 'Type',
      editorName: 'Name',
      editorNamePlaceholder: 'e.g. GitHub work account',
      editorNameRequired: 'A name is required',
      editorUsername: 'Username',
      editorPassword: 'Password',
      editorTotpSeed: 'Authenticator key (otpauth:// or Base32)',
      editorTotpHint: 'This entry already has an authenticator key; leave empty to keep it.',
      editorUris: 'URIs',
      editorNotes: 'Notes',
      editorFavorite: 'Favorite',
      editorReprompt: 'Require re-authentication',
      editorRepromptHint: 'When on, reading this entry asks for the master password.',
      editorFolder: 'Folder',
      editorFolderNone: 'No folder',
      editorCustomFields: 'Custom fields',
      editorFieldName: 'Field name',
      editorFieldValue: 'Value',
      editorAddField: 'Add field',
      editorRemoveField: 'Remove field',
      editorCard: 'Card',
      editorCardholderName: 'Cardholder',
      editorBrand: 'Brand',
      editorNumber: 'Number',
      editorExpMonth: 'Expiry month',
      editorExpYear: 'Expiry year',
      editorCode: 'Security code',
      editorIdentity: 'Identity',
      editorIdentityTitle: 'Title',
      editorFirstName: 'First name',
      editorMiddleName: 'Middle name',
      editorLastName: 'Last name',
      editorIdentityEmail: 'Email',
      editorIdentityPhone: 'Phone',
      editorCompany: 'Company',
      editorSsn: 'SSN',
      editorPassportNumber: 'Passport number',
      editorLicenseNumber: 'License number',
      editorAddress1: 'Address 1',
      editorAddress2: 'Address 2',
      editorAddress3: 'Address 3',
      editorCity: 'City',
      editorState: 'State',
      editorPostalCode: 'Postal code',
      editorCountry: 'Country',
      editorSshKey: 'SSH key',
      editorPrivateKey: 'Private key',
      editorPublicKey: 'Public key',
      editorKeyFingerprint: 'Fingerprint',
      editorSave: 'Save',
      editorSaving: 'Saving…',
      editorCancel: 'Cancel',
      editorSaved: 'Saved',
      editorSaveFailed: 'Save failed',
      editorSaveOffline: 'Not saved: the connection to DSH dropped, so the entry is unchanged. Please try again.',
      editorSynced: 'Synced to the server',
      // See the zh dictionary: the write landed, the list is what lags.
      editorSyncWarning: 'Saved to the server; the local list has not refreshed yet: {reason}',
      editorNoChanges: 'No changes',
      editorStale: 'This entry was changed elsewhere. Reopen the editor to continue.',
      toolRunning: 'Running…',
      toolFailed: 'Failed',
      toolArgs: 'Arguments',
      toolResult: 'Output',
      toolError: 'Error',
      toolDone: 'Done',
      toolHits: '{n} hits',
      editorRepromptLocked: 'This entry requires re-authentication. Unlock it with the master password first.',
      editorUnmodelled: 'Not handled by this form and kept as-is on save: passkeys, attachments, password history.',
      editorFido2Note: 'This entry has a passkey; it is kept as-is on save.',
      // v0.5.0: session events
      syncTipSessionEvent: 'Last session event: {event}',
      sessionEventRelogin: 'background re-login succeeded',
      sessionEventReloginFailed: 'background re-login failed',
      sessionEventRejected: 'background re-login rejected',
      sessionEventTwoFactor: 'background re-login needs a two-factor code',
    }

    // ── theme tokens (the only color source; fallbacks keep the page readable
    //    outside the harness). `--vw-*` are plugin-local semantic aliases over
    //    the host theme, in the shape dsh-vault uses. ──────────────────────────
    // The skeleton's ink, and the one colour here that is NOT a theme token.
    // Every candidate token failed for the same reason: the host's border
    // aliases are alpha inks (#0000000a for l1, #0000001a for l2), so both are
    // near-white once composited on a white panel — and the shared pulse then
    // halves them again. The placeholder read as empty space, which is the bug
    // the skeleton exists to prevent. A neutral mid-grey at 32% is legible on
    // white (about #d5d5d5) and on the dark theme's near-black surface (about
    // #555555) without needing a light/dark pair, and the pulse keeps it inside
    // a visible band in both.
    const SKELETON_INK = 'rgba(128, 128, 128, 0.5)'

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
      // The countdown ramp lands here: the host's error token is the red the
      // arc reaches in the last seconds.
      err: 'var(--vw-err, var(--dsw-alias-state-error-primary, #c0392b))',
      idle: 'var(--vw-idle, var(--dsw-alias-state-idle-primary, #8b949e))',
      // The accent used by informational marks (TOTP, "live code"). It is the
      // host's own business blue — the colour the link and the model label use —
      // not the button fill above, which is ink rather than an accent.
      info: 'var(--vw-info, var(--dsw-alias-state-business-primary, #4176e6))',
      // The warn *label* token rather than the warn *primary* one: primary is a
      // fill (amber 500), which as 11px text on a light surface only reaches
      // ~2:1. The label token is the pair the host itself sets warn text in.
      warnText: 'var(--vw-warn-text, var(--dsw-alias-state-warn-label, #b8830f))',
      // The tertiary tints, one per state. The host defines them for both
      // themes (a pale wash on light, a deep shaded wash on dark), which is
      // exactly the "flat but themed" badge fill a single colour cannot give.
      okBg: 'var(--vw-ok-bg, var(--dsw-alias-state-success-tertiary, #e6faed))',
      warnBg: 'var(--vw-warn-bg, var(--dsw-alias-state-warn-tertiary, #fef5e7))',
      infoBg: 'var(--vw-info-bg, var(--dsw-alias-state-business-tertiary, #e4edfd))',
      // The host has no error *tertiary*, so danger borrows the same-shaped
      // hover wash it defines for destructive affordances (a 5% red on light,
      // a 15% red on dark) — the one danger fill that is themed on both sides.
      errBg: 'var(--vw-err-bg, var(--dsw-alias-interactive-bg-hover-danger, #fee2e2))',
    }

    /**
     * Blend a colour token with another token, tolerantly.
     *
     * Both sides are `var()` chains whose real value only exists once the host
     * theme resolves, so no JS colour maths can touch them. `color-mix()` takes
     * the chains verbatim and lets the browser resolve them. A browser without
     * it gets `fallback` (the nearer endpoint) rather than a declaration the
     * engine drops, which would leave the element with no colour at all.
     */
    const supportsColorMix = () =>
      typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', 'color-mix(in srgb, red 50%, blue)')
    const blend = (from, to, percent, fallback) => {
      if (!supportsColorMix()) return fallback ?? from
      return 'color-mix(in srgb, ' + from + ' ' + percent + '%, ' + to + ')'
    }

    /**
     * ── badge system ────────────────────────────────────────────────────────
     *
     * One anatomy for every mark in the panel, so a type, a state and a
     * capability all weigh the same and line up in a column: a 18px pill, 11px
     * medium label, tabular digits, no border, a flat tinted fill.
     *
     * Flat means flat: the fill is a single translucent tint of the tone's own
     * colour and the label is that same colour pushed toward the ink token —
     * no gradient, no shadow, no second stroke. Pushing toward ink is what
     * keeps one tone legible in both themes: mixed with near-black it darkens
     * on a light surface, mixed with near-white it lightens on a dark one, and
     * neither side needs a second hand-picked hex value. The tint stays
     * translucent rather than opaque so the badge reads as part of the card it
     * sits on instead of a sticker pasted over it.
     *
     * The palette is deliberately three accents plus neutrals — blue for a live
     * code, green for a capability that protects the entry, amber for a soft
     * deletion, grey for a retired entry. Anything that is merely a classifier
     * (the entry type) stays neutral: colour is spent on state, which is the
     * only thing worth spotting at a glance.
     */
    // Metrics copied from the host's own tag (11px / line-height 17 / weight 500
    // / 1px vertical padding ⇒ a 19px pill), so a mark here is the same size as
    // a mark anywhere else in the settings dialog.
    const BADGE = { height: 19, radius: 999, padding: '1px 8px', fontSize: 11, lineHeight: 17 }
    const badgeTone = (tone) => {
      switch (tone) {
        // The host ships a matched pair per state: a tertiary tint for the fill
        // and a primary/label colour for the text, both of which flip with
        // `body[data-ds-dark-theme]`. Using the pair instead of mixing one
        // colour with transparency is what makes a badge look intentional on
        // both themes — a translucent green over a near-black card greys out,
        // while the dark theme's own green-900 fill stays green.
        case 'info':
          return { color: blend(TOKEN.info, TOKEN.text, 58, TOKEN.info), background: TOKEN.infoBg }
        case 'ok':
          return { color: blend(TOKEN.ok, TOKEN.text, 62, TOKEN.ok), background: TOKEN.okBg }
        case 'warn':
          return { color: blend(TOKEN.warn, TOKEN.text, 55, TOKEN.warnText), background: TOKEN.warnBg }
        case 'danger':
          return { color: blend(TOKEN.err, TOKEN.text, 70, TOKEN.err), background: TOKEN.errBg }
        // Neutral and muted carry the classifier marks (entry type, retired
        // entry): no accent is spent on them, so the fill is the ink itself at
        // a low alpha. Mixing toward the surface instead — the obvious way to
        // get a "plain" chip — inverts in the dark theme, where secondary ink
        // is near-white and the chip came out a pale slab on a black card. A
        // translucent ink rides whatever surface it lands on, which is the one
        // expression that holds in both themes.
        case 'muted':
          return { color: TOKEN.text2, background: blend(TOKEN.text2, 'transparent', 12, TOKEN.bg2) }
        default:
          return { color: blend(TOKEN.text, TOKEN.text2, 68, TOKEN.text), background: blend(TOKEN.text, 'transparent', 7, TOKEN.bg2) }
      }
    }
    // Every badge in the panel differs by tone alone, and there are six tones,
    // so the shape is built once per tone instead of once per badge. A list of
    // fifty rows carries up to three marks each: that was 150 fresh fifteen-key
    // objects per render, all of them identical to one of six. The cached
    // object is handed out directly when a caller adds no override; React never
    // mutates a style object, and the six are frozen below so a stray write
    // fails loudly here instead of leaking into every other badge.
    const badgeBaseCache = new Map()
    const badgeBase = (tone) => {
      let cached = badgeBaseCache.get(tone)
      if (!cached) {
        const palette = badgeTone(tone)
        cached = Object.freeze({
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          flex: 'none',
          height: BADGE.height,
          padding: BADGE.padding,
          borderRadius: BADGE.radius,
          border: 0,
          background: palette.background,
          color: palette.color,
          fontSize: BADGE.fontSize,
          fontWeight: 500,
          lineHeight: BADGE.lineHeight + 'px',
          letterSpacing: 0.2,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        })
        badgeBaseCache.set(tone, cached)
      }
      return cached
    }
    const badgeStyle = (tone, extra) => {
      const base = badgeBase(tone)
      return extra ? { ...base, ...extra } : base
    }
    /** One mark. `tone` picks the palette, `size` is fixed by the system. */
    const Badge = ({ tone = 'neutral', title, children, style }) =>
      h('span', { 'data-vw-badge': tone, title, style: badgeStyle(tone, style) }, children)
    /**
     * A row of marks: 6px apart, so a two-badge row reads as one group.
     *
     * `flex: none` is what keeps a two-badge row from being squeezed into a
     * sliver by a long name beside it — the group is all-or-nothing, and the
     * name is the thing that truncates. Extra props (a data hook, a title)
     * pass straight through, which is how the narrow-panel rules below find
     * the group to hide when even its own 40px no longer fits.
     */
    const BadgeRow = ({ children, style, ...rest }) =>
      h('span', { ...rest, style: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', ...style } }, ...children)

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
      // `container-type` makes the panel the measuring stick for the layout
      // queries in ensureStyles: the host's settings dialog is a fixed 800px
      // wide whatever the window is, so a viewport media query never sees the
      // width the panel actually has to work with.
      panel: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0 12px', color: TOKEN.text, minHeight: 0, containerType: 'inline-size', containerName: 'vw-panel' },
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
        // The gutter that keeps a card's right edge off the scrollbar. This
        // used to be `paddingRight: 4` plus `marginRight: -4`, an attempt to
        // cancel the padding visually — but a negative margin makes the box
        // itself 4px wider than its column, so the scroll area always reported
        // a scrollWidth 4px over its own width and every container measured
        // "overflowing" by that amount. `scrollbar-gutter` reserves the space
        // in the layout instead of painting past it, which is both what the
        // original wanted and something a container query can see.
        boxSizing: 'border-box',
        scrollbarGutter: 'stable',
      },
      // Every child of the scroll area keeps its natural height. It is a flex
      // column, so its children shrink by default, and a card shorter than its
      // own content — the API-key setup form carries two extra fields — had its
      // box squeezed down to the height budget while its fields kept painting
      // past the card's surface onto the dialog background.
      scrollItem: { flex: 'none' },
      // Grid, not flex-wrap: a wrapped flex row re-flows from the left edge, so
      // 设置/刷新 used to drift away from the right edge they belong on. Four
      // tracks keep the search box, the sync chip, the count and the actions on
      // one line, with the search box as the only flexible one; on a phone the
      // media query below gives the search box a row of its own.
      toolbar: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto auto', gap: 8, alignItems: 'center' },
      /**
       * The heading: shield + name + package + build metadata, wrapping on a
       * phone.
       *
       * 6px, not 8: this row holds four items and their gaps were the widest
       * thing in the header. Tighter gaps also let the metadata tail sit close
       * enough to the name to read as one line with two voices rather than as
       * four things that happen to share a row.
       */
      titleRow: { display: 'flex', alignItems: 'baseline', gap: '4px 10px', flexWrap: 'wrap', minWidth: 0 },
      /**
       * The page name: ink, semibold — the heading proper.
       *
       * 15px rather than 16 because the heading now carries the product name
       * ("Vaultwarden 凭据库") rather than one word, and at 16px the whole row
       * — name, package, version, link — no longer fits one line at the panel's
       * real width, which pushed the metadata onto a second row and left the
       * heading looking half-empty. `whiteSpace: nowrap` keeps the name itself
       * from breaking; the row wraps as a unit instead.
       */
      /**
       * The heading unit: name + package, kept together.
       *
       * `nowrap` here (not on the row) is what guarantees the group never
       * splits: if the panel is too narrow, the whole unit moves down as one
       * piece and the metadata follows it — rather than a package name stranded
       * on line one above a version on line two.
       */
      // `baseline`: this group is pure text now (the mark lives on the settings
      // rail), and two sizes on one line have to sit on a shared baseline. With
      // `center` the 17px heading centred against the 12.5px metadata's line box
      // and hung a pixel low — visible as the heading looking dropped against
      // its own metadata.
      titleHead: { display: 'inline-flex', alignItems: 'baseline', gap: 4, minWidth: 0, whiteSpace: 'nowrap' },
      // 17px, not 16: the heading is the one line a reader lands on when the
      // panel opens, and at 16 it sat only half a step above the 13.5px list
      // rows beside it. 17 with a 0.1 tracking keeps it a heading without
      // turning it into a banner.
      // 19px, and lifted 2px off the shared baseline: a 19px CJK glyph puts its
      // ink about 2px lower than the 12.5px Latin x-height beside it even when
      // both sit on the same baseline, which reads as the heading being dropped.
      // The lift is optical, not structural — measured against the live DOM.
      titleText: { fontSize: 19, fontWeight: 600, letterSpacing: 0.1, color: TOKEN.text, position: 'relative', top: -2 },
      /**
       * The package name: secondary grey, regular weight.
       *
       * 12.5px so it sits clearly below the 16px name without dropping to
       * caption size, with 2px of its own left margin — the row's 6px gap plus
       * that extra reads as "same line, weaker voice" instead of as another
       * evenly-spaced sibling.
       */
      titlePackage: { fontSize: 12.5, color: TOKEN.text2, letterSpacing: 0.05 },
      /**
       * The title row's secondary cluster: version, then the repo link.
       *
       * `inline-flex` with a 6px gap keeps the two in one unit that wraps as a
       * whole; without it the version could end a line and the link start the
       * next, which reads as two unrelated notes rather than one.
       */
      // `baseline`, not `center`: the group mixes 12.5px (the package) with
      // 11.5px (version, link) and 2px dots. Centring each item in the line box
      // puts their optical centres together but leaves their baselines apart, so
      // the row reads as slightly staggered letters. A shared baseline is what
      // makes mixed sizes look set rather than assembled.
      titleMeta: { display: 'inline-flex', alignItems: 'baseline', gap: 5, minWidth: 0, whiteSpace: 'nowrap' },
      /** The build number: monospace digits so a version never shifts the row. */
      titleVersion: { fontSize: 11.5, color: TOKEN.text2, fontVariantNumeric: 'tabular-nums', letterSpacing: 0.05 },
      /** The separator between version and link — the host's own 2px caption dot. */
      // A dot has no baseline of its own, so it is nudged up to the optical
      // middle of the text beside it when the row is baseline-aligned.
      titleDot: { width: 2, height: 2, borderRadius: 1, background: TOKEN.text2, opacity: 0.55, flex: 'none', alignSelf: 'center' },
      /**
       * The repo link. Underlined only on hover: an always-underlined link next
       * to the heading reads as a mis-styled title.
       *
       * Colour is the DEFAULT ink, not the link blue: this line sits beside a
       * version number that is already secondary grey, and a blue link there
       * turned the smallest text in the panel into its loudest element. Ink at
       * the same weight as the version keeps the row calm; the GitHub mark and
       * the hover underline are what say "this is a link".
       */
      titleLink: {
        display: 'inline-flex',
        // `baseline`, not `center`: the label is text and has to sit on the
        // row's baseline like the package name and the version beside it. The
        // mark inside is nudged back to the text's optical centre below.
        alignItems: 'baseline',
        gap: 4,
        fontSize: 12.5,
        color: TOKEN.text2,
        textDecoration: 'none',
        cursor: 'pointer',
        borderRadius: RADIUS.xs,
        transition: 'color .12s ease',
      },
      /** Keeps 设置/刷新 together and right-aligned when the row wraps.
       *  `flexWrap` is here so a phone-width row can fold the three buttons
       *  onto a second line instead of squeezing the count beside them until
       *  it reads "共 4". */
      toolbarActions: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 1, flexWrap: 'wrap', minWidth: 0 },

      /**
       * The panel body: the sidebar and the list, side by side once the panel
       * itself is wide enough for both (see the container queries in
       * ensureStyles — the host dialog is a fixed 800px, so the window width
       * says nothing about the room the panel has).
       *
       * Every track is `minmax(0, …)`: a bare `1fr` floors at min-content, so
       * one long URL in a row would widen the column past the host dialog —
       * the same reason the old body was a single column.
       */
      body: { display: 'grid', gridTemplateColumns: 'minmax(150px, 184px) minmax(0, 1fr)', gap: 16, alignItems: 'start', minWidth: 0 },
      /** The sidebar: one row per place, carrying the host's own count. */
      // The rail is sticky, not just laid out in sync with the list: the
      // list lives in the same scroll container, so without it the places
      // scrolled away with the entries and the user lost the filter he was in.
      // Sticky only works once the rail's parent (the body grid) is the natural
      // height of the whole column, which is what scrollItem is for. The phone
      // query below drops back to static, because on a narrow panel the rail
      // belongs above the list and must move with it.
      // `border-box` is load-bearing: the rail is a flex column with its own
      // padding and hairline border, and a content-box rail inside the body
      // grid's single `minmax(0, 1fr)` track came out 4px wider than the
      // column at every width below the rail's breakpoint — enough to push the
      // right hairline and its rounded corner past the panel's edge.
      nav: { position: 'sticky', top: 0, display: 'flex', flexDirection: 'column', gap: 2, boxSizing: 'border-box', width: '100%', border: `1px solid ${TOKEN.border}`, borderRadius: RADIUS.lg, background: TOKEN.bg, padding: 6, minWidth: 0 },
      navRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        // Same reason as S.listRow: the row is `width:100%` with its own
        // padding, so it has to be border-box. The real row is a <button> and
        // gets that from the UA stylesheet, but the rail's *ghost* rows (the
        // ones drawn while the counts are in flight) are <div>s — without this
        // they came out 20px wider than the rail and their count bars hung
        // past its right hairline, which is exactly the misalignment the
        // loading rail was reported for.
        boxSizing: 'border-box',
        padding: '8px 10px',
        border: 0,
        borderRadius: RADIUS.md,
        background: 'transparent',
        color: TOKEN.text,
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 13,
        minWidth: 0,
      },
      navRowActive: { background: TOKEN.bg2 },
      /** A group heading inside the sidebar ("类型 (5)", "文件夹 (1)"). */
      navGroup: { padding: '10px 10px 4px', fontSize: 11.5, color: TOKEN.text2, letterSpacing: 0.2 },
      // The rail's marks are quieter than their labels: the label is what is
      // being read, the drawing only helps find the row.
      navIcon: { flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, color: TOKEN.text2 },
      navIconActive: { color: TOKEN.text },
      navLabel: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      /**
       * The count: one flat chip for every place, so a one-digit 回收站 and a
       * three-digit 全部条目 weigh the same and their numbers sit on one line.
       * The box is fixed (min-width + height) and the digits are tabular, so
       * the column of numbers reads down the rail as a column — the sizes used
       * to follow the text, which left each row's number at a different optical
       * size. On the row in view the chip inverts to the panel's own surface,
       * because a bg-2 chip on a bg-2 row would vanish.
       */
      navCount: {
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        minWidth: 22,
        height: 20,
        padding: '0 6px',
        borderRadius: RADIUS.pill,
        background: TOKEN.bg2,
        color: TOKEN.text2,
        fontSize: 11.5,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1,
      },
      navCountActive: { background: TOKEN.bg, color: TOKEN.text },
      /** The list's column, and the row the list and the detail share. */
      main: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
      /**
       * The content column: one track, because the list and the entry take
       * turns in it. The host dialog is a fixed 800px, and the panel keeps
       * about 560px of that — splitting those 377px of content in two would
       * leave each side too narrow to read a value in.
       */
      split: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16, alignItems: 'start', minWidth: 0 },
      /** The favicon that replaces the monogram tile once the server has one. */
      avatarImg: { width: 18, height: 18, borderRadius: 3, objectFit: 'contain' },
      /** The same favicon in the detail header's larger 36px tile. */
      avatarImgLg: { width: 22, height: 22, borderRadius: 4, objectFit: 'contain' },
      /**
       * The small control that sits inside a field row: 复制, 显示 / 隐藏, the
       * 验证码 row's copy, 读取这一项.
       *
       * One definition, because they are always seen together. They used to be
       * three nearly-identical literals at 28 / 30 / 32px with 12 / 12.5 / 13px
       * labels, so 显示 beside 复制 in the same row came out at different
       * heights and the pair read as two unrelated controls. Everything in a
       * row now shares this box: same height, same padding, same label size —
       * and `flex: none` so a long value beside them cannot squash either one.
       */
      inlineButton: {
        height: 28,
        padding: '0 11px',
        borderRadius: RADIUS.sm,
        border: `1px solid ${TOKEN.borderStrong}`,
        background: 'transparent',
        color: TOKEN.text,
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        flex: 'none',
      },
      /** The copy control beside a code in the 验证码 list — the same box. */
      /**
       * The in-row control as a square icon slot: 28px, same height and radius
       * as inlineButton, with the glyph centred.
       *
       * A square is what lets 显示 and 复制 sit in one row without the pair
       * reading as two different widgets: both are the same box, and the reader
       * tells them apart by the drawing rather than by the width of a word. The
       * label is not lost — it moves into the native tooltip and the accessible
       * name, which is also what an icon-only control is required to carry.
       */
      inlineIconButton: {
        height: 28,
        width: 28,
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: RADIUS.sm,
        border: `1px solid ${TOKEN.borderStrong}`,
        background: 'transparent',
        color: TOKEN.text,
        cursor: 'pointer',
        flex: 'none',
      },
      /**
       * The write actions (编辑 / 归档 / 移入回收站 / 移动到文件夹) as icon
       * buttons: one square each, no label, no border.
       *
       * They used to be plain text buttons of four different widths, and the
       * two longest ("移入回收站", "移动到文件夹") were what pushed the row past
       * the card at phone widths. Four glyphs on one line fix that.
       *
       * 28px is the row-control size the field rows already use, and the
       * border is dropped on purpose: a footer strip of four outlined boxes
       * read as heavy chrome at the bottom of every entry (reported as "肥大"),
       * while a glyph with a hover wash is how a footer toolbar normally looks.
       * The glyph supplies the hit target's meaning, the title supplies the
       * words, and the square keeps the row's rhythm.
       */
      actionBadge: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        borderRadius: RADIUS.sm,
        border: '1px solid transparent',
        background: 'transparent',
        color: TOKEN.text2,
        cursor: 'pointer',
        flex: 'none',
      },
      /** A destructive action reads as one before it is hovered, not after. */

      // The list and the detail pane are cards in the host's sense: one hairline
      // border, a soft surface, and a generous radius.
      card: { border: `1px solid ${TOKEN.border}`, borderRadius: RADIUS.lg, background: TOKEN.bg, overflow: 'hidden' },
      list: { border: `1px solid ${TOKEN.border}`, borderRadius: RADIUS.lg, background: TOKEN.bg, overflow: 'hidden' },
      listRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        // The row is `width:100%` with its own padding, so the box model has
        // to be border-box. A <button> row gets that from the UA stylesheet
        // and a <div> row (the 验证码 place, whose rows cannot nest a button)
        // does not: without this the code row was 28px wider than the list
        // and its copy control was clipped at the panel's right edge.
        boxSizing: 'border-box',
        padding: '12px 14px',
        border: 0,
        background: 'transparent',
        color: TOKEN.text,
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 13.5,
        minWidth: 0,
        // The hover island is positioned against the row, not against a
        // wrapper: the row itself has to be the containing block, otherwise
        // the island would sit outside the list's rounded corners.
        position: 'relative',
      },
      /**
       * The row's hover island: copy the account, copy the password, without
       * opening the card first.
       *
       * It is laid OVER the row's right edge rather than in the flow, because
       * a control that appears on hover must not re-flow the row: an entry
       * whose name is long enough to be clipped would lose its last letters the
       * moment the pointer arrived. The background is the row's own surface, so
       * the island covers the badges underneath instead of stacking on them.
       */
      rowActions: {
        position: 'absolute',
        top: '50%',
        right: 10,
        transform: 'translateY(-50%)',
        // Display is deliberately NOT set here. The island only exists on a
        // device that can hover, and that is a stylesheet decision: the base
        // rule hides it (display: none), the hover media query puts it back.
        // An inline display would beat both and leave a transparent box lying
        // over the row's badges on every touch phone.
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: RADIUS.md,
        border: `1px solid ${TOKEN.border}`,
        background: TOKEN.bg,
      },
      /**
       * One control inside the hover island: the same quiet square the card's
       * write actions wear, one step smaller (24 vs 28) because it sits on a
       * 36px row instead of a padded card footer.
       */
      rowActionBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        padding: 0,
        border: 0,
        borderRadius: RADIUS.sm,
        background: 'transparent',
        color: TOKEN.text2,
        cursor: 'pointer',
        flex: 'none',
      },
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
      // `start` rather than `center`: a row's value can be one line or five
      // (a URL wraps, a note wraps), and centring the label and the controls
      // against a five-line value drops them into the middle of it while a
      // one-line value puts them level with it — the column then has no
      // consistent baseline to read down. Top-aligned, the label and the first
      // line of the value always share a line, and the controls sit level with
      // them, whatever the value's length.
      fieldRow: { display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr) auto', gap: 12, alignItems: 'start', fontSize: 13 },
      fieldLabel: { fontSize: 12, color: TOKEN.text2 },
      fieldValue: { fontSize: 13.5, color: TOKEN.text, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5 },
      /**
       * The masked value: eight bullets standing in for a secret.
       *
       * The bullets are full-width glyphs at the body size — eight of them
       * measure ~108px, which is wider than the value column a field row has
       * once its label and its two controls have taken their share. The mask
       * then wrapped onto a second line, which does not read as "hidden" but
       * as "this value is broken", and it pushed the buttons down with it. A
       * slightly smaller size with negative tracking brings the run to ~78px:
       * one line at every panel width the row is laid out in.
       */
      mask: { fontSize: 12, letterSpacing: '-0.6px', color: TOKEN.text, overflowWrap: 'normal', wordBreak: 'keep-all', whiteSpace: 'nowrap', minWidth: 0 },
      /** TOTP countdown: a groove-sized box with the remaining seconds in the middle. */
      totpRing: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, flex: 'none' },
      totpRingText: { fontSize: 11.5, fontWeight: 600, lineHeight: 1, fontVariantNumeric: 'tabular-nums' },
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
      /**
       * A square icon-only button: the toolbar's three actions.
       *
       * Square so a row of them reads as one control family, and `flex: none`
       * so a narrow panel cannot compress the glyph into a smudge. The label
       * lives in `title`/`aria-label` instead of text, which is what makes the
       * row fit at phone width.
       */
      iconButton: {
        height: CONTROL_HEIGHT,
        width: CONTROL_HEIGHT,
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        borderRadius: RADIUS.md,
        border: `1px solid ${TOKEN.borderStrong}`,
        background: 'transparent',
        color: TOKEN.text,
        cursor: 'pointer',
      },

      ok: { fontSize: 12.5, color: TOKEN.ok },
      error: { fontSize: 12.5, color: TOKEN.err, lineHeight: 1.5 },
      dot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: TOKEN.text, border: `1px solid ${TOKEN.border}`, borderRadius: RADIUS.pill, padding: '4px 11px' },
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
      /** A select sized to its own content, so the row stays one line on a desktop. */
      filterSelect: {
        boxSizing: 'border-box',
        height: CONTROL_HEIGHT,
        padding: '0 8px',
        borderRadius: RADIUS.md,
        border: `1px solid ${TOKEN.borderStrong}`,
        background: TOKEN.bg,
        color: TOKEN.text,
        fontSize: 13,
        outline: 'none',
        maxWidth: 180,
      },
      /** Inline notice: a quiet card used for banners and the confirm step. */
      banner: { border: `1px solid ${TOKEN.border}`, borderRadius: RADIUS.md, background: TOKEN.bg2, padding: '8px 12px', fontSize: 12.5, color: TOKEN.text2, lineHeight: 1.6 },
      /**
       * The action strip at the foot of the detail pane — a footer, not a
       * section.
       *
       * It used to be a headed block ("操作" + four labelled buttons) that took
       * two lines and sat wherever the fields happened to end. It is now one
       * hairline rule with a single row of icon buttons pinned to its end: the
       * same place in every entry, so the controls are learned once, and one
       * line tall, so the card ends where its content does.
       *
       * The negative margins let the rule reach the card's own edges while the
       * buttons keep the detail pane's inner padding — the same trick the
       * card's top rule uses, and what stops the footer looking inset.
       */
      actions: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4, marginInline: -20, paddingInline: 20, borderTop: `1px solid ${TOKEN.border}`, paddingTop: 12 },
      // `minWidth: 0` lets the row actually wrap inside the detail card: a
      // wrapping flex row still measures its longest item, so one wide item
      // pushed the row — and the card with it — past the panel's right edge at
      // phone widths. `justifyContent: flex-end` is what makes it read as a
      // toolbar: the controls sit together at the end of the rule rather than
      // drifting from the left edge.
      actionRow: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', minWidth: 0, maxWidth: '100%' },
      /** The confirmation step: same card, but in the warning colour. */
      confirmBox: { border: `1px solid ${TOKEN.warn}`, borderRadius: RADIUS.md, background: TOKEN.bg, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
      /** A collapsed section header (attachments, password history). */
      foldHead: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: TOKEN.text2, background: 'transparent', border: 0, padding: 0, cursor: 'pointer' },
      /** One history row: the password, then when it was retired. */
      historyRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center' },
      attachmentRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center', fontSize: 12.5 },

      /**
       * The loading placeholder: a grey bar standing in for a line of text.
       *
       * Every surface that used to print the word "同步中" now draws the shape
       * of what is coming instead. A word in the middle of a blank card is the
       * one thing that makes a panel feel like a web page waiting on a server;
       * a placeholder with the right silhouette reads as the content arriving.
       * The pulse is in the stylesheet, so a reader who asked for reduced motion
       * gets a static bar rather than a blinking one.
       */
      // The host's border colour, not `bg2`. `bg2` is a layer tint (#f5f5f5 on
      // a white surface), and a bar painted in it is invisible on the panel's
      // own background: the rail then reads as an empty box rather than as
      // "still loading". The border token is by definition visible against the
      // surface it borders, in both themes, and no browser-support question
      // attaches to it the way it would to a colour mix.
      // The skeleton's ink. It was TOKEN.bg2 (a near-white layer colour) and
      // then TOKEN.border, and both were too pale once the shared pulse halved
      // them: #d9d9d9 at 50% opacity lands on #ececec, which on a white panel is
      // a placeholder nobody can see — the shape of a loading panel that reads
      // as an empty one. The strong border keeps a visible bar through the
      // whole pulse (175 by 225) without competing with real text, and it is a
      // themed token, so the dark theme gets a bar that reads there too.
      skeletonBar: { height: 10, borderRadius: 999, background: SKELETON_INK, flex: 'none' },
      /**
       * A skeleton line: label column + value bar, one per field row.
       *
       * The columns are S.fieldRow's, not a copy with a guess in it. The ghost
       * row used to reserve a fixed 28px third column for a control it does not
       * have, which squeezed the value column 40px narrower than the answered
       * row's — so the placeholder's bars and the real values did not start or
       * end in the same place, and the card visibly re-laid itself out at the
       * moment the answer arrived. 'start' matches too: a real row puts the
       * label and the value flush with the row's top edge, and a ghost row
       * centred in a taller box does not.
       */
      skeletonField: { display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr) auto', gap: 12, alignItems: 'start' },
      /** The list's own placeholder row: avatar tile + two bars + the chevron slot. */
      skeletonRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', boxSizing: 'border-box', width: '100%' },
    }
    // The 验证码 row's copy control is the same box as every other in-row
    // control; keeping it as a named alias means a future tweak to the size
    // cannot leave that one row behind (which is how 显示 and 复制 ended up at
    // different heights in the first place).

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
/* The title row's repo link: a 11.5px link beside a 16px title must not carry
   a permanent underline (it reads as a heading with a stray rule under it), so
   the underline arrives on hover — which still satisfies "visibly a link" for
   a pointer user, and the link colour plus the GitHub mark carry it otherwise. */
.vw-root [data-vw-repo] { transition: color .12s ease, background-color .12s ease }
/* Hover deepens the ink rather than switching hue: the link lives inside a
   grey metadata line, and a colour change there would read as a different
   kind of element rather than the same one focused. */
.vw-root [data-vw-repo]:hover { color: ${TOKEN.text}; text-decoration: underline; text-underline-offset: 2px }
.vw-root [data-vw-repo]:focus-visible { color: ${TOKEN.text}; outline: 2px solid ${TOKEN.borderStrong}; outline-offset: 2px; text-decoration: underline; text-underline-offset: 2px }
.vw-root button[data-variant="primary"]:not(:disabled):hover { opacity: .88; border-color: transparent }
.vw-root input:focus, .vw-root select:focus { border-color: ${TOKEN.accent}; box-shadow: 0 0 0 3px color-mix(in srgb, ${TOKEN.accent} 18%, transparent) }
.vw-root [data-row]:not([aria-selected="true"]):hover { background: ${TOKEN.bg2} }
.vw-root [data-row][aria-selected="true"] { background: ${TOKEN.bg2} }
.vw-root [data-row] + [data-row] { border-top: 1px solid ${TOKEN.border} }
.vw-root ::placeholder { color: ${TOKEN.text2}; opacity: .75 }
/* The countdown ring: between two once-a-second answers the arc sweeps to its
   new length and the tone eases across, so the ring reads as a clock rather
   than a set of steps. Readers who ask for reduced motion keep the steps. */
/* ── the row's glyph controls ─────────────────────────────────────────
   A square icon slot has no text to widen on hover, so the affordance is a
   wash plus a darker ink: the shared button rule above only moves the border
   colour, which on a 28px square is a 1px change nobody notices. The wash is
   the host's own hover layer, so it follows both themes. */
.vw-root [data-vw-icon-btn]:not(:disabled):hover { background: ${TOKEN.bg2}; color: ${TOKEN.text} }
.vw-root [data-vw-icon-btn]:focus-visible { outline: 2px solid ${TOKEN.accent}; outline-offset: 2px }
/* ── the write actions as badges ──────────────────────────────────────
   Same idea one size up: the glyph and the label are one control, so the
   whole chip lights up together. A destructive badge keeps its red ink
   through the hover — a wash is the change, not the colour. */
/* The footer strip: a wash and the panel's own ink on hover. The glyphs sit at
   the secondary ink at rest so four of them do not out-shout the entry they
   belong to; hovering the one you mean brings it forward. */
.vw-root [data-vw-action]:not(:disabled):hover { background: ${TOKEN.bg2}; color: ${TOKEN.text} }
.vw-root [data-vw-action]:focus-visible { outline: 2px solid ${TOKEN.accent}; outline-offset: 2px }
.vw-root [data-vw-totp-ring] { transition: stroke-dashoffset 1s linear, stroke .35s ease }
@media (prefers-reduced-motion: reduce) {
  .vw-root [data-vw-totp-ring] { transition: none }
}
.vw-root { scrollbar-width: thin }
/* ══ motion ═══════════════════════════════════════════════════════════
   The panel used to switch states by swapping one tree for another: rows
   vanished, a word appeared, rows came back. Every one of those swaps was a
   flash, and a flash on a surface that holds passwords reads as "unfinished".
   The rules below give each swap a shape — a fade, a short slide, a stagger —
   so the same state change now reads as the panel turning a page.

   Two rules govern everything here:

     1. Nothing moves further than 6px. This is a settings panel inside a
        dialog, not a splash screen; distance is what makes motion feel slow.
     2. Everything is opt-out under prefers-reduced-motion. A reader who asked
        their OS for less motion gets the end state immediately, never a
        half-finished animation.

   Durations are on a 3-step scale so the whole panel has one tempo:
     --vw-fast   120ms   a control acknowledging a press (hover, focus, copy tick)
     --vw-base   180ms   content appearing (a list, a detail card)
     --vw-slow   260ms   a whole surface swapping (sign-in form → vault)
   ────────────────────────────────────────────────────────────────────── */
:root {
  --vw-fast: 120ms;
  --vw-base: 180ms;
  --vw-slow: 260ms;
  --vw-ease: cubic-bezier(.2, .7, .3, 1);
  --vw-ease-out: cubic-bezier(.16, 1, .3, 1);
}

/* ── content appearing ────────────────────────────────────────────────
   A list, a detail card, a form: each arrives with a 4px lift and a fade.
   The lift is what stops a same-size swap (one list replaced by another)
   from reading as a jump-cut: the eye catches that something moved. */
.vw-root [data-vw-anim="in"] { animation: vw-fade-up var(--vw-base) var(--vw-ease-out) both }

/* A whole surface swapping (sign-in form ↔ vault ↔ setup): longer, and it
   comes down from slightly higher because the panel itself is changing. */
.vw-root [data-vw-anim="surface"] { animation: vw-fade-up var(--vw-slow) var(--vw-ease-out) both }

/* ── the list arriving ────────────────────────────────────────────────
   The rows stagger instead of all appearing at once: 18ms apart, capped at
   the first ten (a 400-row vault must not take 7 seconds to become visible,
   and past ten the eye has stopped counting). This is the single change that
   most made the panel stop looking like it was "loading": a page of rows
   arriving in order reads as data streaming in, where a block of rows
   appearing at once reads as a repaint. */
.vw-root [data-vw-list] > [data-row] { animation: vw-row-in var(--vw-base) var(--vw-ease-out) both }
.vw-root [data-vw-list] > [data-row]:nth-child(1) { animation-delay: 0ms }
.vw-root [data-vw-list] > [data-row]:nth-child(2) { animation-delay: 18ms }
.vw-root [data-vw-list] > [data-row]:nth-child(3) { animation-delay: 36ms }
.vw-root [data-vw-list] > [data-row]:nth-child(4) { animation-delay: 54ms }
.vw-root [data-vw-list] > [data-row]:nth-child(5) { animation-delay: 72ms }
.vw-root [data-vw-list] > [data-row]:nth-child(6) { animation-delay: 90ms }
.vw-root [data-vw-list] > [data-row]:nth-child(7) { animation-delay: 108ms }
.vw-root [data-vw-list] > [data-row]:nth-child(8) { animation-delay: 126ms }
.vw-root [data-vw-list] > [data-row]:nth-child(9) { animation-delay: 144ms }
.vw-root [data-vw-list] > [data-row]:nth-child(n + 10) { animation-delay: 162ms }

/* ── the detail pane opening ──────────────────────────────────────────
   Opening an entry slides its card in from the right on the wide layout
   (where it appears beside the list) and from below on the narrow one
   (where it replaces the list). The direction is the story: "this came from
   the row you clicked" on wide, "this is the next screen" on narrow. */
.vw-root [data-vw-detail] { animation: vw-detail-in-wide var(--vw-base) var(--vw-ease-out) both }
@container vw-panel (max-width: 480px) {
  .vw-root [data-vw-detail] { animation-name: vw-detail-in-narrow }
}

/* ── the skeleton ─────────────────────────────────────────────────────
   A placeholder pulse, not a spinner: the shape of the answer is already on
   screen, so the only thing left to animate is that it is not final yet.
   The pulse is an opacity ramp on the card, not on each bar, so the whole
   placeholder breathes as one object. */
.vw-root [data-vw-skeleton] { animation: vw-pulse 1.4s ease-in-out infinite }

/* ── a state swap that must not flash ─────────────────────────────────
   The rows stay mounted while a read is in flight (see refreshing), and
   this dims them a touch so "these are the old rows" is visible without
   taking them away. 0.55 is deliberate: readable enough to keep reading,
   washed out enough to read as provisional. */
.vw-root [data-vw-stale="1"] { transition: opacity var(--vw-base) var(--vw-ease) }
.vw-root [data-vw-stale="1"] [data-row] { opacity: .55 }

@keyframes vw-fade-up {
  from { opacity: 0; transform: translateY(4px) }
  to   { opacity: 1; transform: none }
}
@keyframes vw-row-in {
  from { opacity: 0; transform: translateY(3px) }
  to   { opacity: 1; transform: none }
}
@keyframes vw-detail-in-wide {
  from { opacity: 0; transform: translateX(6px) }
  to   { opacity: 1; transform: none }
}
@keyframes vw-detail-in-narrow {
  from { opacity: 0; transform: translateY(6px) }
  to   { opacity: 1; transform: none }
}
@keyframes vw-pulse {
  0%, 100% { opacity: .5 }
  50%      { opacity: .85 }
}

/* ── the tick that replaces the glyph ─────────────────────────────────
   Copying a secret is the one action here whose result the reader cannot
   see — the clipboard is not on screen — so the confirmation has to be
   physical: the drawing itself turns into a tick and pops once on the way.
   Scale 1 → .86 → 1.06 → 1 over one base beat. The dip is what makes it
   read as a replacement rather than a second icon fading in over the
   first. Only the icon form morphs: the text form already has the word
   "已复制" to say it, and scaling words is noise. */
.vw-root [data-vw-copied="true"] svg { animation: vw-tick var(--vw-base) var(--vw-ease-out) both; transform-origin: 50% 50% }
@keyframes vw-tick {
  0%   { transform: scale(1) }
  35%  { transform: scale(.86) }
  70%  { transform: scale(1.06) }
  100% { transform: scale(1) }
}

/* ── the sync dot, breathing ──────────────────────────────────────────
   A still dot is a light that may or may not be on. Two layers say it is
   alive without saying it is busy: the dot itself swells a quarter and
   dims, and a copy of it spreads outward and fades. The outer layer is
   the same circle, so the whole thing collapses to a plain dot in a
   browser that ignores animations — which is the correct fallback, since
   the label beside it already spells the state out in words. 2.4s is
   deliberately slower than the 1.4s skeleton pulse: one is "not final
   yet" (urgent), this is "still here" (reassuring). */
.vw-root [data-vw-sync-dot] { position: relative; background: currentColor }
.vw-root [data-vw-sync-dot="ok"],
.vw-root [data-vw-sync-dot="warn"] { animation: vw-breathe 2.4s var(--vw-ease) infinite }
.vw-root [data-vw-sync-dot="ok"]::after,
.vw-root [data-vw-sync-dot="warn"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: currentColor;
  animation: vw-ping 2.4s var(--vw-ease) infinite;
}
@keyframes vw-breathe {
  0%, 100% { transform: scale(1); opacity: 1 }
  50%      { transform: scale(1.22); opacity: .62 }
}
@keyframes vw-ping {
  0%   { transform: scale(1); opacity: .34 }
  70%  { transform: scale(2.7); opacity: 0 }
  100% { transform: scale(2.7); opacity: 0 }
}

/* ── the row's quick actions, on hover ────────────────────────────────
   The detail card is where a secret is edited; it should not be where a
   secret is only ever *read*, because copying an account name is the
   common case and opening a card to do it is two clicks of ceremony.
   Hovering (or focusing into) a row slides a small island of copy
   controls in at its right edge and hides the chevron, which is
   decoration: the row is still clickable at the same hit area. Touch
   devices never fire a real hover, so the island is only built behind
   hover:hover — on a phone the same controls stay where they were, in
   the card. */
/* The island does not exist off a hover device: display:none, not
   opacity:0. A transparent box still swallows taps, and on a phone the
   tap lands on the row and opens the card, which is what it should do. */
.vw-root [data-row] [data-vw-row-actions] { display: none }
@media (hover: hover) {
  .vw-root [data-row] [data-vw-row-actions] {
    display: inline-flex;
    opacity: 0;
    transition: opacity var(--vw-fast) var(--vw-ease);
  }
  .vw-root [data-row] [data-vw-row-chevron] { transition: opacity var(--vw-fast) var(--vw-ease) }
  .vw-root [data-row]:hover [data-vw-row-actions],
  .vw-root [data-row]:focus-within [data-vw-row-actions] { opacity: 1 }
  .vw-root [data-row]:hover [data-vw-row-chevron],
  .vw-root [data-row]:focus-within [data-vw-row-chevron] { opacity: 0 }
}

/* ── the sidebar counting, then filling in ────────────────────────────
   The rail has two states and one shape. Before the counts arrive it draws
   eleven ghost slots in the real rows' own metrics; when the answer lands it
   draws eleven real rows in the same slots. Because the two trees measure the
   same, the rail's box never changes height — measured 418px either way on a
   real vault — so the list beside it never moves and nothing below it reflows.

   Two rules follow, and the second one is a correction:

     1. The rail does not animate its height at all. It used to declare
        a "transition: height" "so the box grows rather than jumps" — which never
        did anything, because the rail's height is auto and a browser cannot
        interpolate auto to auto. It was motion theatre: a rule that reads
        like a fix, sitting exactly where the real fix belongs. The real fix is
        that the skeleton measures what the answer measures, so there is no
        height change to smooth. The two cases where the shape genuinely does
        differ — a vault with more folders than slots, and the failure fallback
        that drops back to three rows — land in one frame, and one frame is
        honest for a change that is itself a correction, not an arrival.

     2. The rail does not animate its arrival either. It is chrome, not
        content: the same places are on screen for as long as the panel is
        open, they are the control the reader keeps pressing, and the answers
        behind them change while the rail does not. A staggered fade said
        "here is new content" about something that had been there the whole
        time — and worse, every frame that re-inserted the rail replayed the
        whole arrival. The phone's drill state did exactly that: it took the
        rail out of the layout and put eleven rows back when the reader
        returned to the list, so 返回列表 looked like the sidebar flashing.
        The rail now appears in one frame, the way its ghost slots do, and the
        panel keeps its one staggered arrival for the thing that arrival was
        written for: a page of entries filling in ([data-vw-list] >
        [data-row] below). Headings, which used to arrive a beat ahead of
        their rows, arrive with them: there is no arrival left to order.
   ────────────────────────────────────────────────────────────────────── */

/* The ghost slots do not stagger: they are one object saying "counting", and
   they were already on screen when the panel opened. Their only motion is the
   shared pulse below. */
.vw-root [data-vw-ghost-row],
.vw-root [data-vw-ghost-group] { transition: none }

/* ── the sidebar's selection ──────────────────────────────────────────
   The active place is a wash that eases in rather than a colour that snaps.
   Two reasons: a snapped background on a 12px-padding row reads as a
   repaint, and the sidebar is the control the reader presses most — every
   press being a hard cut is most of what made the panel feel abrupt.
   Backgrounds and inks only; no size or position changes, so nothing
   reflows while the list beside it is loading. */
.vw-root [data-vw-section] { transition: background-color var(--vw-fast) var(--vw-ease), color var(--vw-fast) var(--vw-ease) }
.vw-root [data-vw-section] [data-vw-section-icon] { transition: color var(--vw-fast) var(--vw-ease) }
/* The entry rows: the selection wash and the hover wash arrive the same way. */
.vw-root [data-row] { transition: background-color var(--vw-fast) var(--vw-ease) }
/* ── focus ────────────────────────────────────────────────────────────
   One ring for the whole panel, on :focus-visible only. The rows and the
   sidebar are a list of buttons; without a shared rule a keyboard reader
   gets the browser's default ring on some controls and nothing at all on
   the ones whose inline style set outline:none (every input and select in
   the editor did). 2px at offset 2, in the accent, is the host's own
   convention — and it is the one affordance that makes a keyboard reader
   feel the panel was built rather than assembled. */
.vw-root :focus-visible { outline: 2px solid ${TOKEN.accent}; outline-offset: 2px }
.vw-root [data-row]:focus-visible { outline-offset: -2px }
/* ── reduced motion ───────────────────────────────────────────────────
   The end state, immediately. Not a shorter animation: a reader who turned
   this on did not ask for a quicker flash, they asked for none. */
@media (prefers-reduced-motion: reduce) {
  .vw-root [data-vw-anim],
  .vw-root [data-vw-detail],
  .vw-root [data-vw-list] > [data-row],
  .vw-root [data-vw-skeleton],
  /* The two arrivals that are new with the island and the sync dot. The tick
     still has to say "copied", so it is not removed — it is cut to a plain
     colour change by dropping the shape animation. The breathing dot and its
     ping ring are pure decoration on top of a colour that already carries the
     state, so they go entirely. */
  .vw-root [data-vw-copied="true"] svg,
  .vw-root [data-vw-sync-dot],
  .vw-root [data-vw-sync-dot]::after {
    animation: none !important
  }
  .vw-root [data-vw-skeleton] { opacity: .6 }
  .vw-root [data-vw-row-actions],
  .vw-root [data-vw-row-chevron] { transition: none !important }
  .vw-root button { transition: none }
}
/* ── the settings nav row's own glyph ──────────────────────────────────
   The host's settings nav hands every plugin section the generic gear; a
   plugin cannot register an icon there, so the label (VaultNavLabel) draws
   the glyph itself and hides that gear. The glyph simply takes the gear's
   place in the row's own flex flow, so the text keeps landing exactly where
   every other row's text sits — no measured offsets, no negative margins
   that could push the label out of its cell on a tight layout. */
.vw-nav-label { display: inline-flex; align-items: center; gap: 8px; min-width: 0 }
/* 18px, matching the component's own default: the badge is a two-shape mark and
   its plate needs the extra 2px to stay separate from the shield at this size. */
.vw-nav-glyph { flex: none; width: 18px; height: 18px; color: inherit }
.vw-nav-text { white-space: nowrap }
/* The sidebar's own hover: its rows carry no border, so the shared button
   hover (which only moves a border colour) would say nothing there. */
.vw-root [data-vw-section]:not([aria-current="true"]):hover { background: ${TOKEN.bg2} }
/* ── the panel's own breakpoint ───────────────────────────────────────
   The panel measures itself, not the window: the host's settings dialog
   is a fixed 800px wide — about 280px of it is the settings navigation —
   so a viewport query never sees the ~560px the panel actually gets. The
   sidebar rail stays as long as a content column beside it is worth
   having; below that it takes the top row, and the drill state hides it
   the way a phone does. */
@container vw-panel (max-width: 480px) {
  .vw-root [data-vw-body] { grid-template-columns: minmax(0, 1fr) !important }
  /* The rail carries an inline display:flex (see S.nav), and an inline
     declaration outranks every selector that is not !important — so without
     it here the rail was never hidden in the drill state: it kept the whole
     content column and pushed the entry (and its editor) below the fold. The
     list rule just below needs nothing because that element has no inline
     display; this one is the asymmetry. */
  .vw-root [data-vw-body][data-vw-drill="1"] [data-vw-nav] { display: none !important }
  /* The rail takes the top row here — it stays pinned (see the coarse-pointer
     block just below), and a sticky element taller than the scrollport simply
     scrolls with it until its own end is in view, so the places stay reachable
     however many folders the vault has. No height cap: capping it clipped the
     last row mid-height, which reads as a broken box rather than a scroller. */
  /* On a phone the label takes a line of its own and the value and its
     controls share the second row: value on the left, the one or two 28px
     glyph slots pinned to the right edge.
     They used to be dropped onto a third line, because 显示 and 复制 were
     28px-wide TEXT buttons that no column could share with a value. As square
     glyph slots the pair is 62px with its gap, so the value keeps the rest of
     the line and the row is two lines tall instead of three — which, on the
     screen that can least afford it, was costing every secret row ~34px. */
  .vw-root [data-vw-field] { grid-template-columns: minmax(0, 1fr) auto !important; gap: 4px 8px !important }
  .vw-root [data-vw-field] > *:first-child { grid-column: 1 / -1 }
  .vw-root [data-vw-field] > [data-vw-field-ctl] { justify-self: end; align-self: center }
  /* A row whose trailing cell is not a control group (a bare icon button, the
     TOTP value) still ends at the right edge rather than starting the line. */
  .vw-root [data-vw-field] > *:last-child:not(:first-child) { justify-self: end; align-self: center }
  /* …except the code, which is a reading, not a control. Pinned to the right
     edge it sat alone in the far corner, 400px from the label that names it —
     on the one screen where the two are already on separate lines. It starts
     where the value column starts, like every other value.

     The selector repeats the trailing-cell shape it overrides
     (:last-child:not(:first-child), specificity 0,4,0) instead of naming the
     cell once: written as .vw-root [data-vw-field] > [data-vw-totp-cell] it
     was 0,3,0, so the rule it was meant to beat still won and a phone kept
     drawing the code in the far corner. Matching the shape keeps the two in
     the same weight class and lets document order decide — this one is
     second. */
  .vw-root [data-vw-field] > [data-vw-totp-cell]:last-child:not(:first-child) { justify-self: start; align-self: center; min-width: 0 }
  .vw-root [data-vw-field] > [data-vw-totp-cell] [data-vw-field-ctl] { justify-self: end }
}
/* ── the rail steps down for a finger, never for a small window ────────
   The unpin used to follow the panel width alone, and a mouse user paid for
   it: any window under ~800px (or the drill state inside the phone-wide
   host dialog) dropped the panel below 480px and the places went off the
   top together with the entries — the filter the reader was standing in
   left the screen. A finger is the one case that wants the other
   behaviour: there the panel is the whole screen, the rail belongs above
   the list, and holding it pinned would keep the places over the entries.
   So the unpin is gated on a coarse pointer; a mouse keeps the rail pinned
   at any width. The window-based fallback below repeats the split for
   browsers without container queries. */
@media (pointer: coarse) {
  @container vw-panel (max-width: 480px) {
    .vw-root [data-vw-nav] { position: static !important }
  }
}
/* Browsers without container queries fall back to the window: the dialog
   shrinks with the window and the panel loses the same ~280px to the
   settings navigation, so the same step happens at ~760px of window. */
@supports not (container-type: inline-size) {
  @media (max-width: 760px) {
    .vw-root [data-vw-body] { grid-template-columns: minmax(0, 1fr) !important }
    .vw-root [data-vw-body][data-vw-drill="1"] [data-vw-nav] { display: none !important }
    .vw-root [data-vw-field] { grid-template-columns: minmax(0, 1fr) auto !important; gap: 4px 8px !important }
    .vw-root [data-vw-field] > *:first-child { grid-column: 1 / -1 }
    /* The same toolbar re-flow as the container query above, for a browser
       that cannot measure the panel itself. */
    .vw-root [data-vw-toolbar] { grid-template-columns: auto minmax(0, 1fr) auto !important }
    .vw-root [data-vw-toolbar] [data-vw-search] { grid-column: 1 / -1; max-width: none !important }
    .vw-root [data-vw-toolbar] [data-vw-actions] { grid-column: 3 }
  }
  /* Only a finger takes the rail down here too: a narrow mouse window keeps
     the pinned rail, exactly as in the container-query branch above. */
  @media (max-width: 760px) and (pointer: coarse) {
    .vw-root [data-vw-nav] { position: static !important }
  }
}
/* An open entry takes the content column whole (see S.split); the row that
   says so — and leads back to the list — is the reader's only way back. */
.vw-root [data-vw-body][data-vw-drill="1"] [data-vw-list] { display: none }
/* A middle step for a content column too narrow for the 92px gutter the wide
   panel uses but still wide enough for a label beside its value. It is
   declared BEFORE the 480px query above in document order, which is what lets
   that query's stacking rule win where both apply — the two used to be in the
   opposite order with equal specificity, so the gutter always survived and
   the stacking step never ran at any width. */
@container vw-panel (min-width: 481px) and (max-width: 620px) {
  .vw-root [data-vw-field] { grid-template-columns: 72px minmax(0, 1fr) auto !important; gap: 8px !important }
}
/* ── narrow screens ───────────────────────────────────────────────────
   Inline styles cannot be reached by a container query, so the
   declarations below override them with !important. They only re-flow what
   is already there: no colour, no size, nothing that would differ between
   themes. */
/* Once the panel is phone-wide the four toolbar tracks stop fitting one
   row: the search box collapses to a sliver beside the sync chip. So the
   search box takes a row of its own and the row below it keeps the chip on
   the left and the two actions against the right edge. The actions used to
   span a whole third row, which left 设置/刷新 floating under an empty
   half-line. The track list is set inline, hence !important; the flexible
   track is the one the count sits in, never the chip's. */
@container vw-panel (max-width: 520px) {
  .vw-root [data-vw-toolbar] { grid-template-columns: auto minmax(0, 1fr) auto !important }
  .vw-root [data-vw-toolbar] [data-vw-search] { grid-column: 1 / -1; max-width: none !important }
  .vw-root [data-vw-toolbar] [data-vw-actions] { grid-column: 3 }
}
/* ── the panel is a sliver ────────────────────────────────────────────
   The host's settings dialog can leave this panel ~110px on a phone (a
   fixed-width dialog minus its navigation column), and at that width three
   tracks cannot hold anything: the chip needs 70px and the three action
   buttons 112px together, so the count's flexible track collapsed to zero
   and its text painted straight through the buttons — "共 426 条" ran across
   the + and the gear. Below the point where a row can hold two controls, each
   one takes a row of its own: nothing overlaps, and every control keeps a
   tappable width. The actions go left with the rest, because right-aligning
   them against a 110px edge reads as an accident. */
@container vw-panel (max-width: 300px) {
  /* The title row's meta cluster (version + repo link) is secondary: at the
     narrowest step it drops to its own line instead of squeezing the title,
     and it never hides — a version and a way to the source are exactly the
     things a reader on an unfamiliar install wants. */
  .vw-root [data-vw-note] { flex-basis: 100% !important; margin-top: 2px }
  /* The detail header is a 36px tile + name + marks on one line; below this
     width the name is down to a few characters and the marks sit on top of it.
     Stacking costs one line and keeps the name readable — which is the one
     thing a header has to do. */
  .vw-root [data-vw-head] { flex-wrap: wrap !important; row-gap: 6px !important }
  .vw-root [data-vw-head] > div { flex-basis: 100% !important }
  .vw-root [data-vw-toolbar] { grid-template-columns: minmax(0, 1fr) !important; justify-items: start }
  .vw-root [data-vw-toolbar] > * { grid-column: 1 !important; max-width: 100% }
  /* The mask is eight dots at the body size; in a 62px column that is two
     lines of four, which reads as a broken value rather than a masked one.
     Tighter dots keep the mask on one line down to the narrowest panel. */
  .vw-root [data-vw-field] > span { letter-spacing: -0.5px }
  .vw-root [data-vw-field] { font-size: 12.5px !important }
  /* The text controls in this block (确认 / 取消, the reprompt's 解锁) carry
     labels, and a wrapping flex row still floors at its widest item — so at
     this width the row stuck out of the card no matter how it wrapped. Letting
     those labels wrap inside their own button keeps every control inside the
     card, and a two-line button is still one tappable target. The icon
     squares are excluded: they have no text to wrap, and stretching them into
     a taller box would break the one row they are sized to fit. */
  .vw-root [data-vw-actions] button:not([data-vw-icon-btn]) { max-width: 100% !important; height: auto !important; min-height: 28px; padding-top: 5px; padding-bottom: 5px; white-space: normal !important; text-align: center }
  /* The footer strip is already 28px squares with 6px gaps — 130px for four —
     which the narrowest panel can hold on one line, so it keeps its own size.
     The icon squares inside the field rows step down to 26px instead: two of
     them plus their gap have to share a line with the value, and 26 + 26 + 6
     leaves the longest mask or URL the most room a sliver can give it. */
  .vw-root [data-vw-field] [data-vw-icon-btn] { width: 26px !important; height: 26px !important }
  .vw-root [data-vw-toolbar] [data-vw-actions] { justify-content: flex-start; gap: 6px }
  /* The three actions are 32px squares by default and need 112px with their
     gaps: one pixel over a 110px content column, which wrapped the third
     control onto a row of its own. At 28px they total 96px and stay on one
     line, which is the difference between a toolbar and a stack of buttons. */
  .vw-root [data-vw-toolbar] [data-vw-actions] > button { width: 28px !important; height: 28px !important }
  /* The rows have the same problem, one level down: at this width the 30px
     tile, the name, a badge and the chevron cannot share a line, and every
     one of them is flex:none — so the row's own box overflowed the card
     and the chevron painted past the rounded edge. The row keeps what it can
     still read in priority order: the name, then the badge, then the way in.
     The tile goes first because it is pure decoration — the letter it draws
     is the first character of the name right beside it. */
  .vw-root [data-row] > span:first-child { display: none !important }
  .vw-root [data-row] { padding: 10px 8px !important; gap: 6px !important }
}
/* ── the row loses its marks last ──────────────────────────────────────
   Below ~170px there is no line left for a badge beside a truncated name:
   the name would be cut to two characters to make room for "TOTP". The
   entry's state is already in the pane the row opens, so the mark is what
   goes, not the name. */
@container vw-panel (max-width: 170px) {
  .vw-root [data-row] [data-vw-marks] { display: none !important }
  .vw-root [data-row] > span:last-child { display: none !important }
}
@media (max-width: 560px) {
  /* Reclaim vertical space: the host dialog is short on a phone. (Field
     rows already stack from the container query above — that one follows
     the panel, this one follows the window.) */
  .vw-root { gap: 12px !important }
  .vw-root [data-vw-detail] { padding: 16px !important }
  .vw-root [data-row] { padding: 10px 12px !important; gap: 10px !important }
  /* The settings nav becomes a tight tab strip here (dsh-web-mobile packs
     its cells at padding 6px 8px, gap 6px, 14px icons). The glyph follows the
     strip's rhythm but stays at 17px rather than the 14px host icons: the
     check inside the shield closes up below that, and this row is the one
     place the mark is the only thing identifying the section. */
  .vw-nav-label { gap: 6px }
  .vw-nav-glyph { width: 17px; height: 17px }
}
`
      document.head.appendChild(style)
    }

    /**
     * The vault glyph: the plugin-list icon as line art.
     *
     * A hollow shield with a solid check inside it, in `currentColor` at the
     * sizes the host chrome uses, so it follows the label colour instead of
     * being painted blue everywhere.
     */
    const VaultGlyph = ({ className, size = 18 }) =>
      h(
        'svg',
        {
          className,
          width: size,
          height: size,
          // The plugin's badge: a shield outline with a check inside it.
          //
          // Two marks, one axis. Earlier passes added the dsh prompt to this —
          // first on a filled plate, then as a bare `>_` — and every version
          // failed the same way: three shapes in a 16-unit box have no room to
          // agree on a centre, so the mark read as scattered rather than
          // composed. What is left is the pair any password manager's own icon
          // carries — a shield and one mark inside it, both centred on x=8 and
          // both sized to leave the same air on every side.
          //
          // Monochrome through `currentColor`, so it follows the rail's ink and
          // flips with the theme.
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        // The shield: outline only, 1.3 stroke. Symmetric about x=8, and its
        // outer box is inset 1 unit on every side so the stroke never clips.
        h('path', {
          d: 'M8 0.5 L13.2 2.85 V7.15 C13.2 10.6 11.1 13 8 14.3 C4.9 13 2.8 10.6 2.8 7.15 V2.85 Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
        // The check: two strokes of a tick, centred on the same axis as the
        // shield and drawn at a heavier weight than the shield's own 1.3 so it
        // reads as one solid mark at 17px. Its long arm rises to 5.95 — clear
        // of the shield's shoulder at y=2.85 but well inside the outline — and
        // the joint is rounded, which is what keeps the corner from looking
        // chipped at rail size.
        h('path', {
          d: 'M5.6 7.55 L7.25 9.2 L10.5 5.95',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )

    /**
     * The sidebar's icon set: drawn, not typed.
     *
     * The menu used to carry text glyphs (▦ ★ ⏱ ◍ ▸ · ⌸ ⌫). Those come from
     * whatever font the host happens to load, so their optical sizes and their
     * baselines differ: a 4.5px triangle sat next to a full-height box, and the
     * middle dot of 未归类 landed on the text baseline instead of the row's
     * centre. Every place now gets one 16×16 drawing at one stroke weight, so a
     * row reads the same whichever kind of place it is — and the rail stays
     * quiet beside the list, which is where the reading happens.
     */
    /**
     * A tinted shape: the stroke's own colour at `alpha`.
     *
     * This is the host's own device — its icons set `fill: 'currentColor'`
     * with `opacity: 0.16` on a shape that needs a body (see
     * IconFolderOpenOutlineRegular's tray). It is a tint of the ink, never a
     * second colour, so it follows the row's text colour in both themes; and
     * it is faint enough that the outline still does all the describing.
     *
     * Declared before NAV_ICON_SHAPES because the shape thunks capture it at
     * call time — until this was hoisted back above them, every icon threw
     * `tinted is not defined` and took the whole panel down.
     */
    const tinted = (alpha) => ({ fill: 'currentColor', fillOpacity: alpha })

    /**
     * The sidebar's icon set, drawn in the host's own icon language.
     *
     * The reference is not invented: these are the conventions the host's
     * icon library (dsh-web-frontend's Icon*OutlineRegular family) actually
     * uses, read out of the shipped bundle:
     *
     *   1. A 16×16 viewBox with the drawing carried on a ~13px optical box
     *      (roughly 1.5 → 14.5), so every mark has a hairline of air around
     *      it. A shape that fills its viewBox is what reads as "chunky".
     *   2. `strokeWidth: 1` and NO explicit stroke-linecap/linejoin in the
     *      icon's own definition — the host leans on the default miter join,
     *      which is what gives its marks their crisp corners.
     *   3. Coordinates written to full precision (2.3457, 13.6541), not
     *      snapped to a coarse grid. The host's shapes are optical, not
     *      pixel-gridded, and that is why they look drawn rather than typed.
     *   4. `fill: 'currentColor'` with `opacity: 0.16` on a shape when the
     *      mark needs a body (IconFolderOpenOutlineRegular's tray, the clock's
     *      hub). It is a real tint of the ink, never a second colour, and it
     *      is deliberately faint: the outline still does all the work.
     *
     * Everything below follows those four rules. The result is a set that
     * sits in the same column as a host icon without looking foreign.
     */
    const NAV_ICON_SHAPES = {
      // Everything: a 2×2 of rounded squares.
      //
      // Drawn on a 12.0 optical span (2.1 → 13.9), which is the width the rest
      // of the family occupies — folder and trash are 12.2, the card's face is
      // 13.0. This used to sit on a 9.2 span (3.4 → 12.6), and that is exactly
      // why 全部条目 read smaller than 收藏 and 验证码 beside it: a sidebar of
      // equal-height rows still shows an icon 3 units narrower as a smaller
      // icon. The 0.10 body is lighter than the 0.16 a solid slab uses, because
      // four tinted tiles at full weight turn the row into a dark blob at 16px.
      all: () => [
        h('rect', { key: 'a', x: 2.1, y: 2.1, width: 5.1, height: 5.1, rx: 1.5, ...tinted(0.06) }),
        h('rect', { key: 'b', x: 8.8, y: 2.1, width: 5.1, height: 5.1, rx: 1.5, ...tinted(0.06) }),
        h('rect', { key: 'c', x: 2.1, y: 8.8, width: 5.1, height: 5.1, rx: 1.5, ...tinted(0.06) }),
        h('rect', { key: 'd', x: 8.8, y: 8.8, width: 5.1, height: 5.1, rx: 1.5, ...tinted(0.06) }),
      ],
      // A five-point star on the family's 12.0 optical span.
      //
      // The vertices are generated rather than hand-written: the outer radius
      // is solved so the widest pair of tips lands exactly on 2.0 → 14.0, and
      // the inner radius is the golden ratio of it (0.382), which is what gives
      // a star its proportion instead of its "cardboard" look. The previous
      // drawing spanned 11.37 × 10.8, so it read a size smaller than the folder
      // two rows below it; and its points were too fat for the tint to show.
      //
      // The path below is that construction written out at full precision —
      // regenerate with: outer = 6.31, inner = 2.41, centre (8, 8.15), first
      // tip straight up.
      favorites: () => [
        h('path', {
          key: 's',
          d: 'M8 1.84L9.80 5.50L13.84 6.09L10.92 8.93L11.61 12.95L8 11.05L4.39 12.95L5.08 8.93L2.16 6.09L6.20 5.50Z',
          ...tinted(0.13),
        }),
      ],
      // A clock: ring, hands, and a solid hub where they meet.
      //
      // The ring used to be a full 1.5 → 14.5 circle — a 13.0 span, the largest
      // mark in the set — so 验证码 sat visibly bigger than 收藏 next to it.
      // It is now 2.0 → 14.0 like everything else, which also gives the drawing
      // the 1.5 of air the host's own icons keep. The hub stays: it is the
      // detail the host's IconClockOutlineRegular carries, and it is what makes
      // the drawing read as a mechanism rather than a circle with two sticks.
      totp: () => [
        h('circle', { key: 'ring', cx: 8, cy: 8, r: 6, ...tinted(0.07) }),
        h('path', { key: 'hand', d: 'M8 4.35V8.15H11.4' }),
        h('circle', { key: 'hub', cx: 8, cy: 8, r: 0.72, ...tinted(1), stroke: 'none' }),
      ],
      login: () => [
        h('path', { key: 'bow', d: 'M8 1.84961C9.7395 1.84961 11.1504 3.26051 11.1504 5C11.1504 6.73949 9.7395 8.15039 8 8.15039C6.26051 8.15039 4.84961 6.73949 4.84961 5C4.84961 3.26051 6.26051 1.84961 8 1.84961Z', ...tinted(0.16) }),
        h('path', { key: 'shaft', d: 'M8 8.15039V14.1504' }),
        h('path', { key: 't1', d: 'M8 10.9004H10.9004' }),
        h('path', { key: 't2', d: 'M8 12.9004H10.1004' }),
      ],
      secureNote: () => [
        h('path', { key: 'sheet', d: 'M3.45 1.9H9.05L12.55 5.4V14.1H3.45V1.9Z', ...tinted(0.16) }),
        h('path', { key: 'fold', d: 'M9.05 1.9V5.4H12.55' }),
        h('path', { key: 'l1', d: 'M5.6 8.3H10.4' }),
        h('path', { key: 'l2', d: 'M5.6 10.8H8.9' }),
      ],
      // A card with a solid stripe: the stripe is the one detail that says
      // "card" and not "rectangle", and it has to be a fill — a 1px line
      // vanishes at 16px.
      card: () => [
        h('path', { key: 'face', d: 'M2.15 3.65H13.85C14.2 3.65 14.5 3.94 14.5 4.3V11.7C14.5 12.06 14.2 12.35 13.85 12.35H2.15C1.79 12.35 1.5 12.06 1.5 11.7V4.3C1.5 3.94 1.79 3.65 2.15 3.65Z', ...tinted(0.12) }),
        h('path', { key: 'stripe', d: 'M1.5 6.1H14.5V7.75H1.5V6.1Z', ...tinted(0.9) }),
        h('path', { key: 'digits', d: 'M3.6 9.6H6.4' }),
      ],
      identity: () => [
        h('path', { key: 'face', d: 'M2.15 3.65H13.85C14.2 3.65 14.5 3.94 14.5 4.3V11.7C14.5 12.06 14.2 12.35 13.85 12.35H2.15C1.79 12.35 1.5 12.06 1.5 11.7V4.3C1.5 3.94 1.79 3.65 2.15 3.65Z', ...tinted(0.12) }),
        h('path', { key: 'head', d: 'M5.75 7.75C6.44 7.75 7 7.19 7 6.5C7 5.81 6.44 5.25 5.75 5.25C5.06 5.25 4.5 5.81 4.5 6.5C4.5 7.19 5.06 7.75 5.75 7.75Z', ...tinted(0.9) }),
        h('path', { key: 'shoulder', d: 'M3.15 10.65C3.15 9.21 4.31 8.35 5.75 8.35C7.19 8.35 8.35 9.21 8.35 10.65' }),
        h('path', { key: 'l1', d: 'M9.85 5.6H12.6' }),
        h('path', { key: 'l2', d: 'M9.85 8.6H12.6' }),
      ],
      sshKey: () => [
        h('path', { key: 'term', d: 'M2.1504 2.65039H13.8496C14.2638 2.65039 14.5996 2.98618 14.5996 3.40039V12.5996C14.5996 13.0138 14.2638 13.3496 13.8496 13.3496H2.1504C1.73619 13.3496 1.4004 13.0138 1.4004 12.5996V3.40039C1.4004 2.98618 1.73619 2.65039 2.1504 2.65039Z', ...tinted(0.12) }),
        h('path', { key: 'prompt', d: 'M4.4004 6.40039L6.4004 8.20039L4.4004 10.0004' }),
        h('path', { key: 'cursor', d: 'M8.2002 10.1504H11.4004' }),
      ],
      // A folder with a tinted tray — the closest analogue to the host's own
      // IconFolderOpenOutlineRegular, whose body is a 0.16 fill under a
      // stroked outline. 未归类 is the same silhouette with the tint dropped
      // and a dash added: the contrast in weight is what tells them apart at
      // a glance, which two identical outlines never did.
      folder: () => [
        h('path', { key: 'body', d: 'M1.9004 12.5996V3.90039C1.9004 3.1263 2.5263 2.5 3.3004 2.5H6.2002C6.4906 2.5 6.7707 2.6011 6.9902 2.7852L8.4004 3.96094H12.6992C13.4733 3.96094 14.0992 4.58624 14.0992 5.36033V12.5996C14.0992 13.3737 13.4733 14 12.6992 14H3.3004C2.5263 14 1.9004 13.3737 1.9004 12.5996Z', ...tinted(0.16) }),
      ],
      unfiled: () => [
        h('path', { key: 'body', d: 'M1.9004 12.5996V3.90039C1.9004 3.1263 2.5263 2.5 3.3004 2.5H6.2002C6.4906 2.5 6.7707 2.6011 6.9902 2.7852L8.4004 3.96094H12.6992C13.4733 3.96094 14.0992 4.58624 14.0992 5.36033V12.5996C14.0992 13.3737 13.4733 14 12.6992 14H3.3004C2.5263 14 1.9004 13.3737 1.9004 12.5996Z', ...tinted(0.06) }),
        h('path', { key: 'dash', d: 'M5.8504 8.75H10.1496' }),
      ],
      // An archive box: lid, body, pull. The lid is a filled slab at 0.16 —
      // the same weight the host gives a filled shape — because that band is
      // what distinguishes this from the card icon two rows above it.
      archive: () => [
        h('path', { key: 'lid', d: 'M2.1504 2.15039H13.8496C14.2638 2.15039 14.5996 2.48618 14.5996 2.90039V5.09961C14.5996 5.51382 14.2638 5.84961 13.8496 5.84961H2.1504C1.73619 5.84961 1.4004 5.51382 1.4004 5.09961V2.90039C1.4004 2.48618 1.73619 2.15039 2.1504 2.15039Z', ...tinted(0.16) }),
        h('path', { key: 'body', d: 'M3.4004 5.84961V11.9004C3.4004 13.1427 4.4076 14.1504 5.6498 14.1504H10.3498C11.592 14.1504 12.5996 13.1427 12.5996 11.9004V5.84961' }),
        h('path', { key: 'pull', d: 'M6.4004 9.5H9.5996' }),
      ],
      trash: () => [
        h('path', { key: 'lid', d: 'M1.9004 4.2002H14.0996' }),
        h('path', { key: 'handle', d: 'M6.0996 4.2002V2.9002C6.0996 2.4578 6.4578 2.0996 6.9002 2.0996H9.0996C9.542 2.0996 9.9002 2.4578 9.9002 2.9002V4.2002' }),
        h('path', { key: 'body', d: 'M3.5996 4.2002L4.1504 12.7998C4.1713 13.6002 4.8281 14.2002 5.6282 14.2002H10.3718C11.1719 14.2002 11.8287 13.6002 11.8496 12.7998L12.4004 4.2002', ...tinted(0.12) }),
      ],
      // ── row controls ──────────────────────────────────────────────────────
      // The eye behind 显示 / 隐藏: a lidded almond with a solid pupil, the mark
      // every password manager uses for "look at this value". The lid carries a
      // 0.075 wash so the opening reads as a hole rather than an empty outline,
      // and the pupil is solid ink at 2.15 radius — big enough to be what the
      // eye looks at, small enough to leave the almond its own edge. The
      // 1.6 → 14.4 optical box keeps the 1.5 of air the rest of the family has.
      eye: () => [
        h('path', { key: 'lid', d: 'M1.6 8C3.35 4.85 5.5 3.25 8 3.25C10.5 3.25 12.65 4.85 14.4 8C12.65 11.15 10.5 12.75 8 12.75C5.5 12.75 3.35 11.15 1.6 8Z', ...tinted(0.075) }),
        h('path', { key: 'pupil', d: 'M8 5.85a2.15 2.15 0 1 0 0 4.3a2.15 2.15 0 0 0 0-4.3Z', ...tinted(1), stroke: 'none' }),
      ],
      // The same eye, struck through. A struck-through eye is the universal
      // "not visible" mark and it reads at 14px, where a shut lid with lashes
      // collapsed into a scribble; the slash runs corner to corner on the same
      // 1.5-inset box the eye uses, so it never clips the frame.
      eyeOff: () => [
        h('path', { key: 'lid', d: 'M1.6 8C3.35 4.85 5.5 3.25 8 3.25C10.5 3.25 12.65 4.85 14.4 8C12.65 11.15 10.5 12.75 8 12.75C5.5 12.75 3.35 11.15 1.6 8Z', ...tinted(0.075) }),
        h('path', { key: 'pupil', d: 'M8 5.85a2.15 2.15 0 1 0 0 4.3a2.15 2.15 0 0 0 0-4.3Z', ...tinted(1), stroke: 'none' }),
        h('path', { key: 'slash', d: 'M2.75 2.75L13.25 13.25' }),
      ],
      // The eye with a plus at its lower right: "bring this one field in", which
      // is a different promise from 显示 ("it is already here, uncover it"). The
      // eye gives up the lower-right corner to the plus rather than being scaled
      // down, so the two marks stay the same weight.
      eyePlus: () => [
        h('path', { key: 'lid', d: 'M1.6 7C3.25 4.2 5.2 2.75 7.35 2.75C9.5 2.75 11.45 4.2 13.1 7C11.45 9.8 9.5 11.25 7.35 11.25C5.2 11.25 3.25 9.8 1.6 7Z', ...tinted(0.075) }),
        h('path', { key: 'pupil', d: 'M7.35 4.85a1.95 1.95 0 1 0 0 3.9a1.95 1.95 0 0 0 0-3.9Z', ...tinted(1), stroke: 'none' }),
        h('path', { key: 'pstem', d: 'M12.3 10.2V14.3' }),
        h('path', { key: 'pbar', d: 'M10.25 12.25H14.35' }),
      ],
      // An arrow rising out of a tray: 恢复 — out of the trash, back into the
      // vault. The direction is the whole meaning; a bare arrow would say
      // "forward", the opposite of what this control does. The tray is open at
      // the top so the arrow reads as leaving it, not passing behind it.
      restore: () => [
        h('path', { key: 'tray', d: 'M2.55 9.15V11.85C2.55 12.62 3.18 13.25 3.95 13.25H12.05C12.82 13.25 13.45 12.62 13.45 11.85V9.15', ...tinted(0.1) }),
        h('path', { key: 'stem', d: 'M8 9.55V2.75' }),
        h('path', { key: 'head', d: 'M5.3 5.45L8 2.75L10.7 5.45' }),
      ],
      // A tick: the copy control's own "done". Drawn on the same optical box as
      // the rest — 3.3 → 12.7 wide, 4.7 → 11.4 tall — so it sits level with the
      // copy sheet it replaces instead of jumping to the frame's corner.
      check: () => [
        h('path', { key: 't', d: 'M3.3 8.3L6.4 11.4L12.7 4.7' }),
      ],
      // Two offset sheets: the clipboard's universal mark, and the one shape
      // that still reads as "copy" once the label is gone. The back sheet is a
      // tinted body open on the side the front one covers — a closed second
      // outline would double every edge and turn to mush at 14px — and it is
      // inset so the pair sits inside the same 1.5 box as every other mark.
      copy: () => [
        h('path', { key: 'back', d: 'M5.6 5.6V3.7C5.6 3.15 6.05 2.7 6.6 2.7H12.4C12.95 2.7 13.4 3.15 13.4 3.7V9.5C13.4 10.05 12.95 10.5 12.4 10.5H10.5', ...tinted(0.1) }),
        h('path', { key: 'front', d: 'M3.6 5.6H9.4C9.94 5.6 10.4 6.06 10.4 6.6V12.4C10.4 12.94 9.94 13.4 9.4 13.4H3.6C3.06 13.4 2.6 12.94 2.6 12.4V6.6C2.6 6.06 3.06 5.6 3.6 5.6Z' }),
      ],
      // A pencil lying on the diagonal: body, tip, and one nib line. The body is
      // a closed quad with a light wash so the joined edges read as a barrel;
      // the nib line is the ferrule. Drawn 2.6 → 13.4 on both axes, which is
      // what keeps it from looking heavier than the sheet beside it.
      pencil: () => [
        h('path', { key: 'body', d: 'M11.7 2.85C12.1 2.45 12.74 2.45 13.14 2.85C13.54 3.25 13.54 3.89 13.14 4.29L4.9 12.53L2.6 13.3L3.37 11Z', ...tinted(0.08) }),
        h('path', { key: 'nib', d: 'M10.05 4.55L11.45 5.95' }),
      ],
      // The archive box: a wide tinted lid over a body, with the pull slot in
      // the middle. The lid is a full closed rectangle at 0.16 — the weight the
      // host gives a filled shape — because that band is the one detail that
      // separates this from the card icon carrying the same outline.
      archiveBox: () => [
        h('path', { key: 'lid', d: 'M2.25 2.75H13.75C13.97 2.75 14.15 2.93 14.15 3.15V5.15C14.15 5.37 13.97 5.55 13.75 5.55H2.25C2.03 5.55 1.85 5.37 1.85 5.15V3.15C1.85 2.93 2.03 2.75 2.25 2.75Z', ...tinted(0.16) }),
        h('path', { key: 'body', d: 'M3.25 5.55V11.85C3.25 12.92 4.13 13.8 5.2 13.8H10.8C11.87 13.8 12.75 12.92 12.75 11.85V5.55' }),
        h('path', { key: 'pull', d: 'M6.35 8.9H9.65' }),
      ],
      // A folder with an arrow leaving it: "move this out, into that". The plain
      // folder alone is already the 文件夹 place's mark, so reusing it here put
      // two identical drawings one above the other meaning different things.
      //
      // The folder occupies the LEFT half (1.4 → 9.06) and the arrow the right
      // (9.7 → 14.35), which is the only split where both shapes survive at
      // 14px. The previous drawing closed the folder at 12.23 and then ran the
      // arrow head out to 14.8 — past the 14.5 optical box every other mark in
      // the set respects — so the arrow was clipped by the button and the pair
      // read as a folder with a stray line beside it.
      moveFolder: () => [
        h('path', { key: 'body', d: 'M1.35 12.55V4.05C1.35 3.6 1.72 3.23 2.17 3.23H4.62C4.94 3.23 5.24 3.36 5.45 3.6L6.62 4.95H8.55C9.0 4.95 9.37 5.32 9.37 5.77V12.55C9.37 13.0 9.0 13.37 8.55 13.37H2.17C1.72 13.37 1.35 13.0 1.35 12.55Z', ...tinted(0.11) }),
        h('path', { key: 'arrow', d: 'M9.95 8.3H14.4' }),
        h('path', { key: 'head', d: 'M12.15 6.05L14.4 8.3L12.15 10.55' }),
      ],
      // ── small marks ───────────────────────────────────────────────────────
      // Navigational, not informational: no tint, and a shorter reach, so they
      // read as punctuation beside a row rather than as a rival icon.
      chevron: () => [h('path', { key: 'c', d: 'M5.9502 3.40039L10.5498 8L5.9502 12.5996' })],
      chevronLeft: () => [h('path', { key: 'c', d: 'M10.0498 3.40039L5.4502 8L10.0498 12.5996' })],
      twistyClosed: () => [h('path', { key: 't', d: 'M6.1504 4.10059L10.0498 8L6.1504 11.8994' })],
      twistyOpen: () => [h('path', { key: 't', d: 'M4.10059 6.15039L8 10.0498L11.8994 6.15039' })],
      close: () => [h('path', { key: 'x', d: 'M3.7002 3.7002L12.2998 12.2998M12.2998 3.7002L3.7002 12.2998' })],
      /** An entry type this bundle has never heard of. */
      entry: () => [
        h('path', { key: 'frame', d: 'M4.3496 1.90039H11.6504C13.0034 1.90039 14.0996 2.99661 14.0996 4.34961V11.6504C14.0996 13.0034 13.0034 14.0996 11.6504 14.0996H4.3496C2.99661 14.0996 1.9004 13.0034 1.9004 11.6504V4.34961C1.9004 2.99661 2.99661 1.90039 4.3496 1.90039Z', ...tinted(0.12) }),
        h('path', { key: 'core', d: 'M8 5.4004L10.5996 8L8 10.5996L5.4004 8L8 5.4004Z', ...tinted(0.9) }),
      ],
      // ── toolbar glyphs ─────────────────────────────────────────────────────
      newEntry: () => [h('path', { key: 'p', d: 'M8 2.40039V13.5996M2.40039 8H13.5996' })],
      // GitHub's own mark, at the family's optical box. It is a FILLED glyph
      // rather than a stroked one — the logo has no stroke in it, and drawing
      // an outline of it would produce a shape nobody recognises.
      github: () => [
        h('path', {
          key: 'g',
          d: 'M8 1.2C4.13 1.2 1 4.33 1 8.19c0 3.09 2.01 5.71 4.79 6.63.35.07.48-.15.48-.34v-1.19c-1.95.43-2.36-.94-2.36-.94-.32-.81-.78-1.02-.78-1.02-.64-.44.05-.43.05-.43.7.05 1.07.72 1.07.72.63 1.08 1.65.77 2.05.59.06-.46.24-.77.44-.95-1.56-.18-3.19-.78-3.19-3.47 0-.77.27-1.39.72-1.88-.07-.18-.31-.89.07-1.85 0 0 .59-.19 1.93.72a6.7 6.7 0 0 1 3.51 0c1.34-.91 1.93-.72 1.93-.72.38.96.14 1.67.07 1.85.45.49.72 1.11.72 1.88 0 2.7-1.64 3.29-3.2 3.46.25.22.47.64.47 1.29v1.91c0 .19.13.41.48.34A7.09 7.09 0 0 0 15 8.19C15 4.33 11.87 1.2 8 1.2Z',
          fill: 'currentColor',
          stroke: 'none',
        }),
      ],
      // A gear drawn as a gear: a hub plus ONE closed outline whose edge folds
      // outward into eight teeth. Spokes and rim at the same weight read as a
      // sun at 14px, so the teeth have to be part of the outline itself. The
      // path below walks each tooth's two outer corners and drops back to the
      // root radius, which is what gives the silhouette its notches.
      settings: () => [
        h('circle', { key: 'hub', cx: 8, cy: 8, r: 2.1 }),
        h('path', {
          key: 'teeth',
          d: 'M7.048 1.671 L8.952 1.671 8.699 3.352 10.792 4.219 11.802 2.852 13.148 4.198 11.781 5.208 12.648 7.301 14.329 7.048 14.329 8.952 12.648 8.699 11.781 10.792 13.148 11.802 11.802 13.148 10.792 11.781 8.699 12.648 8.952 14.329 7.048 14.329 7.301 12.648 5.208 11.781 4.198 13.148 2.852 11.802 4.219 10.792 3.352 8.699 1.671 8.952 1.671 7.048 3.352 7.301 4.219 5.208 2.852 4.198 4.198 2.852 5.208 4.219 7.301 3.352 Z',
        }),
      ],
      refresh: () => [
        h('path', { key: 'a', d: 'M13.5996 8.0002C13.5996 11.0931 11.0929 13.6002 8 13.6002C4.9071 13.6002 2.40039 11.0931 2.40039 8.0002C2.40039 4.9073 4.9071 2.40059 8 2.40059' }),
        h('path', { key: 'b', d: 'M8 0.900391L11.0996 2.40039L8 4.90039' }),
      ],
    }

    /**
     * One icon from the shared 24-unit table.
     *
     * The viewBox is 24 while the element is 16px, so every unit above is
     * scaled by 2/3 on the way to the screen: a 1.7-unit stroke renders at
     * ~1.13px, which is the hairline the host's own icons use. Drawing on the
     * larger grid is what buys the precision — on a 16-unit grid a folder tab,
     * a key's teeth and a card's stripe all land on the same handful of
     * half-pixels and blur into each other.
     *
     * `size` defaults to the rail's own: the sidebar draws at 16 and the
     * toolbar's icon-only buttons at 14, which is what lets three actions
     * share one row with the count at phone width.
     */
    const navGlyph = (name, size = 16) =>
      h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          // 'none' at the root, with each shape setting its own tint: the
          // tinted bodies and the pure-stroke marks (chevrons, the close X)
          // then share one renderer without either style leaking into the
          // other.
          fill: 'none',
          stroke: 'currentColor',
          // 1, with no linecap/linejoin override — exactly what the host's own
          // icon component sets. Its crisp corners come from SVG's default
          // miter join, not from rounding them off.
          strokeWidth: 1,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        (NAV_ICON_SHAPES[name] ?? NAV_ICON_SHAPES.entry)(),
      )
    /**
     * The rail's own icon set, drawn in the reference UI's language.
     *
     * The sidebar is the one part of this panel that sits directly beside the
     * host's own navigation, so its marks are the ones a reader compares. The
     * previous set was hand-optimised for a 16-unit grid with tinted bodies;
     * measured against the reference the reader actually pointed at, that
     * family is a different dialect — heavier, filled, and short of air.
     *
     * So the rail alone switches dialects, and only the rail: everything else
     * (toolbar, action badges, twisties, the reveal/copy pair) keeps navGlyph
     * below, because those are read in isolation and the 16-grid serves them
     * better at 13-14px.
     *
     * The rules copied over, rather than eyeballed:
     *   1. A 24-unit box with 2-unit strokes and round caps and joins. Stroke
     *      weight is therefore proportional to the box, which is what keeps a
     *      15px mark legible without thickening it by hand.
     *   2. Every mark inside a 20-unit optical box (2 → 22), so rows of equal
     *      height present marks of equal weight. Nothing touches the edge.
     *   3. Outline only. No tinted bodies: at rail size the reference reads as
     *      line art, and a filled tile beside it looks like a different family.
     */
    const RAIL_ICON_SHAPES = {
      // Everything: a 2×2 of rounded squares.
      all: () => [
        h('rect', { key: 'a', x: 3, y: 3, width: 7, height: 7, rx: 1 }),
        h('rect', { key: 'b', x: 14, y: 3, width: 7, height: 7, rx: 1 }),
        h('rect', { key: 'c', x: 14, y: 14, width: 7, height: 7, rx: 1 }),
        h('rect', { key: 'd', x: 3, y: 14, width: 7, height: 7, rx: 1 }),
      ],
      // Favourites: a five-point star, drawn as one continuous outline so the
      // joins round off instead of spiking at the tips.
      favorites: () => [
        h('path', {
          key: 's',
          d: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z',
        }),
      ],
      // One-time codes: a clock, hands at 12 and just past 3.
      totp: () => [
        h('path', { key: 'h', d: 'M12 6v6l4 2' }),
        h('circle', { key: 'c', cx: 12, cy: 12, r: 10 }),
      ],
      // Logins: a round key, barrel pointing down-right at the ward.
      login: () => [
        h('path', {
          key: 'k',
          d: 'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z',
        }),
        h('circle', { key: 'p', cx: 16.5, cy: 7.5, r: 0.5, fill: 'currentColor' }),
      ],
      // Cards: a face with its stripe.
      card: () => [
        h('rect', { key: 'r', x: 2, y: 5, width: 20, height: 14, rx: 2 }),
        h('line', { key: 'l', x1: 2, x2: 22, y1: 10, y2: 10 }),
      ],
      // Secure notes: a page with ruled lines.
      secureNote: () => [
        h('path', { key: 'p', d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }),
        h('path', { key: 'f', d: 'M14 2v4a2 2 0 0 0 2 2h4' }),
        h('path', { key: 'l1', d: 'M10 9H8' }),
        h('path', { key: 'l2', d: 'M16 13H8' }),
        h('path', { key: 'l3', d: 'M16 17H8' }),
      ],
      // Identities: a card with a portrait and two data lines.
      identity: () => [
        h('path', { key: 'p', d: 'M13 19a4 4 0 0 0-8 0' }),
        h('path', { key: 'l1', d: 'M16 10h2' }),
        h('path', { key: 'l2', d: 'M16 14h2' }),
        h('circle', { key: 'c', cx: 9, cy: 12, r: 3 }),
        h('rect', { key: 'r', x: 2, y: 5, width: 20, height: 14, rx: 2 }),
      ],
      // SSH keys: a terminal window, because the key lives on a machine.
      sshKey: () => [
        h('path', { key: 'p1', d: 'm7 11 2-2-2-2' }),
        h('path', { key: 'p2', d: 'M11 13h4' }),
        h('rect', { key: 'r', x: 3, y: 3, width: 18, height: 18, rx: 2 }),
      ],
      // Folders: closed.
      folder: () => [
        h('path', {
          key: 'f',
          d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
        }),
      ],
      // Unfiled: the open folder — the same drawer, with nothing put away.
      unfiled: () => [
        h('path', {
          key: 'f',
          d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
        }),
      ],
      // Archive: the lidded box, distinct from the folder at a glance because
      // its lid is a separate rectangle sitting on top of the body.
      archive: () => [
        h('rect', { key: 'l', x: 2, y: 3, width: 20, height: 5, rx: 1 }),
        h('path', { key: 'b', d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' }),
        h('path', { key: 'h', d: 'M10 12h4' }),
      ],
      // Trash: a bin with two ribs.
      trash: () => [
        h('path', { key: 'r1', d: 'M10 11v6' }),
        h('path', { key: 'r2', d: 'M14 11v6' }),
        h('path', { key: 'b', d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }),
        h('path', { key: 'l', d: 'M3 6h18' }),
        h('path', { key: 'h', d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
      ],
      // Any type with no mark of its own: a triangle, a square and a circle —
      // reads as "a shape, whichever one" rather than as a specific type.
      entry: () => [
        h('path', {
          key: 't',
          d: 'M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z',
        }),
        h('rect', { key: 's', x: 3, y: 14, width: 7, height: 7, rx: 1 }),
        h('circle', { key: 'c', cx: 17.5, cy: 17.5, r: 3.5 }),
      ],
    }

    /**
     * Draw one rail icon. 15px is the reference's own size; the rail slot is
     * 16 so the mark keeps a hairline of air on each side, which is what stops
     * a round stroke from looking cropped.
     */
    const railGlyph = (name, size = 15) =>
      h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        (RAIL_ICON_SHAPES[name] ?? RAIL_ICON_SHAPES.entry)(),
      )

    /** Which drawing each entry type gets; an unknown id gets the generic mark. */
    const TYPE_ICON_NAMES = { login: 'login', secureNote: 'secureNote', card: 'card', identity: 'identity', sshKey: 'sshKey' }

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
    const monogramCache = new Map()
    const monogram = (item) => {
      // Same entry, same tile: the inputs are the id plus the three fields the
      // letter is drawn from, so the memo key is those and nothing else. A row
      // asks for its monogram on every render (twice per render, in fact — the
      // avatar tile and the fallback), and each miss ran `new URL` per URI plus
      // two regex passes per candidate.
      const key = `${item?.id ?? ''}\u0000${item?.name ?? ''}\u0000${item?.username ?? ''}\u0000${item?.uris?.[0] ?? ''}`
      const cached = monogramCache.get(key)
      if (cached !== undefined) return cached
      if (monogramCache.size >= 2048) monogramCache.clear()
      const letter = monogramOf(item)
      monogramCache.set(key, letter)
      return letter
    }
    const monogramOf = (item) => {
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

    /**
     * Where the server keeps a site's icon.
     *
     * Bitwarden caches the icons it fetched for an entry's URIs, and serves
     * them under /icons/<host>/icon.png — same picture an official client
     * shows. The host answers with a 19px globe when it has nothing, which is
     * what ICON_MIN_PX screens out below.
     */
    const iconUrl = (config, host) => {
      const base = String(config?.serverUrl ?? '').trim().replace(/\/+$/, '')
      if (!base || !host) return null
      return `${base}/icons/${encodeURIComponent(host)}/icon.png`
    }

    /**
     * Ask the browser to load one icon, and remember whether it is real.
     *
     * Deliberately a probe rather than `onError` on the row's own `<img>`:
     * failing rows flicker as each one discovers the server has no icon, and a
     * row that is re-rendered would ask again. The answer lands in the module
     * map, which is what re-renders the row — the panel is not the one being
     * asked, so the map is read during render.
     *
     * No DOM (the test double, a server render) means no probing at all: rows
     * keep their letter tile, which is also what they show while an icon loads.
     */
    /**
     * Hosts whose icon has been asked for but not yet fetched, drained by the
     * mounted panel once its list is on screen.
     * @type {Set<string>}
     */
    const pendingIconHosts = new Set()
    /**
     * Hosts a probe has already been fired for.
     *
     * The gate that makes queueing idempotent: without it, a host whose icon
     * the server does not have would be queued again by every render that drew
     * its row, and the queue would never come to rest. Membership means "asked
     * once", not "answered" — the answer is `iconCache`'s business.
     * @type {Set<string>}
     */
    const probedIconHosts = new Set()
    /**
     * Wake the mounted panel because a host joined the queue.
     *
     * The drain runs from an effect, so it only runs when its dependencies
     * change. A row that queues its host while nothing else about the list
     * moves — the detail pane's header, for instance — would otherwise sit on
     * a letter tile until something unrelated re-rendered the panel.
     */
    const notifyIconQueue = () => {
      // Nothing to fetch without a DOM: queueing alone would re-render for
      // ever without ever draining.
      if (typeof Image === 'undefined') return
      iconVersion += 1
      // Batched, for the same reason `bumpIcons` is — and here it matters
      // more. This is called from `iconFor`, which runs DURING render, once
      // per row whose host has not been probed yet. A first page carries up
      // to fifty rows and nearly as many distinct hosts, so one render of the
      // list fired up to fifty notifications, each one a synchronous
      // `setState` from inside a render pass: fifty whole-panel re-renders
      // landing in the same second the reader opened the panel, plus React
      // warning about updating a component while rendering another. The queue
      // itself is complete before the microtask runs, so one wake-up drains
      // all of it.
      if (iconFlush !== null) return
      iconFlush = Promise.resolve().then(() => {
        iconFlush = null
        iconSubscribers.forEach((notify) => notify())
      })
    }

    const probeIcon = (url, onChange) => {
      if (!url || typeof Image === 'undefined') return
      const image = new Image()
      image.onload = () => {
        const host = iconHostOf(url)
        iconCache.set(host, Number(image.naturalWidth) >= ICON_MIN_PX ? 'ok' : 'none')
        onChange()
      }
      image.onerror = () => {
        iconCache.set(iconHostOf(url), 'none')
        onChange()
      }
      image.src = url
    }

    /** The host a probe URL was built for, so the answer lands on its own key. */
    const iconHostOf = (url) => {
      const match = /\/icons\/([^/]+)\//.exec(String(url ?? ''))
      if (!match) return ''
      try {
        return decodeURIComponent(match[1])
      } catch {
        return match[1]
      }
    }

    /**
     * The favicon for an entry's row, or null to keep the letter tile.
     *
     * One image per host, not per entry: the server keys its icons by host, so
     * two logins to the same site share one picture. A host is probed at most
     * once per page load (iconCache), which is why the `<img>` here can be
     * rendered straight away — a host already known to have no icon never
     * reaches this line.
     */
    const iconFor = (item, imgStyle) => {
      const host = hostOf(item?.uris?.[0])
      if (!host) return null
      const state = iconCache.get(host)
      const url = iconUrl(openCache.config?.config, host)
      if (!url) return null
      if (state === 'none') return null
      if (state !== 'ok') {
        // Not asked yet. The row keeps its letter tile and the host is QUEUED,
        // not fetched: a first page carries up to fifty rows and nearly as many
        // hosts, and a favicon probe is a cross-site request that measured
        // 0.9–1.6 s against a real server — fired from render, that was fifty
        // slow requests and fifty whole-panel re-renders landing in the same
        // second the reader had just clicked into the panel. The panel drains
        // the queue once the rows are actually up (see the effect in VaultPanel).
        if (!pendingIconHosts.has(host) && !probedIconHosts.has(host)) {
          pendingIconHosts.add(host)
          notifyIconQueue()
        }
        return null
      }
      // `imgStyle` is for the bigger tile the detail header draws: the picture
      // scales with its slot, so one fixed 18px size left the header's icon
      // looking lost in the middle of a 36px tile.
      return h('img', { key: 'icon', src: url, alt: '', style: imgStyle ?? S.avatarImg, draggable: 'false' })
    }

    /**
     * Show just the host of a URI: full URLs make list rows unreadable.
     *
     * Memoised by URI string: a row asks for the same host on every render, in
     * two places (the subtitle and the monogram's candidate list), and parsing
     * a URL is the expensive part of building a row. The map holds at most a
     * page's worth of distinct URIs before it is cleared.
     */
    const hostCache = new Map()
    const hostOf = (uri) => {
      const raw = String(uri ?? '').trim()
      if (!raw) return ''
      const cached = hostCache.get(raw)
      if (cached !== undefined) return cached
      let host
      try {
        host = new URL(/^\w+:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
      } catch {
        host = raw
      }
      if (hostCache.size >= 512) hostCache.clear()
      hostCache.set(raw, host)
      return host
    }

    /**
     * Did this failure happen before the host ever saw the request?
     *
     * `connection.rpc.call` throws the browser's own TypeError when fetch itself
     * fails — offline, a dropped TLS connection, a proxy that closed the socket
     * early. The host's own refusals never look like this: they come back inside
     * an envelope and `makeInvoke` re-throws them with a host code and a Chinese
     * message. So a native TypeError-like error carrying no host code is a
     * transport failure, whatever the engine decided to call it.
     */
    const isTransportFailure = (failure) => {
      if (!failure) return false
      const code = failure.code
      if (code && code !== 'rpc_error') return false
      const text = String(failure.message ?? failure)
      return /load failed|failed to fetch|networkerror|network error|fetch failed/i.test(text)
    }

    /**
     * Put a ceiling on one read.
     *
     * A promise that never settles is worse than one that rejects: `await`
     * simply waits, so a request the host never answers — a request dropped by a
     * captive portal, a socket the phone's radio parked until the tab wakes —
     * leaves the sidebar shimmering with no rows and no error, which is the
     * one failure mode the reader cannot act on. The timeout turns that into an
     * ordinary rejection so the caller's existing fallback runs.
     *
     * Silent by construction: the timeout rejects with the same shape a failed
     * call would (no host code), so callers cannot tell a slow host from a
     * dropped one, and neither can the reader — who is told the counts are
     * unknown, not which of a dozen network faults produced that.
     */
    const withTimeout = (promise, ms, label) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = new Error(`${label} 超时`)
          error.code = 'timeout'
          reject(error)
        }, ms)
        promise.then(
          (value) => { clearTimeout(timer); resolve(value) },
          (failure) => { clearTimeout(timer); reject(failure) },
        )
      })

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

    /**
     * Absolute local timestamp for tooltips, where "3 分钟前" is not enough.
     *
     * Memoised per timestamp string. Every list row formats its own revision
     * date for a tooltip, so a full page built fifty `Date` objects and fifty
     * six-part pad chains per render — and the answer for one ISO string is a
     * pure function of it (the panel's time zone does not change under a
     * running page). The map is cleared wholesale once it grows past a page's
     * worth of entries, which keeps a long session from accumulating one entry
     * per row it ever drew.
     */
    const absoluteTimeCache = new Map()
    const absoluteTime = (iso) => {
      const key = String(iso ?? '')
      const hit = absoluteTimeCache.get(key)
      if (hit !== undefined) return hit
      const then = Date.parse(key)
      let text = '—'
      if (Number.isFinite(then)) {
        const date = new Date(then)
        const pad = (value) => String(value).padStart(2, '0')
        text = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      }
      if (absoluteTimeCache.size >= 512) absoluteTimeCache.clear()
      absoluteTimeCache.set(key, text)
      return text
    }

    // ── small controls ────────────────────────────────────────────────────────

    /**
     * How long a copied secret is allowed to sit in the clipboard.
     *
     * A copied password outlives the panel, the tab and the process that
     * copied it: every clipboard manager, every other local app, and the OS
     * history keep it. The panel cannot clear what it does not own, so it puts
     * the value on the clipboard, waits, and takes it back — but only after
     * reading the clipboard and confirming it still holds what was written.
     * Clearing unconditionally would destroy whatever the reader copied in the
     * meantime, which is a worse bug than the one this fixes.
     */
    const CLIPBOARD_TTL_MS = 20000
    /**
     * Ceiling on the sidebar's overview read, in milliseconds.
     *
     * A read that never settles is worse than one that rejects: `await` simply
     * waits, so a request the host never answers — dropped by a captive portal,
     * or a socket the phone's radio parked until the tab wakes — would leave the
     * sidebar shimmering with no rows and no error, which is the one failure
     * mode the reader cannot act on. The timeout turns that into an ordinary
     * rejection so the caller's existing fallback runs.
     *
     * Long enough that a merely slow network still gets its counts, short enough
     * that the rail settles into its structural places when the answer is simply
     * not coming: the sidebar is furniture, and a count that never arrives must
     * not hold the shape of the panel hostage.
     */
    const OVERVIEW_TIMEOUT_MS = 6000
    /**
     * The same ceiling for the other read that describes a place rather than a
     * row. Shorter than the overview's, because nothing waits on it: the folder
     * list only feeds the move-to-folder step, so a slow answer is better
     * dropped than kept open — but it still must not stay open forever, which
     * is exactly how the sidebar used to get stuck.
     */
    const READ_TIMEOUT_MS = 5000
    /**
     * Write `text` to the clipboard and schedule its removal.
     *
     * Best-effort in both directions: an insecure context has no clipboard at
     * all, and `readText` is gated behind a permission prompt in several
     * browsers. Either refusal means the clear is skipped — never thrown, and
     * never surfaced to the reader, who did not ask for this and cannot act on
     * it. Each write owns its own timer; a clear that runs late finds the
     * clipboard changed and simply does nothing.
     */
    const copyWithExpiry = async (text, onCopied) => {
      await navigator.clipboard.writeText(String(text ?? ''))
      onCopied?.()
      const written = String(text ?? '')
      setTimeout(() => {
        void (async () => {
          try {
            if (typeof navigator.clipboard.readText !== 'function') return
            const current = await navigator.clipboard.readText()
            // Somebody copied something else in the meantime: that value is
            // theirs, not ours.
            if (current !== written) return
            await navigator.clipboard.writeText('')
          } catch {
            /* clipboard unreadable or unwritable (permission, insecure context) */
          }
        })()
      }, CLIPBOARD_TTL_MS)
    }
    /**
     * Copy-to-clipboard button with a short "copied" confirmation.
     *
     * `inline` picks the field-row box (S.inlineButton) instead of the
     * standalone button: inside a detail row the control is always paired with
     * a 显示 toggle, and the two have to be the same size for the pair to read
     * as one group. Standalone uses (a toolbar, a confirm step) keep the roomier
     * default. The confirmation swaps only the colours, never the box, so the
     * button does not resize under the reader's cursor the moment they click.
     */
    function CopyButton({ value, t, inline, icon, load, box, label: customLabel, glyph }) {
      const [copied, setCopied] = useState(false)
      const [fetching, setFetching] = useState(false)
      useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
      }, [copied])
      // Three boxes, one per use: the stand-alone button, the field-row text
      // button, and the square icon slot. `icon` wins over `inline` when both
      // are passed, which is how a row asks for the glyph form and still keeps
      // the size every control in that row shares. `box` replaces all three
      // for the quiet variant the list rows wear on hover.
      const base = box ?? (icon ? S.inlineIconButton : inline ? S.inlineButton : S.button)
      const label = customLabel ?? t('copy')
      // `glyph` names the resting drawing: the island's account control wears
      // an id card, its password control a key. The confirmation is always the
      // tick, whichever drawing it replaces.
      const body = icon ? navGlyph(copied ? 'check' : glyph ?? 'copy', 14) : copied ? t('copied') : label
      return h(
        'button',
        {
          type: 'button',
          ...(icon ? { 'data-vw-icon-btn': '' } : {}),
          // The confirmation is a shape change, and a shape change needs a
          // starting frame: the attribute is what the stylesheet hangs the
          // tick morph on, and it disappearing 1.5s later is what lets the
          // next copy animate again (an animation on an attribute that never
          // changes only ever plays once).
          ...(copied ? { 'data-vw-copied': 'true' } : {}),
          // Busy and copied both recolour, never resize: a control that changes
          // width under the cursor that is about to click it reads as a misfire.
          style: copied || fetching ? { ...base, color: TOKEN.ok, borderColor: TOKEN.ok } : base,
          disabled: fetching,
          onClick: async (event) => {
            // Inside a row, copying is not also opening: the row's own click
            // handler would fire on the way up and swap the card underneath.
            event?.stopPropagation?.()
            try {
              // A value the panel does not already hold (a password, a hidden
              // custom field) is read first. `load` is that read, and it is the
              // whole reason a row can offer a copy without revealing on open.
              let text = value
              if (typeof load === 'function') {
                setFetching(true)
                try {
                  text = await load()
                } catch {
                  /* the read was refused (reprompt gate, host error): no tick */
                  return
                } finally {
                  setFetching(false)
                }
              }
              if (text === undefined || text === null || text === '') return
              // The confirmation is the reader's; the scheduled clear is
              // the secret's (see copyWithExpiry).
              await copyWithExpiry(text, () => setCopied(true))
            } catch {
              /* clipboard unavailable (insecure context): nothing to confirm */
            }
          },
          title: copied ? t('copied') : label,
          // The confirmation is a colour change and, in the icon form, a
          // different drawing — neither reaches a screen reader, so the
          // state is announced through the accessible name as well.
          'aria-label': copied ? t('copied') : label,
        },
        body,
      )
    }

    /**
     * A write action as an icon: one glyph, one tooltip.
     *
     * These four used to be text buttons of four different widths, and the two
     * longest ("移入回收站", "移动到文件夹") were what pushed the row — and then
     * the card — past the panel's right edge at phone widths. A glyph under no
     * label is the shape every toolbar uses, it wraps as a square, and it keeps
     * the row on one line at any width.
     *
     * The tooltip is the native `title`, and it carries more than a label
     * could: what the action will actually do to the entry (归档 removes it
     * from the model's search, 移入回收站 is recoverable). That sentence is the
     * thing a reader hovering a destructive control wants to know, which is why
     * the title is the tip and not the label repeated.
     */
    const ActionBadge = ({ action, icon, label, tip, onClick, disabled, danger }) => {
      const base = S.actionBadge
      const title = tip ?? label
      return h(
        'button',
        {
          type: 'button',
          'data-vw-action': action,
          'data-vw-icon-btn': '',
          title,
          'aria-label': title,
          disabled,
          // Red ink, not a red ring: a bordered red square among three quiet
          // glyphs read as a warning badge the size of a button. The colour is
          // what marks it destructive; the box stays the same box.
          style: danger ? { ...base, color: TOKEN.err } : base,
          onClick,
        },
        navGlyph(icon, 16),
      )
    }

    /**
     * One placeholder bar, drawn on the line box it is standing in for.
     *
     * A bar is not text. `height: 10` on a span makes a 10px box, so a column
     * of two bars measured 24px where the two lines of real text it replaces
     * measure 39 — and the list grew 15px per row at the moment the answer
     * landed, which is the jump this skeleton exists to prevent. A `minHeight`
     * on the column only moved the number around: it was still a guess at
     * somebody else's height.
     *
     * So each bar sits inside a block whose font-size is the real line's — the
     * same style object the answer uses (`S.listName`, `S.fieldValue`, …), not
     * a number copied out of it, so the two cannot drift apart. The bar itself
     * is an inline-block centred on that line, and the line box supplies the
     * height and the baseline: what the reader measures is what the text will
     * measure after the swap, at any font the host installs, because the line
     * height is `normal` in both states.
     */
    const skeletonLine = (font, bar) =>
      h(
        'span',
        { style: { display: 'block', fontSize: font.fontSize } },
        h('span', { style: { ...S.skeletonBar, display: 'inline-block', verticalAlign: 'middle', ...bar } }),
      )

    /**
     * The list's placeholder: rows with the right silhouette, not a word.
     *
     * It replaces the bare "同步中" card that used to fill the pane while the
     * first read was in flight. The silhouette matters more than the pulse:
     * six rows of an avatar tile, a name bar and a meta bar are the same
     * height as six real rows, so the answer replaces the placeholder without
     * the card resizing under the reader. A one-line "同步中" card, by
     * contrast, was shorter than the list it became — which is the jump that
     * read as a flash.
     *
     * Eleven rows, not six: the scroll area caps the list at min(58vh, 560px),
     * so a real answer fills it while six ghost rows (≈324px) would sit 200px
     * short — and the card growing 200px the instant the rows land is its own
     * jump. Eleven ghost rows always exceed the cap, so the placeholder and the
     * answer are the same height and the swap is invisible.
     *
     * The rows are aria-hidden: the panel announces "正在读取" once through the
     * status role, and eleven placeholder rows must not make a screen reader
     * read eleven fake entries.
     */
    const ListSkeleton = ({ t, rows = 11 }) =>
      h(
        'div',
        { 'data-vw-skeleton': '', 'data-vw-list-ghost': '', role: 'status', 'aria-label': t('syncLoading'), style: { ...S.list } },
        Array.from({ length: rows }, (_, index) =>
          h(
            'div',
            { key: `ghost-${index}`, 'data-vw-skeleton-row': '', style: S.skeletonRow, 'aria-hidden': 'true' },
            h('span', { style: { ...S.avatar, borderStyle: 'dashed', background: 'transparent' } }),
            // gap 3 and the two font sizes are the real row's: the column is as
            // tall as its lines, not as tall as an avatar somebody typed next to
            // it. The ghost used to be padded out to 30px to match the tile,
            // which left the answer 9px taller than its placeholder at every
            // row — the tile is not what makes a row 63px, the subtitle is.
            h(
              'span',
              { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
              skeletonLine(S.listName, { width: `${58 - (index % 3) * 9}%` }),
              skeletonLine(S.listMeta, { width: `${40 - (index % 4) * 5}%`, height: 8, opacity: 0.7 }),
            ),
          ),
        ),
      )

    /**
     * The detail pane's placeholder: the field rows the answer will fill.
     *
     * Same reasoning as the list's — it holds the card's shape so the real
     * content does not resize it — but it also draws the label column, because
     * a detail card is a two-column form and a placeholder without the column
     * would land the values in the wrong place when they arrive.
     */
    const DetailSkeleton = ({ t }) =>
      h(
        'div',
        { 'data-vw-skeleton': '', 'data-vw-detail-ghost': '', role: 'status', 'aria-label': t('syncLoading'), style: { ...S.detail } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('span', { style: { ...S.avatar, width: 36, height: 36, borderStyle: 'dashed', background: 'transparent' } }),
          // The header's two lines, on the header's own type: S.cardTitle is
          // 15px and S.listMeta 12px, and a bar drawn at 12 and 8 measured a
          // 34px header against the real 42px one.
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 } },
            skeletonLine(S.cardTitle, { width: 150, height: 12 }),
            skeletonLine(S.listMeta, { width: 96, height: 8, opacity: 0.7 }),
          ),
        ),
        h('div', { style: { height: 1, background: TOKEN.border } }),
        ...Array.from({ length: 5 }, (_, index) =>
          h(
            'div',
            { key: `dfield-${index}`, 'data-vw-skeleton-field': '', style: S.skeletonField, 'aria-hidden': 'true' },
            skeletonLine(S.fieldLabel, { width: index % 2 ? 44 : 34, height: 8, opacity: 0.7 }),
            skeletonLine(S.fieldValue, { width: `${72 - index * 7}%` }),
          ),
        ),
      )

    /**
     * A field-row control that is a glyph rather than a word (显示 / 隐藏, 复制).
     *
     * The native `title` is the tooltip — the same mechanism the toolbar's icon
     * buttons already use, and the one a reader gets without waiting for a
     * custom layer to render. `aria-label` carries the same words as the
     * accessible name, because an icon-only button has no text to fall back on.
     */
    const IconButton = ({ name, label, onClick, disabled, ok, dataAttr }) => {
      const base = S.inlineIconButton
      return h(
        'button',
        {
          type: 'button',
          title: label,
          'aria-label': label,
          disabled,
          'data-vw-icon-btn': '',
          ...(dataAttr ?? {}),
          style: ok ? { ...base, color: TOKEN.ok, borderColor: TOKEN.ok } : base,
          onClick,
        },
        navGlyph(name, 14),
      )
    }

    /**
     * The reveal control: an open eye while the value is hidden, a closed one
     * while it is shown.
     *
     * The drawing carries the state and the tooltip carries the action ("显示"
     * while the value is covered, "隐藏" once it is open) — the same convention
     * a password field's own eye follows, so the pair need not be learned.
     */
    const RevealButton = ({ open, t, onClick, dataAttr }) =>
      h(IconButton, {
        name: open ? 'eyeOff' : 'eye',
        label: open ? t('hide') : t('show'),
        onClick,
        dataAttr,
      })

    /**
     * A secret row that starts masked: card number, security code, private key,
     * a custom field value, a note body.
     *
     * None of them belong on screen by default — the panel may be open while
     * someone else is looking at it — so the value is hidden behind a reveal
     * toggle, and copied through CopyButton without ever being shown.
     * It is a component rather than a closure inside detailPane because the
     * open/closed flag is per-row state, and a hook inside a plain function
     * would change the call order of VaultPanel's hooks.
     *
     * `multiline` swaps the revealed body to a pre-wrapping block, so a note
     * keeps its line breaks once it is shown (masked, it is a single run of
     * dots by design). An empty `secret` renders no toggle at all: a Show
     * button that reveals nothing reads as a broken entry, which is why the
     * caller passes '—' as the placeholder for one.
     */
    function SecretRow({ label, secret, placeholder, multiline, t }) {
      const [open, setOpen] = useState(false)
      const shown = Boolean(secret)
      const revealedStyle = multiline ? { ...S.mono, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } : S.mono
      // The placeholder is a mask only when it actually stands in for a value
      // this row is holding back. An empty field says "—" instead, and a dash
      // must not inherit the mask's nowrap and negative tracking.
      const masked = Boolean(secret) && !open
      return h(
        'div',
        { 'data-vw-field': '', style: S.fieldRow },
        h('span', { style: S.fieldLabel }, label),
        h('span', { style: masked ? { ...S.fieldValue, ...S.mask } : open ? revealedStyle : S.fieldValue }, open ? secret ?? '' : placeholder),
        // One flex group, wrapping only if a very long translation cannot fit:
        // at the panel's narrowest the row is a single column, and two 28px
        // controls have to share the line the value gave up.
        h(
          'span',
          { 'data-vw-field-ctl': '', style: { display: 'inline-flex', gap: 6, flexWrap: 'wrap' } },
          shown ? h(RevealButton, { open, t, onClick: () => setOpen((previous) => !previous) }) : null,
          secret ? h(CopyButton, { value: secret, t, icon: true }) : null,
        ),
      )
    }

    /**
     * The editor: one form over one entry's whole plaintext record.
     *
     * It is a component rather than a closure inside VaultPanel for the same
     * reason SecretRow is: a hook inside a plain function would change the
     * call order of VaultPanel's own hooks. The panel owns the state (which
     * entry is open, what was typed, whether a save is in flight) and passes
     * it in; this component only renders controls and reports changes.
     *
     * The controls are built from a field table rather than written out one
     * by one, so a type's whole shape is visible in one place — and so the
     * list of what the form does NOT touch (passkeys, attachments, password
     * history) is stated next to what it does.
     */
    const EDITOR_FIELDS = {
      login: [
        { key: 'username', label: 'editorUsername', control: 'text' },
        { key: 'password', label: 'editorPassword', control: 'password' },
        { key: 'totp', label: 'editorTotpSeed', control: 'text', hint: 'editorTotpHint' },
        // A single-line input, not a textarea: a URL is one line, and the
        // textarea's 66px box read as a chunky empty slab under a label.
        { key: 'uris', label: 'editorUris', control: 'text' },
      ],
      card: [
        { key: 'cardholderName', label: 'editorCardholderName', control: 'text' },
        { key: 'brand', label: 'editorBrand', control: 'text' },
        { key: 'number', label: 'editorNumber', control: 'password' },
        { key: 'expMonth', label: 'editorExpMonth', control: 'text' },
        { key: 'expYear', label: 'editorExpYear', control: 'text' },
        { key: 'code', label: 'editorCode', control: 'password' },
      ],
      identity: [
        { key: 'title', label: 'editorIdentityTitle', control: 'text' },
        { key: 'firstName', label: 'editorFirstName', control: 'text' },
        { key: 'middleName', label: 'editorMiddleName', control: 'text' },
        { key: 'lastName', label: 'editorLastName', control: 'text' },
        { key: 'username', label: 'editorUsername', control: 'text' },
        { key: 'email', label: 'editorIdentityEmail', control: 'text' },
        { key: 'phone', label: 'editorIdentityPhone', control: 'text' },
        { key: 'company', label: 'editorCompany', control: 'text' },
        { key: 'ssn', label: 'editorSsn', control: 'password' },
        { key: 'passportNumber', label: 'editorPassportNumber', control: 'password' },
        { key: 'licenseNumber', label: 'editorLicenseNumber', control: 'password' },
        { key: 'address1', label: 'editorAddress1', control: 'text' },
        { key: 'address2', label: 'editorAddress2', control: 'text' },
        { key: 'address3', label: 'editorAddress3', control: 'text' },
        { key: 'city', label: 'editorCity', control: 'text' },
        { key: 'state', label: 'editorState', control: 'text' },
        { key: 'postalCode', label: 'editorPostalCode', control: 'text' },
        { key: 'country', label: 'editorCountry', control: 'text' },
      ],
      sshKey: [
        { key: 'privateKey', label: 'editorPrivateKey', control: 'textarea' },
        { key: 'publicKey', label: 'editorPublicKey', control: 'textarea' },
        { key: 'keyFingerprint', label: 'editorKeyFingerprint', control: 'text' },
      ],
      secureNote: [],
    }
    /** Which section of the form a field belongs to, for the two grouped types. */
    const EDITOR_GROUPS = { card: 'editorCard', identity: 'editorIdentity', sshKey: 'editorSshKey' }
    /**
     * The order the creator's type selector lists the kinds in. Login first
     * because it is what most entries are, and the secret-bearing kinds last
     * so a reader who only wanted a password never has to scroll past a card.
     */
    const EDITOR_TYPE_ORDER = ['login', 'secureNote', 'card', 'identity', 'sshKey']

    /**
     * A blank form for one entry type. Module-level on purpose: the creator's
     * type selector rebuilds the form from it, and it is the one shape both the
     * panel and the editor component can reach without a hook.
     */
    const blankForm = (type) => ({
      type,
      name: '',
      username: '',
      password: '',
      totp: '',
      uris: '',
      notes: '',
      favorite: false,
      reprompt: 0,
      folderId: '',
      fields: [],
      card: { cardholderName: '', brand: '', number: '', expMonth: '', expYear: '', code: '' },
      identity: {},
      sshKey: { privateKey: '', publicKey: '', keyFingerprint: '' },
    })

    function EditorForm({ open, form, base, busy, loading, result, stale, folders, t, onChange, onSave, onCancel }) {
      /** The outcome line, so a message that appears can bring itself into view. */
      const outcomeRef = useRef(null)
      const outcomeKey = result ? `${result.status}\u0000${result.error ?? result.syncWarning ?? ''}` : ''
      useEffect(() => {
        if (!outcomeKey) return
        const node = outcomeRef.current
        if (!node || typeof node.scrollIntoView !== 'function') return
        // `nearest` on purpose: it scrolls the smallest amount that makes the
        // line visible and does not yank the panel when it already is.
        node.scrollIntoView({ block: 'nearest' })
      }, [outcomeKey])
      // `base` is the host draft: in edit mode `open` carries only
      // {id, mode}, so before the draft lands this fell through to the
      // login fallback and a card entry flashed a username/password form.
      const type = form?.type ?? base?.type ?? open?.type ?? 'login'
      const set = (patch) => onChange({ ...form, ...patch })
      const setGroup = (group, patch) => set({ [group]: { ...(form?.[group] ?? {}), ...patch } })
      const typeKey = TYPE_LABEL_KEYS[type]
      const fields = EDITOR_FIELDS[type] ?? []
      const groupKey = EDITOR_GROUPS[type]
      const valueOf = (field) => (groupKey ? form?.[type]?.[field.key] ?? '' : form?.[field.key] ?? '')
      const writeValue = (field, value) => (groupKey ? setGroup(type, { [field.key]: value }) : set({ [field.key]: value }))

      const label = (key) => t(key)
      const control = (field) => {
        const value = valueOf(field)
        const shared = {
          value,
          disabled: busy,
          style: field.control === 'textarea' ? { ...S.input, minHeight: 66, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } : S.input,
          'aria-label': label(field.label),
          onChange: (event) => writeValue(field, event.target.value),
        }
        if (field.control === 'textarea') {
          return h('textarea', { ...shared, rows: 3, spellcheck: false })
        }
        return h('input', { ...shared, type: field.control, spellcheck: false })
      }

      const row = (field) =>
        h(
          'label',
          { key: field.key, style: S.formRow, 'data-vw-editor-field': field.key },
          h('span', null, label(field.label)),
          control(field),
          field.hint ? h('span', { style: S.hint }, label(field.hint)) : null,
        )

      // A save that landed: the write is on the server, so the row says so at
      // once. A warning rides along only when the host could not fold the
      // change into its own copy — the list is behind, the write is not.
      const outcome = () => {
        if (!result) return null
        if (result.status === 'unchanged') {
          return h('span', { 'data-vw-editor-result': '', style: S.hint }, t('editorNoChanges'))
        }
        if (result.status === 'error') {
          return h('span', { 'data-vw-editor-error': '', style: S.error, role: 'alert' }, result.error ?? t('editorSaveFailed'))
        }
        if (result.status === 'reprompt') {
          return h('span', { 'data-vw-editor-error': '', style: S.error, role: 'alert' }, t('editorRepromptLocked'))
        }
        if (result.status === 'saved') {
          const warning = result.syncWarning
          return h(
            'div',
            { 'data-vw-editor-result': '', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('span', { style: S.ok }, t('editorSaved')),
            warning ? h('span', { style: { fontSize: 12.5, color: TOKEN.warn, lineHeight: 1.5 } }, t('editorSyncWarning').replace('{reason}', String(warning))) : h('span', { style: S.hint }, t('editorSynced')),
          )
        }
        return null
      }

      return h(
        'div',
        { 'data-vw-editor': '', style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: S.cardTitle }, open.mode === 'create' ? t('createTitle') : t('editTitle')),
          h(
            BadgeRow,
            { style: { marginLeft: 2 } },
            h(Badge, { tone: 'neutral' }, typeKey ? t(typeKey) : type),
            form?.favorite ? h(Badge, { tone: 'warn' }, t('favorite')) : null,
            Number(form?.reprompt) ? h(Badge, { tone: 'ok', title: t('editorRepromptHint') }, t('editorReprompt')) : null,
          ),
        ),
        stale ? h('div', { 'data-vw-editor-stale': '', style: { ...S.banner, borderColor: TOKEN.warn, color: TOKEN.text } }, t('editorStale')) : null,
        loading ? h('span', { style: S.note }, t('syncLoading')) : null,
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h(
            'label',
            { style: S.formRow },
            h('span', null, t('editorName')),
            h('input', {
              type: 'text',
              value: form?.name ?? '',
              disabled: busy,
              placeholder: t('editorNamePlaceholder'),
              'aria-label': t('editorName'),
              style: S.input,
              onChange: (event) => set({ name: event.target.value }),
            }),
          ),
          open.mode === 'create'
            ? h(
                'label',
                { style: S.formRow },
                h('span', null, t('editorType')),
                h(
                  'select',
                  {
                    style: S.select,
                    value: type,
                    disabled: busy,
                    'aria-label': t('editorType'),
                    onChange: (event) => onChange(blankForm(event.target.value)),
                  },
                  EDITOR_TYPE_ORDER.map((name) => h('option', { key: name, value: name }, t(TYPE_LABEL_KEYS[name]))),
                ),
              )
            : null,
          groupKey ? h('span', { style: { fontSize: 12, fontWeight: 600, color: TOKEN.text2 } }, label(groupKey)) : null,
          ...fields.map(row),
          type === 'secureNote'
            ? h(
                'label',
                { style: S.formRow, 'data-vw-editor-field': 'notes' },
                h('span', null, t('secureNoteBody')),
                h('textarea', {
                  rows: 5,
                  value: form?.notes ?? '',
                  disabled: busy,
                  placeholder: t('editorNotes'),
                  'aria-label': t('secureNoteBody'),
                  style: { ...S.input, minHeight: 90, resize: 'vertical' },
                  onChange: (event) => set({ notes: event.target.value }),
                }),
              )
            : h(
                'label',
                { style: S.formRow, 'data-vw-editor-field': 'notes' },
                h('span', null, t('editorNotes')),
                h('textarea', {
                  rows: 3,
                  value: form?.notes ?? '',
                  disabled: busy,
                  'aria-label': t('editorNotes'),
                  style: { ...S.input, minHeight: 66, resize: 'vertical' },
                  onChange: (event) => set({ notes: event.target.value }),
                }),
              ),
        ),
        // Folder: only personal entries can move between folders, and the
        // list is the host's own, so the choice is never invented here.
        open.mode === 'edit' && !base?.organizationId
          ? h(
              'label',
              { style: S.formRow },
              h('span', null, t('editorFolder')),
              h(
                'select',
                {
                  style: S.select,
                  value: form?.folderId ?? '',
                  disabled: busy,
                  'aria-label': t('editorFolder'),
                  onChange: (event) => set({ folderId: event.target.value }),
                },
                h('option', { key: '__none__', value: '' }, t('editorFolderNone')),
                ...(folders ?? []).map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)),
              ),
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
          h(
            'label',
            { style: { ...S.formRow, flexDirection: 'row', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'checkbox',
              checked: Boolean(form?.favorite),
              disabled: busy,
              'aria-label': t('editorFavorite'),
              onChange: (event) => set({ favorite: event.target.checked }),
            }),
            h('span', null, t('editorFavorite')),
          ),
          h(
            'label',
            { style: { ...S.formRow, flexDirection: 'row', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'checkbox',
              checked: Boolean(Number(form?.reprompt)),
              disabled: busy,
              'aria-label': t('editorReprompt'),
              onChange: (event) => set({ reprompt: event.target.checked ? 1 : 0 }),
            }),
            h('span', null, t('editorReprompt')),
            h('span', { style: S.hint }, t('editorRepromptHint')),
          ),
        ),
        h(
          'div',
          { 'data-vw-editor-fields': '', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: TOKEN.text2 } }, t('editorCustomFields')),
          ...(form?.fields ?? []).map((field, index) =>
            h(
              'div',
              { key: 'field-' + index, style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) auto', gap: 8, alignItems: 'center' } },
              h('input', {
                type: 'text',
                value: field.name ?? '',
                disabled: busy,
                placeholder: t('editorFieldName'),
                'aria-label': t('editorFieldName'),
                style: S.input,
                onChange: (event) => {
                  const next = (form?.fields ?? []).map((entry, i) => (i === index ? { ...entry, name: event.target.value } : entry))
                  set({ fields: next })
                },
              }),
              h('input', {
                type: 'text',
                value: field.value ?? '',
                disabled: busy,
                placeholder: t('editorFieldValue'),
                'aria-label': t('editorFieldValue'),
                style: S.input,
                onChange: (event) => {
                  const next = (form?.fields ?? []).map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry))
                  set({ fields: next })
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  style: { ...S.button, height: 28, width: 28, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
                  disabled: busy,
                  'aria-label': t('editorRemoveField'),
                  onClick: () => set({ fields: (form?.fields ?? []).filter((_, i) => i !== index) }),
                },
                navGlyph('close', 13),
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              'data-vw-editor-add-field': '',
              style: { ...S.button, alignSelf: 'flex-start' },
              disabled: busy,
              onClick: () => set({ fields: [...(form?.fields ?? []), { name: '', value: '', type: 0 }] }),
            },
            t('editorAddField'),
          ),
        ),
        base?.hasFido2 ? h('span', { style: S.hint }, t('editorFido2Note')) : h('span', { style: S.hint }, t('editorUnmodelled')),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', { type: 'button', 'data-vw-editor-save': '', style: S.buttonPrimary, disabled: busy || loading || stale, onClick: onSave }, busy ? t('editorSaving') : t('editorSave')),
          h('button', { type: 'button', 'data-vw-editor-cancel': '', style: S.button, disabled: busy, onClick: onCancel }, t('editorCancel')),
        ),
        // The outcome belongs to the button that produced it, so it sits under
        // the buttons rather than at the top of the form where it read as a
        // page-level banner. The ref still scrolls it into view when one lands.
        h('div', { ref: outcomeRef, style: { display: 'flex', flexDirection: 'column', gap: 2 } }, outcome()),
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
    /**
     * The host's last session event, said in words.
     *
     * `report.lastSessionEvent` is how a background re-login explains itself,
     * and it is the difference between "the panel asks for my password again"
     * and "the panel asks for my password again, because the refresh was
     * rejected". An unknown kind is shown raw rather than dropped, so a newer
     * host loses nothing by having invented one.
     */
    // ── the transcript's own view of a bitwarden_* call ───────────────────────
    /**
     * Every tool this plugin registers into the conversation.
     *
     * The model needs the plaintext — that is the whole point of the plugin —
     * but the transcript is a different surface: it is read over a shoulder, in
     * screenshots, and in a session log that outlives the task. A password
     * sitting in a tool card is a secret leaking through a channel nobody
     * chose to open. So the row is rendered from the arguments and result this
     * module already has, with every secret-shaped value replaced by dots: the
     * row still says WHICH entry and WHICH field, never the value.
     *
     * What the mask sits ON is the host's own row, not a hand-drawn one:
     * `DisclosureRow` and the icons come from the platform's
     * `@deepseek-ai/dsh-client-ui-primitives` (a page seed word, and the same
     * module the official `skill` / `schedule` / `deliverables` rows build
     * themselves from). A bitwarden_get is the one call in this plugin whose
     * whole purpose is to hand the MODEL a plaintext secret, so unlike an SSH
     * tool — which simply never returns one — the masking cannot move into the
     * host result. It stays here, and only the shell around it is native.
     */
    const TOOL_ROW_KEYS = {
      bitwarden_find: { title: '检索凭据', kind: 'search', icon: 'IconSearchOutlineRegular' },
      bitwarden_get: { title: '读取凭据', kind: 'read', icon: 'IconBrowseOutlineRegular' },
      bitwarden_status: { title: '凭据库状态', kind: 'read', icon: 'IconGaugeOutlineRegular' },
      bitwarden_sync: { title: '同步保险库', kind: 'read', icon: 'IconRefreshOutlineRegular' },
      bitwarden_folders: { title: '文件夹列表', kind: 'read', icon: 'IconFolderOpenOutlineRegular' },
      bitwarden_create: { title: '新建条目', kind: 'edit', icon: 'IconEditOutlineRegular' },
      bitwarden_update: { title: '修改条目', kind: 'edit', icon: 'IconEditOutlineRegular' },
      bitwarden_delete: { title: '删除条目', kind: 'delete', icon: 'IconTrashOutlineRegular' },
      bitwarden_restore: { title: '恢复条目', kind: 'edit', icon: 'IconUnarchiveOutlineRegular' },
    }
    /**
     * Value keys whose contents are secrets, wherever they appear in a
     * bitwarden_* payload. Matched case-insensitively on the key alone, so a
     * nested `card.number` or a `fields[].value` is caught the same way a
     * top-level `password` is.
     */
    const SECRET_KEY = /^(password|passphrase|totp|totpsecret|secret|number|code|securitycode|ssn|socialsecuritynumber|passportnumber|licensenumber|privatekey|notes|value|notesvalue|cardnumber|cvv|cvc|pin|apikeyclientsecret|apikey|token|accesstoken|refreshtoken|clientsecret|masterpassword|masterkey|encryptedkey|repromptpassword)$/i
    /** A masked value, drawn in place of a secret. */
    const MASK = '••••••••'
    const isSecretKey = (key) => SECRET_KEY.test(String(key ?? '').replace(/[_-]/g, ''))
    /**
     * Rebuild a tool payload with every secret-shaped value masked.
     *
     * Recursive and shape-agnostic: the tools answer objects (one entry's
     * fields), arrays (search hits) and strings (a rendered report). A string
     * payload is masked line by line, because the tool's own renderer emits
     * `"password": "…"` inside JSON text — that is exactly the form the
     * transcript shows today.
     */
    const maskSecrets = (value, depth = 0) => {
      if (depth > 8 || value === null || value === undefined) return value
      if (typeof value === 'string') return maskSecretText(value)
      if (Array.isArray(value)) return value.map((entry) => maskSecrets(entry, depth + 1))
      if (typeof value !== 'object') return value
      const out = {}
      for (const [key, raw] of Object.entries(value)) {
        out[key] = isSecretKey(key) && raw !== null && raw !== undefined && String(raw) !== '' ? MASK : maskSecrets(raw, depth + 1)
      }
      return out
    }
    /**
     * Mask the secret values inside a JSON/text payload line by line.
     *
     * Deliberately conservative: it only rewrites values whose own key names
     * them a secret, and it never touches identifiers (id/name/username/uris)
     * — a row that lost its name would be unreadable, and the name is not what
     * this protects.
     */
    const maskSecretText = (text) =>
      String(text).replace(/"([A-Za-z0-9_]+)"\s*:\s*("(?:[^"\\]|\\.)*"|null)/g, (match, key, raw) => {
        if (!isSecretKey(key)) return match
        if (raw === 'null') return match
        return `"${key}": "${MASK}"`
      })
    /**
     * The result text of one settled tool row, or null while it is still
     * running. Mirrors ui-tool's contract: every text block joined, non-text
     * blocks serialized.
     */
    const toolResultText = (block) => {
      if (!block || !('content' in block)) return null
      const parts = []
      for (const item of block.content ?? []) parts.push(item?.type === 'text' ? String(item.text) : JSON.stringify(item, null, 2))
      if (parts.length === 0 && block.error) parts.push(`${block.error.name ?? 'error'}: ${block.error.code ?? ''}`)
      return parts.join('\n') || null
    }
    /**
     * What one call did, in the row's own words.
     *
     * Purely from the arguments and the masked answer: the entry's name and id
     * are identifiers, not secrets, and they are what makes the row worth
     * reading — "工具 · 读取凭据 · github.com" answers the reader's only
     * question (which credential did the agent touch) without answering the one
     * the masking exists to withhold.
     */
    const describeCall = (args, output, t) => {
      let parsed = null
      let count = null
      try {
        parsed = output ? JSON.parse(output) : null
        if (parsed && typeof parsed === 'object') {
          // A find answers with its own hit count; a get with the entry it read.
          if (Array.isArray(parsed.items)) count = parsed.items.length
          else if (typeof parsed.matched === 'number') count = parsed.matched
          else if (Array.isArray(parsed.folders)) count = parsed.folders.length
        }
      } catch {
        parsed = null
        count = null
      }
      // The entry's NAME is the useful label, and it is not a secret. A call
      // that named the entry in its arguments has it there; one that named only
      // an id gets it back in the answer — which beats printing a bare UUID the
      // reader cannot place. A status report has neither, and falls through.
      const label = args?.name ?? parsed?.name ?? args?.id ?? null
      const parts = []
      if (label) parts.push(String(label).slice(0, 60))
      if (count !== null) parts.push(t('toolHits').replace('{n}', String(count)))
      return parts.join(' · ') || t('toolDone')
    }
    /**
     * The host's own row furniture, when the page has it.
     *
     * `@deepseek-ai/dsh-client-ui-primitives` is a platform seed word: the web
     * shell boots it as a static module, and the host's own tool rows and the
     * official plugin rows (`skill`, `schedule`, `deliverables`) build
     * themselves from it. Reading it here is what makes a bitwarden_* row the
     * SAME row a `运行命令` call draws, rather than a lookalike drawn beside it.
     *
     * Optional on purpose, and resolved lazily once: a page that hosts this
     * bundle outside the web shell (the test harness, an older shell) must
     * still get a working, masked row rather than a crash, so every call site
     * falls back to plain elements carrying the same text and the same hooks.
     */
    let primitivesCache
    const primitives = () => {
      if (primitivesCache !== undefined) return primitivesCache
      try {
        primitivesCache = require('@deepseek-ai/dsh-client-ui-primitives') ?? null
      } catch {
        primitivesCache = null
      }
      return primitivesCache
    }
    /**
     * The body of an expanded row, styled as the host styles a tool's input /
     * output pair: the markdown code surface, a caption-coloured label column,
     * and a scrolling text column. Tokens only, so it follows the theme.
     */
    const IO = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        margin: '4px 0 4px 4px',
        border: `0.5px solid var(--dsw-alias-border-l1, ${TOKEN.border})`,
        borderRadius: 'var(--dsw-radius-lg, 16px)',
        background: `var(--dsw-alias-markdown-code-block, ${TOKEN.bg2})`,
        /**
         * The host sets its io card's type with this one shorthand, and every
         * child inherits it: 11px code face on a 16px line box. Without it the
         * body fell back to the surrounding UI face at per-child sizes, which
         * is why the row read as a different kind of object than a native bash
         * row sitting right beside it. Declared once here, and to the
         * children's exclusion, so the label and the text share one grid.
         */
        font: 'var(--dsw-font-markdown-code-block-small, 11px/16px var(--ds-font-family-code, ui-monospace, monospace))',
        overflow: 'hidden',
      },
      section: {
        display: 'grid',
        gridTemplateColumns: 'max-content minmax(0, 1fr)',
        alignItems: 'baseline',
        columnGap: 14,
        padding: '12px 16px',
        maxHeight: 150,
        overflowY: 'auto',
      },
      // No font-size here: the host's ioLabel takes its type from the card
      // shorthand, so the label sits on the same 16px grid as the text column
      // beside it. A hardcoded size is what broke that alignment.
      label: {
        position: 'sticky',
        top: 0,
        alignSelf: 'start',
        color: 'var(--dsw-alias-label-caption, ' + TOKEN.text2 + ')',
        whiteSpace: 'nowrap',
      },
      // Same reasoning as the label: the card owns the type, this column only
      // owns the colour and the wrapping behaviour.
      text: {
        minWidth: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: TOKEN.text2,
      },
      divider: { flex: 'none', height: '0.5px', background: TOKEN.borderStrong },
      /**
       * The collapsed line, matching the host's own summary: secondary tier
       * size, the row's line box, ellipsised from the end.
       *
       * `flex: auto` and `min-width: 0` are load-bearing, not decoration: the
       * host hands this node to `TextShimmer`, whose content slot is a flex
       * row, so a child that cannot shrink would push the row wide instead of
       * ellipsising — the one visible difference from a native row.
       */
      summaryWrap: {
        display: 'inline-flex',
        alignItems: 'center',
        flex: 'auto',
        minWidth: 0,
        overflow: 'hidden',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
        lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
      },
      summary: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      /** The host's separator: a 2px caption dot between title and summary. */
      sep: {
        flex: 'none',
        width: 2,
        height: 2,
        margin: '0 8px',
        borderRadius: 1,
        background: 'var(--dsw-alias-label-caption, ' + TOKEN.text2 + ')',
      },
      // ── the primitives-free fallback header ─────────────────────────────────
      fallbackRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        minWidth: 0,
        padding: 0,
        border: 0,
        background: 'transparent',
        color: TOKEN.text2,
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 13,
      },
      fallbackTitle: { flex: 'none', color: TOKEN.text },
    }

    /**
     * One `bitwarden_*` call as the transcript draws it: what was asked and
     * what came back, with every secret masked to dots.
     *
     * Reads only from the settled block, so it replays identically from a
     * stored session and never re-runs a call to render a row.
     */
    function BitwardenToolRow(props) {
      const { block, t } = props
      const meta = TOOL_ROW_KEYS[props.toolName] ?? { title: props.toolName, kind: 'other' }
      const settled = block && 'kind' in block
      const argsRaw = (settled ? block.call?.argsRaw : block?.argsRaw) ?? ''
      let args = null
      try {
        args = argsRaw ? JSON.parse(argsRaw) : null
      } catch {
        args = null
      }
      const output = settled ? toolResultText(block) : null
      // The arguments are masked too: `bitwarden_create` carries the password
      // the model was asked to set, and showing it would undo the point.
      const shownArgs = args ? JSON.stringify(maskSecrets(args), null, 2) : maskSecretText(argsRaw)
      const shownOutput = output === null ? null : maskSecretText(output)
      const [open, setOpen] = useState(false)
      const running = !settled
      const failed = Boolean(settled && block.isError)
      // The line says what the call did, not just that it happened: it names the
      // entry that was touched. There is no "secrets hidden" note — the dots in
      // the expanded body are the whole signal, and a badge repeating it on every
      // row only adds noise to lines that already have nothing to hide.
      const summary = running ? t('toolRunning') : failed ? t('toolFailed') : describeCall(args, shownOutput, t)
      const expandable = Boolean(argsRaw || shownOutput !== null)
      const shown = open && expandable
      const prim = primitives()
      const DisclosureRow = prim?.DisclosureRow
      // Which glyph a row wears is this table's business; the host exports the
      // set, so an unknown name degrades to no icon rather than to a crash.
      const Icon = meta.icon ? prim?.[meta.icon] : null
      const section = (label, text, error) =>
        h(
          'div',
          { style: IO.section },
          h('span', { style: IO.label }, label),
          // The style object goes under `style`, like every sibling above. It
          // used to be spread as the prop bag itself, which React turned into
          // stray minwidth/whitespace/wordbreak ATTRIBUTES: none of the
          // declarations applied, so the payload rendered as one unwrapped run
          // with its newlines collapsed instead of the host's pre-wrap column.
          h(
            'span',
            error ? { style: { ...IO.text, color: TOKEN.err } } : { style: IO.text },
            text,
          ),
        )
      const body = shown
        ? h(
            'div',
            { style: IO.card },
            argsRaw ? section(t('toolArgs'), shownArgs, false) : null,
            argsRaw && shownOutput !== null ? h('span', { style: IO.divider, 'aria-hidden': true }) : null,
            shownOutput !== null ? section(failed ? t('toolError') : t('toolResult'), shownOutput, failed) : null,
          )
        : null
      // The line reads "标题 · 摘要", with the host's own separator dot — the same
      // 2px caption-coloured mark a bash row draws between its title and
      // description. Without it the summary would trail the title ambiguously.
      const summaryNode = h(
        'span',
        { style: IO.summaryWrap, 'data-vw-tool-summary': '' },
        h('span', { style: IO.sep, 'data-shimmer-decoration': '', 'aria-hidden': true }),
        h('span', { style: IO.summary }, summary),
      )
      const rowProps = {
        'data-vw-tool-row': props.toolName,
        'data-state': running ? 'running' : failed ? 'error' : 'ok',
      }
      if (DisclosureRow) {
        // The native header, verbatim: same 16px leading box, 13px title, hover
        // chevron, whole-row click target and keyboard handling as every other
        // tool row. The summary rides the same collapsed slot a bash row puts
        // its description in, so the two line up to the pixel.
        return h('div', rowProps, h(DisclosureRow, {
          icon: Icon ? h(Icon, { size: 14 }) : null,
          title: meta.title,
          running,
          open: shown,
          expandable,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: () => setOpen((previous) => !previous),
          collapsedContent: summaryNode,
        }, body))
      }
      // No primitives on this page: the same anatomy from plain elements —
      // same text, same a11y contract, same masking, no crash.
      return h('div', rowProps,
        h(
          'button',
          {
            type: 'button',
            'data-vw-tool-toggle': '',
            'aria-expanded': shown ? 'true' : 'false',
            disabled: !expandable,
            onClick: () => setOpen((previous) => !previous),
            style: IO.fallbackRow,
          },
          Icon ? h(Icon, { size: 14 }) : null,
          h('span', { style: IO.fallbackTitle }, meta.title),
          summaryNode,
        ),
        body,
      )
    }

    const sessionEventOf = (report, t) => {
      const event = report?.lastSessionEvent
      if (!event?.kind) return null
      const key = SESSION_EVENT_KEYS[event.kind]
      const parts = [key ? t(key) : String(event.kind)]
      if (event.message) parts.push(String(event.message))
      if (event.at) parts.push(absoluteTime(event.at))
      // A recovered re-login is good news; a rejected refresh is a warning; a
      // failed one is why the sign-in form is about to appear.
      const tone = event.kind === 'relogin' ? 'ok' : event.kind === 'login_failed' ? 'err' : 'warn'
      return { text: t('syncTipSessionEvent').replace('{event}', parts.join(' · ')), tone }
    }

    function SyncChip({ report, t, invoke, onSynced }) {
      const session = report?.session ?? null
      const [state, setState] = useState({ status: 'idle' })
      const live = report?.liveSync ?? {}
      const mode = live.mode ?? 'off'
      const busy = state.status === 'syncing'
      const baseTone = busy ? 'idle' : mode === 'websocket' ? (live.connected ? 'ok' : 'warn') : mode === 'polling' ? 'warn' : 'idle'
      const sessionEvent = sessionEventOf(report, t)
      // The chip must not keep glowing green while the host is reporting that
      // its last background re-login failed.
      const tone = busy || !sessionEvent || sessionEvent.tone === 'ok' ? baseTone : sessionEvent.tone === 'err' ? 'err' : baseTone === 'ok' ? 'warn' : baseTone
      const label = mode === 'websocket' ? t('syncWebsocket') : mode === 'polling' ? t('syncPolling') : t('syncOff')
      const detail = [
        t('syncTipClick'),
        t('syncTipMode').replace('{mode}', label),
        t('syncTipConnected').replace('{state}', live.connected ? t('syncTipYes') : t('syncTipNo')),
        live.pollIntervalMs ? t('syncTipInterval').replace('{seconds}', String(Math.round(live.pollIntervalMs / 1000))) : null,
        live.lastSyncAt ? t('syncTipLastSync').replace('{time}', absoluteTime(live.lastSyncAt)) : null,
        live.lastSignalAt ? t('syncTipLastSignal').replace('{time}', absoluteTime(live.lastSignalAt)) : null,
        sessionEvent ? sessionEvent.text : null,
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
        // The dot carries the tone twice: as its own fill and as its colour,
        // because the breathing layers are pseudo-elements and a pseudo can
        // only inherit currentColor. The layer is drawn only for the two
        // "this is live" tones — a still grey dot for 已关闭, a still red one
        // for a failure — so the motion itself means "connected".
        h('span', { 'data-vw-sync-dot': tone, style: { ...S.dot, background: TOKEN[tone], color: TOKEN[tone] } }),
        busy ? t('syncNow') : label,
        live.lastSyncAt ? h('span', { style: { color: TOKEN.text2 } }, relativeTime(live.lastSyncAt, t)) : null,
      )
    }

    /**
     * Blend two colour tokens by ratio: 0 returns from, 1 returns to.
     *
     * Both sides are var() chains resolved per theme, so no JS colour maths can
     * touch them — but color-mix() takes the chains verbatim and lets the
     * browser resolve them. A browser without color-mix() snaps to the nearer
     * endpoint rather than dropping the stroke, which would blank the arc.
     */
    function rampTone(from, to, ratio) {
      const t = Math.max(0, Math.min(1, Number(ratio) || 0))
      if (t <= 0) return from
      if (t >= 1) return to
      const mixable = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', 'color-mix(in srgb, red 50%, blue)')
      if (!mixable) return t < 0.5 ? from : to
      return 'color-mix(in srgb, ' + to + ' ' + Math.round(t * 100) + '%, ' + from + ')'
    }

    /**
     * The countdown ring beside a live code.
     *
     * The remaining seconds sit inside an arc that shortens as the code ages,
     * and its tone ramps green → orange → red as the window closes. The arc
     * is SVG driven by `stroke-dashoffset`; the stylesheet animates that offset
     * over the second between two answers, so the ring sweeps instead of
     * ticking — and a reader who asks for reduced motion gets the steps without
     * the sweep.
     *
     * `role="img"` with a label: the ring is the only place the remaining
     * seconds are written down, and a screen reader should be told the number
     * rather than have to make sense of an arc.
     */
    function TotpRing({ seconds, period, label }) {
      // 30px box / r12 / 3.5px stroke: the smallest size that still reads at
      // 1× next to the 14px code, so the seconds never blur into the arc.
      const RING_SIZE = 30
      const RING_R = 12
      const RING_STROKE = 3.5
      const CENTRE = RING_SIZE / 2
      const CIRCUMFERENCE = 2 * Math.PI * RING_R
      const span = Number(period) > 0 ? Number(period) : 30
      const left = Math.max(0, Math.min(1, Number(seconds) / span))
      // The tone is a ramp, not three flat steps: the arc leaves green, cools
      // through orange, and lands on red as the window closes — the colour is
      // itself a reading of the time left, so it must move every second.
      const tone = left >= 0.5 ? TOKEN.ok : left >= 0.2 ? rampTone(TOKEN.ok, TOKEN.warn, (0.5 - left) / 0.3) : rampTone(TOKEN.warn, TOKEN.err, (0.2 - left) / 0.2)
      return h(
        'span',
        { style: { ...S.totpRing, width: RING_SIZE, height: RING_SIZE }, role: 'img', 'aria-label': label, title: label },
        h(
          'svg',
          {
            width: RING_SIZE,
            height: RING_SIZE,
            viewBox: '0 0 ' + RING_SIZE + ' ' + RING_SIZE,
            'aria-hidden': 'true',
            focusable: 'false',
            style: { position: 'absolute', top: 0, left: 0, transform: 'rotate(-90deg)' },
          },
          h('circle', { cx: CENTRE, cy: CENTRE, r: RING_R, fill: 'none', stroke: TOKEN.bg2, strokeWidth: RING_STROKE }),
          h('circle', {
            'data-vw-totp-ring': '',
            cx: CENTRE,
            cy: CENTRE,
            r: RING_R,
            fill: 'none',
            stroke: tone,
            strokeWidth: RING_STROKE,
            strokeLinecap: 'round',
            strokeDasharray: CIRCUMFERENCE.toFixed(2),
            strokeDashoffset: (CIRCUMFERENCE * (1 - left)).toFixed(2),
          }),
        ),
        h('span', { style: { ...S.totpRingText, color: tone } }, String(seconds)),
      )
    }

    /**
     * A code as it is read aloud: three digits, a space, three digits.
     *
     * The gap is the whole point — a bare six-digit string is a wall of
     * identical-width glyphs, while "686 029" is two groups the eye can carry
     * across to the keypad. Only the display is grouped: the value copied and
     * sent to the host stays the bare six digits.
     */
    const groupCode = (code) => {
      const text = String(code ?? '')
      if (!/^[0-9]{6,}$/.test(text)) return text
      return `${text.slice(0, 3)} ${text.slice(3)}`
    }

    /**
     * One timer for every live code on screen.
     *
     * Each row used to own a `setInterval(1000)`: fifty rows meant fifty timers
     * on fifty different phases, each firing its own `setState` and its own
     * read. The interval itself is cheap — what was not is that nothing
     * serialised them, so a full list paid fifty separate render passes every
     * second for one tick of the clock. A single shared beat puts them back in
     * one phase: the fifty results land in the same task, React batches them
     * into one render, and the ring drains in one visible step across the list
     * instead of fifty slightly different ones.
     *
     * The timer exists only while something is listening, so a panel without a
     * 验证码 row (or one where every such row is gated) runs no timer at all.
     */
    const totpClock = (() => {
      const listeners = new Set()
      let timer = null
      const beat = () => {
        // Copied: a listener may unsubscribe while the beat is running, and
        // one dead row must not stop the clock for the rest.
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch {
            /* a failed tick is the row's business, not the clock's */
          }
        }
      }
      return {
        add(listener) {
          listeners.add(listener)
          if (timer === null) timer = setInterval(beat, 1000)
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0 && timer !== null) {
              clearInterval(timer)
              timer = null
            }
          }
        },
      }
    })()

    /**
     * One TOTP answer serves its whole window: the code cannot change inside
     * it, and the countdown is arithmetic on the fetched answer. Rows used to
     * re-ask the host every second — fifty rows was fifty RPCs a second — for
     * values that were already on screen. The cache is shared by every row and
     * the detail pane, an answer without a code (a re-prompt refusal) is never
     * cached, and a window is refetched a second before it rolls.
     */
    // Keyed by the panel's `invoke`: each mounted panel owns its own answers, so
    // a remount with a different host (or a test harness with fresh fixtures)
    // starts from an empty cache instead of another panel's window.
    const totpCaches = new WeakMap()
    const totpOf = (invoke, id) => {
      let totpWindowCache = totpCaches.get(invoke)
      if (!totpWindowCache) {
        totpWindowCache = new Map()
        totpCaches.set(invoke, totpWindowCache)
      }
      const hit = totpWindowCache.get(id)
      const now = Date.now()
      if (hit && now < hit.expiresAt - 1000) return Promise.resolve(hit.derive(now))
      if (hit && hit.inFlight) return hit.inFlight
      const inFlight = invoke('totp', { id })
        .then((value) => {
          const entry = totpWindowCache.get(id)
          if (entry) entry.inFlight = null
          const totp = value?.totp
          if (!totp || totp.code === undefined) {
            totpWindowCache.delete(id)
            return value
          }
          const period = Number(totp.period) > 0 ? Number(totp.period) : 30
          const seconds = Number.isFinite(totp.secondsRemaining) ? Math.max(1, Math.round(totp.secondsRemaining)) : period
          const expiresAt = Date.now() + seconds * 1000
          const fresh = {
            expiresAt,
            inFlight: null,
            derive: (at) => ({ ...value, totp: { ...totp, secondsRemaining: Math.max(0, Math.round((expiresAt - at) / 1000)) } }),
          }
          if (totpWindowCache.size > 200) {
            for (const [key, stale] of totpWindowCache) {
              if (stale !== fresh && stale.expiresAt < now) totpWindowCache.delete(key)
            }
          }
          totpWindowCache.set(id, fresh)
          return fresh.derive(Date.now())
        })
        .catch((error) => {
          const entry = totpWindowCache.get(id)
          if (entry) entry.inFlight = null
          throw error
        })
      if (hit) hit.inFlight = inFlight
      else totpWindowCache.set(id, { expiresAt: 0, inFlight, derive: () => null })
      return inFlight
    }

    const VaultRow = react.memo(function VaultRow({ item, selected, sectionKind, includeTrashed, iconTick, onSelect, t, invoke }) {
    return h(
                  'div',
                  {
                    key: item.id,
                    role: 'option',
                    // Every row is a div now, and every row is focusable: the
                    // hover island holds real buttons, and a button cannot nest
                    // a button. Enter and Space are what a div has to re-learn
                    // once the UA stops doing it (see onKeyDown below).
                    tabIndex: 0,
                    'aria-selected': selected ? 'true' : 'false',
                    'data-row': '',
                    'data-vw-totp-row': sectionKind === SECTION_TOTP ? '' : undefined,
                    'data-trashed': item.trashed ? 'true' : undefined,
                    style: S.listRow,
                    onClick: () => onSelect(item.id),
                    onKeyDown: (event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      // A key pressed inside one of the island's own buttons is
                      // that button's, not the row's.
                      if (event.target !== event.currentTarget) return
                      event.preventDefault()
                      onSelect(item.id)
                    },
                  },
                  // A monogram tile instead of a bare letter: it reads as an icon
                  // slot, so rows line up whether or not an entry has a favicon.
                  // The favicon takes the slot when the server has one (see
                  // `iconFor`); the letter stays underneath while it loads.
                  h('span', { style: S.avatar, 'aria-hidden': 'true' }, iconFor(item) ?? monogram(item)),
                  h(
                    'span',
                    { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
                    // A trashed row is struck through: it is in the list because
                    // the reader asked for the trash, and it must not read like a
                    // live credential at a glance.
                    h(
                      'span',
                      { style: item.trashed ? { ...S.listName, textDecoration: 'line-through', color: TOKEN.text2 } : S.listName },
                      item.name || t('untitled'),
                    ),
                    // The subtitle is a dotted line, not a badge rack: user name,
                    // then where it points, then when it last moved. Each part is
                    // optional and the separators follow, so a card with no
                    // username does not open with a dangling dot.
                    h(
                      'span',
                      {
                        style: S.listMeta,
                        title: item.revisionDate ? t('listMetaTimeTip').replace('{time}', absoluteTime(item.revisionDate)) : undefined,
                      },
                      [item.username, hostOf(item.uris?.[0]), item.revisionDate ? relativeTime(item.revisionDate, t) : null]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  ),
                  // The 验证码 place exists to read codes, so its rows trade the
                  // badges and the chevron for the code itself: ring, grouped
                  // digits, and a copy control.
                  sectionKind === SECTION_TOTP
                    ? h(TotpRowTail, { item, invoke, t })
                    : [
                        // The row's marks travel as one group: a trashed entry
                        // that also carries a code used to put its two badges at
                        // whatever width each happened to need, so the column of
                        // marks never lined up between rows. A fixed 6px gap and
                        // one shared box keep them in a column, and the chevron
                        // stays out of it — it is a control, not a mark.
                        h(
                          BadgeRow,
                          { key: 'marks', 'data-vw-marks': '' },
                          item.trashed ? h(Badge, { tone: 'warn', title: t('trashTip') }, t('trashBadge')) : null,
                          item.archived ? h(Badge, { tone: 'muted', title: t('archivedTip') }, t('archived')) : null,
                          item.hasTotp ? h(Badge, { tone: 'info', title: t('hasTotp') }, 'TOTP') : null,
                        ),
                        // The star is 14px of decoration, so it gets the rail's
                        // own glyph rather than a ★ character: the character's
                        // optical size and baseline follow the host font, which
                        // is exactly the mismatch the sidebar stopped having.
                        item.favorite
                          ? h('span', { style: { display: 'inline-flex', color: TOKEN.warnText, flex: 'none' }, title: t('favorite'), 'aria-label': t('favorite'), role: 'img' }, navGlyph('favorites', 14))
                          : null,
                        // The hover island: copy the account, copy the password,
                        // without opening the card first. Reading a name is the
                        // common case, and opening a card to do it is ceremony.
                        // The password is not in the list projection at all - the
                        // row asks for it on click (see the `load` prop), which is
                        // also what keeps a reprompt-gated entry gated: the read
                        // comes back refused and the button simply never confirms.
                        h(
                          'span',
                          { key: 'island', 'data-vw-row-actions': '', style: S.rowActions },
                          item.username
                            ? h(CopyButton, {
                                key: 'user',
                                value: item.username,
                                t,
                                icon: true,
                                glyph: 'identity',
                                box: S.rowActionBtn,
                                label: t('copyUsername'),
                              })
                            : null,
                          h(CopyButton, {
                            key: 'pass',
                            t,
                            icon: true,
                            glyph: 'login',
                            box: S.rowActionBtn,
                            label: t('copyPassword'),
                            load: async () => {
                              const view = await invoke('reveal', {
                                id: item.id,
                                field: 'password',
                                includeTrashed: includeTrashed,
                              })
                              return view?.password ?? undefined
                            },
                          }),
                        ),
                        h('span', { 'data-vw-row-chevron': '', style: { display: 'inline-flex', flex: 'none', color: TOKEN.text2 }, 'aria-hidden': 'true' }, navGlyph('chevron', 14)),
                      ],
    )
    })

    /**
     * The trailing half of a 验证码 row: ring, code, and a copy control.
     *
     * Its own component because the code is a per-second value with its own
     * state, and a list of rows cannot hold one per row in the panel's own
     * hooks — the row is a component the moment it has state (the same reason
     * TotpValue exists).
     *
     * A re-prompt entry is shown as a label, never as a code, and is not
     * polled: this list used to be the one read surface that skipped the
     * master-password gate, so a 30 s code for an entry the operator had
     * flagged «ask me again» sat on screen for anyone who walked past. The
     * host now answers such a row with `repromptRequired`, and the slow
     * interval below exists so the row notices the moment the reader unlocks
     * that entry elsewhere — without asking every second on a row that cannot
     * answer.
     */
    function TotpRowTail({ item, invoke, t }) {
      const [state, setState] = useState({ status: 'loading' })
      const [copied, setCopied] = useState(false)
      const gated = Boolean(state.status === 'ready' && state.value?.repromptRequired)
      useEffect(() => {
        if (gated) return undefined
        let alive = true
        const tick = () =>
          totpOf(invoke, item.id)
            .then((value) => alive && setState({ status: 'ready', value }))
            .catch(() => alive && setState({ status: 'error' }))
        tick()
        const stop = totpClock.add(tick)
        return () => {
          alive = false
          stop()
        }
      }, [item.id, invoke, gated])
      // A gated row still asks, just rarely: the grant the reader proves on
      // another pane is the only thing that can turn this row back on.
      useEffect(() => {
        if (!gated) return undefined
        let alive = true
        const timer = setInterval(() => {
          invoke('totp', { id: item.id })
            .then((value) => alive && setState({ status: 'ready', value }))
            .catch(() => {})
        }, 30000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [item.id, invoke, gated])
      useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
      }, [copied])
      if (gated) {
        return h('span', { style: S.listMeta, title: t('totpGatedTip') }, t('totpGated'))
      }
      const totp = state.status === 'ready' ? state.value?.totp : null
      if (!totp || totp.code === undefined) return h('span', { style: S.listMeta }, '—')
      return [
        h(TotpRing, {
          key: 'ring',
          seconds: totp.secondsRemaining,
          period: totp.period,
          label: t('totpRingTip').replace('{seconds}', String(totp.secondsRemaining)),
        }),
        h('span', { key: 'code', 'data-vw-totp-code': '', style: { ...S.mono, fontSize: 14, letterSpacing: 0.5, flex: 'none' } }, groupCode(totp.code)),
        h(
          'button',
          {
            key: 'copy',
            type: 'button',
            'data-vw-totp-copy': '',
            style: copied ? { ...S.inlineIconButton, color: TOKEN.ok, borderColor: TOKEN.ok } : S.inlineIconButton,
            title: copied ? t('copied') : t('totpCopyTip'),
            'aria-label': copied ? t('copied') : t('totpCopyTip'),
            // The row underneath selects the entry; copying a code is not
            // selecting it, so the click stops here.
            onClick: async (event) => {
              event.stopPropagation()
              try {
                // A code has a 30 s life, but the clipboard copy of it does
                // not: same expiry rule as a password.
                await copyWithExpiry(totp.code, () => setCopied(true))
              } catch {
                /* clipboard unavailable (insecure context): nothing to confirm */
              }
            },
          },
          navGlyph(copied ? 'check' : 'copy', 14),
        ),
      ]
    }

    /**
     * Live TOTP code with a countdown ring (one RPC call per second).
     *
     * A re-prompt entry answers with `repromptRequired` instead of a code, and
     * the row then says so: the gate is opened on the entry's own pane, not
     * from inside a read-only countdown somebody may be watching.
     */
    function TotpValue({ id, invoke, t }) {
      const [state, setState] = useState({ status: 'loading' })
      const gated = Boolean(state.status === 'ready' && state.value?.repromptRequired)
      useEffect(() => {
        if (gated) return undefined
        let alive = true
        const tick = () =>
          totpOf(invoke, id)
            .then((value) => alive && setState({ status: 'ready', value }))
            .catch(() => alive && setState({ status: 'error' }))
        tick()
        const stop = totpClock.add(tick)
        return () => {
          alive = false
          stop()
        }
      }, [id, invoke, gated])
      if (gated) return h('span', { style: S.listMeta, title: t('totpGatedTip') }, t('totpGated'))
      if (state.status !== 'ready' || !state.value?.totp) return h('span', { style: S.listMeta }, '—')
      const { code, secondsRemaining, period } = state.value.totp
      if (code === undefined) return h('span', { style: S.listMeta }, '—')
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
        h('span', { style: { ...S.mono, fontSize: 14, letterSpacing: 1 } }, code),
        h(TotpRing, { seconds: secondsRemaining, period, label: t('totpRingTip').replace('{seconds}', String(secondsRemaining)) }),
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
        { style: { ...S.detail, ...S.scrollItem, maxWidth: 520 } },
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
        { style: { ...S.detail, ...S.scrollItem, maxWidth: 520 } },
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
        { style: { ...S.detail, ...S.scrollItem, maxWidth: 520 } },
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
      // Re-prompt state: the typed master password never leaves this component
      // except in the authorizeReprompt call itself, and `grant` is just a
      // countdown the host reports back — it holds no secret.
      const [repromptPw, setRepromptPw] = useState('')
      const [repromptErr, setRepromptErr] = useState(null)
      const [repromptBusy, setRepromptBusy] = useState(false)
      const [grant, setGrant] = useState({ granted: false, remainingMs: 0 })
      // Card numbers, identities and SSH keys no longer ride along with `all`,
      // so the panel fetches each class only when the reader asks for it. The
      // result is held per entry id and dropped as soon as the selection moves.
      const [typeFields, setTypeFields] = useState({})
      const [setup, setSetup] = useState({ status: 'loading' })
      /**
       * The installed build, as the host reports it on `boot`.
       *
       * The title row shows it, so it has to survive the panel's own state
       * machine — a cached reopen that skips the boot round trip keeps the
       * value from the last real one rather than dropping it. Null until a
       * host answers, which is why the title renders the version only when
       * there is one.
       */
      const [plugin, setPlugin] = useState(null)
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
      // The sidebar's place: which section the list is showing. Kept in state
      // rather than passed into the read, because the toolbar, the counter, the
      // detail's trash handling and the write path all have to agree on it.
      const [section, setSection] = useState(DEFAULT_SECTION)
      /**
       * A place change is in flight: the rows on screen still belong to the
       * previous place and are about to be replaced.
       *
       * This is what lets the switch animate instead of cut. Without it the
       * grid re-renders the new place's (empty) rows the moment the sidebar is
       * clicked, so the list visibly empties and then refills — the flicker
       * reported. With it the old rows stay, dimmed, until the answer for the
       * new place lands and the keyed list fades its own rows in.
       */
      const [switching, setSwitching] = useState(false)
      /**
       * Which place the rows in `state.list` actually belong to.
       *
       * Not the same thing as `section`: switching place is instant, while the
       * rows for the new place arrive a round trip later — and until they do,
       * `state.list` still holds the previous place's. Rendering those rows
       * through the new place's rules is how a switch to 验证码 put fifty login
       * rows on screen dressed as code rows, each one polling for a code it
       * does not have. Anything that depends on the place's KIND for what a row
       * *is* reads this; anything about where the reader is going reads `section`.
       */
      const [listSection, setListSection] = useState(DEFAULT_SECTION)
      /** Latest `listSection`, for the async reveal paths that need it without re-binding. */
      const listSectionRef = useRef(DEFAULT_SECTION)
      listSectionRef.current = listSection
      // The host's own per-section counts (vw/overview): one read gives every
      // place's size, so a badge describes the pool the host will serve rather
      // than the page that happens to be loaded. Null until it lands — and left
      // null on a host that predates the method, where the navigation falls
      // back to the one place that needs no counts at all.
      const [overview, setOverview] = useState(null)
      // A probe answers outside React (module scope), so its arrival is a
      // re-render here rather than a state write there. Bumping the version is
      // the whole wake-up: the rows read the map on the way through.
      //
      // The value is kept, not just the setter: the icon drain is an effect,
      // and it has to re-run when a host JOINS the queue — which happens in a
      // render that may leave every other dependency untouched.
      const [iconTick, setIconTick] = useState(0)
      useEffect(() => {
        const notify = () => setIconTick(iconVersion)
        iconSubscribers.add(notify)
        return () => iconSubscribers.delete(notify)
      }, [])
      // Folder id → name, for the move-to-folder step.
      const [folders, setFolders] = useState([])
      // Whether the panel may write at all: the host derives its form over its
      // own schema, so the tier is read from the configuration, never guessed.
      const [accessMode, setAccessMode] = useState('readonly')
      // Bumped after a write, so the open entry re-reads its new state.
      const [detailGen, setDetailGen] = useState(0)
      /**
       * What is left of an entry once the host's answer is taken away: the
       * identity a locked pane still renders, and nothing else.
       *
       * `projectItem` answers a gated entry with exactly these keys (id, name,
       * type, uris, repromptRequired, hint). Reusing that shape here means the
       * pane does not need a second branch: it falls into the same
       * `value.repromptRequired` render it would have got from the host, and
       * the re-read that follows simply confirms it.
       */
      const gatedStub = (value) => ({
        id: value?.id ?? null,
        name: value?.name ?? null,
        type: value?.type ?? null,
        uris: value?.uris,
        repromptRequired: true,
      })
      /**
       * The write step waiting for confirmation, or null. One slot for every
       * action (archive, trash, restore, move): the confirmation is always the
       * same card, and only one write can be in flight at a time.
       */
      const [pendingWrite, setPendingWrite] = useState(null)
      /**
       * The last write's outcome, tagged with the entry it belongs to — so a
       * message from the entry the user has since left is never painted into
       * the one on screen now.
       */
      const [writeState, setWriteState] = useState({ status: 'idle', id: null })
      /** The move step: null closed, '' means "out of every folder". */
      const [moveTarget, setMoveTarget] = useState(null)
      /**
       * The editor: null closed, otherwise the entry being edited or created.
       *
       * `base` is the draft the host handed over and `draft` is what the reader
       * has since typed, so a save can name exactly which fields changed — and
       * the host can be told about those alone, which is what keeps an edit
       * from disturbing fields this form never showed (passkeys, attachments,
       * password history).
       */
      const [editor, setEditor] = useState(null)
      /** The draft the host returned, for the diff above. */
      const [editorBase, setEditorBase] = useState(null)
      /** A save in flight, so the buttons say so and a second click is ignored. */
      const [editorBusy, setEditorBusy] = useState(false)
      /** The last save's outcome, including the sync warning if there was one. */
      const [editorResult, setEditorResult] = useState(null)
      /**
       * Set when the vault changed elsewhere while this editor was open. The
       * write is refused by the host in that case (its own copy moved on), so
       * the reader is told to re-read rather than silently overwriting.
       */
      const [editorStale, setEditorStale] = useState(false)
      /**
       * What the reader has typed into the open editor. A plain object held
       * apart from `editor` (which says *which* entry is open) so every
       * keystroke is a diffable value rather than a re-read of the host draft.
       */
      const [editorForm, setEditorForm] = useState(null)
      /**
       * Whether the host's `draft` answer is still in flight for the entry the
       * editor was opened for: the pane shows a loading state until it lands,
       * and a late answer for a closed editor is dropped.
       */
      const [editorLoading, setEditorLoading] = useState(false)
      /** The two collapsed detail sections (attachments, password history). */
      const [historyOpen, setHistoryOpen] = useState(false)
      const [attachmentsOpen, setAttachmentsOpen] = useState(false)
      const searchRef = useRef(null)
      /** Latest status, readable from callbacks without adding a dependency. */
      const statusRef = useRef('loading')
      statusRef.current = state.status
      // The pause is about WHICH report was landed, not which rows are up: a
      // settled list must keep the chip it drew instead of overwriting it with
      // an older read's. Both feedback paths re-read `state` through the
      // functional setter, because `state` in this closure is the render that
      // started the read — by the time either answer lands it is stale.
      const liveReportRef = useRef(null)
      // Deliberately NOT assigned from `state.report` on every render.
      //
      // It used to be, and that quietly defeated the whole point of firing the
      // list and the status probe together: a render that ran while the list
      // was already in hand but the probe was not had `state.report` still
      // null, so the read below fell through to `await reportPromise` and the
      // rows waited for the probe after all. The probe is the expensive half of
      // a cold open (~1.5 s measured), so the first open paid it twice over:
      // once on the list, once on the wait.
      //
      // Only a report that actually ARRIVED is written here (see the probe's
      // own callback), so the value means "the latest report this panel has",
      // which is exactly what the read below wants to carry forward.
      /** Paging bookkeeping: one page at a time, tied to a list generation. */
      const pagingRef = useRef({ busy: false, gen: 0 })
      /**
       * Detail-pane generation: bumped whenever the pane changes hands, so an
       * answer that arrives late — a slow reveal, or a "confirm read" started
       * on one entry and finished after moving to another — is dropped instead
       * of painted into whatever is on screen now.
       */
      const revealGenRef = useRef(0)
      /**
       * What is open right now, readable from the panel-wide key handler.
       * The handler is registered once (it must be: re-registering it on every
       * state change would be a listener per keystroke) and Escape has to know
       * whether there is anything to close, so the two answers live in refs.
       */
      const selectedIdRef = useRef(null)
      const editorRef = useRef(null)
      const closeEditorRef = useRef(null)
      selectedIdRef.current = selectedId
      editorRef.current = editor
      /**
       * Editor generation: bumped on every open (and on close), so a draft
       * asked for on one entry and answered after the reader moved to another
       * is dropped instead of overwriting the entry now on screen. Without
       * this the slow answer always won — it landed last.
       */
      const editorGenRef = useRef(0)
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
      /**
       * The section the rows on screen were read with. The async paths (a page,
       * a follow-up, a refresh after a write) read it from here instead of
       * taking a dependency on `section`: rebuilding every callback on a
       * section change would drop pages that are already in flight.
       */
      const sectionRef = useRef(section)
      /**
       * The query and section of the last read that finished. It is what tells
       * a *change of place* (which may be answered from the section cache, with
       * no round trip at all) from an *open of the panel* (which always asks the
       * host, so a stale count is corrected behind the painted rows).
       */
      const lastReadRef = useRef(null)
      /**
       * Set when a read failed while the last one succeeded. It is what makes
       * skipping `boot` safe: a session that really did die has to be revived
       * by a full boot, so the retry after a failure always boots.
       */
      const bootNeededRef = useRef(false)

      /** Fetch entries for a live session (never logs in by itself). */
      const readVault = useCallback(
        async (nextQuery, options = {}) => {
          const identity = options.identity ?? cacheKey(openCache.config?.config)
          // The section decides what the host is asked for. It is taken here
          // (not only in the handlers) because the async paths — a page, a
          // follow-up, a refresh after a write — reach this through refs.
          const view = options.section ?? sectionRef.current
          sectionRef.current = view
          // The loading card is for a panel with nothing to show. When rows are
          // already on screen they stay, with `refreshing` flagging the read in
          // flight: the previous answer keeps painting the list while the next
          // one is on its way, so typing in the search box never blanks it. A
          // `quiet` read is a background one over a painted snapshot and does
          // not announce itself at all.
          if (!options.quiet) {
            setState((previous) =>
              previous.status === 'ready' || previous.status === 'refreshing'
                ? { status: 'refreshing', list: previous.list, report: previous.report }
                : { status: 'loading' },
            )
          }
          // A fresh read starts a new paging generation: a page still in
          // flight for the previous list must not append into this one.
          pagingRef.current.gen += 1
          const generation = pagingRef.current.gen
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
            const firstLimit = pagingIsRefused() ? FULL_LIMIT : PAGE_SIZE
            const fields = listFieldsFor(view)
            // The rows do not wait for the sync chip. `status` is the expensive
            // half of a cold open — it probes /api/config and unlocks the vault,
            // measured at ~2.3 s against ~10 ms for the list — and awaiting both
            // together meant the panel sat on "同步中" for the whole probe with
            // the rows already in hand. So the list is awaited on its own and the
            // chip's report lands whenever it lands; a report that never arrives
            // costs the chip, which the panel already treats as optional.
            // The landing spot also parks the report where the success path
            // below can pick it up, so a status that answered FIRST is not
            // fetched a second time and a status that already failed does not
            // blink the chip back to "syncing".
            // Fired, deliberately not awaited by the rows below: its answer
            // lands in `liveReportRef` and re-renders the chip on its own. The
            // `.catch` is what keeps a probe that fails from becoming an
            // unhandled rejection.
            void invoke('status')
              .then((value) => {
                if (pagingRef.current.gen !== generation) return null
                liveReportRef.current = value
                setState((previous) =>
                  previous.status === 'ready' || previous.status === 'refreshing' ? { ...previous, report: value } : previous,
                )
                return value
              })
              .catch(() => null)
            const list = await invoke('list', { query: nextQuery ?? '', limit: firstLimit, includeArchived: fields.includeArchived, includeTrashed: fields.includeTrashed, section: fields.section, sectionValue: fields.sectionValue })
            // The chip keeps whatever report is already live — the one this
            // read just landed, or the one an earlier read painted. A first
            // open has neither, and it must NOT wait for one: the probe is the
            // slow half (measured ~1.5 s against a ~10 ms list), and the chip
            // is chrome. The probe's own callback above fills it in a moment
            // later, so the cost of not waiting is a blank chip for one frame
            // rather than a blank list for a second and a half.
            const report = liveReportRef.current ?? null
            // A newer read owns the panel now — a keystroke, a refresh, another
            // tab. Painting this answer would replace the newer query's rows
            // with an older query's, and (for a first page) store a snapshot of
            // a list the user has already left.
            if (pagingRef.current.gen !== generation) return
            if (pagingIsRefused()) {
              setHostCapped(true)
              if ((Array.isArray(list.items) ? list.items.length : 0) < Number(list.matched ?? 0)) setManualMore(true)
            }
            // Start paging where the host says its answer ends: a host that
            // predates paging reports no window, and the first page is the
            // whole answer it gave, so its length is the same number.
            offsetRef.current = nextOffsetOf(list, Array.isArray(list.items) ? list.items.length : 0)
            // Remember the successful result so the next open can paint at
            // once: in memory for a reopen, and in localStorage for a reload.
            // Only the unfiltered first page is worth remembering: the snapshot
            // is what the next open paints before the host answers, and a
            // searched answer would make that paint a lie.
            if (!nextQuery && sameSection(view, DEFAULT_SECTION)) {
              // The sidebar's counts ride along when they are known: a reload
              // must not make the menu wait a round trip for numbers it already had.
              const snapshot = { key: identity, overview: openCache.overview?.key === identity ? openCache.overview.overview : null, list, report, at: Date.now() }
              openCache.vault = snapshot
              writeSnapshot(snapshot)
            }
            // Every place keeps its own answer as well, so stepping back into
            // one the reader just left paints from here instead of going back
            // to the host for rows it has already served (see `load`).
            if (!nextQuery) {
              openCache.sections.set(`${identity}\u0000${sectionKeyOf(view)}`, { list, offset: offsetRef.current, at: Date.now() })
            }
            // The place this answer belongs to: a section switch compares
            // against it to tell "the reader moved" from "the panel opened".
            lastReadRef.current = { query: nextQuery ?? '', section: view }
            bootNeededRef.current = false
            setListSection(view)
            setSwitching(false)
            setState({ status: 'ready', list, report })
          } catch (failure) {
            // Same rule for failures: a stale error must not replace the newer
            // read's rows, nor drag the user onto the code screen.
            if (pagingRef.current.gen !== generation) return
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
              setSwitching(false)
              setState({ status: 'two_factor', error: message, code: failure?.code })
              return
            }
            // Whatever went wrong, the next read has to ask the host for a
            // session rather than assume the one that just failed is still
            // good. Without this the skip-boot shortcut above would keep
            // skipping it and no retry could ever come back.
            bootNeededRef.current = true
            // A background refresh that fails keeps the cached view on screen:
            // the user did not ask for anything, so a transient network blip
            // must not wipe out what they are looking at — unless the failure
            // is one a cached view cannot survive. A dead session is that
            // case: it looks exactly like a quiet refresh, because the rows on
            // screen came from the section cache, and swallowing it leaves the
            // reader on stale rows with no error and no way back. Painting
            // from a cache must never be how a signed-out panel looks signed
            // in.
            const sessionLost = /unauthorized|session_expired|not_configured|bad_credentials|two_factor/i.test(String(failure?.code ?? ''))
            setSwitching(false)
            if (options.quiet && !sessionLost && (statusRef.current === 'ready' || statusRef.current === 'refreshing')) return
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
        async (nextQuery, nextSection) => {
          const view = nextSection ?? sectionRef.current
          // Paint first, ask later. Whatever the last successful read for this
          // server and account was, it goes on screen now — including after a
          // reload, where the module cache is gone — and the host call below
          // decides whether it was the right one.
          //
          // There are two memories to paint from, and they cover different
          // places: the localStorage snapshot holds the unfiltered first page
          // of the whole vault, so it is what 全部条目 paints and nothing else,
          // while `openCache.sections` holds each place's own last answer.
          const cachedFor = cacheKey(openCache.config?.config)
          const cached = nextQuery ? null : openCache.sections.get(`${cachedFor}\u0000${sectionKeyOf(view)}`)
          const cachedFresh = Boolean(cached) && Date.now() - cached.at < SECTION_CACHE_MS
          const moved = Boolean(lastReadRef.current) && !sameSection(lastReadRef.current.section, view)

          /** Put a remembered answer in this place's name, and stop paging the old one. */
          const paintCached = (answer) => {
            sectionRef.current = view
            // A page still in flight for the list being left must not append
            // into this one, and a queued follow-up belongs to it as well.
            pagingRef.current.gen += 1
            pagingRef.current.busy = false
            if (followUpRef.current) {
              clearTimeout(followUpRef.current)
              followUpRef.current = null
            }
            setLoadingMore(false)
            setManualMore(false)
            setHostCapped(false)
            offsetRef.current = answer.offset
            // The rows on screen are this place's now, which is what the next
            // section switch compares against (see `moved`).
            lastReadRef.current = { query: '', section: view }
            // The report is about the account rather than the place, so the
            // one already on screen stays: it is the sync chip's only source.
            setListSection(view)
            setState((previous) => ({ status: 'ready', list: answer.list, report: previous.report ?? null }))
          }

          // The reader stepped into a place they left a moment ago: its rows
          // are still what the host served for it, so nothing is asked at all.
          // That is the whole point of the menu, and it stays a zero-RPC move.
          if (cachedFresh && moved) {
            paintCached(cached)
            // An answer straight from the section cache is not a wait: the new
            // rows are already in hand, so the dim comes off in the same tick
            // it went on and nothing is animated over. Without this the list
            // would sit at 0.55 opacity until some later read landed — a dimmed
            // list with no reason to be dim.
            setSwitching(false)
            return
          }

          // The panel just OPENED here, onto a place whose rows are still in
          // hand — 验证码 after a reopen, say. It paints from that answer
          // immediately and the host is still asked below, quietly, to correct
          // it. This used to go the other way round: only 全部条目 had a
          // snapshot to paint from, so every other place showed an empty list
          // while it waited for rows the panel had already been served a minute
          // ago. Five rows deserve better than a spinner.
          //
          // No else: leaving a blank here would blank the rows a keystroke is
          // typing over. The read itself decides below — it keeps the rows and
          // flags `refreshing` when there is something on screen to keep.
          const paintedSection = cachedFresh ? cached : null
          let painted = null
          if (paintedSection) {
            paintCached(paintedSection)
          } else {
            painted = nextQuery || !sameSection(view, DEFAULT_SECTION) ? null : freshSnapshot()
            if (painted) {
              // The snapshot is always the whole vault's first page.
              setSwitching(false)
              setListSection(DEFAULT_SECTION)
              setState({ status: 'ready', list: painted.list, report: painted.report })
              // The place names and their counts belong to the same picture.
              if (painted.overview) setOverview(painted.overview)
            }
          }

          // One round trip instead of two, and it revives a stored session
          // while it is in there.
          //
          // Unless the panel is ALREADY showing entries: then the session it
          // would revive is the one that just served those rows, and asking
          // again costs a round trip for an answer that cannot have changed.
          // The panel used to pay it on every section switch — `boot`,
          // `folders` and `overview` all ahead of the one `list` the reader
          // actually asked for. The config comes from the module cache, and a
          // session that really did die still surfaces below: the failed list
          // is caught, and the next read boots for real (see `bootNeededRef`).
          // Everything the panel derives from the config, in one place.
          //
          // It has to be ONE place: a path that hands the panel a config
          // without running this leaves state at its initial value, and the
          // one that bites is `accessMode` — it starts at 'readonly', so a
          // panel that skipped boot showed no edit or create buttons at all,
          // however the vault was actually configured.
          const applyConfig = (next) => {
            if (!next) return
            setSetup({ status: 'ready', config: next })
            setAccessMode(next.accessMode === 'ask' || next.accessMode === 'auto' ? next.accessMode : 'readonly')
            const cached = openCache.config
            if (cached?.config !== next) openCache.config = { config: next, at: Date.now() }
          }
          const knownConfig = openCache.config?.config ?? null
          const canSkipBoot = Boolean(knownConfig) && Boolean(lastReadRef.current) && !bootNeededRef.current
          let boot = null
          if (canSkipBoot) {
            // The cached config is the same one the live session was built
            // from, so it still describes this panel: apply it exactly as a
            // real boot would, then skip only the round trip.
            boot = { config: knownConfig, resumed: true, session: null }
            applyConfig(knownConfig)
          } else try {
            boot = await invoke('boot')
            applyConfig(boot?.config)
            // The host answers with the package's own manifest identity; the
            // title row shows the version from here rather than from a literal
            // baked into this bundle, so it can never disagree with the package
            // that is actually installed.
            if (boot?.plugin) setPlugin(boot.plugin)
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
              applyConfig(legacyConfig)
            } else {
              setSetup({ status: 'error', error: failure?.message ?? String(failure) })
            }
            }
          }
          const config = boot?.config ?? null
          const identity = cacheKey(config)

          // A snapshot painted before the config arrived may belong to another
          // account: drop it rather than show the wrong entries — and erase it,
          // because the next open would otherwise paint it again before `boot`
          // got a chance to compare. A stored list belonging to a different
          // account is not a cache miss; it is somebody else's vault names on
          // this disk.
          if (painted && painted.key !== identity) {
            painted = null
            forgetSnapshot()
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
          const remembered = freshOverview(identity)
          if (remembered) setOverview(remembered)
          // The two reads that describe the places around the rows — the folder
          // list behind the move-to-folder step, the overview behind the rail —
          // are fired BEFORE the list, not after it. Neither depends on the
          // rows, and firing them afterwards put two round trips in series
          // behind a third for no reason: the cold open was boot → list →
          // (folders ‖ overview) when boot → (list ‖ folders ‖ overview) is the
          // same work in one fewer round trip.
          //
          // They remain settled INDEPENDENTLY rather than awaited together.
          // They used to sit in one Promise.all, which made the slower read the
          // gate for the faster one: the rail is drawn from `overview`, and
          // `folders` only feeds the move-to-folder step, but a folders call
          // that never settled held the already-arrived overview hostage. The
          // panel then showed its rows under a rail stuck on its ghost block,
          // forever — the list said 428 entries and the sidebar still said
          // "loading". That is the reported bug, and no amount of retrying or
          // timing out the overview can fix it, because the overview had
          // already succeeded.
          //
          // So each read gets its own ceiling and its own landing. Whatever
          // arrives is applied at once; whatever does not is dropped on the
          // floor by its own timer. Nothing here waits for anything else.
          const foldersRead = withTimeout(invoke('folders'), READ_TIMEOUT_MS, 'folders')
            .then((payload) => setFolders(Array.isArray(payload?.folders) ? payload.folders : []))
            .catch(() => { /* an older host, or a read that failed: keep the folders on screen */ })
          // A remembered overview is not re-asked: `freshOverview` already
          // answered from what this panel read a moment ago (see REOPEN_CACHE_MS),
          // and the rail is on screen from it. The read below still runs when
          // there is nothing remembered, which is the only case where the rail
          // has to describe an account it has never seen.
          //
          // Retry once: a single transient failure on a slow network used to
          // leave the rail shimmering with no rows and no way to get them — the
          // panel looked broken rather than busy. One quiet retry covers the
          // dropped first attempt without doubling the cost of a host that
          // genuinely lacks the method.
          //
          // ONE ceiling over the chain, not one per attempt: bounding each try
          // separately makes the worst case the sum of them (two six-second
          // waits), and the sum is exactly the case this exists for — a request
          // that never answers, where the retry cannot help because the first
          // one is still open. A single timer covers both attempts and the gap
          // between them.
          const overviewRead = remembered
            ? Promise.resolve()
            : withTimeout(invoke('overview').catch(() => invoke('overview')), OVERVIEW_TIMEOUT_MS, 'overview')
                .then((payload) => {
                  openCache.overview = { key: identity, overview: payload, at: Date.now() }
                  setOverview(payload)
                })
                .catch(() => {
                  // Nothing arrived: stop pretending the rail is loading. An empty
                  // overview renders the three structural places and lets the nav
                  // fall out of its busy state, which is honest — the counts are
                  // unknown, but the rail is not stuck. A rail that kept claiming
                  // to be busy while the list underneath was already full is the
                  // shape of a hung panel, which is the one thing this file spends
                  // its length trying to avoid.
                  setOverview({ failed: true, sections: [], types: [], folderList: [], folderCount: 0, unfiled: 0 })
                })
          // The rows. This is the read the reader is waiting for, so it is the
          // one that must not be delayed by the two above — they are already in
          // flight and land on their own.
          await readVault(nextQuery, { quiet: Boolean(paintedSection ?? painted), identity, section: view })
          await Promise.all([foldersRead, overviewRead])
        },
        [invoke, readVault],
      )

      /**
       * Is a read in flight over rows that are already on screen?
       *
       * One derived flag, read in one place each: the toolbar (which must not
       * be taken away from a reader who is typing), the count, and the row
       * list. The rows keep being drawn from the previous answer while this is
       * true, so a keystroke never blanks the screen on its way to the new
       * answer — the flicker this status exists to stop.
       */
      const refreshing = state.status === 'refreshing'
      /** The rows the host served (empty until a read succeeded). */
      const items = () => (state.status === 'ready' || refreshing ? state.list.items ?? [] : [])
      /**
       * The rows on screen: what the host served for this place, and nothing
       * else. The host narrows the pool before it scores and pages, so a folder
       * or a type folded in here would make the badge, the counter and the
       * pager describe a list nobody is looking at.
       *
       * Computed ONCE per render, not behind a function. Every place that asks
       * — the empty-state test, the row map, the footer's sizes — used to call
       * `items()` again, and each call rebuilt the `?? []` fallback; the footer
       * alone asked for `matched` and `items()` three separate times in one
       * line of text. This is also what the render loops over, so it is the
       * value worth naming.
       */
      const visibleRows = items()
      /** How many the host matched. Read on almost every frame; parsed once. */
      const matched = Number(state.list?.matched ?? 0)
      /**
       * Move to a place in the sidebar.
       *
       * The place is client-side state; the rows for it are read by the effect
       * below, and a place the reader just left is answered from the section
       * cache instead (see `load`). A no-op is skipped so re-picking the
       * current place does not re-read it.
       */
      const goSection = (next) => {
        if (sameSection(next, sectionRef.current)) return
        sectionRef.current = next
        setSection(next)
        // The open entry belongs to the place being left; on the two-column
        // layout its detail would otherwise sit beside a list it is not in.
        setSelectedId(null)
        // The rows of the place being left stay mounted until the new ones
        // arrive (see `switching`). They are dimmed rather than removed: a
        // column that empties and refills is the flicker this panel is being
        // fixed for, and a dimmed column says "the next place is on its way"
        // without taking away the reader's orientation.
        setSwitching(true)
      }
      /**
       * Is what is on screen a prefix of a longer answer? Every page reports
       * `hasMore`; a host that predates paging omits it, and there the count
       * the host matched is the next best signal.
       */
      const morePages = () =>
        (state.status === 'ready' || refreshing) &&
        // A host that cannot page has already handed over everything it will:
        // asking again would only spin the control (see `cappedNotice`).
        !hostCapped &&
        (state.list.hasMore === true || (state.list.hasMore === undefined && visibleRows.length < matched))
      /**
       * Rows the host is holding back — its answer was clamped (FULL_LIMIT) and
       * it cannot page, so they are unreachable from the panel. Said in place,
       * as a notice, rather than offered as a control that does nothing.
       */
      const cappedNotice = hostCapped && (state.status === 'ready' || refreshing) && matched > visibleRows.length
      // The async page loads read the newest list and the newest answer through
      // refs: depending on `state` would rebuild those callbacks on every
      // keystroke and on every arrived page.
      itemsRef.current = visibleRows
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
          const view = sectionRef.current
          const fields = listFieldsFor(view)
          try {
            const full = await invoke('list', { query, limit: FULL_LIMIT, includeArchived: fields.includeArchived, includeTrashed: fields.includeTrashed, section: fields.section, sectionValue: fields.sectionValue })
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
            // A full read that lands while a keystroke's read is still in
            // flight must not be dropped on the floor: 'refreshing' is exactly
            // the state where the rows on screen are still the reader's, so it
            // counts as "something to keep" here too.
            setState((previous) =>
              previous.status === 'ready' || previous.status === 'refreshing'
                ? { ...previous, list: { ...full, offset: 0, hasMore: truncated } }
                : previous,
            )
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
          const view = sectionRef.current
          const fields = listFieldsFor(view)
          paging.busy = true
          setLoadingMore(true)
          if (fromButton) setManualMore(false)
          try {
            const page = await invoke('list', { query, limit: PAGE_SIZE, offset, includeArchived: fields.includeArchived, includeTrashed: fields.includeTrashed, section: fields.section, sectionValue: fields.sectionValue })
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
              previous.status === 'ready' || previous.status === 'refreshing'
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
              markPagingRefused()
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

      /**
       * Fetch the favicons the rows asked for, once the rows are actually up.
       *
       * The list may decide the panel costs nothing to read, the icons must not
       * be allowed to change that: each probe is a cross-site request that
       * measured 0.9–1.6 s, and every answer re-renders the panel. Doing this in
       * an idle callback keeps all of it out of the window in which the reader
       * is still deciding whether the thing works.
       *
       * The timeout is the floor, not a fallback: a busy main thread can defer
       * an idle callback for a long time, and an icon that never arrives is
       * worse than one that arrives late.
       */
      useEffect(() => {
        if (state.status !== 'ready') return undefined
        // `iconTick` re-runs this when a row queues a host and nothing else
        // moved — the detail pane's own header, for one. `state.list` is the
        // other half: a fresh page brings a fresh batch of hosts with it.
        if (!pendingIconHosts.size) return undefined
        const drain = () => {
          const hosts = [...pendingIconHosts]
          pendingIconHosts.clear()
          for (const host of hosts) {
            // Marked before the call: "asked" is what stops the queue from
            // refilling on the next render, whether or not the probe can run.
            probedIconHosts.add(host)
            const url = iconUrl(openCache.config?.config, host)
            if (url) probeIcon(url, bumpIcons)
          }
        }
        const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(drain, { timeout: 400 }) : null
        const timer = idle === null ? setTimeout(drain, 0) : null
        return () => {
          if (idle !== null && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle)
          if (timer !== null) clearTimeout(timer)
        }
      }, [state.status, state.list, iconTick])

      // A queued follow-up page belongs to the mounted panel; unmounting drops
      // it rather than reading on behalf of a closed settings pane.
      useEffect(
        () => () => {
          if (followUpRef.current) clearTimeout(followUpRef.current)
          followUpRef.current = null
        },
        [],
      )

      // search is debounced; the first (empty) query loads immediately.
      // `section` is in the dependency list on purpose: moving to another place
      // is a new list, and it must appear without waiting for a keystroke. A
      // place whose answer is still cached is served by `load` itself, with no
      // round trip at all.
      useEffect(() => {
        // A keystroke must never take the search box away: `load` keeps the
        // rows on screen here, so the toolbar (and the box inside it) mounts
        // once and stays mounted while the rows are replaced.
        const timer = setTimeout(() => load(query, section), query ? 250 : 0)
        return () => clearTimeout(timer)
      }, [query, section, load])

      // The panel's three shortcuts, all of them about not having to find
      // something with the pointer: "/" and Cmd/Ctrl-K put the cursor in the
      // search box, and Escape steps back out of whatever is open — the editor
      // first, then the card. Escape used to do nothing outside the search box,
      // so leaving a card meant finding the back button; on a phone in the drill
      // layout that button is the whole way back.
      //
      // Every branch refuses to run while the keystroke is going into a form
      // field: the search box owns Escape (it clears the query), and an editor
      // input owns every key typed into it. A global handler that forgot this
      // would close the card out from under someone editing it.
      useEffect(() => {
        const onKeyDown = (event) => {
          const target = event.target
          const inField = Boolean(target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
          // Cmd-K on a Mac, Ctrl-K elsewhere. Both are checked because the panel
          // cannot know which keyboard it is being read from.
          if (event.key === 'k' || event.key === 'K') {
            if (!(event.metaKey || event.ctrlKey) || event.altKey) return
            event.preventDefault()
            searchRef.current?.focus()
            return
          }
          if (event.key === 'Escape') {
            if (inField) return
            if (editorRef.current) {
              event.preventDefault()
              closeEditorRef.current?.()
              return
            }
            if (selectedIdRef.current) {
              event.preventDefault()
              setSelectedId(null)
            }
            return
          }
          if (event.key !== '/' || event.metaKey || event.ctrlKey) return
          if (inField) return
          event.preventDefault()
          searchRef.current?.focus()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [])

      // The re-prompt grant is a countdown the host owns; the panel only
      // mirrors it so the reader can see how long the unlock lasts. It is
      // polled only while a gated entry is actually on screen — otherwise every
      // open of the panel would spend a round trip on a countdown nobody is
      // looking at.
      //
      // The answer also closes the pane again: when the window runs out, the
      // plaintext it unlocked must not stay on screen. Without this the grant
      // was only a number — the reveal flag, the narrow card/SSH/note payloads
      // and an open editor all outlived it, so a 5-minute proof left those
      // secrets readable for as long as the entry stayed selected.
      // The countdown is polled while a gated entry is on screen, and also
      // while a grant is still in force over an entry that HAS been unlocked:
      // the host's answer for an unlocked entry is the plaintext, which no
      // longer carries `repromptRequired`, so keying the poll on that flag
      // alone stopped watching the very window it is supposed to close — the
      // pane then kept the plaintext after the proof lapsed. `grant.granted`
      // is what keeps the watch alive for exactly as long as there is
      // something left to take away.
      const gateOnScreen = detail.status === 'ready' && (Boolean(detail.value?.repromptRequired) || grant.granted)
      const grantRef = useRef(grant)
      grantRef.current = grant
      useEffect(() => {
        if (!gateOnScreen) return undefined
        let alive = true
        const tick = async () => {
          try {
            const state = await invoke('repromptGrant')
            if (!alive) return
            const next = { granted: Boolean(state?.granted), remainingMs: Number(state?.remainingMs) || 0 }
            const wasGranted = grantRef.current.granted
            setGrant(next)
            // Only a fall from granted to not-granted is a scrub: the first
            // answer after a fresh open is `granted: false` too, and treating
            // that as an expiry would fight the unlock that just happened.
            if (wasGranted && !next.granted) {
              setRevealed(false)
              setTypeFields({})
              closeEditor()
              // The pane itself has to go back behind the gate. Clearing the
              // reveal flag only re-masked ONE row: `detail` still held the
              // host's full plaintext, so the password row's own 显示 toggle
              // put the value straight back on screen (and so did the notes
              // and custom-field rows) long after the proof expired — the
              // exact opposite of what this effect is for.
              //
              // Two steps, and the order matters. First the plaintext leaves
              // React state here, synchronously, so no rejected or slow re-read
              // can leave it readable in between. Then `detailGen` makes the
              // host answer again, which restores the authoritative gated
              // payload (id/name/type/uris only).
              setDetail((previous) => (previous.status === 'ready' ? { status: 'ready', value: gatedStub(previous.value) } : previous))
              setDetailGen((previous) => previous + 1)
            }
          } catch {
            /* the host is busy or the panel is closing; next tick retries */
          }
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [invoke, gateOnScreen])

      // selection loads the full reveal once; reprompt entries stay gated
      useEffect(() => {
        // Whoever asks next owns the pane: this entry's own reveal and any
        // "confirm read" begun here are stale the moment the subject changes.
        revealGenRef.current += 1
        if (!selectedId) {
          setDetail({ status: 'idle' })
          setRevealed(false)
          return undefined
        }
        let alive = true
        setDetail({ status: 'loading' })
        setRevealed(false)
        setHistoryOpen(false)
        setAttachmentsOpen(false)
        // Narrow secrets were fetched for the previous entry; keeping them
        // would put one entry's card number on the next entry's screen.
        setTypeFields({})
        // A row in the trash must be read as trashed: the host refuses to
        // reveal a soft-deleted entry unless the caller says it meant to.
        // The row being opened belongs to the list on screen (`listSection`),
        // not to wherever the reader may have since navigated.
        const trashView = listSectionRef.current.kind === SECTION_TRASH
        invoke('reveal', { id: selectedId, includeTrashed: trashView })
          .then((value) => alive && setDetail({ status: 'ready', value }))
          .catch((failure) => alive && setDetail({ status: 'error', error: failure?.message }))
        return () => {
          alive = false
          revealGenRef.current += 1
        }
      }, [selectedId, invoke, detailGen])

      // Entering (or leaving) the drill state swaps which pane lives in the
      // scroll container. The list may have been scrolled thousands of pixels
      // down, and the container keeps that offset across the swap, so the
      // pane the reader just asked for could open part-way down — or, with a
      // short detail, past where the browser can clamp it. Starting at the top
      // is what makes "the list gave way to this entry" read as a move.
      useEffect(() => {
        const node = scrollRef.current
        if (node) node.scrollTop = 0
      }, [selectedId, editor])

      // Unlock a reprompt entry: the user types the master password here and
      // the host decides. `vw/authorizeReprompt` is the only path to the gate —
      // there is no argument any caller can pass to fake it — and the answer
      // opens a window, so one verification covers the next few reads.
      const authorizeReveal = async () => {
        const generation = (revealGenRef.current += 1)
        setRepromptBusy(true)
        setRepromptErr(null)
        try {
          const result = await invoke('authorizeReprompt', {
            password: repromptPw,
            id: selectedId,
            includeTrashed: listSectionRef.current.kind === SECTION_TRASH,
          })
          if (revealGenRef.current !== generation) return
          if (!result?.authorized) {
            setRepromptErr(result?.hint ? `${result.message} ${result.hint}` : result?.message || t('repromptWrong'))
            return
          }
          // Do not keep the plaintext on screen after a successful check.
          setRepromptPw('')
          setGrant({ granted: true, remainingMs: Number(result.remainingMs) || 0 })
          setDetail({ status: 'ready', value: result.view })
          setRevealed(true)
        } catch (failure) {
          if (revealGenRef.current !== generation) return
          setRepromptErr(failure?.message ?? t('repromptWrong'))
        } finally {
          if (revealGenRef.current === generation) setRepromptBusy(false)
        }
      }

      /**
       * Pull one narrow class of secret (card / identity / sshKey / secureNote)
       * on demand. `field=all` reports only that the class exists, so the panel
       * asks for the payload itself the first time the reader clicks — the same
       * reason the tool surface forces a caller to be specific.
       */
      const readTypeField = async (id, field) => {
        const generation = revealGenRef.current
        const trashView = listSectionRef.current.kind === SECTION_TRASH
        setTypeFields((previous) => ({ ...previous, [field]: { status: 'loading' } }))
        try {
          const value = await invoke('reveal', { id, field, includeTrashed: trashView })
          if (revealGenRef.current !== generation) return
          setTypeFields((previous) => ({ ...previous, [field]: { status: 'ready', value: value?.[field] ?? null } }))
        } catch (failure) {
          if (revealGenRef.current !== generation) return
          setTypeFields((previous) => ({ ...previous, [field]: { status: 'error', error: failure?.message } }))
        }
      }

      const move = (delta) => {
        if (!visibleRows.length) return
        const index = visibleRows.findIndex((item) => item.id === selectedId)
        const next = index < 0 ? (delta > 0 ? 0 : visibleRows.length - 1) : Math.max(0, Math.min(visibleRows.length - 1, index + delta))
        setSelectedId(visibleRows[next].id)
      }

      /** The label of a folder id, for the row subtitle and the move step. */
      const folderLabel = (folderId) => {
        if (!folderId) return t('folderUnfiled')
        const match = folders.find((entry) => entry.id === folderId)
        return match ? match.name : t('folderUnfiled')
      }

      /**
       * The move step's folder choices, in the same order the sidebar shows
       * them. The unfiled bucket is not one of them: it is the absence of a
       * folder, and the list offers "no folder" under its own id (`null`).
       */
      const folderOptions = () => folders.filter((entry) => entry.id !== SECTION_UNFILED)

      /** The write tier: the panel only offers writes it can actually make. */
      const canWrite = accessMode === 'ask' || accessMode === 'auto'

      // ── the editor ───────────────────────────────────────────────────────────
      // The editor is the one place in the panel that holds plaintext the list
      // never saw: a password, a card number, a private key. So it opens on an
      // explicit click, it asks the host for the whole record in one round trip
      // (`vw/draft`), and a save names exactly the fields that changed — which
      // is what keeps an edit from disturbing the passkeys, attachments and
      // password history the form never showed.

      /**
       * Turn the host's draft into form values. Text areas are joined with
       * newlines, and a missing object becomes an empty one rather than
       * being left undefined (React would then treat the control as uncontrolled).
       */
      const formFromDraft = (draft) => ({
        type: draft.type,
        name: draft.name ?? '',
        username: draft.username ?? '',
        password: draft.password ?? '',
        totp: '',
        uris: (draft.uris ?? []).join('\n'),
        notes: draft.notes ?? '',
        favorite: Boolean(draft.favorite),
        reprompt: Number(draft.reprompt ?? 0) ? 1 : 0,
        folderId: draft.folderId ?? '',
        fields: (draft.fields ?? []).map((field) => ({ name: field?.name ?? '', value: field?.value ?? '', type: Number(field?.type ?? 0) })),
        card: { ...blankForm('card').card, ...(draft.card ?? {}) },
        identity: { ...(draft.identity ?? {}) },
        sshKey: { ...blankForm('sshKey').sshKey, ...(draft.sshKey ?? {}) },
      })

      /**
       * The reverse: form values back into the shape `vw/draft` answers with.
       *
       * Needed after a save, where the form replaces the draft as the baseline
       * (see saveEditor). It deliberately carries only what the form holds, so
       * the fields the editor never draws — password history, attachments,
       * the secure-note body — are dropped from state rather than kept around
       * decrypted for the rest of the session.
       */
      const draftFromForm = (form) => ({
        type: form?.type,
        name: form?.name ?? '',
        username: form?.username ?? '',
        password: form?.password ?? '',
        uris: String(form?.uris ?? '').split('\n').map((uri) => uri.trim()).filter(Boolean),
        notes: form?.notes ?? '',
        favorite: Boolean(form?.favorite),
        reprompt: Number(form?.reprompt ?? 0) ? 1 : 0,
        folderId: form?.folderId ?? '',
        fields: (form?.fields ?? []).map((field) => ({ name: field?.name ?? '', value: field?.value ?? '', type: Number(field?.type ?? 0) })),
        card: { ...(form?.card ?? {}) },
        identity: { ...(form?.identity ?? {}) },
        sshKey: { ...(form?.sshKey ?? {}) },
      })

      /**
       * The fields an edit changed, and nothing else. Every key here is a
       * gateway parameter of `vw/update` / `vw/create` — flat, never nested
       * under a `patch` object, because the gateway rejects what its
       * parameter list does not declare.
       */
      const diffOf = (draft, form) => {
        // Compare like with like. The reader's form has already been through
        // `formFromDraft` (uris joined to text, a null card/identity/sshKey
        // turned into an empty object), so diffing it against the RAW draft
        // compared two different shapes and reported every field as changed —
        // a save that changed nothing still sent a PUT and both syncs.
        const base = formFromDraft(draft ?? {})
        const input = { name: String(form.name ?? '').trim() }
        const changed = (key) => JSON.stringify(base[key]) !== JSON.stringify(form[key])
        if (changed('name')) input.name = String(form.name ?? '').trim()
        else delete input.name
        if (changed('username')) input.username = String(form.username ?? '')
        if (changed('password')) input.password = String(form.password ?? '')
        if (form.totp) input.totp = String(form.totp)
        if (changed('uris')) input.uris = String(form.uris ?? '').split('\n').map((uri) => uri.trim()).filter(Boolean)
        if (changed('notes')) input.notes = String(form.notes ?? '')
        if (changed('favorite')) input.favorite = Boolean(form.favorite)
        if (changed('reprompt')) input.reprompt = Number(form.reprompt) ? 1 : 0
        const folderId = String(form.folderId ?? '')
        if (folderId !== String(base.folderId ?? '')) input.folderId = folderId || null
        if (changed('fields')) input.fields = (form.fields ?? []).filter((field) => field.name || field.value)
        if (changed('card')) input.card = form.card
        if (changed('identity')) input.identity = form.identity
        if (changed('sshKey')) input.sshKey = form.sshKey
        return input
      }

      /** Close the editor without touching the entry. */
      const closeEditor = () => {
        // A draft still in flight belongs to the editor being closed.
        editorGenRef.current += 1
        setEditor(null)
        setEditorBase(null)
        setEditorForm(null)
        setEditorLoading(false)
        setEditorBusy(false)
        setEditorResult(null)
        setEditorStale(false)
      }
      // The key handler closes the editor on Escape, and it is registered once;
      // this is how it reaches a function that is rebuilt on every render.
      closeEditorRef.current = closeEditor

      /**
       * Open the editor on an existing entry. The draft is asked for over
       * `vw/draft`, which answers the reprompt gate with a `repromptRequired`
       * stub instead of the plaintext — the panel then says so, rather than
       * showing a form that could not be filled.
       */
      const openEditor = async (item) => {
        const id = item?.id
        if (!id) return
        const generation = (editorGenRef.current += 1)
        // The row's own `type` rides along: the draft is a round trip away,
        // and until it lands this is the only thing that knows whether the
        // entry is a login or a card. Without it the form was built for
        // 'login' first and rebuilt once the draft arrived.
        setEditor({ id, mode: 'edit', type: item?.type })
        setEditorBase(null)
        setEditorForm(null)
        setEditorResult(null)
        setEditorStale(false)
        setEditorBusy(false)
        setEditorLoading(true)
        try {
          const draft = await invoke('draft', { id })
          // A late answer for an entry the reader has already left must not
          // paint over the one they are looking at now.
          if (editorGenRef.current !== generation) return
          if (draft?.repromptRequired) {
            setEditorLoading(false)
            setEditorResult({ status: 'reprompt', id, name: draft.name })
            return
          }
          setEditorBase(draft)
          setEditorForm(formFromDraft(draft))
          setEditorLoading(false)
        } catch (failure) {
          if (editorGenRef.current !== generation) return
          setEditorLoading(false)
          setEditorResult({ status: 'error', id, error: failure?.message ?? String(failure) })
        }
      }

      /** Open the editor on a new entry of `type`. */
      const openCreator = (type) => {
        // A creator is not waiting on any draft, so one that arrives late
        // must not fill the blank form the reader just opened.
        editorGenRef.current += 1
        setEditor({ id: null, mode: 'create', type: type ?? 'login' })
        setEditorBase(null)
        setEditorForm(blankForm(type ?? 'login'))
        setEditorResult(null)
        setEditorStale(false)
        setEditorBusy(false)
        setEditorLoading(false)
      }

      /**
       * Run a write, riding out a dropped connection.
       *
       * `connection.rpc.call` is a plain fetch: when the socket dies before the
       * answer arrives the browser rejects with its own TypeError, and the panel
       * had no way to tell that apart from the host refusing the write. On a
       * phone that happens for reasons the reader cannot control — the LAN proxy
       * closes the client connection after every response, a host restart lands
       * mid-request, the radio drops while the request is in flight — and the write
       * itself is idempotent from this side: an `update` carries the revision it
       * started from (the server refuses a stale one), and a retried `update` of
       * the same fields leaves the same entry. So a transport failure is retried
       * a couple of times before the reader is told anything.
       *
       * Only transport failures are retried. A host answer — a refusal, a
       * conflict, a validation error — is final and returned at once: retrying
       * those is exactly what the write path's own comments warn against.
       */
      const writeWithRetry = async (run, attempts = 3) => {
        let lastFailure = null
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            return await run()
          } catch (failure) {
            if (!isTransportFailure(failure)) throw failure
            lastFailure = failure
            // Back off a little: the usual cause is a connection that just went
            // away, and the next attempt opens a fresh one.
            if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
          }
        }
        throw lastFailure
      }

      /**
       * Save the open editor.
       *
       * The host already runs the write behind the access gate, so `readonly`
       * is refused there and its message is what the reader sees. A write that
       * succeeds is reported at once — the host folds the change into its own
       * vault before it answers and refreshes in the background, so there is
       * nothing left for this panel to wait for. The rows are re-read afterwards
       * for the counts and the list, and a failure there is not a failed write.
       */
      const saveEditor = async () => {
        const open = editor
        const form = editorForm
        if (!open || !form) return
        const name = String(form.name ?? '').trim()
        if (!name) {
          setEditorResult({ status: 'error', id: open.id, error: t('editorNameRequired') })
          return
        }
        setEditorBusy(true)
        setEditorResult(null)
        try {
          let answer
          if (open.mode === 'create') {
            answer = await writeWithRetry(() => invoke('create', { input: { ...form, name } }))
          } else {
            const input = diffOf(editorBase, form)
            // Nothing actually changed: the vault already holds exactly this
            // entry, so there is no write to make and nothing to refresh.
            // Saying so IS the answer — the alternative was a real PUT for a
            // save the reader never made.
            if (!Object.keys(input).length) {
              setEditorBusy(false)
              setEditorResult({ status: 'unchanged', id: open.id, name })
              return
            }
            answer = await writeWithRetry(() => invoke('update', { id: open.id, input }))
          }
          // The write landed, so the success is said NOW. The host folds the
          // saved cipher into its own vault before it answers and refreshes in
          // the background (see lib/mutations.js #apply), and the panel used to
          // ask for a SECOND full sync here and print the success only after it
          // — 2.7~16 s of the reader staring at a form that had in fact been
          // saved. That call is gone. A syncWarning the host still reports on a
          // degraded path is carried through as before.
          setEditorResult({
            status: 'saved',
            id: open.id,
            name: answer?.name ?? name,
            revisionDate: answer?.revisionDate ?? null,
            ...(answer?.syncWarning ? { syncWarning: answer.syncWarning } : {}),
          })
          setEditorBusy(false)
          // The rows, the counts and the open entry all describe the entry that
          // just changed, so they are read again. Both are cheap next to the
          // write, and neither may turn a write that already landed into a
          // failure — the reader would retry a save that is on the server.
          try {
            void refreshOverview()
            await load(query, sectionRef.current)
          } catch {
            /* the write landed; a failed re-read is not a failed write */
          }
          if (open.mode === 'create') {
            closeEditor()
          } else {
            // An edit keeps the form open — the reader may still be working
            // through it — so the whole decrypted record must not keep sitting
            // in state behind it. `editorBase` was the host's ENTIRE draft,
            // including what this form never draws: `passwordHistory` (every
            // retired password, in the clear), `attachments` and `secureNote`.
            // Rebuilding it from the form drops exactly those, keeps the diff
            // working for a further edit (same shape, same values), and leaves
            // 保存成功 on screen. The password and TOTP inputs are cleared for
            // the same reason: both are documented as "leave empty to keep",
            // so an empty one writes nothing and holds no secret.
            setEditorBase(draftFromForm({ ...form, name }))
            setEditorForm((previous) => (previous ? { ...previous, password: '', totp: '' } : previous))
          }
        } catch (failure) {
          setEditorBusy(false)
          // The host refuses a write whose own copy has moved on, and says so
          // with `stale_revision` — a conflict, not a failure. The editor says
          // the same thing and stops offering the save: retrying it would
          // overwrite whatever changed in the meantime.
          const code = failure?.code
          if (code === 'stale_revision' || /已被其他客户端修改/.test(String(failure?.message ?? ''))) {
            setEditorStale(true)
            setEditorResult({ status: 'error', id: open.id, error: t('editorStale') })
            return
          }
          // A transport failure arrives with no envelope from the host: the
          // browser's own fetch rejected, and it names the engine's wording
          // ("Load failed" on WebKit/iOS, "Failed to fetch" on Chromium). It
          // means one thing here — the request never arrived, nothing was
          // written — so it gets advice the reader can act on instead of an
          // engine string. Anything else is a real answer from the host and
          // keeps the host's own text.
          if (isTransportFailure(failure)) {
            setEditorResult({ status: 'error', id: open.id, error: t('editorSaveOffline'), retryable: true })
            return
          }
          setEditorResult({ status: 'error', id: open.id, error: failure?.message ?? String(failure) })
        }
      }


      /** The entry a write is about: the open one, or just its row. */
      const targetOf = (id) => (state.status === 'ready' || refreshing ? items().find((item) => item.id === id) : undefined) ?? (detail.value?.id === id ? detail.value : undefined)

      const closeWrite = () => {
        setPendingWrite(null)
        setMoveTarget(null)
      }

      /**
       * What the entry is now: trashed wins over archived, because a trashed
       * entry is out of the vault either way and "restore" is the only move
       * that means anything for it.
       */
      const writeStateOf = (item) => (item?.trashed ? 'trashed' : item?.archived ? 'archived' : 'normal')

      /**
       * Run a write and repaint from it.
       *
       * Everything goes through the host's own guard (readonly is refused
       * there, not only hidden here), and a write says nothing about the
       * revision it started from: when another client changed the entry in the
       * meantime the host answers `stale_revision`, which is a conflict to
       * report — not a failure to retry.
       */
      const runWrite = async (item, write) => {
        if (!item) return
        setWriteState({ status: 'saving', id: item.id })
        try {
          if (write.kind === 'archive' || write.kind === 'unarchive') {
            const input = { archived: write.kind === 'archive' }
            await invoke('update', { id: item.id, input })
          } else if (write.kind === 'trash') {
            await invoke('remove', { id: item.id })
          } else if (write.kind === 'restore') {
            await invoke('restore', { id: item.id })
          } else if (write.kind === 'move') {
            const input = { folderId: write.folderId }
            await invoke('update', { id: item.id, input })
          }
          setWriteState({ status: 'done', id: item.id })
          setDetailGen((value) => value + 1)
          // The counts moved with the entry, so they are read again beside the
          // rows — a move between folders is exactly what a badge is for.
          void refreshOverview()
          await load(query, sectionRef.current)
        } catch (failure) {
          setWriteState({ status: 'error', id: item.id, error: failure?.message ?? String(failure) })
        }
      }

      /** Ask first: the confirmation is the only path into `runWrite`. */
      const confirmWrite = () => {
        const pending = pendingWrite
        if (!pending) return
        const item = targetOf(pending.id)
        setPendingWrite(null)
        void runWrite(item, pending)
      }

      /**
       * A write's message. The host already translates its refusals (readonly
       * says how to unlock writes, a conflict says to re-read), so its text is
       * the one to show; the fallback covers a thrown value without one.
       */
      const writeMessage = (failure) => (failure?.error ? String(failure.error) : failure?.message ? String(failure.message) : t('writeFailed'))

      /**
       * The question a pending write asks. Each action has its own sentence:
       * "move" needs the destination in it, or the confirmation says nothing
       * about where the entry is going.
       */
      const confirmText = (write) => {
        if (write.kind === 'trash') return t('confirmTrash')
        if (write.kind === 'restore') return t('confirmRestore')
        if (write.kind === 'archive') return t('confirmArchive')
        if (write.kind === 'unarchive') return t('confirmUnarchive')
        return t('confirmMoveFolder').replace('{folder}', write.label ?? t('moveNone'))
      }

      /** One labelled select — the move step's folder choice. */
      const filterSelect = (label, tag, value, onChange, options) =>
        h(
          'label',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 6, color: TOKEN.text2 } },
          h('span', null, label),
          h('select', { [tag]: '', style: S.filterSelect, value, onChange }, options),
        )

      /**
       * One place in the sidebar: the same three-part row everywhere, so the
       * counts line up whether the place is a type, a folder or the trash.
       *
       * Deliberately not `role="option"` and deliberately not a button in the
       * list's sense: the sidebar is a navigation surface, and the browser test
       * (and a screen reader) must be able to tell its rows from the entry rows
       * by role alone.
       */
      const navRow = (target, iconName, label, count) => {
        const current = sameSection(target, section)
        return h(
          'button',
          {
            key: sectionKeyOf(target),
            type: 'button',
            'data-vw-section': sectionKeyOf(target),
            'aria-current': current ? 'true' : undefined,
            style: current ? { ...S.navRow, ...S.navRowActive } : S.navRow,
            onClick: () => goSection(target),
          },
          h(
            'span',
            {
              'data-vw-section-icon': iconName,
              style: current ? { ...S.navIcon, ...S.navIconActive } : S.navIcon,
              'aria-hidden': 'true',
            },
            // The rail is the one surface drawn in the reference dialect; see
            // RAIL_ICON_SHAPES for why it does not share navGlyph.
            railGlyph(iconName),
          ),
          h('span', { 'data-vw-section-label': '', style: S.navLabel }, label),
          Number.isFinite(Number(count))
            ? h('span', { 'data-vw-section-count': '', style: current ? { ...S.navCount, ...S.navCountActive } : S.navCount }, String(count))
            : null,
        )
      }

      /**
       * The sidebar.
       *
       * Its counts are the host's own (`vw/overview`), which is the whole
       * reason the read exists: a count taken from the page that happens to be
       * loaded would say "3" for a folder with 300 entries. Until that answer
       * arrives — and forever, on a host that predates the method — the
       * sidebar degrades to the one place that needs no counts at all, rather
       * than to a menu of guesses.
       */
      /**
       * The rail's shape while the counts are still in flight.
       *
       * Every place in this rail is a row of the same three parts: a mark, a
       * label, a count. Until the host has said which places exist, the rail
       * draws those rows and nothing else — a skeleton of the answer, in the
       * answer's own metrics.
       *
       * It used to draw the three structural places as REAL rows and ghost
       * only what came after them, which made the loading rail a hybrid: three
       * finished rows sitting on a block of placeholders. That seam is the
       * "有点突兀" this rewrite answers — the eye reads two stacked objects
       * rather than one rail counting. 全部条目 / 收藏 / 验证码 are not more
       * certain than the rest while the read is in flight; they only LOOK
       * certain because they need no count. So they wait in the same form as
       * everything else.
       *
       * Eleven slots, and the number is measured rather than guessed: three
       * places, a heading and two types, a heading and four folder-ish rows is
       * what this vault's rail holds (9 rows at 36px + 2 headings at 30px +
       * gaps + the rail's own padding and hairline = the 418px the real rail
       * takes). The equal height is the whole point — the answer replaces the
       * skeleton slot for slot, so nothing below the rail moves when it lands,
       * and the rows can fade in where the bars were instead of arriving as a
       * new layout. A vault with more folders simply grows past it: there is
       * no height cap here, because a cap would clip.
       */
      const navPlaceholders = () => {
        // A ghost row in the real row's metrics, part for part. The label slot
        // keeps the real label's line box — the bar is an inline-block inside
        // it, so the strut of the 13px font still sets the row's height and the
        // ghost is the same 36px the real row is, at any zoom level. Writing a
        // fixed 36px here instead would drift the moment the host's font
        // metrics changed, and nine rows of drift is a jump, which is the one
        // thing this block exists to prevent.
        const row = (key) =>
          h(
            'div',
            {
              key,
              'data-vw-ghost-row': '',
              'aria-hidden': 'true',
              style: { ...S.navRow, cursor: 'default', pointerEvents: 'none' },
            },
            h('span', { style: S.navIcon }, h('span', { style: { ...S.skeletonBar, width: 11, height: 11, borderRadius: 3 } })),
            h(
              'span',
              { style: S.navLabel },
              h('span', { style: { ...S.skeletonBar, display: 'inline-block', verticalAlign: 'middle', width: 56, height: 9 } }),
            ),
            // The count's slot, ghosted as the DIGITS rather than as the chip
            // they sit in. Ghosting the whole pill made the skeleton's right
            // column a column of solid blocks, heavier than the faint chip the
            // real rows draw — the placeholder outweighed the answer it was
            // standing in for. A short bar at the same right edge says "a
            // number goes here" at the same weight as the rest of the ghost.
            h(
              'span',
              // 20px tall: the real chip is 20px and it is the tallest thing in a
              // real row, so it is what sets that row's 36px. A slot shorter than
              // the chip would make every ghost row 2px short — 18px across nine
              // rows, which is exactly the jump this skeleton exists to avoid.
              { style: { flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', width: 22, height: 20 } },
              h('span', { style: { ...S.skeletonBar, width: 16, height: 8 } }),
            ),
          )
        const group = (key) =>
          h(
            'div',
            { key, 'data-vw-ghost-group': '', 'aria-hidden': 'true', style: S.navGroup },
            h('span', { style: { ...S.skeletonBar, display: 'inline-block', verticalAlign: 'middle', width: 42, height: 8 } }),
          )
        // The wrapper carries `data-vw-skeleton` (the one shared pulse) and no
        // height of its own: it is exactly as tall as the slots inside it.
        return h(
          'div',
          { key: 'nav-ghost', 'data-vw-skeleton': '', 'aria-hidden': 'true', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          row('p1'), row('p2'), row('p3'),
          group('g-types'), row('t1'), row('t2'),
          group('g-folders'), row('f1'), row('f2'), row('f3'), row('f4'),
        )
      }

      const nav = () => {
        // One lookup table per render instead of four linear scans over the same
        // list. The list is short, but this runs on every keystroke and every
        // icon probe, and a Map read is the same shape at any vault size.
        const sectionsById = new Map((overview?.sections ?? []).map((entry) => [entry.id, entry]))
        const byId = (id) => sectionsById.get(id)
        // Nothing is known yet: draw the whole rail as one skeleton, not as
        // three finished rows above a block of placeholders.
        //
        // The three structural places are certain to exist, but a count is
        // certain not to — and a rail that shows three complete rows and then
        // re-renders all of them once the numbers land was doing the thing this
        // file keeps trying to stop: changing its content in place, a frame
        // apart, for no reason the reader can see. One shape from the first
        // frame, filled in when the answer arrives.
        if (!overview) {
          return h(
            'nav',
            { 'data-vw-nav': '', style: S.nav, 'aria-label': t('navSections'), 'aria-busy': 'true' },
            navPlaceholders(),
          )
        }
        const places = [navRow(DEFAULT_SECTION, 'all', t('sectionAll'), overview?.items)]
        // 收藏 and 验证码 are STRUCTURAL: they exist in every vault, whatever
        // the counts say, so they are drawn before the overview arrives.
        //
        // They used to wait for it along with everything else, which meant the
        // sidebar rendered one row, then re-rendered at full height a moment
        // later — measured here as a 48px → 418px jump about 160ms after the
        // panel opened. That jump is the "闪一下" this change is about: it is
        // not an animation, it is the layout changing its mind, and no
        // transition on top of it can hide it. The counts are simply blank
        // until they are known (the pill renders nothing rather than a 0 that
        // would be a lie), so the rows are the same height the whole time.
        places.push(navRow({ kind: SECTION_FAVORITES, value: '' }, 'favorites', t('sectionFavorites'), byId('favorites')?.count))
        places.push(navRow({ kind: SECTION_TOTP, value: '' }, 'totp', t('sectionTotp'), byId('totp')?.count))
        // The read failed and no retry is coming: the rail keeps its three
        // structural places and stops claiming to be busy. Ghosts here would be
        // a placeholder for something that is never going to arrive, which is
        // the shape of a hung panel — the one thing this file spends its length
        // trying to avoid.
        if (overview.failed) {
          return h('nav', { 'data-vw-nav': '', style: S.nav, 'aria-label': t('navSections') }, places)
        }
        const types = overview.types ?? []
        if (types.length) {
          places.push(h('div', { key: 'g-types', 'data-vw-nav-group': 'types', style: S.navGroup }, `${t('sectionTypes')} (${types.length})`))
          for (const type of types) {
            // A type this bundle has no word for still gets a row, under the
            // host's own label: an entry must not vanish from the menu just
            // because it is a kind of entry the panel had not seen before.
            const key = TYPE_LABEL_KEYS[type.id]
            places.push(navRow({ kind: SECTION_TYPE, value: type.id }, TYPE_ICON_NAMES[type.id] ?? 'entry', key ? t(key) : type.label ?? String(type.id), type.count))
          }
        }
        const folderList = overview.folderList ?? []
        const folderCount = Number(overview.folderCount ?? folderList.length)
        if (folderCount || Number(overview.unfiled ?? 0)) {
          places.push(h('div', { key: 'g-folders', 'data-vw-nav-group': 'folders', style: S.navGroup }, `${t('sectionFolders')} (${folderCount})`))
          for (const folder of folderList) {
            places.push(navRow({ kind: SECTION_FOLDER, value: folder.id }, 'folder', folder.name, folder.count))
          }
          places.push(navRow({ kind: SECTION_UNFILED, value: '' }, 'unfiled', t('sectionUnfiled'), overview.unfiled))
        }
        places.push(navRow({ kind: SECTION_ARCHIVE, value: '' }, 'archive', t('sectionArchive'), byId('archive')?.count ?? overview.archived))
        places.push(navRow({ kind: SECTION_TRASH, value: '' }, 'trash', t('sectionTrash'), byId('trash')?.count ?? overview.trashed))
        return h('nav', { 'data-vw-nav': '', style: S.nav, 'aria-label': t('navSections') }, places)
      }

      /**
       * Read the sidebar's counts again, outside `load`.
       *
       * The refresh button and a finished write both change what the places
       * hold, so the badges have to follow them — a folder that just gained an
       * entry must not keep the count it had before the move. A host without
       * the method leaves the sidebar exactly as it was.
       */
      const refreshOverview = async () => {
        const identity = cacheKey(openCache.config?.config)
        try {
          const payload = await withTimeout(invoke('overview'), OVERVIEW_TIMEOUT_MS, 'overview')
          openCache.overview = { key: identity, overview: payload, at: Date.now() }
          setOverview(payload)
        } catch {
          /* an older host, or a read that failed: keep the counts on screen */
        }
      }

      const toolbar = h(
        'div',
        { style: S.toolbar, 'data-vw-toolbar': '' },
        h('input', {
          ref: searchRef,
          'data-vw-search': '',
          style: { ...S.input, width: '100%', minWidth: 0 },
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
        // A sync the reader asked for reads through: `readVault` goes to the
        // host unconditionally, so the answer cannot come from the cache the
        // button exists to doubt.
        // The chip's slot is always filled, so the toolbar's four tracks never
        // re-measure: during the first read it holds an inert placeholder of
        // exactly the chip's height instead of collapsing to nothing.
        state.status === 'ready' || refreshing
          ? h(SyncChip, { report: state.report, t, invoke, onSynced: () => readVault(query) })
          : h('span', { 'data-vw-chip-ghost': '', 'aria-hidden': 'true', style: { ...S.chip, visibility: 'hidden' } }, '同步'),
        // The count's own slot carries the in-flight word: the toolbar is a
        // four-track grid, and a fifth child would wrap the actions onto a row
        // of their own. `aria-live` keeps the change announced.
        // `minWidth: 0` lets the track shrink, but the text itself must never be
        // clipped: on a phone the count used to be cut to "共 4" because the
        // neighbouring actions could not give up their own width.
        h('span', { style: { ...S.note, whiteSpace: 'nowrap', overflow: 'visible', textOverflow: 'clip' }, 'aria-live': 'polite' }, refreshing ? t('refreshing') : state.status === 'ready' ? t('itemsCount').replace('{n}', String(state.list?.vaultItems ?? visibleRows.length)) : ''),
        h(
          'div',
          // Named, because a narrow panel moves this cell to its own track and
          // "the last child" would silently stop meaning it the day a fifth
          // control joins the row.
          { style: S.toolbarActions, 'data-vw-actions': '' },
          // Icon-only actions, from the same 16×16 line-art table the sidebar
          // rail uses. The words cost a whole third row on a phone and squeezed
          // the count beside them; the glyphs keep the row one line at every
          // width. Each keeps its accessible name and tooltip, so nothing is
          // lost for a screen reader or a first-time reader.
          canWrite && !editor
            ? h('button', { type: 'button', 'data-vw-new': '', title: t('newEntry'), 'aria-label': t('newEntry'), style: S.iconButton, onClick: () => openCreator('login') }, navGlyph('newEntry', 14))
            : null,
          h('button', { type: 'button', title: t('openSetup'), 'aria-label': t('openSetup'), style: S.iconButton, onClick: () => setShowSetup(true) }, navGlyph('settings', 14)),
          // The refresh button means "ask again": `readVault` is the path that
          // always asks, so an answer from the section cache cannot happen here.
          h('button', { type: 'button', title: t('refresh'), 'aria-label': t('refresh'), style: S.iconButton, onClick: () => { void refreshOverview(); return readVault(query) } }, navGlyph('refresh', 14)),
        ),
      )

      // The place the ROWS belong to — see `listSection`. Every "what is this
      // row" decision below reads this rather than `section`, so a switch to
      // 验证码 cannot re-skin the previous place's rows as code rows and leave
      // them polling for codes.
      const rowSection = listSection
      const list = h(
        'div',
        {
          'data-vw-list': '',
          style: S.list,
          role: 'listbox',
          'aria-label': t('panelTitle'),
          // Keyed by the place ONLY: switching 全部条目 → 验证码 must re-mount
          // the list so the row stagger runs again (a redraw of the same
          // element would animate nothing), while a background refresh of the
          // SAME place must not — the rows are already on screen and re-running
          // the entrance over them would be the flash this entire change
          // exists to remove.
          //
          // The query used to be part of this key, and that made every
          // keystroke tear the whole list down and build it again: fifty rows
          // at roughly fifteen elements each is ~750 nodes, two CopyButtons
          // with their own state per row, and the stagger then replayed from
          // zero. Typing "github" in the search box did that on every debounced
          // pause. The rows are keyed by id, so results changing under a stable
          // container is exactly the diff React is good at.
          key: `list-${listSection.kind}-${listSection.value ?? ''}`,
          // Dimmed (not emptied) while the next place is being read.
          'data-vw-stale': switching ? '1' : undefined,
        },
        (state.status === 'ready' || refreshing) && visibleRows.length === 0
          ? // An empty screen says which emptiness it is: the trash, which is
            // empty because nothing is deleted, or any other place, which is
            // empty because the search or the place itself matched nothing.
            rowSection.kind === SECTION_TRASH
            ? h('div', { 'data-vw-trash-empty': '', style: S.empty }, h('span', null, t('trashEmpty')), h('span', { style: S.note }, t('listHint')))
            : h('div', { style: S.empty }, h('span', null, t('listEmpty')), h('span', { style: S.note }, t('listHint')))
          : visibleRows.map((item) =>
              h(VaultRow, {
                key: item.id,
                item,
                selected: item.id === selectedId,
                sectionKind: rowSection.kind,
                includeTrashed: rowSection.kind === SECTION_TRASH,
                iconTick,
                onSelect: setSelectedId,
                t,
                invoke,
              }),
            ),
        // The tail: the capped notice (rows this side cannot reach), the
        // explicit "还有 N 条" control (the reader outran the host, or a page
        // could not be read), or a quiet line while the next page is on its
        // way. Its numbers stay the host's own (rows loaded vs rows matched)
        // even under a folder filter: the filter is applied on top of what the
        // host served, so counting the visible rows here would promise a page
        // that has nothing left to show — and this control has to stay
        // reachable precisely when the filter matched nothing yet.
        cappedNotice
          ? h(
              'div',
              {
                'data-list-capped': '',
                style: { ...S.note, padding: '10px 4px 2px', textAlign: 'center', lineHeight: 1.6 },
              },
              t('moreBlocked')
                .replace('{shown}', String(visibleRows.length))
                .replace('{total}', String(matched))
                .replace('{n}', String(Math.max(0, matched - visibleRows.length))),
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
                t('loadMore').replace('{n}', String(Math.max(1, matched - visibleRows.length))),
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
        // The editor replaces the detail, not a section of it: the two answer
        // different questions ("what does this entry hold" vs "what should it
        // hold"), and a half-open editor under a read-only summary reads as a
        // form that will not save. Everything the editor needs is in `editor`,
        // `editorForm` and `editorBase`, so the reveal's own state is untouched
        // and the detail re-renders untouched once the editor closes.
        // A host that answered the draft with a stub is telling the reader
        // the entry is still gated. The editor is not shown at all in that
        // case: a form whose fields could never be filled reads as broken.
        if (editor && editorResult?.status === 'reprompt') {
          return h(
            'div',
            { 'data-vw-detail': '', style: S.detail },
            h('span', { style: S.cardTitle }, editorResult.name ?? t('untitled')),
            h('span', { style: S.note }, t('editorRepromptLocked')),
            h('button', { type: 'button', 'data-vw-editor-cancel': '', style: S.button, onClick: closeEditor }, t('editorCancel')),
          )
        }
        if (editor) {
          return h(
            'div',
            { 'data-vw-detail': '', style: { ...S.detail, display: 'flex', flexDirection: 'column', gap: 12 } },
            h(EditorForm, {
              open: editor,
              form: editorForm,
              base: editorBase,
              busy: editorBusy,
              loading: editorLoading,
              result: editorResult,
              stale: editorStale,
              folders,
              t,
              onChange: (next) => setEditorForm(next),
              onSave: () => { void saveEditor() },
              onCancel: closeEditor,
            }),
          )
        }
        // The card that is about to arrive, in outline. Returning a one-line
        // "同步中" card here made the pane jump in height twice per click —
        // once when it collapsed to the word and once when the fields landed.
        if (detail.status === 'loading') return h(DetailSkeleton, { t })
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
          // The gate the host put up is deliberate: nothing in this component
          // can open it but the user's own keystrokes, and the answer opens a
          // short window so a second entry does not need a second check.
          const minutes = Math.max(1, Math.ceil((grant.remainingMs || 0) / 60000))
          const unlocked = grant.granted && grant.remainingMs > 0
          return h(
            'div',
            { style: S.detail },
            h('span', { style: S.cardTitle }, value.name || t('untitled')),
            h('span', { style: S.note }, t('repromptLocked')),
            h('span', { style: S.note }, t('repromptHint')),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 320 } },
              h('input', {
                type: 'password',
                value: repromptPw,
                placeholder: t('repromptPasswordPlaceholder'),
                autocomplete: 'off',
                spellcheck: false,
                disabled: repromptBusy,
                'aria-label': t('repromptPasswordPlaceholder'),
                style: S.input,
                onInput: (event) => setRepromptPw(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !repromptBusy) authorizeReveal()
                },
              }),
              h(
                'button',
                { type: 'button', style: S.buttonPrimary, disabled: repromptBusy || !repromptPw, onClick: authorizeReveal },
                repromptBusy ? t('syncLoading') : t('confirmRead'),
              ),
            ),
            repromptErr ? h('span', { style: S.error, role: 'alert' }, repromptErr) : null,
            unlocked ? h('span', { style: S.note }, t('repromptGrantedBadge').replace('{n}', String(minutes))) : null,
            // The unlock is a window, and the editor is the one thing that
            // needs it: while the window is open the entry can be edited
            // without a second check, which is the whole reason the host
            // opens a window rather than answering one field.
            unlocked && canWrite
              ? h(ActionBadge, { action: 'edit', icon: 'pencil', label: t('edit'), tip: t('actionEditTip'), onClick: () => openEditor(value) })
              : null,
          )
        }
        const row = (label, content, copyValue) =>
          h(
            'div',
            { 'data-vw-field': '', style: S.fieldRow, key: label },
            h('span', { style: S.fieldLabel }, label),
            h('span', { style: S.fieldValue }, content ?? '—'),
            copyValue ? h('span', { 'data-vw-field-ctl': '', style: { display: 'inline-flex', gap: 6 } }, h(CopyButton, { value: copyValue, t, icon: true })) : null,
          )
        const typeKey = TYPE_LABEL_KEYS[value.type]
        const typeLabel = typeKey ? t(typeKey) : value.type
        /**
         * The rows under the identity card's username line: only the fields
         * that actually carry something, so an empty identity does not render
         * a column of dashes.
         */
        const subtitle = [value.username, value.folder, (value.collections ?? []).join(', ')].filter(Boolean).join(' · ')
        const kind = value.type

        /**
         * Narrow payloads are fetched on demand. `all` reports only that the
         * class exists; `typeFields[field]` holds the state of the one fetch
         * the reader asked for. Until then the entry gets a row that says what
         * is there and a button to fetch it — the panel being handed the whole
         * card number just because the entry was opened is the thing this
         * change was made to prevent.
         */
        const narrow = (field, present) => {
          const state = typeFields[field]
          if (!present) return { payload: null, row: null }
          const label = t(TYPE_LABEL_KEYS[value.type] ?? value.type)
          if (state?.status === 'ready' && state.value) return { payload: state.value, row: null }
          if (state?.status === 'error') return { payload: null, row: row(label, h('span', { style: S.error }, state.error), null) }
          const busy = state?.status === 'loading'
          // Built here rather than through `row()`: that helper's third
          // argument is a copy value, so passing a button would wrap it in a
          // CopyButton and the control would never be clickable.
          return {
            payload: null,
            row: h(
              'div',
              { 'data-vw-field': '', style: S.fieldRow, key: `narrow-${field}` },
              h('span', { style: S.fieldLabel }, label),
              h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                h('span', { style: S.listMeta }, t(HINT_KEYS[field])),
                // An SSH fingerprint identifies the key without being any
                // part of it, so `all` carries it and the placeholder shows
                // it — the reader can tell which key a row is about without
                // fetching the key.
                field === 'sshKey' && value.sshKeyFingerprint
                  ? h('span', { style: S.mono }, value.sshKeyFingerprint)
                  : null,
                busy ? h('span', { style: S.listMeta }, t('loadingMore')) : null,
              ),
              // Not a value control but a fetch: the eye would say "this is
              // already here, show it", which is the one thing this row cannot
              // do. An eye with a plus is what says "pull this one in".
              h(IconButton, { name: 'eyePlus', label: t('revealThisField'), disabled: busy, onClick: () => readTypeField(selectedId, field) }),
            ),
          }
        }

        const cardField = value.card ? { payload: value.card, row: null } : narrow('card', value.hasCard)
        const identityField = value.identity ? { payload: value.identity, row: null } : narrow('identity', value.hasIdentity)
        const sshKeyField = value.sshKey ? { payload: value.sshKey, row: null } : narrow('sshKey', value.hasSshKey)
        const card = cardField.payload
        const identity = identityField.payload
        const sshKey = sshKeyField.payload
        // The placeholder rows go in first so the "read this one field"
        // button sits where the class used to render, then the real rows
        // replace them once that single field has been fetched.
        const typeRows = [cardField.row, identityField.row, sshKeyField.row].filter(Boolean)
        if (kind === 'card' && card) {
          if (card.number) typeRows.push(h(SecretRow, { key: 'cardNumber', label: t('cardNumber'), secret: card.number, placeholder: '•••• •••• •••• ' + String(card.number).slice(-4), t }))
          if (card.cardholderName) typeRows.push(row(t('cardholderName'), card.cardholderName, card.cardholderName))
          if (card.brand) typeRows.push(row(t('cardBrand'), card.brand))
          const expiry = [card.expMonth, card.expYear].filter(Boolean).join(' / ')
          if (expiry) typeRows.push(row(t('cardExpiry'), expiry))
          if (card.code) typeRows.push(h(SecretRow, { key: 'cardCode', label: t('cardCode'), secret: card.code, placeholder: '•••', t }))
        }
        if (kind === 'identity' && identity) {
          for (const [labelKey, fieldNames] of IDENTITY_LABELS) {
            const parts = fieldNames.map((field) => identity[field]).filter(Boolean)
            if (parts.length) typeRows.push(row(t(labelKey), parts.join(' '), parts.join(' ')))
          }
          // Whatever the server sent that the label list does not name keeps
          // its own key as the label rather than disappearing.
          for (const [field, text] of Object.entries(identity)) {
            if (!IDENTITY_FIELD_NAMES.has(field) && text) typeRows.push(row(field, text, text))
          }
        }
        if (kind === 'sshKey' && sshKey) {
          if (sshKey.publicKey) typeRows.push(row(t('sshPublicKey'), h('span', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, sshKey.publicKey), sshKey.publicKey))
          if (sshKey.keyFingerprint) typeRows.push(row(t('sshFingerprint'), sshKey.keyFingerprint, sshKey.keyFingerprint))
          if (sshKey.privateKey) typeRows.push(h(SecretRow, { key: 'sshPrivateKey', label: t('sshPrivateKey'), secret: sshKey.privateKey, placeholder: '●●●●●●●●', t }))
        }

        /**
         * The custom fields block, shared by every type.
         *
         * Every value is masked, like a card number or a private key:
         * Bitwarden has a "hidden" field type that carries PINs, API keys and
         * recovery codes. The host does send `fields[].type` (it is what keeps
         * hidden values out of the model-facing `all` projection), but this
         * pane does not branch on it on purpose: the panel is where the
         * account's owner reads their own vault, so every field starts masked
         * and the human clicks 显示 — the same treatment the card number and
         * the private key get, hidden or not. The `type` is still carried in
         * the payload if a future row wants to label it.
         */
        const fieldsSection = (value.fields ?? []).length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
              h('span', { style: { fontSize: 12, fontWeight: 600, color: TOKEN.text2 } }, t('customFields')),
              ...(value.fields ?? []).map((field, index) =>
                h(SecretRow, {
                  key: 'field-' + index,
                  label: field.name,
                  secret: field.value,
                  placeholder: '●●●●●●●●',
                  t,
                }),
              ),
            )
          : null

        /**
         * Attachments, collapsed: the plugin never downloads the bytes (the
         * url behind them is a separate encrypted blob), so this is a list of
         * what is attached, not a download shelf.
         */
        const attachmentList = value.attachments ?? []
        const attachmentsSection = attachmentList.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
              h(
                'button',
                { type: 'button', 'data-vw-fold': 'attachments', style: S.foldHead, onClick: () => setAttachmentsOpen((previous) => !previous) },
                navGlyph(attachmentsOpen ? 'twistyOpen' : 'twistyClosed', 14),
                t('attachments').replace('{n}', String(attachmentList.length)),
              ),
              attachmentsOpen
                ? h(
                    'div',
                    { 'data-vw-attachments': '', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    ...attachmentList.map((entry, index) =>
                      h(
                        'div',
                        { style: S.attachmentRow, key: entry.id ?? `attachment-${index}` },
                        h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.fileName || '—'),
                        h('span', { style: S.listMeta }, entry.sizeName || (Number.isFinite(entry.size) ? `${entry.size} B` : '')),
                      ),
                    ),
                    h('span', { style: S.hint }, t('attachmentNoDownload')),
                  )
                : null,
            )
          : null

        /**
         * Password history, collapsed: the old passwords exist so that "was
         * this rotated?" has an answer — they are masked until asked for.
         */
        const history = value.passwordHistory ?? []
        const historySection = history.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
              h(
                'button',
                { type: 'button', 'data-vw-fold': 'history', style: S.foldHead, onClick: () => setHistoryOpen((previous) => !previous) },
                navGlyph(historyOpen ? 'twistyOpen' : 'twistyClosed', 14),
                t('passwordHistory').replace('{n}', String(history.length)),
              ),
              historyOpen
                ? h(
                    'div',
                    { 'data-vw-history': '', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    ...history.map((entry, index) =>
                      h(
                        'div',
                        { style: S.historyRow, key: `history-${index}` },
                        h('span', { style: S.mono }, '●●●●●●●●'),
                        h('span', { style: S.listMeta }, entry.lastUsedDate ? t('historyLastUsed').replace('{time}', absoluteTime(entry.lastUsedDate)) : ''),
                      ),
                    ),
                  )
                : null,
            )
          : null

        /**
         * The write block. The panel is the one surface the access gate does
         * not cover (its RPCs never ask), so the note says so in place; and
         * nothing is written without the confirmation step below it.
         */
        const writeKind = writeStateOf(value)
        const pending = pendingWrite && pendingWrite.id === value.id ? pendingWrite : null
        const busyWrite = writeState.status === 'saving' && writeState.id === value.id
        const actionsSection = h(
          'div',
          { 'data-vw-actions': '', style: S.actions },
          canWrite
            ? h(
                'div',
                // The footer strip: the four write actions as one tidy row of
                // icons pinned to the card's bottom edge, right-aligned the way
                // a toolbar is. No heading, no labels — what each one does is
                // in its title, and the row reads as a footer rather than as a
                // section of its own.
                { style: S.actionRow },
                writeKind === 'trashed'
                  ? h(ActionBadge, { action: 'restore', icon: 'restore', label: t('actionRestore'), tip: t('actionRestoreTip'), disabled: busyWrite, onClick: () => setPendingWrite({ id: value.id, kind: 'restore' }) })
                  : null,
                writeKind === 'trashed'
                  ? null
                  : h(ActionBadge, { action: 'edit', icon: 'pencil', label: t('edit'), tip: t('actionEditTip'), disabled: busyWrite, onClick: () => openEditor(value) }),
                writeKind === 'trashed'
                  ? null
                  : h(ActionBadge, {
                      action: 'archive',
                      icon: 'archiveBox',
                      label: value.archived ? t('actionUnarchive') : t('actionArchive'),
                      tip: value.archived ? t('actionUnarchiveTip') : t('actionArchiveTip'),
                      disabled: busyWrite,
                      onClick: () => setPendingWrite({ id: value.id, kind: value.archived ? 'unarchive' : 'archive' }),
                    }),
                writeKind === 'normal'
                  ? h(ActionBadge, { action: 'trash', icon: 'trash', label: t('actionTrash'), tip: t('actionTrashTip'), disabled: busyWrite, danger: true, onClick: () => setPendingWrite({ id: value.id, kind: 'trash' }) })
                  : null,
                writeKind === 'trashed'
                  ? null
                  : h(ActionBadge, { action: 'move', icon: 'moveFolder', label: t('actionMoveFolder'), tip: t('actionMoveFolderTip'), disabled: busyWrite, onClick: () => setMoveTarget(value.folderId ?? '') }),
              )
            : h('span', { 'data-vw-readonly': '', style: S.note }, t('writeBlockedReadonly')),
          pending
            ? h(
                'div',
                { 'data-vw-confirm': '', style: S.confirmBox },
                h('span', null, confirmText(pending)),
                h('span', { style: S.hint }, t('writeNote')),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  h('button', { type: 'button', 'data-vw-confirm-ok': '', style: S.buttonPrimary, onClick: confirmWrite }, t('confirm')),
                  h('button', { type: 'button', style: S.button, onClick: closeWrite }, t('cancel')),
                ),
              )
            : null,
          moveTarget !== null
            ? h(
                'div',
                { 'data-vw-move': '', style: S.confirmBox },
                h('span', null, t('actionMoveFolder')),
                h(
                  'select',
                  { style: S.filterSelect, value: moveTarget, onChange: (event) => setMoveTarget(event.target.value) },
                  h('option', { key: '__none__', value: '' }, t('moveNone')),
                  ...folderOptions().map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)),
                ),
                h('span', { style: S.hint }, t('writeNote')),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      'data-vw-move-ok': '',
                      style: S.buttonPrimary,
                      onClick: () => {
                        const folderId = moveTarget ? moveTarget : null
                        const label = moveTarget ? folderLabel(moveTarget) : t('moveNone')
                        setPendingWrite({ id: value.id, kind: 'move', folderId, label })
                        setMoveTarget(null)
                      },
                    },
                    t('confirm'),
                  ),
                  h('button', { type: 'button', style: S.button, onClick: closeWrite }, t('cancel')),
                ),
              )
            : null,
          writeState.id === value.id && writeState.status === 'saving' ? h('span', { style: S.note }, t('writeSaving')) : null,
          writeState.id === value.id && writeState.status === 'done' ? h('span', { 'data-vw-write-done': '', style: S.ok }, t('writeDone')) : null,
          writeState.id === value.id && writeState.status === 'error' ? h('span', { 'data-vw-write-error': '', style: S.error }, writeMessage(writeState)) : null,
        )

        return h(
          'div',
          {
            'data-vw-detail': '',
            style: S.detail,
            // Keyed by the entry so moving between two entries re-mounts the
            // card: the entrance animation runs per entry (as it should — the
            // reader did press a different row), and no frame of the previous
            // entry's fields can survive into the new one.
            key: `detail-${value.id}`,
          },

          // Trashed first: it is the state that changes how every other row
          // below should be read.
          value.trashed ? h('div', { 'data-vw-banner': '', style: { ...S.banner, borderColor: TOKEN.warn, color: TOKEN.text } }, t('trashedBanner')) : null,
          h(
            'div',
            { 'data-vw-head': '', style: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 } },
            // The detail header takes the same tile the list row does: the site's
            // favicon when the server has one, the letter tile when it does not.
            // Rendering the monogram alone here left the opened entry as a bare
            // letter even though its row in the list was showing the icon.
            h(
              'span',
              { style: { ...S.avatar, width: 36, height: 36, fontSize: 14 }, 'aria-hidden': 'true' },
              iconFor(value, S.avatarImgLg) ?? monogram(value),
            ),
            h(
              'div',
              { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
              h('span', { style: S.cardTitle }, value.name || t('untitled')),
              h('span', { style: S.listMeta }, subtitle || t('noMeta')),
            ),
            // The entry's marks, in one group so their boxes line up with the
            // list rows they came from. The type is the human word for it,
            // never the raw `type3` an unknown numeric type falls back to;
            // it stays neutral because it classifies rather than warns.
            h(
              BadgeRow,
              { style: { gap: 6 } },
              value.type ? h(Badge, { tone: 'neutral' }, typeLabel) : null,
              value.archived ? h(Badge, { tone: 'muted', title: t('archivedTip') }, t('archived')) : null,
              value.hasFido2 ? h(Badge, { tone: 'ok', title: t('hasFido2Tip') }, t('hasFido2')) : null,
            ),
          ),
          h('div', { style: { height: 1, background: TOKEN.border } }),
          // Login-only rows: a card or an SSH key has no password, and an
          // empty one under a "password" label read as a broken entry.
          kind === 'login' ? row(t('username'), value.username, value.username) : null,
          // One row for the password: masked value, a show/hide toggle and a
          // copy button. Rendering the toggle as a second row made the label
          // repeat and pushed the controls out of the card.
          kind === 'login'
            ? h(
                'div',
                // The same three-part anatomy every other secret row uses —
                // label, value, controls — so a password sits in the same
                // column as a card number or a private key. The controls are
                // one flex group (not a nested column that wrapped them onto
                // their own line), which is what keeps 显示 and 复制 on one
                // line at every width; the field row's own grid handles where
                // that group lands. The trailing empty cell the old three-slot
                // grid needed is gone with it: in a one-column row it left a
                // stray 4px gap under the buttons on a phone.
                { 'data-vw-field': '', style: { ...S.fieldRow, alignItems: 'start' }, key: 'password' },
                h('span', { style: { ...S.fieldLabel, paddingTop: 2 } }, t('password')),
                h('span', { style: revealed ? { ...S.mono, overflowWrap: 'anywhere', minWidth: 0 } : { ...S.fieldValue, ...S.mask } }, revealed ? value.password ?? '' : '●●●●●●●●'),
                h(
                  'span',
                  { 'data-vw-field-ctl': '', style: { display: 'inline-flex', gap: 6, flexWrap: 'wrap' } },
                  h(RevealButton, { open: revealed, t, onClick: () => setRevealed((previous) => !previous) }),
                  value.password ? h(CopyButton, { value: value.password, t, icon: true }) : null,
                ),
              )
            : null,
          // Gated on the host's own flag: the panel is never handed
          // `totpSecret` — that is the point of the projection — so gating on
          // it left every entry showing a dash for a code the host can compute.
          //
          // This is the one field row that is centred instead of top-aligned.
          // Its value is a 30px ring with the 14px code vertically centred in
          // it, so top-aligning the row put the label's baseline 8px above the
          // code's — the only row in the card where the two columns disagreed
          // about where the line was. Centring both boxes puts the same line
          // through them.
          //
          // `data-vw-totp-cell` is here for the phone, not the desktop: the
          // narrow layout pins a field row's trailing cell to the right edge
          // (that is where the 28px glyph slots live), and a code is not a
          // control — pushed to the far edge it read as a second column of the
          // card. The stylesheet sends this one back to the left instead.
          kind === 'login'
            ? h(
                'div',
                { 'data-vw-field': '', style: { ...S.fieldRow, alignItems: 'center' } },
                h('span', { style: S.fieldLabel }, t('totp')),
                h(
                  'span',
                  { 'data-vw-totp-cell': '', style: { minWidth: 0 } },
                  value.hasTotp ? h(TotpValue, { id: value.id, invoke, t }) : h('span', { style: S.listMeta }, '—'),
                ),
              )
            : null,
          ...typeRows,
          kind === 'login' ? row(t('uris'), (value.uris ?? []).join(', ')) : null,
          row(t('folder'), [value.folder, (value.collections ?? []).join(', ')].filter(Boolean).join(' · ')),
          // A secure note's body is its whole content, so it gets the label
          // that says so instead of the generic "notes".
          // Either way the body starts as dots and pre-wraps only once the
          // reader asks for it: a note is as sensitive as a password (the
          // host's own projection says so), and the pane may be open while
          // somebody else is looking at it. SecretRow carries the toggle and
          // the copy control, exactly as it does for a card number; the
          // `narrow('secureNote', …)` fetch above is untouched, so the body
          // still arrives only when that one field was asked for.
          kind === 'secureNote'
            ? (() => {
                const noteField = narrow('secureNote', Boolean(value.secureNote))
                if (noteField.payload?.notes !== undefined) {
                  return h(SecretRow, { label: t('secureNoteBody'), secret: noteField.payload.notes, placeholder: '●●●●●●●●', multiline: true, t })
                }
                return noteField.row ?? h(SecretRow, { label: t('secureNoteBody'), secret: value.notes ?? '', placeholder: value.notes ? '●●●●●●●●' : '—', multiline: true, t })
              })()
            : h(SecretRow, { label: t('notes'), secret: value.notes ?? '', placeholder: value.notes ? '●●●●●●●●' : '—', multiline: true, t }),
          fieldsSection,
          attachmentsSection,
          historySection,
          actionsSection,
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
       * The live-sync poll: the vault is a shared thing, and a change made in
       * the official client (or by another copy of this panel) has to reach the
       * rows here without the reader pressing 刷新.
       *
       * It is gated on three things, each of which would make the request
       * pointless or harmful:
       *   - the host saying it has no live channel at all (an old host that
       *     predates `liveSync` in the status report), where polling is the
       *     only channel there is and the interval is the host's;
       *   - a WebSocket already pushing (`mode === 'websocket'`), where the
       *     host's own signal handler refreshes and a second timer would
       *     double every read;
       *   - the panel having nothing to refresh yet, or the reader being in the
       *     middle of something — an open editor, an open setup form, a write
       *     in flight — where replacing the rows would drop their work.
       *
       * The refresh itself is a quiet one: `readVault` keeps whatever is on
       * screen while it asks, so an unchanged vault repaints identically
       * instead of flashing.
       */
      useEffect(() => {
        const report = state.status === 'ready' || refreshing ? state.report : null
        const live = report?.liveSync
        // Only a host that reports a live channel at all can be asked: the
        // field is absent on an older host, and a panel that invented an
        // interval would poll a server that never said it wanted to be polled.
        if (!live || live.mode === 'off' || live.mode === 'websocket') return undefined
        if (state.status !== 'ready' && !refreshing) return undefined
        if (editor || showSetup || pendingWrite || writeState.status === 'saving') return undefined
        const interval = Math.max(15000, Number(live.pollIntervalMs) || 60000)
        let alive = true
        const tick = async () => {
          if (!alive) return
          try {
            await readVault(query)
          } catch {
            /* a failed poll leaves the rows as they are; the next one retries */
          }
        }
        const timer = setInterval(tick, interval)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [state.status, state.report, refreshing, editor, showSetup, pendingWrite, writeState.status, query, readVault])

      /**
       * Leave the two-factor screen for the setup form.
       * Also drops the half-finished session: once the user goes back to edit
       * the address/account/password, the stale challenge must not survive and
       * the next connect starts clean.
       */
      const backToSetup = async () => {
        forgetConfig()
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

      /**
       * Dress a whole-surface swap so it animates instead of cutting.
       *
       * The panel has four mutually exclusive surfaces — the vault, the
       * sign-in form, the two-factor form and the setup form — and pressing
       * between them used to be an instant tree swap: the old card vanished and
       * the new one appeared in the same frame, which the eye reads as a
       * flicker. Wrapping the swap in a keyed element gives it a name, and the
       * stylesheet gives that name a fade.
       *
       * The key is what makes it a *swap* rather than a redraw: React unmounts
       * the old wrapper and mounts a new one, so the CSS animation restarts
       * even when the two surfaces happen to be the same component (retrying a
       * sign-in, say). Without the key the second attempt would animate
       * nothing.
       */
      const surface = (node) =>
        h('div', { key: `surface-${state.status}-${showSetup ? 'setup' : 'main'}`, 'data-vw-anim': 'surface', style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 } }, node)

      const body = () => {
        // The setup form wins whenever it is open: after "back to settings" the
        // user must be able to edit the address/account/password in peace.
        if (showSetup) {
          return surface(h(SetupForm, {
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
          }))
        }
        // The first read of an open panel. This used to return a one-line card
        // holding the word 同步中 — the whole panel collapsed to a sentence,
        // then grew back into a sidebar and a list, and that grow-back is what
        // read as a flash. Now the body keeps its final shape from the first
        // frame: a ghost sidebar, a ghost list, and an empty detail slot that
        // the real answer fades into.
        if (state.status === 'loading') {
          return h(
            'div',
            { 'data-vw-body': '', 'data-vw-booting': '', style: S.body },
            nav(),
            h(
              'div',
              { 'data-vw-main': '', style: S.main },
              h('div', { 'data-vw-split': '', style: S.split }, h(ListSkeleton, { t })),
            ),
          )
        }
        // Opening the panel lands here whenever no session is live: the user
        // signs in explicitly instead of being auto-logged-in (and, for a
        // 2FA account, dropped onto the code screen every time).
        if (state.status === 'signin') {
          return surface(h(SignInForm, {
            t,
            invoke,
            initial: setup.status === 'ready' ? setup.config : undefined,
            onConnected: () => readVault(query),
            onTwoFactor: (pending) => {
              setTwoFactor({ pending: true, providers: pending.providers, provider: pending.provider, providerDescriptions: pending.providerDescriptions })
              setState({ status: 'two_factor' })
            },
            onSetup: () => setShowSetup(true),
          }))
        }
        if (state.status === 'two_factor') {
          return surface(h(TwoFactorForm, {
            t,
            invoke,
            pending: twoFactor ?? { pending: true },
            onDone: () => load(query),
            onRestart: backToSetup,
            onRefresh: refreshChallenge,
          }))
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
            return h('div', { 'data-vw-anim': 'surface', style: { ...S.detail, ...S.empty } }, h('span', { style: S.note }, t('syncLoading')))
          }
          return surface(h(SetupForm, {
            t,
            invoke,
            initial: setup.status === 'ready' ? setup.config : undefined,
            notice: setup.status === 'error' ? t('setupConfigFailed') + '：' + setup.error : null,
            onDone: () => load(query),
          }))
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
            forgetConfig()
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
        // The sidebar and the list share the body once the panel is wide
        // enough; below that the stylesheet stacks them and the drill state
        // hides the list behind the open entry (see the container queries in
        // ensureStyles).
        return h(
          'div',
          // The drill state takes the list away whenever the detail column is
          // the thing being read — for an opened entry AND for the editor. The
          // editor is what exposed the difference: 新建条目 opened a form into
          // a pane that sits *after* the list in the tree, and on a narrow
          // panel (the phone-width settings dialog) the list is thousands of
          // pixels tall, so the form was rendered far below the fold and the
          // button that opened it disappeared from the toolbar. Without the
          // drill flag the CSS keeps the list too.
          { 'data-vw-body': '', 'data-vw-drill': selectedId || editor ? '1' : undefined, style: S.body },
          nav(),
          h(
            'div',
            { 'data-vw-main': '', style: S.main },
            // Where the list gave its column to the entry, this is the way
            // back to it; where both fit side by side the list never left,
            // so the stylesheet hides the row (it stays in the tree, so the
            // control exists at every width).
            selectedId
              ? h(
                  'div',
                  { 'data-vw-back-row': '', style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h(
                    'button',
                    { type: 'button', 'data-vw-back': '', style: { ...S.button, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 4 }, onClick: () => setSelectedId(null) },
                    navGlyph('chevronLeft', 14),
                    t('backToList'),
                  ),
                )
              : null,
            h(
              'div',
              { 'data-vw-split': '', style: S.split },
              list,
              editor || selectedId ? detailPane() : null,
            ),
          ),
        )
      }

      // The search toolbar only makes sense once there is a vault to search —
      // and it must stay mounted while a read is in flight, or the box the
      // reader is typing into would disappear under their cursor on the first
      // keystroke. That is exactly why `refreshing` exists as a status of its
      // own: the rows and the toolbar both outlive the read, and the count's
      // slot carries the "in flight" word instead.
      // The toolbar is part of the panel's frame, not part of its answer.
      //
      // It used to wait for the first read, which meant the whole panel grew by
      // the toolbar's height (~40px) the moment rows arrived — measured as a
      // 392px → 624px jump in the panel's own box. Keeping the controls on
      // screen from the first frame also means the search box the reader may
      // already be typing into is never taken away and put back.
      const showToolbar = (state.status === 'loading' || state.status === 'ready' || refreshing) && state.report?.configured !== false
      // What the heading reports about this build. The host's own answer wins;
      // the build stamp covers the two cases where there is none (an older
      // host, or a bundle served before a restart picked up the new node half).
      const version = plugin?.version || BUILD_VERSION
      const repoUrl = plugin?.repository || BUILD_REPOSITORY
      return h(
        'div',
        { className: 'vw-root', style: S.panel },
        h(
          'div',
          { style: S.titleRow },
          // No mark in the heading. The shield was tried here and cost more
          // than it gave: it had to be sized against the name beside it, and at
          // any size it pushed the metadata onto a second row at phone width.
          // The settings rail already carries the badge for this section, so
          // repeating it one line below read as an icon beside an icon.
          //
          // Two groups, not four loose items. The heading is one unit and the
          // metadata is another, so a narrow panel moves the WHOLE metadata
          // block to the next row — instead of the old behaviour, where the
          // package stayed on line one and only the version and link fell
          // through, which read as an unfinished line. Within a group nothing
          // wraps; `nowrap` on each is what makes that a guarantee rather than
          // a hope about the text's width.
          h(
            'span',
            { style: S.titleHead },
            // Heading only. The badge was here for a while and the row read as
            // "icon, gap, icon" beside the settings rail's own shield on the
            // same screen; the rail already identifies the section, so the
            // heading does not repeat it.
            h('span', { style: S.titleText }, t('panelTitle')),
          ),
          // `plugin` (the host's own manifest read) wins when it is there;
          // otherwise the build stamp answers, so the line is never empty — not
          // on an older host, and not on a bundle served before a restart
          // picked up the new node half.
          h(
            'span',
            { 'data-vw-note': '', style: S.titleMeta },
            // The package name leads the metadata group: when the panel is too
            // narrow for one line, it travels down WITH the version and the
            // link instead of being left behind on the heading's row. Grouped
            // this way each row reads as a whole thought — a name, then an
            // identity — rather than as a heading with its tail cut off.
            h('span', { style: S.titlePackage }, t('packageLabel')),
            h('span', { style: S.titleDot, 'aria-hidden': 'true' }),
            h('span', { 'data-vw-version': '', style: S.titleVersion }, t('versionLabel').replace('{version}', version)),
            h('span', { style: S.titleDot, 'aria-hidden': 'true' }),
            h(
              'a',
              {
                'data-vw-repo': '',
                href: normalizeRepoUrl(repoUrl),
                target: '_blank',
                // noreferrer as well as noopener: the target is our own repo,
                // but a settings dialog is not a place to leak the host origin.
                rel: 'noopener noreferrer',
                title: t('repoTitle'),
                style: S.titleLink,
              },
              h('span', { style: { display: 'inline-flex', alignSelf: 'center' } }, navGlyph('github', 13)),
              t('repoLabel'),
            ),
          ),
        ),
        showToolbar ? toolbar : null,
        h('div', { ref: scrollRef, style: S.scrollArea, 'data-scroll-area': '', onScroll: onListScroll }, h('div', { style: S.scrollItem }, body())),
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

      // The transcript's rows for this plugin's tools. These exist for one
      // reason: the model-facing result is plaintext on purpose, and the
      // conversation is a surface the operator did not choose to expose it on.
      // The row is built from the recorded call and result, so it is a pure
      // re-render — no RPC, and replaying a stored session shows the same
      // masked card it showed live. Unclaimed tool names keep the host's
      // generic row, so a host without this slot simply shows the raw card as
      // before rather than breaking.
      for (const toolName of Object.keys(TOOL_ROW_KEYS)) {
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            { name: 'tool.call.toolview', key: toolName, inject: () => ({ t }) },
            (props) => h(BitwardenToolRow, { ...props, t: props.t ?? t }),
          ),
        )
      }
    }

    /**
     * Test hooks: the transcript row plus the masker it draws from.
     *
     * Exported as values rather than through a render helper because this
     * bundle's `require` is the host's seed table — it has no renderer, and a
     * second require() from inside the factory is what the module-loader
     * contract forbids. The suite mounts the component with its own renderer.
     */
    const __toolRow = { component: BitwardenToolRow, maskSecrets, maskSecretText, isSecretKey, mask: MASK, keys: TOOL_ROW_KEYS }
    module.exports = { name: 'dsh-vaultwarden', inject: ['slots', 'locale', 'connection'], apply, VaultPanel, __resetOpenCache: resetOpenCache, __resetPagingRefusal: () => { pagingRefused = false; pagingRefusedAt = 0 }, __setIcons: setIcons, __toolRow,
      /**
       * Drop the memoized platform-primitives lookup. The resolution is cached
       * at module scope because the answer cannot change while a page lives;
       * the suite, which mounts the same bundle against pages WITH and WITHOUT
       * the module, is the one caller that needs it re-read.
       */
      __resetPrimitives: () => { primitivesCache = undefined } }
    return module.exports
  },
})
