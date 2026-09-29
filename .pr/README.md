# 上架 PR 提交材料（待提交）

提交目标：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
分支名建议：`add/buvkb-dsh-vaultwarden`

## 为什么还没提交

仓库创建于 2026-09-29 08:21 UTC，CI 要求**创建满 1 天**。
本地已用仓库自带的 `scripts/check-submission.mjs` 预跑，唯一未通过项就是年龄：

```
repository is 0.1 days old (needs 1) — nothing to do: this check re-runs
by itself and should clear in about 23h. No need to resubmit, push, or
close and reopen; the age bar is the only thing failing here.
```

`dsh.bundle` manifest、tarball URL、条目格式均已通过校验。

## 提交步骤

```sh
gh repo clone awesome-dsh-plugin/awesome-dsh-plugin /tmp/awesome
cd /tmp/awesome
git checkout -b add/buvkb-dsh-vaultwarden
cp <此目录>/entry.yml data/plugins/BuvkB__dsh-vaultwarden.yml
git add data/plugins/BuvkB__dsh-vaultwarden.yml
git commit -m "Add BuvkB/dsh-vaultwarden"
git push -u origin add/buvkb-dsh-vaultwarden
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add BuvkB/dsh-vaultwarden" \
  --body "..."
```

注意：
- **只加这一个文件**，不要手工编辑 README（由脚本生成）。
- 若 CI 因年龄报红，**不要重新提交、不要强推空提交**——`regate.yml` 每 6 小时自动重跑，达标即转绿。
