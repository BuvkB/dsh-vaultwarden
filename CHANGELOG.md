# Changelog

All notable changes to `dsh-vaultwarden` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-10-06

v0.4.0 攒下的读写能力搬进面板：条目页能归档、移入回收站、恢复、移动文件夹，列表页有回收站与归档筛选，详情页补齐五类条目的投影。

### 新增

- **面板写操作（归档/取消归档、移入回收站、恢复、移动文件夹）**：详情页新增「操作」区，按条目当前状态给按钮——普通条目给归档、移入回收站、移动文件夹，归档条目给取消归档，回收站条目只给恢复。每个动作都过一道确认框，框内固定写着「面板操作不受 accessMode 门禁保护，请谨慎操作。」；`readonly` 档不显示任何按钮，只留一行说明。写操作进行中/完成/失败各有一行状态，失败按 `stale_revision` 等错误码翻译。
- **回收站独立入口**：列表上方新增筛选行，「回收站 {n}」chip 显示回收站条数（来自 `vw/status`），点开后软删条目排到列表最前、条目名划掉并带「回收站」徽标；选中后可查看内容并就地恢复。回收站为空、筛选无结果各有专门的空态提示。
- **文件夹与归档筛选**：筛选行里还有文件夹下拉（全部文件夹/未归类/各文件夹）与归档三档（含归档/只看归档/隐藏归档），改动即重查；任一筛选生效时出现「清除筛选」。文件夹筛选只过滤已取回的这一窗条目，不改变宿主侧的分页游标。
- **五类条目详情投影**：信用卡（卡号掩码、持卡人、品牌、有效期、安全码）、身份信息（姓名/邮箱/电话/地址）、SSH 密钥（公钥与指纹明文，私钥掩码可显示）；带通行密钥的条目显示「含通行密钥」徽标。
- **附件与密码历史折叠区**：附件列出文件名与大小（只显示信息，不下载内容）；历史密码按最近使用时间列出，不显示明文。
- **回收站横幅与会话事件行**：回收站条目的详情页顶部有「该条目在回收站中（软删除）」横幅；同步徽标悬停详情新增一行后台会话事件（重新登录/被拒/需两步验证），不再只有 token 倒计时。

### 修复

- **`vw/folders` 返回未解析的 JSON 字符串**：`VaultGateway.folders()` 把 `folderList()` 的 JSON 文本原样透传给调用方。v0.4.0 起一直没有消费方所以没暴露；面板文件夹筛选是第一个消费方，顺手修掉。

### 变更

- **网关读参数透传**：`vw/list` 增加 `includeArchived` / `includeTrashed`（缺省仍含归档），`vw/reveal` 增加 `includeTrashed`。回收站条目此前只能靠 `vw/status` 的计数看到，现在能直接读、能恢复。
- **`findEntries` 支持回收站**：`options.includeTrashed` 参与结果合并与记忆键；回收站条目排在结果最前，空查询时不会落到第一页之外。

### 测试

- `test/client-card.test.mjs` 145 → 194 项：筛选行（chip 计数与勾选、文件夹与归档筛选、清除筛选）、写操作全链路（确认框文案、`archived`/`folderId`/软删参数、回收站条目 `includeTrashed`、`readonly` 只读说明）、五类条目详情与折叠区。
- `test/gateway-flow.test.mjs` 52 → 67 项：读/写参数透传（归档与回收站开关真正到达后端、回收站条目要 `includeTrashed` 才能读、`vw/folders` 返回解析后的对象、软删与恢复走通网关）。
- `test/host-entry.test.mjs` 线面方法白名单 16 → 19（补 `boot`/`restore`/`folders`）。
- 十三套离线测试共 582 项全部通过。

## [0.4.0] — 2026-10-06

实现《dsh-vaultwarden 缺失功能优先级排序》里的全部 6 项 P0 与 8 项 P1：写回不再丢字段，删除链路可回滚，回收站有出口，写回带并发保护，五类条目都能读写，文件夹 id 可见可清。

### 修复

