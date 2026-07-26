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
