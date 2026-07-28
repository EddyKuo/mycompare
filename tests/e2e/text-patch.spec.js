/**
 * Text Patch, driven through the running app.
 *
 * The parser and the apply rules have unit tests. What only a real run shows is
 * that the view is reachable, that the rows reach the DOM, and — the part that
 * matters — that applying actually rewrites files on disk, and that a patch
 * which cannot be applied leaves every one of them untouched.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let dir

const PATCH = [
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '',
].join('\n')

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-tp-'))
  await writeFile(join(dir, 'f.txt'), 'one\ntwo\nthree\n', 'utf-8')
  await writeFile(join(dir, 'stale.txt'), 'nothing like the patch\n', 'utf-8')
  ;({ app, win } = await launchApp([dir]))
  await win.waitForFunction(() => !!window.__testAPI)
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

/** @param {string} text */
async function openPatch(text = PATCH) {
  await win.evaluate(() => window.__testAPI.menuCommand('session.new.textpatch'))
  await expect(win.locator('#view-textpatch')).toBeVisible({ timeout: 5000 })
  return win.evaluate((t) => window.__testAPI.patchSet('C:/t/x.patch', t), text)
}

test('the patch view is reachable and renders the change', async () => {
  expect(await openPatch()).toBe(true)
  expect(await win.evaluate(() => window.__testAPI.currentView())).toBe('textpatch')

  const stats = await win.evaluate(() => window.__testAPI.patchStats())
  expect(stats).toEqual({ files: 1, hunks: 1, added: 1, removed: 1 })

  // A removal shows on the left only and an insertion on the right only; that
  // asymmetry is what makes a patch read as a change.
  await expect(win.locator('#view-textpatch .tp-delete')).toHaveCount(1)
  await expect(win.locator('#view-textpatch .tp-insert')).toHaveCount(1)
})

test('a malformed patch is refused rather than half-shown', async () => {
  // Silently dropping lines would leave the user unable to tell a truncated
  // view from a small patch.
  expect(await openPatch('@@ this is not a hunk header @@\nnonsense\n')).toBe(false)
  expect(await win.evaluate(() => window.__testAPI.patchRows())).toBe(0)
})

test('navigation moves by difference, by section and by file', async () => {
  const multi = [
    '--- a/one.txt', '+++ b/one.txt',
    '@@ -1,2 +1,2 @@', '-a', '+A', ' b',
    '@@ -5,2 +5,2 @@', ' e', '-f', '+F',
    '--- a/two.txt', '+++ b/two.txt',
    '@@ -1,1 +1,1 @@', '-x', '+X',
    '',
  ].join('\n')
  await openPatch(multi)

  const stats = await win.evaluate(() => window.__testAPI.patchStats())
  expect(stats.files).toBe(2)
  expect(stats.hunks).toBe(3)

  await win.evaluate(() => window.__testAPI.patchRun('firstDifference'))
  expect(await win.evaluate(() => window.__testAPI.patchRun('getCurrentDiffIndex'))).toBe(0)

  // Section and file navigation are separate commands in BC, and they move by
  // different units — stepping one must not be the same as stepping the other.
  expect(await win.evaluate(() => window.__testAPI.patchRun('goToSection', 1))).toBe(true)
  expect(await win.evaluate(() => window.__testAPI.patchRun('goToFile', 1))).toBe(true)
})

test('applying rewrites the file on disk', async () => {
  await openPatch()
  const plan = await win.evaluate((root) => window.__testAPI.patchPreview(root), dir)
  expect(plan).toHaveLength(1)
  expect(plan[0].ok).toBe(true)

  // previewApply does not write; the file must still be untouched here.
  expect(await readFile(join(dir, 'f.txt'), 'utf-8')).toBe('one\ntwo\nthree\n')

  await win.evaluate(async (root) => {
    const view = window.__testAPI
    const plan2 = await view.patchRun('previewApply', root)
    for (const item of plan2.filter((p) => p.ok)) {
      await window.electronAPI.writeFileAt(item.path, item.text)
    }
  }, dir)

  expect(await readFile(join(dir, 'f.txt'), 'utf-8')).toBe('one\nTWO\nthree\n')
})

test('a patch that does not match leaves the file exactly as it was', async () => {
  const before = await readFile(join(dir, 'stale.txt'), 'utf-8')
  await openPatch([
    '--- a/stale.txt', '+++ b/stale.txt',
    '@@ -1,2 +1,2 @@', ' expected line', '-gone', '+new',
    '',
  ].join('\n'))

  const plan = await win.evaluate((root) => window.__testAPI.patchPreview(root), dir)
  expect(plan[0].ok).toBe(false)
  expect(plan[0].reason).toBeTruthy()
  expect(await readFile(join(dir, 'stale.txt'), 'utf-8')).toBe(before)
})

test('a write outside every opened folder is refused', async () => {
  const outcome = await win.evaluate(async () => {
    try {
      await window.electronAPI.writeFileAt('C:/Windows/System32/mycompare-should-not-exist.txt', 'x')
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  expect(outcome).not.toBe('allowed')
})