- **软删实际是彻底删除（P0）**：`remove()` 的非 permanent 分支原来请求 `POST /api/ciphers/{id}/delete`——在 Vaultwarden 里这是**彻底删除**，条目从数据库直接消失，插件却回复"已进入回收站"。现在软删改走 `PUT /api/ciphers/{id}/delete`；`permanent: true` 走 `DELETE` 且必须同时传 `confirm: true`，否则拒绝并在响应里说明。`test/mock-server.mjs` 同步改成分支语义（它此前把 POST 实现成软删，正是这条错误一直没被测试发现的原因）。
- **写回静默丢字段（P0）**：写回改为**复用条目原有的 item key**，只对本次变更的字段重新加密，其余键原样带回——`login.fido2Credentials`（通行密钥）、`passwordHistory`、`login.passwordRevisionDate`、`login.uri`（单数旧字段）、`uris[].match` 匹配策略、`archivedDate`、附件元数据都不再丢。此前任何一次改密都会顺手抹掉前五类数据，且没有任何提示。
- **写回覆盖并发修改（P0）**：PUT 现在带 `lastKnownRevisionDate`；服务端发现条目已被其他客户端改过时返回 400，插件翻译成"条目已被其他客户端修改，请重新读取后再试"（`stale_revision`）。
- **非 login 类型不能读写（P0）**：`type` 不再硬编码为 1，支持 `secureNote`/`card`/`identity`/`sshKey` 的创建与更新，读侧同步投影这四类内容。安全笔记的 `type` 是明文 JSON 而不是 EncString，按官方格式单独处理（加密它会让官方客户端读到乱码）。
- **文件夹 id 出不来、清不掉（P0）**：列表投影 `folderId`，新增 `bitwarden_folders`（id + 名字 + 条目数 + 未归类条数）；`folderId` 三态——不传=不动、传 id=移入、传 `null` 或空串=移出（原来的 `??` 回退让"移出"永远失败）。
- **回收站没有出口（P0）**：`bitwarden_find`/`bitwarden_get` 加 `includeTrashed`，`bitwarden_status` 报回收站与归档条数，新增 `bitwarden_restore` 工具与 `vw/restore` RPC。后端 `restore()` 早已实现，只是没有暴露。
- **归档条目混在正式列表里（P1）**：投影 `archived`；`bitwarden_find` 默认排除归档并提示"还有 N 条归档"，`includeArchived` 可查；`bitwarden_update` 支持归档/取消归档。此前写回还会把归档条目悄悄拽出归档（服务端把"没带 archivedDate"解释为取消归档）。
- **令牌失效后的后台兜底登录没有状态（P1）**：重新登录成功、失败、被拒绝、需要两步验证都会记录 `lastSessionEvent`，`bitwarden_status` 与面板状态接口都会带上；失败后有 60 秒冷却，不对同一个失效会话反复重试。
- **网关 `configure` 会静默丢掉 `ask` 档**：accessMode 白名单以前内联写成 `readonly || auto`，`ask` 传进来会被忽略；现在统一为 `['readonly', 'ask', 'auto']`。

### 新增

- **`encryptedFor` 写回字段（P1）**：创建与更新都带当前用户 uuid。Vaultwarden main 已把它列为必填（PR #7693），不带的话升级到该版本后所有写回会整条 422。
- **附件与密码历史读取（P1）**：投影 `attachments`（文件名、大小、下载地址，不下载内容）与 `passwordHistory`（含 `lastUsedDate`），并用 `hasFido2` 标记条目是否带通行密钥。
- **组织条目写入（P1）**：创建组织条目传 `organizationId` + `collectionIds` 走 `POST /api/ciphers/create`，字段用组织密钥包裹；更新组织条目复用组织密钥与条目原 key。
- **文件夹工具与回收站/归档开关**：全局工具 7 → 9（新增 `bitwarden_folders`、`bitwarden_restore`）。
- **面板归档徽标**：面板列表保留显示归档条目并带「已归档」徽标（模型侧搜索默认不返回归档）。

### 变更

- **写回权限门禁下沉**：readonly 档的拒绝判断从工具包装层下沉到 `VaultMutations` 的 guard（`write_disabled`），工具层与网关层共用同一个判断；`ask` 档的审批流程不变。
- **落盘缓存加完整性校验**：密文缓存用 HMAC-SHA256 签名（密钥 `~/.dsh/data/dsh-vaultwarden/cache.key`，0600，随机 32 字节），并严格比对服务器地址与邮箱；缓存版本升到 2，未签名、签名不符或账号不匹配的缓存一律丢弃重下。
- **协议事实修正**：Vaultwarden 的 `/api/sync` 没有 `syncToken` 增量（1.37.3 的 `SyncData` 只有 `excludeDomains` 一个参数），"协议支持增量同步"的说法不成立；当前实现是"密文落盘缓存 + 13 字节修订号探针 + 需要时全量下载"。
- **构建脚本修一处漏链**：`scripts/build.sh` 在两处 `npm install` 之后的补链只写了三个包，漏了 `@deepseek-ai/dsh-typert-protocol`；npm 会剪掉不是自己建立的符号链接，于是**全新检出**跑 build.sh 会在 host-entry 套件以 `ERR_MODULE_NOT_FOUND` 中断（本仓库工作区因为第一次链接没被剪过，一直没暴露）。改为把 peer 清单提成 `PEERS` 并用 `relink_peers()` 全量重链。

