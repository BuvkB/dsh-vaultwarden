# dsh-bitwarden — 让每个 DSH 会话自带凭据库

把自建 **Vaultwarden / Bitwarden** 接入 DeepSeek Harness：任何新建会话（无论 workspace）
都会自动知道"密码可以去 Bitwarden 里读"，无需用户每次提醒；主密码等凭据在 DSH 设置里填一次即可。

## 装了什么

| 能力 | 说明 |
| --- | --- |
| 设置卡片 | 设置 → 插件 → 插件配置 里的 Bitwarden 卡片（主密码只写、保存即生效） |
| 三个全局工具 | `bitwarden_find`（检索条目，不含密码）、`bitwarden_get`（取密码/用户名/TOTP/自定义字段）、`bitwarden_status`（配置/连通/解锁状态） |
| 系统提示词章节 | 全局注入一段简短引导，要求模型在需要任何账号、密码、API key、token 时**先自查凭据库**，而不是先问用户 |
| 配置项 `bitwarden` | 在 DSH 设置 → 插件 中渲染成表单；主密码 / API 密钥字段标记为 secret（走网络时不回传明文、只写不读） |

插件直连服务器 REST API（`/identity/accounts/prelogin`、`/identity/connect/token`、`/api/sync`），
不依赖 `bw` CLI，也不额外安装运行时依赖；除可选的 `hash-wasm`（Argon2id KDF）外全部使用 Node 内置模块。

## 配置

三种方式，优先级从高到低：**用户设置（GUI/settings.yaml）→ 插件组合配置 → 环境变量 → 默认值**。

### 1. DSH 设置界面（推荐）

**设置 → 插件 → 插件配置 → Bitwarden / Vaultwarden 凭据库**：插件自带前端卡片，
填完点"保存"立即生效（无需重启）。主密码与 API 密钥是**只写字段**——保存后不会再回传浏览器，
输入框留空表示不修改。

> 卡片由插件的浏览器半边（`lib/client.js`）提供；若刚注入/重载后没看到卡片，
> 刷新一次页面（F5）即可，之后随启动图自动加载。

字段：

| 字段 | 说明 |
| --- | --- |
| `serverUrl` | 服务器地址，默认 `https://bitwarden.jindom.cc`；也可填 `http://192.168.88.101` |
| `email` | 登录邮箱。**必须与账号一致**——它是 KDF 的盐值 |
| `masterPassword` | 主密码（secret）。用于派生主密钥、解密保险库，只存在本机 `settings.yaml` |
| `apiKeyClientId` | 可选。Bitwarden 网页端 → 账户设置 → 安全 → 密钥 的 `client_id`（`user.<uuid>`）。填了就走 API 密钥登录，**可绕过两步验证** |
| `apiKeyClientSecret` | 可选。上面的 `client_secret`（secret） |
| `cacheMinutes` | 解锁后的内存缓存时长，默认 30 分钟；到期后自动重新同步 |

配置文件位置：`$DSH_HOME/settings.yaml`（本机为 `/dsh-home/settings.yaml`）。

### 2. 环境变量

`DSH_BITWARDEN_SERVER`、`DSH_BITWARDEN_EMAIL`、`DSH_BITWARDEN_MASTER_PASSWORD`、
`DSH_BITWARDEN_CLIENT_ID`、`DSH_BITWARDEN_CLIENT_SECRET`（也接受去掉 `DSH_` 前缀的写法）。

### 3. 组合配置

在 profile 的 cordis 配置里给插件传入同名字段即可（作为 settings 的 base 层）。

> 开了两步验证（2FA）的账号：密码授权会被服务器拒绝。此时填 `apiKeyClientId` / `apiKeyClientSecret`
> 走 API 密钥登录即可（主密码仍要填，用于解密保险库）。

## 用法（模型侧）

```
bitwarden_find  { "query": "github jindom" }        → 条目列表（id/名称/用户名/网址，无密码）
bitwarden_get   { "id": "…", "field": "password" }  → 用户名 + 密码
bitwarden_get   { "name": "GitHub 工作账号", "field": "totp" } → 当前 6/8 位动态码
bitwarden_status{ "refresh": true }                 → 丢缓存重新登录同步 + 状态报告
```

