/**
 * The unified Options dialog (P2-24 / P2-34 / P2-38) and the print preview
 * (P2-28), driven through the real UI.
 *
 * Unit tests can prove the store round-trips; only this can prove the pages
 * exist, that a colour picked in the dialog reaches the document, and that
 * the print command shows the report before the print dialog opens.
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

/** Every page the dialog must offer. */
const PANES = ['general', 'display', 'nav', 'backup', 'shortcuts', 'appearance']

test.beforeAll(async () => {
  ;({ app, win } = await launchApp())
})

test.afterAll(async () => {
  await closeApp(app)
})

test.beforeEach(async () => {
  await win.evaluate(() => {
    localStorage.removeItem('mycompare:settings')
    localStorage.removeItem('mycompare:theme')
  })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
})

/**
 * @param {string} pane
 */
async function openOptions(pane) {
  const modal = win.locator('#settings-modal')
  if (!(await modal.isVisible())) await win.locator('#btn-settings-modal').click()
  await expect(modal).toBeVisible()
  await win.locator(`#options-tab-${pane}`).click()
  await expect(win.locator(`#options-pane-${pane}`)).toBeVisible()
}

test('offers every page, one visible at a time', async () => {
  await win.locator('#btn-settings-modal').click()
  await expect(win.locator('#settings-modal')).toBeVisible()

  for (const pane of PANES) {
    await win.locator(`#options-tab-${pane}`).click()
    await expect(win.locator(`#options-pane-${pane}`)).toBeVisible()
    const visible = await win.locator('.options-pane:not([hidden])').count()
    expect(visible).toBe(1)
  }
})

test('the settings that used to live in four modals are all still reachable', async () => {
  // The integration must not have dropped a control on the way in.
  const ids = [
    ['nav', '#chk-nav-wrap'], ['nav', '#chk-nav-first-on-load'],
    ['nav', '#chk-nav-next-after-copy'], ['nav', '#chk-nav-no-diff-message'],
    ['backup', '#chk-backup-enabled'], ['backup', '#sel-backup-naming'],
    ['backup', '#txt-backup-folder'], ['backup', '#btn-backup-folder'],
    ['backup', '#btn-backup-folder-clear'],
    ['shortcuts', '#settings-shortcuts-list'],
  ]
  for (const [pane, sel] of ids) {
    await openOptions(pane)
    await expect(win.locator(sel)).toBeVisible()
  }
})

test('a picked colour reaches the document and reset gives it back', async () => {
  await openOptions('appearance')

  const swatches = win.locator('#options-colors input[type="color"]')
  expect(await swatches.count()).toBeGreaterThan(5)

  await win.locator('#color-importantBg').fill('#123456')
  await win.locator('#color-importantBg').dispatchEvent('input')

  const applied = await win.evaluate(() =>
    document.documentElement.style.getPropertyValue('--diff-replace-bg'))
  expect(applied).toBe('#123456')

  await win.locator('#btn-settings-reset').click()
  const afterReset = await win.evaluate(() =>
    document.documentElement.style.getPropertyValue('--diff-replace-bg'))
  expect(afterReset).toBe('')
})

test('a colour override survives a reload', async () => {
  await openOptions('appearance')
  await win.locator('#color-charInsert').fill('#0a0b0c')
  await win.locator('#color-charInsert').dispatchEvent('input')

  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  const applied = await win.evaluate(() =>
    document.documentElement.style.getPropertyValue('--diff-char-insert'))
  expect(applied).toBe('#0a0b0c')
})

test('a rejected font is refused rather than written into the page', async () => {
  await openOptions('appearance')
  await win.locator('#inp-font-mono').fill('x; background-image: url(http://evil/)')
  await win.locator('#inp-font-mono').dispatchEvent('change')

  await expect(win.locator('#settings-modal-status')).toContainText('無效')
  const applied = await win.evaluate(() =>
    document.documentElement.style.getPropertyValue('--mono-font-family'))
  expect(applied).toBe('')
})

test('the Display page can hide and restore the toolbar', async () => {
  await openOptions('display')
  await win.locator('#chk-show-toolbar').uncheck()
  await expect(win.locator('#toolbar')).toBeHidden()

  await win.locator('#chk-show-toolbar').check()
  await expect(win.locator('#toolbar')).toBeVisible()
})

test('the theme selector drives the document theme', async () => {
  await openOptions('general')
  await win.locator('#sel-theme-mode').selectOption('dark')
  expect(await win.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  expect(await win.evaluate(() => localStorage.getItem('mycompare:theme'))).toBe('dark')

  await win.locator('#sel-theme-mode').selectOption('system')
  expect(await win.evaluate(() => localStorage.getItem('mycompare:theme'))).toBeNull()
})

test('print shows a preview of the report before the print dialog', async () => {
  await win.evaluate(() => window.__testAPI.openComparison({
    type: 'text', leftContent: 'a\nb\nc\n', rightContent: 'a\nB\nc\n',
  }))
  await win.locator('#btn-print-report').click()

  const modal = win.locator('#print-preview-modal')
  await expect(modal).toBeVisible()
  await expect(win.locator('#print-preview-view')).toContainText('文字比對')

  // The preview must show the report itself, not an empty frame.
  const frame = win.frameLocator('#print-preview-frame')
  await expect(frame.locator('body')).toContainText('比對報告')

  await win.locator('#btn-print-preview-cancel').click()
  await expect(modal).toBeHidden()
})

test('print on a view with no report says so instead of doing nothing', async () => {
  await win.locator('#btn-print-report').click()
  await expect(win.locator('#print-preview-modal')).toBeHidden()
  await expect(win.locator('#status-message')).toContainText('不支援列印')
})

test('the settings transfer entry points are on the General page', async () => {
  // The bundle's contents are covered by unit tests; what only this can show
  // is that the buttons exist and that the dialog behind them is native (so
  // the round trip itself is not drivable here).
  await openOptions('general')
  await expect(win.locator('#btn-settings-export')).toBeVisible()
  await expect(win.locator('#btn-settings-import')).toBeVisible()
  await expect(win.locator('#options-pane-general')).toContainText('遠端連線設定檔不在其中')
})
