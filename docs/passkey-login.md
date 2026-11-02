# 通行密钥登录（CDP 配方）

插件负责保管、解密和导出通行密钥；浏览器侧只负责执行标准 WebAuthn。**不需要修改 ego、Playwright 或任何 CDP 插件。**

## 1. 确认凭据

```bash
bitwarden_passkey_list <条目 id 或名称>
```

返回的 `passkey.discoverable` / `usableForLogin` 为 true 时，才支持「输入框留空、点一次登录按钮」这类 **免用户名** 的通行密钥登录（Telegram Web 就是这种）。非 discoverable 的凭据需要站点在 `allowCredentials` 里点名，通常不适合这种入口。

## 2. 导出（0600 文件）

```bash
bitwarden_passkey_export <条目 id 或名称>
```

- 返回 `path`（不返回私钥），文件权限 0600，含 `cdp` 块；
- 受 `accessMode` 控制：`readonly` 拒绝、`ask` 走 DSH 对话审批、`auto` 直接执行；
- 超过 24 小时的导出文件会在下一次导出时自动清理；用后仍建议立即删除；
- 每次导出会向 `passkeys/audit.jsonl` 追加一条 0600 审计记录：时间、条目 id、rpId、权限档与来源（model/panel），不含私钥。

## 3. 注入浏览器（一个 CDP 会话内完成）

虚拟认证器属于 **当前 CDP 会话**：`enable` / `addVirtualAuthenticator` / `addCredential` / 点击必须放在同一次调用里；跨调用会报 `The Virtual Authenticator Environment has not been enabled for this session`。

用 ego 时（`ego_script` 的 `cdp()` 就是原样转发）：

```js
const fs = await import('node:fs')
const doc = JSON.parse(fs.readFileSync('/path/to/exported.json', 'utf8'))

await cdp('WebAuthn.enable', {})
const auth = await cdp('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
})
await cdp('WebAuthn.addCredential', { authenticatorId: auth.authenticatorId, credential: doc.cdp })

// 同一个脚本里点击登录按钮（坐标由 page.evaluate 取）
const rect = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /passkey/i.test(x.innerText))
  const r = b.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})
await page.mouse.click(rect.x, rect.y)
```

Playwright / Puppeteer 用同样的 CDP 方法名即可：

```js
const cdp = await page.context().newCDPSession(page)
await cdp.send('WebAuthn.enable')
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { /* 同上 */ } })
await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: doc.cdp })
```

## 4. Telegram Web 示例

1. 用插件导出 `telegram.org` 条目的通行密钥；
2. 打开 `https://web.telegram.org/a/`；
3. 在同一 `ego_script` 里执行上面的 WebAuthn 设置，然后点「LOG IN WITH PASSKEY」；
4. 登录后立即删除导出文件。

## 5. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `The Virtual Authenticator Environment has not been enabled for this session` | 认证器只在当前 CDP 会话有效，跨调用丢失 | 把 enable/建认证器/装凭据/点击放进同一次 `ego_script` |
| `OperationError: A request is already pending.` | 上一次 WebAuthn 请求还挂着 | 重新加载页面，再点一次；不要连续点 |
| 点击无反应 | 页面还没渲染出登录按钮 | 用 `ego_navigate` 等页面加载完成后再执行脚本 |
| `passkey_proof_required` | 运行中的插件还是旧模块 | 重启插件/宿主，或重新保存插件设置触发热加载 |

导出文件内含私钥：只通过 0600 路径交接，不要把文件内容打印到对话或日志。
