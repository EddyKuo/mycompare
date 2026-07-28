/**
 * The folder-compare toolbar fits the window.
 *
 * This is the one thing unit tests cannot answer: jsdom has no layout, so the
 * measurement that decides what fits is a no-op there. The toolbar used to be
 * `overflow-x: auto` with 37 controls wanting 2318px in a ~1380px window, which
 * did two things — it put two fifths of the controls behind a scrollbar, and it
 * made `overflow-y` `auto` as well, so the dropdown menus anchored to those
 * buttons were clipped to the 36px strip. The batch menu measured at x=2236 in
 * a 1384px window with nothing hit-testable at that point: the feature was
 * unreachable, not merely awkward.
 *
 * So the assertions here are about position, not about class names: nothing
 * past the right edge, and every dropdown openable and actually on screen.
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

test.beforeAll(async () => {
  ;({ app, win } = await launchApp())
  await win.waitForFunction(() => !!window.__testAPI)
  await win.evaluate(() => window.__testAPI.menuCommand('session.new.folder'))
  await win.waitForSelector('.fc-toolbar')
})

test.afterAll(async () => {
  await win.setViewportSize({ width: 1400, height: 900 })
  await closeApp(app)
})

/** Measure the toolbar as it currently stands. */
function measure() {
  return win.evaluate(() => {
    const bar = document.querySelector('.fc-toolbar')
    const wrap = document.querySelector('.fc-overflow-wrap')
    const menu = document.querySelector('.fc-overflow-menu')
    const right = bar.getBoundingClientRect().right
    const visible = [...bar.children].filter((c) => c.getBoundingClientRect().width > 0)
    return {
      width: bar.clientWidth,
      right,
      inBar: visible.length,
      inMenu: menu.children.length,
      // A one-pixel tolerance: sub-pixel layout, not a control hanging off.
      past: visible.filter((c) => c.getBoundingClientRect().right > right + 1)
        .map((c) => c.className),
      overflowShown: wrap.style.display !== 'none',
    }
  })
}

/**
 * Resize and wait for the relayout, without waiting for what is being asserted.
 *
 * Waiting for "nothing sticks out" would make the assertions vacuous — the poll
 * would establish the very thing the test then checks. Resize observers deliver
 * before paint, so two frames is enough and is about the mechanism rather than
 * about the outcome.
 *
 * @param {number} width
 */
async function resize(width) {
  await win.setViewportSize({ width, height: 800 })
  await expect.poll(async () => (await measure()).width).toBe(width)
  await win.evaluate(() => new Promise((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done(null)))
  }))
}

for (const width of [800, 1000, 1400, 1920]) {
  test(`${width}px：沒有任何控制項超出工具列右緣`, async () => {
    await resize(width)
    const m = await measure()
    expect(m.past).toEqual([])
    // Something has to be reachable regardless of how narrow it gets.
    expect(m.inBar).toBeGreaterThan(3)
  })
}

test('視窗變窄時收進選單，變寬時放回工具列', async () => {
  // The bug this guards against is one-way collapse: measuring the already
  // collapsed toolbar instead of the real one leaves it stuck narrow forever.
  await resize(1920)
  const wide = await measure()
  await resize(900)
  const narrow = await measure()
  await resize(1920)
  const again = await measure()

  expect(narrow.inMenu).toBeGreaterThan(wide.inMenu)
  expect(narrow.inBar).toBeLessThan(wide.inBar)
  expect(again.inMenu).toBe(wide.inMenu)
  expect(again.inBar).toBe(wide.inBar)
})

test('收進選單的項目仍然可用，不是只是被藏起來', async () => {
  await resize(1000)
  await win.locator('.fc-btn-overflow').click()
  const menu = win.locator('.fc-overflow-menu')
  await expect(menu).toBeVisible()

  // 記錄 is first in the overflow order, so it is in the menu at any width
  // narrow enough for the menu to exist at all.
  const btnLog = menu.locator('.fc-btn-log')
  await expect(btnLog).toBeVisible()
  await btnLog.click()
  await expect(win.locator('.fc-log')).toBeVisible({ timeout: 2000 })
  await btnLog.click()
  await expect(win.locator('.fc-log')).toBeHidden()
})

test('選單內的核取方塊不會因為勾選就把選單關掉', async () => {
  // The click that toggles a checkbox is also an outside click as far as the
  // document handler is concerned; without stopping it the menu would shut on
  // every single toggle and be unusable for the switches it mostly holds.
  await resize(1000)
  const menu = win.locator('.fc-overflow-menu')
  if (!(await menu.isVisible())) await win.locator('.fc-btn-overflow').click()
  const cb = menu.locator('#fc-flat-mode')
  await expect(cb).toBeVisible()
  await cb.click()
  await expect(menu).toBeVisible()
  await cb.click()
  await expect(menu).toBeVisible()
  await win.locator('.fc-list').click({ position: { x: 5, y: 5 } })
  await expect(menu).toBeHidden()
})

test('每個工具列下拉都開得出來而且整個在畫面內', async () => {
  await resize(1400)
  const cases = [
    ['.fc-btn-batch', '.fc-batch-menu', '.fc-batch-item'],
    ['.fc-btn-select', '.fc-select-menu', '.fc-select-item'],
    ['.fc-btn-compare-menu', '.fc-compare-menu', '.fc-compare-item'],
    ['.fc-btn-overflow', '.fc-overflow-menu', '.fc-btn-log'],
  ]
  for (const [button, menu, item] of cases) {
    const out = await win.evaluate(([b, m, i]) => {
      const btn = document.querySelector(b)
      btn.disabled = false
      btn.click()
      const rect = document.querySelector(m).getBoundingClientRect()
      // elementFromPoint is the honest test: a menu can be laid out and still
      // be covered or clipped, in which case no click ever reaches it.
      const hit = document.elementFromPoint(rect.left + 8, rect.top + 8)
      btn.click()
      return {
        onScreen: rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1,
        hits: !!hit?.closest(i) || !!hit?.matches?.(i),
      }
    }, [button, menu, item])
    expect(out, button).toEqual({ onScreen: true, hits: true })
  }
})
