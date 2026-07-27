/**
 * E2E for the gap-matrix v2 text-compare items.
 *
 * Unit tests prove the modules work; these prove a user can actually reach
 * them — the exact failure class Sprint 16 found four instances of.
 *
 *   P1-19 — Compare Selection to Clipboard (context menu + Ctrl+Shift+C)
 *   P2-30 — Manual ignore (context menu + Ctrl+I)
 *   P2-25 — Text Patch viewer (context menu + Ctrl+Shift+P)
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

/** Dismiss any open context menu / toast so tests do not leak state. */
async function reset(page) {
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    document.querySelectorAll('.mc-toast').forEach(el => el.remove())
  })
}

test('右鍵選單提供剪貼簿比較、手動忽略與 Patch 入口', async () => {
  await goToTextCompare(win)
  await win.locator('#content-left').click({ button: 'right' })
  await expect(win.locator('.ctx-menu')).toBeVisible({ timeout: 3000 })

  await expect(win.locator('.ctx-item', { hasText: '與剪貼簿比較選取內容' })).toHaveCount(1)
  await expect(win.locator('.ctx-item', { hasText: '切換選取行的忽略標記' })).toHaveCount(1)
  await expect(win.locator('.ctx-item', { hasText: '列出手動忽略的行' })).toHaveCount(1)
  await expect(win.locator('.ctx-item', { hasText: '清除所有手動忽略' })).toHaveCount(1)
  await expect(win.locator('.ctx-item', { hasText: '開啟 Patch 檔' })).toHaveCount(1)

  await reset(win)
})

test('P2-30：「列出手動忽略的行」在沒有標記時明確回報', async () => {
  await goToTextCompare(win)
  await win.locator('#content-left').click({ button: 'right' })
  await expect(win.locator('.ctx-menu')).toBeVisible({ timeout: 3000 })
  await win.locator('.ctx-item', { hasText: '列出手動忽略的行' }).click()

  await expect(win.locator('.mc-toast')).toContainText('目前沒有手動忽略的行', { timeout: 3000 })
  await reset(win)
})

test('P2-30：Ctrl+I 抵達文字視圖，未選取時給出可見提示', async () => {
  await goToTextCompare(win)
  await reset(win)
  await win.keyboard.press('Control+i')
  await expect(win.locator('.mc-toast--warn')).toContainText('選取', { timeout: 3000 })
  await reset(win)
})

test('P1-19：Ctrl+Shift+C 抵達文字視圖，未選取時給出可見提示', async () => {
  await goToTextCompare(win)
  await reset(win)
  await win.keyboard.press('Control+Shift+C')
  await expect(win.locator('.mc-toast--warn')).toContainText('剪貼簿', { timeout: 3000 })
  await reset(win)
})

test('P2-25：Patch 檢視器入口在右鍵選單中可點擊', async () => {
  // The dialog half is Electron-native and cannot be scripted here; what this
  // guards is that the entry exists and is enabled, which is the layer that
  // silently went missing for four other features in Sprint 16.
  await goToTextCompare(win)
  await reset(win)

  await win.locator('#content-left').click({ button: 'right' })
  await expect(win.locator('.ctx-menu')).toBeVisible({ timeout: 3000 })
  await expect(win.locator('.ctx-item', { hasText: '開啟 Patch 檔' })).toBeEnabled()
  await reset(win)
})
