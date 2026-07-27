/**
 * Renderer wiring for the non-filesystem sources, end to end.
 *
 * Every case here is a feature whose main-process handler and preload binding
 * already existed and whose unit tests already passed, but which no renderer
 * code ever called. Unit tests cannot catch that, so these drive the same
 * entry points the menus and the folder view reach — the dialogs themselves
 * are the only step stubbed, because they cannot be driven headlessly.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'fs/promises'
import { tmpdir, platform } from 'os'
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
let folderDir
/** @type {string} */
let zipPath
/** @type {string} */
let snapPath

const DISK_TEXT = 'line one\nfrom disk\nline three\n'
const ZIP_TEXT = 'line one\nfrom the zip\nline three\n'

const REG_LEFT = [
  'Windows Registry Editor Version 5.00',
  '',
  '[HKEY_CURRENT_USER\\Software\\MyCompareWiring]',
  '"Name"="Alice"',
  '"Count"=dword:0000002a',
].join('\r\n')

const REG_RIGHT = [
  'Windows Registry Editor Version 5.00',
  '',
  '[HKEY_CURRENT_USER\\Software\\MyCompareWiring]',
  '"Name"="Bob"',
  '"Count"=dword:0000002a',
].join('\r\n')

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-wiring-'))
  folderDir = join(dir, 'folder')
  await mkdir(join(folderDir, 'src'), { recursive: true })
  await writeFile(join(folderDir, 'a.txt'), DISK_TEXT, 'utf-8')
  await writeFile(join(folderDir, 'src', 'b.js'), 'console.log(1)\n', 'utf-8')
  await writeFile(join(dir, 'left.reg'), `﻿${REG_LEFT}`, 'utf16le')
  await writeFile(join(dir, 'right.reg'), `﻿${REG_RIGHT}`, 'utf16le')

  // A read-only file so the attributes column has something to report.
  await writeFile(join(folderDir, 'locked.txt'), 'locked\n', 'utf-8')
  await chmod(join(folderDir, 'locked.txt'), 0o444)

  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  zip.file('a.txt', ZIP_TEXT)
  zip.folder('src').file('b.js', 'console.log(2)\n')
  zipPath = join(dir, 'bundle.zip')
  await writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))

  snapPath = join(dir, 'tree.mcss')
  await writeSnapshot(folderDir, snapPath)

  // The fixture directory is passed on the command line, which the main
  // process registers as an allowed root — the same trust step a dialog
  // performs, and the only one available without a dialog.
  ;({ app, win } = await launchApp([dir]))
  await win.waitForFunction(() => !!window.__testAPI)
})

test.afterAll(async () => {
  await closeApp(app)
  await chmod(join(folderDir, 'locked.txt'), 0o666).catch(() => {})
  await rm(dir, { recursive: true, force: true })
})

/** Close every open tab so the next test starts from the home view. */
async function resetTabs() {
  for (;;) {
    const btn = win.locator('.tab-close').first()
    if (!(await btn.count())) break
    await btn.click()
  }
}

test('a file inside an archive opens with its real contents, not two blank panes', async () => {
  await resetTabs()
  await win.evaluate(([zip, folder]) => window.__testAPI.openArchiveSide('left', zip)
    .then(() => window.__testAPI.folderSetRight(folder)), [zipPath, folderDir])

  const rows = await win.evaluate(() => window.__testAPI.folderRows())
  const aRow = rows.find((r) => r.name === 'a.txt')
  expect(aRow, 'the archive root should list a.txt').toBeTruthy()
  expect(aRow.leftPath).toContain('::')

  await win.evaluate(() => window.__testAPI.folderDblClick('a.txt'))
  await win.waitForFunction(() => window.__testAPI.currentView() === 'text')

  const contents = await win.evaluate(() => window.__testAPI.textGetContents())
  // The bug this covers: the `zip::entry` path went to readFile(), the path
  // validator refused it, the exception was swallowed, and both panes showed
  // empty — which the diff then reported as "identical".
  expect(contents.left).toContain('from the zip')
  expect(contents.right).toContain('from disk')
  const stats = await win.evaluate(() => window.__testAPI.textGetStats())
  expect(stats.total).toBeGreaterThan(0)
  expect(stats.replace + stats.insert + stats.delete).toBeGreaterThan(0)
  expect(await win.evaluate(() => window.__testAPI.statusLevel())).not.toBe('error')
})

