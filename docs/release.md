# 发版步骤

## 一句话

本地跑门禁与预检 → 推 main → 打 tag → **云端自动**完成 npm 发布、打包、建 Release → 三道复验。

打包不在本地做。tag 推上去之后，`npm pack`、两个资产、Release 页面全部由 GitHub Actions 在干净检出上生成，所以发出去的产物永远对应仓库里那个提交，不依赖本机工作区当时是什么状态。

## 分工

| 在哪 | 做什么 |
| --- | --- |
| 本地 | 改版本号与 CHANGELOG、打戳、跑门禁、跑一致性预检、推 main、打 tag |
| GitHub Actions | 版本一致性校验、语法检查、`npm publish`（Trusted Publishing）、`npm pack`、建 Release 并上传双资产 |

## 详细步骤

```sh
cd /home/tinyog/dsh/dsh-vaultwarden

# 1. 改 package.json 的 version
# 2. 在 CHANGELOG.md 顶部写当前版本段（## [x.y.z] — 日期）
# 3. 把版本号打进浏览器包（面板标题显示的版本靠它，不能手改）
node scripts/stamp-build.mjs

# 4. 门禁：全部离线测试
bash scripts/build.sh

# 5. 一致性预检：版本三方一致、工作区干净、包内容正确、模块可解析
node scripts/preflight-release.mjs

# 6. 提交并推 main
git add -A && git commit -m 'release: v0.15.0'
git push origin main

# 7. 打 tag 并推送 —— 这一步触发云端发版，之后不用再在本地做任何事
git tag -a v0.15.0 -m 'v0.15.0：...'
git push origin v0.15.0
```

预检会在这些情况下拦下来：tag 与 package.json 版本不一致、`lib/client.js` 的 `BUILD_VERSION` 没跟上、CHANGELOG 缺当前版本段、工作区有未提交改动、`npm pack` 漏掉运行必需的文件、任一模块语法不过。它不联网——联网的事都留给云端。

## 云端流水线（.github/workflows/publish.yml）

1. 检出 tag 对应的提交，装 Node 24；
2. 语法检查 `lib/*.js`；
3. **版本一致性**：tag、`package.json`、`lib/client.js` 的 `BUILD_VERSION` 必须三方相同，否则整条流水线失败；
4. `npm publish`：走 Trusted Publishing（OIDC），不需要 token、不弹两步验证；rc 版本自动发到 `rc` 标签，绝不当 `latest`；该版本已存在时跳过发布，便于整体重跑；
5. `npm pack` 打一次包，复制成两个资产名（带版本号 + 稳定的 `dsh-vaultwarden.tgz`），并打印 sha256；
6. 从 CHANGELOG 提取**当前版本那一段**作为 Release 正文（取不到就失败，不会发出空 Release）；
7. 建 Release 并上传双资产；Release 已存在时只覆盖资产，不动页面和 tag。

**失败了怎么重跑**：流水线是幂等的，GitHub Actions 页面点 Re-run all jobs，或 `gh run rerun <run-id>`。已发布的版本会被跳过，接着做打包和 Release。

## 为什么两个资产

| 资产 | 用途 |
| --- | --- |
| `dsh-vaultwarden-0.15.0.tgz` | 人工核对、归档、写进 Release 正文的直链 |
| `dsh-vaultwarden.tgz` | 市场条目与 `releases/latest/download` 用的稳定名，**每次发版都覆盖它** |

两者由同一次 `npm pack` 复制而来，字节完全一致，不需要手动上传两次。

## 复验（发布后，本地，不解压不下载）

```sh
npm run verify-release              # 校验 package.json 里的版本
npm run verify-release -- v0.15.0   # 或点名某个 tag
```

它只读哈希：

1. Release 已发布（不是 draft），两个资产都在、都不为空；
2. 两个资产的 digest 相同——市场下载稳定名、人下载版本化名，两者不同就等于发了两个不同的包；
3. npm 上有这个版本，且 `dist-tags.latest`（正式版）或 `dist-tags.rc`（RC）指向它（市场更新提示靠这条）。

**为什么不下载解包**：digest 本身就是内容哈希，下载只能再证明一次「传输没坏」，证明不了「文件对不对」。而「本地打包 vs 云端打包」的字节对比也不成立——npm 版本不同会改压缩元数据：v0.15.0 实测本地 npm 10.9.8 得 `4790db5f…`、云端 npm 11.x 得 `b80b21cb…`，但两份解包后的目录 `diff -r` 完全一致。所以有意义的检查是「各发布渠道互相一致」，不是「和本地包的字节一致」。

界面效果由作者本人在真实 GUI 里看，不列入发版门禁：自动化开浏览器只能证明「没白屏」，证明不了观感对不对。

## 为什么发版必须发 npm

市场判断某条目有没有新版本，走的是 `dsh-market` 的 `lib/updates.js`：目录条目的 `npm` 字段有值时，才拿 registry 的 `dist-tags.latest` 和用户已装版本比较。目录的 `npm` 字段来自 `awesome-dsh-plugin` 每天 02:23 UTC 的 `probe-npm.mjs`——它读仓库 `package.json` 的 `name`，再去 registry 校验 `repository` 是否指回本仓库。所以：

- 只推 GitHub、不发 npm → 目录 `npm` 恒为 null → **用户永远看不到更新提示**，只能手动重装；
- 发了 npm → 次日构建回填 → 更新角标生效。

条目里**不要**手写 `npm:` 字段，收录指南明确说会被校验拒绝，映射自动采集。

## 陷阱

- **不要移动已发布的 tag。** 删 tag 会让 GitHub 把 Release 降级成 draft（URL 变成 `untagged-xxxx`），对外不可见；`gh release upload` 仍会成功，所以不会报错。万一发生：`gh release edit <tag> --tag <tag> --draft=false --latest` 恢复。
- **npm 发布成功后流水线仍可能失败**（打包或 Release 步骤）。因为发布步骤幂等，直接重跑整条流水线即可，不会重复发版。
- **上传新资产后 CDN 可能短暂 404**，等几秒重试即可。
- 市场条目只在需要改描述时才动；此时从 `upstream/main` 切一个新分支、只改 `data/plugins/BuvkB__dsh-vaultwarden.yml` 一个文件，推 fork 后开 PR。