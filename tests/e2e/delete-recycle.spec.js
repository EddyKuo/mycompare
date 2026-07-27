/**
 * Deleting through the real IPC handler.
 *
 * The unit test can only re-state the decision procedure; this one runs it. It
 * matters because the interesting behaviour is a refusal — a platform with no
 * recycle bin must not quietly unlink instead — and a refusal is easy to write
 * and easy to get wrong in the wiring rather than the logic.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, rm, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let dir

const exists = async (p) => {
  try { await access(p); return true } catch { return false }
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-del-'))
  ;({ app, win } = await launchApp([dir]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

test('a plain delete goes to the recycle bin and says so', async () => {
  const p = join(dir, 'recyclable.txt')
  await writeFile(p, 'bin me', 'utf-8')

  const result = await win.evaluate((f) => window.electronAPI.deleteFile(f), p)

  expect(result).toMatchObject({ deleted: true, permanent: false })
  expect(await exists(p)).toBe(false)
})

test('a permanent delete is reported as permanent', async () => {
  const p = join(dir, 'gone.txt')
  await writeFile(p, 'gone', 'utf-8')

  const result = await win.evaluate(
    (f) => window.electronAPI.deleteFile(f, { permanent: true }), p)

  expect(result).toMatchObject({ deleted: true, permanent: true })
  expect(await exists(p)).toBe(false)
})

test('a path outside every opened root is still refused', async () => {
  // The recycle-bin route must not become a way around the allow-list.
  const outcome = await win.evaluate(async () => {
    try {
      await window.electronAPI.deleteFile('C:/Windows/System32/drivers/etc/hosts')
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  expect(outcome).not.toBe('allowed')
  expect(outcome).toMatch(/Access denied|not within any opened root/)
})
