/**
 * Opening a file in another application.
 *
 * Driven through the real handler, because the interesting parts are the two
 * things a unit test of the logic would not exercise: `shell.openPath` reports
 * failure by *resolving* with a message rather than rejecting, and the path
 * still has to clear the allow-list.
 *
 * Nothing here actually launches an application — a missing file and a
 * forbidden path both fail before that point, which is exactly what is under
 * test.
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
  dir = await mkdtemp(join(tmpdir(), 'mycompare-openwith-'))
  await writeFile(join(dir, 'present.txt'), 'hi', 'utf-8')
  ;({ app, win } = await launchApp([dir]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

test('the API is exposed to the renderer', async () => {
  expect(await win.evaluate(() => typeof window.electronAPI?.openWith)).toBe('function')
})

test('a file outside every opened root is refused', async () => {
  const outcome = await win.evaluate(async () => {
    try {
      await window.electronAPI.openWith('C:/Windows/System32/calc.exe')
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  expect(outcome).not.toBe('allowed')
  expect(outcome).toMatch(/Access denied|not within any opened root/)
})

test('a missing file fails before any application is launched', async () => {
  const outcome = await win.evaluate(async (p) => {
    try {
      await window.electronAPI.openWith(p)
      return 'opened'
    } catch (err) {
      return String(err?.message ?? err)
    }
  }, join(dir, 'not-here.txt'))

  expect(outcome).not.toBe('opened')
  expect(outcome).toMatch(/ENOENT|no such file/i)
})
