/**
 * Alignment mode (BC 1.7) and the Text options page (BC 1.9), end to end.
 *
 * Unit tests can only show that the pure functions and the setters work; these
 * go through the dialogs a user actually reaches, which is where the previous
 * "complete module, no caller" defects lived.
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

test('the alignment dialog offers the three modes and never-align removes paired rows', async () => {
  await loadPair(win, 'a\nb\nc\nd\n', 'a\nx\ny\nd\n')

  // Standard alignment pairs b/x and c/y into changed rows.
  const pairedBefore = await win.evaluate(() =>
    document.querySelectorAll('#view-text .diff-line.replace').length)

  await win.keyboard.press('Control+Shift+L')
  const dlg = win.locator('dialog.tc-dialog')
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('對齊模式')
  await expect(dlg.locator('input[name="tc-align-mode"]')).toHaveCount(3)

  await dlg.locator('input[name="tc-align-mode"][value="never"]').check()
  await dlg.locator('button', { hasText: '套用' }).first().click()
  await expect(win.locator('dialog.tc-dialog')).toHaveCount(0)
  await win.waitForTimeout(200)

  const pairedAfter = await win.evaluate(() =>
    document.querySelectorAll('#view-text .diff-line.replace').length)
  expect(pairedBefore).toBeGreaterThan(0)
  expect(pairedAfter).toBe(0)

  // Put it back so later specs see the default.
  await win.keyboard.press('Control+Shift+L')
  await expect(win.locator('dialog.tc-dialog')).toBeVisible()
  await win.locator('dialog.tc-dialog input[name="tc-align-mode"][value="standard"]').check()
  await win.locator('dialog.tc-dialog button', { hasText: '套用' }).first().click()
  await expect(win.locator('dialog.tc-dialog')).toHaveCount(0)
})

test('unaligned mode lays row N against row N', async () => {
  // Standard alignment finds the common "b"/"c"; unaligned must not.
  await loadPair(win, 'b\nc\n', 'a\nb\nc\n')

  await win.keyboard.press('Control+Shift+L')
  const dlg = win.locator('dialog.tc-dialog')
  await expect(dlg).toBeVisible()
  await dlg.locator('input[name="tc-align-mode"][value="unaligned"]').check()
  await dlg.locator('button', { hasText: '套用' }).first().click()
  await expect(win.locator('dialog.tc-dialog')).toHaveCount(0)
  await win.waitForTimeout(200)

  // Standard alignment would report no changed rows at all here (b and c match
  // outright); unaligned turns both into row-against-row changes.
  const paired = await win.evaluate(() =>
    document.querySelectorAll('#view-text .diff-line.replace').length)
  expect(paired).toBeGreaterThan(0)

  await win.keyboard.press('Control+Shift+L')
  await expect(win.locator('dialog.tc-dialog')).toBeVisible()
  await win.locator('dialog.tc-dialog input[name="tc-align-mode"][value="standard"]').check()
  await win.locator('dialog.tc-dialog button', { hasText: '套用' }).first().click()
  await expect(win.locator('dialog.tc-dialog')).toHaveCount(0)
})

test('the editor options dialog is reachable from the right-click menu and auto indent works', async () => {
  await loadPair(win, 'foo\n', 'foo\n')

  const pane = win.locator('#pane-left')
  await pane.click({ button: 'right', position: { x: 40, y: 40 } })
  const menu = win.locator('.ctx-menu')
  await expect(menu).toBeVisible({ timeout: 3000 })
  await menu.locator('text=編輯器選項').first().click()

  const dlg = win.locator('dialog.tc-dialog')
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('自動縮排')
  await expect(dlg).toContainText('Backspace 反縮排')
  await expect(dlg).toContainText('允許游標超過行尾')
  await dlg.locator('input[type="checkbox"]').first().check()
  await dlg.locator('button', { hasText: '套用' }).first().click()
  await expect(win.locator('dialog.tc-dialog')).toHaveCount(0)

  // Enter inside an indented line now carries the indentation across.
  await win.evaluate(() => {
    window.__testAPI.textSetLeft('C:/tmp/left.txt', '    indented\n')
  })
  await win.keyboard.press('Control+e')
  const ta = win.locator('#pane-left textarea.edit-textarea')
  await expect(ta).toBeVisible()
  await ta.click()
  await win.evaluate(() => {
    const el = document.querySelector('#pane-left textarea.edit-textarea')
    el.selectionStart = el.selectionEnd = '    indented'.length
  })
  await win.keyboard.press('Enter')
  await expect(ta).toHaveValue('    indented\n    \n')

  await win.keyboard.press('Control+e')
})
