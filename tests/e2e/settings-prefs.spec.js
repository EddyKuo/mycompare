/**
 * The settings dialog beyond shortcuts.
 *
 * The Next-Difference preferences and the backup options were read by every
 * view and by every save, but no control wrote them — so the stored values
 * could never leave their defaults. These tests drive the real controls and
 * check what lands in localStorage, which is what those readers consult.
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
  await win.locator('#btn-settings-modal').click()
  await expect(win.locator('#settings-modal')).toBeVisible()
})

/** @returns {Promise<any>} the stored prefs object, or null */
function storedPrefs() {
  return win.evaluate(() => {
    const raw = localStorage.getItem('mycompare:settings')
    return raw ? JSON.parse(raw).prefs : null
  })
}

test('the four Next Difference options are shown with their defaults', async () => {
  await expect(win.locator('#chk-nav-wrap')).not.toBeChecked()
  await expect(win.locator('#chk-nav-first-on-load')).toBeChecked()
  await expect(win.locator('#chk-nav-next-after-copy')).toBeChecked()
  await expect(win.locator('#chk-nav-no-diff-message')).toBeChecked()
})

test('toggling wrap-around persists and survives a reload', async () => {
  await win.locator('#chk-nav-wrap').check()
  expect((await storedPrefs()).navWrapAround).toBe(true)

  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.locator('#btn-settings-modal').click()
  await expect(win.locator('#chk-nav-wrap')).toBeChecked()
})

test('turning off the no-difference message is written through', async () => {
  await win.locator('#chk-nav-no-diff-message').uncheck()
  expect((await storedPrefs()).navShowNoDiffMessage).toBe(false)
})

test('backup naming offers the four schemes the main process implements', async () => {
  const values = await win.locator('#sel-backup-naming option')
    .evaluateAll((opts) => opts.map((o) => o.value))
  expect(values).toEqual(['suffix', 'replace', 'tilde', 'numbered'])
})

test('choosing a naming scheme persists', async () => {
  await win.locator('#sel-backup-naming').selectOption('numbered')
  expect((await storedPrefs()).backupNaming).toBe('numbered')
})

test('disabling backups greys out the naming choice', async () => {
  await win.locator('#chk-backup-enabled').uncheck()
  expect((await storedPrefs()).backupOnSave).toBe(false)
  await expect(win.locator('#sel-backup-naming')).toBeDisabled()
})

test('the backup folder starts alongside the original and can be cleared', async () => {
  await expect(win.locator('#txt-backup-folder')).toContainText('與原檔同一資料夾')

  // A folder can only be set through the OS dialog, which cannot be driven
  // here; the store is written directly to prove the display reads it back.
  await win.evaluate(() => {
    const raw = localStorage.getItem('mycompare:settings')
    const parsed = raw ? JSON.parse(raw) : { shortcuts: {}, prefs: {} }
    parsed.prefs = { ...(parsed.prefs ?? {}), backupFolder: 'C:\\backups' }
    localStorage.setItem('mycompare:settings', JSON.stringify(parsed))
  })
  await win.locator('#btn-settings-modal-cancel').click()
  await win.locator('#btn-settings-modal').click()
  await expect(win.locator('#txt-backup-folder')).toHaveText('C:\\backups')

  await win.locator('#btn-backup-folder-clear').click()
  await expect(win.locator('#txt-backup-folder')).toContainText('與原檔同一資料夾')
  expect((await storedPrefs()).backupFolder).toBe('')
})

test('a key bound twice is flagged on both rows, naming the other action', async () => {
  await win.locator('#btn-settings-modal-cancel').click()
  await win.evaluate(() => {
    const raw = localStorage.getItem('mycompare:settings')
    const parsed = raw ? JSON.parse(raw) : { shortcuts: {} }
    parsed.shortcuts = { ...(parsed.shortcuts ?? {}), nextDiff: 'F8', refresh: 'F8' }
    localStorage.setItem('mycompare:settings', JSON.stringify(parsed))
  })
  await win.locator('#btn-settings-modal').click()

  const warnings = win.locator('#settings-shortcuts-list .settings-row-conflict')
  await expect(warnings).toHaveCount(2)
  await expect(warnings.first()).toContainText('F8')
  // The warning has to say who took the key, not merely that something did.
  await expect(warnings.first()).toContainText('重新整理')
})

test('no conflict warning appears for the shipped defaults', async () => {
  await expect(win.locator('#settings-shortcuts-list .settings-row-conflict')).toHaveCount(0)
})
