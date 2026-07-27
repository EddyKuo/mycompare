import { _electron as electron } from '@playwright/test'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Absolute path to project root (three levels up from tests/e2e/helpers/) */
const ROOT = join(__dirname, '../../..')

/**
 * A throwaway Electron profile for this worker.
 *
 * Without it every run reads and writes the developer's real profile: the
 * settings a test changes are still there for the next test, for the next run,
 * and for the actual application. That made the suite order-dependent, and it
 * hid a genuine bug — a corrected default in DEFAULT_PREFS kept reading as the
 * old value, because the old one had been persisted by an earlier run and
 * stored preferences win over defaults.
 *
 * One directory per worker process, shared by every app this file launches, so
 * a test that opens a second window still sees the first one's state.
 */
const PROFILE = mkdtempSync(join(tmpdir(), 'mycompare-e2e-profile-'))

process.on('exit', () => {
  try { rmSync(PROFILE, { recursive: true, force: true }) } catch { /* best effort on exit */ }
})

/**
 * Launch the Electron app from the built output.
 * Prerequisites: `npm run build` must have been executed beforehand.
 *
 * @param {string[]} [extraArgs] positional paths passed on the command line.
 *   The main process registers CLI arguments as allowed roots, which is how a
 *   test authorises a fixture directory without a file dialog.
 * @returns {Promise<{ app: import('@playwright/test').ElectronApplication, win: import('@playwright/test').Page }>}
 */
export async function launchApp(extraArgs = []) {
  const mainEntry = join(ROOT, 'out/main/index.js')

  const app = await electron.launch({
    // The switch goes after the entry point on purpose. parseCli() reads
    // process.argv from index 2, so a switch placed before the entry would
    // push the entry itself into that window and register the built main
    // script as an allowed root.
    args: [mainEntry, `--user-data-dir=${PROFILE}`, ...extraArgs],
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
  })

  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  return { app, win }
}

/**
 * Close the Electron app gracefully.
 * @param {import('@playwright/test').ElectronApplication} app
 */
export async function closeApp(app) {
  await app.close()
}
