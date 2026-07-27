/**
 * The version control column, on the path a user actually walks.
 *
 * The IPC behind it is covered in vcs-owner.spec.js and the cell logic in
 * folder-vcs-owner.test.js. Neither proves the column reaches the screen —
 * and reaching the screen is exactly what this feature failed at when it
 * shipped, with two complete main-process modules and nothing wired to them.
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
let base
/** @type {string} */
let repo
/** @type {string} */
let plain
let hasGit = true

test.beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'mycompare-vcscol-'))
  repo = join(base, 'repo')
  plain = join(base, 'plain')

  try {
    await run('git', ['init', '-q', repo])
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    await run('git', ['config', 'user.name', 'Test'], { cwd: repo })
    await writeFile(join(repo, 'same.txt'), 'one\n', 'utf-8')
    await writeFile(join(repo, 'edited.txt'), 'one\n', 'utf-8')
    await run('git', ['add', '.'], { cwd: repo })
    await run('git', ['commit', '-q', '-m', 'first'], { cwd: repo })
    // One committed-and-clean file, one modified, one git has never seen.
    await writeFile(join(repo, 'edited.txt'), 'one\ntwo\n', 'utf-8')
    await writeFile(join(repo, 'fresh.txt'), 'new\n', 'utf-8')
  } catch {
    hasGit = false
  }

  await run('git', ['init', '-q', plain]).catch(() => {})
  await rm(join(plain, '.git'), { recursive: true, force: true }).catch(() => {})
  await writeFile(join(plain, 'same.txt'), 'one\n', 'utf-8')

  ;({ app, win } = await launchApp([base]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(base, { recursive: true, force: true })
})

/** Load the pair and turn the VCS column on. */
async function openWithVcs(left, right) {
  await win.evaluate(async ([l, r]) => {
    await window.__testAPI?.folderSetLeft(l)
    await window.__testAPI?.folderSetRight(r)
    window.__testAPI?.folderSetColumns(['name', 'size', 'vcs'])
  }, [left, right])
}

test('paints a state for each file rather than leaving the column blank', async () => {
  test.skip(!hasGit, 'git is not available on this machine')

  await openWithVcs(repo, plain)

  // The cells start as a pending placeholder and are patched when the single
  // git status lands, so the wait is for real content rather than for markup.
  await win.waitForFunction(() => {
    const cells = [...document.querySelectorAll('.fc-vcs')]
    return cells.length > 0 && cells.every((c) => c.textContent !== '…')
  }, { timeout: 10000 })

  const states = await win.evaluate(() =>
    [...document.querySelectorAll('.fc-row')].map((r) => ({
      name: r.querySelector('.fc-name')?.textContent?.trim() ?? '',
      vcs: r.querySelector('.fc-vcs')?.textContent?.trim() ?? '',
      cls: r.querySelector('.fc-vcs')?.className ?? '',
    })))

  const edited = states.find((s) => s.name.includes('edited.txt'))
  const fresh = states.find((s) => s.name.includes('fresh.txt'))
  expect(edited, 'the modified file has no row').toBeTruthy()
  expect(fresh, 'the untracked file has no row').toBeTruthy()

  // The badge is not the point; that the two states are told apart is. A
  // column that painted one value for everything would look populated and
  // answer nothing.
  expect(edited.vcs).not.toBe('')
  expect(fresh.vcs).not.toBe('')
  expect(edited.vcs).not.toBe(fresh.vcs)
  expect(edited.cls).toContain('fc-vcs--')
})

test('a folder outside a repository shows no state instead of claiming clean', async () => {
  // The dangerous failure here is silence that reads as an answer: a user
  // seeing "clean" for a tree git has never heard of would trust it.
  await openWithVcs(plain, plain)

  await win.waitForFunction(() => {
    const cells = [...document.querySelectorAll('.fc-vcs')]
    return cells.length > 0 && cells.every((c) => c.textContent !== '…')
  }, { timeout: 10000 })

  const cells = await win.evaluate(() =>
    [...document.querySelectorAll('.fc-vcs')].map((c) => c.textContent?.trim() ?? ''))

  expect(cells.length).toBeGreaterThan(0)
  for (const text of cells) expect(text).toBe('—')
})

test('the column header is present only while the column is on', async () => {
  await openWithVcs(repo, plain)
  // One heading per side, so turning the column on adds two.
  await expect(win.locator('#view-folder .fc-col-vcs')).toHaveCount(2)

  await win.evaluate(() => window.__testAPI?.folderSetColumns(['name', 'size']))
  await expect(win.locator('#view-folder .fc-col-vcs')).toHaveCount(0)
  await expect(win.locator('#view-folder .fc-vcs')).toHaveCount(0)
})