### 测试

- 新增第十三套离线测试 `test/write-back.test.mjs`（46 项）：软删端点与回收站可见性、字段保真（通行密钥/密码历史/URI 匹配策略/附件/归档日期/原 key 不轮换）、并发 400 的翻译、文件夹三态、归档开关、面板列表缓存。
- `test/mutations.test.mjs` 扩到 38 项：五类条目的创建与更新、组织条目更新、软删/恢复/彻底删除的确认、旧版（账号键）条目的写回。
- `test/mock-server.mjs` 对齐真实服务端语义：`POST /delete` 改回彻底删除，新增 `PUT /delete`（软删）与 `PUT /restore`；PUT 保留请求未带的附件；新增 `richCipher` 夹具（通行密钥/密码历史/匹配策略/附件/归档）。
- 十三套离线测试共 518 项全部通过。

## [0.3.2] — 2026-10-05

### 修复

- **Argon2id 账号永远登录失败（P0）**：`kdfMemory` 的单位是 MiB（Bitwarden/Vaultwarden 默认 64），而 `hash-wasm` 的 `memorySize` 按 KiB 计数。此前把 64 直接当成 64 KiB 交给 KDF，派生出完全错误的主密钥，服务器按「邮箱或主密码不正确」拒绝——用户看到的是密码错，实际是单位错。现在统一 ×1024（`lib/vault.js` 的 `deriveMasterKey`），mock 服务端同步修正，并新增固定向量测试锁死两家单位（见下）。
- **「确认读取」的迟到答复会串条目（P0）**：为条目 B 点「确认读取」后立刻切到条目 A，B 的明文密码会被画进 A 的详情面板，且 `revealed` 标志遗留，A 自己的密码会随后直接显示。详情面板现在按「选中项世代号」判定，迟到的答复（含失败分支）一律丢弃。
- **被放弃的列表查询会覆盖新查询**：快速改搜索词时，先发后到的旧答复会把旧行画上屏幕，首屏还会把这批旧行写进 localStorage 快照。`readVault` 现在在写入 state 前比对世代号，过期答复（含错误分支）直接返回。
- 前端套件在缺少 `react` / `react-test-renderer` 时打印一行「skipping」后以退出码 0 结束，等于把 129 项面板检查静默变成「全绿」。现在报错并非零退出，缺依赖就是失败。

### 测试

- 新增第十二套离线测试 `test/kdf-units.test.mjs`（13 项）：用固定摘要同时锁住 Argon2id 的正确单位（64 MiB 对应 `memorySize: 64 * 1024`）与旧错误单位（64 KiB），并交叉验证 mock 服务端、`hash-wasm` 直接调用与 `node:crypto` 的 PBKDF2 结果。
- `test/client-card.test.mjs` 增加两处竞态回归（129 → 142 项）：换条目后迟到的「确认读取」不得画进新条目、被放弃查询的迟到行不得覆盖新查询也不得写进快照。
- 十二套离线测试共 444 项全部通过。

## [0.3.1] — 2026-10-02

### 修复

- 换令牌失败不再无差别删除会话：只有服务器**明确拒绝** refresh token（`invalid_grant` / 401）才清除盘上会话；断网、超时、429 限流、5xx 一律保留内存令牌与 `session.json`。此前任何一种失败都会删掉整份会话，于是一次网络抖动就导致下次打开必须重输主密码 + 验证码——这就是「重启一次输一次密码」的来源。
- 后台换令牌失败改为向上抛错，不再掉进「用主密码重新登录」：两步验证账号不会因为一次网络错误被拖到验证码界面；网络恢复后下一次使用静默续上。
- 新增会话丢失诊断：会话被服务器拒绝而清除时记录 `lastSessionLoss`（时间、原因、服务器消息），面板状态接口与 `bitwarden_status` 都会带上它，回答「为什么又让我输密码」。

### 测试

