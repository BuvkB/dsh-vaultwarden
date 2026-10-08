# 前端设计说明（dsh-vaultwarden 浏览器半边）

> 对应代码：`lib/client.js`（条目浏览面板）、`lib/gateway.js`（Host 侧 `vw` 网关）、`test/client-card.test.mjs`（252 项，含 localStorage 快照、`vw/boot` 打桩、旧宿主拒绝分页参数回退整表并被记住、满额截断诚实提示、列表分页与分页游标校准、层级分区导航与分区缓存零 RPC、服务端图标与降级（列表行与详情头部同源）、验证码分区行、写操作二次确认与只读档、五类条目详情）。
> 设计基线：与宿主设置页同水准；明暗双主题；仅 `--dsw-alias-*` 令牌；可访问性达标。

## 1. 一个界面，一个槽位

| 界面 | 槽位 | 内容 |
|---|---|---|
| 条目浏览面板 | `settings.section`（id = `vaultwarden`，order 30） | 层级分区菜单（类型 / 文件夹 / 收藏 / 验证码 / 归档 / 回收站）+ 同步后的凭据列表 + 详情 + 复制 + TOTP 圆环倒计时 |
| 配置表单 | 宿主从插件 `Config` schema 派生 | 服务器/账号/密钥/同步控制/权限档，密钥字段只写 |

选型依据（`cordis_inspect_query` → Slots.listSubTree）：
- `settings.section` 是 list 槽、`replaceRisk: none`、**有分配空间**，插件获得自己的设置页，不与任何第三方插件耦合（不依赖 dsh-better-sidebar 之类）。
- 0.2.0 起配置表单由宿主按 `Config` schema 渲染，插件不再自绘卡片；旧的 `settingsScope` / `settings.plugin.item` 已被移除，继续用它们会导致前端整块不注册（曾实测踩到）。
- 会话内表面（composer dock / 右栏 tab）都要求 session 作用域或依赖其他插件，v1 不做。

## 1b. 图标规范

| 位置 | 形态 | 来源 |
|---|---|---|
| 插件列表 / 插件市场 | 双层盾牌（紫 #6C4DF6 后盾 + 蓝 #2E6BE6 前盾）配白色镂空钥匙孔 | 包根 `icon.svg`（1024 画布，扁平色块 + 镂空），`package.json` `icon` 字段指向它，`files` 收录 |
| 设置页导航行「凭证据库」 | 单色盾牌线稿（`currentColor` 跟随行文字色，明暗双主题自适应） | `lib/client.js` `VaultGlyph` |

宿主 artwork 规范（实证自 dsh-context / dsh-im）：包根带 `icon.svg` + `package.json` 顶层 `"icon": "icon.svg"` + `files` 收录；
插件管理器渲染 `pkg.meta.icon`（`@deepseek-ai/dsh-client-ui-plugin-manager`，卡片 36px / 列表行 30px，`PluginArtworkDefault` 兜底），
官方风 = 鲜艳扁平的纯色形状组合（dsh-im = 交叠对话气泡 + 渐变，dsh-context = 六色拼贴），不是「线稿 + 彩色底框」。
设置导航行没有插件图标槽（宿主只给五个内置 section 自己的图标，其余一律发默认齿轮），所以那一行的图标由标签自己画：
`VaultNavLabel` 把盾牌线稿并进标签自身的 flex 流（`.vw-nav-label` 行向布局，桌面 gap 8px / 移动 tab 条 6px 由样式表断点给，
不实测、不覆盖宿主槽位），同时把宿主齿轮 `display: none`——图标占的就是齿轮原来的位置，行文字与其余行对齐。
样式表由 `VaultNavLabel` 挂载时 `ensureStyles()` 保证存在（设置 nav 是宿主弹层，可能早于面板首次渲染）。

## 2. 数据通道

浏览器只走 `/api` connection RPC（`vw/*` 命名空间，`connection.rpc.call('/api','vw/<method>',{args})`），
**承载操作者已认证会话**——与 dsh-vault 相同的受信通道；插件刻意不自建 HTTP 路由（那会绕过鉴权，实测裸请求能拿到 200）。

