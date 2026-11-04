# 通行密钥导出与使用（CDP / Playwright / Selenium）

插件负责保管、解密和导出通行密钥；浏览器侧只负责执行标准 WebAuthn。**不需要修改 ego、Playwright、Puppeteer 或任何 CDP 插件。**

## 1. 文件里有什么

`bitwarden_passkey_export` 生成 `webauthn-credential/v2` 文件，权限 0600。核心是两个块：

```json
{
  "format": "webauthn-credential/v2",
  "entry": { "id": "...", "name": "..." },
  "passkey": { "userName": "...", "rpName": "...", "created": "..." },
  "cdp": {
    "credentialId": "标准 base64",
    "isResidentCredential": true,
    "rpId": "example.com",
    "privateKey": "标准 base64（PKCS#8 DER）",
    "userHandle": "标准 base64",
    "signCount": 0
  },
  "playwright": {
    "rpId": "example.com",
    "id": "base64url",
    "userHandle": "base64url",
    "privateKey": "base64url（PKCS#8 DER）",
    "publicKey": "base64url（SPKI DER）",
    "signCount": 0
  }
}
```

- `cdp`：标准 base64，供 Raw CDP、Puppeteer、Playwright 的 `CDPSession`、chrome-remote-interface、Selenium 使用。
- `playwright`：base64url + `publicKey`，供 Playwright 1.62+ 的 `context.credentials.create()` 使用。**非 resident（非 discoverable）凭据没有这个块**，文件里会写 `"playwright": null` 和 `"playwrightUnsupported": "non-resident"`。
- `v1` 旧文件只有 `cdp` 块，仍然可以导入；导入时优先读 `cdp`，没有则读 `playwright`。

## 2. 导出与清理

```bash
bitwarden_passkey_list <条目 id 或名称>
bitwarden_passkey_export <条目 id 或名称>
```

- 返回 `path`，不返回私钥；文件权限 0600。
- 返回 `counter` / `counterWarning`；`counter` 为 0 时提示可能被校验计数器的站点拒绝。
- 可选 `signCount: <整数>`：覆盖导出凭据的签名计数器（0..4294967295）；默认使用 vault 的 counter。
- 受 `accessMode` 控制：`readonly` 拒绝、`ask` 走 DSH 对话审批、`auto` 直接执行。
- 用完后立即执行 `bitwarden_passkey_cleanup`（可传 `path`；不传则清理全部 `.json` 和 `.tmp`）。
- 超过 24 小时的遗留文件会在下一次导出或插件启动时清理。
- **不要把文件内容读入对话/日志，也不要打印；只把 `path` 交给受控的浏览器自动化步骤。**

## 3. 通用 CDP 配方（所有 CDP 客户端共用）

虚拟认证器属于**当前 CDP 会话**：`enable` / `addVirtualAuthenticator` / `addCredential` / 真实点击必须放在同一个会话里；拆到不同调用/不同进程会报：

```text
The Virtual Authenticator Environment has not been enabled for this session
```

最小流程：

```js
const auth = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,          // discoverable 凭据必须
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
})
await cdp.send('WebAuthn.addCredential', {
  authenticatorId: auth.authenticatorId,
  credential: doc.cdp,
})
// 然后用真实鼠标事件点击站点自己的登录按钮
```

三条硬规则：

1. **不要 switchTab**：`switchTab` 会 `invalidateSession()`；ego 的每个脚本预置 `ensureRealTab` 也会调用它。`page.goto` 走 `Page.navigate`，不受影响。
2. **一个 environment 只能有一个 internal virtual authenticator**：第二个 `addVirtualAuthenticator` 会报 `Chrome only supports one internal authenticator per environment`。不要并发跑两个登录。
3. **必须真实点击**：用 `Input.dispatchMouseEvent` / `page.mouse.click`，不要用 `element.click()` 或 `dispatchEvent('click')`——合成事件 `isTrusted=false`，可能不满足 user activation。

## 4. 客户端矩阵

