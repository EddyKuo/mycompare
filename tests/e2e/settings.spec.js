/**
 * Settings e2e.
 *
 * The shortcuts modal, SettingsStore and the default binding table all
 * shipped, but nothing rendered the list or read a binding back, so the
 * feature was inert. These tests drive it through the real UI.
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

test.beforeEach(async () => {
  await win.evaluate(() => localStorage.removeItem('mycompare:settings'))
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
})

test('the shortcuts modal lists bindings instead of being empty', async () => {
  await win.locator('#btn-settings-modal').click()
  await expect(win.locator('#settings-modal')).toBeVisible()

  const rows = win.locator('#settings-shortcuts-list .settings-row')
  await expect(rows.first()).toBeVisible()
  expect(await rows.count()).toBeGreaterThan(10)

  // Defaults should be shown, not "not set".
  await expect(win.locator('#settings-shortcuts-list').getByText('F8').first()).toBeVisible()
})

test('clearing a binding persists', async () => {
  await win.locator('#btn-settings-modal').click()
  const row = win.locator('#settings-shortcuts-list .settings-row').first()
  await row.getByText('清除').click()

  const stored = await win.evaluate(() => {
    const raw = localStorage.getItem('mycompare:settings')
    return raw ? JSON.parse(raw) : null
  })
  expect(stored).not.toBeNull()
  expect(Object.values(stored.shortcuts)).toContain('')
})

test('reset restores the defaults', async () => {
  await win.locator('#btn-settings-modal').click()
  await win.locator('#settings-shortcuts-list .settings-row').first().getByText('清除').click()
  await win.locator('#btn-settings-reset').click()

  const nextDiff = await win.evaluate(() => {
    const raw = localStorage.getItem('mycompare:settings')
    return raw ? JSON.parse(raw).shortcuts.nextDiff : null
  })
  expect(nextDiff).toBe('F8')
})

test('a rebound key drives the action', async () => {
  // Rebind "close tab" to F4, then confirm F4 closes a tab.
  await win.evaluate(() => {
    const raw = localStorage.getItem('mycompare:settings')
    const parsed = raw ? JSON.parse(raw) : { shortcuts: {} }
    parsed.shortcuts = { ...(parsed.shortcuts ?? {}), closeTab: 'F4' }
    localStorage.setItem('mycompare:settings', JSON.stringify(parsed))
  })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')

  await win.evaluate(() => {
    document.querySelector('.session-type-btn[data-type="text"]')?.click()
  })
  await expect(win.locator('.tab-item')).toHaveCount(1)

  await win.locator('body').press('F4')
  await expect(win.locator('.tab-item')).toHaveCount(0)
})

test('every shortcut action shown in the modal has a default binding', async () => {
  await win.locator('#btn-settings-modal').click()

  const rows = await win.evaluate(() =>
    [...document.querySelectorAll('#settings-shortcuts-list .settings-row')]
      .map((r) => ({
        name: r.querySelector('.settings-row-name')?.textContent ?? '',
        combo: r.querySelector('.settings-row-combo')?.textContent ?? '',
      })))

  expect(rows.length).toBeGreaterThan(10)

  // An action with no default is unreachable from the keyboard, which is how
  // Ctrl+P was briefly lost when the handler moved to the binding table.
  // Copy-all is deliberately unbound — it is reachable from the toolbar and
  // menu, and BC ships no default for it either. Listing the exceptions
  // explicitly means a newly added action that forgets a default still fails.
  const INTENTIONALLY_UNBOUND = ['複製全部差異到左側', '複製全部差異到右側']
  const unbound = rows
    .filter((r) => r.combo === '（未設定）')
    .map((r) => r.name)
  expect(unbound.sort()).toEqual([...INTENTIONALLY_UNBOUND].sort())
})

test('Ctrl+P still reaches the print action', async () => {
  const bound = await win.evaluate(() => {
    const raw = localStorage.getItem('mycompare:settings')
    const s = raw ? JSON.parse(raw) : null
    return s?.shortcuts?.print ?? null
  })
  // Defaults are only materialised once something is written; read through the
  // rendered modal instead, which merges defaults in.
  await win.locator('#btn-settings-modal').click()
  const shown = await win.evaluate(() =>
    [...document.querySelectorAll('#settings-shortcuts-list .settings-row')]
      .some((r) => r.querySelector('.settings-row-combo')?.textContent === 'Ctrl+P'))
  expect(bound === null || bound === 'Ctrl+P').toBe(true)
  expect(shown).toBe(true)
})
