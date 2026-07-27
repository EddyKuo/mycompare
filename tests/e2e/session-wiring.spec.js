/**
 * Sprint 22 — the host-side wiring, exercised the way a user reaches it.
 *
 * The unit suite can only show that app.js *mentions* a view's guard. What it
 * cannot show is that clicking the × on a tab with unsaved edits stops. That
 * is the failure this project keeps shipping, so it is checked here by
 * clicking the actual button.
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
 * Replace window.confirm with a recorder, so a modal cannot stall the run and
 * the message itself can be asserted on.
 *
 * @param {import('@playwright/test').Page} page
 * @param {boolean} answer what confirm() should return
 */
async function stubConfirm(page, answer) {
  await page.evaluate((a) => {
    window.__confirms = []
    window.confirm = (msg) => { window.__confirms.push(String(msg)); return a }
  }, answer)
}

/**
 * Close every open tab, answering yes to anything that asks.
 * @param {import('@playwright/test').Page} page
 */
async function resetTabs(page) {
  await stubConfirm(page, true)
  await page.evaluate(() => {
    // Preferences live in localStorage and outlive the process, so an earlier
    // spec's toggle would otherwise decide what these assertions see.
    window.__testAPI.navSetPref('confirmOnCloseTab', false)
    for (const _ of window.__testAPI.tabs()) {
      window.__testAPI.menuCommand('session.close')
    }
  })
  await expect(page.locator('#session-home')).toBeVisible({ timeout: 5000 })
}

/**
 * Open a comparison of the given type from the home screen.
 * @param {import('@playwright/test').Page} page
 * @param {string} type
 */
async function openViewFromHome(page, type) {
  await resetTabs(page)
  await page.locator(`[data-type="${type}"].session-type-btn`).click()
  await expect(page.locator(`#view-${type}`)).toBeVisible({ timeout: 5000 })
}

// ---------------------------------------------------------------------------
// A1 — unsaved changes block the close
// ---------------------------------------------------------------------------

test('表格有未儲存的儲存格編輯時，按分頁 × 會被擋下', async () => {
  await openViewFromHome(win, 'table')

  await win.evaluate(() => {
    window.__testAPI.tableSetLeft('left.csv', 'a,b\n1,2\n3,4\n')
    window.__testAPI.tableSetRight('right.csv', 'a,b\n1,2\n3,9\n')
  })

  const firstCell = win.locator('#view-table .tc-pane').first()
    .locator('tr.tc-row:not(.phantom) td.tc-cell').first()
  await expect(firstCell).toBeVisible({ timeout: 5000 })

  await firstCell.dblclick()
  await win.locator('#view-table .tc-cell-input').fill('changed')
  await win.keyboard.press('Enter')

  // The view must actually consider itself dirty, or this test would pass for
  // the wrong reason.
  await expect(win.locator('#view-table .tc-btn--dirty').first()).toBeVisible()

  await stubConfirm(win, false)
  await win.locator('.tab-item--active .tab-close').click()

  const asked = await win.evaluate(() => window.__confirms)
  expect(asked.join('\n')).toMatch(/未儲存/)
  expect(await win.evaluate(() => window.__testAPI.tabs().length)).toBe(1)
  await expect(win.locator('#view-table')).toBeVisible()

  // Saying yes this time really does close it.
  await stubConfirm(win, true)
  await win.locator('.tab-item--active .tab-close').click()
  expect(await win.evaluate(() => window.__testAPI.tabs().length)).toBe(0)
})

test('沒有未儲存修改時，關閉分頁不會多問一次', async () => {
  await openViewFromHome(win, 'table')
  await stubConfirm(win, true)

  await win.locator('.tab-item--active .tab-close').click()

  expect(await win.evaluate(() => window.__confirms)).toEqual([])
  expect(await win.evaluate(() => window.__testAPI.tabs().length)).toBe(0)
})

// ---------------------------------------------------------------------------
// A2 — reserved config names are the app's, not the user's
// ---------------------------------------------------------------------------

test('設定管理不會列出 __mycompare: 保留項目', async () => {
  await openViewFromHome(win, 'folder')

  await win.evaluate(() => {
    const entry = (viewType) => ({
      viewType, settings: { __v: 1, __view: viewType }, createdAt: new Date().toISOString(),
    })
    localStorage.setItem('mycompare:namedConfigs', JSON.stringify({
      __schema: 1,
      entries: {
        '__mycompare:folder-defaults__': entry('folder'),
        '我的資料夾設定': entry('folder'),
      },
    }))
  })

  await win.locator('#btn-config-modal').click()
  await expect(win.locator('#config-modal')).toBeVisible()

  const names = await win.evaluate(() => window.__testAPI.configListNames())
  expect(names).toContain('我的資料夾設定')
  expect(names.some((n) => n.startsWith('__mycompare:'))).toBe(false)

  // Nor can the user write into the namespace by hand.
  await win.locator('#input-config-name').fill('__mycompare:sneaky')
  await win.locator('#btn-config-save').click()
  await expect(win.locator('#config-modal-status')).toContainText('保留')

  await win.locator('#btn-config-modal-cancel').click()
})