| 客户端 / 浏览器 | 读哪个块 | 支持情况 | 关键限制 |
|---|---|---|---|
| Raw CDP / chrome-remote-interface | `cdp` | Chrome / Edge / Brave / Opera / Arc / Electron | 同一 CDP session；不要 switchTab |
| Puppeteer | `cdp` | Chromium only | `page.createCDPSession()`；同一 session |
| Playwright（CDPSession） | `cdp` | Chromium only | `context.newCDPSession(page)`；同一 session |
| Playwright 1.62+ `context.credentials` | `playwright` | Chromium / Firefox / WebKit（页面级 polyfill，按版本实测） | base64url + `publicKey`；`signCount` 必须 0..0xffffffff；只支持 resident 凭据 |
| Selenium 4 Java/Python | `cdp` 解码 | Chrome / Edge only | `byte[]` / `PrivateKey`；不能 `Credential.fromMap(doc.cdp)` |
| Firefox / Safari（不走 Playwright） | — | 不支持 CDP 虚拟认证器 | 只能用 OS passkey / Bitwarden 扩展 / CTAP2 硬件密钥 |

## 5. 各客户端示例

### Raw CDP / chrome-remote-interface

```js
const session = await client.attachToTarget(targetId) // 保持同一个 session
await session.send('WebAuthn.enable')
const { authenticatorId } = await session.send('WebAuthn.addVirtualAuthenticator', { options: { /* 同上 */ } })
await session.send('WebAuthn.addCredential', { authenticatorId, credential: doc.cdp })
```

### Puppeteer

```js
const cdp = await page.createCDPSession()
await cdp.send('WebAuthn.enable')
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { /* 同上 */ } })
await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: doc.cdp })
```

### Playwright（CDPSession）

```js
const cdp = await context.newCDPSession(page)
await cdp.send('WebAuthn.enable')
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { /* 同上 */ } })
await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: doc.cdp })
```

### Playwright 1.62+ `context.credentials`

```js
const context = await browser.newContext()
await context.credentials.create(doc.playwright.rpId, {
  id: doc.playwright.id,
  userHandle: doc.playwright.userHandle,
  privateKey: doc.playwright.privateKey,
  publicKey: doc.playwright.publicKey,
  signCount: doc.playwright.signCount,
})
await context.credentials.install()
const page = await context.newPage()
// 页面里的 navigator.credentials.get() 会由这个虚拟认证器应答
```

注意：

- `publicKey` 必须和 `privateKey` 匹配；文件里的 `playwright` 块已经由插件从私钥派生。
- 如果 `privateKey`/`publicKey` 都不传，Playwright 会**生成一对新密钥**，那就不是密码库里的 passkey 了。
- `signCount` 必须 0..0xffffffff；插件对 `-1` 会写成 0。
- `context.credentials` 只建模 resident 凭据；非 discoverable 的 passkey 请用 `cdp` 块。

### Selenium 4（Java）

```java
byte[] id = Base64.getDecoder().decode((String) cdp.get("credentialId"));
byte[] userHandle = cdp.get("userHandle") == null ? null
    : Base64.getDecoder().decode((String) cdp.get("userHandle"));
byte[] der = Base64.getDecoder().decode((String) cdp.get("privateKey"));
PrivateKey key = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(der));
int signCount = ((Number) cdp.get("signCount")).intValue();

Credential cred = Credential.createResidentCredential(
    id, (String) cdp.get("rpId"), key, userHandle, signCount);
authenticator.addCredential(cred);
// 非 resident：Credential.createNonResidentCredential(id, rpId, key, signCount)
```

### Selenium 4（Python）

```python
import base64
from selenium.webdriver.common.virtual_authenticator import Credential

cdp = doc["cdp"]
cred = Credential.create_resident_credential(
    base64.b64decode(cdp["credentialId"]),
    cdp["rpId"],
    base64.b64decode(cdp["userHandle"]) if cdp.get("userHandle") else None,
    base64.b64decode(cdp["privateKey"]),
    int(cdp["signCount"]),
)
driver.add_credential(cred)
```

**不要直接 `Credential.fromMap(doc.cdp)`**：Java 的 `fromMap` 用 `Base64.getUrlDecoder()`，CDP 是标准 base64（`+/`）；而且 `signCount` 会被强转 `Long`，JSON 里的小整数常是 `Integer`，会 `ClassCastException`。Python 的 `from_dict` 也不是 CDP 直通，需先解码成 bytes。

### ego（只是其中一个宿主）

```js
const fs = await import('node:fs')
const doc = JSON.parse(fs.readFileSync('/path/to/exported.json', 'utf8'))

await cdp('WebAuthn.enable', {})
const auth = await cdp('WebAuthn.addVirtualAuthenticator', { options: { /* 同上 */ } })
await cdp('WebAuthn.addCredential', { authenticatorId: auth.authenticatorId, credential: doc.cdp })

const rect = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /passkey/i.test(x.innerText))
  const r = b.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})
await page.mouse.click(rect.x, rect.y)
```

