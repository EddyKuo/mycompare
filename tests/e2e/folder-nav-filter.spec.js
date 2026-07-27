/**
 * Folder compare: archives beyond zip, navigation history, the four mask
 * fields, and deleting through the recycle bin.
 *
 * Each of these is a path a user actually walks — a toolbar button, a key, a
 * dialog — which is the part unit tests cannot vouch for. The archive case in
 * particular existed as a decoder, an IPC channel and a passing unit test for
 * a whole sprint while no UI ever called it.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm, access } from 'fs/promises'
import { gzipSync } from 'zlib'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let base

const exists = async (p) => {
  try { await access(p); return true } catch { return false }
}

test.beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'mycompare-fcnav-'))
  await mkdir(join(base, 'left', 'sub'), { recursive: true })
  await mkdir(join(base, 'right', 'sub'), { recursive: true })
  await writeFile(join(base, 'left', 'sub', 'a.txt'), 'left a\n', 'utf-8')
  await writeFile(join(base, 'left', 'sub', 'notes.log'), 'noise\n', 'utf-8')
  await writeFile(join(base, 'right', 'sub', 'a.txt'), 'right a\n', 'utf-8')
  await writeFile(join(base, 'left', 'top.txt'), 'top\n', 'utf-8')

  // A gzip member: not a zip, so it can only be read through the generic
  // read-archive route the folder view now uses.
  await writeFile(join(base, 'payload.txt.gz'), gzipSync(Buffer.from('hello from gzip\n')))

  ;({ app, win } = await launchApp([base]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(base, { recursive: true, force: true })
})

/** Replace the blocking native dialogs so a test can read what they said. */
async function captureDialogs(page, { confirmAnswer = true } = {}) {
  await page.evaluate((answer) => {
    const w = /** @type {any} */ (window)
    w.__alerts = []
    w.__confirms = []
    w.alert = (m) => { w.__alerts.push(String(m)) }
    w.confirm = (m) => { w.__confirms.push(String(m)); return answer }
  }, confirmAnswer)
}

const alertsOf = (page) => page.evaluate(() => /** @type {any} */ (window).__alerts ?? [])

/**
 * Wait for a summary message rather than reading the list once.
 *
 * The file disappears before the summary alert is raised, so polling on the
 * file and then reading alerts immediately is a race — which is how this spec
 * first turned up flaky.
 *
 * @param {import('@playwright/test').Page} page
 * @param {RegExp} expected
 */
const expectAlert = (page, expected) =>
  expect.poll(async () => (await alertsOf(page)).join(' | ')).toMatch(expected)

/** The panel is a toggle, so clicking blind closes it half the time. */
async function openFilterPanel(page) {
  const panel = page.locator('.fc-filter-panel')
  if (!(await panel.isVisible())) await page.locator('.fc-btn-filter').click()
  await expect(panel).toBeVisible()
}

async function openPair(page) {
  await page.evaluate(async (dir) => {
    await window.__testAPI.folderSetLeft(`${dir}`)
  }, join(base, 'left', 'sub'))
  await page.evaluate(async (dir) => {
    await window.__testAPI.folderSetRight(`${dir}`)
  }, join(base, 'right', 'sub'))
  await expect(page.locator('#view-folder')).toBeVisible()
}

// ── Archives beyond zip ─────────────────────────────────────────────────────

test('a gzip archive opens as a virtual folder（原本只有 zip 進得來）', async () => {
  await win.evaluate(
    (p) => window.__testAPI.openArchiveSide('left', p),
    join(base, 'payload.txt.gz'))

  const rows = await win.evaluate(() => window.__testAPI.folderRows())
  expect(rows.map((r) => r.name)).toContain('payload.txt')

  const label = await win.locator('.fc-path-display[data-side="left"]').textContent()
  expect(label).toContain('壓縮檔')
})

test('the archive button offers every supported format, not just Zip', async () => {
  const title = await win.locator('.fc-path-cell .fc-open-btn').nth(1).getAttribute('title')
  expect(title).toContain('7z')
  expect(title).toContain('tar')
  const text = await win.locator('.fc-path-cell .fc-open-btn').nth(1).textContent()
  expect(text).toContain('封存檔')
})

// ── Navigation ──────────────────────────────────────────────────────────────

test('Up One Level moves both sides and Back returns', async () => {
  await captureDialogs(win)
  await openPair(win)

  await win.locator('.fc-btn-nav[title^="上一層"]').click()
  await expect(win.locator('.fc-path-display[data-side="left"]'))
    .toHaveText(join(base, 'left'))
  await expect(win.locator('.fc-path-display[data-side="right"]'))
    .toHaveText(join(base, 'right'))
  // The parent listing is really loaded, not just the label swapped.
  await expect(win.locator('.fc-row[data-name="top.txt"]')).toHaveCount(1)

  await win.locator('.fc-btn-nav[title^="上一頁"]').click()
  await expect(win.locator('.fc-path-display[data-side="left"]'))
    .toHaveText(join(base, 'left', 'sub'))

  await win.locator('.fc-btn-nav[title^="下一頁"]').click()
  await expect(win.locator('.fc-path-display[data-side="left"]'))
    .toHaveText(join(base, 'left'))
})

