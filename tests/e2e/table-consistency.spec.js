/**
 * S26 — Table Compare 一致性缺口的入口驗證。
 *
 * 這些功能的單元測試在 tests/unit/s26-table-consistency.test.js。單元測試
 * 回答不了「有沒有人用它」——本專案反覆出現的失敗模式正是「實作完整、單元
 * 測試齊全、但沒有任何呼叫端」。這裡一律驅動生產版本的真實工具列與右鍵選單。
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

const LEFT_CSV  = 'id,name,age\n1,Alice,30\n2,Bob,25\n3,Carol,40\n'
const RIGHT_CSV = 'id,name,age\n1,Alice,30\n2,Bob,26\n3,Dave,40\n'

/** @param {import('@playwright/test').Page} page */
async function goToTableCompare(page) {
  const viewTable = page.locator('#view-table')
  if (await viewTable.isVisible()) return
  await page.locator('#btn-new-session').click()
  await expect(page.locator('#session-home')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-type="table"].session-type-btn').click()
  await expect(viewTable).toBeVisible({ timeout: 5000 })
}

/** @param {import('@playwright/test').Page} page */
async function loadTables(page) {
  await goToTableCompare(page)
  await page.evaluate(([l, r]) => {
    window.__testAPI?.tableSetLeft('left.csv', l)
    window.__testAPI?.tableSetRight('right.csv', r)
  }, [LEFT_CSV, RIGHT_CSV])
  await page.waitForFunction(
    () => (window.__testAPI?.tableGetRowCount() ?? 0) > 0,
    { timeout: 10000 }
  )
}

test('每一項都有工具列或路徑列入口', async () => {
  await loadTables(win)
  for (const id of ['#tc-btn-select-all', '#tc-btn-row-numbers',
                    '#tc-btn-font-larger', '#tc-btn-font-smaller', '#tc-btn-font-reset',
                    '#tc-btn-prev-edit', '#tc-btn-next-edit',
                    '#tc-btn-explorer-left', '#tc-btn-explorer-right']) {
    await expect(win.locator(id)).toBeAttached()
  }
})

test('Select All 按鈕會把可見的儲存格標成選取範圍', async () => {
  await loadTables(win)
  await expect(win.locator('.tc-cell--in-range')).toHaveCount(0)
  await win.locator('#tc-btn-select-all').click()
  await expect(win.locator('.tc-cell--in-range').first()).toBeAttached({ timeout: 5000 })

  // 點一格會取消範圍——否則接下來的清除會打在看不見的選取上。
  await win.locator('.tc-table-scroll .tc-cell').first().click()
  await expect(win.locator('.tc-cell--in-range')).toHaveCount(0)
})

test('列號開關切換 class，列號儲存格仍在 DOM 中', async () => {
  await loadTables(win)
  const root = win.locator('.table-compare')
  await expect(root).not.toHaveClass(/tc-hide-row-numbers/)

  await win.locator('#tc-btn-row-numbers').click()
  await expect(root).toHaveClass(/tc-hide-row-numbers/)
  // 節點若被移除，所有以欄索引為準的查找都會錯一格。
  await expect(win.locator('.tc-row .tc-row-num').first()).toBeAttached()

  await win.locator('#tc-btn-row-numbers').click()
  await expect(root).not.toHaveClass(/tc-hide-row-numbers/)
})

test('字級按鈕同時改變 CSS 變數與虛擬捲動用的列高', async () => {
  await loadTables(win)
  const rowHeight = () => win.evaluate(
    () => document.querySelector('.table-compare')?.style.getPropertyValue('--tc-row-height'))

  await win.locator('#tc-btn-font-reset').click()
  expect(await rowHeight()).toBe('24px')

  await win.locator('#tc-btn-font-larger').click()
  expect(await rowHeight()).toBe('25px')
  // 捲動高度以列高計算；兩者若脫鉤，列會逐格偏離視窗。
  const measured = await win.evaluate(
    () => document.querySelector('.tc-table-scroll .tc-row')?.getBoundingClientRect().height ?? 0)
  expect(Math.round(measured)).toBe(25)

  await win.locator('#tc-btn-font-reset').click()
  expect(await rowHeight()).toBe('24px')
})

test('編輯導航按鈕在有編輯之前是停用的，編輯之後啟用並跳到該列', async () => {
  await loadTables(win)
  await expect(win.locator('#tc-btn-next-edit')).toBeDisabled()

  // 雙擊進入編輯模式，改一格再離開。
  const cell = win.locator('.tc-table-scroll').first().locator('.tc-row').nth(1).locator('.tc-cell').nth(1)
  await cell.dblclick()
  await win.locator('.tc-cell-input').fill('Edited')
  await win.locator('.tc-cell-input').press('Enter')

  await expect(win.locator('#tc-btn-next-edit')).toBeEnabled()
  await win.locator('#tc-btn-next-edit').click()
  await expect(win.locator('.tc-cell--selected').first()).toBeAttached({ timeout: 5000 })
})

test('Explorer 按鈕在沒有真實路徑時把原因說出來，而不是靜默失敗', async () => {
  await goToTableCompare(win)
  // 注入的是壓縮檔內容的虛擬路徑：磁碟上沒有對應位置，必須明講。
  await win.evaluate(([l, r]) => {
    window.__testAPI?.tableSetLeft('/tmp/pack.zip::inner.csv', l)
    window.__testAPI?.tableSetRight('/tmp/pack.zip::other.csv', r)
  }, [LEFT_CSV, RIGHT_CSV])
  await win.waitForFunction(
    () => (window.__testAPI?.tableGetRowCount() ?? 0) > 0,
    { timeout: 10000 }
  )

  await win.locator('#tc-btn-explorer-left').click()
  await expect(win.locator('#status-message')).toContainText('磁碟上沒有對應位置', { timeout: 5000 })
})

test('右鍵選單提供全選、儲存格剪貼與檔案總管', async () => {
  await loadTables(win)
  await win.locator('.tc-table-scroll').first().locator('.tc-cell').first()
    .click({ button: 'right' })

  const menu = win.locator('.ctx-menu')
  await expect(menu).toBeVisible({ timeout: 5000 })
  for (const label of ['全選', '剪下儲存格', '貼上到儲存格', '清除儲存格',
                       '下一處編輯', '在檔案總管中顯示']) {
    await expect(menu.locator('.ctx-item', { hasText: label }).first()).toBeAttached()
  }
  await win.keyboard.press('Escape')
})
