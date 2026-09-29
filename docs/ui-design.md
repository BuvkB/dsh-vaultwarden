# 前端设计说明（dsh-vaultwarden 浏览器半边）

> 对应代码：`lib/client.js`（设置卡片 + 条目浏览面板）、`test/client-card.test.mjs`（37 项）。
> 设计基线：与宿主设置页同水准；明暗双主题；仅 `--dsw-alias-*` 令牌；可访问性达标。

## 1. 两个界面，两个槽位

| 界面 | 槽位 | 内容 |
|---|---|---|
| 配置卡片 | `settings.plugin.item`（key = `bitwarden`） | 服务器/账号/密钥/同步控制，9 个字段分三节 |
| 条目浏览面板 | `settings.section`（id = `vaultwarden`，order 30） | 同步后的凭据列表 + 详情 + 复制 + TOTP 倒计时 |

选型依据（`cordis_inspect_query` → Slots.listSubTree）：
- `settings.section` 是 list 槽、`replaceRisk: none`、**有分配空间**，插件获得自己的设置页，不与任何第三方插件耦合（不依赖 dsh-better-sidebar 之类）。
- `settings.plugin.item` 是上游已在用的键位槽，配置卡片继续留在「插件配置」里。
- 会话内表面（composer dock / 右栏 tab）都要求 session 作用域或依赖其他插件，v1 不做。

## 2. 数据通道

浏览器只走同源 HTTP（Host 侧 `lib/api.js`，仅回环、no-store）：

```
GET  /dsh-vaultwarden/api/status             配置/解锁/同步状态
GET  /dsh-vaultwarden/api/list?query=&limit= 条目摘要（永不含密码）
POST /dsh-vaultwarden/api/reveal             单条字段（reprompt 受 confirm 控制）
POST /dsh-vaultwarden/api/totp               当前 TOTP + 倒计时
POST /dsh-vaultwarden/api/sync               强制同步
```

备选方案记录：`ctx.remote.<ns>`（Typert Remote）的客户端命名空间由 `@deepseek-ai/dsh-api-remotes` 编译期固定，第三方插件无法新增；`ctx.remote.commands.execute` 需要 Agent 作用域，设置页场景不总具备。dsh-vault 走的是 `connection.rpc.call('/api', 'vault/*')` + 自建 Host gateway，本插件选择自注册 HTTP 路由，依赖更少、已测试覆盖。

## 3. 设计体系

**间距**：4 / 8 / 12 / 16 / 24 五档；卡片内边距 16/20，节间距 16。
**字号**：正文 13、次级 12、小节标题 12（semibold）、标题 15/14。
**控件**：输入框高 30、圆角 6；主按钮（accent）+ 次按钮（ghost）；布尔用自建 `role="switch"` + `aria-checked`（抄宿主开关行为：36×20 轨道 + 14 圆形 knob + 120ms 位移）。
**焦点**：2px focus ring 用 `border-strong`/accent 令牌表达（输入框 outline 由 token 控制）。

**令牌层**（`--vw-*` 是插件本地语义别名，套在宿主令牌上，字面量只作 fallback——与 dsh-vault 的 `--v-*` 同构）：

| 本地令牌 | 宿主令牌 | 用途 |
|---|---|---|
| `--vw-text` / `--vw-text-2` | label-primary / label-secondary | 正文 / 次级文字（**不用 opacity 压暗**） |
| `--vw-border` / `--vw-border-strong` | border-l1 / border-l2 | 分隔线 / 输入框描边 |
| `--vw-bg` / `--vw-bg-2` | bg-layer-1 / bg-layer-2 | 卡片 / 嵌套面 |
| `--vw-accent` / `--vw-on-accent` | brand-primary / 白 | 主按钮、进度条 |
| `--vw-ok/warn/err/idle` | state-success/warn/error/idle-primary | 状态圆点与边框（**不当正文色**） |

明暗双主题：所有令牌随 `body[data-ds-dark-theme]` 自动翻转，无私立第二套样式。

## 4. 条目面板

- **工具行**：搜索框（`/` 聚焦、Esc 清空、↑↓ 移动选中）、同步状态 chip（实时/轮询/关闭 + 连接圆点 + 相对同步时间）、条目总数、刷新按钮。
- **列表**：行 = 中性首字母圆枕 + 名称 + 用户名·URI 截断 + 收藏星 + TOTP 徽标；`role="listbox"`/`role="option"` + `aria-selected`；选中行用 bg-2 高亮。
- **详情**：用户名/密码（默认掩码，显示/隐藏切换）/TOTP（30 秒倒计时进度条，每秒请求、卸载清理定时器）/URI/目录/备注/自定义字段；每行复制按钮，成功 1.5 秒反馈（`aria-live`）。
- **reprompt**：Bitwarden 开启「重新验证」的条目不出明文，显示锁形说明 + 「确认读取」按钮（带 `confirm: true` 再请求）。
- **空状态**：未配置（引导去卡片补全）/ 加载失败（错误 + hint + 重试）/ 无匹配（换词提示）/ 未选中（引导选条目）。

## 5. 安全姿态

- 列表接口永不返回密码；密码只在用户主动打开条目并点「显示」后出现，且只进 DOM。
- reprompt 条目遵循 Bitwarden 官方客户端约定，不自动解密展示。
- 主密码/API secret 在 GUI 为只写字段（留空=不修改），已存值不回显。
- 面板所有请求走同源 + 仅回环的 HTTP 路由（Host 侧强制）。

## 6. 自验

- `node test/client-card.test.mjs`：37 项（模块加载器契约、9 字段、三分节、switch aria、secret 不回显、保存/清除、同步状态行、面板列表/搜索/详情/掩码/复制/repromise/TOTP/空状态）。
- 主题合规：全部颜色经 `var(--vw-*, var(--dsw-alias-*, #fallback))`，无 var() fallback 之外的硬编码色值；无 opacity 压暗文字；`state-*` 不用于正文。
- 待办：安装进 profile 后做明暗双主题截图核对（见项目任务清单）。
