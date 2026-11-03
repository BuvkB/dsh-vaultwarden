/**
 * Writes through the host settings service, with one retry rule.
 *
 * Every profile write in DSH serializes on a single lock
 * (`<profile>/package.json.lock`) and the lock helper only waits two seconds
 * for it (DEFAULT_LOCK_WAIT_MS in @deepseek-ai/dsh-atomic-write). The plugin
 * market takes that same lock for a whole npm install or update — measured at
 * 72 seconds for one dsh-pet update — so a panel write that lands in that
 * window fails on a timeout that says nothing about this plugin or the value
 * it was writing.
 *
 * Retrying is the right answer for that contention: the holder will finish,
 * and the write the operator already confirmed still deserves to land. A
 * failure after the retries have run out is not a permission problem, so the
 * error names what is really happening instead of forwarding the host's lock
 * path to a reader who cannot act on it.
 */
import { VaultError } from './vault.js'

/** The host's own wording; matched rather than the path so a moved profile
 *  still matches. */
const LOCK_TIMEOUT = /timed out waiting for the writer lock/

export const SETTINGS_BUSY_MESSAGE =
  '插件配置暂时被其他操作占用（插件市场可能正在安装或更新插件），请等它完成后再试。'

/** How long to keep trying, and how long to wait between attempts. Sized for
 *  the install window's short tail: three tries spread over ~2.5s, on top of
 *  the two seconds each attempt already spends waiting for the lock. */
const DEFAULT_DELAYS = [300, 700, 1500]

/**
 * Run one settings write, retrying while the profile lock is held elsewhere.
 *
 * @template T
 * @param {() => Promise<T>} run - the settings call to perform
 * @param {{ delays?: number[], sleep?: (ms: number) => Promise<void> }} [options] - test seams
 * @returns {Promise<T>} whatever `run` returned
 */
export async function withSettingsLockRetry(run, options = {}) {
  const delays = Array.isArray(options.delays) ? options.delays : DEFAULT_DELAYS
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      const busy = LOCK_TIMEOUT.test(String(error?.message ?? ''))
      if (!busy || attempt >= delays.length) {
        if (busy) {
          throw new VaultError(SETTINGS_BUSY_MESSAGE, {
            code: 'settings_busy',
            hint: '打开「插件市场」查看是否有进行中的安装或更新；它完成后重试一次即可，已保存的配置不受影响。',
          })
        }
        throw error
      }
      await sleep(delays[attempt])
    }
  }
}
