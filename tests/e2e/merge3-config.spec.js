/**
 * Session settings for the three-way merge view.
 *
 * ThreeWayCompare implements getConfig/applyConfig, but the table that maps the
 * active view to a configurable one omitted merge3, so the dialog reported
 * "this view does not support settings" and nothing could be saved or loaded.
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

test.beforeAll(async () => { ({ app, win } = await launchApp()) })
test.afterAll(async () => { await closeApp(app) })

test.beforeEach(async () => {
  await win.evaluate(() => localStorage.removeItem('mycompare:namedConfigs'))
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.locator('[data-type="merge3"].session-type-btn').click()
  await expect(win.locator('#view-merge3')).toBeVisible({ timeout: 5000 })
})

test('a merge3 configuration can be saved and listed', async () => {
  await win.locator('#btn-config-modal').click()
  await expect(win.locator('#config-modal')).toBeVisible()

  await win.locator('#input-config-name').fill('我的合併設定')
  await win.locator('#btn-config-save').click()

  await expect(win.locator('#config-modal-status')).toContainText('已儲存設定')
  await expect(win.locator('#config-list')).toContainText('我的合併設定')
  await expect(win.locator('#config-list')).toContainText('merge3')

  const stored = await win.evaluate(() => {
    const raw = localStorage.getItem('mycompare:namedConfigs')
    return raw ? JSON.parse(raw) : null
  })
  expect(JSON.stringify(stored)).toContain('merge3')
})

test('a saved merge3 configuration can be loaded back', async () => {
  await win.locator('#btn-config-modal').click()
  await win.locator('#input-config-name').fill('設定 A')
  await win.locator('#btn-config-save').click()

  await win.locator('#config-list').getByText('載入').first().click()
  await expect(win.locator('#config-modal-status')).toContainText('已套用設定')
})