// ---------------------------------------------------------------------------
// A3 — every 🖨 goes through the same preview
// ---------------------------------------------------------------------------

test('Hex 視圖的 🖨 列印走共用的列印預覽', async () => {
  await openViewFromHome(win, 'hex')

  await win.evaluate(() => {
    const b64 = btoa('hello world hex report')
    window.__testAPI.hexSetLeft('a.bin', b64)
    window.__testAPI.hexSetRight('b.bin', btoa('hello world hex REPORT'))
  })

  await win.locator('#view-hex .hx-btn-report', { hasText: '列印' }).click()
  await expect(win.locator('#print-preview-modal')).toBeVisible({ timeout: 5000 })
  await expect(win.locator('#print-preview-view')).toContainText('Hex')

  await win.locator('#btn-print-preview-cancel').click()
  await expect(win.locator('#print-preview-modal')).toBeHidden()
})

// ---------------------------------------------------------------------------
// A4 — .html asks instead of assuming
// ---------------------------------------------------------------------------

test('開啟 .html 時詢問要用文字還是表格比對', async () => {
  await resetTabs(win)

  // Not awaited: the picker is shown before anything is read, and the promise
  // only settles once a button is clicked.
  await win.evaluate(() => {
    window.__pickDone = window.__testAPI.openComparison({
      leftPath: 'C:/fixtures/report.html',
      leftContent: '<table><tr><td>1</td></tr></table>',
      rightPath: 'C:/fixtures/report2.html',
      rightContent: '<table><tr><td>2</td></tr></table>',
    })
  })

  const picker = win.locator('#view-picker-modal')
  await expect(picker).toBeVisible({ timeout: 5000 })
  await expect(win.locator('#view-picker-list button')).toHaveCount(2)

  await win.locator('#view-picker-list button[data-view-type="table"]').click()
  await win.evaluate(() => window.__pickDone)

  await expect(picker).toBeHidden()
  await expect(win.locator('#view-table')).toBeVisible()
  expect(await win.evaluate(() => window.__testAPI.tabs().at(-1).type)).toBe('table')
})

test('取消選擇時不會開任何分頁', async () => {
  await resetTabs(win)

  await win.evaluate(() => {
    window.__pickDone = window.__testAPI.openComparison({
      leftPath: 'C:/fixtures/report.html',
      leftContent: '<p>x</p>',
    })
  })
  await expect(win.locator('#view-picker-modal')).toBeVisible({ timeout: 5000 })
  await win.locator('#btn-view-picker-cancel').click()
  await win.evaluate(() => window.__pickDone)

  expect(await win.evaluate(() => window.__testAPI.tabs().length)).toBe(0)
})

// ---------------------------------------------------------------------------
// B — BC Session menu
// ---------------------------------------------------------------------------

test('Locked：鎖定後重新比對被忽略，分頁標題出現鎖頭', async () => {
  await openViewFromHome(win, 'text')

  await win.evaluate(() => window.__testAPI.menuCommand('session.locked'))
  expect(await win.evaluate(() => window.__testAPI.tabs()[0].locked)).toBe(true)
  await expect(win.locator('.tab-item--active .tab-title')).toContainText('🔒')

  await win.evaluate(() => window.__testAPI.menuCommand('session.recompare'))
  await expect(win.locator('#status-message')).toContainText('已鎖定')

  await win.evaluate(() => window.__testAPI.menuCommand('session.locked'))
  expect(await win.evaluate(() => window.__testAPI.tabs()[0].locked)).toBe(false)
})

test('Clear Session：清空後仍是同一種比對，且沒有檔案', async () => {
  await resetTabs(win)
  await win.evaluate(() => window.__testAPI.openComparison({
    type: 'text',
    leftPath: 'C:/fixtures/a.txt', leftContent: 'a\nb\n',
    rightPath: 'C:/fixtures/b.txt', rightContent: 'a\nc\n',
  }))
  expect(await win.evaluate(() => window.__testAPI.tabs()[0].leftPath))
    .toBe('C:/fixtures/a.txt')

  await stubConfirm(win, true)
  await win.evaluate(() => window.__testAPI.menuCommand('session.clear'))

  const tabs = await win.evaluate(() => window.__testAPI.tabs())
  expect(tabs.length).toBe(1)
  expect(tabs[0].type).toBe('text')
  expect(tabs[0].leftPath).toBe('')
  await expect(win.locator('#view-text')).toBeVisible()
})

