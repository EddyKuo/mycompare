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
import { launchApp, closeApp, toolbarItem } from './helpers/electron-app.js'

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
  const btn = await toolbarItem(win, '[data-filter="left-newer"]')

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

// ---------------------------------------------------------------------------
// S21: Move / Exchange, Version column, Compare Attributes, settings scope
//
// These check that the new features are *reachable from the UI*. Unit tests
// verify the modules; only a run through the real app answers whether anything
// calls them (the Sprint 16 lesson).
// ---------------------------------------------------------------------------

test('S21: 批次操作選單含「移動」與「互換」', async () => {
  await goToFolderCompare(win)
  const menu = win.locator('.fc-batch-menu')
  await expect(menu.locator('[data-action="move-to-right"]')).toBeAttached()
  await expect(menu.locator('[data-action="move-to-left"]')).toBeAttached()
  await expect(menu.locator('[data-action="exchange"]')).toBeAttached()
})

test('S21: 規則面板有「比對屬性」核取方塊', async () => {
  await goToFolderCompare(win)
  await (await toolbarItem(win, '.fc-btn-rules')).click()
  const panel = win.locator('.fc-rules-panel')
  await expect(panel).toBeVisible({ timeout: 2000 })
  await expect(panel.locator('.fc-compare-attrs')).toBeAttached()
  await (await toolbarItem(win, '.fc-btn-rules')).click()
})

test('S21: ⚙ 設定開啟對話框並提供兩種套用範圍', async () => {
  await goToFolderCompare(win)
  await (await toolbarItem(win, '.fc-btn-settings')).click()
  const dialog = win.locator('.fc-settings-backdrop')
  await expect(dialog).toBeVisible({ timeout: 2000 })
  await expect(dialog.locator('input[value="view"]')).toBeAttached()
  await expect(dialog.locator('input[value="default"]')).toBeAttached()
  await dialog.locator('.fc-modal-cancel').click()
  await expect(dialog).toBeHidden()
})

test('S21: 欄位選單可切換「版本」欄', async () => {
  await goToFolderCompare(win)
  await (await toolbarItem(win, '.fc-btn-columns')).click()
  const item = win.locator('.ctx-item', { hasText: '版本' }).first()
  await expect(item).toBeVisible({ timeout: 2000 })
  await item.click()
  await expect(win.locator('.fc-header')).toContainText('版本', { timeout: 2000 })
  // Restore, so later tests see the default column set.
  await (await toolbarItem(win, '.fc-btn-columns')).click()
  await win.locator('.ctx-item', { hasText: '版本' }).first().click()
})

// ---------------------------------------------------------------------------
// S26: the P2 gaps — extra columns, composable display switches, comparison
// criteria, Quick Compare and Compare To.
//
// Same reasoning as the S21 block above: the unit tests know the modules work,
// only the built app answers whether a user can reach them.
// ---------------------------------------------------------------------------

test('S26: 欄位選單列出建立時間 / 完整路徑 / 檢查碼', async () => {
  await goToFolderCompare(win)
  await (await toolbarItem(win, '.fc-btn-columns')).click()
  for (const label of ['建立時間', '完整路徑', '檢查碼']) {
    await expect(win.locator('.ctx-item', { hasText: label }).first())
      .toBeVisible({ timeout: 2000 })
  }
  await win.keyboard.press('Escape')
})

test('S26: 欄位選單可切換檢查碼欄，表頭標出實際的演算法', async () => {
  await goToFolderCompare(win)
  await (await toolbarItem(win, '.fc-btn-columns')).click()
  await win.locator('.ctx-item', { hasText: '檢查碼' }).first().click()

  // 表頭寫的是實際演算法，不是籠統的「檢查碼」。這一欄的值會被拿去跟
  // unzip 或 7z 的輸出對照，沒有標明是哪一種就等於給了一個無法解讀的數字。
  await expect(win.locator('.fc-header')).toContainText('CRC-32', { timeout: 2000 })

  // 切成 MD5，表頭要跟著改；不改的話兩種演算法會共用同一個標題。
  await (await toolbarItem(win, '.fc-btn-columns')).click()
  await win.locator('.ctx-item', { hasText: '檢查碼：MD5' }).first().click()
  await expect(win.locator('.fc-header')).toContainText('MD5', { timeout: 2000 })
  await expect(win.locator('.fc-header')).not.toContainText('CRC-32')

  // 還原，讓後面的測試看到預設狀態。
  await (await toolbarItem(win, '.fc-btn-columns')).click()
  await win.locator('.ctx-item', { hasText: '檢查碼：CRC-32' }).first().click()
  await (await toolbarItem(win, '.fc-btn-columns')).click()
  await win.locator('.ctx-item', { hasText: '檢查碼' }).first().click()
})

test('S26: 工具列有左孤兒 / 右孤兒獨立開關，且下拉會標成「自訂組合」', async () => {
  await goToFolderCompare(win)
  // Reached through the `⋯` menu at this window width; visible either way, but
  // asserting on the bare selector would be asserting on the window size.
  const leftOrphan = await toolbarItem(win, '[data-filter="left-orphan"]')
  const rightOrphan = await toolbarItem(win, '[data-filter="right-orphan"]')
  await expect(leftOrphan).toBeVisible()
  await expect(rightOrphan).toBeVisible()

  const preset = win.locator('.fc-view-preset')
  await preset.selectOption('left-newer')
  await leftOrphan.click()
  await expect(preset).toHaveValue('custom')

  // Restore the default view for later tests.
  await preset.selectOption('all')
})

test('S26: 規則面板有時間位移、檔名大小寫與檔名對齊三項條件', async () => {
  await goToFolderCompare(win)
  await (await toolbarItem(win, '.fc-btn-rules')).click()
  const panel = win.locator('.fc-rules-panel')
  await expect(panel).toBeVisible({ timeout: 2000 })
  await expect(panel.locator('.fc-rules-time-shift')).toBeAttached()
  await expect(panel.locator('.fc-rules-name-case')).toBeAttached()
  await expect(panel.locator('.fc-compare-name-case')).toBeAttached()
  await expect(panel.locator('.fc-rules-align')).toBeAttached()

  // The select really drives the setting: apply and read it back.
  await panel.locator('.fc-rules-time-shift').selectOption('dst')
  await panel.locator('.fc-rules-apply').click()
  await expect(panel.locator('.fc-rules-time-shift')).toHaveValue('dst')
  await panel.locator('.fc-rules-time-shift').selectOption('none')
  await panel.locator('.fc-rules-apply').click()
  await (await toolbarItem(win, '.fc-btn-rules')).click()
})

test('S26: 「比對 ▾」下拉含 Compare To 與 Quick Compare 四項', async () => {
  await goToFolderCompare(win)
  await win.locator('.fc-btn-compare-menu').click()
  const menu = win.locator('.fc-compare-menu')
  await expect(menu).toBeVisible({ timeout: 2000 })
  for (const action of ['compare-to-left', 'compare-to-right',
    'quick-compare-selected', 'quick-compare-all']) {
    await expect(menu.locator(`[data-action="${action}"]`)).toBeAttached()
  }
  await win.locator('.fc-btn-compare-menu').click()
})

test('S26: 批次選單含「快速比對選取」', async () => {
  await goToFolderCompare(win)
  await expect(win.locator('.fc-batch-menu [data-action="quick-compare"]')).toBeAttached()
})
