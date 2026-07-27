/**
 * S25: three-way merge pane layout, in the production bundle.
 *
 * The unit suite runs in jsdom, which performs no layout: there, a collapsed
 * pane still stores whatever scrollTop is written to it, and every box is
 * zero-sized. Neither of the two defects this project has actually shipped in
 * this area — a wrapped toolbar covering the canvas, a control pushed outside
 * the window — is visible without a real layout engine. So the geometry
 * assertions belong here.
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

const ROW_HEIGHT = 18
const LINES = 4000

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

/** @param {import('@playwright/test').Page} page */
async function loadFiles(page) {
  await page.evaluate((n) => {
    const make = (tag) => Array.from({ length: n }, (_, i) =>
      (i === 2000 ? `${tag}${i}` : `line${i}`)).join('\n')
    window.__testAPI.mergeSetAll(make('L'), make('line'), make('R'))
  }, LINES)
}

/** Put the layout back so the tests do not depend on each other's order. */
async function resetLayout() {
  await win.locator('#view-merge3 .mw-btn-reset-layout').click()
}

/**
 * Bounding boxes of the parts that must stay inside the view.
 *
 * @returns {Promise<{ view: DOMRect, toolbar: DOMRect, top: DOMRect, output: DOMRect }>}
 */
function boxes() {
  return win.evaluate(() => {
    const pick = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }
    }
    return {
      view: pick('#view-merge3'),
      toolbar: pick('#view-merge3 .mw-toolbar'),
      top: pick('#view-merge3 .mw-top'),
      output: pick('#view-merge3 .mw-output-pane'),
    }
  })
}

test('預設四窗格：工具列沒有把任何窗格擠出視圖', async () => {
  await goToMerge(win)
  await loadFiles(win)
  await resetLayout()

  const b = await boxes()
  // The defect this pins: a toolbar that wraps to more rows than the view can
  // spare pushes the panes past the bottom edge, where they cannot be used.
  expect(b.top.height).toBeGreaterThan(50)
  expect(b.output.height).toBeGreaterThan(50)
  expect(b.top.bottom).toBeLessThanOrEqual(b.view.bottom + 1)
  expect(b.output.bottom).toBeLessThanOrEqual(b.view.bottom + 1)
  expect(b.toolbar.height).toBeLessThan(b.view.height * 0.5)
})

test('隱藏基準窗格：左右兩側變寬，且沒有留下孤兒分隔線', async () => {
  await goToMerge(win)
  await loadFiles(win)
  await resetLayout()

  const widthOf = (side) => win.evaluate((s) =>
    document.querySelector(`#view-merge3 .mw-pane--${s}`).getBoundingClientRect().width, side)

  const leftBefore = await widthOf('left')

  await win.locator('#view-merge3 .mw-btn-toggle-base').click()

  await expect(win.locator('#view-merge3 .mw-pane--base')).toBeHidden()
  await expect(win.locator('#view-merge3 .mw-pane--left')).toBeVisible()
  await expect(win.locator('#view-merge3 .mw-pane--right')).toBeVisible()

  const leftAfter = await widthOf('left')
  expect(leftAfter).toBeGreaterThan(leftBefore)

  // Two panes need one divider, not two.
  const dividers = await win.evaluate(() =>
    [...document.querySelectorAll('#view-merge3 .mw-pane-divider')]
      .filter((el) => el.getBoundingClientRect().width > 0).length)
  expect(dividers).toBe(1)

  await resetLayout()
  await expect(win.locator('#view-merge3 .mw-pane--base')).toBeVisible()
})

test('放大輸出：輸出佔滿視圖，來源窗格收起，控制項仍在畫面內', async () => {
  await goToMerge(win)
  await loadFiles(win)
  await resetLayout()

  await win.locator('#view-merge3 .mw-btn-max-output').click()

  await expect(win.locator('#view-merge3 .mw-top')).toBeHidden()
  const b = await boxes()
  expect(b.output.height).toBeGreaterThan(b.view.height * 0.5)
  expect(b.output.bottom).toBeLessThanOrEqual(b.view.bottom + 1)

  // The way out has to remain clickable — that is the whole difference between
  // "maximised" and "the user is now stuck".
  const restore = win.locator('#view-merge3 .mw-btn-max-output')
  await expect(restore).toBeVisible()
  await expect(restore).toHaveText('還原輸出')
  await restore.click()
  await expect(win.locator('#view-merge3 .mw-top')).toBeVisible()
})

test('放大來源：三個來源佔滿，輸出只留可操作的標題列', async () => {
  await goToMerge(win)
  await loadFiles(win)
  await resetLayout()

  const before = (await boxes()).top.height
  await win.locator('#view-merge3 .mw-btn-max-sources').click()

  await expect(win.locator('#view-merge3 .mw-output-content')).toBeHidden()
  await expect(win.locator('#view-merge3 .mw-output-header')).toBeVisible()
  await expect(win.locator('#view-merge3 .mw-btn-save')).toBeVisible()

  const b = await boxes()
  expect(b.top.height).toBeGreaterThan(before)
  expect(b.output.height).toBeLessThan(60)
  expect(b.output.bottom).toBeLessThanOrEqual(b.view.bottom + 1)

  await resetLayout()
  await expect(win.locator('#view-merge3 .mw-output-content')).toBeVisible()
})

test('拖曳過的輸出高度在放大／還原之後回來', async () => {
  await goToMerge(win)
  await loadFiles(win)
  await resetLayout()

  await win.evaluate(() => {
    document.querySelector('#view-merge3 .mw-output-pane').style.height = '320px'
  })
  const dragged = (await boxes()).output.height
  expect(dragged).toBeGreaterThan(300)

  await win.locator('#view-merge3 .mw-btn-max-output').click()
  await win.locator('#view-merge3 .mw-btn-max-output').click()

  expect((await boxes()).output.height).toBeCloseTo(dragged, 0)
  await resetLayout()
})

