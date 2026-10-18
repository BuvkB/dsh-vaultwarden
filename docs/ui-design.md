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

- **标题行**：**照抄宿主插件标题的格式**（见插件市场卡片头），**不带头部图标**。分两组、组内不折行：
  - 标题组：`Vaultwarden 凭据库`（16px 半粗、正文墨色）
  - 元信息组：`dsh-vaultwarden` · `v<版本号>` · `GitHub` 链接（12.5 / 11.5 / 11.5px 次要灰）

  两组各自 `nowrap`、行本身 `flex-wrap`，所以窄屏时**整组下沉**而不是拆散——这解决了「第一行留包名、第二行只剩版本号」那种读起来像没排完的断法。实测 ≥370px 单行（行高 22px），<370px 两行（标题一行、元信息完整一行）。曾试过用盾牌线稿打头，但图标要和名字配大小、且在手机宽度会把元信息顶到第二行，而设置导航栏本身已经带了这枚盾牌，面板内重复一遍没有收益，故去掉。实测 16px 下 ≥360px 仍单行（行高 22px），<360px 才让元信息整体折到第二行。四点刻意与宿主对齐：图标**直接画在页面上**、不加圆角底色块（18px 字形套一层底衬会读成贴纸）；包名与版本号同为次要灰，构成一条元信息尾巴；链接**用默认墨色不用链接蓝**，否则面板里最小的字反而最抢眼；分隔符是宿主自己那种 2px 圆点。原先的兼容说明「（支持 Bitwarden / Vaultwarden）」只是重复标题已说的事，已删除。
  **版本号有两个来源，缺一不可**：bundle 读不到 `package.json`，宿主经 `vw/boot` 由 node 半边 `gateway.js` 的 `pluginIdentity()` 读自身 manifest 返回（面板本来就要发这次调用，不增加往返，且不会与实装包脱节）；但改 node 半边**必须重启才生效**，所以 `scripts/stamp-build.mjs` 在每次 build 时把 `package.json` 的 version 与 repository 写进 bundle 的 `BUILD_VERSION` / `BUILD_REPOSITORY` 两个字面量作为兜底——宿主有值就用宿主的，没有就用构建戳，任何时候标题行都不会缺版本号。构建戳由脚本改写、幂等，不靠人手维护。`repository.url` 是 npm 简写（`git+https://…​.git`），浏览器不认这个 scheme，前端用 `normalizeRepoUrl()` 去 `git+` 前缀与 `.git` 后缀后渲染为 `target=_blank` + `rel=noopener noreferrer` 的链接；拿不到时回退到写死的仓库地址。窄面板（<300px）下元信息簇换行到标题下方，不隐藏——版本与源码入口正是陌生安装环境里最需要的信息。
