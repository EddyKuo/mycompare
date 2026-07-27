/**
 * Difference navigation reaching every view.
 *
 * The per-view unit tests prove the stepping rules; what they cannot answer is
 * whether F7 / F8 / Alt+Home / Alt+End are actually wired to the view that is
 * on screen. Both hex and text used to bind these keys themselves *and* be
 * driven by the global binding, so every press moved two differences.
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

/** 8 bytes with three separated differing runs. */
const LEFT_BIN = Buffer.from([0, 1, 0, 2, 0, 3, 0, 0]).toString('base64')
const RIGHT_BIN = Buffer.from([0, 9, 0, 9, 0, 9, 0, 0]).toString('base64')

/** @param {import('@playwright/test').Page} page */
async function goToHex(page) {
  const home = page.locator('#session-home')
  if (!(await page.locator('#view-hex').isVisible())) {
    if (!(await home.isVisible())) {
      await page.locator('#btn-new-session').click()
      await expect(home).toBeVisible({ timeout: 5000 })
    }
    await page.locator('[data-type="hex"].session-type-btn').click()
  }
  await expect(page.locator('#view-hex')).toBeVisible({ timeout: 5000 })
}

/** @param {import('@playwright/test').Page} page */
async function loadHex(page) {
  await page.evaluate(([l, r]) => {
    window.__testAPI.hexSetLeft('a.bin', l)
    window.__testAPI.hexSetRight('b.bin', r)
  }, [LEFT_BIN, RIGHT_BIN])
}

const index = (page) => page.evaluate(() => window.__testAPI.navDiffIndex())
const status = (page) => page.evaluate(() => window.__testAPI.navStatusText())

test('F8 advances exactly one difference per press', async () => {
  await goToHex(win)
  await win.evaluate(() => {
    window.__testAPI.navSetPref('navWrapAround', false)
    window.__testAPI.navSetPref('navFirstDiffOnLoad', false)
  })
  await loadHex(win)
  expect(await index(win)).toBe(-1)

  await win.keyboard.press('F8')
  expect(await index(win)).toBe(0)
  await win.keyboard.press('F8')
  expect(await index(win)).toBe(1)
  await win.keyboard.press('F7')
  expect(await index(win)).toBe(0)
})

test('Alt+End / Alt+Home jump to the ends', async () => {
  await goToHex(win)
  await win.evaluate(() => window.__testAPI.navSetPref('navFirstDiffOnLoad', false))
  await loadHex(win)

  await win.keyboard.press('Alt+End')
  expect(await index(win)).toBe(2)
  await win.keyboard.press('Alt+Home')
  expect(await index(win)).toBe(0)
})

test('with wrap off, F8 at the last difference stops and says so', async () => {
  await goToHex(win)
  await win.evaluate(() => window.__testAPI.navSetPref('navWrapAround', false))
  await loadHex(win)

  await win.keyboard.press('Alt+End')
  expect(await index(win)).toBe(2)

  await win.keyboard.press('F8')
  expect(await index(win)).toBe(2)
  expect(await status(win)).toContain('已到最後一個差異')

  await win.keyboard.press('Alt+Home')
  await win.keyboard.press('F7')
  expect(await index(win)).toBe(0)
  expect(await status(win)).toContain('已到第一個差異')
})

test('with wrap on, F8 at the last difference returns to the first', async () => {
  await goToHex(win)
  await win.evaluate(() => window.__testAPI.navSetPref('navWrapAround', true))
  await loadHex(win)

  await win.keyboard.press('Alt+End')
  expect(await index(win)).toBe(2)
  await win.keyboard.press('F8')
  expect(await index(win)).toBe(0)

  await win.evaluate(() => window.__testAPI.navSetPref('navWrapAround', false))
})

test('go to first difference on load selects it without a keypress', async () => {
  await goToHex(win)
  await win.evaluate(() => window.__testAPI.navSetPref('navFirstDiffOnLoad', true))
  await loadHex(win)
  expect(await index(win)).toBe(0)
})

test('table navigation responds to the same keys', async () => {
  const home = win.locator('#session-home')
  await win.locator('#btn-new-session').click()
  await expect(home).toBeVisible({ timeout: 5000 })
  await win.locator('[data-type="table"].session-type-btn').click()
  await expect(win.locator('#view-table')).toBeVisible({ timeout: 5000 })

  await win.evaluate(() => {
    window.__testAPI.navSetPref('navWrapAround', false)
    window.__testAPI.navSetPref('navFirstDiffOnLoad', false)
    window.__testAPI.tableSetLeft('a.csv', 'id,v\n1,a\n2,b\n3,c\n')
    window.__testAPI.tableSetRight('b.csv', 'id,v\n1,X\n2,Y\n3,Z\n')
  })

  await win.keyboard.press('Alt+End')
  const last = await index(win)
  expect(last).toBeGreaterThan(0)

  await win.keyboard.press('F8')
  expect(await index(win)).toBe(last)
  expect(await status(win)).toContain('已到最後一個差異')
})
