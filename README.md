# dsh-vaultwarden — 让每个 DSH 会话实时同步 Vaultwarden 密码库

把自建 **Vaultwarden / Bitwarden** 接入 DeepSeek Harness：任何新建会话（无论 workspace）都会自动知道"密码可以去 Bitwarden 里读"；服务器端任何增删改都会通过 WebSocket **实时**反映到本地，无需手动刷新。

> Forked from [Jindom/dsh-bitwarden](https://github.com/Jindom/dsh-bitwarden)（MIT，协议层与 mock 测试体系源自上游）。本 fork 的核心增量：**WebSocket 实时同步 + 写回 + 条目浏览面板 + 更完整的 Bitwarden 客户端约定遵从**。

## 装了什么

| 能力 | 说明 |
| --- | --- |
| 实时同步引擎 | 登录后订阅 `/notifications/hub`（SignalR over WebSocket），服务器变更即时推送 → 400ms 防抖 → 增量 `/api/sync` + 解密换缓存；WebSocket 不可用（`ENABLE_WEBSOCKET=false`、旧服务器、反代不放行）自动降级为轮询；429 限流自动退避 |
| 7 个全局工具 | `bitwarden_find`（检索，不含密码）、`bitwarden_get`（密码/用户名/TOTP/备注/自定义字段）、`bitwarden_status`（配置/连通/解锁/同步模式）、`bitwarden_sync`（强制同步）、`bitwarden_create`/`bitwarden_update`/`bitwarden_delete`（写回，默认关闭） |
| 系统提示词章节 | 全局注入引导：需要任何账号、密码、API key、token 时先自查凭据库，而不是先问用户 |
| 设置卡片 | 设置 → 插件 → 插件配置里的 Bitwarden 卡片：连接/认证/同步三节 9 个字段 + 同步状态行（实时/轮询/关闭 + 圆点 + 相对同步时间） |
| 条目浏览面板 | 设置 → 凭据库 独立页面：搜索、列表、详情、复制、TOTP 30 秒倒计时、reprompt 条目受保护 |
| 同源 HTTP API | `/dsh-vaultwarden/api/{status,list,reveal,totp,sync}`，仅供浏览器半边调用，**仅接受本机回环请求** |

插件直连服务器 REST API（`/identity/accounts/prelogin`、`/identity/connect/token`、`/api/sync`、`/api/ciphers*`），
**不依赖 `bw` CLI**；除可选的 `hash-wasm`（Argon2id KDF）外全部使用 Node 内置模块。

## 配置

三种方式，优先级从高到低：**用户设置（GUI/settings.yaml）→ 插件组合配置 → 环境变量 → 默认值**。

### 1. DSH 设置界面（推荐）

**设置 → 插件 → 插件配置 → Bitwarden / Vaultwarden 凭据库**：主密码与 API 密钥是**只写字段**（保存后不回传浏览器，留空表示不修改）。

| 字段 | 说明 |
| --- | --- |
| `serverUrl` | 服务器地址，如 `https://vault.example.com` 或 `http://192.168.x.x`（留空则插件待配置，不报错） |
| `email` | 登录邮箱。**必须与账号一致**——它是 KDF 的盐值 |
| `masterPassword` | 主密码（secret）。用于派生主密钥、解密保险库，只存本机 `settings.yaml` |
| `apiKeyClientId` / `apiKeyClientSecret` | 可选。Bitwarden 网页端 → 账户设置 → 安全 → 密钥；填了走 API 密钥登录，**可绕过两步验证** |
| `websocket` | 启用 WebSocket 实时通知（默认开） |
| `pollIntervalSeconds` | WebSocket 不可用时的轮询间隔（默认 60 秒，最小 5） |
| `cacheMinutes` | 解锁后的内存缓存时长（默认 30 分钟） |
| `deviceIdentifier` | 可选设备标识。官方桌面/浏览器客户端会持久化稳定值；**留空按「服务器+邮箱」确定性派生，不写盘** |
| `accessMode` | 写权限：`readonly`（默认，拒绝写回）/ `auto`（允许 create/update/delete，仅个人条目） |

### 2. 环境变量

`DSH_BITWARDEN_SERVER`、`DSH_BITWARDEN_EMAIL`、`DSH_BITWARDEN_MASTER_PASSWORD`、
`DSH_BITWARDEN_CLIENT_ID`、`DSH_BITWARDEN_CLIENT_SECRET`、`DSH_BITWARDEN_DEVICE_ID`（也接受去掉 `DSH_` 前缀的写法）。

### 3. 组合配置

profile 的 cordis 配置里给插件传入同名字段即可。

## 用法（模型侧）

```
bitwarden_find  { "query": "github" }                  → 条目列表（元信息，无密码）
bitwarden_get   { "id": "…", "field": "password" }     → 用户名 + 密码
bitwarden_get   { "name": "GitHub 工作账号", "field": "totp" } → 当前动态码
bitwarden_status{ "refresh": true }                    → 状态报告（含 liveSync: 模式/连接/最近同步）
bitwarden_sync  { }                                    → 强制重新同步
bitwarden_create{ "name": "新站点", "username": "…", "password": "…" } → 写回（需 accessMode=auto）
bitwarden_update{ "id": "…", "password": "新密码" }     → 改密（需 accessMode=auto）
bitwarden_delete{ "id": "…", "permanent": false }      → 软删/彻底删（需 accessMode=auto）
```

## 用法（人侧）

**设置 → 凭据库**（左栏新增入口）：搜索框（`/` 聚焦、Esc 清空、↑↓ 选择）、条目列表（首字母头像/用户名/URI/收藏/TOTP 徽标）、详情（密码默认掩码可切换、复制按钮、TOTP 倒计时进度条、备注/自定义字段/目录）。Bitwarden 里开了「重新验证」的条目不会自动出明文，需点「确认读取」。

## 对 Bitwarden/Vaultwarden 客户端约定的遵从

- **设备标识**：按「服务器+邮箱」确定性派生（可配置覆盖），不像官方 CLI 那样每次登录新建设备。
- **通知类型**：按官方 `NotificationType` 枚举处理——`LogOut`（会话在别处被注销）会清除本地令牌与缓存，其余类型触发重同步。
- **SignalR 协议**：negotiate → WebSocket（`access_token` 走 query）→ `{"protocol":"json","version":1}` 握手 → type 6 keepalive 应答 → type 1 ReceiveMessage。
- **reprompt**：`reprompt: 1` 的条目不自动返回明文（工具与面板同一规则，`confirm` 才读）。
- **回收站语义**：软删（`deletedDate`）后的条目不进入列表，可 restore；彻底删除走 purge。
- **per-item key**：写回时按官方做法生成 64 字节条目密钥，字段用条目密钥、`cipher.key` 用用户密钥包裹（类型 2 EncString）。
- **限流**：429 时按官方客户端的退避思路重试一次。

## 安全说明

- 主密码、用户密钥、解密后的条目**只存在内存**，不写盘、不打日志；插件只持久化用户填写的配置。
- 同源 HTTP API 只接受**本机回环**请求（web server 自身不带鉴权，路由自担请求策略）。
- 工具返回的明文凭据会进入会话上下文（这是"让模型能用密码"的前提）。提示词要求模型不要回显、不要写入文件。
- 写回默认关闭（`accessMode: readonly`）；开启后也只能写个人条目，组织条目明确报错。
- 与本地 `dsh-vault` 插件**无标识冲突**（条目 id / 工具名 / 设置命名空间 / 设置页 id 均不同）：本插件是 `dsh-vaultwarden` ↔ `bitwarden_*` ↔ `bitwarden` ↔ `vaultwarden`，dsh-vault 是 `vault` ↔ `vault_*` ↔ `settings.vault` ↔ `vault`。

## 排错

| 现象 | 处理 |
| --- | --- |
| `凭据库尚未配置完整` | 在设置卡片补 `serverUrl` + `email` + `masterPassword`（或 API 密钥） |
| `登录失败：Username or password is incorrect` | 核对 `email`（必须与登录账号一致）与主密码 |
| `该账户启用了两步验证` | 改用 API 密钥登录（client_id/client_secret） |
| `该账户使用 Argon2id KDF` | 插件目录执行 `npm install hash-wasm`；或网页端把 KDF 改为 PBKDF2-SHA256 |
| `无法连接 …` | 检查地址/端口/证书与网络可达性；自签证书需换成受信任证书 |
| 实时同步不生效 | `bitwarden_status` 看 `liveSync.mode`：`polling` 说明 WebSocket 没通（反代需放行 `Upgrade`/`Connection`，或服务器 `ENABLE_WEBSOCKET=false`） |
| 想让模型立刻重试 | `bitwarden_status { "refresh": true }` 或 `bitwarden_sync` |

## 安装

```sh
dsh plugin --profile web add dsh-vaultwarden          # npm（发布后）
dsh plugin --profile web add github:<owner>/dsh-vaultwarden#v0.2.0   # GitHub 源（首次需 allowBuilds）
dsh plugin --profile web add /absolute/path/to/dsh-vaultwarden        # 本地路径（开发）
```

装新 bundle 后可能需要重启 `dsh web` 才会加载；前端半边在页面刷新后出现。

## 测试

```sh
bash scripts/build.sh    # 链接 peer 依赖 + 语法检查 + 五套离线测试
node test/mock-e2e.test.mjs    # 协议/加密/检索/TOTP/刷新/API key（23 项）
node test/live-sync.test.mjs   # WebSocket 握手/推送同步/防抖/LogOut/降级轮询（16 项）
node test/api.test.mjs         # 同源 HTTP API 全路由 + 回环策略（19 项）
node test/mutations.test.mjs   # 写回 增改删恢复 + per-item key 往返（22 项）
node test/client-card.test.mjs # 设置卡片 + 条目面板（37 项，react-test-renderer）
```

mock 服务端（`test/mock-server.mjs`）按 Bitwarden 协议实现了服务端半边（PBKDF2/Argon2id、HKDF、AES-CBC+HMAC、per-item key、组织密钥、SignalR hub），并可选取代官方 `bw` CLI 做跨实现对照。设计说明见 [docs/ui-design.md](docs/ui-design.md)。

## 许可

MIT（保留上游 Jindom/dsh-bitwarden 署名）。
