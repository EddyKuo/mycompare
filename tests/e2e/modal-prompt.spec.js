/**
 * The promise-based prompt modal, driven the way a user drives it.
 *
 * Electron does not implement `window.prompt` — it throws
 * `TypeError: prompt() is not supported.` — so every native call site was dead
 * on arrival. Unit tests could not catch that: jsdom *does* define
 * window.prompt, and the modal module's own unit tests never ran inside the
 * app. Only a run against the built application proves the path works.
 *
 * This spec fails loudly in either direction: if the modal never appears the
 * input locator times out, and if it appears but is not wired the file on disk
 * is unchanged.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, rm, access, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let leftDir
/** @type {string} */
let rightDir

const exists = async (p) => {
  try { await access(p); return true } catch { return false }
}

test.beforeAll(async () => {
  leftDir = await mkdtemp(join(tmpdir(), 'mycompare-prompt-l-'))
  rightDir = await mkdtemp(join(tmpdir(), 'mycompare-prompt-r-'))
  await writeFile(join(leftDir, 'before.txt'), 'hello', 'utf-8')
  await writeFile(join(rightDir, 'before.txt'), 'hello', 'utf-8')
  ;({ app, win } = await launchApp([leftDir, rightDir]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(leftDir, { recursive: true, force: true })
  await rm(rightDir, { recursive: true, force: true })
})

/** Load both fixture folders into the folder view. */
async function openFolders() {
  await win.evaluate(async ([l, r]) => {
    await window.__testAPI.folderSetLeft(l)
    await window.__testAPI.folderSetRight(r)
  }, [leftDir, rightDir])
  await expect(win.locator('#view-folder')).toBeVisible({ timeout: 5000 })
}

/**
 * Right-click a row and pick a context-menu entry by its exact label.
 * @param {string} rowName
 * @param {string} label
 */
async function pickFromRowMenu(rowName, label) {
  const row = win.locator(`.fc-row[data-name="${rowName}"]`).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.click({ button: 'right' })
  const item = win.locator('.ctx-menu .ctx-item', { hasText: label }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
}

test('重新命名 opens the modal and the rename actually happens', async () => {
  await openFolders()
  await pickFromRowMenu('before.txt', '重新命名…')

  // If prompt() were still native this would never appear — the click handler
  // would have thrown before reaching here.
  const input = win.locator('.mc-modal-overlay .mc-modal-input')
  await expect(input).toBeVisible({ timeout: 5000 })
  // The old name is offered as the default, as the native dialog did.
  await expect(input).toHaveValue('before.txt')

  await input.fill('after.txt')
  await win.locator('.mc-modal-overlay .mc-modal-btn--primary').click()
  await expect(win.locator('.mc-modal-overlay')).toHaveCount(0, { timeout: 5000 })

  await expect.poll(() => exists(join(leftDir, 'after.txt')), { timeout: 5000 }).toBe(true)
  expect(await exists(join(leftDir, 'before.txt'))).toBe(false)
})

test('Escape cancels and renames nothing', async () => {
  await openFolders()
  const namesBefore = (await readdir(leftDir)).sort()

  await pickFromRowMenu('after.txt', '重新命名…')
  const input = win.locator('.mc-modal-overlay .mc-modal-input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('should-not-exist.txt')
  await win.keyboard.press('Escape')
  await expect(win.locator('.mc-modal-overlay')).toHaveCount(0, { timeout: 5000 })

  expect((await readdir(leftDir)).sort()).toEqual(namesBefore)
  expect(await exists(join(leftDir, 'should-not-exist.txt'))).toBe(false)
})

test('新建資料夾（左側） creates the folder typed into the modal', async () => {
  await openFolders()
  await pickFromRowMenu('after.txt', '新建資料夾（左側）…')

  const input = win.locator('.mc-modal-overlay .mc-modal-input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('made-by-modal')
  await win.locator('.mc-modal-overlay .mc-modal-btn--primary').click()
  await expect(win.locator('.mc-modal-overlay')).toHaveCount(0, { timeout: 5000 })

  await expect.poll(() => exists(join(leftDir, 'made-by-modal')), { timeout: 5000 }).toBe(true)
})

test('the modal renders above the app chrome and traps Escape', async () => {
  // The overlay is appended to <body>; a view's own stacking context must not
  // be able to bury it. Reading the element at the centre of the viewport is
  // the only check that accounts for the whole z-index ladder at once.
  await openFolders()
  await pickFromRowMenu('made-by-modal', '重新命名…')
  await expect(win.locator('.mc-modal-overlay .mc-modal-input')).toBeVisible({ timeout: 5000 })

  const onTop = await win.evaluate(() => {
    const box = document.querySelector('.mc-modal-box')
    const r = box.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!box.contains(hit)
  })
  expect(onTop).toBe(true)

  await win.keyboard.press('Escape')
  await expect(win.locator('.mc-modal-overlay')).toHaveCount(0, { timeout: 5000 })
})
