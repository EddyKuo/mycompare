/**
 * e2e for the BC Edit / Search command set in the text view
 * (gap-matrix v2 §1.4, §1.5).
 *
 * These run against the production bundle and drive the commands the way a
 * user does — a real key press, a real right-click — because this project has
 * repeatedly shipped features whose unit tests passed while nothing in the
 * app could reach them.
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

/**
 * @param {import('@playwright/test').Page} page
 */
async function goToTextCompare(page) {
  const home = page.locator('#session-home')
  const viewText = page.locator('#view-text')
  if (await home.isVisible()) {
    await page.locator('[data-type="text"].session-type-btn').click()
  } else if (!(await viewText.isVisible())) {
    await page.locator('#btn-new-session').click()
    await expect(home).toBeVisible({ timeout: 5000 })
    await page.locator('[data-type="text"].session-type-btn').click()
  }
  await expect(viewText).toBeVisible({ timeout: 5000 })
}

/**
 * Load a fresh pair of files and put the caret on one left-hand line.
 * @param {import('@playwright/test').Page} page
 * @param {string} left
 * @param {string} right
 * @param {number} lineNo 1-based left line to click
 */
async function load(page, left, right, lineNo) {
  await goToTextCompare(page)
  await page.evaluate(([l, r]) => {
    window.__testAPI.textSetLeft('L.txt', l)
    window.__testAPI.textSetRight('R.txt', r)
  }, [left, right])
  const row = page.locator(`#content-left .diff-line[data-left-line="${lineNo}"]`)
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.locator('.line-text').click()
  return row
}

/**
 * Text of the left pane, one entry per rendered line.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>}
 */
async function leftLines(page) {
  return page.$$eval('#content-left .diff-line .line-text',
    (els) => els.map(e => e.textContent))
}

test.describe('§1.4 edit commands via keyboard', () => {
  test('Ctrl+D deletes the caret line and Ctrl+Z puts it back', async () => {
    await load(win, 'alpha\nbravo\ncharlie\n', 'alpha\nbravo\ncharlie\n', 2)
    expect(await leftLines(win)).toContain('bravo')

    await win.keyboard.press('Control+d')
    await expect
      .poll(async () => (await leftLines(win)).includes('bravo'))
      .toBe(false)

    await win.keyboard.press('Control+z')
    await expect
      .poll(async () => (await leftLines(win)).includes('bravo'))
      .toBe(true)
  })

  test('Ctrl+Enter inserts a blank line after the caret', async () => {
    await load(win, 'alpha\nbravo\n', 'alpha\nbravo\n', 1)
    const before = (await leftLines(win)).length
    await win.keyboard.press('Control+Enter')
    await expect.poll(async () => (await leftLines(win)).length).toBe(before + 1)
  })

  test('Ctrl+] indents and Ctrl+[ removes the indent again', async () => {
    await load(win, 'alpha\nbravo\n', 'alpha\nbravo\n', 1)
    await win.keyboard.press('Control+]')
    await expect
      .poll(async () => (await leftLines(win)).some(l => l === '    alpha'))
      .toBe(true)

    await win.keyboard.press('Control+[')
    await expect
      .poll(async () => (await leftLines(win)).some(l => l === 'alpha'))
      .toBe(true)
  })

  test('Alt+Shift+ArrowRight copies just the caret line to the right pane', async () => {
    await load(win, 'alpha\nbravo\ncharlie\n', 'alpha\nXXXXX\ncharlie\n', 2)
    await win.keyboard.press('Alt+Shift+ArrowRight')
    await expect
      .poll(() => win.$$eval('#content-right .diff-line .line-text',
        (els) => els.map(e => e.textContent)))
      .toContain('bravo')
  })

  test('a locked side refuses the command and says so', async () => {
    await load(win, 'alpha\nbravo\n', 'alpha\nbravo\n', 2)
    // Lock the left side through the context menu, the user's own route.
    const row = win.locator('#content-left .diff-line[data-left-line="2"]')
    await row.click({ button: 'right' })
    // The text pane's menu is taller than the window and scrolls internally,
    // so the item has to be brought into the menu's own viewport first.
    const lock = win.locator('.ctx-item', { hasText: '鎖定左側' }).first()
    await lock.scrollIntoViewIfNeeded()
    await lock.click({ force: true })

    // Let the "已鎖定" confirmation expire, so the next toast asserted on can
    // only be the refusal.
    await expect(win.locator('.mc-toast')).toHaveCount(0, { timeout: 10000 })

    await row.locator('.line-text').click()
    await win.keyboard.press('Control+d')
    await expect(win.locator('.mc-toast').first()).toContainText('鎖定', { timeout: 3000 })
    expect(await leftLines(win)).toContain('bravo')

    // The view instance outlives this test, so hand the lock back or every
    // later edit command in this file refuses.
    await expect(win.locator('.mc-toast')).toHaveCount(0, { timeout: 10000 })
    await row.click({ button: 'right' })
    const unlock = win.locator('.ctx-item', { hasText: '鎖定左側' }).first()
    await unlock.scrollIntoViewIfNeeded()
    await unlock.click({ force: true })
    await expect(win.locator('.mc-toast').first()).toContainText('解鎖', { timeout: 3000 })
    await expect(win.locator('.mc-toast')).toHaveCount(0, { timeout: 10000 })
  })
})