- **工具行**：搜索框（占位符只说明搜什么；`/` 聚焦、Esc 清空、↑↓ 移动选中放在 tooltip——原先塞在占位符里，窄屏先被截断）、同步状态 chip（实时/轮询/关闭 + 连接圆点 + 相对同步时间）、条目总数，以及**三个图标按钮**：新建条目（`+`）、设置、刷新（v0.8.0 起由文字改 16×16 线稿；文字版在手机上占掉整第三行）。
- **布局**：左「侧栏」+ 右「内容列」两栏；内容列在列表与条目详情之间切换（打开条目时列表让位给详情，列表上方留「‹ 返回列表」一行）。侧栏始终可见，不用手机那种「点进去就换屏」。
  滚动区是带高度预算的 flex 列（`max-height: min(58vh, 560px)` + `overflow-y: auto`，标题与工具栏因此常驻、内容自己滚）。**它的直接子项一律 `flex: none`（`S.scrollItem`）**：flex 子项默认会缩，卡片内容高过预算时盒子被压扁、字段却继续画到卡片底衬之外——API 密钥模式比主密码模式多两行，829px 高的窗口下 58vh 只有 480px，client_secret、它的说明与按钮整块浮在弹窗底色上，看着就像字段错位。
  左栏 `position: sticky; top: 0`，列表滚动时钉在滚动区顶部（`align-items: start` 的网格给它位移空间；侧栏父级按内容自然高度排布才有处可粘，即上一条）。**解钉只对粗指针（手指）生效**：`@media (pointer: coarse)` 里再嵌 `@container vw-panel (max-width: 480px)`（无容器查询时用 `@media (max-width: 760px) and (pointer: coarse)`）各写一条 `position: static !important`——手机上左栏搬到顶部、成为普通内容，跟着列表一起滑动；鼠标在**任意宽度都保持钉住**，窄窗口不会让分区菜单（收藏 / 验证码 / 未归类…）跟着列表滚走。左栏比滚动口高时（文件夹多）sticky 元素会随列表滚到自身末尾，因此**不加 `max-height`**（加了会把最后一行截在半个高度上，看着像坏盒子）。
  工具栏在窄面板下改两行：搜索框独占一行，下面一行左是同步胶囊、右是**三个动作按钮**（`@container vw-panel (max-width: 520px)`，容器查询够不到内联样式故用 `!important`）。此前它把操作区整行铺满成第三行，手机上出现半行空白、两个按钮飘在下面。
  面板窄到 **300px 以下**（宿主弹窗减去自己的导航列后只剩 ~110px）时每个控件各占一行：三个 32px 按钮加间距要 112px，比内容列宽一个像素，第三个会被挤到新的一行——收到 28px 正好一排。这个宽度下计数所在的可伸缩轨道还会塌成 0、文字直接画到按钮上面（`elementsFromPoint` 命中的是计数而不是按钮），所以必须先让每个控件各占一行。
  **齿轮图标是一条闭合轮廓 + 中心毂**（八齿、32 个点），不是「圆 + 八根辐条」：辐条与轮圈同粗，14px 下只读得出太阳。
  断点走 **CSS 容器查询**（`@container vw-panel`）而不是窗口宽度：宿主设置弹窗固定 800px 宽，其中约 280px 是设置导航，面板自己只剩 ~560px，用窗口宽度判断会永远判成「桌面」。
  `<480px` 才把侧栏搬到顶部、钻取时藏侧栏；`481–620px` 把字段行的标签列从 92px 收到 72px，`<480px` 再让字段行整行竖排。**容器查询的书写顺序是有语义的**：字段行的三条规则特异性相同，所以窄的那条必须写在宽的后面——曾把 `max-width:620px` 写在 `max-width:480px` 之后，结果 72px 标签列在任何宽度都赢，竖排那条永远不生效，手机上密码的掩码点折成两行、显示/复制被挤到卡片外。`<170px` 时最后才收起行内徽章组与 chevron（名称优先保住，状态在打开的详情里本来就有）。不支持容器查询的浏览器回退到 `@supports not (container-type)` + 760px 窗口断点。
- **分区菜单**（侧栏，计数来自 `vw/overview`）：全部条目 / 收藏 / 验证码 三行，然后是两组带标题的层级：类型 (n)（登录、安全笔记、银行卡、身份信息、SSH 密钥，按数量降序）与 文件夹 (n)（各文件夹 + 未归类），最后是 归档 与 回收站。点一行即把列表切成该分区的池子（`vw/list` 带 `section`/`sectionValue`，宿主侧收窄后才计数、才分页，因此计数与列表永远一致）；当前分区带 `aria-current` 高亮。
   每行的图标是**画出来的 SVG 线稿**（`NAV_ICON_SHAPES` → `navGlyph`），不再用 `▦ ★ ⏱ ◍ ▸ · ⌸ ⌫` 这些字体字符——它们的光学大小与基线随宿主字体变。**画法严格对齐宿主自己的图标语言**（从 `dsh-web-frontend` 的 `Icon*OutlineRegular` 家族实证）：16×16 视框、`strokeWidth: 1`、**不覆盖** `stroke-linecap/linejoin`（宿主靠 SVG 默认 miter 拐角取得锐利感，插件若改成圆角就是在同一列里画另一套图标）、坐标为光学校准值而非粗网格对齐、需要体块时用 `fill: currentColor` + `fillOpacity 0.06–0.16`（宿主对 IconFolderOpenOutlineRegular 的托盘就是这么画的）。视觉框统一在 1.5–14.5，四周留约 1.5 的空气——把视框填满才是「傻大黑粗」的根因。分类标记（文件夹 vs 未归类）靠**体块浓淡**区分，不靠再加线条。
  计数是**统一的扁平药丸**（`min-width 22` / 高 20 / `border-radius: 999px` / tabular-nums），一位数的回收站与三位数的全部条目等重、数字对齐成列；当前行的药丸反色成面板底色，避免 bg-2 叠在 bg-2 上看不见。计数元素里始终只有裸数字，样式只是它外面的壳。
