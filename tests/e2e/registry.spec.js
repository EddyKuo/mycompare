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
/** @type {string} */
let bigPath

const SAMPLE = [
  'Windows Registry Editor Version 5.00',
  '',
  '[HKEY_CURRENT_USER\\Software\\MyCompareTest]',
  '@="default"',
  '"Name"="Alice"',
  '"Count"=dword:0000002a',
].join('\r\n')

/**
 * A .reg holding one binary value of the size real ones reach.
 *
 * reg.exe wraps binary data at ~80 columns, so a multi-megabyte value arrives
 * as tens of thousands of continuation lines.
 *
 * @returns {string}
 */
function bigSample() {
  const lines = [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Software\\MyCompareTest\\Big]',
    '"Blob"=hex:\\',
  ]
  for (let i = 0; i < 60_000; i++) {
    lines.push('  00,11,22,33,44,55,66,77,88,99,aa,bb,cc,dd,ee,ff,\\')
  }
  lines.push('  00')
  return lines.join('\r\n')
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-reg-'))
  regPath = join(dir, 'sample.reg')
  bigPath = join(dir, 'big.reg')
  await writeFile(regPath, `\uFEFF${SAMPLE}`, 'utf16le')
  await writeFile(bigPath, bigSample(), 'utf-8')
  // Authorised on the command line: the renderer has no way to add a root.
  ;({ app, win } = await launchApp([regPath, bigPath]))
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
  const result = await win.evaluate(
    (p) => window.electronAPI.readRegFile(p), regPath)

  expect(result.format).toBe('reg5')
  const byName = Object.fromEntries(result.rows.map((r) => [r.name, r]))
  expect(byName.Name.value).toBe('Alice')
  expect(byName.Count.type).toBe('REG_DWORD')
  expect(byName.Count.value).toContain('42')
  expect(byName[''].value).toBe('default')
})

test('a multi-megabyte value comes back instead of freezing the app', async () => {
  // Parsing happens in the main process, so a stall here is not a slow view —
  // every window stops responding and there is no way back. The export of
  // HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion on a stock Windows 11
  // install holds a value this size, so it is an ordinary key to compare, not
  // a contrived one. The unit tests cover the joining function directly; this
  // is the only check that the whole IPC path stays responsive.
  const started = Date.now()
  const result = await win.evaluate(
    (p) => window.electronAPI.readRegFile(p), bigPath)
  const elapsed = Date.now() - started

  const blob = result.rows.find((r) => r.name === 'Blob')
  expect(blob?.type).toBe('REG_BINARY')
  // The value survived intact — a fast wrong answer would pass a timing check.
  expect(blob.value.startsWith('00 11 22 33')).toBe(true)
  expect(blob.value.length).toBeGreaterThan(2_000_000)
  expect(elapsed).toBeLessThan(15_000)
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