`bitwarden_get` 的 `field` 可选：`all`（默认）、`password`、`username`、`totp`、`notes`、`fields`。
名称不唯一时会报 `ambiguous` 并提示改用 `id`。

## 安全说明

- 主密码、用户密钥、解密后的条目**只存在内存**，不写盘、不打日志；插件只持久化用户填写的配置。
- 工具返回的明文凭据会进入会话上下文（这是"让模型能用密码"的前提）。提示词要求模型不要回显、
  不要写入文件；如需更严格，可只用 `field: "password"` 做窄查询。
- 服务器证书必须受信任（本机 Node 的 CA 策略）；自签证书需要在服务器侧换成受信任证书。

## 排错

| 现象 | 处理 |
| --- | --- |
| `凭据库尚未配置完整` | 在设置里补 `email` + `masterPassword`（或 API 密钥） |
| `登录失败：Username or password is incorrect` | 核对 `email`（必须与账号一致）与主密码 |
| `该账户启用了两步验证` | 改用 API 密钥登录 |
| `该账户使用 Argon2id KDF` | 插件目录执行 `npm install hash-wasm`；或网页端把 KDF 改为 PBKDF2-SHA256 |
| `无法连接 …` | 检查地址/端口/证书与网络可达性（本机需能访问 `https://bitwarden.jindom.cc` 或 `192.168.88.101`） |
| 想让模型立刻重试 | `bitwarden_status { "refresh": true }` |

## 装配方式（重要）

本插件以 **profile bundle** 装配（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` 的 insert 条目，
profile `bundles` 里列出包名，`dependencies` 用 `link:` 指向本目录）。

> ⚠️ **同一插件只能有一条装配路径**：已经这样装配的包，**不要**再用注入器的 `dev_inject_plugin` 运行时装一次
> ——同一 package 出现两个活跃 Loader 源，`client-modules` 会在启动期以组合错误拒绝启动
> （详见 `.incident-2026-09-15/README.md`）。热更代码用 `dev_reload_package` 即可，它作用于同一个 entry。

前端半边约定：客户端模块表按 `factory(require) → exports` 记忆化，**factory 必须 return 导出对象**。

## 开发

```bash
bash scripts/build.sh     # 链接 peer 依赖 + 语法检查 + 可选 hash-wasm + 离线端到端测试
node test/mock-e2e.test.mjs
```

三套验证，都可离线运行：

1. **`test/mock-e2e.test.mjs`（23 项）** — 起一个 mock Vaultwarden（服务端同样实现 Bitwarden 的
   PBKDF2 / HKDF-Expand / AES-CBC+HMAC EncString、RSA-OAEP 组织密钥、per-item key、legacy type-0 密文），
   验证登录、同步、解密、检索、TOTP（RFC 6238 标准向量）、token 刷新、API 密钥登录、
   32 字节 v2 用户密钥、不可解密组织条目的降级与全部错误路径。

2. **`test/cli-interop.mjs`（9 项，跨实现对照）** — 让**官方 Bitwarden CLI** 登录同一个 mock：
   CLI 登录成功 ⇒ 我们算出的主密码哈希 / KDF 与官方实现一致；CLI 能解开我们产出的密文
   （条目名、账号密码、TOTP URI、自定义字段、备注、目录、RSA 组织密钥）⇒ HKDF 拉伸与
   EncString 线格式与官方实现一致。缺 CLI / openssl 时自动跳过。

3. **`test/client-card.test.mjs`（19 项）** — 按浏览器模块加载器的真实格式加载 `lib/client.js`
   （`window.__ModuleLoader__.load({id, factory})` + CJS 包装），跑 `apply` 并挂载注册到
   `settings.plugin.item` 的设置卡片：渲染 6 个字段、密码框不回显、只保存改动项、
   清除覆盖、命名空间不可用时的降级。缺 react 时自动跳过。

```bash
# 官方 CLI 互操作（可选）：
npm install --prefix /tmp/bwcli-install @bitwarden/cli@2024.9.0
BW_CLI=/tmp/bwcli-install/node_modules/.bin/bw node test/cli-interop.mjs
```