test('an archive directory expands through the archive listing', async () => {
  await resetTabs()
  await win.evaluate((zip) => window.__testAPI.openArchiveSide('left', zip), zipPath)
  await win.evaluate(() => window.__testAPI.folderClick('src'))
  await win.waitForFunction(() =>
    window.__testAPI.folderRows().some((r) => r.name === 'b.js'))
})

test('a read failure is shown to the user instead of being swallowed', async () => {
  await resetTabs()
  await win.evaluate((zip) => window.__testAPI.openComparison({
    type: 'text',
    leftPath: `${zip}::no/such/entry.txt`,
  }), zipPath)

  expect(await win.evaluate(() => window.__testAPI.statusLevel())).toBe('error')
  const text = await win.evaluate(() => window.__testAPI.statusText())
  expect(text).toContain('無法讀取')
  expect(text).toContain('壓縮檔')
})

test('a snapshot opens as one side of a folder comparison', async () => {
  await resetTabs()
  await win.evaluate(([snap, folder]) => window.__testAPI.openSnapshotCompare({
    path: snap, name: 'tree', count: 4, createdAt: new Date().toISOString(), hasCrc: false,
  }).then(() => window.__testAPI.folderSetRight(folder)), [snapPath, folderDir])

  expect(await win.evaluate(() => window.__testAPI.currentView())).toBe('folder')
  const rows = await win.evaluate(() => window.__testAPI.folderRows())
  // Both sides list the same tree, so every row must be matched rather than
  // orphaned — proof the snapshot side really was read.
  expect(rows.map((r) => r.name).sort()).toEqual(['a.txt', 'locked.txt', 'src'])
  expect(rows.every((r) => r.status !== 'right-only')).toBe(true)
  expect(rows.find((r) => r.name === 'a.txt').leftPath).toContain('snapshot://')
})

test('two .reg files compare as normalised text', async () => {
  await resetTabs()
  await win.evaluate(([l, r]) => window.__testAPI.openRegCompare(l, r),
    [join(dir, 'left.reg'), join(dir, 'right.reg')])

  await win.waitForFunction(() => window.__testAPI.currentView() === 'text')
  const contents = await win.evaluate(() => window.__testAPI.textGetContents())
  expect(contents.left).toContain('[HKEY_CURRENT_USER\\Software\\MyCompareWiring]')
  expect(contents.left).toContain('Alice')
  expect(contents.right).toContain('Bob')
  // The shared DWORD must line up, so exactly the changed value stands out.
  const stats = await win.evaluate(() => window.__testAPI.textGetStats())
  expect(stats.equal).toBeGreaterThan(0)
  expect(stats.replace + stats.insert + stats.delete).toBeGreaterThan(0)
})

test('the attributes column reports read-only and the real hidden state', async () => {
  await resetTabs()
  await win.evaluate((folder) => window.__testAPI.folderSetLeft(folder), folderDir)
  // The attributes column is off by default; this is the "欄位選擇" action.
  await win.evaluate(() => window.__testAPI.folderSetColumns(['name', 'size', 'mtime', 'attrs']))

  // Turning the column on now re-scans, because the hidden bit is only read
  // while scanning. Reading the rows straight away races that rescan.
  await expect.poll(async () => {
    const rows = await win.evaluate(() => window.__testAPI.folderRows())
    return rows.find((r) => r.name === 'locked.txt')?.attrs ?? ''
  }).toContain('R')

  const rows = await win.evaluate(() => window.__testAPI.folderRows())
  const locked = rows.find((r) => r.name === 'locked.txt')
  expect(locked.attrs).toContain('R')
  expect(locked.attrsTitle).toContain('唯讀')

  const plain = rows.find((r) => r.name === 'a.txt')
  expect(plain.attrs).not.toContain('R')

  // This used to assert '?' on Windows, because fs.Stats carries no attribute
  // bits and the column could only say "cannot tell". read-dir now asks the OS
  // when the attributes column is on, so the honest answer is available and
  // the marker must not appear for a file that is simply not hidden.
  expect(plain.attrs).not.toContain('?')
  expect(plain.attrs).not.toContain('H')
})
