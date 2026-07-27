/**
 * Folder snapshots, end to end.
 *
 * The unit tests cover the format; these confirm the IPC surface is wired and
 * that a snapshot's virtual paths cannot be used to reach the filesystem.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'
import { writeSnapshot } from '../../src/main/snapshot.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let dir
/** @type {string} */
let snapPath

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-snap-e2e-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'a.txt'), 'hello', 'utf-8')
  await writeFile(join(dir, 'src', 'b.js'), 'console.log(1)', 'utf-8')
  snapPath = join(dir, 'tree.mcss')

  // The fixture directory is authorised on the command line, the way the app
  // authorises a path outside a dialog. Nothing the renderer says can widen
  // the allow-list, so a test cannot take that shortcut either.
  ;({ app, win } = await launchApp([dir]))
})

/** Build the snapshot fixture once, on demand. */
let fixtureWritten = false
async function writeSnapshotFixture() {
  if (fixtureWritten) return
  await writeSnapshot(dir, snapPath)
  fixtureWritten = true
}

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

test('a snapshot round-trips and projects one level at a time', async () => {
  // Written from the test process rather than through the IPC, because the
  // create-snapshot handler opens a save dialog that cannot be driven headlessly.
  await writeSnapshotFixture()

  const root = await win.evaluate(
    (p) => window.electronAPI.readSnapshotDir(p, ''), snapPath)
  expect(root.map((e) => e.name).sort()).toEqual(['a.txt', 'src'])
  expect(root.every((e) => e.path.startsWith('snapshot://'))).toBe(true)

  const src = await win.evaluate(
    (p) => window.electronAPI.readSnapshotDir(p, 'src'), snapPath)
  expect(src.map((e) => e.name)).toEqual(['b.js'])
  expect(src[0].isDirectory).toBe(false)
  expect(src[0].size).toBe('console.log(1)'.length)
})

test('a snapshot stores no file contents', async () => {
  await writeSnapshotFixture()
  const bytes = await readFile(snapPath)
  expect(bytes.includes(Buffer.from('console.log(1)'))).toBe(false)
})

test('snapshot paths are refused by the filesystem handlers', async () => {
  const result = await win.evaluate(async () => {
    try {
      await window.electronAPI.readFile('snapshot://src/b.js')
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  // Virtual entries have no file behind them; letting one through would read
  // whatever happens to sit at that location.
  expect(result).not.toBe('allowed')
})

test('the snapshot IPC surface is exposed to the renderer', async () => {
  const api = await win.evaluate(() => ({
    create: typeof window.electronAPI?.createSnapshot,
    load: typeof window.electronAPI?.loadSnapshot,
    readDir: typeof window.electronAPI?.readSnapshotDir,
  }))
  expect(api).toEqual({ create: 'function', load: 'function', readDir: 'function' })
})

test('reading a level from an unauthorised path is refused', async () => {
  const result = await win.evaluate(async () => {
    try {
      await window.electronAPI.readSnapshotDir('C:/nope.mcss', '')
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  // On-demand loading must still go through path validation, or the snapshot
  // reader would be a way around the sandbox.
  expect(result).not.toBe('allowed')
})

test('the Session menu offers snapshot commands', async () => {
  const labels = await app.evaluate(({ Menu }) => {
    const out = []
    const walk = (items) => {
      for (const it of items) {
        if (it.submenu) walk(it.submenu.items)
        else out.push(it.label)
      }
    }
    walk(Menu.getApplicationMenu().items)
    return out
  })
  expect(labels.some((l) => l.includes('建立資料夾快照'))).toBe(true)
  expect(labels.some((l) => l.includes('開啟快照比對'))).toBe(true)
})
