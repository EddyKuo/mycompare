/**
 * E2E for the Sprint 25 gap-matrix items.
 *
 * The unit suite proves the logic; this proves a user inside the production
 * bundle can reach it. That distinction is the one this project keeps getting
 * wrong — nine features have shipped complete and uncallable.
 *
 *   merge3 — editable output, ignore unimportant, info, conflict proximity,
 *            manual conflict marks, take-both in either order
 *   text   — Merge Files, load from archive, Text Replacements
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

test.beforeAll(async () => { ;({ app, win } = await launchApp()) })
test.afterAll(async () => { await closeApp(app) })

/** @param {import('@playwright/test').Page} page */
async function goToMerge(page) {
  const view = page.locator('#view-merge3')
  if (await view.isVisible()) return
  await page.locator('#btn-new-session').click()
  await expect(page.locator('#session-home')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-type="merge3"].session-type-btn').click()
  await expect(view).toBeVisible({ timeout: 5000 })
}

/** @param {import('@playwright/test').Page} page */
async function goToText(page) {
  const view = page.locator('#view-text')
  if (await view.isVisible()) return
  await page.locator('#btn-new-session').click()
  await expect(page.locator('#session-home')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-type="text"].session-type-btn').click()
  await expect(view).toBeVisible({ timeout: 5000 })
}

/** One conflicting line in the middle, which every merge test below needs. */
async function loadConflict(page) {
  await page.evaluate(() => {
    window.__testAPI.mergeSetAll('a\nL\nc\n', 'a\nb\nc\n', 'a\nR\nc\n')
  })
}

// ---------------------------------------------------------------------------
// 3-way merge
// ---------------------------------------------------------------------------

test('合併輸出可直接編輯，並標示為手動編輯', async () => {
  await goToMerge(win)
  await loadConflict(win)

  await win.locator('.mw-btn-edit-output').click()
  const ta = win.locator('.mw-output-textarea')
  await expect(ta).toBeVisible()

  await ta.fill('手寫的合併結果')
  await expect(win.locator('.mw-output-edited-badge')).toBeVisible()
  await expect(win.locator('.mw-btn-discard-output')).toBeVisible()

  // Back to the cards, and the hand edit is still what would be saved.
  await win.locator('.mw-btn-edit-output').click()
  await expect(win.locator('.mw-output-edited-note')).toBeVisible()

  await win.locator('.mw-btn-discard-output').click()
  await expect(win.locator('.mw-output-edited-badge')).toBeHidden()
})

test('衝突卡片提供兩者（左→右）與兩者（右→左）', async () => {
  await goToMerge(win)
  await loadConflict(win)

  await win.locator('.mw-choice-both-rl').first().click()
  const output = await win.evaluate(() =>
    document.querySelector('.mw-output-textarea').value)
  expect(output).toContain('R\nL')
})

test('工具列可批次套用任一種來源', async () => {
  await goToMerge(win)
  await loadConflict(win)

  await win.locator('.mw-resolve-all-select').selectOption('base')
  await win.locator('.mw-btn-resolve-all').click()
  const output = await win.evaluate(() =>
    document.querySelector('.mw-output-textarea').value)
  expect(output).toContain('b')
})

test('鄰近門檻把兩側相鄰的變更併為同一個衝突', async () => {
  await goToMerge(win)
  await win.evaluate(() => {
    window.__testAPI.mergeSetAll(
      'a\nB\nc\nd\ne\n', 'a\nb\nc\nd\ne\n', 'a\nb\nc\nD\ne\n')
  })
  await expect(win.locator('.mw-conflict-counter')).toHaveText(/無衝突/)

  await win.locator('.mw-proximity-input').fill('3')
  await win.locator('.mw-proximity-input').blur()
  await expect(win.locator('.mw-conflict-counter')).toHaveText(/1 個衝突|\/ 1/)
})

test('忽略不重要差異可從工具列開關，並提供樣式編輯器', async () => {
  await goToMerge(win)
  await win.evaluate(() => {
    window.__testAPI.mergeSetAll(
      'a\nv = 2 // left\nc\n', 'a\nv = 1\nc\n', 'a\nv = 2 // right\nc\n')
  })
  await expect(win.locator('.mw-conflict-counter')).toHaveText(/1/)

  await win.locator('.mw-btn-unimportant-edit').click()
  const modal = win.locator('.mw-modal')
  await expect(modal).toBeVisible()
  await modal.locator('.mw-modal-textarea').fill('//.*$')
  await modal.locator('button', { hasText: '套用' }).click()

  await expect(win.locator('.mw-unimportant-check')).toBeChecked()
  await expect(win.locator('.mw-conflict-counter')).toHaveText(/無衝突/)
})

