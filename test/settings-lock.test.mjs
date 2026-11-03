/**
 * The profile lock is shared with the plugin market's install/update, which
 * holds it for a whole npm run. These checks pin the retry rule: short
 * contention is absorbed, a real failure still surfaces, and the message an
 * operator sees says what is happening instead of quoting the host's lock path.
 */
import { withSettingsLockRetry, SETTINGS_BUSY_MESSAGE } from '../lib/settings-write.js'

let passed = 0
let failed = 0
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1
    console.log('  ok ' + label)
  } else {
    failed += 1
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

const lockError = () =>
  new Error('atomic-write: timed out waiting for the writer lock at /home/demo/.dsh/profiles/web/package.json.lock')

/** Records the waits so a test can prove they happened and in order. */
const recorder = () => {
  const waits = []
  return { waits, sleep: async (ms) => { waits.push(ms) } }
}

console.log('settings write lock retry test')

{
  const { waits, sleep } = recorder()
  let calls = 0
  const value = await withSettingsLockRetry(
    async () => {
      calls += 1
      return 'written'
    },
    { sleep },
  )
  check('a free lock writes once', calls === 1 && value === 'written', JSON.stringify({ calls, value }))
  check('a free lock waits not at all', waits.length === 0, JSON.stringify(waits))
}

{
  const { waits, sleep } = recorder()
  let calls = 0
  const value = await withSettingsLockRetry(
    async () => {
      calls += 1
      if (calls < 3) throw lockError()
      return 'written'
    },
    { sleep },
  )
  check('a lock held for two attempts is absorbed', calls === 3 && value === 'written', JSON.stringify({ calls, value }))
  check('the waits grow between attempts', JSON.stringify(waits) === JSON.stringify([300, 700]), JSON.stringify(waits))
}

{
  const { waits, sleep } = recorder()
  let calls = 0
  let error = null
  try {
    await withSettingsLockRetry(
      async () => {
        calls += 1
        throw lockError()
      },
      { sleep },
    )
  } catch (caught) {
    error = caught
  }
  check('a lock that never frees gives up after the attempts', calls === 4, String(calls))
  check('giving up mentions the plugin market', error?.code === 'settings_busy' && String(error?.message).includes('插件市场'), JSON.stringify({ code: error?.code, message: error?.message }))
  check('giving up carries an actionable hint', typeof error?.hint === 'string' && error.hint.includes('插件市场'), String(error?.hint))
  check('the raw lock path does not reach the operator', !String(error?.message).includes('package.json.lock'), String(error?.message))
  check('the busy message is the exported one', error?.message === SETTINGS_BUSY_MESSAGE, String(error?.message))
  check('giving up stops waiting after the last delay', JSON.stringify(waits) === JSON.stringify([300, 700, 1500]), JSON.stringify(waits))
}

{
  const { waits, sleep } = recorder()
  let calls = 0
  let error = null
  try {
    await withSettingsLockRetry(
      async () => {
        calls += 1
        throw new Error('Config field "accessMode" is not volatile')
      },
      { sleep },
    )
  } catch (caught) {
    error = caught
  }
  check('an ordinary failure is not retried', calls === 1, String(calls))
  check('an ordinary failure keeps its own message', error?.message === 'Config field "accessMode" is not volatile', String(error?.message))
  check('an ordinary failure waits not at all', waits.length === 0, JSON.stringify(waits))
}

{
  const { waits, sleep } = recorder()
  const value = await withSettingsLockRetry(async () => ({ accessMode: 'auto' }), { sleep, delays: [] })
  check('an empty delay list still performs the write', value?.accessMode === 'auto' && waits.length === 0, JSON.stringify(value))
}

console.log('')
console.log('settings-lock: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exitCode = 1
