/**
 * Drag & drop in the hex, table and three-way merge views.
 *
 * A test cannot fabricate a File the browser will hand a real path for — that
 * is the security property, not a limitation to work around. So these tests
 * assert two things end to end: the panes really are wired as drop targets in
 * the built app, and a File the page constructs authorises nothing, no matter
 * which pane it is dropped on.
 */
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win
/** @type {string} */
let unopened

/**
 * Panes that must accept a drop, per view. The class is the highlight the view
 * adds while a drag is over the pane.
 */
const VIEWS = [
  { type: 'hex', view: '#view-hex', dragClass: 'hx-drop-target', panes: ['.hx-pane[data-side="left"]', '.hx-pane[data-side="right"]'] },
  { type: 'table', view: '#view-table', dragClass: 'tc-drop-target', panes: ['#view-table .tc-pane:nth-of-type(1)', '#view-table .tc-pane:nth-of-type(2)'] },
  { type: 'merge3', view: '#view-merge3', dragClass: 'mw-drop-target', panes: ['.mw-pane--left', '.mw-pane--base', '.mw-pane--right'] },
]

test.beforeAll(async () => {
  // Never passed on the command line, so it stays outside every allowed root.
  unopened = await mkdtemp(join(tmpdir(), 'mycompare-drop-'))
  await writeFile(join(unopened, 'secret.txt'), 'not yours\n', 'utf-8')
  ;({ app, win } = await launchApp())
})

test.afterAll(async () => {
  await closeApp(app)
  await rm(unopened, { recursive: true, force: true })
})

/**
 * @param {string} type
 * @param {string} viewSelector
 */
async function openView(type, viewSelector) {
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.locator(`[data-type="${type}"].session-type-btn`).click()
  await expect(win.locator(viewSelector)).toBeVisible({ timeout: 5000 })
}

for (const { type, view, dragClass, panes } of VIEWS) {
  test(`${type}: every input pane highlights while a file is dragged over it`, async () => {
    await openView(type, view)

    for (const pane of panes) {
      const node = win.locator(pane).first()
      await expect(node).toBeVisible()

      const highlighted = await node.evaluate((el, cls) => {
        const event = new Event('dragover', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'dataTransfer', { value: { files: [], dropEffect: 'none' } })
        el.dispatchEvent(event)
        const on = el.classList.contains(cls)
        const cancelled = event.defaultPrevented
        el.dispatchEvent(new Event('dragleave', { bubbles: true }))
        return { on, cancelled, off: !el.classList.contains(cls) }
      }, dragClass)

      expect(highlighted).toEqual({ on: true, cancelled: true, off: true })
    }
  })

  test(`${type}: a page-constructed File authorises nothing`, async () => {
    await openView(type, view)

    const outcome = await win.locator(panes[0]).first().evaluate(async (el, secret) => {
      const forged = new File(['x'], secret)
      // What the drop handler passes on: the File itself. preload resolves it
      // with webUtils.getPathForFile, which has nothing to say about a File the
      // page made up — so no root is registered and no read is authorised.
      const entries = await window.electronAPI.acceptDroppedFiles([forged])

      const event = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: { files: [forged], dropEffect: 'copy' } })
      el.dispatchEvent(event)

      let read = 'refused'
      try {
        await window.electronAPI.readFile(secret)
        read = 'allowed'
      } catch { /* expected */ }
      return { entries, read }
    }, join(unopened, 'secret.txt'))

    expect(outcome.entries).toEqual([])
    expect(outcome.read).toBe('refused')
  })
}

test('a drop that resolves no path leaves the merge view empty', async () => {
  await openView('merge3', '#view-merge3')

  const rows = await win.locator('.mw-pane--base').evaluate(async (el) => {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    const forged = new File(['x'], 'nowhere.txt')
    Object.defineProperty(event, 'dataTransfer', { value: { files: [forged], dropEffect: 'copy' } })
    el.dispatchEvent(event)
    await new Promise((r) => setTimeout(r, 200))
    return el.querySelectorAll('.mw-line').length
  })

  expect(rows).toBe(0)
})
