/**
 * Password flow: masked reads, scalar reveals, placeholder handles, write guards,
 * field-level custom fields and the hidden-field projection.
 *
 * Run: node test/secret-flow.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { VaultClient } from '../lib/vault.js'
import { VaultMutations } from '../lib/mutations.js'
import { EMAIL, PASSWORD, startMockServer } from './mock-server.mjs'

const home = mkdtempSync(join(tmpdir(), 'bw-secret-flow-'))
process.env.DSH_HOME = home
let passed = 0
let failed = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    passed++
    console.log('  ✓ ' + label)
  } else {
    failed++
    console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''))
  }
}

const makeHost = (server, extra = {}) => {
  const tools = []
  const ctx = {
    effect: (fn) => fn(),
    on: () => () => {},
    plugin: () => ({}),
    systemPrompt: { section: () => () => {} },
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    inject: (_services, callback) => callback({
      effect: (fn) => fn(),
      settings: { update: async () => {}, describe: () => [] },
      slots: { inject: () => {}, register: () => () => {} },
      webServer: { register: () => { throw new Error('no HTTP route') } },
    }),
  }
  apply(ctx, {
    serverUrl: server.url,
    email: EMAIL,
    masterPassword: PASSWORD,
    apiKeyClientId: '',
    apiKeyClientSecret: '',
    websocket: false,
    pollIntervalSeconds: 3600,
    cacheMinutes: 30,
    deviceIdentifier: '',
    accessMode: 'readonly',
    maskEnabled: true,
    maskMode: true,
    ...extra,
  })
  return tools
}
const tool = (tools, name) => tools.find((entry) => entry.name === name)

async function main() {
  const server = await startMockServer({ richCipher: true })
  if (!server) {
    console.log('  ! hash-wasm missing — skipping')
    process.exit(0)
  }
  try {
    const tools = makeHost(server)
    const getTool = tool(tools, 'bitwarden_get')
    const revealTool = tool(tools, 'bitwarden_reveal')
    const updateTool = tool(tools, 'bitwarden_update')

    // 1. masked read -----------------------------------------------------------------
    const masked = JSON.parse(await getTool.execute({ id: 'cipher-github', field: 'password' }))
    check('masked read marks itself before the payload', Object.keys(masked)[0] === '_masked' && masked._masked === true)
    check('masked read lists the masked field', masked._maskedFields?.includes('password'))
    check('masked read returns a placeholder, not plaintext', /^\{\{BW_PASSWORD_[a-z2-7]{8}\}\}$/.test(String(masked.passwordMasked)))
    // The credential key itself must be gone: a call site that reads
    // `payload.password` has to fail loudly instead of quietly receiving a
    // look-alike string it would then type into a form.
    check('masked read withholds the pristine password key', !('password' in masked))
    check('masked read carries a reveal hint', /bitwarden_reveal/.test(String(masked._hint)) && /Masked/.test(String(masked._hint)))

    // 2. hidden custom fields are typed, not a fake string ---------------------------
    const all = JSON.parse(await getTool.execute({ id: 'cipher-github', field: 'all' }))
    const hidden = all.fields.find((entry) => entry.name === 'API Token')
    check('hidden custom field is typed', hidden?.hidden === true && hidden?.value === null)
    check('ordinary custom field stays readable', all.fields.find((entry) => entry.name === '租户')?.value === 'jindom')
    check('hidden custom field is listed in _maskedFields', all._maskedFields?.some((path) => path.startsWith('fields[')))

    // 3. reveal returns one scalar value --------------------------------------------
    const revealed = JSON.parse(await revealTool.execute({ id: 'cipher-github' }))
    check('reveal returns a scalar value', revealed.ok === true && revealed.field === 'password' && typeof revealed.value === 'string')
    check('reveal value is the plaintext password', revealed.value === 'gh-p@ssw0rd-42')
    check('reveal does not include the whole projection', !('password' in revealed) && !('notes' in revealed))

    // 4. a placeholder is itself a usable handle --------------------------------------
    const byHandle = JSON.parse(await revealTool.execute({ placeholder: masked.passwordMasked }))
    check('reveal by placeholder resolves the exact entry', byHandle.value === revealed.value && byHandle.entry?.id === 'cipher-github')
    check('reveal by placeholder keeps the field name', byHandle.field === 'password')

    // 5. custom field by name ---------------------------------------------------------
    const custom = JSON.parse(await revealTool.execute({ id: 'cipher-github', field: 'fields', fieldName: 'API Token' }))
    check('reveal fieldName returns only the named custom field', custom.value === 'tok_live_abc123' && custom.fieldName === 'API Token')
    const fieldsView = JSON.parse(await getTool.execute({ id: 'cipher-github', field: 'fields' }))
    const customFieldView = fieldsView.fields?.find((entry) => entry.name === 'API Token')
    const customPlaceholder = customFieldView?.valueMasked ?? customFieldView?.value
    check('masked custom field withholds the pristine value key', !('value' in (customFieldView ?? {})))
    const customByHandle = JSON.parse(await revealTool.execute({ placeholder: customPlaceholder }))
    check('a custom-field placeholder resolves to that exact field', customByHandle.value === 'tok_live_abc123' && customByHandle.fieldName === 'API Token')
    const filteredGet = JSON.parse(await getTool.execute({ id: 'cipher-github', field: 'all', fieldName: 'API Token' }))
    check('bitwarden_get fieldName filters the fields array', filteredGet.fields?.length === 1 && filteredGet.fields[0].name === 'API Token')
    const history = JSON.parse(await revealTool.execute({ id: 'cipher-rich', field: 'passwordHistory', index: 0 }))
    check('history reveal marks the value as not current', history.current === false && history.value === 'rich-pass-0')

    // 6. stale placeholder is loud ---------------------------------------------------
    const staleText = String(await revealTool.execute({ placeholder: '{{BW_PASSWORD_aaaaaaaa}}' }))
    check('unknown placeholder does not silently reveal another entry', /placeholder 已失效/.test(staleText) && !staleText.includes('gh-p@ssw0rd-42'))

    // 7. hidden sentinel cannot be written back ---------------------------------------
    const vc = new VaultClient({
      serverUrl: server.url,
      email: EMAIL,
      masterPassword: PASSWORD,
      apiKeyClientId: '',
      apiKeyClientSecret: '',
      cacheMinutes: 30,
    })
    await vc.unlock()
    const muts = new VaultMutations(vc, { guard: () => null })
    const onlyHidden = await muts.create({
      name: 'Only hidden probe',
      type: 'login',
      fields: [{ name: 'token', value: 'secret-xyz', type: 1 }],
    })
    const skeleton = await vc.revealEntry('cipher-github', 'all', undefined, { skeleton: true })
    check('panel detail skeleton carries no password or notes', !('password' in skeleton) && !('notes' in skeleton) && skeleton.hasPassword === true)
    check('panel detail skeleton only names the fields', skeleton.fields?.length > 0 && skeleton.fields.every((field) => field.value === null) && skeleton.fields.some((field) => field.hidden === true))

    const onlyProjection = JSON.parse(await getTool.execute({ id: onlyHidden.id, field: 'all' }))
    check('a hidden-only entry still gets a masked marker', onlyProjection._masked === true && onlyProjection._maskedFields?.includes('fields[0]'))
    const blocked = String(await updateTool.execute({ id: onlyHidden.id, fields: JSON.stringify(onlyProjection.fields) }))
    check('hidden projection cannot be written back', /不能把脱敏占位符写回密码库/.test(blocked))

    const mergeProbe = await muts.create({
      name: 'Merge probe',
      type: 'login',
      fields: [
        { name: 'tenant', value: 'acme', type: 0 },
        { name: 'token', value: 'keep-me', type: 1 },
      ],
    })
    await muts.update(mergeProbe.id, { fields: [{ name: 'tenant', value: 'new-tenant' }] })
    const merged = JSON.parse(await vc.get(mergeProbe.id, 'fields'))
    const mergedTenant = merged.fields.find((entry) => entry.name === 'tenant')
    const mergedToken = merged.fields.find((entry) => entry.name === 'token')
    check('one-field update merges rather than replacing the list', mergedTenant?.value === 'new-tenant' && mergedToken?.value === 'keep-me')
    check('one-field update preserves the hidden type', mergedToken?.type === 1)

    // 8. mask off still reveals -------------------------------------------------------
    const offTools = makeHost(server, { maskEnabled: false, maskMode: false })
    const offReveal = JSON.parse(await tool(offTools, 'bitwarden_reveal').execute({ id: 'cipher-github', field: 'password' }))
    check('mask off reveal returns plaintext instead of guidance', offReveal.value === 'gh-p@ssw0rd-42' && offReveal.masked === false)
    const offGet = String(await tool(offTools, 'bitwarden_get').execute({ id: 'cipher-github', field: 'password' }))
    check('mask off get is plaintext', offGet.includes('gh-p@ssw0rd-42') && !offGet.includes('_masked'))

    // 9. a secret read probes the server rather than trusting a young cache --------
    const freshA = new VaultClient({
      serverUrl: server.url,
      email: EMAIL,
      masterPassword: PASSWORD,
      apiKeyClientId: '',
      apiKeyClientSecret: '',
      cacheMinutes: 30,
    })
    const freshB = new VaultClient({
      serverUrl: server.url,
      email: EMAIL,
      masterPassword: PASSWORD,
      apiKeyClientId: '',
      apiKeyClientSecret: '',
      cacheMinutes: 30,
    })
    await freshA.unlock()
    await freshB.unlock()
    await new VaultMutations(freshB, { guard: () => null }).update('cipher-github', { password: 'rotation-wins' })
    const stale = JSON.parse(await freshA.get('cipher-github', 'password'))
    const current = JSON.parse(await freshA.get('cipher-github', 'password', undefined, { fresh: true }))
    check('a secret read refuses to serve a stale rotation', stale.password !== 'rotation-wins')
    check('a fresh secret read picks up the external rotation', current.password === 'rotation-wins')
  } finally {
    await server.close()
    rmSync(home, { recursive: true, force: true })
  }
  console.log('')
  console.log(passed + ' passed, ' + failed + ' failed')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