test('Save Session As：以自訂名稱另存，出現在最近的 Session', async () => {
  await resetTabs(win)
  await win.evaluate(() => window.__testAPI.openComparison({
    type: 'text',
    leftPath: 'C:/fixtures/a.txt', leftContent: 'a\n',
    rightPath: 'C:/fixtures/b.txt', rightContent: 'b\n',
  }))

  // Driven through the real dialog rather than by stubbing window.prompt. The
  // stub used to pass because app.js called the native prompt — which throws
  // in Electron, so the command could never have worked for a user. A test
  // that replaces the broken call cannot notice it is broken.
  // Not awaited: the command only resolves once the dialog is answered.
  void win.evaluate(() => window.__testAPI.menuCommand('session.saveAs'))
  const nameInput = win.locator('.mc-modal-overlay .mc-modal-input')
  await expect(nameInput).toBeVisible({ timeout: 5000 })
  await nameInput.fill('我的比對設定 A')
  await win.locator('.mc-modal-overlay .mc-modal-btn--primary').click()

  await expect(win.locator('#status-message')).toContainText('我的比對設定 A')
  await expect(win.locator('.tab-item--active .tab-title')).toContainText('我的比對設定 A')

  const names = await win.evaluate(() =>
    window.__testAPI.tabs().length >= 0 &&
    Object.values(JSON.parse(localStorage.getItem('mycompare:sessions')).entries)
      .map((raw) => JSON.parse(raw).name))
  expect(names).toContain('我的比對設定 A')
})

test('Compare Parent Folders：以兩檔的上層資料夾開資料夾比對', async () => {
  await resetTabs(win)
  await win.evaluate(() => window.__testAPI.openComparison({
    type: 'text',
    leftPath: 'C:/fixtures/left/a.txt', leftContent: 'a\n',
    rightPath: 'C:/fixtures/right/a.txt', rightContent: 'b\n',
  }))

  await win.evaluate(() => window.__testAPI.menuCommand('session.compareParentFolders'))
  await expect(win.locator('#view-folder')).toBeVisible({ timeout: 5000 })

  const last = await win.evaluate(() => window.__testAPI.tabs().at(-1))
  expect(last.type).toBe('folder')
})

// ---------------------------------------------------------------------------
// 三向合併的兩個 hand-off
// ---------------------------------------------------------------------------

/** @param {import('@playwright/test').Page} page */
async function openMerge3WithPaths(page) {
  await openViewFromHome(page, 'merge3')
  await page.evaluate(() => {
    window.__testAPI.mergeSetAll('a\nL\nc\n', 'a\nb\nc\n', 'a\nR\nc\n', {
      left:  'C:/fixtures/left/a.txt',
      base:  'C:/fixtures/base/a.txt',
      right: 'C:/fixtures/right/a.txt',
    })
  })
}

test('Merge Parent Folders：接上後按鈕啟用，三個來源都在時開三向資料夾比對', async () => {
  await openMerge3WithPaths(win)

  // The view keeps this disabled until app.js subscribes, so an enabled button
  // is itself the assertion that the hand-off is wired.
  const btn = win.locator('.mw-btn-parent-folders')
  await expect(btn).toBeEnabled()

  await btn.click()
  await expect(win.locator('#view-folder')).toBeVisible({ timeout: 5000 })

  // This used to assert 「左側與右側」, i.e. that the base was thrown away. That
  // encoded a limitation rather than a requirement: the ancestor is the whole
  // basis for deciding who changed what, so a merge's parent folders opened
  // without it show every difference as a conflict.
  await expect(win.locator('#status-message')).toContainText('三向')

  const last = await win.evaluate(() => window.__testAPI.tabs().at(-1))
  expect(last.type).toBe('folder')

  // The base really arrived, rather than the status line merely saying so.
  const threeSided = await win.evaluate(() =>
    document.querySelectorAll('#view-folder .fc-header-side').length)
  expect(threeSided).toBe(3)
})

test('Compare to Output：在真正的文字比對分頁開啟，而不是唯讀對話框', async () => {
  await openMerge3WithPaths(win)

  await win.locator('.mw-output-cmp-select').selectOption('left')
  await win.locator('.mw-btn-compare-output').click()

  await expect(win.locator('#view-text')).toBeVisible({ timeout: 5000 })
  // The view's own fallback dialog must not have been used.
  await expect(win.locator('.mw-modal')).toHaveCount(0)
  await expect(win.locator('.tab-item--active .tab-title')).toContainText('合併輸出')

  const contents = await win.evaluate(() => window.__testAPI.textGetContents())
  expect(contents.left).toContain('L')
  expect(contents.right.length).toBeGreaterThan(0)
})

test('Compare Files Using：以選擇的視圖重開同樣的兩個檔案', async () => {
  await resetTabs(win)
  await win.evaluate(() => window.__testAPI.openComparison({
    type: 'text',
    leftPath: 'C:/fixtures/a.csv', leftContent: 'a,b\n1,2\n',
    rightPath: 'C:/fixtures/b.csv', rightContent: 'a,b\n1,3\n',
  }))

  // Not awaited: the command only resolves once the picker is answered.
  await win.evaluate(() => window.__testAPI.menuCommand('session.compareUsing'))
  await expect(win.locator('#view-picker-modal')).toBeVisible({ timeout: 5000 })
  // The view already in use is not offered again.
  await expect(win.locator('#view-picker-list button[data-view-type="text"]')).toHaveCount(0)

  await win.locator('#view-picker-list button[data-view-type="table"]').click()
  await expect(win.locator('#view-table')).toBeVisible({ timeout: 5000 })
  expect(await win.evaluate(() => window.__testAPI.tabs().at(-1).type)).toBe('table')
})