**ego 必须用一次 `ego_script`/`ego_cli` heredoc 完成全流程**；`ego_cdp` 每次调用新进程/新 session，跨调用会报 `The Virtual Authenticator Environment has not been enabled for this session`。脚本里不要调用 `switchTab` / `openOrReuseTab` / `closeTab`。

## 6. 硬约束

- **Chromium-only（CDP 路径）**：Chrome / Edge / Brave / Opera / Arc / Electron 支持 CDP WebAuthn 虚拟认证器；Firefox 129 宣布弃用 CDP、Nightly 141 完全移除；Safari 无 CDP。非 Chromium 浏览器用 Playwright `context.credentials`（页面级 polyfill）或 OS passkey / Bitwarden 扩展 / CTAP2 硬件密钥。
- **secure context**：站点必须 HTTPS 或 localhost / 127.0.0.1；普通 HTTP 页面无法调用 WebAuthn。
- **rpId**：必须是站点 origin 的可注册域后缀；`WebAuthn.addCredential` 必填，填错凭据不会被选中。
- **user gesture**：站点登录按钮必须由真实用户手势触发；自动化用 `Input.dispatchMouseEvent` / `page.mouse.click`。
- **resident 凭据**：`isResidentCredential=true` 时 Chrome 强制要求 `userHandle`，且 `userHandle` 最多 64 字节；导出前插件会校验，缺 handle 或超长会直接拒绝。
- **signCount**：CDP 允许 `-1`（无计数器）；Playwright 只接受 0..0xffffffff。插件在 `cdp` 块保留原值，在 `playwright` 块把 `-1` 映射为 0。

## 7. 签名计数器（signCount）

WebAuthn 的签名计数器是防克隆机制：认证器每次断言都会递增 `signCount`，服务端可能拒绝“计数器没有变大”的断言。Bitwarden 条目里的 `counter` 有可能落后于服务端记录的值（尤其是通过文件 + 虚拟认证器使用过的 passkey），这时浏览器端断言会成功，但服务端返回通用错误。

处理方式：

- 先看 `bitwarden_passkey_export` 返回的 `counter` / `counterWarning`；
- 如果站点报通用错误但本地断言成功（credentialId、origin、rpIdHash 都对），把导出参数设为比上次更大的值，例如：

  ```text
  bitwarden_passkey_export <条目> signCount: 1000000
  ```

- 也可以在消费端读取文件后覆盖 `doc.cdp.signCount`，再 `WebAuthn.addCredential`；下一次需要更大的值。
- Playwright 块要求 `signCount` 在 0..0xffffffff；vault 的 `-1` 会被写成 0。

## 8. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `The Virtual Authenticator Environment has not been enabled for this session` | 认证器只在当前 CDP 会话有效，跨调用/换进程丢失 | 把 enable / addVirtualAuthenticator / addCredential / 点击放进同一个 session |
| `The User Handle is required for Resident Credentials` | resident 凭据缺 userHandle | 该 passkey 可能损坏；到官方客户端重新注册，或不要当 resident 用 |
| `The User Handle must have a maximum size of 64` | userHandle 超过 64 字节 | 同上，重新注册或修复源数据 |
| `Chrome only supports one internal authenticator per environment` | 同一环境已有认证器 | 串行执行；先 `removeVirtualAuthenticator` 或换一个浏览器环境 |
| `The Authenticator does not support Resident Credentials.` | 建认证器时 `hasResidentKey: false` | 改成 `hasResidentKey: true` |
| `OperationError: A request is already pending.` | 上一次 WebAuthn 请求还挂着 | 重新加载页面，再点一次；不要连续点 |
| 点击无反应 | 页面还没渲染出登录按钮 | 等页面加载完；用真实鼠标事件 |

## 9. 安全

导出文件内含私钥：只通过 0600 路径交接，**不要用文件读取工具打开它、不要把内容打印到对话或日志**。用完后立即 `bitwarden_passkey_cleanup`；24 小时 TTL 和启动清扫只是兜底，不是替代清理。

（本机通过 dsh-ego-browser 插件调用通行密钥成功；其他 CDP 浏览器未进行测试，如有问题请及时提出 issue。）
