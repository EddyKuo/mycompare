/**
 * Drag-and-drop path acceptance.
 *
 * A dropped path is not an allowed root, so every read of it fails validation
 * in the main process until the drop is registered. These tests exercise that
 * boundary from the renderer side.
 *
 * The renderer hands over the dropped `File` objects and preload resolves each
 * one with `webUtils.getPathForFile`. That is not a detail: it is what stops
 * the renderer naming a path of its own choosing. A test cannot fabricate a
 * File the browser will hand a real path for, which is exactly the point — so
 * fixture directories are authorised the way the app authorises them outside a
 * dialog, by command-line argument.
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
/** @type {string} */
let unopened

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-dnd-'))
  await writeFile(join(dir, 'a.txt'), 'hello\nworld\n', 'utf-8')
  await writeFile(join(dir, 'b.txt'), 'hello\nthere\n', 'utf-8')
  await mkdir(join(dir, 'sub'), { recursive: true })

  // A second directory that is never passed on the command line, so it stays
  // outside every allowed root for the lifetime of the app.
  unopened = await mkdtemp(join(tmpdir(), 'mycompare-dnd-closed-'))
  await writeFile(join(unopened, 'secret.txt'), 'not yours\n', 'utf-8')

  ;({ app, win } = await launchApp([join(dir, 'a.txt')]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
  await rm(unopened, { recursive: true, force: true })
})

test('reading a path that was never opened is refused', async () => {
  const result = await win.evaluate(async (p) => {
    try {
      await window.electronAPI.readFile(p)
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  }, join(unopened, 'secret.txt'))

  expect(result).not.toBe('allowed')
  expect(result).toMatch(/Access denied|not within any opened root/)
})

test('the renderer cannot name a path of its own', async () => {
  // A File the page constructs has no path behind it, so preload resolves
  // nothing and no root is registered. Were the path itself accepted over IPC,
  // any script in the renderer could authorise ~/.ssh and read it — the drop
  // would just be the cover story.
  const outcome = await win.evaluate(async (p) => {
    const forged = new File(['x'], p)
    const entries = await window.electronAPI.acceptDroppedFiles([forged])
    let read = 'refused'
    try {
      await window.electronAPI.readFile(p)
      read = 'allowed'
    } catch { /* expected */ }
    return { entries, read }
  }, join(unopened, 'secret.txt'))

  expect(outcome.entries).toEqual([])
  expect(outcome.read).toBe('refused')
})

test('junk input is handled without throwing', async () => {
  const results = await win.evaluate(async () => [
    await window.electronAPI.acceptDroppedFiles(null),
    await window.electronAPI.acceptDroppedFiles([]),
  ])
  expect(results[0]).toEqual([])
  expect(results[1]).toEqual([])
})

test('a path authorised on the command line is readable', async () => {
  const content = await win.evaluate(async (p) => {
    const r = await window.electronAPI.readFile(p)
    return r?.content ?? null
  }, join(dir, 'b.txt'))

  expect(content).toBe('hello\nthere\n')
})

test('read-dir reports attributes the folder view can display', async () => {
  const entries = await win.evaluate((d) => window.electronAPI.readDir(d), dir)

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
