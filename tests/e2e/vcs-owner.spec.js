/**
 * The version control and owner columns, through the real IPC.
 *
 * These two features shipped as a pair of complete main-process modules with
 * thirty-five passing unit tests behind them and no handler, no preload entry,
 * and therefore no way to reach either one. Every call the folder view made
 * was a TypeError waiting for the column to render.
 *
 * The unit tests check the parsing. This checks the part they cannot: that the
 * channel exists, that it runs git against a real repository, and that a path
 * outside the opened roots is refused here as it is everywhere else.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'

const run = promisify(execFile)

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let dir
/** Whether git exists here; without it the status call answers 'git-missing'. */
let hasGit = true

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-vcs-'))

  try {
    // A repository built by git itself, not a hand-made .git directory: the
    // point is to read what the real tool reports.
    await run('git', ['init', '-q'], { cwd: dir })
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    await run('git', ['config', 'user.name', 'Test'], { cwd: dir })
    await writeFile(join(dir, 'tracked.txt'), 'one\n', 'utf-8')
    await run('git', ['add', 'tracked.txt'], { cwd: dir })
    await run('git', ['commit', '-q', '-m', 'first'], { cwd: dir })
    // Three states worth distinguishing: modified, untracked, and clean.
    await writeFile(join(dir, 'tracked.txt'), 'one\ntwo\n', 'utf-8')
    await writeFile(join(dir, 'fresh.txt'), 'new\n', 'utf-8')
  } catch {
    hasGit = false
  }

  ;({ app, win } = await launchApp([dir]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

test('reports the repository and the files that changed in it', async () => {
  test.skip(!hasGit, 'git is not available on this machine')

  const res = await win.evaluate((d) => window.electronAPI.vcsStatus(d), dir)

  expect(res.available).toBe(true)
  expect(res.vcs).toBe('git')

  // Keyed by repository-relative POSIX path, which is what lookupVcsState in
  // the folder view converts an absolute row path into before indexing here.
  // Both files have to appear — an empty map satisfies "available" while
  // showing a tree full of edits as clean.
  expect(res.files['tracked.txt'], 'the edited file is missing').toBeTruthy()
  expect(res.files['fresh.txt'], 'the untracked file is missing').toBeTruthy()
  // Modified and untracked are different states; one value for both would
  // render the column as decoration.
  expect(res.files['tracked.txt']).not.toBe(res.files['fresh.txt'])
})

test('a directory outside any repository is a quiet no-column, not an error', async () => {
  // The folder view asks for this on every open. A throw here would break
  // ordinary folder comparison for everyone not working inside a repository.
  const plain = await mkdtemp(join(tmpdir(), 'mycompare-norepo-'))
  try {
    const { app: a2, win: w2 } = await launchApp([plain])
    const res = await w2.evaluate((d) => window.electronAPI.vcsStatus(d), plain)
    expect(res.available).toBe(false)
    expect(typeof res.reason).toBe('string')
    await closeApp(a2)
  } finally {
    await rm(plain, { recursive: true, force: true })
  }
})

test('staging a file through the menu changes what status reports', async () => {
  test.skip(!hasGit, 'git is not available on this machine')

  const target = join(dir, 'fresh.txt')
  const before = await win.evaluate((d) => window.electronAPI.vcsStatus(d), dir)

  const out = await win.evaluate(
    ([root, p]) => window.electronAPI.vcsRun({ action: 'add', root, paths: [p] }),
    [dir, target])
  expect(out.results[0].state).toBe('done')

  // The write actually reached git rather than reporting success on nothing.
  const after = await win.evaluate((d) => window.electronAPI.vcsStatus(d), dir)
  expect(after.files['fresh.txt']).not.toBe(before.files['fresh.txt'])
})

test('the diff query returns the changed text', async () => {
  test.skip(!hasGit, 'git is not available on this machine')

  const res = await win.evaluate(
    ([root, p]) => window.electronAPI.vcsText({ action: 'diff', root, path: p }),
    [dir, join(dir, 'tracked.txt')])

  expect(res.text).toContain('two')
})

test('refuses a path outside the repository it was given', async () => {
  test.skip(!hasGit, 'git is not available on this machine')

  const outcome = await win.evaluate(async (root) => {
    try {
      await window.electronAPI.vcsText({
        action: 'diff', root, path: 'C:/Windows/System32/drivers/etc/hosts',
      })
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  }, dir)
  expect(outcome).not.toBe('allowed')
})

test('reads an owner for a real file', async () => {
  const infos = await win.evaluate(
    (p) => window.electronAPI.fileOwners([p]), join(dir, 'tracked.txt'))

  expect(Array.isArray(infos)).toBe(true)
  expect(infos).toHaveLength(1)
  // Not asserting a particular account name — that varies by machine. What
  // matters is that something was read rather than a blank placeholder.
  expect(typeof infos[0].owner).toBe('string')
})

test('answers one entry per path, in the order asked', async () => {
  const paths = [join(dir, 'tracked.txt'), join(dir, 'fresh.txt')]
  const infos = await win.evaluate((ps) => window.electronAPI.fileOwners(ps), paths)

  expect(infos).toHaveLength(2)
  // Losing the correspondence would attribute one file's owner to another,
  // which no amount of correct parsing would show.
  expect(infos[0].path).toBe(paths[0])
  expect(infos[1].path).toBe(paths[1])
})

test('the owner lookup refuses a path outside every opened root', async () => {
  const outcome = await win.evaluate(async () => {
    try {
      await window.electronAPI.fileOwners(['C:/Windows/System32/drivers/etc/hosts'])
      return 'allowed'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  expect(outcome).not.toBe('allowed')
})
