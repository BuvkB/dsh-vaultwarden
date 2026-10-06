# dsh-vaultwarden — 让每个 DSH 会话实时同步 Vaultwarden 密码库

把自建 **Vaultwarden / Bitwarden** 接入 DeepSeek Harness：任何新建会话（无论 workspace）都会自动知道"密码可以去 Bitwarden 里读"；服务器端任何增删改都会通过 WebSocket **实时**反映到本地，无需手动刷新。

> **独立实现**：直接对接 Bitwarden/Vaultwarden 服务端 REST 与 SignalR 协议，不依赖 `bw` CLI，除可选的 `hash-wasm`（Argon2id KDF）外只用 Node 内置模块。
> 设计过程中参考了两个 MIT 项目，详见文末[「参考与致谢」](#参考与致谢)。

## 界面预览

| 条目列表 | 条目详情（浅色） | 条目详情（暗色） |
| --- | --- | --- |
| ![列表](assets/panel-list.png) | ![详情](assets/panel-detail.png) | ![暗色详情](assets/panel-detail-dark.png) |

> 截图中的条目为演示数据；界面颜色全部取自宿主的 `--dsw-alias-*` 主题 token，因此浅色/暗色下都跟随主题。

## 装了什么

| 能力 | 说明 |
| --- | --- |
| 实时同步引擎 | 登录后订阅 `/notifications/hub`（SignalR over WebSocket），服务器变更即时推送 → 400ms 防抖 → `/api/sync` 重同步 + 解密换缓存（Vaultwarden 的同步接口没有增量参数，只有全量）；WebSocket 不可用（`ENABLE_WEBSOCKET=false`、旧服务器、反代不放行）自动降级为轮询，并**每 30–120 秒自动重试升级回 WebSocket**；429 限流自动退避 |
| 9 个全局工具 | `bitwarden_find`（检索：名称/用户名/URL/备注/自定义字段；默认不含密码，也不含归档与回收站）、`bitwarden_get`（密码/用户名/TOTP/备注/自定义字段/附件名/密码历史/卡片/身份/SSH 密钥）、`bitwarden_status`（配置/连通/解锁/同步模式/归档与回收站条数）、`bitwarden_sync`（强制同步）、`bitwarden_folders`（文件夹 id + 名字 + 条目数）、`bitwarden_restore`（从回收站恢复）、`bitwarden_create`/`bitwarden_update`/`bitwarden_delete`（写回，默认关闭） |
| 系统提示词章节 | 全局注入引导：需要任何账号、密码、API key、token 时先自查凭据库，而不是先问用户 |
| 配置表单 | 由宿主从插件 `Config` schema 派生（设置 → 插件 → bitwarden）：12 个字段（服务器/邮箱/主密码/API 密钥/同步与缓存开关/权限档/会话天数），密钥字段为只写 |
| 条目浏览面板 | 设置 → 凭据库 独立页面：搜索、列表、详情、复制、TOTP 30 秒倒计时、reprompt 条目受保护；五类条目（登录/安全笔记/信用卡/身份/SSH 密钥）各自的详情字段、附件与密码历史折叠区；列表带**回收站 chip + 文件夹筛选 + 归档筛选**（回收站条目划掉显示并带徽标）；`accessMode` 非 readonly 时详情底部出现**写操作**（归档/取消归档、移入回收站、恢复、移动文件夹，逐个二次确认）；同步徽标**可点击手动同步**，悬停显示模式/连接/间隔/上次同步/错误 |
| 认证通道 | 面板经 `/api` connection RPC 取数（`vw/*` 命名空间）——**走操作者已认证会话**，插件不自建 HTTP 路由 |
| 插件列表彩色图标 | 按宿主 artwork 规范提供包根 `icon.svg`（双层盾牌：紫 #6C4DF6 + 蓝 #2E6BE6，白色镂空钥匙孔）；设置页「凭证据库」一行同用盾牌线稿，替换宿主默认齿轮 |

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
| `pollIntervalSeconds` | WebSocket 不可用时的兜底轮询间隔（默认 300 秒，最小 30）。WebSocket 正常时用不到，徽标可点击手动同步 |
| `cacheMinutes` | 解锁后的内存缓存时长（默认 30 分钟） |
| `localCache` | 本地密文缓存（默认开）。把上次同步的密文写到本机，下次启动先出列表、再用 13 字节的账号修订号问服务器变没变；关闭则每次启动都重新全量下载 |
| `deviceIdentifier` | 可选设备标识。官方桌面/浏览器客户端会持久化稳定值；**留空按「服务器+邮箱」确定性派生，不写盘** |
| `accessMode` | 写权限：`readonly`（默认，一律拒绝写回）/ `ask`（每次写回需用户确认）/ `auto`（直接写回）。个人条目与组织条目都可写（创建组织条目传 `organizationId` + `collectionIds`） |
| `sessionDays` | 登录会话保留天数（默认 30，0=每次重登）。**按闲置计时**：期间只要用过一次就自动续期，闲置超期才失效 |

### 2. 环境变量

`DSH_BITWARDEN_SERVER`、`DSH_BITWARDEN_EMAIL`、`DSH_BITWARDEN_MASTER_PASSWORD`、
`DSH_BITWARDEN_CLIENT_ID`、`DSH_BITWARDEN_CLIENT_SECRET`、`DSH_BITWARDEN_DEVICE_ID`（也接受去掉 `DSH_` 前缀的写法）。

### 3. 组合配置

profile 的 cordis 配置里给插件传入同名字段即可。

## 用法（模型侧）

```
bitwarden_find    { "query": "github" }                → 条目列表（元信息，无密码）
bitwarden_find    { "query": "旧", "includeTrashed": true, "includeArchived": true }
                                                       → 连回收站与归档一起列（默认都不列）
bitwarden_get     { "id": "…", "field": "password" }   → 用户名 + 密码
bitwarden_get     { "name": "GitHub 工作账号", "field": "totp" } → 当前动态码
bitwarden_status  { "refresh": true }                  → 状态报告（含 liveSync / 条目/归档/回收站条数 / 最近一次会话事件）
bitwarden_sync    { }                                  → 强制重新同步
bitwarden_folders { }                                  → 文件夹 id + 名字 + 条目数（folderId 从这里来）
bitwarden_create  { "name": "新站点", "username": "…", "password": "…" } → 写回（需 accessMode=ask/auto）
bitwarden_create  { "name": "新站点", "type": "card", "card": { "number": "…" } } → 信用卡/身份/安全笔记/SSH 密钥同理
bitwarden_update  { "id": "…", "password": "新密码" }   → 改密（需 accessMode=ask/auto）
bitwarden_update  { "id": "…", "folderId": null }      → 移出文件夹（不传=不动，传 id=移入）
bitwarden_update  { "id": "…", "archived": true }      → 归档 / false 取消归档
bitwarden_delete  { "id": "…" }                        → 软删进回收站（需 accessMode=ask/auto）
bitwarden_delete  { "id": "…", "permanent": true, "confirm": true } → 彻底删除（不可逆，必须带 confirm）
bitwarden_restore { "id": "…" }                        → 从回收站恢复（需 accessMode=ask/auto）
```

## 用法（人侧）

**设置 → 凭据库**（左栏新增入口）：搜索框（`/` 聚焦、Esc 清空、↑↓ 选择）、筛选行（回收站 chip 带条数 / 文件夹 / 归档三档：含归档·只看归档·隐藏归档；改动任一档立即重查，右侧出现「清除筛选」）、条目列表（首字母头像/用户名/URI/收藏/TOTP 徽标；归档条目带「已归档」徽标，回收站条目名称划掉并带「回收站」徽标）、详情（密码默认掩码可切换、复制按钮、TOTP 倒计时进度条、备注/自定义字段/目录；附件与密码历史各自折叠；按类型显示卡片/身份/SSH 密钥字段）。Bitwarden 里开了「重新验证」的条目不会自动出明文，需点「确认读取」。

`accessMode` 为 `ask`/`auto` 时，详情底部多出「操作」区：归档 / 取消归档、移入回收站、恢复、移动到文件夹——每个操作都要再点一次「确认」，并在确认框里注明**面板操作不受 accessMode 门禁保护，请谨慎操作**（面板走的是已认证会话 RPC，没有逐次审批弹窗；模型工具的 `ask` 审批不受影响）。`readonly` 档下这些按钮不渲染，只显示一行说明。文件夹筛选只作用于当前页面已取到的条目，搜索与分页仍在整个库上跑。

## 对 Bitwarden/Vaultwarden 客户端约定的遵从

- **设备标识**：按「服务器+邮箱」确定性派生（可配置覆盖），不像官方 CLI 那样每次登录新建设备。
- **通知类型**：按官方 `NotificationType` 枚举处理——`LogOut`（会话在别处被注销）会清除本地令牌与缓存，其余类型触发重同步。
- **SignalR 协议**：negotiate → WebSocket（`access_token` 走 query）→ `{"protocol":"json","version":1}` 握手 → type 6 keepalive 应答 → type 1 ReceiveMessage。
- **reprompt**：`reprompt: 1` 的条目不自动返回明文（工具与面板同一规则，`confirm` 才读）。
- **回收站语义**：软删走 `PUT /api/ciphers/{id}/delete`（写 `deletedDate`），彻底删除走 `DELETE /api/ciphers/{id}`；`POST /delete` 在服务端是彻底删除，插件不再使用。回收站条目默认不列出，`includeTrashed` 可看，`bitwarden_restore` 恢复。
- **归档语义**：`archivedDate` 存在即归档；搜索默认排除，`includeArchived` 可看；写回不带该字段会被服务端解释为取消归档，所以插件原样带回。
- **per-item key**：**更新复用条目原有的 64 字节密钥**（只对本次变更的字段重新加密），创建时才新生成一把；`cipher.key` 用用户密钥或组织密钥包裹（类型 2 EncString）。这样改密不会连带抹掉通行密钥、密码历史、URI 匹配策略这些插件不认识的字段。
- **并发保护**：写回带 `lastKnownRevisionDate`；服务端发现条目已被其他客户端改过时返回 400，插件回「条目已被其他客户端修改，请重新读取后再试」。
- **组织条目**：创建走 `POST /api/ciphers/create`（带 `collectionIds`），字段用组织密钥包裹；更新复用组织密钥与条目原 key。
- **限流**：429 时按官方客户端的退避思路重试一次。

## 安全说明

- 主密码、用户密钥、解密后的条目**只存在内存**，不写盘、不打日志；插件只持久化用户填写的配置。
- 落盘缓存里放的是**服务器原样返回的密文**（`~/.dsh/data/dsh-vaultwarden/vault-cache.json.gz`，gzip 压缩、权限 `0600`），插件自己不解密也不落明文；解密只在内存里发生。
- 配置表单由宿主从插件 `Config` schema 派生（设置 → 插件 → bitwarden）；面板数据走 `/api` connection RPC（已认证会话），**没有绕过鉴权的自建路由**。
- 工具返回的明文凭据会进入会话上下文（这是"让模型能用密码"的前提）。提示词要求模型不要回显、不要写入文件。
- 写回默认关闭（`accessMode: readonly`）；`ask` 档每次写入都走 DSH 审批确认，`auto` 直接写入。个人条目与组织条目都支持；彻底删除必须显式带 `confirm: true`，避免一次调用不可逆地抹掉条目。
- 落盘缓存带 HMAC-SHA256 签名（密钥 `~/.dsh/data/dsh-vaultwarden/cache.key`，`0600`）：签名不符、账号不匹配或没有密钥的缓存一律丢弃重下，防止把别处的缓存文件当成自己的读进来。
- 与本地 `dsh-vault` 插件**无标识冲突**（条目 id / 工具名 / 设置命名空间 / 设置页 id 均不同）：本插件是 `dsh-vaultwarden` ↔ `bitwarden_*` ↔ `bitwarden` ↔ `vaultwarden`，dsh-vault 是 `vault` ↔ `vault_*` ↔ `settings.vault` ↔ `vault`。

## 排错

| 现象 | 处理 |
| --- | --- |
| `凭据库尚未配置完整` | 在设置卡片补 `serverUrl` + `email` + `masterPassword`（或 API 密钥） |
| 面板停在「尚未配置完成」、只有「重试」按钮 | 0.2.1 及更早的全新安装会如此（`vw/config` 被 `sessionPersistence` 拖垮）。升级到 0.2.2，或先在 设置 → 插件 → dsh-vaultwarden 的配置卡片里手填三项，面板随即恢复 |
| `登录失败：Username or password is incorrect` | 核对 `email`（必须与登录账号一致）与主密码 |
| `该账户启用了两步验证` | 改用 API 密钥登录（client_id/client_secret） |
| `该账户使用 Argon2id KDF` | 插件目录执行 `npm install hash-wasm`；或网页端把 KDF 改为 PBKDF2-SHA256 |
| `无法连接 …` | 检查地址/端口/证书与网络可达性；自签证书需换成受信任证书 |
| 实时同步不生效 | `bitwarden_status` 看 `liveSync.mode`：`polling` 说明 WebSocket 没通（反代需放行 `Upgrade`/`Connection`，或服务器 `ENABLE_WEBSOCKET=false`） |
| 想让模型立刻重试 | `bitwarden_status { "refresh": true }` 或 `bitwarden_sync` |

## 兼容性

插件声明了四条 **peer 依赖**，全部标记为 `optional`（由宿主提供，npm 不会去装）：

| peer | 范围 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-tools` | `^0.1.0-0 \|\| ^0.1.1-0 \|\| ^0.1.2-0 \|\| ^0.1.3-0 \|\| ^0.1.5-0 \|\| ^0.1.6-0 \|\| ^0.1.7-0 \|\| ^0.2.0-0` | `defineTool` |
| `@deepseek-ai/dsh-typert-protocol` | 同上 | `Remote` / `TypertRemoteService` |
| `@deepseek-ai/schemastery` | `^3.18.0 \|\| ^3.18.1-0` | `Config` schema |
| `@deepseek-ai/cordis` | `>=4.0.1-rc.1 <5` | 宿主内核（插件由宿主注入，不自行安装） |

**支持范围：DSH 0.1.0 线到 0.2.x**（含全部已发布的预发布构建），拒绝 `0.0.1-rc.*` 与 `0.3.0` 及以上。实际验证环境为 **DSH 0.2.0-rc.1 / `@deepseek-ai/dsh-tools` 0.2.0-rc.2**。

> ⚠️ **为什么范围要写成这样**：npm 的预发布规则是「只有范围里*某个*比较符与该版本的 `major.minor.patch` 元组完全一致、且自身带预发布标签时，该预发布版本才被放行」。而 DSH 发布到 npm 的构建**全部带预发布标签**，所以看似合理的 `>=0.1.0-rc.1 <0.3.0-0` 实际只会放行 30 个已发布 `dsh-tools` 构建中的 5 个——包括把用户自己的运行时挡在外面，`npm install` 直接 `ERESOLVE`。宿主的加载闸门用的是 `{ includePrerelease: true }`，因此这个问题**在加载时不会暴露**，只在 npm 安装路径上炸。
>
> `test/peer-ranges.test.mjs` 会拿 `npm view <pkg> versions` 的版本清单逐个核对四条范围：对旧范围报 13 处失败，对当前范围全绿。换 harness 版本后请同步更新该文件里的清单。

## 安装

```sh
dsh plugin --profile web add dsh-vaultwarden          # npm（发布后）
dsh plugin --profile web add github:<owner>/dsh-vaultwarden#v0.5.0   # GitHub 源（首次需 allowBuilds）
dsh plugin --profile web add /absolute/path/to/dsh-vaultwarden        # 本地路径（开发）
```

装新 bundle 后可能需要重启 `dsh web` 才会加载；前端半边在页面刷新后出现。

## 测试

```sh
bash scripts/build.sh    # 链接 peer 依赖 + 语法检查 + 十三套离线测试（共 582 项）
```

| 套件 | 覆盖 |
| --- | --- |
| `test/peer-ranges.test.mjs`（31） | peer 范围 vs npm 已发布构建；拒绝 0.0.1 线 / 0.3.0+ / 错误包名 |
| `test/mock-e2e.test.mjs`（41） | 协议 / 加密 / 检索 / TOTP / 令牌刷新 / API key / 两步验证 |
| `test/kdf-units.test.mjs`（13） | KDF 单位与已知向量：Argon2id 的 `kdfMemory`（MiB）必须换算成 hash-wasm 的 KiB、PBKDF2 迭代数被尊重、邮箱盐归一化；固定摘要同时锁住「正确单位」与「旧错误单位」，mock 与客户端同错时也能报警 |
| `test/live-sync.test.mjs`（17） | WebSocket 握手 / 推送同步 / 防抖 / LogOut / 降级轮询 / 升级回退 |
| `test/mutations.test.mjs`（38） | 写回增改删恢复 + per-item key 往返；五类条目（登录/安全笔记/信用卡/身份/SSH 密钥）的创建与更新、组织条目更新、软删/恢复/彻底删除的确认、旧版账号键条目的写回 |
| `test/write-back.test.mjs`（46） | **P0/P1 回归**：软删端点与回收站可见性、写回字段保真（通行密钥 / 密码历史 / URI 匹配策略 / 附件 / 归档日期 / 原 key 不轮换）、并发 400 翻译、文件夹三态、归档开关、面板列表缓存 |
| `test/cache-store.test.mjs`（69） | 密文落盘缓存的写入/权限/账号校验/7 天信任窗口 + 修订号探针快路径（探针失败退回全量、关开关不落文件） |
| `test/session-resilience.test.mjs`（22） | 换令牌失败的分级：断网 / 429 / 5xx 保留会话与 refresh token 且不发密码授权，网络恢复后静默续上；只有服务器明确拒绝（`invalid_grant`）才清盘 |
| `test/host-entry.test.mjs`（27） | Host 入口 `apply()` + Remote 网关线面（含 SRC 签名约束）+ 插件列表图标契约（`icon.svg` 资产、1024 画布、蓝底圆角块、白色镂空盾牌与键孔） |
| `test/gateway-flow.test.mjs`（67） | 登录全链路：错密码 / 2FA 挑战 / 换码重试 / 会话持久化 / `vw/boot` 静默恢复与：aged token 静默换新、旧会话不被重登删掉 / **读参数透传**（归档与回收站开关真正传到后端、回收站条目要 `includeTrashed` 才能读、`vw/folders` 返回解析后的对象）/ 写参数透传（归档、软删、恢复走通网关） |
| `test/access-mode.test.mjs`（17） | readonly / ask / auto 三档权限 |
| `test/client-card.test.mjs`（194） | 条目面板 + **筛选行**（回收站 chip 计数与勾选、文件夹与归档筛选、清除筛选）+ **写操作**（归档/移入回收站/移动到文件夹与恢复的二次确认、`readonly` 档只读说明、回收站条目要 `includeTrashed`）+ **五类条目详情**（卡片掩码、身份字段、SSH 密钥、附件与密码历史折叠区）+ 徽标手动同步 + 重开缓存 + **localStorage 快照**（重载先绘制、未登录即清）+ **旧宿主回退**（`vw/boot` 按网关错误码识别；拒绝分页参数改整表读取并被记住；满 200 上限截断改诚实提示且不再重试）+ **分页游标校准**（宿主窗口漂移不重复行、废弃列表的迟到页不回灌）+ **两处竞态回归**（换条目后迟到的「确认读取」答复不得画进新条目、被放弃查询的迟到行不得覆盖新查询也不得写进快照）（react-test-renderer + RPC 桩） |

另有一套 `test/cli-interop.mjs`：与官方 `bw` CLI 做跨实现对照，未安装 `bw` 或 `openssl` 时自我跳过（退出码 0）。

mock 服务端（`test/mock-server.mjs`）按 Bitwarden 协议实现了服务端半边（PBKDF2/Argon2id、HKDF、AES-CBC+HMAC、per-item key、组织密钥、SignalR hub、两步验证），可选取代官方 `bw` CLI 做跨实现对照。它的写入分支按 Vaultwarden 1.37.3 的实际语义实现：`PUT /ciphers/{id}` 整条替换、`POST /delete` 彻底删、`PUT /delete` 软删、`PUT /restore` 恢复、附件不在请求里就不动——mock 与真实服务端语义不一致时，测试会把错误当成正确固化下来（0.3.2 那次 Argon2 单位故障就是这样发生的）。设计说明见 [docs/ui-design.md](docs/ui-design.md)。

## 登录与会话

### 为什么要输两次（密码 + 验证码）

Vaultwarden 的两步验证是**两步**：先验证主密码，再提交动态码。插件严格按这个顺序来——密码错误会停在表单并报错，**只有密码验证通过后**才进入验证码界面。

### 免密登录（推荐）

`sessionDays` 默认 **30 天**，且**按闲置计时**：登录一次后，令牌（含 refresh token 与派生主密钥）会加密保存在 `~/.dsh/data/dsh-vaultwarden/session.json`（权限 `0600`，仅本人可读）。期间只要用过一次密码库，有效期就自动往后滑；**闲置超过 30 天才失效**。所以正常情况下，插件重启、DSH 重启都不需要你再输密码——除非真的 30 天没用过。

设为 `0` 可关闭持久化，每次都重新登录。

> ⚠️ 该文件等同于主密码的保护级别：能读到它就能解密保险库。这与插件已把 `masterPassword` 存在 profile 配置里（为了能无人值守解锁）是同一权衡，官方客户端的「记住我 / PIN 解锁」也是同样取舍。

### 静默恢复：开面板不再要一遍密码

登录信息会**加密落盘**（`~/.dsh/data/dsh-vaultwarden/session.json`，`0600`，其中含 refresh token；access token 只有 1 小时寿命）。
插件开面板（以及每次启动预热）时先**静默恢复**：读盘 → access token 还在 → 直接用；
access token 过期了 → 用 refresh token 换一张新的。**全程不会自动登录，所以不会弹两步验证**。
弹登录表单只剩三种情况：盘上真的没有会话（首次配置、登出过、或闲置超过 `sessionDays`）、
refresh token 被服务器**明确拒绝**（换机改密等），或者磁盘上的会话文件损坏/版本不符。

> 0.2.5 之前这里有两个 bug：access token 1 小时一过，面板就以为你被登出了；
> 而「用同一套账号密码点验证并登录」会先把盘上会话删掉再登，逼着你重输密码+验证码。
> 0.3.1 之前还有第三个：**换令牌时只要失败就删会话**——断网、429 限流、5xx 都算，
> 于是一次网络抖动就丢掉整份会话，下次打开只能重输主密码+验证码。
> 现在只有服务器明确拒绝（`invalid_grant` / 401）才删；网络类失败原样保留，网络一恢复就静默续上。
> 若确实被拒绝，面板的状态接口会给出 `lastSessionLoss`，说明是哪次、为什么丢的。

### 秒开：先绘制，再请求

开面板时面板**先把上一次成功的列表画出来**（内存缓存 + `localStorage` 快照，5 分钟内有效），
再向宿主要最新数据；快照只含列表本来就显示的内容（名称/类型/用户名/URI/目录/徽标），**不含密码与动态码**，
并按「服务器 + 邮箱」绑定——换了账号不会看到别人的条目。一旦宿主报告你已登出，快照立即清除。
宿主侧同样做了减法：开面板改为一次 `boot` RPC（配置 + 会话 + 是否恢复），列表与状态两个请求并行发出；
插件激活时还会在后台预热会话与解密缓存，重启 dsh 后第一次开面板也不用等全量同步。
实测（mock 服务端）：一次登录 + 两次「重启」后开面板，**0 次密码授权、0 次两步验证、0 次 refresh**，列表 4–11 ms 返回。
列表也改为渐进加载：首屏一次只取 50 条（`PAGE_SIZE`），向下滚动自动续读下一页；只有滑得比加载快时，尾部才出现「还有 N 条，点击继续显示」按钮兜底。宿主不接受分页参数（descriptor 未声明 `offset`，网关直接拒绝）时自动回退为整表读取，上限 200 与旧版一致，且这次拒绝会被记住——下次打开直接整表读取。整表读取被上限截断时不再给出点了没有反应的按钮，而是就地提示「本机只同步到 200/总数 条，其余请在 Bitwarden 网页端查看」。续读位置以宿主报告的窗口为准：某页比请求的偏移晚到（上游新增使窗口漂移）时按宿主报告的端点续读，重复行去重后不会漏行。

### 密文落盘缓存：冷启动不再全量下载

0.3.0 起，每次成功同步后插件会把**服务器原样返回的密文**（gzip 后约为原体积的 1/3）写到 `~/.dsh/data/dsh-vaultwarden/vault-cache.json.gz`（权限 `0600`，原子写入）。下次冷启动先读这份缓存立刻出列表，同时用 `GET /api/accounts/revision-date` 问一次服务器（响应仅 13 字节）：

- **修订号没变** → 本次启动不再下载，省掉约 660 KB 的 `/api/sync`；
- **修订号变了** → 后台全量同步一次并刷新缓存，界面先显示旧数据、随后无缝换成新的；
- **探针失败 / 缓存损坏 / 换了账号** → 自动退回全量下载，行为与旧版一致。

两条兜底：缓存超过 **7 天**未更新时，即使探针说没变也强制全量同步一次（防上游遗漏修订号更新的边缘路径）；登出、切换账号、关掉 `localCache` 都会立即清掉缓存文件。

### 通行密钥（passkey / WebAuthn）不支持

Vaultwarden 的通行密钥是一种 **2FA 方式**，但它必须由**浏览器调用 `navigator.credentials` 并配合认证器上的用户手势**（指纹/面容/PIN）才能完成——这是 WebAuthn 防自动化的核心设计。插件运行在无头 Node 进程中，**没有浏览器和认证器，物理上无法完成这个仪式**，因此不支持，未来也不会支持。

**替代方案**：改用 **API 密钥**登录（`apiKeyClientId` = `user.<uuid>` + `apiKeyClientSecret`）。Vaultwarden 的 API 密钥**直接绕过 2FA**（服务端 `user_api_key_login` 不调用 `twofactor_auth`），配合上面的会话持久化，基本可以做到永久免密。

在面板的登录表单里把「登录方式」切到 **API 密钥**即可填写这两个字段（宿主的插件配置页同样可以填）。密钥在 Vaultwarden 网页端 **设置 → 安全 → 密钥** 获取。

> 注意：API 密钥只解决**登录**，不解决**解密**——保险库是用主密码派生的密钥加密的，所以 `masterPassword` 仍然必填。API 密钥省掉的是验证码，不是主密码。

## 参考与致谢

本项目为独立实现，设计与实现过程中参考了以下两个 MIT 项目：

| 项目 | 本项目参考之处 |
| --- | --- |
| [Jindom/dsh-bitwarden](https://github.com/Jindom/dsh-bitwarden) | DSH 凭据插件的最小骨架、系统提示词注入思路、mock 服务端测试方法论 |
| [Ox0400/dsh-vault](https://github.com/Ox0400/dsh-vault) | `--dsw-alias-*` 主题 token 用法、设置页面板的视觉与交互基线 |

在此致谢。两者的 MIT 许可与版权声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 许可

MIT，详见 [LICENSE](LICENSE)。