- **徽章体系**（`Badge` / `BadgeRow` / `badgeStyle`，一处定义全局复用）：宿主 tag 的同一套度量——`height 19` / `padding 1px 8px` / `font-size 11` / `line-height 17` / `weight 500` / 全圆角 / tabular-nums，无描边、无渐变、无阴影（扁平），底色取宿主每档状态的 **tertiary 浅色**（浅色主题是淡色洗，深色主题是深色洗，随 `body[data-ds-dark-theme]` 自动翻转），字色是同一状态色与正文墨色混合（`color-mix`，不支持时退回状态色）。语义五档、克制配色：`info` 蓝=TOTP/实时、`ok` 绿=通行密钥/重新验证开关、`warn` 琥珀=回收站、`muted` 灰=已归档、`neutral` 墨=条目类型等分类标记；**颜色只花在状态上**，分类一律中性色。中性与灰色两档用 `当前墨色 + 低透明度` 而不是「与 surface 混合」——后者在深色主题会翻成黑卡片上的浅色块。
- **行内控件**（`S.inlineButton`）：字段行里的复制、显示/隐藏、读取这一项、验证码行的复制共用同一个盒子（`height 28` / `padding 0 11px` / `radius sm` / `font-size 12` / `flex: none`）。它们总是成对出现，所以必须同高同字号——此前是 28/30/32 三套近似字面量，「显示」和「复制」并排时高矮字号都不一致。`CopyButton` 用 `inline` 开关选这一套；完成复制的绿色反馈只换颜色不换盒子，避免点击瞬间按钮跳动。
- **字段行**（`S.fieldRow`）：`align-items: start` 而非 center——一个值可能是一行也可能是五行（长 URL、笔记），居中会让标签和右侧控件落在值中间，同列基线不一致；顶端对齐后标签与值首行、右侧控件永远同一水平线。
- **分区缓存**：切回刚离开的分区时，若该分区快照在 5 分钟内（`SECTION_CACHE_MS`）就**直接重绘、零 RPC**；搜索、刷新按钮与写操作不走缓存（一律重查）。首次进入某分区仍是「先画后拉」。
- **列表**：行 = 服务端缓存的站点图标（`<img>` 指向 `<serverUrl>/icons/<host>/icon.png`，主题无关、随服务器缓存；加载失败或像素小于 `ICON_MIN_PX = 24` 的行退回中性首字母圆枕，纯数字名如 IP 不会退化成同一个「1」）+ 名称 + 用户名·URI 截断 + 徽章组 + 收藏星 + chevron；归档条目带「已归档」徽章（muted），回收站条目名称划掉、带「回收站」徽章（warn），带动态码的带 TOTP 徽章（info）；`role="listbox"`/`role="option"` + `aria-selected`；选中行用 bg-2 高亮。收藏星与 chevron 都是**同一套 16×16 线稿**（`navGlyph`），不用 ★ / › 字符——字符的光学大小和基线随宿主字体变。徽章由 `BadgeRow` 包成一组（固定 6px 间距），所以一行里两个徽章与相邻只有一个徽章的行左右边缘仍然对齐。
  列表行的盒子模型是 **border-box**：`listRow` 是 `width:100%` 加自身内边距，`<button>` 行从 UA 样式表拿到 border-box，而「验证码」分区的行是 `<div>`（行里不能再套按钮），不写 `boxSizing` 就会比列表宽 28px，把复制按钮切在面板右缘之外——桌面 800px 与手机 390px 都实测到了。
