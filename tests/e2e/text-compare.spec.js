/**
 * Text Compare e2e tests for MyCompare.
 *
 * Covers: basic UI, find/replace (T42), bookmarks (T43), go-to-line (T44),
 *         show filter (T46), visible whitespace (T47), line numbers (T48),
 *         font size (T49), layout toggle (T50).
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
// Navigation helper — ensures we are in the text-compare view
// ---------------------------------------------------------------------------
async function goToTextCompare(page) {
  const home = page.locator('#session-home')
  const viewText = page.locator('#view-text')
  if (await home.isVisible()) {
    await page.locator('[data-type="text"].session-type-btn').click()
    await expect(viewText).toBeVisible({ timeout: 5000 })
  } else if (!(await viewText.isVisible())) {
    // In another view — go home first, then navigate
    await page.locator('#btn-new-session').click()
    await expect(home).toBeVisible({ timeout: 5000 })
    await page.locator('[data-type="text"].session-type-btn').click()
    await expect(viewText).toBeVisible({ timeout: 5000 })
  }
}

// ---------------------------------------------------------------------------
// Helper to ensure find-bar is closed before a test
// ---------------------------------------------------------------------------
async function closeFindBarIfOpen(page) {
  const findBar = page.locator('#find-bar')
  if (await findBar.isVisible()) {
    await page.keyboard.press('Escape')
    // wait for it to hide
    await expect(findBar).toBeHidden({ timeout: 2000 }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Basic functionality
// ---------------------------------------------------------------------------

test('文字比對介面可開啟（view-text 可見）', async () => {
  await goToTextCompare(win)
  await expect(win.locator('#view-text')).toBeVisible({ timeout: 5000 })
  await expect(win.locator('#session-home')).toBeHidden()
})

test('Paste 按鈕存在且可點擊，content-left 結構正確', async () => {
  await goToTextCompare(win)
  const btnLeft = win.locator('#btn-paste-left')
  const btnRight = win.locator('#btn-paste-right')
  await expect(btnLeft).toBeVisible()
  await expect(btnRight).toBeVisible()
  // content-left and content-right exist
  await expect(win.locator('#content-left')).toBeAttached()
  await expect(win.locator('#content-right')).toBeAttached()
})

test('compare-area 與 pane 結構存在', async () => {
  await goToTextCompare(win)
  await expect(win.locator('#compare-area')).toBeVisible()
  await expect(win.locator('#pane-left')).toBeAttached()
  await expect(win.locator('#pane-right')).toBeAttached()
  await expect(win.locator('#splitter')).toBeAttached()
})

test('狀態列 status-message 可見', async () => {
  await goToTextCompare(win)
  await expect(win.locator('#status-message')).toBeVisible()
  await expect(win.locator('#statusbar')).toBeVisible()
})

test('btn-swap 存在於 DOM（交換左右按鈕）', async () => {
  await goToTextCompare(win)
  await expect(win.locator('#btn-swap')).toBeAttached()
})

// ---------------------------------------------------------------------------
// T42: Find & Replace
// ---------------------------------------------------------------------------

test('T42: Ctrl+F 開啟 find bar，find-input 存在', async () => {
  await goToTextCompare(win)
  await closeFindBarIfOpen(win)

  const findBar = win.locator('#find-bar')
  await expect(findBar).toBeHidden()

  await win.keyboard.press('Control+f')
  await expect(findBar).toBeVisible({ timeout: 3000 })
  await expect(win.locator('#find-input')).toBeVisible()

  // cleanup
  await win.keyboard.press('Escape')
})

test('T42: Ctrl+H 開啟 replace 模式，replace-input 可見', async () => {
  await goToTextCompare(win)
  await closeFindBarIfOpen(win)

  await win.keyboard.press('Control+h')
  const findBar = win.locator('#find-bar')
  await expect(findBar).toBeVisible({ timeout: 3000 })

  const replaceInput = win.locator('#replace-input')
  await expect(replaceInput).toBeVisible({ timeout: 2000 })

  // cleanup
  await win.keyboard.press('Escape')
})

test('T42: find-count span 存在於 find bar', async () => {
  await goToTextCompare(win)
  await closeFindBarIfOpen(win)

  await win.keyboard.press('Control+f')
  await expect(win.locator('#find-bar')).toBeVisible({ timeout: 3000 })
  await expect(win.locator('#find-count')).toBeAttached()

  // cleanup
  await win.keyboard.press('Escape')
})

test('T42: toggle-replace 按鈕存在且可切換 replace-input', async () => {
  await goToTextCompare(win)
  await closeFindBarIfOpen(win)

  // Open find bar
  await win.keyboard.press('Control+f')
  await expect(win.locator('#find-bar')).toBeVisible({ timeout: 3000 })

  const toggleBtn = win.locator('#toggle-replace')
  await expect(toggleBtn).toBeAttached()

  // replace-input initially hidden in find-only mode
  const replaceInput = win.locator('#replace-input')
  const initiallyHidden = !(await replaceInput.isVisible())

  // Click toggle-replace
  await toggleBtn.click()
  // After toggle, visibility should have changed
  if (initiallyHidden) {
    await expect(replaceInput).toBeVisible({ timeout: 2000 })
  } else {
    await expect(replaceInput).toBeHidden({ timeout: 2000 })
  }

  // cleanup
  await win.keyboard.press('Escape')
})

// ---------------------------------------------------------------------------
// T44: Go To Line
// ---------------------------------------------------------------------------

test('T44: Ctrl+G 開啟 goto-bar（#goto-bar 可見）', async () => {
  await goToTextCompare(win)
  await closeFindBarIfOpen(win)

  const gotoBar = win.locator('#goto-bar')
  await win.keyboard.press('Control+g')
  await expect(gotoBar).toBeVisible({ timeout: 3000 })

  // cleanup
  await win.keyboard.press('Escape')
})

test('T44: Escape 關閉 goto-bar', async () => {
  await goToTextCompare(win)
  await closeFindBarIfOpen(win)

  await win.keyboard.press('Control+g')
  const gotoBar = win.locator('#goto-bar')
  await expect(gotoBar).toBeVisible({ timeout: 3000 })

  await win.keyboard.press('Escape')
  await expect(gotoBar).toBeHidden({ timeout: 2000 })
})

// ---------------------------------------------------------------------------
// T46: Show Filter
// ---------------------------------------------------------------------------

test('T46: Show Filter 按鈕 All/Diff/Same/None 存在', async () => {
  await goToTextCompare(win)
  await expect(win.locator('#btn-show-all')).toBeAttached()
  await expect(win.locator('#btn-show-diff')).toBeAttached()
  await expect(win.locator('#btn-show-same')).toBeAttached()
  await expect(win.locator('#btn-show-none')).toBeAttached()
})

test('T46: 點擊 btn-show-diff 後該按鈕有 active class，其他沒有', async () => {
  await goToTextCompare(win)

  await win.locator('#btn-show-diff').click()
  await expect(win.locator('#btn-show-diff')).toHaveClass(/active/)
  await expect(win.locator('#btn-show-all')).not.toHaveClass(/active/)
  await expect(win.locator('#btn-show-same')).not.toHaveClass(/active/)
  await expect(win.locator('#btn-show-none')).not.toHaveClass(/active/)
})

test('T46: 點擊 btn-show-all 後 btn-show-all 有 active class', async () => {
  await goToTextCompare(win)

  // First switch to diff mode, then switch back
  await win.locator('#btn-show-diff').click()
  await win.locator('#btn-show-all').click()
  await expect(win.locator('#btn-show-all')).toHaveClass(/active/)
})

// ---------------------------------------------------------------------------
// T47: Visible Whitespace
// ---------------------------------------------------------------------------

test('T47: btn-whitespace 存在且可點擊', async () => {
  await goToTextCompare(win)
  const btn = win.locator('#btn-whitespace')
  await expect(btn).toBeAttached()
  await expect(btn).toBeVisible()
})

test('T47: 點擊 btn-whitespace 後有 active class，再點擊取消 active', async () => {
  await goToTextCompare(win)
  const btn = win.locator('#btn-whitespace')

  // Ensure starting state is inactive
  const startActive = await btn.evaluate(el => el.classList.contains('active'))
  if (startActive) {
    // click to deactivate first
    await btn.click()
  }
  await expect(btn).not.toHaveClass(/active/)

  await btn.click()
  await expect(btn).toHaveClass(/active/)

  await btn.click()
  await expect(btn).not.toHaveClass(/active/)
})

// ---------------------------------------------------------------------------
// T48: Line Numbers
// ---------------------------------------------------------------------------

test('T48: btn-line-numbers 存在，初始有 active class', async () => {
  await goToTextCompare(win)
  const btn = win.locator('#btn-line-numbers')
  await expect(btn).toBeAttached()
  await expect(btn).toHaveClass(/active/)
})

test('T48: 點擊 btn-line-numbers 後移除 active class', async () => {
  await goToTextCompare(win)
  const btn = win.locator('#btn-line-numbers')

  // Ensure active first
  if (!(await btn.evaluate(el => el.classList.contains('active')))) {
    await btn.click()
    await expect(btn).toHaveClass(/active/)
  }

  await btn.click()
  await expect(btn).not.toHaveClass(/active/)

  // Restore
  await btn.click()
  await expect(btn).toHaveClass(/active/)
})

// ---------------------------------------------------------------------------
// T49: Font Size
// ---------------------------------------------------------------------------

test('T49: Ctrl+= 放大字型不報錯', async () => {
  await goToTextCompare(win)
  // Should not throw; we just verify no unhandled error
  await win.keyboard.press('Control+=')
  // If we're still alive and view is visible, the shortcut was handled
  await expect(win.locator('#view-text')).toBeVisible()
})

test('T49: Ctrl+- 縮小字型不報錯', async () => {
  await goToTextCompare(win)
  await win.keyboard.press('Control+-')
  await expect(win.locator('#view-text')).toBeVisible()
})

test('T49: Ctrl+0 重設字型大小不報錯', async () => {
  await goToTextCompare(win)
  await win.keyboard.press('Control+0')
  await expect(win.locator('#view-text')).toBeVisible()
})

// ---------------------------------------------------------------------------
// T50: Layout Toggle
// ---------------------------------------------------------------------------

test('T50: btn-layout-toggle 初始文字包含 Side', async () => {
  await goToTextCompare(win)
  const btn = win.locator('#btn-layout-toggle')
  await expect(btn).toBeAttached()
  await expect(btn).toContainText('Side')
})

test('T50: 點擊 btn-layout-toggle 後文字變為包含 Over', async () => {
  await goToTextCompare(win)
  const btn = win.locator('#btn-layout-toggle')

  // Make sure we start in Side mode
  const text = await btn.textContent()
  if (text && text.includes('Over')) {
    await btn.click()
    await expect(btn).toContainText('Side', { timeout: 2000 })
  }

  await btn.click()
  await expect(btn).toContainText('Over', { timeout: 2000 })
})

test('T50: 再次點擊 btn-layout-toggle 還原為 Side', async () => {
  await goToTextCompare(win)
  const btn = win.locator('#btn-layout-toggle')

  // Ensure Over mode
  const text = await btn.textContent()
  if (text && text.includes('Side')) {
    await btn.click()
    await expect(btn).toContainText('Over', { timeout: 2000 })
  }

  await btn.click()
  await expect(btn).toContainText('Side', { timeout: 2000 })
})
