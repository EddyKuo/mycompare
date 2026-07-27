/**
 * S24 Hex gaps — 從使用者實際會走的路徑驗證入口存在。
 *
 * 這個專案九次以上交付過「模組完整、單元測試齊全、但沒有任何呼叫端」的功能，
 * 而單元測試回答不了「有沒有人用它」。這裡按的是生產版本裡真正的按鈕。
 *
 * Run with: npm run test:e2e （會先 npm run build）
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

/**
 * Messages from every dialog raised since the last reset.
 *
 * Registered once: the page is shared by the whole file, and a per-test
 * listener would leave earlier tests' handlers racing for the same dialog.
 * @type {string[]}
 */
const dialogs = []

test.beforeAll(async () => {
  ;({ app, win } = await launchApp())
  win.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.accept().catch(() => { /* already handled by the previous listener */ })
  })
})

test.beforeEach(() => {
  dialogs.length = 0
})

test.afterAll(async () => {
  await closeApp(app)
})

/** @param {import('@playwright/test').Page} page */
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

/**
 * @param {number[]} values
 * @returns {string} base64
 */
function toBase64(values) {
  let binary = ''
  for (const v of values) binary += String.fromCharCode(v & 0xff)
  return btoa(binary)
}

/**
 * Show the replace row, whatever state the previous test left it in.
 * @param {import('@playwright/test').Page} page
 */
async function openReplace(page) {
  const row = page.locator('#hx-replace-input')
  if (!(await row.isVisible())) await page.locator('#hx-btn-replace-toggle').click()
  await expect(row).toBeVisible()
}

/** @param {import('@playwright/test').Page} page */
async function loadPair(page) {
  const left = []
  const right = []
  for (let i = 0; i < 512; i++) {
    left.push(i & 0xff)
    right.push(i === 300 ? 0x00 : i & 0xff)
  }
  await page.evaluate(([l, r]) => {
    window.__testAPI?.hexSetLeft('/tmp/s24-left.bin', l)
    window.__testAPI?.hexSetRight('/tmp/s24-right.bin', r)
  }, [toBase64(left), toBase64(right)])
  await expect(page.locator('.hx-row').first()).toBeVisible({ timeout: 5000 })
}

test('Over/Under 佈局按鈕會切換軸向', async () => {
  await goToHexCompare(win)
  await loadPair(win)

  const btn = win.locator('#hx-btn-layout')
  await expect(btn).toBeVisible()
  await expect(btn).toHaveText('⬛ Side')

  await btn.click()
  await expect(win.locator('.hx-body')).toHaveClass(/over-under/)
  await expect(btn).toHaveText('⊟ Over')

  await btn.click()
  await expect(win.locator('.hx-body')).not.toHaveClass(/over-under/)
})

test('縮圖按鈕會畫出整檔差異色帶', async () => {
  await goToHexCompare(win)
  await loadPair(win)

  const btn = win.locator('#hx-btn-thumb')
  await expect(btn).toBeVisible()
  await btn.click()

  await expect(win.locator('.hx-thumb')).toBeVisible()
  // 兩檔只在一個位元組不同，所以至少要有一條色帶，且不能是整條都上色。
  const marks = win.locator('.hx-thumb-mark')
  await expect(marks).not.toHaveCount(0)
  expect(await marks.count()).toBeLessThanOrEqual(400)

  await btn.click()
  await expect(win.locator('.hx-thumb')).toBeHidden()
})

test('取代列可以打開，且未進編輯模式時會擋下並說明', async () => {
  await goToHexCompare(win)
  await loadPair(win)

  await expect(win.locator('#hx-btn-replace-toggle')).toBeVisible()
  await openReplace(win)

  await win.locator('#hx-find-input').fill('00 01 02')
  await win.locator('#hx-replace-input').fill('FF')

  // alert 已被共用的 handler 接走：沒有進編輯模式的取代必須明確拒絕，
  // 而不是安靜地什麼都不做。
  await win.locator('#hx-btn-replace-all').click()
  await win.waitForTimeout(300)
  expect(dialogs.join('\n')).toContain('編輯模式')
})

test('取代後可以一次復原', async () => {
  await goToHexCompare(win)
  await loadPair(win)

  await openReplace(win)
  await win.locator('#hx-find-input').fill('00 01 02')
  await win.locator('#hx-replace-input').fill('AA BB CC DD')

  const before = await win.evaluate(() => window.__testAPI?.hexGetRowCount())
  expect(before).toBeGreaterThan(0)

  // 進編輯模式後才允許寫入。
  await win.locator('.hx-btn-edit').first().click()
  await win.locator('#hx-btn-replace-all').click()
  await win.waitForTimeout(300)

  const dirty = await win.locator('.hx-dirty-info').textContent()
  expect(dirty ?? '').toContain('未儲存')

  // ↶ 是編輯列的第二個按鈕。
  await win.locator('.hx-btn-edit').nth(1).click()
  await win.waitForTimeout(300)
  const after = await win.locator('.hx-dirty-info').textContent()
  expect(after ?? '').toBe('')
})

test('重新載入按鈕存在且會呼叫讀檔（檔案不存在時明確報錯）', async () => {
  await goToHexCompare(win)
  await loadPair(win)

  const btn = win.locator('#hx-btn-reload')
  await expect(btn).toBeVisible()
  await btn.click()
  await win.waitForTimeout(500)

  // 注入的路徑在磁碟上不存在，所以正確的行為是報錯給使用者看，
  // 而不是靜默地維持舊內容。
  expect(dialogs.join('\n')).toContain('重新載入')
})
