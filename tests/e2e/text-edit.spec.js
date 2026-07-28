/**
 * Text Edit, driven through the running app.
 *
 * The unit tests cover the offset arithmetic. What they cannot show is that the
 * view is reachable, that Find in Files crosses the IPC boundary and comes back
 * with real hits, and that the search cannot be pointed outside a folder the
 * user opened — none of which exist in jsdom.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises'
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
  dir = await mkdtemp(join(tmpdir(), 'mycompare-te-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'a.txt'), 'alpha\nneedle here\nomega\n', 'utf-8')
  await writeFile(join(dir, 'src', 'b.js'), 'const needle = 1\n// needle twice\n', 'utf-8')
  await writeFile(join(dir, 'src', 'c.md'), 'nothing to see\n', 'utf-8')
  // Authorised on the command line: the renderer cannot add a root itself.
  ;({ app, win } = await launchApp([dir]))
  await win.waitForFunction(() => !!window.__testAPI)
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

/** Open the editor view with some content in it. */
async function openEditor(text = 'one\ntwo\nthree\n') {
  await win.evaluate(() => window.__testAPI.menuCommand('session.new.textedit'))
  await expect(win.locator('#view-textedit')).toBeVisible({ timeout: 5000 })
  await win.evaluate((t) => window.__testAPI.editSetContent('C:/t/demo.txt', t, 'UTF-8'), text)
}

test('the editor is reachable from the session menu', async () => {
  await openEditor()
  expect(await win.evaluate(() => window.__testAPI.currentView())).toBe('textedit')
  // The textarea and its highlighted underlay both exist; one without the
  // other is the failure that makes the caret and the text disagree.
  await expect(win.locator('#view-textedit .te-input')).toHaveCount(1)
  await expect(win.locator('#view-textedit .te-code')).toHaveCount(1)
})

test('the gutter numbers every line', async () => {
  await openEditor('a\nb\nc\nd\n')
  // Four lines plus the empty one after the final newline.
  await expect(win.locator('#view-textedit .te-lineno')).toHaveCount(5)
})

test('an editing command changes the buffer and marks it modified', async () => {
  await openEditor('one\ntwo\nthree\n')
  expect(await win.evaluate(() => window.__testAPI.editIsModified())).toBe(false)

  await win.evaluate(() => {
    const ta = document.querySelector('#view-textedit .te-input')
    ta.setSelectionRange(4, 4) // on line 2
    window.__testAPI.editRun('deleteLine')
  })

  expect(await win.evaluate(() => window.__testAPI.editGetContent())).toBe('one\nthree\n')
  expect(await win.evaluate(() => window.__testAPI.editIsModified())).toBe(true)
})

test('Find in Files returns real hits through the IPC', async () => {
  await openEditor()
  const result = await win.evaluate(
    (root) => window.__testAPI.editFindInFiles({ root, query: 'needle' }), dir)

  expect(result.matches.length).toBe(3)
  const files = [...new Set(result.matches.map((m) => m.relPath))].sort()
  expect(files).toEqual(['a.txt', 'src/b.js'])
  const first = result.matches.find((m) => m.relPath === 'a.txt')
  expect(first.line).toBe(2)
  expect(first.text).toBe('needle here')
  expect(result.truncated).toBeNull()

  // The results panel is the only way a user sees any of this.
  await expect(win.locator('#view-textedit .te-results')).toBeVisible()
  await expect(win.locator('#view-textedit .te-result')).toHaveCount(3)
})

test('the file mask narrows the search', async () => {
  await openEditor()
  const result = await win.evaluate(
    (root) => window.__testAPI.editFindInFiles({ root, query: 'needle', mask: '*.js' }), dir)
  expect(result.matches.every((m) => m.relPath.endsWith('.js'))).toBe(true)
  expect(result.matches.length).toBe(2)
})

test('a search rooted outside every opened folder is refused', async () => {
  await openEditor()
  const outcome = await win.evaluate(async () => {
    try {
      await window.electronAPI.findInFiles({ root: 'C:/Windows/System32', query: 'a' })
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  // Searching reads every file beneath the root, so it has to obey the same
  // allow-list as opening one.
  expect(outcome).not.toBe('allowed')
})

test('double-clicking a result opens that file at that line', async () => {
  await openEditor()
  await win.evaluate(
    (root) => window.__testAPI.editFindInFiles({ root, query: 'needle' }), dir)

  const row = win.locator('#view-textedit .te-result', { hasText: 'src/b.js' }).first()
  await row.dblclick()

  await expect
    .poll(() => win.evaluate(() => window.__testAPI.editGetContent()))
    .toContain('const needle = 1')
})
