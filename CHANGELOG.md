# Changelog

All notable changes to `dsh-vaultwarden` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.6] — 2026-10-01

### 新增

- 插件列表显示彩色图标：双层盾牌（紫 #6C4DF6 + 蓝 #2E6BE6）配白色镂空钥匙孔，与官方插件同一套 artwork 规范（包根 icon.svg + package.json icon 字段）。
- 设置页「凭证据库」一行换成插件自己的盾牌图标，不再用宿主默认齿轮；图标随行内文字流式排布，桌面列与移动 tab 条都不错位、不夺位。
- 设置页图标跟随行文字颜色，明暗双主题无需额外处理。

### 测试

- Host 入口测试新增插件列表图标契约断言（27 项，原 23）。
- 客户端组件测试覆盖设置行盾牌图标（85 项，原 83）。
- 全套测试 287 项，8 个文件全部通过。

## [0.2.5] — 2026-10-01

### 新增

- 打开凭据库面板自动恢复登录：访问令牌过期或重启后，直接用已保存的会话自动续期，不再要求重新登录。
- 打开面板立即显示条目：列表先渲染本地快照，再后台从服务器刷新。
- 插件启动即预热：插件加载时就在后台恢复会话、填充解密缓存，重启后第一次打开面板不再等待。
- 新增 `vw/boot` 接口：一次请求同时拿到配置与登录状态；不支持的旧宿主自动回退原逻辑，条目列表照常打开、不要求登录。
- 列表读取与连接状态探测并行执行，探测失败不再拖累列表。

### 修复

- 修复每隔一小时就要求重新登录的问题。
- 修复已保存的会话被误删、每次登录都要重输两步验证码的问题。
- 修复旧宿主上打不开条目列表的问题。

### 测试

- 客户端组件测试改用 `boot` 接口（83 项，原 72），覆盖快照先渲染、登出后不渲染列表等场景。
- 网关流程测试新增 `boot` 一节（51 项，原 35），含旧宿主回退两条断言（仍能打开列表、不要求登录）。
- 全套测试 279 项，8 个文件全部通过。

## [0.2.4] — 2026-09-30

Installable again from npm. No breaking changes.

### Fixed

- **`npm install` failed with `ERESOLVE` against every current DSH build.**
  Every published `@deepseek-ai/dsh-*` build is a prerelease, and npm only
  admits a prerelease when the range carries an explicit branch for its
  `major.minor.patch` tuple. `>=0.1.0-rc.1 <0.3.0-0` therefore admitted 5 of
  the 30 published `@deepseek-ai/dsh-tools` builds and rejected the rest,
  including the harness this plugin runs on. The harness loader itself checks
  peers with `{ includePrerelease: true }`, so nothing failed at load time —
  only the npm path, which is exactly the path the marketplace falls back to.
  Both `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-typert-protocol` now
  enumerate the published release lines (`^0.1.0-0 || … || ^0.2.0-0`), which
  admits 26 of 30 builds — everything from the 0.1.0 line onward.
- **`@deepseek-ai/schemastery` had the same trap.** `^3.18.0` rejected the
  published `3.18.1-rc.1` / `3.18.1-rc.4` builds; the range now carries a
  `^3.18.1-0` branch and admits all six published versions.
- **The `cordis` peer named a package the runtime does not ship.** The
  declaration was the bare name `cordis` (an unrelated npm package, and not
  installed anywhere in a DSH tree), so the peer could never resolve; it is
  now `@deepseek-ai/cordis` with the range `>=4.0.1-rc.1 <5`, which admits
  every published build and refuses `4.0.0-rc.x` / `5.x`.

### Added

- **`test/peer-ranges.test.mjs`** — a manifest guard that resolves a semver
  copy from the local DSH installation, checks every peer range against the
  hard-coded `npm view <pkg> versions` fixtures, and pins the versions that
  must stay refused (`0.0.1-rc.*`, `0.3.0`, `4.0.0-rc.10`, `5.0.0`, …). It
  fails with 13 checks against the previous manifest and passes against the
  new one, so the trap cannot come back unnoticed. Skips itself (exit 0) when
  no DSH installation is reachable, like the CLI interop suite.

### Notes

- The version lists in the guard are fixtures, not a live lookup: update them
  when the harness publishes a release.
- 252 offline tests across eight suites (`bash scripts/build.sh`).

## [0.2.3] — 2026-09-29

Panel copy and phone layout. No breaking changes.

### Changed

- **The title is just "Bitwarden 凭据库".** The old
  "Bitwarden / Vaultwarden 凭据库" spent the whole heading on two product
  names. Vaultwarden support now rides alongside in small type
  (`（支持 Bitwarden / Vaultwarden）`), which says the same thing without
  shouting it. The English dictionary matches.
- **The search box only says what it searches.** The placeholder also carried
  the keyboard shortcuts, and on a phone that text was truncated before it
  finished. It is now `搜索名称、用户名或网址`, with `/`, Esc and ↑↓ moved to
  the input tooltip, where they stay reachable without competing for space.

### Fixed

- **Phone layout.** Below 560px the search box takes its own row, field rows
  stack their label above the value so long URLs and notes keep the full
  width, and the detail card tightens its padding. Driven by a scoped media
  query over markers on the elements that need re-flowing.
- **Every list tile showed the same glyph.** Entries named after a host
  (`10.0.0.10`, `…:9443`) showed `1` in every row. The monogram now takes
  the first letter found across name, username and URI host, so those rows
  read as distinct entries at a glance.

### Tests

- 221 offline tests across seven suites (`bash scripts/build.sh`).

## [0.2.2] — 2026-09-29

A fresh install could not be set up from the panel. No breaking changes.

### Fixed

