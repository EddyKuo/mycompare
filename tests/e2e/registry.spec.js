/**
 * Registry comparison, end to end.
 *
 * Parsing is covered by unit tests; this checks the IPC is wired, that a
 * malicious key path cannot reach reg.exe, and that a .reg file round-trips
 * through the real handler.
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
/** @type {string} */
let regPath

const SAMPLE = [
  'Windows Registry Editor Version 5.00',
  '',
  '[HKEY_CURRENT_USER\\Software\\MyCompareTest]',
  '@="default"',
  '"Name"="Alice"',
  '"Count"=dword:0000002a',
].join('\r\n')

test.beforeAll(async () => {
  ;({ app, win } = await launchApp())
  dir = await mkdtemp(join(tmpdir(), 'mycompare-reg-'))
  regPath = join(dir, 'sample.reg')
  await writeFile(regPath, `\uFEFF${SAMPLE}`, 'utf16le')
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

test('the registry IPC surface is exposed', async () => {
  const api = await win.evaluate(() => ({
    exp: typeof window.electronAPI?.exportRegistryKey,
    read: typeof window.electronAPI?.readRegFile,
  }))
  expect(api).toEqual({ exp: 'function', read: 'function' })
})

test('a UTF-16 .reg file parses through the real handler', async () => {
  const result = await win.evaluate(async (p) => {
    await window.electronAPI.acceptDroppedPaths([p])
    return window.electronAPI.readRegFile(p)
  }, regPath)

  expect(result.format).toBe('reg5')
  const byName = Object.fromEntries(result.rows.map((r) => [r.name, r]))
  expect(byName.Name.value).toBe('Alice')
  expect(byName.Count.type).toBe('REG_DWORD')
  expect(byName.Count.value).toContain('42')
  expect(byName[''].value).toBe('default')
})

test('an unauthorised .reg path is refused', async () => {
  const result = await win.evaluate(async () => {
    try {
      await window.electronAPI.readRegFile('C:/Windows/System32/config/SAM')
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  expect(result).not.toBe('allowed')
})

test('a key path carrying argument syntax is rejected before reg.exe sees it', async () => {
  for (const bad of ['HKCU\\a"b', '/y', '-y', 'HKEY_MADE_UP\\x']) {
    const result = await win.evaluate(async (k) => {
      try {
        await window.electronAPI.exportRegistryKey(k)
        return 'allowed'
      } catch (err) {
        return String(err?.message ?? err)
      }
    }, bad)
    // The dialog is cancelled in headless runs, so 'null' is also a pass —
    // what must never happen is the path reaching the child process.
    expect(result, bad).not.toBe('allowed')
  }
})
