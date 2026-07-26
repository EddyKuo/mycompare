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
