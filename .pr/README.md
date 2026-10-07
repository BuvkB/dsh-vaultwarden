# 上架 PR 提交材料（已提交）

提交目标：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
PR：#6211「Add BuvkB/dsh-vaultwarden (security)」，分支 `add/buvkb-dsh-vaultwarden`（head 为 fork BuvkB/awesome-dsh-plugin）。

## 当前状态

- PR #6211 于 2026-09-30 提交，OPEN，checks 通过（Submission gate pass；check pass）。
- 2026-10-01：随 v0.2.7 发版，把条目的 tarball 从 v0.2.4 更新到 v0.2.7（commit 58329e7b）。
- 2026-10-02：随 v0.3.0 发版（密文落盘缓存 + 修订号探针），把条目的 tarball 从 v0.2.7 更新到 v0.3.0。
- 2026-10-02：随 v0.3.1 发版（换令牌失败不再无差别删除会话），把条目的 tarball 从 v0.3.0 更新到 v0.3.1。
- 2026-10-05：随 v0.3.2 发版（Argon2id 的 KDF 内存单位、面板两处竞态守卫、前端测试可信度），把条目的 tarball 从 v0.3.1 更新到 v0.3.2。
- 2026-10-06：随 v0.4.0 发版（写回丢字段、软删实际彻底删除、回收站没有出口等 6 项 P0 与 8 项 P1），把条目的 tarball 从 v0.3.2 更新到 v0.4.0；条目的工具数描述同步从「seven」改为「nine」。
- 2026-10-06：随 v0.5.0 发版（面板补归档/回收站/移动写操作、回收站独立 chip、文件夹与归档筛选），把条目的 tarball 从 v0.4.0 更新到 v0.5.0。
- 2026-10-06：随 v0.5.1 发版（回收站条目在合并列表中的排序修复），把条目的 tarball 从 v0.5.0 更新到 v0.5.1。
- 2026-10-07：随 v0.5.2 发版（面板动态码恒显破折号、搜索框逐字闪白屏两处修复；peer 范围补到 0.2.1 线），把条目的 tarball 从 v0.5.1 更新到 v0.5.2。
- 2026-10-07：随 v0.5.3 发版（动态码倒计时由 30 秒横条改为会缩短的圆环，颜色随剩余时间由绿经橙渐变到红），把条目的 tarball 从 v0.5.2 更新到 v0.5.3。
- 2026-10-07：随 v0.6.0 发版（面板改成 Bitwarden App 式层级分区菜单 + 分区缓存、宿主侧新增 `vw/overview` 与 `section`/`sectionValue` 分区取数、服务端站点图标、验证码分区行、断点改容器查询），把条目的 tarball 从 v0.5.3 更新到 v0.6.0（commit b087e7706）。
- 条目文件：`data/plugins/BuvkB__dsh-vaultwarden.yml`（内容与本目录 `entry.yml` 一致）。

## 后续更新条目

改动只应落在一个文件：`data/plugins/BuvkB__dsh-vaultwarden.yml`（fork 仓库 BuvkB/awesome-dsh-plugin 的 `add/buvkb-dsh-vaultwarden` 分支）。更新 tarball 指向新版本后推送即可，无需关闭重开 PR。

注意：
- **只改这一个文件**，不要手工编辑 README（由脚本生成）。
- 若 CI 因年龄报红，**不要重新提交、不要强推空提交**——`regate.yml` 每 6 小时自动重跑，达标即转绿。