- 新增第十一套离线测试 `test/session-resilience.test.mjs`（22 项）：断网 / 429 / 5xx 下 `resumeSession()`、`boot()`、`ensureToken()` 均保留会话与 refresh token、不发密码授权；网络恢复后复用同一 refresh token 静默续上；服务端明确拒绝时才清盘，且之后仍可重新登录。

## [0.3.0] — 2026-10-02

### 新增

- 密文落盘缓存：每次成功同步后，把服务器**原样返回的密文**（不是明文）gzip 后写到 `~/.dsh/data/dsh-vaultwarden/vault-cache.json.gz`（权限 `0600`，先写临时文件再原子改名）。下次冷启动先读这份缓存，列表立刻出来，不必等整份保险库下载完。
- 账号修订号探针：出完缓存后向服务器问一次 `GET /api/accounts/revision-date`（响应只有 13 字节）。**修订号没变就完全不下载**（省掉一次约 660 KB 的 `/api/sync`）；变了才在后台全量同步一次并刷新缓存，界面先显示旧数据、随后无缝换成新的。
- 新设置项 `localCache`（默认开启）：关掉则每次启动都重新全量下载，行为与 0.2.7 一致；登出、切换账号、关闭该开关都会立即删掉缓存文件。
- 缓存信任上限：缓存超过 **7 天**未更新时，即使探针说没变也强制全量同步一次（兜住上游可能漏推修订号的边缘路径）；探针报错、缓存损坏、解密失败一律退回全量下载。
- 状态报告新增 `cached` 与 `cache` 两个字段（是否来自缓存、缓存开关/文件/写入时间/记录的修订号），`syncedAt` 在缓存命中时报告的是缓存写入时间。

### 测试

- 新增第十套离线测试 `test/cache-store.test.mjs`（61 项）：缓存读写与权限、账号/版本/损坏数据的拒绝、7 天信任窗口边界、以及 VaultClient 的完整路径——冷启动写缓存、热启动跳过下载、修订号变化后台补一次、探针失败保留缓存但不再授权快路径、超 7 天强制全量、换账号与登出清文件、关闭 `localCache` 不落文件也不发探针。
- mock 服务端实现 `/api/accounts/revision-date` 路由，并提供 `revision()` / `bumpRevision()` / `failRevision()` 三个测试挂钩。
- 十套离线测试共 396 项全部通过（未安装官方 `bw` CLI 时 `cli-interop` 自跳过）。

## [0.2.7] — 2026-10-01

### 新增

- 条目列表渐进式加载：首屏一次只取 50 条，向下滚动自动续读下一页；滑得比加载快时，尾部出现「还有 N 条，点击继续显示」按钮兜底。宿主不接受分页参数时自动回退为整表读取（上限 200，与旧版一致）。
- 条目列表支持 `offset` 分页参数，`vw/list` 返回 `offset` 与 `hasMore`。

### 修复

- 修掉「点加载点不动」：宿主一次最多取 200 条时，之前给出的「还有 N 条」按钮再点也只会读回同样 200 条。现在改为就地提示「本机只同步到 200/总数 条，其余请在 Bitwarden 网页端查看」，不再提供点了没有反应的按钮。
- 旧宿主不支持分页参数时不再停在「50 行 + 点不动的按钮」，自动回退为整表读取。
- 拒绝分页的宿主会被记住：本次会话内下次打开面板直接整表读取，不再先画 50 行、再被拒、再重画一遍。
- 修复旧宿主上打开面板可能直接报错的问题：现在按网关的错误码判断，能正确回退；宿主明确拒绝调用时仍照常报错。
- 修复分页续读可能错位、漏条目的问题：上游在两页之间新增条目时，续读位置跟住宿主上报的窗口端点。
- 修复面板在续读途中关闭时留下无人回收的读取。

### 测试

- 客户端组件测试覆盖分页场景（129 项，原 85）：首屏 50 行、滚动续读、滑得比加载快时出按钮、旧宿主拒绝分页参数后回退整表、页读失败保留列表、无布局度量时滚动不发请求、窗口漂移时续读不重不漏、废弃列表的迟到页不写入新列表、200 条上限截断时改显示诚实提示且不再重试、拒绝分页的宿主下次打开直接整表、无此方法与拒绝调用的边界。
- mock-e2e 新增分页断言（41 项，原 38）；gateway-flow 新增分页参数透传断言（52 项，原 51）。
- 八套离线测试共 335 项全部通过（未安装官方 `bw` CLI 时 `cli-interop` 自跳过）。

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
