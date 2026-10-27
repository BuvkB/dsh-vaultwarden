# 发版步骤

## 一句话

跑门禁 → 提交并推 main → 打 tag → `npm publish` → `npm pack` → 建 Release 并**同时上传带版本号与不带版本号两个资产** → 三道复验。

**市场条目不需要再动，但 npm 必须发。** v0.8.1 起条目的 tarball 指向 `releases/latest/download/dsh-vaultwarden.tgz`（不带版本号的稳定资产名），GitHub 会自动解析到最新 release，因此发新版本不再产生市场 PR。

**但「发版即自动更新」还依赖 npm。** 市场判断某条目有没有新版本时，走的是 `dsh-market` 的 `lib/updates.js`：目录条目的 `npm` 字段有值时，才拿 registry 的 `dist-tags.latest` 和用户已装版本比较。目录的 `npm` 字段来自 `awesome-dsh-plugin` 每天 02:23 UTC 的 `probe-npm.mjs`——它读仓库 `package.json` 的 `name`，再去 registry 校验 `repository` 是否指回本仓库。所以：

- 只推 GitHub、不发 npm → 目录 `npm` 恒为 null → **用户永远看不到更新提示**，只能手动重装；
- 发了 npm → 次日构建回填 → 更新角标生效。

条目里**不要**手写 `npm:` 字段，收录指南明确说会被校验拒绝，映射自动采集。

## 详细步骤

```sh
cd /home/tinyog/dsh/dsh-vaultwarden

# 1. 门禁（二十三套离线测试，共 1557 项；native-row 与 cli-interop 视环境自跳过）
bash scripts/build.sh

# 2. 版本号与 CHANGELOG 改好后提交、推 main
git add -A && git commit -m 'fix(xxx): ...'   # 日志只写「修复 xxx / 新增 xxx」
git push origin main

# 3. 打 tag 并推送（务必先让 tag 指向最终 commit，推完不要再移动）
git tag -a v0.8.2 -m 'v0.8.2：...' && git push origin v0.8.2

# 4. 发布到 npm（市场更新提示的来源，漏了这一步用户就看不到更新）
npm publish                            # 需要 ~/.npmrc 里的 npmjs token
npm view dsh-vaultwarden version       # 确认 latest 已是新版本

# 5. 打包
npm pack --silent                      # -> dsh-vaultwarden-0.8.2.tgz
sha256sum dsh-vaultwarden-0.8.2.tgz

# 6. 建 Release，两个资产都传
cp dsh-vaultwarden-0.8.2.tgz /tmp/dsh-vaultwarden.tgz
gh release create v0.8.2 \
  --title 'v0.8.2：...' \
  --notes-file /tmp/notes-0.8.2.md \
  dsh-vaultwarden-0.8.2.tgz /tmp/dsh-vaultwarden.tgz
```

`--notes-file` 只放**当前版本**那一段 CHANGELOG，别贴整份文件。

## 为什么要有无版本号的那一个

| 资产 | 用途 |
| --- | --- |
| `dsh-vaultwarden-0.8.2.tgz` | 人工核对、归档、写进 Release 正文的直链 |
| `dsh-vaultwarden.tgz` | 市场条目与 `latest/download` 用的稳定名，**每次发版都覆盖它** |

两者内容完全一致（同一 sha256）。有版本号的那个让「这份 tgz 是哪个版本」一眼可查；无版本号的那个让 URL 永远不变。

## 三道复验

1. 从 `https://github.com/BuvkB/dsh-vaultwarden/releases/latest/download/dsh-vaultwarden.tgz` 下载，核对 sha256 与本地一致；同时核对 GitHub 记录的 digest。
2. 解包，检查修复标记齐全（每次发版按当版改动的关键字查）、`package/package.json` 版本号正确、`node --check` 全部 lib 文件通过。
3. 对比发布产物与源码：`lib/client.js`、`CHANGELOG.md` 应逐字节一致。

界面效果由作者本人在真实 GUI 里看，不列入发版门禁：自动化开浏览器只能证明「没白屏」，证明不了观感对不对，而它的代价是每次发版都要维护一套浏览器环境。

## 陷阱

- **不要移动已发布的 tag。** 删 tag 会让 GitHub 把 Release 降级成 draft（URL 变成 `untagged-xxxx`），对外不可见；`gh release upload` 仍会成功，所以不会报错。万一发生：`gh release edit <tag> --tag <tag> --draft=false --latest` 恢复。
- **上传新资产后 CDN 可能短暂 404**，等几秒重试即可。
- 市场条目只在需要改描述时才动；此时从 `upstream/main` 切一个新分支、只改 `data/plugins/BuvkB__dsh-vaultwarden.yml` 一个文件，推 fork 后开 PR。