test('收合再展開後，三個窗格的捲動位置一致且仍在原處', async () => {
  await goToMerge(win)
  await loadFiles(win)
  await resetLayout()

  const target = 1200 * ROW_HEIGHT
  await win.evaluate((top) => {
    const pane = document.querySelector('#view-merge3 .mw-content-left')
    pane.scrollTop = top
    pane.dispatchEvent(new Event('scroll'))
  }, target)

  const tops = () => win.evaluate(() => ['left', 'base', 'right'].map((s) =>
    document.querySelector(`#view-merge3 .mw-content-${s}`).scrollTop))

  expect(new Set(await tops()).size).toBe(1)

  // Hide the base, scroll on with only two panes, then bring it back. This is
  // exactly the case jsdom cannot reproduce: while it is display:none the base
  // pane is not scrollable and every write to it is dropped.
  await win.locator('#view-merge3 .mw-btn-toggle-base').click()
  await win.locator('#view-merge3 .mw-btn-toggle-base').click()

  const after = await tops()
  expect(new Set(after).size).toBe(1)
  expect(after[0]).toBe(target)

  const shown = await win.evaluate(() =>
    [...document.querySelectorAll('#view-merge3 .mw-content-left .mw-linetext')]
      .map((el) => el.textContent))
  expect(shown).toContain('line1200')
  expect(shown.length).toBeLessThan(200)
})

test('放大輸出再還原，捲動位置與渲染的列都回到原處', async () => {
  await goToMerge(win)
  await loadFiles(win)
  await resetLayout()

  const target = 900 * ROW_HEIGHT
  await win.evaluate((top) => {
    const pane = document.querySelector('#view-merge3 .mw-content-base')
    pane.scrollTop = top
    pane.dispatchEvent(new Event('scroll'))
  }, target)

  await win.locator('#view-merge3 .mw-btn-max-output').click()
  await win.locator('#view-merge3 .mw-btn-max-output').click()

  const tops = await win.evaluate(() => ['left', 'base', 'right'].map((s) =>
    document.querySelector(`#view-merge3 .mw-content-${s}`).scrollTop))
  expect(new Set(tops).size).toBe(1)
  expect(tops[0]).toBe(target)

  const shown = await win.evaluate(() =>
    [...document.querySelectorAll('#view-merge3 .mw-content-right .mw-linetext')]
      .map((el) => el.textContent))
  expect(shown).toContain('line900')
})

test('收起狀態下捲動仍然同步兩個可見窗格', async () => {
  await goToMerge(win)
  await loadFiles(win)
  await resetLayout()

  await win.locator('#view-merge3 .mw-btn-toggle-base').click()
  await win.evaluate(() => {
    const pane = document.querySelector('#view-merge3 .mw-content-left')
    pane.scrollTop = 600 * 18
    pane.dispatchEvent(new Event('scroll'))
  })

  const right = await win.evaluate(() =>
    document.querySelector('#view-merge3 .mw-content-right').scrollTop)
  expect(right).toBe(600 * ROW_HEIGHT)

  await resetLayout()
  const all = await win.evaluate(() => ['left', 'base', 'right'].map((s) =>
    document.querySelector(`#view-merge3 .mw-content-${s}`).scrollTop))
  expect(new Set(all).size).toBe(1)
  expect(all[0]).toBe(600 * ROW_HEIGHT)
})

test('行號可以隱藏，行文字不會跟著消失', async () => {
  await goToMerge(win)
  await loadFiles(win)
  await resetLayout()

  const gutterWidth = () => win.evaluate(() =>
    document.querySelector('#view-merge3 .mw-content-left .mw-linenum')
      ?.getBoundingClientRect().width ?? 0)

  expect(await gutterWidth()).toBeGreaterThan(0)
  await win.locator('#view-merge3 .mw-btn-toggle-linenum').click()
  expect(await gutterWidth()).toBe(0)

  const texts = await win.evaluate(() =>
    [...document.querySelectorAll('#view-merge3 .mw-content-left .mw-linetext')].length)
  expect(texts).toBeGreaterThan(0)

  await resetLayout()
  expect(await gutterWidth()).toBeGreaterThan(0)
})

test('每個版面控制在每一種版面下都留在視窗內，可以按得到', async () => {
  await goToMerge(win)
  await loadFiles(win)
  await resetLayout()

  const controls = [
    '.mw-btn-toggle-base', '.mw-btn-max-output', '.mw-btn-max-sources',
    '.mw-btn-toggle-linenum', '.mw-btn-reset-layout',
  ]

  // Every reachable layout, including the combinations: a control that only
  // survives the default one is not a way out of the others.
  for (const steps of [[], ['.mw-btn-toggle-base'], ['.mw-btn-max-output'],
    ['.mw-btn-max-sources'], ['.mw-btn-toggle-base', '.mw-btn-max-sources'],
    ['.mw-btn-toggle-base', '.mw-btn-max-output']]) {
    await resetLayout()
    for (const s of steps) await win.locator(`#view-merge3 ${s}`).click()

    const offscreen = await win.evaluate((sels) => {
      const w = window.innerWidth
      const h = window.innerHeight
      return sels.filter((sel) => {
        const r = document.querySelector(`#view-merge3 ${sel}`).getBoundingClientRect()
        return r.width === 0 || r.height === 0 ||
          r.bottom > h || r.right > w || r.top < 0 || r.left < 0
      })
    }, controls)

    expect(offscreen, `layout ${JSON.stringify(steps)}`).toEqual([])
  }

  await resetLayout()
})
