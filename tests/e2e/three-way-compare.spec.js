/**
 * S15-U01 / S16: 3-Way Compare e2e.
 *
 * Covers what the unit suite structurally cannot: that the view behaves the
 * same inside the real production bundle — the merge alignment (S13-C01), the
 * virtualised panes, and the absence of any element id the view could collide
 * on with a second instance.
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

/** Big enough that rendering every row would be the bug under test. */
const BIG_LINES = 8000

test.beforeAll(async () => { ({ app, win } = await launchApp()) })
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

/**
 * Load three generated files whose only difference is one line, far down.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} n
 * @param {number} conflictAt
 */
async function loadBig(page, n, conflictAt) {
  await page.evaluate(({ n, conflictAt }) => {
    const make = (tag) => Array.from({ length: n }, (_, i) =>
      (i === conflictAt ? `${tag}${i}` : `line${i}`)).join('\n')
    window.__testAPI.mergeSetAll(make('L'), make('line'), make('R'))
  }, { n, conflictAt })
}

test('3-way 比對視圖掛載', async () => {
  await goToMerge(win)
  await expect(win.locator('#view-merge3')).toBeVisible()
})

test('S13-C01 regression: 單行插入不再讓後續行誤判為衝突', async () => {
  await goToMerge(win)
  await win.evaluate(() => {
    window.__testAPI.mergeSetAll('a\nX\nb\nc\n', 'a\nb\nc\n', 'a\nb\nc\n')
  })
  const count = await win.evaluate(() => window.__testAPI.mergeGetConflictCount())
  expect(count).toBe(0)
})

test('合併視圖不使用任何 element id', async () => {
  await goToMerge(win)

  // A second merge tab would duplicate every id in this subtree; none exist,
  // so nothing can be duplicated.
  const ids = await win.evaluate(() =>
    [...document.querySelectorAll('#view-merge3 [id]')].map((el) => el.id))
  expect(ids).toEqual([])

  const resolvable = await win.evaluate(() =>
    ['mw-output', 'mw-content-left', 'mw-conflict-counter', 'mw-btn-filter']
      .filter((id) => document.getElementById(id) !== null))
  expect(resolvable).toEqual([])
})

test('虛擬捲動：8000 行只渲染可見的那幾列', async () => {
  await goToMerge(win)
  await loadBig(win, BIG_LINES, 5000)

  const counts = await win.evaluate(() =>
    ['left', 'base', 'right'].map((side) =>
      document.querySelectorAll(`#view-merge3 .mw-content-${side} .mw-line`).length))

  for (const c of counts) {
    expect(c).toBeGreaterThan(0)
    expect(c).toBeLessThan(200)
  }

  // The spacer still claims the full document height, so the scrollbar is honest.
  const spacerHeight = await win.evaluate(() =>
    document.querySelector('#view-merge3 .mw-content-left .mw-vspacer')?.clientHeight ?? 0)
  expect(spacerHeight).toBeGreaterThan(BIG_LINES * 10)
})

test('捲動後換一批列，數量仍受限', async () => {
  await goToMerge(win)
  await loadBig(win, BIG_LINES, 5000)

  const texts = () => win.evaluate(() =>
    [...document.querySelectorAll('#view-merge3 .mw-content-left .mw-linetext')]
      .map((el) => el.textContent))

  const before = await texts()
  await win.evaluate(() => {
    const pane = document.querySelector('#view-merge3 .mw-content-left')
    pane.scrollTop = 3000 * 18
    pane.dispatchEvent(new Event('scroll'))
  })
  const after = await texts()

  expect(after).not.toEqual(before)
  expect(after.length).toBeLessThan(200)
  expect(after.some((t) => t === 'line3000')).toBe(true)

  // The other two panes followed.
  const tops = await win.evaluate(() =>
    ['left', 'base', 'right'].map((side) =>
      document.querySelector(`#view-merge3 .mw-content-${side}`).scrollTop))
  expect(new Set(tops).size).toBe(1)
})

test('衝突導航把遠處的衝突捲進可見範圍', async () => {
  await goToMerge(win)
  await loadBig(win, BIG_LINES, 5000)
  expect(await win.evaluate(() => window.__testAPI.mergeGetConflictCount())).toBe(1)

  const visible = () => win.evaluate(() =>
    [...document.querySelectorAll('#view-merge3 .mw-content-left .mw-linetext')]
      .some((el) => el.textContent === 'L5000'))

  // "When loading new files, go to first difference" is on by default (as in
  // Beyond Compare), so the only conflict is already scrolled into the window.
  expect(await visible()).toBe(true)

  // Scroll it back out, then prove navigation brings it back.
  await win.evaluate(() => {
    for (const side of ['left', 'base', 'right']) {
      document.querySelector(`#view-merge3 .mw-content-${side}`).scrollTop = 0
      document.querySelector(`#view-merge3 .mw-content-${side}`)
        .dispatchEvent(new Event('scroll'))
    }
  })
  expect(await visible()).toBe(false)

  await win.locator('#view-merge3 .mw-btn-next').click()
  expect(await visible()).toBe(true)
})

test('批次解決把輸出寫滿，且不留衝突標記', async () => {
  await goToMerge(win)
  await loadBig(win, 500, 200)

  await win.locator('#view-merge3 .mw-btn-all-left').click()
  const output = await win.evaluate(() =>
    document.querySelector('#view-merge3 .mw-output-textarea').value)

  expect(output).toContain('L200')
  expect(output).not.toContain('<<<<<<<')
  expect(output.split('\n').length).toBe(500)
})