```
vw/status   配置/解锁/同步状态
vw/overview 分区计数（全部/收藏/验证码/归档/回收站）+ 类型与文件夹分组（侧栏菜单用）
vw/list     条目摘要（永不含密码；空查询=全量）
vw/reveal   单条字段；field 默认 all（窄字段需点名 card / identity / secureNote / sshKey / totp）；reprompt 条目只有在 authorizeReprompt 开过时间窗后才返回明文
vw/authorizeReprompt  面板内输入主密码 → 比对会话主密钥 → 开一个纯内存时间窗（默认 5 分钟），并把刚解锁的条目一并回传
vw/repromptGrant  轮询剩余解锁时间（仅当门正在屏幕上时）
vw/totp     当前 TOTP + 倒计时
vw/sync     强制同步
vw/session · vw/reset · vw/discardChallenge  会话
vw/boot     一次取回配置 + 会话 + 是否恢复（开面板用）
vw/config · vw/configure · vw/connect · vw/twoFactor · vw/submitTwoFactor  配置与登录
vw/list     section / sectionValue 选分区池（all/totp/type/folder/unfiled/favorites/archive/trash），宿主侧收窄后才计数与分页；includeArchived / includeTrashed 决定归档与回收站是否入列
vw/reveal   includeTrashed 供回收站条目读取（否则报 trashed）
vw/folders  文件夹 id + 名字 + 条目数 + 未归类条数
vw/create · vw/update · vw/remove · vw/restore   写回（受 Config.accessMode 约束）
```

Host 侧由 `lib/gateway.js`（`TypertRemoteService` 子类，命名空间 `vw`）实现。纯 JS 无法使用装饰器语法
（Node 22 不解析），标记由 `markRemote()` 按协议描述符格式在运行时打上，`remoteMethods()` 可回读验证
（host-entry 测试即断言这 20 个线面方法）。配置表单不自绘：0.2.0 起宿主从插件 `Config` schema 派生
（旧版的 `settingsScope` / `settings.plugin.item` 已移除，用它会导致前端整块不注册）。

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

- **标题行**：`Bitwarden 凭据库` + 小字 `（支持 Bitwarden / Vaultwarden）`；标题本身保持短，兼容说明不喧宾夺主。
- **工具行**：搜索框（占位符只说明搜什么；`/` 聚焦、Esc 清空、↑↓ 移动选中放在 tooltip——原先塞在占位符里，窄屏先被截断）、同步状态 chip（实时/轮询/关闭 + 连接圆点 + 相对同步时间）、条目总数、设置/刷新按钮组。
- **布局**：左「侧栏」+ 右「内容列」两栏；内容列在列表与条目详情之间切换（打开条目时列表让位给详情，列表上方留「‹ 返回列表」一行）。侧栏始终可见，不用手机那种「点进去就换屏」。
  滚动区是带高度预算的 flex 列（`max-height: min(58vh, 560px)` + `overflow-y: auto`，标题与工具栏因此常驻、内容自己滚）。**它的直接子项一律 `flex: none`（`S.scrollItem`）**：flex 子项默认会缩，卡片内容高过预算时盒子被压扁、字段却继续画到卡片底衬之外——API 密钥模式比主密码模式多两行，829px 高的窗口下 58vh 只有 480px，client_secret、它的说明与按钮整块浮在弹窗底色上，看着就像字段错位。
  左栏 `position: sticky; top: 0`，列表滚动时钉在滚动区顶部（`align-items: start` 的网格给它位移空间；侧栏父级按内容自然高度排布才有处可粘，即上一条）。**解钉只对粗指针（手指）生效**：`@media (pointer: coarse)` 里再嵌 `@container vw-panel (max-width: 480px)`（无容器查询时用 `@media (max-width: 760px) and (pointer: coarse)`）各写一条 `position: static !important`——手机上左栏搬到顶部、成为普通内容，跟着列表一起滑动；鼠标在**任意宽度都保持钉住**，窄窗口不会让分区菜单（收藏 / 验证码 / 未归类…）跟着列表滚走。左栏比滚动口高时（文件夹多）sticky 元素会随列表滚到自身末尾，因此**不加 `max-height`**（加了会把最后一行截在半个高度上，看着像坏盒子）。
  工具栏在窄面板下改两行：搜索框独占一行，下面一行左是同步胶囊、右是**设置/刷新**（`@container vw-panel (max-width: 520px)`，容器查询够不到内联样式故用 `!important`）。此前它把操作区整行铺满成第三行，手机上出现半行空白、两个按钮飘在下面。
  断点走 **CSS 容器查询**（`@container vw-panel`）而不是窗口宽度：宿主设置弹窗固定 800px 宽，其中约 280px 是设置导航，面板自己只剩 ~560px，用窗口宽度判断会永远判成「桌面」。
  `<480px` 才把侧栏搬到顶部、钻取时藏侧栏；`<620px` 把字段行的标签列从 92px 收到 72px。不支持容器查询的浏览器回退到 `@supports not (container-type)` + 760px 窗口断点。
