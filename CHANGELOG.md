# Changelog

All notable changes to `dsh-vaultwarden` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- `peerDependencies` use explicit prerelease branches
  (`>=0.1.0-rc.1 <0.3.0-0`) so rc builds of DSH resolve correctly.
- Verified against Vaultwarden 2026.6.0 (`/notifications/hub` reachable,
  two-factor account, 431 entries).
- 204 offline tests across seven suites (`bash scripts/build.sh`).
