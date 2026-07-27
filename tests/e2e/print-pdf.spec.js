/**
 * PDF export, through the real printToPDF.
 *
 * This cannot be unit tested in any useful way: the whole point is that
 * Chromium renders the report and stamps page numbers into a footer template,
 * and a mock of `printToPDF` would be testing the mock. What is checked here
 * is that a real PDF comes out, that it has more than one page when the report
 * is long, and that a cancelled dialog leaves no file behind.
 */
import { test, expect } from '@playwright/test'
import { readFile, mkdtemp, rm, access } from 'fs/promises'
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
  dir = await mkdtemp(join(tmpdir(), 'mycompare-pdf-'))
  ;({ app, win } = await launchApp([dir]))
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(dir, { recursive: true, force: true })
})

/**
 * Point the save dialog at a fixed path instead of showing it.
 * @param {string | null} target null to simulate the user cancelling
 */
async function stubSaveDialog(target) {
  await app.evaluate(async ({ dialog }, t) => {
    dialog.showSaveDialog = async () =>
      (t === null ? { canceled: true, filePath: '' } : { canceled: false, filePath: t })
  }, target)
}

/** A report tall enough to need more than one page. */
function longReport(rows) {
  const body = Array.from({ length: rows }, (_, i) =>
    `<tr><td>${i}</td><td>left line ${i}</td><td>right line ${i}</td></tr>`).join('')
  return `<html><head><title>報告</title></head><body>
    <h1>比對報告</h1><table>${body}</table></body></html>`
}

test('produces a real PDF at the chosen path', async () => {
  const out = join(dir, 'report.pdf')
  await stubSaveDialog(out)

  const res = await win.evaluate(
    ([html, name]) => window.electronAPI.printToPdf(html, name),
    [longReport(20), 'report.pdf'])

  expect(res.saved).toBe(true)
  expect(res.path).toBe(out)

  const buf = await readFile(out)
  // A PDF, not an HTML file with a .pdf name — the signature is the cheapest
  // way to catch the handler writing the wrong buffer.
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  expect(buf.length).toBeGreaterThan(1000)
})

test('a long report really does span several pages', async () => {
  // Page numbers are the reason this path exists at all; a footer reading
  // "1 / 1" on a 2000-row report would mean pagination never happened.
  const out = join(dir, 'long.pdf')
  await stubSaveDialog(out)

  const res = await win.evaluate(
    ([html, name]) => window.electronAPI.printToPdf(html, name),
    [longReport(2000), 'long.pdf'])
  expect(res.saved).toBe(true)

  const buf = await readFile(out)
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  expect(pages).toBeGreaterThan(1)
})

test('cancelling writes nothing and says so', async () => {
  await stubSaveDialog(null)
  const res = await win.evaluate(
    (html) => window.electronAPI.printToPdf(html, 'never.pdf'), longReport(5))

  expect(res.saved).toBe(false)
  await expect(access(join(dir, 'never.pdf'))).rejects.toThrow()
})

test('empty content is refused rather than writing a blank file', async () => {
  await stubSaveDialog(join(dir, 'empty.pdf'))
  const outcome = await win.evaluate(async () => {
    try {
      await window.electronAPI.printToPdf('', 'empty.pdf')
      return 'accepted'
    } catch (err) {
      return String(err?.message ?? err)
    }
  })
  expect(outcome).not.toBe('accepted')
  await expect(access(join(dir, 'empty.pdf'))).rejects.toThrow()
})

test('a failed export leaves no offscreen window behind', async () => {
  // The worker window and the temp file are cleaned up in a finally block;
  // without it every failed export would leak one of each.
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

  await stubSaveDialog(join(dir, 'ok.pdf'))
  await win.evaluate((html) => window.electronAPI.printToPdf(html, 'ok.pdf'), longReport(10))

  const after = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  expect(after).toBe(before)
})