- **分区菜单**（侧栏，计数来自 `vw/overview`）：全部条目 / 收藏 / 验证码 三行，然后是两组带标题的层级：类型 (n)（登录、安全笔记、银行卡、身份信息、SSH 密钥，按数量降序）与 文件夹 (n)（各文件夹 + 未归类），最后是 归档 与 回收站。点一行即把列表切成该分区的池子（`vw/list` 带 `section`/`sectionValue`，宿主侧收窄后才计数、才分页，因此计数与列表永远一致）；当前分区带 `aria-current` 高亮。
  每行的图标是**画出来的 SVG 线稿**（`NAV_ICON_SHAPES` → `navGlyph`，16×16、1.3px 描边、`currentColor`），不再用 `▦ ★ ⏱ ◍ ▸ · ⌸ ⌫` 这些字体字符——它们的视觉大小与基线随宿主字体而变（半个高度的三角挨着满高的方框，未归类的中点在文字基线上），换成同一套线稿后每行读起来一致；条目类型的图标按 `TYPE_ICON_NAMES` 投影，未知类型退到通用记号。图标是装饰（`aria-hidden`），颜色比标签浅一档，当前行加深。
  计数是**统一的扁平药丸**（`min-width 22` / 高 20 / `border-radius: 999px` / tabular-nums），一位数的回收站与三位数的全部条目等重、数字对齐成列；当前行的药丸反色成面板底色，避免 bg-2 叠在 bg-2 上看不见。计数元素里始终只有裸数字，样式只是它外面的壳。
- **分区缓存**：切回刚离开的分区时，若该分区快照在 5 分钟内（`SECTION_CACHE_MS`）就**直接重绘、零 RPC**；搜索、刷新按钮与写操作不走缓存（一律重查）。首次进入某分区仍是「先画后拉」。
- **列表**：行 = 服务端缓存的站点图标（`<img>` 指向 `<serverUrl>/icons/<host>/icon.png`，主题无关、随服务器缓存；加载失败或像素小于 `ICON_MIN_PX = 24` 的行退回中性首字母圆枕，纯数字名如 IP 不会退化成同一个「1」）+ 名称 + 用户名·URI 截断 + 收藏星 + TOTP 徽标；归档条目带「已归档」徽标，回收站条目名称划掉、带「回收站」徽标（warn 色）；`role="listbox"`/`role="option"` + `aria-selected`；选中行用 bg-2 高亮。
  列表行的盒子模型是 **border-box**：`listRow` 是 `width:100%` 加自身内边距，`<button>` 行从 UA 样式表拿到 border-box，而「验证码」分区的行是 `<div>`（行里不能再套按钮），不写 `boxSizing` 就会比列表宽 28px，把复制按钮切在面板右缘之外——桌面 800px 与手机 390px 都实测到了。