- **验证码分区行**（等于 m00193 的 App 形态）：图标 + 名称 + 用户名 + 30px 倒计时圆环（环心写剩余秒数）+ 6 位动态码（等宽、3+3 分组「686 029」）+ 右侧复制按钮（点它不打开条目）。动态码每秒只在这几行里请求。
- **详情头部**：图标位与列表行同源（`iconFor(value, S.avatarImgLg) ?? monogram(value)`）——服务器有站点图标就显示图标，没有才退回 36px 的字母圆枕。这两处曾各走各的：列表行取图标，头部直接画字母，于是点开条目图标就消失了（v0.7.1 修）。大圆枕里用 22px 的图，列表行仍是 18px。reprompt 条目的头部同样拿得到图标：`projectItem` 的门只挡字段，网址本就在打开它的那一行里露着。
- **详情**：用户名/密码（默认掩码，显示/隐藏切换）/TOTP（30px 圆环倒计时，每秒请求、卸载清理定时器；剩余秒数写在环心，弧随剩余时间缩短，色从绿经橙渐变到红，`role="img"` + `aria-label` 报出秒数，`prefers-reduced-motion` 下不扫弧只跳格）/URI/目录/备注/自定义字段；每行复制按钮，成功 1.5 秒反馈（`aria-live`）。按类型投影：卡片（卡号掩码到后四位/持卡人/品牌/有效期/安全码）、身份（姓名/邮箱/电话/地址分组合并）、SSH 密钥（公钥与指纹明文、私钥掩码）；附件与密码历史各自折叠（附件只显示文件名与大小，不提供下载）；带通行密钥的条目显示徽标。回收站条目顶部有软删说明横幅，读取时带 `includeTrashed`。
- **写操作**（`accessMode` 为 `ask`/`auto` 时）：详情底部「操作」区 = 归档/取消归档、移入回收站、恢复（仅回收站条目）、移动到文件夹；点任一操作先出确认框（文案随操作变化，注明**面板操作不受 accessMode 门禁保护，请谨慎操作**），确认后才发 `vw/update`/`vw/remove`/`vw/restore`。移动文件夹用独立小框（不移动 + 文件夹列表，取消发送 `folderId: null`）。`readonly` 档不渲染按钮，显示一行「当前为只读模式」。写入期间显示「正在写入…」，完成后就地提示并刷新。
- **reprompt**：Bitwarden 开启「重新验证」的条目不出明文，**任何字段都不出**。详情里是锁形说明 + **主密码输入框** + 「输入主密码解锁」（回车即提交），输错留在原地报错。这道门没有布尔旁路：`reveal` 不收 `confirm`，解锁只能由 `vw/authorizeReprompt` 打开，时间窗（默认 5 分钟）内整条可读，窗在面板上以「已解锁 N 分钟」显示。
- **窄字段按需读取**：`all` 只给存在位（`hasCard` / `hasIdentity` / `hasSshKey`，SSH 另给指纹）。详情渲染成「含银行卡 · 读取这一项」一行，点一下才发一次 `vw/reveal { field: 'card' }`，取回的行替换那一行；切换条目时这些窄字段状态一并清空。
- **编辑器**（v0.8.0，`accessMode` 为 `ask`/`auto` 时）：详情「操作」区多一个**编辑**，工具栏多一个**新建条目**。编辑器**整体替换详情**，不是详情里的一节——两者回答的是不同问题（「这条是什么」vs「这条该改成什么」），半开的编辑器压在只读摘要下面读起来像一个存不进的表单。
  打开编辑 = 一次 `vw/draft { id }`：宿主把整条明文装配好返回（密码、卡号、身份、SSH 私钥、笔记正文），而不是让面板逐控件发一次 `vw/reveal`。TOTP **种子刻意不在 draft 里**（面板本来就只经 `vw/totp` 取码、从不持有种子），表单里那一项留空即保留原设置；想换种子才在这里填。
  表单按类型给字段：登录（用户名/密码/TOTP/网址/备注）、安全笔记（正文）、银行卡（持卡人/品牌/卡号/到期月年/安全码，卡号与安全码是密码型控件）、身份信息（称谓/名/中间名/姓/用户名/公司/邮箱/电话/SSN/护照/驾照/三行地址/城市/省州/邮编/国家，SSN/护照/驾照是密码型控件）、SSH 密钥（私钥/公钥/指纹，私钥是 textarea 等宽）。另有收藏、需要重新验证、文件夹（仅个人条目）、自定义字段（增删行）。
  保存 = **只发变化过的字段**：`diffOf(base, form)` 逐项比对宿主给的 draft 与读者键入的值，`vw/update { id, input }` 的 `input` 是**扁平字段**（网关按参数名校验，嵌套 `patch` 对象会被拒）。没碰过的密码/TOTP/用户名根本不进请求——这正是表单没展示的通行密钥、附件、密码历史能原样留存的原因。新建走 `vw/create`，类型选择器一换就按新类型重建表单。
  保存成功后**强制 `vw/sync`**（写回已落地，这一步让下一条 `vw/list` 读得到），再重读列表与分区计数；同步失败只作为「已保存，但同步未完成：…」的警告跟在成功旁边——写已经落地，把它报成失败会诱使读者重试、从而造出重复条目。
  **冲突**：宿主在自己那份已变时以 `stale_revision` 拒绝写入。编辑器据此停用保存按钮并说明「该条目已被其他客户端修改，请重新打开编辑器」——这不是该重试的错误。
  **实时同步**：宿主处于轮询模式（`liveSync.mode` 非 `off` 非 `websocket`）时，面板按宿主自报的 `pollIntervalMs`（下限 15 秒）安静重读一次列表：`readVault` 保留屏上旧行，答案不变就原样重绘、不闪。WebSocket 模式不另起定时器（宿主自己的信号处理器会刷新）；编辑器/设置表单/确认框/写入进行中一律不刷——换掉读者正在编辑的行等于丢他们的工作。
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

