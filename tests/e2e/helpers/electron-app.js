import { _electron as electron } from '@playwright/test'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Absolute path to project root (three levels up from tests/e2e/helpers/) */
const ROOT = join(__dirname, '../../..')

/**
 * Launch the Electron app from the built output.
 * Prerequisites: `npm run build` must have been executed beforehand.
 *
 * @returns {Promise<{ app: import('@playwright/test').ElectronApplication, win: import('@playwright/test').Page }>}
 */
export async function launchApp() {
  const mainEntry = join(ROOT, 'out/main/index.js')

  const app = await electron.launch({
    args: [mainEntry],
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