- **A new install was stuck on "尚未配置完成" and could never reach the
  guided setup form.** The panel opens with `vw/config`, and that call
  rejected on an unconfigured install: the payload reports the session store
  through `VaultClient.sessionPersistence`, whose getter keyed the stored
  session by `serverUrl` — empty before setup — and `normalizeServerUrl("")`
  raises `not_configured`. The exception took the whole config payload down,
  so the panel rendered an error wall whose only control was a 重试 button
  that re-ran the same failing request. The getter now reports "nothing
  stored" instead of throwing when no server is configured. This is the path
  a first install takes, so it affected every new user.
- **A failed `vw/config` no longer hides the setup form.** The form is the
  only way out of an unconfigured state, so it is now rendered from the
  configuration state alone: whatever makes the read fail, the fields come up
  empty with the reason shown above them, instead of a dead end.

### Tests

- Two regression suites for the report above: the gateway now asserts that a
  fresh install can read its config (the wiring mirrors `lib/index.js`, with a
  real `SessionStore` — without a store the getter returned early, which is
  why the existing tests passed), and the panel asserts that a failing config
  RPC still offers the setup form.
- 214 offline tests across seven suites (`bash scripts/build.sh`).

## [0.2.1] — 2026-09-29

Panel responsiveness and release polish. No breaking changes.

### Fixed

- **Reopening the panel no longer re-loads everything.** Each open re-ran
  `config` → `session` → `list` → `status`, and `status()` performs a
  `/api/config` network round trip (measured **380–830 ms** against a real
  Vaultwarden) whose only useful output is the server version string. Three
  layers of caching now sit in front of that:
  - the reachability probe is reused for 5 minutes (a forced refresh still
    always re-probes),
  - `findEntries` is memoised per `(query, limit)` and dropped whenever the
    vault is replaced,
  - a module-level cache survives the panel unmounting, so a reopen paints the
    previous list immediately and refreshes quietly behind it. A failed
    background refresh never replaces a view the user is already reading, and
    the cache is keyed by `serverUrl` + `email` so switching accounts cannot
    show one vault's entries for another.
- **A reload loop that wiped user input.** `readVault` had been given
  `state.status` as a dependency, so every status change rebuilt `load()`,
  which re-ran the mount effect — an endless reload. The status is now read
  through a ref, which gives the same answer without the churn.

### Added

- Panel screenshots (`assets/`) plus `screenshots.json`, so storefronts show
  the list and detail views in both themes. The published images are
  anonymised: real usernames, emails and addresses were replaced with demo
  values, while layout and colour are the genuine render.

### Tests

- 207 offline tests across seven suites (`bash scripts/build.sh`).

## [0.2.0] — 2026-09-29

First public release as an **independent project** (not a fork). It talks to the
Bitwarden/Vaultwarden REST + SignalR protocols directly: no `bw` CLI, no runtime
dependencies beyond an optional `hash-wasm` (Argon2id KDF).

### Added

- **WebSocket real-time sync** — subscribes to `/notifications/hub` (SignalR),
  debounces bursts by 400 ms, then pulls `/api/sync` and re-decrypts the cache.
  Falls back to polling when the hub is unreachable and **periodically retries
  upgrading back** to WebSocket; honours `LogOut` notifications; backs off on
  429.
- **Write-back** — `bitwarden_create` / `bitwarden_update` / `bitwarden_delete`
  (soft delete by default, `permanent` to purge), personal items only.
- **Entry browser panel** — a settings page with search, a hierarchical
  list → detail flow, copy buttons, live TOTP countdown, and a reprompt gate for
  entries that require re-verification.
- **Three write-permission tiers** — `readonly` (default, refuses every write),
  `ask` (each write goes through the host approval seam; denied when no approval
  channel is composed), `auto` (writes directly).
- **Guided setup + sign-in forms** — server URL, email, master password, and an
  optional sign-in method switch to **API key** (`user.<uuid>` + secret), which
  bypasses two-factor. Credentials are verified before being stored, and only
  changed fields are written.
- **Two-factor login** — password is verified first; the code screen is reached
  only afterwards. A rejected code keeps the user on that screen to retry, and
  the challenge is refreshed automatically when it expires.
- **Session persistence** (`sessionDays`, default 30) — the token, refresh token
  and derived master key are stored in
  `~/.dsh/data/dsh-vaultwarden/session.json` (`0600`), so plugin and harness
  restarts no longer require a password or a new code. Expiry is **idle-based**:
  every use slides the window, and only 30 idle days invalidate it. Set `0` to
  disable.
- **Clickable sync chip** — click to sync immediately; hover for sync mode,
  connection state, poll interval, last signal/sync times and the last error.
- Six global tools — `bitwarden_find`, `bitwarden_get`, `bitwarden_status`,
  `bitwarden_sync`, plus the three write tools — and a system-prompt section that
  teaches every session to consult the vault before asking the user.

### Security

- The panel reads through the authenticated `/api` connection RPC channel
  (`vw/*`); the plugin deliberately serves **no HTTP route of its own**, so it
  cannot bypass the operator's session.
- Secret fields (master password, API key secret) are marked `secret`: never
  echoed back to the UI, never written to logs.
- WebAuthn / passkeys are **not supported**: they require a browser and a user
  gesture on an authenticator, which a headless process cannot perform. Use an
  API key instead — it bypasses two-factor entirely.

### Notes

- `peerDependencies` enumerate the published DSH release lines
  (`^0.1.0-0 || … || ^0.2.0-0`) with an explicit prerelease branch per tuple,
  because npm admits a prerelease only through a comparator carrying the same
  `major.minor.patch`. See the 0.2.4 entry above.
- Verified against Vaultwarden 2026.6.0 (`/notifications/hub` reachable,
  two-factor account, 431 entries).
- 204 offline tests across seven suites (`bash scripts/build.sh`).
