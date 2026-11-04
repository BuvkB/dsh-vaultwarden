/**
 * Documentation contract for the multi-client passkey recipe. Agents and users
 * depend on these exact constraints; a silent reword can reintroduce the
 * mistakes the recipe exists to prevent.
 */
import { readFileSync } from 'node:fs'

const doc = readFileSync(new URL('../docs/passkey-login.md', import.meta.url), 'utf8')
let passed = 0
let failed = 0
const check = (label, condition) => {
  if (condition) {
    passed++
    console.log('  ✓ ' + label)
  } else {
    failed++
    console.error('  ✗ ' + label)
  }
}

const musts = [
  ['ego_cdp is named', 'ego_cdp'],
  ['ego_script is named', 'ego_script'],
  ['the no-switchTab rule is present', 'switchTab'],
  ['Chromium-only is stated', 'Chromium-only'],
  ['Firefox removal is stated', 'Firefox 129'],
  ['secure context is stated', 'secure context'],
  ['rpId is stated', 'rpId'],
  ['user gesture is stated', 'user gesture'],
  ['Selenium fromMap warning is present', 'Credential.fromMap(doc.cdp)'],
  ['the cdp block is documented', 'cdp'],
  ['the playwright block is documented', 'playwright'],
  ['publicKey is documented', 'publicKey'],
  ['signCount is documented', 'signCount'],
  ['counterWarning is documented', 'counterWarning'],
  ['the cross-session error is quoted', 'The Virtual Authenticator Environment has not been enabled for this session'],
]
for (const [label, needle] of musts) check(label, doc.includes(needle))

console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