- **验证码分区行**（等于 m00193 的 App 形态）：图标 + 名称 + 用户名 + 30px 倒计时圆环（环心写剩余秒数）+ 6 位动态码（等宽、3+3 分组「686 029」）+ 右侧复制按钮（点它不打开条目）。动态码每秒只在这几行里请求。
- **详情头部**：图标位与列表行同源（`iconFor(value, S.avatarImgLg) ?? monogram(value)`）——服务器有站点图标就显示图标，没有才退回 36px 的字母圆枕。这两处曾各走各的：列表行取图标，头部直接画字母，于是点开条目图标就消失了（v0.7.1 修）。大圆枕里用 22px 的图，列表行仍是 18px。reprompt 条目的头部同样拿得到图标：`projectItem` 的门只挡字段，网址本就在打开它的那一行里露着。
- **详情**：用户名/密码（默认掩码，显示/隐藏切换）/TOTP（30px 圆环倒计时，每秒请求、卸载清理定时器；剩余秒数写在环心，弧随剩余时间缩短，色从绿经橙渐变到红，`role="img"` + `aria-label` 报出秒数，`prefers-reduced-motion` 下不扫弧只跳格）/URI/目录/备注/自定义字段；每行复制按钮，成功 1.5 秒反馈（`aria-live`）。按类型投影：卡片（卡号掩码到后四位/持卡人/品牌/有效期/安全码）、身份（姓名/邮箱/电话/地址分组合并）、SSH 密钥（公钥与指纹明文、私钥掩码）；附件与密码历史各自折叠（附件只显示文件名与大小，不提供下载）；带通行密钥的条目显示徽标。回收站条目顶部有软删说明横幅，读取时带 `includeTrashed`。
- **写操作**（`accessMode` 为 `ask`/`auto` 时）：详情底部「操作」区 = 归档/取消归档、移入回收站、恢复（仅回收站条目）、移动到文件夹；点任一操作先出确认框（文案随操作变化，注明**面板操作不受 accessMode 门禁保护，请谨慎操作**），确认后才发 `vw/update`/`vw/remove`/`vw/restore`。移动文件夹用独立小框（不移动 + 文件夹列表，取消发送 `folderId: null`）。`readonly` 档不渲染按钮，显示一行「当前为只读模式」。写入期间显示「正在写入…」，完成后就地提示并刷新。
- **reprompt**：Bitwarden 开启「重新验证」的条目不出明文，**任何字段都不出**。详情里是锁形说明 + **主密码输入框** + 「输入主密码解锁」（回车即提交），输错留在原地报错。这道门没有布尔旁路：`reveal` 不收 `confirm`，解锁只能由 `vw/authorizeReprompt` 打开，时间窗（默认 5 分钟）内整条可读，窗在面板上以「已解锁 N 分钟」显示。
- **窄字段按需读取**：`all` 只给存在位（`hasCard` / `hasIdentity` / `hasSshKey`，SSH 另给指纹）。详情渲染成「含银行卡 · 读取这一项」一行，点一下才发一次 `vw/reveal { field: 'card' }`，取回的行替换那一行；切换条目时这些窄字段状态一并清空。
- **空状态**：未配置（引导去卡片补全）/ 加载失败（错误 + hint + 重试）/ 无匹配（换词提示）/ 未选中（引导选条目）。

## 5. 安全姿态

- 列表数据（`vw/list`）永不返回密码；密码只在用户主动打开条目并点「显示」后出现，且只进 DOM。
- reprompt 条目遵循 Bitwarden 官方客户端约定，不自动解密展示，且**只能由本人在面板输入主密码解锁**——工具面没有、也不该有能绕过它的参数（v0.6.x 的 `confirm: true` 已删除）。
- 主密码/API secret 在宿主派生的表单里是只写字段（留空=不修改），已存值不回显。
- 面板所有数据走 `/api` connection RPC —— 该通道自带操作者鉴权，插件不注册任何自有 HTTP 路由。


## 7. 开箱体验：静默恢复 + 先绘制后请求

**开面板的时序**（`VaultPanel` 的 `load()`）：

