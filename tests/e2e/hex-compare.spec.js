/**
 * Hex Compare e2e tests.
 *
 * Tests the two-pane hex compare view layout and virtual-scroll rendering.
 * File dialog is bypassed by injecting base64 data directly via window.__testAPI.
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
// Helper: navigate to hex compare view
// ---------------------------------------------------------------------------
async function goToHexCompare(page) {
  const home = page.locator('#session-home')
  const viewHex = page.locator('#view-hex')

  if (await viewHex.isVisible()) return

  if (!(await home.isVisible())) {
    await page.locator('#btn-new-session').click()
    await expect(home).toBeVisible({ timeout: 5000 })
  }

  await page.locator('[data-type="hex"].session-type-btn').click()
  await expect(viewHex).toBeVisible({ timeout: 5000 })
}

// ---------------------------------------------------------------------------
// Helper: build a small base64 payload (256 bytes: 0x00–0xFF)
// ---------------------------------------------------------------------------
function makeTestBase64() {
  // 256 bytes, values 0x00 to 0xFF
  const bytes = new Uint8Array(256)
  for (let i = 0; i < 256; i++) bytes[i] = i
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

// ---------------------------------------------------------------------------
// Diagnostic Test 0: Capture JS errors during hex view mount
// ---------------------------------------------------------------------------
test('Diagnostic: hex mount 過程中的 JS 錯誤', async () => {
  const errors = []
  const consoleErrors = []

  // Capture uncaught errors
  win.on('pageerror', (err) => errors.push(err.message))
  win.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await goToHexCompare(win)
  // Small delay to let any async errors surface
  await win.waitForTimeout(500)

  console.log('[diag] pageerrors:', errors)
  console.log('[diag] console errors:', consoleErrors)

  // Dump view-hex state
  const hexState = await win.evaluate(() => ({
    viewHexDisplay:   document.getElementById('view-hex')?.style.display,
    viewHexChildren:  document.getElementById('view-hex')?.children.length,
    viewHexInnerHTML: document.getElementById('view-hex')?.innerHTML.slice(0, 300),
    hasTestAPI:       !!window.__testAPI,
    hexCompareExists: !!document.querySelector('.hex-compare'),
    hxBodyExists:     !!document.querySelector('.hx-body'),
    hxPaneCount:      document.querySelectorAll('.hx-pane').length,
  }))
  console.log('[diag] hexState:', JSON.stringify(hexState, null, 2))

  // This test always passes — it's only for diagnosis
  expect(errors.length + consoleErrors.length).toBeGreaterThanOrEqual(0)
})

// ---------------------------------------------------------------------------
// Test 1: Hex compare view opens and shows two panes
// ---------------------------------------------------------------------------
test('Hex 比對視圖顯示兩個 pane', async () => {
  await goToHexCompare(win)

  // Both panes must be in the DOM
  const panes = win.locator('.hx-pane')
  await expect(panes).toHaveCount(2)

  // Both panes visible
  await expect(panes.nth(0)).toBeVisible()
  await expect(panes.nth(1)).toBeVisible()

  // Toolbar visible
  await expect(win.locator('.hx-toolbar')).toBeVisible()

  // Path bar visible (global)
  await expect(win.locator('#path-bar')).toBeVisible()
})

// ---------------------------------------------------------------------------
// Test 2: Scroll containers have positive clientHeight (layout sanity)
// ---------------------------------------------------------------------------
test('Hex pane scroll 容器高度大於 0', async () => {
  await goToHexCompare(win)

  const scrollHeight = await win.evaluate(() => window.__testAPI?.hexGetScrollHeight())
  console.log('[diag] scroll.clientHeight =', scrollHeight)

  expect(scrollHeight).toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// Test 3: Injecting left-side data renders hx-row elements
// ---------------------------------------------------------------------------
test('注入左側資料後 hx-row 元素出現（虛擬捲動渲染）', async () => {
  await goToHexCompare(win)

  const b64 = makeTestBase64()

  // Inject test data directly, bypassing file dialog
  await win.evaluate((base64) => {
    window.__testAPI?.hexSetLeft('test-left.bin', base64)
  }, b64)

  // Wait for requestAnimationFrame + DOM update
  await win.waitForFunction(
    () => (window.__testAPI?.hexGetRowCount() ?? 0) > 0,
    { timeout: 3000 }
  )

  const rowCount = await win.evaluate(() => window.__testAPI?.hexGetRowCount())
  console.log('[diag] hx-row count after inject =', rowCount)
  expect(rowCount).toBeGreaterThan(0)

  // Inner height should be set to pixel value (not empty or '100%')
  const innerHeight = await win.evaluate(() => window.__testAPI?.hexGetInnerHeight())
  console.log('[diag] inner.style.height =', innerHeight)
  expect(innerHeight).toMatch(/^\d+px$/)
})

// ---------------------------------------------------------------------------
// Test 4: Hex rows contain offset, hex bytes, and ASCII columns
// ---------------------------------------------------------------------------
test('hx-row 包含 hx-offset, hx-hex, hx-ascii 欄位', async () => {
  await goToHexCompare(win)

  const b64 = makeTestBase64()
  await win.evaluate((base64) => {
    window.__testAPI?.hexSetLeft('test-left.bin', base64)
  }, b64)

  // Wait for rows
  await win.waitForFunction(
    () => (window.__testAPI?.hexGetRowCount() ?? 0) > 0,
    { timeout: 3000 }
  )

  // First row must have the three sub-columns
  await expect(win.locator('.hx-row').first().locator('.hx-offset')).toBeAttached()
  await expect(win.locator('.hx-row').first().locator('.hx-hex')).toBeAttached()
  await expect(win.locator('.hx-row').first().locator('.hx-ascii')).toBeAttached()
})

// ---------------------------------------------------------------------------
// Test 5: First row offset = 00000000 for 256-byte test file
// ---------------------------------------------------------------------------
test('第一列 offset 顯示 00000000', async () => {
  await goToHexCompare(win)

  const b64 = makeTestBase64()
  await win.evaluate((base64) => {
    window.__testAPI?.hexSetLeft('test-left.bin', base64)
  }, b64)

  await win.waitForFunction(
    () => (window.__testAPI?.hexGetRowCount() ?? 0) > 0,
    { timeout: 3000 }
  )

  const firstOffset = await win.locator('.hx-row[data-row="0"] .hx-offset').textContent()
  expect(firstOffset?.trim()).toBe('00000000')
})

// ---------------------------------------------------------------------------
// Test 6: Inject right-side data too — diff highlighting applied
// ---------------------------------------------------------------------------
test('注入右側資料後 diff 高亮存在', async () => {
  await goToHexCompare(win)

  // Left: 0x00–0xFF
  const b64Left = makeTestBase64()
  // Right: all zeros (will differ from left everywhere except index 0)
  const rightBytes = new Uint8Array(256)
  let rightBinary = ''
  for (let i = 0; i < rightBytes.length; i++) rightBinary += String.fromCharCode(rightBytes[i])
  const b64Right = btoa(rightBinary)

  await win.evaluate(([bLeft, bRight]) => {
    window.__testAPI?.hexSetLeft('test-left.bin', bLeft)
    window.__testAPI?.hexSetRight('test-right.bin', bRight)
  }, [b64Left, b64Right])

  await win.waitForFunction(
    () => (window.__testAPI?.hexGetRowCount() ?? 0) > 0,
    { timeout: 3000 }
  )

  // Some bytes should have diff class (bytes differ from offset 1 onward)
  const diffCount = await win.evaluate(
    () => document.querySelectorAll('.hx-byte.diff').length
  )
  console.log('[diag] diff byte count =', diffCount)
  expect(diffCount).toBeGreaterThan(0)
})
