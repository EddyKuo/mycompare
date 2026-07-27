/**
 * The P2 round's two user-facing additions, driven through the real UI.
 *
 * Both are the kind of feature this project has shipped unreachable before: a
 * store that round-trips and a panel that renders, with nothing in between.
 * These walk the path a user walks — open the dialog, untick the box, look at
 * the toolbar; load an image, open the info panel, read the header fields.
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

/** A 2×2 red PNG — 8-bit RGB, no interlace, no pHYs. */
const TINY_RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

test.beforeAll(async () => { ({ app, win } = await launchApp()) })
test.afterAll(async () => { await closeApp(app) })

async function goToImageCompare(page) {
  const viewImage = page.locator('#view-image')
  if (await viewImage.isVisible()) return
  await page.locator('#btn-new-session').click()
  await expect(page.locator('#session-home')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-type="image"].session-type-btn').click()
  await expect(viewImage).toBeVisible({ timeout: 5000 })
}

async function openCommandsPage() {
  await win.locator('#btn-settings-modal').click()
  await expect(win.locator('#settings-modal')).toBeVisible()
  await win.locator('#options-tab-commands').click()
  await expect(win.locator('#options-pane-commands')).toBeVisible()
}

test('unticking a command removes it from the toolbar and ticking brings it back', async () => {
  await openCommandsPage()

  const box = win.locator('#settings-commands-list input[data-command-id="swap"]')
  await expect(box).toBeChecked()
  await box.uncheck()
  await expect(win.locator('#btn-swap')).toBeHidden()

  await box.check()
  await expect(win.locator('#btn-swap')).toBeVisible()
  await win.locator('#btn-settings-modal-cancel').click()
})

test('a hidden command is still hidden after a reload', async () => {
  await openCommandsPage()
  await win.locator('#settings-commands-list input[data-command-id="swap"]').uncheck()
  await win.locator('#btn-settings-modal-cancel').click()

  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await expect(win.locator('#btn-swap')).toBeHidden()

  // Put it back, so the shared window does not carry this into later specs.
  await openCommandsPage()
  await win.locator('#settings-commands-list input[data-command-id="swap"]').check()
  await expect(win.locator('#btn-swap')).toBeVisible()
  await win.locator('#btn-settings-modal-cancel').click()
})

test('the command search narrows the list', async () => {
  await openCommandsPage()
  const rows = win.locator('#settings-commands-list input[type="checkbox"]')
  expect(await rows.count()).toBeGreaterThan(5)

  await win.locator('#inp-command-filter').fill('交換')
  await expect(rows).toHaveCount(1)

  await win.locator('#inp-command-filter').fill('')
  await win.locator('#btn-settings-modal-cancel').click()
})

test('the image info panel quotes the file header, not the decoder', async () => {
  await goToImageCompare(win)
  await win.evaluate(async (b64) => {
    await window.__testAPI?.imageSetLeft('left.png', b64, 'png')
    await window.__testAPI?.imageSetRight('right.png', b64, 'png')
  }, TINY_RED_PNG_B64)

  await win.locator('#view-image .ic-btn-info').click()
  const panel = win.locator('#view-image .ic-info-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('檔頭中繼資料')
  await expect(panel).toContainText('位元深度')
  await expect(panel).toContainText('交錯')
  await win.locator('#view-image .ic-btn-info').click()
})

test('the blend ratio slider is live only when there is an overlay', async () => {
  await goToImageCompare(win)

  const slider = win.locator('#view-image .ic-blend-slider')
  await expect(slider).toBeEnabled()

  await win.locator('#view-image .ic-overlay-select:not(.ic-highlight-select)').selectOption('normal')
  await expect(slider).toBeDisabled()

  await win.locator('#view-image .ic-overlay-select:not(.ic-highlight-select)').selectOption('blend')
  await expect(slider).toBeEnabled()
})