1. 同步绘制：`openCache`（同页）→ localStorage 快照（重载后）。有就立刻 `ready`，没有才 `loading`。
2. 一次 `vw/boot`：`{ config, resumed, session }`。Host 侧 `resumeSession()` 只读盘会话 + 必要时刷新 refresh token，**从不发起登录**（否则两步验证账号每次开面板都被拦）。
3. 身份校验：快照的 `serverUrl + email` 与 `boot.config` 不一致 → 丢快照回到 `loading`；未配置 → 清快照进引导；`resumed: false` → 清快照进登录表单。
4. 后台刷新：`vw/list` 与 `vw/status` **并行**发出，成功后回写两级缓存。列表按 `PAGE_SIZE = 50` 分页，向下滚动自动续读下一页；滑得比加载快时，尾部才出现「还有 N 条」按钮兜底。宿主拒绝分页参数时回退整表读取（上限 200），被上限截断时仍保留按钮。
4b. 切分区：该分区快照在 `SECTION_CACHE_MS = 5 分钟` 内且确实换过分区 → 直接重绘，**零 RPC**；否则先画列表再补一次安静的后台读取（分页游标与「还有 N 条」状态随分区一起重置）。搜索、刷新按钮、写操作一律绕过缓存。

**为什么要这种顺序**：凭据列表只含摘要（名称/类型/用户名/URI/目录/徽标），没有密码与 TOTP 明文，可以安全驻留 localStorage；
快照按「服务器 + 邮箱」绑定，且在宿主报告登出时立即删除。宿主侧同时把「开一次面板」从两次串行 RPC 降为一次，列表与状态并行，
插件激活时后台预热（`resumeSession` + `unlock` 填解密缓存），重启后第一次开面板不再付全量同步的代价。

## 6. 自验

- `node test/client-card.test.mjs`：252 项（模块加载器契约、9 字段、三分节、switch aria、secret 不回显、保存/清除、同步状态行、面板列表/搜索/详情/掩码/复制/repromise/TOTP/空状态、**层级分区导航（侧栏行与计数、分组标题、aria-current、进入分区带 section/sectionValue、切回命中快照零 RPC、老宿主无 `vw/overview` 时只剩「全部条目」一行）、服务端图标（`__setIcons` 命中出 `<img>`、`none` 退回字母圆枕、打开后的详情头部带同一个图标且放大到 22px）、验证码分区行（3+3 分组动态码、圆环、复制）、写操作（归档/回收站/恢复/移动的二次确认与参数、readonly 只读说明、回收站条目 includeTrashed）、五类条目详情（卡片掩码/身份/SSH/附件与历史折叠）**、**重载先从快照绘制而未登录即清快照**、`vw/boot` 一次 RPC 取代 config+session、**旧宿主（无 `vw/boot`）回退后仍开列表且不被要求登录**、**宿主拒绝 `vw/boot` 时报错而不误判旧宿主**、**列表分页：首屏 50 行、滚动续读、滑快出按钮、旧宿主拒绝分页参数后回退整表、页读失败保留列表、无布局度量不发请求、窗口漂移按宿主端点续读不重不漏、废弃列表迟到页被丢弃、满 200 上限截断改诚实提示且不再重试、拒绝分页的宿主下次打开直接整表**）、**按键不得清空列表**（刷新期间旧行留屏、搜索框不卸载、状态提示「正在刷新」、答复落地后行被替换）、**动态码圆环**（三档色令牌与 `stroke-dashoffset` 换算、环心秒数与 aria 标签、偏移随秒数递增、无 `color-mix()` 时取就近端点不丢描边、渐变终点落在 error 令牌）。
- 主题合规：全部颜色经 `var(--vw-*, var(--dsw-alias-*, #fallback))`，无 var() fallback 之外的硬编码色值；无 opacity 压暗文字；`state-*` 不用于正文。
- 明暗双主题截图已核对（`assets/panel-*.png` 三张，800×820：侧栏分区 + 列表页、浅色详情页含写操作区、暗色详情页）。截图在真机 GUI 里拍（宿主自己那 800px 弹窗），因此侧栏宽度就是它在真实设置页里的宽度。
