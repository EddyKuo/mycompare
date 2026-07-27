/**
 * A second window, and moving a tab into it.
 *
 * BC lets a session live in its own window and lets a tab be pulled out into
 * one. This app had exactly one window and no way to make another.
 *
 * Worth driving end to end rather than unit-testing the pieces: the window is
 * created in main, the session descriptor crosses IPC, and the receiving
 * renderer has to subscribe before main sends — a hand-off that fails silently
 * if the timing is wrong, since a message to a page that has not yet
 * subscribed is simply dropped.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let dir

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-multiwin-'))
  await writeFile(join(dir, 'left.txt'), 'alpha\nbravo\n', 'utf-8')
  await writeFile(join(dir, 'right.txt'), 'alpha\ncharlie\n', 'utf-8')
  ;({ app, win } = await launchApp([dir]))
  await win.waitForFunction(() => !!window.__testAPI)
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

/** Close every extra window so one test cannot strand another. */
async function closeExtras() {
  for (const w of app.windows()) {
    if (w !== win) await w.close().catch(() => {})
  }
  await expect.poll(() => app.windows().length, { timeout: 5000 }).toBe(1)
}

test('the bridge exposes window creation', async () => {
  expect(await win.evaluate(() => typeof window.electronAPI.openNewWindow)).toBe('function')
  expect(await win.evaluate(() => typeof window.electronAPI.onAdoptSession)).toBe('function')
})

test('opens a second window with its own renderer', async () => {
  const before = app.windows().length
  await win.evaluate(() => window.electronAPI.openNewWindow(null))
  await expect.poll(() => app.windows().length, { timeout: 10000 }).toBe(before + 1)

  const second = app.windows().find((w) => w !== win)
  await second.waitForLoadState('domcontentloaded')
  // A real renderer, not a blank shell: the preload bridge is present, which
  // is what a window created by window.open would lack.
  expect(await second.evaluate(() => typeof window.electronAPI)).toBe('object')

  await closeExtras()
})

test('a moved tab arrives with its files loaded', async () => {
  await win.evaluate(([l, r]) => window.__testAPI.openComparison({
    type: 'text', leftPath: l, rightPath: r,
  }), [join(dir, 'left.txt'), join(dir, 'right.txt')])

  const tabsBefore = await win.evaluate(() => window.__testAPI.tabs().length)
  expect(tabsBefore).toBeGreaterThan(0)

  // Right-click the active tab and take the command, as a user would.
  await win.locator('.tab-item--active').click({ button: 'right' })
  const item = win.locator('.ctx-item', { hasText: '移到新視窗' })
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  await expect.poll(() => app.windows().length, { timeout: 10000 }).toBe(2)
  const second = app.windows().find((w) => w !== win)
  await second.waitForLoadState('domcontentloaded')

  // The session really came across: the text view is showing the file, not an
  // empty pane. This is the half that a descriptor-shaped-but-never-applied
  // hand-off would fail.
  await second.waitForFunction(() => {
    const c = window.__testAPI?.textGetContents?.()
    return !!c && c.left.includes('alpha')
  }, { timeout: 10000 })

  // And the originating window gave the tab up, rather than duplicating it.
  await expect.poll(
    () => win.evaluate(() => window.__testAPI.tabs().length), { timeout: 5000 })
    .toBe(tabsBefore - 1)

  await closeExtras()
})

test('the tab menu offers closing even when windows are unavailable', async () => {
  // The move commands are hidden when the build cannot open windows, but the
  // menu must not become empty — a right-click that shows nothing reads as a
  // broken menu rather than an unavailable feature.
  await win.evaluate(([l, r]) => window.__testAPI.openComparison({
    type: 'text', leftPath: l, rightPath: r,
  }), [join(dir, 'left.txt'), join(dir, 'right.txt')])

  await win.locator('.tab-item--active').click({ button: 'right' })
  await expect(win.locator('.ctx-item', { hasText: '關閉分頁' })).toBeVisible()
  await win.keyboard.press('Escape')
})
