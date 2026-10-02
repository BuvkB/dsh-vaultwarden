# 上架 PR 提交材料（已提交）

提交目标：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
PR：#6211「Add BuvkB/dsh-vaultwarden (security)」，分支 `add/buvkb-dsh-vaultwarden`（head 为 fork BuvkB/awesome-dsh-plugin）。

## 当前状态

- PR #6211 于 2026-09-30 提交，OPEN，checks 通过（Submission gate pass；check pass）。
- 2026-10-01：随 v0.2.7 发版，把条目的 tarball 从 v0.2.4 更新到 v0.2.7（commit 58329e7b）。
- 2026-10-02：随 v0.3.0 发版（密文落盘缓存 + 修订号探针），把条目的 tarball 从 v0.2.7 更新到 v0.3.0。
- 2026-10-02：随 v0.3.1 发版（换令牌失败不再无差别删除会话），把条目的 tarball 从 v0.3.0 更新到 v0.3.1。
- 条目文件：`data/plugins/BuvkB__dsh-vaultwarden.yml`（内容与本目录 `entry.yml` 一致）。

## 后续更新条目

改动只应落在一个文件：`data/plugins/BuvkB__dsh-vaultwarden.yml`（fork 仓库 BuvkB/awesome-dsh-plugin 的 `add/buvkb-dsh-vaultwarden` 分支）。更新 tarball 指向新版本后推送即可，无需关闭重开 PR。

注意：
- **只改这一个文件**，不要手工编辑 README（由脚本生成）。
- 若 CI 因年龄报红，**不要重新提交、不要强推空提交**——`regate.yml` 每 6 小时自动重跑，达标即转绿。
