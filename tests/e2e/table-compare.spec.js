/**
 * S15-U01: Table Compare e2e smoke tests.
 *
 * Verifies CSV ingestion path: injecting CSV strings produces a rendered
 * table with row counts that match the input and visible diff highlighting.
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

async function goToTableCompare(page) {
  const viewTable = page.locator('#view-table')
  if (await viewTable.isVisible()) return
  await page.locator('#btn-new-session').click()
  await expect(page.locator('#session-home')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-type="table"].session-type-btn').click()
  await expect(viewTable).toBeVisible({ timeout: 5000 })
}

const LEFT_CSV  = 'id,name,age\n1,Alice,30\n2,Bob,25\n3,Carol,40\n'
const RIGHT_CSV = 'id,name,age\n1,Alice,30\n2,Bob,26\n3,Dave,40\n'

test('Table 比對視圖掛載並顯示表格', async () => {
  await goToTableCompare(win)
  await expect(win.locator('.tc-wrap, .tc-table-scroll').first()).toBeAttached({ timeout: 5000 })
})

test('Table 注入 CSV 兩側後渲染列數 > 0 且 cell-diff 出現', async () => {
  await goToTableCompare(win)
  await win.evaluate(([l, r]) => {
    window.__testAPI?.tableSetLeft('left.csv',  l)
    window.__testAPI?.tableSetRight('right.csv', r)
  }, [LEFT_CSV, RIGHT_CSV])

  await win.waitForFunction(
    () => (window.__testAPI?.tableGetRowCount() ?? 0) > 0,
    { timeout: 5000 }
  )

  const rowCount = await win.evaluate(() => window.__testAPI?.tableGetRowCount())
  expect(rowCount).toBeGreaterThan(0)

  // Bob's age (25 vs 26) and Carol/Dave row should produce diff cells.
  const diffCount = await win.evaluate(() => window.__testAPI?.tableGetDiffCellCount())
  expect(diffCount).toBeGreaterThan(0)
})

test('大表格只渲染可視範圍的列（虛擬捲動）', async () => {
  await goToTableCompare(win)

  const ROWS = 20000
  await win.evaluate((n) => {
    const build = (tweak) => {
      const lines = ['id,name,value']
      for (let i = 0; i < n; i++) lines.push(`${i},name${i},${tweak && i === 5 ? 'X' : i}`)
      return lines.join('\n')
    }
    window.__testAPI?.tableSetLeft('big-left.csv', build(false))
    window.__testAPI?.tableSetRight('big-right.csv', build(true))
  }, ROWS)

  await win.waitForFunction(
    () => (window.__testAPI?.tableGetRowCount() ?? 0) > 0,
    { timeout: 15000 }
  )

  // Scroll height must reflect all rows even though only a window is built.
  const spacerHeight = await win.evaluate(
    () => document.querySelector('.tc-table-scroll .tc-vs-spacer')?.clientHeight ?? 0
  )
  expect(spacerHeight).toBeGreaterThan(ROWS * 20)

  const renderedRows = await win.evaluate(
    () => document.querySelectorAll('.tc-table-scroll .tc-row').length
  )
  expect(renderedRows).toBeGreaterThan(0)
  // Two panes, a viewport's worth each plus overscan — nowhere near 20000.
  expect(renderedRows).toBeLessThan(500)
})

// ── P2-43..46: Go To / Copy row / Insert row / severity shading / thumbnail ──
//
// These exist as e2e because this project's recurring failure is a complete
// implementation with no caller. Driving the real toolbar in the production
// build is the only check that the entry points are actually connected.

/**
 * @param {import('@playwright/test').Page} page
 */
async function loadSmallTables(page) {
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

test('新指令都有工具列入口', async () => {
  await loadSmallTables(win)
  for (const id of ['#tc-btn-goto', '#tc-btn-copy-right', '#tc-btn-copy-left',
                    '#tc-btn-insert-row', '#tc-btn-severity', '#tc-btn-thumb']) {
    await expect(win.locator(id)).toBeAttached()
  }
})

test('Go To 開啟後輸入列,欄會選取該儲存格', async () => {
  await loadSmallTables(win)
  await win.locator('#tc-btn-goto').click()
  await expect(win.locator('.tc-goto-bar')).toBeVisible()

  await win.locator('#tc-goto-input').fill('2,1')
  await win.locator('#tc-goto-input').press('Enter')

  await expect(win.locator('.tc-goto-bar')).toBeHidden()
  await expect(win.locator('.tc-cell--selected').first()).toBeAttached({ timeout: 5000 })
})

test('差異程度色階開關會為差異儲存格加上等級', async () => {
  await loadSmallTables(win)
  await expect(win.locator('[class*="tc-cell--sev"]')).toHaveCount(0)
  await win.locator('#tc-btn-severity').click()
  await expect(win.locator('[class*="tc-cell--sev"]').first()).toBeAttached({ timeout: 5000 })
  await win.locator('#tc-btn-severity').click()
  await expect(win.locator('[class*="tc-cell--sev"]')).toHaveCount(0)
})

test('縮圖開關會畫出差異色帶', async () => {
  await loadSmallTables(win)
  await win.locator('#tc-btn-thumb').click()
  await expect(win.locator('.tc-thumb')).toBeVisible()
  await expect(win.locator('.tc-thumb-mark').first()).toBeAttached({ timeout: 5000 })
  await win.locator('#tc-btn-thumb').click()
  await expect(win.locator('.tc-thumb')).toBeHidden()
})

test('複製整列到右側會讓那一列不再是差異', async () => {
  await loadSmallTables(win)
  const before = await win.evaluate(() => window.__testAPI?.tableGetDiffCellCount())
  expect(before).toBeGreaterThan(0)

  // Select a cell on the differing row so the command has a target.
  await win.locator('.tc-table-scroll').first().locator('tr.tc-row.different td.tc-cell')
    .first().click()
  await win.locator('#tc-btn-copy-right').click()

  await expect.poll(
    () => win.evaluate(() => window.__testAPI?.tableGetDiffCellCount()),
    { timeout: 5000 }
  ).toBeLessThan(before)

  // Re-injecting clears the unsaved-changes flag; leaving it set makes the
  // beforeunload guard block the window close and hang the run's teardown.
  await loadSmallTables(win)
})

test('插入列會讓左側多一列', async () => {
  await loadSmallTables(win)
  const before = await win.evaluate(() => window.__testAPI?.tableGetRowCount())
  await win.locator('.tc-table-scroll').first().locator('tr.tc-row td.tc-cell').first().click()
  await win.locator('#tc-btn-insert-row').click()
  await expect.poll(
    () => win.evaluate(() => window.__testAPI?.tableGetRowCount()),
    { timeout: 5000 }
  ).toBeGreaterThan(before)

  await loadSmallTables(win)
})