test.describe('§1.5 navigation commands via keyboard', () => {
  test('Ctrl+F8 moves the in-line difference cursor onto a changed run', async () => {
    await load(win, 'aaXbbbbbbYcc\n', 'aa1bbbbbb2cc\n', 1)
    await win.keyboard.press('Control+F8')
    await expect(win.locator('.char-diff--current').first()).toBeVisible({ timeout: 3000 })
  })

  test('Alt+F8 warns until there is an edit, then jumps to it', async () => {
    await load(win, 'alpha\nbravo\ncharlie\ndelta\n', 'alpha\nbravo\ncharlie\ndelta\n', 1)

    // Nothing edited yet: the command must say so rather than do nothing.
    await win.keyboard.press('Alt+F8')
    await expect(win.locator('.mc-toast').first()).toContainText('編輯', { timeout: 3000 })

    // Edit line 3, then move the caret back to line 1.
    await win.locator('#content-left .diff-line[data-left-line="3"] .line-text').click()
    await win.keyboard.press('Control+]')
    await expect(win.locator('#content-left .diff-line.replace').first())
      .toBeVisible({ timeout: 3000 })
    await expect(win.locator('.mc-toast')).toHaveCount(0, { timeout: 10000 })

    await win.locator('#content-left .diff-line[data-left-line="1"] .line-text').click()
    await win.keyboard.press('Alt+F8')
    // A successful jump is silent; a failed one toasts.
    await expect(win.locator('.mc-toast')).toHaveCount(0, { timeout: 2000 })
  })
})

test.describe('every command is offered by the context menu', () => {
  const LABELS = [
    '複製此行 → 右側',
    '複製此行 → 左側',
    '複製此行 → 另一側',
    '複製此差異 → 另一側',
    '在此行前插入空行',
    '在此行後插入空行',
    '刪除此行',
    '刪除到行首',
    '刪除到行尾',
    '刪除單字',
    '增加縮排',
    '減少縮排',
    '選取此差異區塊',
    '全選',
    '下一個行內差異',
    '上一個行內差異',
    '下一個編輯位置',
    '上一個編輯位置',
    '對齊錨點',
    '對齊錨點',
    'Isolate',
  ]

  test('lists all of them', async () => {
    await load(win, 'alpha\nbravo\n', 'alpha\nBRAVO\n', 1)
    await win.locator('#content-left .diff-line[data-left-line="1"]').click({ button: 'right' })
    const menu = win.locator('.ctx-menu')
    await expect(menu).toBeVisible({ timeout: 3000 })
    const text = await menu.textContent()
    for (const label of LABELS) {
      expect(text, label).toContain(label)
    }
    await win.keyboard.press('Escape')
  })

  test('Align With pins two lines together from the menu', async () => {
    await load(win, 'alpha\nbravo\ncharlie\n', 'alpha\nbravo\ncharlie\n', 2)
    await win.locator('#content-left .diff-line[data-left-line="2"]').click({ button: 'right' })
    await win.locator('.ctx-item', { hasText: '設為對齊錨點' }).first().click()

    await win.locator('#content-right .diff-line[data-right-line="3"]').click({ button: 'right' })
    await win.locator('.ctx-item', { hasText: '完成對齊' }).first().click()

    await expect(win.locator('.diff-line.align-anchor').first()).toBeVisible({ timeout: 3000 })
  })
})
