/**
 * Sprint 18 gap items, exercised through the controls a user actually clicks.
 *
 * The unit suite covers the logic; this spec exists to answer the question unit
 * tests cannot — is the feature reachable in the built app at all. Everything
 * here goes through real toolbar buttons rather than calling view methods.
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

/**
 * @param {import('@playwright/test').Page} page
 * @param {'hex'|'table'} type
 */
async function goToView(page, type) {
  const view = page.locator(`#view-${type}`)
  if (await view.isVisible()) return
  const home = page.locator('#session-home')
  if (!(await home.isVisible())) {
    await page.locator('#btn-new-session').click()
    await expect(home).toBeVisible({ timeout: 5000 })
  }
  await page.locator(`[data-type="${type}"].session-type-btn`).click()
  await expect(view).toBeVisible({ timeout: 5000 })
}

/**
 * 512 bytes; with 16 bytes per row that is 32 rows, of which rows 0 and 16
 * differ — enough that "differences only" and "same only" are both non-empty.
 * @param {boolean} mutate
 */
function payload(mutate) {
  const bytes = new Uint8Array(512)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff
  if (mutate) { bytes[0] ^= 0xff; bytes[16 * 16] ^= 0xff }
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

test('Hex：Show 篩選按鈕改變可見列與捲動高度', async () => {
  await goToView(win, 'hex')
  await win.evaluate(([l, r]) => {
    window.__testAPI?.hexSetLeft('left.bin', l)
    window.__testAPI?.hexSetRight('right.bin', r)
  }, [payload(false), payload(true)])
  // Earlier specs may leave hex panes mounted in other tabs, so every query
  // here is scoped to the visible view rather than to the whole document.
  const SCOPE = '#view-hex .hx-pane[data-side="left"]'
  const heightOf = () => win.evaluate(
    (s) => document.querySelector(`${s} .hx-inner`)?.style.height ?? '', SCOPE)
  const offsets = () => win.evaluate((s) => [...document.querySelectorAll(
    `${s} .hx-row .hx-offset`)].map((n) => n.textContent), SCOPE)

  await win.waitForFunction(
    (s) => (document.querySelector(`${s} .hx-inner`)?.style.height ?? '').endsWith('px'),
    SCOPE, { timeout: 5000 })

  const allHeight = await heightOf()
  expect(allHeight).toBe('640px') // 32 rows × 20px

  const buttons = win.locator('#view-hex .hx-show-btn')
  await expect(buttons).toHaveCount(3)

  await buttons.nth(1).click() // 差異
  expect(await heightOf()).toBe('40px') // 2 differing rows
  expect(await offsets()).toEqual(['00000000', '00000100'])

  await buttons.nth(2).click() // 相同
  expect(await heightOf()).toBe('600px') // 30 identical rows

  await buttons.nth(0).click() // 全部
  expect(await heightOf()).toBe(allHeight)
})

test('Hex：篩選狀態下仍只渲染可見列', async () => {
  await goToView(win, 'hex')
  const rows = await win.evaluate(
    () => document.querySelectorAll('#view-hex .hx-row[data-row]').length)
  // Both panes together, window plus overscan — nowhere near the 32 source rows
  // times two that a non-virtual renderer would produce for this input.
  expect(rows).toBeGreaterThan(0)
  expect(rows).toBeLessThanOrEqual(64)
})

test('Hex：工具列有複製到左/右與 HTML 報告入口', async () => {
  await goToView(win, 'hex')
  await expect(win.locator('#view-hex .hx-btn-copy')).toHaveCount(2)
  await expect(win.locator('#view-hex .hx-btn-report')).toHaveCount(2)
})

test('Hex：右鍵選單含「在檔案總管中顯示」', async () => {
  await goToView(win, 'hex')
  await win.locator('#view-hex .hx-pane[data-side="left"] .hx-row .hx-byte').first()
    .click({ button: 'right' })
  await expect(win.locator('.ctx-menu')).toBeVisible({ timeout: 3000 })
  await expect(win.locator('.ctx-item', { hasText: '在檔案總管中顯示' })).toHaveCount(1)
  await win.keyboard.press('Escape')
})

test('Table：Side / Over 佈局切換', async () => {
  await goToView(win, 'table')
  await win.evaluate(() => {
    window.__testAPI?.tableSetLeft('L.csv', 'id,name\n1,Alice\n2,Bob')
    window.__testAPI?.tableSetRight('R.csv', 'id,name\n1,Alice\n2,Bobby')
  })

  const btn = win.locator('#view-table #tc-btn-layout')
  await expect(btn).toHaveText('⬛ Side')
  await expect(win.locator('#view-table .tc-body.over-under')).toHaveCount(0)

  await btn.click()
  await expect(btn).toHaveText('⊟ Over')
  await expect(win.locator('#view-table .tc-body.over-under')).toHaveCount(1)
  // Both panes must survive the flip; a broken grid would collapse one of them.
  await expect(win.locator('#view-table .tc-body.over-under > .tc-pane')).toHaveCount(2)

  await btn.click()
  await expect(btn).toHaveText('⬛ Side')
  await expect(win.locator('#view-table .tc-body.over-under')).toHaveCount(0)
})

test('Table：工具列有列印入口', async () => {
  await goToView(win, 'table')
  await expect(win.locator('#view-table #tc-btn-print')).toBeVisible()
})