- `node test/client-card.test.mjs`：295 项（模块加载器契约、9 字段、三分节、switch aria、secret 不回显、保存/清除、同步状态行、面板列表/搜索/详情/掩码/复制/repromise/TOTP/空状态、**工具栏图标化**（新建/设置/刷新画成 16×16 线稿，`title` + `aria-label` 保留可访问名；手机宽度三个按钮与计数同排，不再换行也不再被挤成「共 4」）、**密码行两行堆叠**（掩码值一行、显示/复制按钮一行，label 顶部对齐，窄宽下按钮不再被挤出卡片）、**网址字段单行 input**（一个 URL 一行，66px textarea 读起来像块空板）、**层级分区导航（侧栏行与计数、分组标题、aria-current、进入分区带 section/sectionValue、切回命中快照零 RPC、老宿主无 `vw/overview` 时只剩「全部条目」一行）、服务端图标（`__setIcons` 命中出 `<img>`、`none` 退回字母圆枕、打开后的详情头部带同一个图标且放大到 22px）、验证码分区行（3+3 分组动态码、圆环、复制）、写操作（归档/回收站/恢复/移动的二次确认与参数、readonly 只读说明、回收站条目 includeTrashed）、五类条目详情（卡片掩码/身份/SSH/附件与历史折叠）**、**重载先从快照绘制而未登录即清快照**、`vw/boot` 一次 RPC 取代 config+session、**旧宿主（无 `vw/boot`）回退后仍开列表且不被要求登录**、**宿主拒绝 `vw/boot` 时报错而不误判旧宿主**、**列表分页：首屏 50 行、滚动续读、滑快出按钮、旧宿主拒绝分页参数后回退整表、页读失败保留列表、无布局度量不发请求、窗口漂移按宿主端点续读不重不漏、废弃列表迟到页被丢弃、满 200 上限截断改诚实提示且不再重试、拒绝分页的宿主下次打开直接整表**）、**按键不得清空列表**（刷新期间旧行留屏、搜索框不卸载、状态提示「正在刷新」、答复落地后行被替换）、**动态码圆环**（三档色令牌与 `stroke-dashoffset` 换算、环心秒数与 aria 标签、偏移随秒数递增、无 `color-mix()` 时取就近端点不丢描边、渐变终点落在 error 令牌）。
- `node test/gateway-flow.test.mjs`：90 项，其中 v0.8.0 补的**编辑器全链路**：`draft` 返回整条明文（密码在、TOTP 只给标志不给种子、自定义字段与 revisionDate 在）、未知 id 报 `not_found`、`update` 只改点名字段且未点名的自定义字段原样留存、写后 `sync` 能读回、并发改写以 `stale_revision` 拒绝且不改动条目、`create` 落库后列表可见。
- `node test/host-entry.test.mjs`：28 项，含 `vw/draft` 在线面白名单内、且 `draft(id, includeTrashed)` 的参数名与面板发出的字段一一对应（网关会拒收参数表里没有的字段）。
- 主题合规：全部颜色经 `var(--vw-*, var(--dsw-alias-*, #fallback))`，无 var() fallback 之外的硬编码色值；无 opacity 压暗文字；`state-*` 不用于正文。
- 明暗双主题截图已核对（`assets/panel-*.png` 三张，800×820：侧栏分区 + 列表页、浅色详情页含写操作区、暗色详情页）。截图在真机 GUI 里拍（宿主自己那 800px 弹窗），因此侧栏宽度就是它在真实设置页里的宽度。
