/**
 * e2e for the text-compare view panels added in P2-29 / P3:
 * Details (Text / Hex / Alignment), Ruler, File Info, Description box and the
 * per-side editing lock.
 *
 * These are reachable only from the pane context menu, so the spec drives the
 * real menu rather than calling the view directly — the unit tests already
 * cover the logic; what needs proving here is that a user can get to it.
 *
 * Run with: npm run test:e2e   (prerequisite: npm run build)
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

test.beforeAll(async () => {
  ;({ app, win } = await launchApp())
})

test.afterAll(async () => {
  await closeApp(app)
})

/** @param {import('@playwright/test').Page} page */
async function goToTextCompare(page) {
  const home = page.locator('#session-home')
  const viewText = page.locator('#view-text')
  if (await home.isVisible()) {
    await page.locator('[data-type="text"].session-type-btn').click()
  } else if (!(await viewText.isVisible())) {
    await page.locator('#btn-new-session').click()
    await expect(home).toBeVisible({ timeout: 5000 })
    await page.locator('[data-type="text"].session-type-btn').click()
  }
  await expect(viewText).toBeVisible({ timeout: 5000 })
}

/**
 * Open the left pane's context menu and click the item whose label contains
 * `label`.
 * @param {import('@playwright/test').Page} page
 * @param {string} label
 */
async function contextMenuClick(page, label) {
  await page.locator('#content-left').click({ button: 'right', position: { x: 40, y: 10 } })
  const menu = page.locator('.ctx-menu')
  await expect(menu).toBeVisible({ timeout: 3000 })
  await menu.locator('.ctx-item', { hasText: label }).first().click()
  await expect(menu).toBeHidden({ timeout: 3000 }).catch(() => {})
}

/**
 * Toggle a panel only if it is not already in the wanted state — the specs
 * share one app instance, so a blind toggle would depend on test order.
 * @param {import('@playwright/test').Page} page
 * @param {string} label
 * @param {string} selector
 * @param {boolean} want
 */
async function ensurePanel(page, label, selector, want) {
  const present = (await page.locator(selector).count()) > 0
  if (present !== want) await contextMenuClick(page, label)
  await expect(page.locator(selector)).toHaveCount(want ? 1 : 0)
}

test('右鍵選單提供標尺 / 檔案資訊 / 說明欄，且可再次關閉', async () => {
  await goToTextCompare(win)

  await ensurePanel(win, '欄位標尺', '.tc-ruler', true)
  // Exactly two scales (one per pane), each a single text node.
  await expect(win.locator('.tc-ruler__scale')).toHaveCount(2)
  expect(await win.locator('.tc-ruler__scale').first().evaluate(el => el.children.length)).toBe(0)

  await ensurePanel(win, '檔案資訊', '.tc-fileinfo', true)
  await ensurePanel(win, '說明欄', '.tc-description', true)
  await win.locator('.tc-description__input').fill('e2e 說明')
  expect(await win.locator('.tc-description__input').inputValue()).toBe('e2e 說明')

  await ensurePanel(win, '欄位標尺', '.tc-ruler', false)
  await ensurePanel(win, '說明欄', '.tc-description', false)
})

test('三種詳細資料面板可切換，且互斥只有一個面板', async () => {
  await goToTextCompare(win)

  await contextMenuClick(win, '詳細資料：文字')
  await expect(win.locator('.tc-details')).toHaveCount(1)
  await expect(win.locator('.tc-details__tab.active')).toHaveAttribute('data-mode', 'text')

  await win.locator('.tc-details__tab[data-mode="hex"]').click()
  await expect(win.locator('.tc-details__tab.active')).toHaveAttribute('data-mode', 'hex')

  await win.locator('.tc-details__tab[data-mode="alignment"]').click()
  await expect(win.locator('.tc-details__tab.active')).toHaveAttribute('data-mode', 'alignment')

  // The comparison panes are still there and still scrollable.
  await expect(win.locator('#content-left')).toBeVisible()

  await win.locator('.tc-details__close').click()
  await expect(win.locator('.tc-details')).toHaveCount(0)
})

test('可鎖定單側編輯，狀態顯示於檔案資訊', async () => {
  await goToTextCompare(win)

  await ensurePanel(win, '檔案資訊', '.tc-fileinfo', true)
  await contextMenuClick(win, '鎖定左側')
  await expect(win.locator('.tc-fileinfo__row').first()).toContainText('🔒')

  await contextMenuClick(win, '鎖定左側')
  await expect(win.locator('.tc-fileinfo__row').first()).not.toContainText('🔒')
  await ensurePanel(win, '檔案資訊', '.tc-fileinfo', false)
})

test('文法選單反映目前檔案格式', async () => {
  await goToTextCompare(win)
  await win.locator('#content-left').click({ button: 'right', position: { x: 40, y: 10 } })
  const menu = win.locator('.ctx-menu')
  await expect(menu).toBeVisible({ timeout: 3000 })
  // With nothing loaded there is no file format, and the menu says so instead
  // of offering elements that do not exist.
  await expect(menu.locator('.ctx-item', { hasText: '文法：' })).toHaveCount(1)
  await win.keyboard.press('Escape')
})