test('Alt+↑ does the same as the Up button', async () => {
  await captureDialogs(win)
  await openPair(win)

  await win.locator('.fc-list').click()
  await win.keyboard.press('Alt+ArrowUp')
  await expect(win.locator('.fc-path-display[data-side="left"]'))
    .toHaveText(join(base, 'left'))
})

// ── Include / Exclude fields ────────────────────────────────────────────────

test('Exclude Files hides matching files and leaves folders alone', async () => {
  await captureDialogs(win)
  await openPair(win)
  await expect(win.locator('.fc-row[data-name="notes.log"]')).toHaveCount(1)

  await openFilterPanel(win)
  await win.locator('.fc-filter-input[data-field="excludeFiles"]').fill('*.log')
  await win.locator('.fc-filter-apply').click()

  await expect(win.locator('.fc-row[data-name="notes.log"]')).toHaveCount(0)
  await expect(win.locator('.fc-row[data-name="a.txt"]')).toHaveCount(1)

  await win.locator('.fc-filter-clear').click()
  await expect(win.locator('.fc-row[data-name="notes.log"]')).toHaveCount(1)
})

test('Exclude Folders hides a whole subtree', async () => {
  await captureDialogs(win)
  await win.evaluate(async (dir) => { await window.__testAPI.folderSetLeft(dir) },
    join(base, 'left'))

  await expect(win.locator('.fc-row[data-name="sub"]')).toHaveCount(1)
  await openFilterPanel(win)
  await win.locator('.fc-filter-input[data-field="excludeFolders"]').fill('sub')
  await win.locator('.fc-filter-apply').click()
  await expect(win.locator('.fc-row[data-name="sub"]')).toHaveCount(0)
  // A file mask must not have hidden the folder, and vice versa.
  await expect(win.locator('.fc-row[data-name="top.txt"]')).toHaveCount(1)

  await win.locator('.fc-filter-clear').click()
})

// ── Deleting ────────────────────────────────────────────────────────────────

test('deleting from the folder view goes to the recycle bin and says so', async () => {
  const victim = join(base, 'left', 'delete-me.txt')
  await writeFile(victim, 'bye\n', 'utf-8')

  await captureDialogs(win)
  await win.evaluate(async (dir) => { await window.__testAPI.folderSetLeft(dir) },
    join(base, 'left'))

  const row = win.locator('.fc-row[data-name="delete-me.txt"]')
  await expect(row).toHaveCount(1)
  await row.locator('.fc-row-cb').check()

  await win.locator('.fc-btn-batch').click()
  await win.locator('.fc-batch-item[data-action="delete-left"]').click()

  const modal = win.locator('.fc-modal')
  await expect(modal).toBeVisible()
  await expect(win.locator('.fc-del-permanent')).not.toBeChecked()
  await win.locator('.fc-modal-ok').click()

  await expect.poll(() => exists(victim)).toBe(false)
  await expectAlert(win, /已移至資源回收桶/)
})

test('the permanent checkbox is honoured and reported as permanent', async () => {
  const victim = join(base, 'left', 'burn-me.txt')
  await writeFile(victim, 'burn\n', 'utf-8')

  await captureDialogs(win)
  await win.evaluate(async (dir) => { await window.__testAPI.folderSetLeft(dir) },
    join(base, 'left'))

  const row = win.locator('.fc-row[data-name="burn-me.txt"]')
  await expect(row).toHaveCount(1)
  await row.locator('.fc-row-cb').check()

  await win.locator('.fc-btn-batch').click()
  await win.locator('.fc-batch-item[data-action="delete-left"]').click()
  await win.locator('.fc-del-permanent').check()
  await win.locator('.fc-modal-ok').click()

  await expect.poll(() => exists(victim)).toBe(false)
  await expectAlert(win, /已永久刪除/)
})

test('cancelling the delete dialog leaves the file alone', async () => {
  const survivor = join(base, 'left', 'keep-me.txt')
  await writeFile(survivor, 'keep\n', 'utf-8')

  await captureDialogs(win)
  await win.evaluate(async (dir) => { await window.__testAPI.folderSetLeft(dir) },
    join(base, 'left'))

  const row = win.locator('.fc-row[data-name="keep-me.txt"]')
  await expect(row).toHaveCount(1)
  await row.locator('.fc-row-cb').check()

  await win.locator('.fc-btn-batch').click()
  await win.locator('.fc-batch-item[data-action="delete-left"]').click()
  await win.locator('.fc-modal-cancel').click()

  await expect(win.locator('.fc-modal')).toHaveCount(0)
  expect(await exists(survivor)).toBe(true)
})
