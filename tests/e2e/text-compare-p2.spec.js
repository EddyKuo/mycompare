/**
 * e2e for the gap-matrix v3 P2 text-compare items.
 *
 * Unit tests can prove the methods work; only this can prove a user can reach
 * them in the built app, which is the failure mode this project keeps hitting.
 *
 * Run with: npm run test:e2e   (prerequisite: npm run build)
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
    await expect(viewText).toBeVisible({ timeout: 5000 })
  } else if (!(await viewText.isVisible())) {
    await page.locator('#btn-new-session').click()
    await expect(home).toBeVisible({ timeout: 5000 })
    await page.locator('[data-type="text"].session-type-btn').click()
    await expect(viewText).toBeVisible({ timeout: 5000 })
  }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} left
 * @param {string} right
 */
async function loadPair(page, left, right) {
  await page.evaluate(([l, r]) => {
    window.__testAPI.textSetLeft('C:/tmp/left.txt', l)
    window.__testAPI.textSetRight('C:/tmp/right.txt', r)
  }, [left, right])
  await page.waitForTimeout(200)
}

/** @param {import('@playwright/test').Page} page */
async function closeDialog(page) {
  const dlg = page.locator('dialog.tc-dialog')
  if (await dlg.count()) {
    await dlg.locator('button', { hasText: /^(取消|關閉)$/ }).first().click()
    await expect(page.locator('dialog.tc-dialog')).toHaveCount(0)
  }
}

test.beforeEach(async () => {
  await goToTextCompare(win)
  await closeDialog(win)
})

test('Ctrl+Shift+I opens the Text Compare Info dialog with real counts', async () => {
  await loadPair(win, 'one\ntwo\nthree\n', 'one\n2\nthree\nfour\n')
  await win.keyboard.press('Control+Shift+I')
  const dlg = win.locator('dialog.tc-dialog')
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('文字比對資訊')
  await expect(dlg).toContainText('差異區塊')
  await expect(dlg).toContainText('C:/tmp/left.txt')
  await closeDialog(win)
})

test('Ctrl+Shift+F opens the file format dialog with a "same as left" option', async () => {
  await win.keyboard.press('Control+Shift+F')
  const dlg = win.locator('dialog.tc-dialog')
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('檔案格式')
  const selects = dlg.locator('select')
  await expect(selects).toHaveCount(2)
  await expect(selects.nth(1).locator('option[value="same-as-left"]')).toHaveCount(1)
  await closeDialog(win)
})

test('Ctrl+Shift+L opens the alignment dialog and applies a never-align pattern', async () => {
  await loadPair(win, '// note\nkeep\n', 'other\nkeep\n')
  await win.keyboard.press('Control+Shift+L')
  const dlg = win.locator('dialog.tc-dialog')
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('對齊選項')
  await dlg.locator('textarea').fill('^//')
  await dlg.locator('button', { hasText: '套用' }).click()
  await expect(win.locator('dialog.tc-dialog')).toHaveCount(0)
  // Before the rule the two lines were one `replace` row; the rule forbids
  // pairing them, so they must now be a left-only and a right-only row.
  await expect(win.locator('#content-left .diff-line.replace')).toHaveCount(0)
  await expect(win.locator('#content-left .diff-line.delete')).toHaveCount(1)
  await expect(win.locator('#content-right .diff-line.insert')).toHaveCount(1)

  // Clear it so later tests see the default alignment.
  await win.keyboard.press('Control+Shift+L')
  await win.locator('dialog.tc-dialog textarea').fill('')
  await win.locator('dialog.tc-dialog button', { hasText: '套用' }).click()
  await expect(win.locator('dialog.tc-dialog')).toHaveCount(0)
})

test('the context menu carries every new P2 entry', async () => {
  await loadPair(win, 'a\n', 'b\n')
  await win.locator('#content-left').click({ button: 'right' })
  const menu = win.locator('.ctx-menu')
  await expect(menu).toBeVisible()
  for (const label of ['文字比對資訊', '檔案格式', '不重要文字規則', '對齊選項',
    '語法高亮', '單側獨有的行一律視為重要', '空白：忽略行尾', '跳至編號書籤']) {
    await expect(menu).toContainText(label)
  }
  await win.keyboard.press('Escape')
})

test('the whitespace mode entry makes a trailing-space-only change compare equal', async () => {
  await loadPair(win, 'alpha   \nbeta\n', 'alpha\nbeta\n')
  const before = await win.evaluate(() =>
    document.querySelectorAll('#content-left .diff-line.replace, #content-left .diff-line.delete').length)
  expect(before).toBeGreaterThan(0)

  await win.locator('#content-left').click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: '空白：忽略行尾' }).click()
  await win.waitForTimeout(200)

  const after = await win.evaluate(() =>
    document.querySelectorAll('#content-left .diff-line.replace, #content-left .diff-line.delete').length)
  expect(after).toBe(0)

  // Put it back so later tests see the default.
  await win.locator('#content-left').click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: '空白：完全比對' }).click()
  await win.waitForTimeout(200)
})

test('the unimportant-text dialog lists rules as separate rows', async () => {
  await loadPair(win, 'import os\nbody\n', 'import sys\nbody\n')
  await win.locator('#content-left').click({ button: 'right' })
  await win.locator('.ctx-item', { hasText: '不重要文字規則' }).click()
  const dlg = win.locator('dialog.tc-dialog')
  await expect(dlg).toBeVisible()
  await dlg.locator('button', { hasText: '新增規則' }).click()
  await dlg.locator('input[type="text"]').last().fill('^import')
  await dlg.locator('button', { hasText: '套用' }).click()
  await expect(win.locator('dialog.tc-dialog')).toHaveCount(0)
  await expect(win.locator('#content-left .diff-line.unimportant')).toHaveCount(1)
})

test('the syntax highlighting entry survives a round trip', async () => {
  await win.locator('#content-left').click({ button: 'right' })
  await expect(win.locator('.ctx-item', { hasText: '語法高亮' })).toContainText('✓')
  await win.locator('.ctx-item', { hasText: '語法高亮' }).click()
  await win.locator('#content-left').click({ button: 'right' })
  const entry = win.locator('.ctx-item', { hasText: '語法高亮' })
  await expect(entry).not.toContainText('✓')
  await entry.click()
})
