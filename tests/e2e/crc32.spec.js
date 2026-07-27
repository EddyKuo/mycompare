/**
 * CRC-32 through the real IPC, against a value produced outside this codebase.
 *
 * The unit test checks the algorithm against published vectors. This checks
 * the other half: that the channel exists, reads the actual file, and refuses
 * paths outside the opened roots like every other file operation here.
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
  dir = await mkdtemp(join(tmpdir(), 'mycompare-crc-'))
  await writeFile(join(dir, 'check.txt'), '123456789', 'utf-8')
  await writeFile(join(dir, 'empty.txt'), '', 'utf-8')
  await writeFile(join(dir, 'other.txt'), 'abc', 'utf-8')
  ;({ app, win } = await launchApp([dir]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

test('matches the standard check value for "123456789"', async () => {
  // CBF43926 is the documented CRC-32 check value, the one every CRC
  // implementation is expected to reproduce.
  const out = await win.evaluate(
    (p) => window.electronAPI.crc32File(p), join(dir, 'check.txt'))
  expect(out).toBe('CBF43926')
})

test('an empty file is all zeroes, not an error', async () => {
  const out = await win.evaluate(
    (p) => window.electronAPI.crc32File(p), join(dir, 'empty.txt'))
  expect(out).toBe('00000000')
})

test('different contents give different values', async () => {
  // A CRC that returned a constant would pass both tests above if the constant
  // happened to be right for one of them.
  const a = await win.evaluate((p) => window.electronAPI.crc32File(p), join(dir, 'check.txt'))
  const b = await win.evaluate((p) => window.electronAPI.crc32File(p), join(dir, 'other.txt'))
  expect(a).not.toBe(b)
  expect(b).toBe('352441C2')
})

test('it is not the MD5 channel wearing a different name', async () => {
  const p = join(dir, 'other.txt')
  const crc = await win.evaluate((f) => window.electronAPI.crc32File(f), p)
  const md5 = await win.evaluate((f) => window.electronAPI.hashFile(f), p)
  expect(crc).toHaveLength(8)
  expect(md5).toHaveLength(32)
  expect(crc).not.toBe(md5)
})

test('refuses a path outside every opened root', async () => {
  const outcome = await win.evaluate(async () => {
    try {
      await window.electronAPI.crc32File('C:/Windows/System32/drivers/etc/hosts')
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  expect(outcome).not.toBe('allowed')
})
