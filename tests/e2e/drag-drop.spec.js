/**
 * Drag-and-drop path acceptance.
 *
 * A dropped path is not an allowed root, so every read of it failed
 * validation in the main process — the text panes accepted drops but could
 * never load them. These tests exercise the IPC that grants access.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises'
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
  ;({ app, win } = await launchApp())
  dir = await mkdtemp(join(tmpdir(), 'mycompare-dnd-'))
  await writeFile(join(dir, 'a.txt'), 'hello\nworld\n', 'utf-8')
  await writeFile(join(dir, 'b.txt'), 'hello\nthere\n', 'utf-8')
  await mkdir(join(dir, 'sub'), { recursive: true })
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

test('reading a path that was never opened is refused', async () => {
  const result = await win.evaluate(async (p) => {
    try {
      await window.electronAPI.readFile(p)
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  }, join(dir, 'a.txt'))

  expect(result).not.toBe('allowed')
  expect(result).toMatch(/Access denied|not within any opened root/)
})

test('accepting a dropped path makes it readable', async () => {
  const content = await win.evaluate(async (p) => {
    const entries = await window.electronAPI.acceptDroppedPaths([p])
    if (!entries.length) return null
    const r = await window.electronAPI.readFile(p)
    return r?.content ?? null
  }, join(dir, 'b.txt'))

  expect(content).toBe('hello\nthere\n')
})

test('directories are reported as such', async () => {
  const entries = await win.evaluate(
    (p) => window.electronAPI.acceptDroppedPaths([p]),
    join(dir, 'sub')
  )
  expect(entries).toHaveLength(1)
  expect(entries[0].isDirectory).toBe(true)
})

test('paths that do not exist are dropped rather than registered', async () => {
  const entries = await win.evaluate(
    (p) => window.electronAPI.acceptDroppedPaths([p]),
    join(dir, 'no-such-file.txt')
  )
  expect(entries).toEqual([])
})

test('non-array and junk input is handled', async () => {
  const results = await win.evaluate(async () => [
    await window.electronAPI.acceptDroppedPaths(null),
    await window.electronAPI.acceptDroppedPaths(['', 123, undefined]),
  ])
  expect(results[0]).toEqual([])
  expect(results[1]).toEqual([])
})

test('read-dir reports attributes the folder view can display', async () => {
  const entries = await win.evaluate(async (d) => {
    await window.electronAPI.acceptDroppedPaths([d])
    return window.electronAPI.readDir(d)
  }, dir)

  expect(entries.length).toBeGreaterThan(0)
  const file = entries.find((e) => e.name === 'a.txt')
  expect(file).toBeTruthy()
  expect(typeof file.readOnly).toBe('boolean')
  expect(typeof file.ctime).toBe('string')
  // hidden is null where the platform cannot say, never a guess.
  expect(file.hidden === null || typeof file.hidden === 'boolean').toBe(true)

  const sub = entries.find((e) => e.name === 'sub')
  expect(sub.isDirectory).toBe(true)
})