test('資訊對話框列出三個來源的統計', async () => {
  await goToMerge(win)
  await loadConflict(win)

  await win.locator('.mw-btn-info').click()
  const modal = win.locator('.mw-modal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.mw-info-table')).toHaveCount(3)
  await expect(modal).toContainText('衝突總數')
  await modal.locator('.mw-modal-close', { hasText: '關閉' }).click()
})

test('手動標記衝突：沒有選取時明確報錯，選取後產生衝突', async () => {
  await goToMerge(win)
  await win.evaluate(() => {
    window.__testAPI.mergeSetAll('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nc\n')
  })
  await expect(win.locator('.mw-conflict-counter')).toHaveText(/無衝突/)

  await win.locator('.mw-btn-mark-conflict').click()
  await expect(win.locator('#status-message')).toContainText('選取')

  // Select the second base row, then mark it.
  await win.evaluate(() => {
    const row = document.querySelector('.mw-content-base .mw-line[data-line="2"]')
    const range = document.createRange()
    range.selectNodeContents(row)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  })
  await win.locator('.mw-btn-mark-conflict').click()
  await expect(win.locator('.mw-conflict-counter')).toHaveText(/1/)

  await win.locator('.mw-btn-clear-conflicts').click()
  await expect(win.locator('.mw-conflict-counter')).toHaveText(/無衝突/)
})

// ---------------------------------------------------------------------------
// Text compare
// ---------------------------------------------------------------------------

test('文字比對右鍵選單提供取代規則、三向合併與封存檔入口', async () => {
  await goToText(win)
  await win.evaluate(() => {
    window.__testAPI.textSetLeft('a.txt', 'x = 1;\n')
    window.__testAPI.textSetRight('b.txt', 'x=1;\n')
  })

  await win.locator('#content-left').click({ button: 'right' })
  await expect(win.locator('.ctx-menu')).toBeVisible({ timeout: 3000 })
  await expect(win.locator('.ctx-item', { hasText: '文字取代規則' })).toHaveCount(1)
  await expect(win.locator('.ctx-item', { hasText: '轉為三向合併（選擇基準檔）' })).toHaveCount(1)
  await expect(win.locator('.ctx-item', { hasText: '轉為三向合併（無基準檔）' })).toHaveCount(1)
  await expect(win.locator('.ctx-item', { hasText: '從封存檔載入' })).toHaveCount(1)
  await win.keyboard.press('Escape')
})

test('取代規則讓等價但寫法不同的行視為相同', async () => {
  await goToText(win)
  await win.evaluate(() => {
    window.__testAPI.textSetLeft('a.txt', 'x = 1;\nkeep\n')
    window.__testAPI.textSetRight('b.txt', 'x=1;\nkeep\n')
  })
  await expect(win.locator('#diff-counter')).not.toHaveText(/0 \/ 0/)

  await win.locator('#content-left').click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: '文字取代規則' }).click()

  const dlg = win.locator('dialog.tc-dialog')
  await expect(dlg).toBeVisible({ timeout: 3000 })
  await dlg.locator('.tc-dialog-textarea').fill('re: \\s+ => ')
  await dlg.locator('button', { hasText: '套用' }).click()
  await expect(dlg).toBeHidden()

  // Equivalent now, and the pane still shows the original spacing.
  await expect(win.locator('#diff-counter')).toHaveText(/0 \/ 0|無差異/)
  await expect(win.locator('#content-left')).toContainText('x = 1;')
})

test('取代規則拒絕會災難性回溯的樣式，並留在對話框說明原因', async () => {
  await goToText(win)
  await win.locator('#content-left').click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: '文字取代規則' }).click()

  const dlg = win.locator('dialog.tc-dialog')
  await expect(dlg).toBeVisible({ timeout: 3000 })
  await dlg.locator('.tc-dialog-textarea').fill('re: (a+)+$ => x')
  await dlg.locator('button', { hasText: '套用' }).click()

  await expect(dlg).toBeVisible()
  await expect(dlg.locator('.tc-dialog-errors')).toContainText('被拒絕')
  await dlg.locator('button', { hasText: '取消' }).click()
})

test('轉為三向合併（無基準檔）會帶著兩側內容開啟合併工作階段', async () => {
  await goToText(win)
  await win.evaluate(() => {
    window.__testAPI.textSetLeft('a.txt', 'a\nb\nc\n')
    window.__testAPI.textSetRight('b.txt', 'a\nB\nc\n')
  })

  await win.locator('#content-left').click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: '轉為三向合併（無基準檔）' }).click()

  await expect(win.locator('#view-merge3')).toBeVisible({ timeout: 5000 })
  await expect(win.locator('.mw-content-left')).toContainText('b')
  await expect(win.locator('.mw-content-right')).toContainText('B')
})
