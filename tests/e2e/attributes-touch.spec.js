/**
 * Hidden attributes, read-only, and timestamp copying, through the real IPC.
 *
 * These three cannot be unit tested in any useful way: Node's Stats carries no
 * attribute bits, so the whole implementation is the OS call. A test that
 * mocked it would be testing the mock.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, rm, stat, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'

const isWindows = process.platform === 'win32'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let dir

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-attr-'))
  await writeFile(join(dir, 'plain.txt'), 'a', 'utf-8')
  await writeFile(join(dir, 'secret.txt'), 'b', 'utf-8')
  await writeFile(join(dir, 'old.txt'), 'c', 'utf-8')
  ;({ app, win } = await launchApp([dir]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

test('read-dir leaves hidden unknown unless asked, so it costs nothing by default', async () => {
  // Reading the attribute spawns a process per directory; a recursive scan
  // must not pay for it without asking.
  const rows = await win.evaluate((d) => window.electronAPI.readDir(d), dir)
  const row = rows.find((r) => r.name === 'plain.txt')
  expect(row).toBeTruthy()
  if (isWindows) expect(row.hidden).toBeNull()
})

test('read-dir reports the hidden attribute when asked', async () => {
  test.skip(!isWindows, 'no hidden attribute on this platform')

  await win.evaluate(
    (p) => window.electronAPI.setHidden(p, true), join(dir, 'secret.txt'))

  const rows = await win.evaluate(
    (d) => window.electronAPI.readDir(d, { attributes: true }), dir)
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]))

  expect(byName['secret.txt'].hidden).toBe(true)
  // The point of asking is to distinguish hidden from not — reporting true for
  // everything would pass a weaker test.
  expect(byName['plain.txt'].hidden).toBe(false)

  await win.evaluate(
    (p) => window.electronAPI.setHidden(p, false), join(dir, 'secret.txt'))
  const after = await win.evaluate(
    (d) => window.electronAPI.readDir(d, { attributes: true }), dir)
  expect(after.find((r) => r.name === 'secret.txt').hidden).toBe(false)
})

test('read-dir reports the system and archive bits alongside hidden', async () => {
  test.skip(!isWindows, 'no such attributes on this platform')

  // attrib already prints all three on the same line; only H was being read,
  // so the folder view's System and Archive columns had nothing to show even
  // though the answer was right there.
  const p = join(dir, 'flagged.txt')
  await writeFile(p, 'x', 'utf-8')
  await win.evaluate((f) => window.electronAPI.setHidden(f, true), p)

  const rows = await win.evaluate(
    (d) => window.electronAPI.readDir(d, { attributes: true }), dir)
  const row = rows.find((r) => r.name === 'flagged.txt')

  expect(row.hidden).toBe(true)
  expect(typeof row.system).toBe('boolean')
  expect(typeof row.archive).toBe('boolean')

  // A plain file must read false rather than true for everything, or the
  // columns would be decorative.
  const plain = rows.find((r) => r.name === 'plain.txt')
  expect(plain.hidden).toBe(false)
  expect(plain.system).toBe(false)

  await win.evaluate((f) => window.electronAPI.setHidden(f, false), p)
})

test('read-only can be set and cleared without discarding other permissions', async () => {
  const p = join(dir, 'plain.txt')
  const before = (await stat(p)).mode

  await win.evaluate((f) => window.electronAPI.setReadOnly(f, true), p)
  expect((await stat(p)).mode & 0o200).toBe(0)

  await win.evaluate((f) => window.electronAPI.setReadOnly(f, false), p)
  expect((await stat(p)).mode & 0o200).not.toBe(0)

  // Only the write bits may move. Rewriting the whole mode would silently drop
  // group and other permissions on Unix.
  expect((await stat(p)).mode & ~0o222).toBe(before & ~0o222)
})

test('a timestamp can be copied onto another file, leaving atime alone', async () => {
  const p = join(dir, 'old.txt')
  const target = new Date('2019-03-04T05:06:07.000Z')
  const atimeBefore = (await stat(p)).atime

  await win.evaluate(
    ([f, t]) => window.electronAPI.setMtime(f, t), [p, target.toISOString()])

  const after = await stat(p)
  expect(Math.abs(after.mtime.getTime() - target.getTime())).toBeLessThan(2000)
  // Touch exists to make one file look like another, not to record that we
  // opened it.
  expect(Math.abs(after.atime.getTime() - atimeBefore.getTime())).toBeLessThan(2000)
})

test('an unparseable timestamp is refused rather than silently becoming now', async () => {
  const p = join(dir, 'old.txt')
  await utimes(p, new Date('2019-03-04'), new Date('2019-03-04'))

  const outcome = await win.evaluate(async (f) => {
    try {
      await window.electronAPI.setMtime(f, 'not a date')
      return 'accepted'
    } catch (err) {
      return String(err?.message ?? err)
    }
  }, p)

  expect(outcome).not.toBe('accepted')
  expect((await stat(p)).mtime.getFullYear()).toBe(2019)
})

test('all three refuse a path outside every opened root', async () => {
  const outcomes = await win.evaluate(async () => {
    const target = 'C:/Windows/System32/drivers/etc/hosts'
    const results = []
    for (const call of [
      () => window.electronAPI.setHidden(target, true),
      () => window.electronAPI.setReadOnly(target, true),
      () => window.electronAPI.setMtime(target, new Date().toISOString()),
    ]) {
      try { await call(); results.push('allowed') } catch (e) { results.push(String(e.message)) }
    }
    return results
  })
  for (const o of outcomes) expect(o).not.toBe('allowed')
})
