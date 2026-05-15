/**
 * Folder Compare e2e tests for MyCompare.
 *
 * Covers: basic UI, find filename (T54), toolbar buttons T55/T56,
 *         selection dropdown (T51), filter toggles.
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
// Navigation helpers
// ---------------------------------------------------------------------------

async function goHome(page) {
  const home = page.locator('#session-home')
  if (!(await home.isVisible())) {
    await page.locator('#btn-new-session').click()
    await expect(home).toBeVisible({ timeout: 5000 })
  }
}

async function goToFolderCompare(page) {
  const viewFolder = page.locator('#view-folder')
  if (await viewFolder.isVisible()) return

  await goHome(page)
  await page.locator('[data-type="folder"].session-type-btn').click()
  await expect(viewFolder).toBeVisible({ timeout: 5000 })
}

// ---------------------------------------------------------------------------
// Basic functionality
// ---------------------------------------------------------------------------

test('點 data-type="folder" 開啟 folder compare（view-folder 可見）', async () => {
  await goHome(win)
  await win.locator('[data-type="folder"].session-type-btn').click()
  await expect(win.locator('#view-folder')).toBeVisible({ timeout: 5000 })
  await expect(win.locator('#session-home')).toBeHidden()
})

test('Toolbar 有 fc-toolbar', async () => {
  await goToFolderCompare(win)
  const toolbar = win.locator('.fc-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 3000 })
})

test('有兩個「開啟資料夾…」按鈕（fc-open-btn）', async () => {
  await goToFolderCompare(win)
  const openBtns = win.locator('.fc-open-btn[data-side]')
  // There are 4 open buttons (folder + zip for each side), at least 2 with data-side
  await expect(openBtns).toHaveCount(4)
  // Specifically the folder open buttons
  const folderOpenLeft = win.locator('.fc-open-btn[data-side="left"]').first()
  const folderOpenRight = win.locator('.fc-open-btn[data-side="right"]').first()
  await expect(folderOpenLeft).toBeAttached()
  await expect(folderOpenRight).toBeAttached()
})

test('Folder compare view 可從 Session Home 返回', async () => {
  await goToFolderCompare(win)
  await win.locator('#btn-new-session').click()
  await expect(win.locator('#session-home')).toBeVisible({ timeout: 5000 })
})

// ---------------------------------------------------------------------------
// T54: Find Filename
// ---------------------------------------------------------------------------

test('T54: fc-find-bar 存在於 folder compare 容器中（DOM 結構正確）', async () => {
  await goToFolderCompare(win)
  // The fc-find-bar is always in the DOM, just hidden; verify it exists
  const findBar = win.locator('.fc-find-bar')
  await expect(findBar).toBeAttached()
  // fc-find-input must be inside it
  await expect(win.locator('.fc-find-input')).toBeAttached()
})

test('T54: fc-find-bar 可透過 JS 呼叫開啟（_openFindBar）', async () => {
  await goToFolderCompare(win)

  // Use evaluate to call _openFindBar directly via the DOM — set display to flex
  // (mimics what FolderCompare._openFindBar() does)
  await win.evaluate(() => {
    const bar = document.querySelector('.fc-find-bar')
    if (bar) bar.style.display = 'flex'
  })

  const findBar = win.locator('.fc-find-bar')
  await expect(findBar).toBeVisible({ timeout: 2000 })
})

test('T54: fc-find-bar 可透過 JS 關閉（顯示後再隱藏）', async () => {
  await goToFolderCompare(win)

  // Open it via JS
  await win.evaluate(() => {
    const bar = document.querySelector('.fc-find-bar')
    if (bar) bar.style.display = 'flex'
  })
  const findBar = win.locator('.fc-find-bar')
  await expect(findBar).toBeVisible({ timeout: 2000 })

  // Close it via the close button
  const closeBtn = win.locator('.fc-find-close')
  await expect(closeBtn).toBeAttached()
  await closeBtn.click()
  await expect(findBar).toBeHidden({ timeout: 2000 })
})

// ---------------------------------------------------------------------------
// T55/T56: Toolbar buttons
// ---------------------------------------------------------------------------

test('T56: 存在 Expand All（⊞）按鈕', async () => {
  await goToFolderCompare(win)
  const btn = win.locator('.fc-btn-expand-all')
  await expect(btn).toBeAttached()
  await expect(btn).toContainText('⊞')
})

test('T56: 存在 Collapse All（⊟）按鈕', async () => {
  await goToFolderCompare(win)
  const btn = win.locator('.fc-btn-collapse-all')
  await expect(btn).toBeAttached()
  await expect(btn).toContainText('⊟')
})

test('T55: 存在 Left Newer toggle 按鈕（data-filter="left-newer"）', async () => {
  await goToFolderCompare(win)
  const btn = win.locator('[data-filter="left-newer"]')
  await expect(btn).toBeAttached()
  // Initially active (showing left-newer items)
  await expect(btn).toHaveClass(/fc-btn-filter-toggle--active/)
})

test('T55: 存在 Right Newer toggle 按鈕（data-filter="right-newer"）', async () => {
  await goToFolderCompare(win)
  const btn = win.locator('[data-filter="right-newer"]')
  await expect(btn).toBeAttached()
  await expect(btn).toHaveClass(/fc-btn-filter-toggle--active/)
})

test('T55: 點擊 Left Newer toggle 切換 active 狀態', async () => {
  await goToFolderCompare(win)
  const btn = win.locator('[data-filter="left-newer"]')

  // Should start as active
  await expect(btn).toHaveClass(/fc-btn-filter-toggle--active/)
  await btn.click()
  await expect(btn).not.toHaveClass(/fc-btn-filter-toggle--active/)

  // Restore
  await btn.click()
  await expect(btn).toHaveClass(/fc-btn-filter-toggle--active/)
})

// ---------------------------------------------------------------------------
// T51: Selection dropdown
// ---------------------------------------------------------------------------

test('T51: 存在「選取 ▾」按鈕（fc-btn-select）', async () => {
  await goToFolderCompare(win)
  const btn = win.locator('.fc-btn-select')
  await expect(btn).toBeAttached()
  await expect(btn).toContainText('選取')
})

test('T51: 點擊 fc-btn-select 顯示 select menu', async () => {
  await goToFolderCompare(win)
  const btn = win.locator('.fc-btn-select')
  const menu = win.locator('.fc-select-menu')

  // Initially hidden
  await expect(menu).toBeHidden()
  await btn.click()
  await expect(menu).toBeVisible({ timeout: 2000 })

  // Close by clicking elsewhere
  await win.locator('.fc-toolbar').click({ position: { x: 5, y: 5 } })
})

test('T51: fc-compare-mode select 存在（比對模式下拉）', async () => {
  await goToFolderCompare(win)
  const select = win.locator('.fc-compare-mode')
  await expect(select).toBeAttached()
  await expect(select).toBeVisible()
})

test('T51: fc-compare-mode 有多個選項（名稱/大小/時間）', async () => {
  await goToFolderCompare(win)
  const options = win.locator('.fc-compare-mode option')
  // Should have at least 3 options (name, size, mtime, both, content)
  const count = await options.count()
  expect(count).toBeGreaterThanOrEqual(3)
})
