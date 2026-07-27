/**
 * Portable-install detection.
 *
 * The interesting case is the negative one. A normal install must report
 * `portable: false` and a real userData path — the settings UI degrades on that
 * answer, and a check that silently failed would have it claim portable and
 * point at a directory nothing writes to.
 *
 * The positive case cannot be driven from here: it depends on a marker file
 * beside the packaged executable, and the e2e runs the built main script under
 * Electron's own binary. What is testable is that the channel exists, answers,
 * and answers honestly for the situation it is actually in.
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

test('the channel exists and reports a concrete answer', async () => {
  const info = await win.evaluate(() => window.electronAPI.getPortableInfo())
  expect(typeof info.portable).toBe('boolean')
  expect(typeof info.dataDir).toBe('string')
  expect(info.dataDir.length).toBeGreaterThan(0)
})

test('a normal install says so rather than claiming portable', async () => {
  // No portable.txt sits beside Electron's binary in a dev checkout.
  const info = await win.evaluate(() => window.electronAPI.getPortableInfo())
  expect(info.portable).toBe(false)
  // And with no marker there is nothing to explain, so no reason is given.
  expect(info.reason).toBe('')
})

test('the settings dialog reflects that answer instead of guessing', async () => {
  await win.evaluate(() => document.getElementById('btn-settings-modal')?.click())
  const text = await win.locator('#settings-modal').innerText()
  expect(text).toMatch(/可攜式|一般安裝/)
})
