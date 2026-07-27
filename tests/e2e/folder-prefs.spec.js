/**
 * The folder Options preferences, through the real dialog and the real tree.
 *
 * These four shipped as controls that stored a value with nothing reading it
 * back, so the unit tests that now cover the readers are the important half.
 * This is the other half: that changing the setting in the dialog reaches a
 * tree the user is looking at.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
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
let left
/** @type {string} */
let right

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycompare-folderpref-'))
  left = join(dir, 'left')
  right = join(dir, 'right')

  for (const base of [left, right]) {
    await mkdir(base, { recursive: true })
    // A name that sorts after a file, so "folders first" is visible rather
    // than coincidental: alphabetically zeta-dir comes last.
    await mkdir(join(base, 'zeta-dir'), { recursive: true })
    await writeFile(join(base, 'zeta-dir', 'nested.txt'), 'nested\n', 'utf-8')
    await writeFile(join(base, 'alpha.txt'), 'a\n', 'utf-8')
    await writeFile(join(base, 'beta.txt'), 'b\n', 'utf-8')
  }

  ;({ app, win } = await launchApp([dir]))
  await win.waitForFunction(() => !!window.__testAPI)
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

/** Set a checkbox preference through the Options dialog, as a user would. */
async function setCheck(pane, id, value) {
  const modal = win.locator('#settings-modal')
  if (!(await modal.isVisible())) {
    await win.evaluate(() => document.getElementById('btn-settings-modal')?.click())
    await expect(modal).toBeVisible({ timeout: 5000 })
  }
  await win.locator(`#options-tab-${pane}`).click()
  const box = win.locator(`#${id}`)
  if ((await box.isChecked()) !== value) await box.click()
  expect(await box.isChecked()).toBe(value)
  await win.locator('#btn-settings-modal-close').click()
}

/** Load the pair and wait for rows. */
async function openPair() {
  await win.evaluate(async ([l, r]) => {
    await window.__testAPI?.folderSetLeft(l)
    await window.__testAPI?.folderSetRight(r)
  }, [left, right])
  await win.waitForFunction(() => document.querySelectorAll('.fc-row').length > 0,
    { timeout: 10000 })
}

/** Visible row names, in display order. */
const rowNames = () => win.evaluate(() =>
  [...document.querySelectorAll('.fc-row')]
    .map((r) => r.querySelector('.fc-name')?.textContent?.trim() ?? '')
    .filter(Boolean))

test('folders sort before files when the preference is on', async () => {
  await setCheck('folderViews', 'chk-folder-folders-first', true)
  await openPair()

  const names = await rowNames()
  const dirIdx = names.findIndex((n) => n.includes('zeta-dir'))
  const fileIdx = names.findIndex((n) => n.includes('alpha.txt'))
  expect(dirIdx, 'the directory row is missing').toBeGreaterThanOrEqual(0)
  expect(fileIdx, 'the file row is missing').toBeGreaterThanOrEqual(0)
  // zeta-dir sorts last by name, so this only holds if the grouping is real.
  expect(dirIdx).toBeLessThan(fileIdx)
})

test('turning it off lets the name order stand', async () => {
  await setCheck('folderViews', 'chk-folder-folders-first', false)
  await openPair()

  const names = await rowNames()
  const dirIdx = names.findIndex((n) => n.includes('zeta-dir'))
  const fileIdx = names.findIndex((n) => n.includes('alpha.txt'))
  expect(dirIdx).toBeGreaterThan(fileIdx)

  await setCheck('folderViews', 'chk-folder-folders-first', true)
})

test('expand on open shows nested children without a click', async () => {
  await setCheck('folderViews', 'chk-folder-expand-on-open', true)
  await openPair()

  await win.waitForFunction(
    () => [...document.querySelectorAll('.fc-row .fc-name')]
      .some((n) => (n.textContent ?? '').includes('nested.txt')),
    { timeout: 10000 })

  const names = await rowNames()
  expect(names.some((n) => n.includes('nested.txt'))).toBe(true)
})

test('with it off the child stays hidden until the folder is opened', async () => {
  // The half that proves the preference is what did it, rather than the tree
  // expanding on its own.
  await setCheck('folderViews', 'chk-folder-expand-on-open', false)
  await openPair()

  const names = await rowNames()
  expect(names.some((n) => n.includes('zeta-dir'))).toBe(true)
  expect(names.some((n) => n.includes('nested.txt'))).toBe(false)
})
