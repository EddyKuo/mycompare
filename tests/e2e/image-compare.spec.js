/**
 * S15-U01: Image Compare e2e smoke tests.
 *
 * Verifies the image view mounts, renders the three canvas panels, and that
 * injecting a tiny PNG produces a non-zero diff canvas.
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

// A 2x2 red PNG (base64) — minimum valid encoded image.
const TINY_RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const TINY_BLUE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNkYPj/HwAEAQH/AGZE0wAAAABJRU5ErkJggg=='

test('Image 比對視圖：三個 canvas panel 都掛載', async () => {
  await goToImageCompare(win)
  await expect(win.locator('.ic-canvas-left')).toBeAttached()
  await expect(win.locator('.ic-canvas-right')).toBeAttached()
  await expect(win.locator('.ic-canvas-diff')).toBeAttached()
})

test('Image 注入兩張不同圖片後 diff canvas 尺寸 > 0', async () => {
  await goToImageCompare(win)
  await win.evaluate(async ([l, r]) => {
    await window.__testAPI?.imageSetLeft('left.png',  l, 'png')
    await window.__testAPI?.imageSetRight('right.png', r, 'png')
  }, [TINY_RED_PNG_B64, TINY_BLUE_PNG_B64])

  await win.waitForFunction(() => {
    const s = window.__testAPI?.imageGetDiffCanvasSize()
    return s && s.w > 0 && s.h > 0
  }, { timeout: 5000 })

  const size = await win.evaluate(() => window.__testAPI?.imageGetDiffCanvasSize())
  expect(size.w).toBeGreaterThan(0)
  expect(size.h).toBeGreaterThan(0)
})

test('Image 工具列含 zoom 按鈕', async () => {
  await goToImageCompare(win)
  // T57 zoom controls
  await expect(win.locator('[title*="放大"], [title*="Zoom In"], [aria-label*="Zoom In"]').first()).toBeAttached()
})
