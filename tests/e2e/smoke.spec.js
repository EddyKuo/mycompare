/**
 * Smoke tests for MyCompare Electron app.
 *
 * Run with:   npm run test:e2e
 * Prerequisite: npm run build (app must be built to out/)
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

// ---------------------------------------------------------------------------
// Shared app instance — one launch per file for speed
// ---------------------------------------------------------------------------
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
// Test 1: App launches and Session Home is visible
// ---------------------------------------------------------------------------
test('App 啟動並顯示 Session Home', async () => {
  // Title element inside session-home
  const title = win.locator('#session-home h1')
  await expect(title).toBeVisible()
  await expect(title).toHaveText('MyCompare')

  // The session-home container itself must be visible
  await expect(win.locator('#session-home')).toBeVisible()
})

// ---------------------------------------------------------------------------
// Test 2: Clicking the text-compare session button shows the text compare view
// ---------------------------------------------------------------------------
test('點擊文字比對按鈕顯示比對介面', async () => {
  // Session Home must still be visible before click
  await expect(win.locator('#session-home')).toBeVisible()

  // Click the text session button
  await win.locator('[data-type="text"].session-type-btn').click()

  // view-text becomes visible (display: flex); session-home hides
  await expect(win.locator('#view-text')).toBeVisible()
  await expect(win.locator('#session-home')).toBeHidden()
})

// ---------------------------------------------------------------------------
// Test 3: Core Toolbar buttons are present in the DOM
// ---------------------------------------------------------------------------
test('Toolbar 核心按鈕存在', async () => {
  const toolbar = win.locator('#toolbar')
  await expect(toolbar).toBeVisible()

  const ids = [
    '#btn-new-session',
    '#btn-show-all',
    '#btn-whitespace',
    '#btn-line-numbers',
    '#btn-layout-toggle',
  ]

  for (const id of ids) {
    await expect(win.locator(id)).toBeAttached()
  }
})

// ---------------------------------------------------------------------------
// Test 4: Text compare view elements (pane structure) are present
// ---------------------------------------------------------------------------
test('文字比對視圖結構正確', async () => {
  // Ensure we are in text-compare view (may already be after test 2)
  const viewText = win.locator('#view-text')
  if (!(await viewText.isVisible())) {
    await win.locator('[data-type="text"].session-type-btn').click()
    await expect(viewText).toBeVisible()
  }

  // Left pane, right pane, splitter, compare-area must all be present
  await expect(win.locator('#pane-left')).toBeAttached()
  await expect(win.locator('#pane-right')).toBeAttached()
  await expect(win.locator('#content-left')).toBeAttached()
  await expect(win.locator('#content-right')).toBeAttached()
  await expect(win.locator('#splitter')).toBeAttached()
  await expect(win.locator('#compare-area')).toBeVisible()

  // Paste buttons are visible (T23)
  await expect(win.locator('#btn-paste-left')).toBeVisible()
  await expect(win.locator('#btn-paste-right')).toBeVisible()

  // Options bar checkboxes are present
  await expect(win.locator('#chk-ignore-line-endings')).toBeAttached()
  await expect(win.locator('#chk-ignore-whitespace')).toBeAttached()
  await expect(win.locator('#chk-ignore-case')).toBeAttached()
})

// ---------------------------------------------------------------------------
// Test 5: Find bar opens with Ctrl+F
// ---------------------------------------------------------------------------
test('Ctrl+F 開啟 Find bar', async () => {
  // Ensure text-compare view is active
  const viewText = win.locator('#view-text')
  if (!(await viewText.isVisible())) {
    await win.locator('[data-type="text"].session-type-btn').click()
    await expect(viewText).toBeVisible()
  }

  // find-bar starts hidden
  const findBar = win.locator('#find-bar')

  // Press Ctrl+F to open find bar
  await win.keyboard.press('Control+f')

  // find-bar should now be visible
  await expect(findBar).toBeVisible({ timeout: 3000 })

  // Close it with Escape for cleanup
  await win.keyboard.press('Escape')
})

// ---------------------------------------------------------------------------
// Test 6: Clicking btn-new-session returns to Session Home
// ---------------------------------------------------------------------------
test('點擊新增比對按鈕返回 Session Home', async () => {
  // Ensure we're not already on home
  const viewText = win.locator('#view-text')
  if (!(await viewText.isVisible())) {
    await win.locator('[data-type="text"].session-type-btn').click()
    await expect(viewText).toBeVisible()
  }

  // Click the New Session button
  await win.locator('#btn-new-session').click()

  // Session home should re-appear
  await expect(win.locator('#session-home')).toBeVisible()
})
