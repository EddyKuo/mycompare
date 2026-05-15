/**
 * Theme toggle e2e tests for MyCompare.
 *
 * Covers: initial theme detection, toggle via btn-theme, persistence across navigation.
 *
 * Run with: npm run test:e2e
 * Prerequisite: npm run build
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the current data-theme attribute on <html> */
async function getTheme(page) {
  return page.evaluate(() => document.documentElement.dataset.theme)
}

// ---------------------------------------------------------------------------
// Theme tests
// ---------------------------------------------------------------------------

test('初始 html[data-theme] 為 "light" 或 "dark"', async () => {
  const theme = await getTheme(win)
  expect(['light', 'dark']).toContain(theme)
})

test('btn-theme 按鈕存在且可見', async () => {
  await expect(win.locator('#btn-theme')).toBeVisible()
})

test('點擊 btn-theme 後 data-theme 切換', async () => {
  const before = await getTheme(win)
  await win.locator('#btn-theme').click()
  const after = await getTheme(win)

  // Must have changed
  expect(after).not.toBe(before)
  // Must be a valid theme value
  expect(['light', 'dark']).toContain(after)
})

test('再點一次 btn-theme 還原為原始主題', async () => {
  // Record state after first toggle (from previous test), click again to restore
  const before = await getTheme(win)
  await win.locator('#btn-theme').click()
  const after = await getTheme(win)
  expect(after).not.toBe(before)
  expect(['light', 'dark']).toContain(after)
})

test('主題切換後 data-theme 值為 "light" 或 "dark"（不為 undefined）', async () => {
  await win.locator('#btn-theme').click()
  const theme = await getTheme(win)
  expect(theme).toBeDefined()
  expect(['light', 'dark']).toContain(theme)
  // Restore
  await win.locator('#btn-theme').click()
})

test('主題值儲存於 localStorage（mycompare:theme）', async () => {
  // Get current theme
  const currentTheme = await getTheme(win)

  // Check localStorage has the value
  const stored = await win.evaluate(() => localStorage.getItem('mycompare:theme'))
  expect(stored).toBe(currentTheme)
})

test('切換主題後 localStorage 值同步更新', async () => {
  const beforeTheme = await getTheme(win)
  await win.locator('#btn-theme').click()
  const afterTheme = await getTheme(win)

  const stored = await win.evaluate(() => localStorage.getItem('mycompare:theme'))
  expect(stored).toBe(afterTheme)
  expect(stored).not.toBe(beforeTheme)

  // Restore
  await win.locator('#btn-theme').click()
})

test('切換到 text-compare view 後，data-theme 仍然保持', async () => {
  const themeBefore = await getTheme(win)

  // Navigate to text compare
  const home = win.locator('#session-home')
  if (!(await home.isVisible())) {
    await win.locator('#btn-new-session').click()
    await expect(home).toBeVisible({ timeout: 5000 })
  }
  await win.locator('[data-type="text"].session-type-btn').click()
  await expect(win.locator('#view-text')).toBeVisible({ timeout: 5000 })

  const themeAfter = await getTheme(win)
  expect(themeAfter).toBe(themeBefore)
})

test('切換到 folder-compare view 後，data-theme 仍然保持', async () => {
  const themeBefore = await getTheme(win)

  // Navigate to folder compare
  const home = win.locator('#session-home')
  if (!(await home.isVisible())) {
    await win.locator('#btn-new-session').click()
    await expect(home).toBeVisible({ timeout: 5000 })
  }
  await win.locator('[data-type="folder"].session-type-btn').click()
  await expect(win.locator('#view-folder')).toBeVisible({ timeout: 5000 })

  const themeAfter = await getTheme(win)
  expect(themeAfter).toBe(themeBefore)

  // Return home for cleanup
  await win.locator('#btn-new-session').click()
})
