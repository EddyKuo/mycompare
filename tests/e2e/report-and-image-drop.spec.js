/**
 * The report dialog (save / copy to clipboard) and image drag-and-drop.
 *
 * Reports could previously only be written to a file, and only from the text
 * and folder views; image had no report at all and accepted no drops. Both
 * gaps are only visible from the outside, which is what these tests drive.
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

test.beforeAll(async () => { ({ app, win } = await launchApp()) })
test.afterAll(async () => { await closeApp(app) })

/** @param {import('@playwright/test').Page} page */
async function goToImageCompare(page) {
  const viewImage = page.locator('#view-image')
  if (await viewImage.isVisible()) return
  await page.locator('#btn-new-session').click()
  await expect(page.locator('#session-home')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-type="image"].session-type-btn').click()
  await expect(viewImage).toBeVisible({ timeout: 5000 })
}

/** Build a solid-colour PNG in the renderer and return its base64 payload. */
async function makePng(page, w, h, css) {
  return page.evaluate(([width, height, colour]) => {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    ctx.fillStyle = colour
    ctx.fillRect(0, 0, width, height)
    return c.toDataURL('image/png').split(',')[1]
  }, [w, h, css])
}

async function loadTwoImages(page) {
  await goToImageCompare(page)
  const black = await makePng(page, 16, 16, '#000000')
  const white = await makePng(page, 16, 16, '#ffffff')
  await page.evaluate(async ([l, r]) => {
    await window.__testAPI?.imageSetLeft('left.png', l, 'png')
    await window.__testAPI?.imageSetRight('right.png', r, 'png')
  }, [black, white])
  await page.waitForFunction(
    () => (window.__testAPI?.imageGetStats() ?? '').length > 0,
    { timeout: 5000 })
}

/**
 * Replace clipboard writing with a recorder.
 *
 * Reading the real clipboard needs a permission this app never asks for, and
 * the assertion is about what the app tried to put there.
 */
async function captureClipboard(page) {
  await page.evaluate(() => {
    window.__clipboardCalls = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => { window.__clipboardCalls.push(text) },
      },
    })
  })
}

test('the report dialog opens for the image view, which previously had none', async () => {
  await loadTwoImages(win)
  await expect(win.locator('#btn-export')).toBeEnabled()
  await win.locator('#btn-export').click()
  await expect(win.locator('#report-modal')).toBeVisible()
  await expect(win.locator('#report-modal-view')).toContainText('圖片比對')
  await expect(win.locator('#btn-report-copy-text')).toBeEnabled()
  await expect(win.locator('#btn-report-copy-html')).toBeEnabled()
  await win.locator('#btn-report-modal-cancel').click()
  await expect(win.locator('#report-modal')).toBeHidden()
})

test('copying the plain-text report puts the real report on the clipboard', async () => {
  await loadTwoImages(win)
  await captureClipboard(win)

  await win.locator('#btn-export').click()
  await win.locator('#btn-report-copy-text').click()
  await expect(win.locator('#report-modal-status')).toContainText('已複製')

  const [copied] = await win.evaluate(() => window.__clipboardCalls)
  expect(copied).toContain('圖片比對報告')
  expect(copied).toContain('left.png')
  // 16x16 all-differing pixels; the report must agree with the status bar.
  expect(copied).toContain('256')
  await win.locator('#btn-report-modal-cancel').click()
})

test('copying the HTML report embeds both images', async () => {
  await loadTwoImages(win)
  await captureClipboard(win)

  await win.locator('#btn-export').click()
  await win.locator('#btn-report-copy-html').click()

  const [copied] = await win.evaluate(() => window.__clipboardCalls)
  expect(copied).toContain('<title>圖片比對報告</title>')
  expect(copied).toContain('src="data:image/png;base64,')
  await win.locator('#btn-report-modal-cancel').click()
})

test('a clipboard failure is reported, not swallowed', async () => {
  await loadTwoImages(win)
  await win.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('剪貼簿被拒') } },
    })
  })

  await win.locator('#btn-export').click()
  await win.locator('#btn-report-copy-text').click()
  await expect(win.locator('#report-modal-status')).toContainText('剪貼簿被拒')
  await win.locator('#btn-report-modal-cancel').click()
})

test('dragging over an image pane marks it as the drop target', async () => {
  await goToImageCompare(win)
  await win.evaluate(() => {
    const pane = document.querySelector('.ic-canvas-left')
    pane?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }))
  })
  await expect(win.locator('.ic-canvas-left')).toHaveClass(/ic-drop-target/)

  await win.evaluate(() => {
    const pane = document.querySelector('.ic-canvas-left')
    pane?.dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
  })
  await expect(win.locator('.ic-canvas-left')).not.toHaveClass(/ic-drop-target/)
})

test('a drop on an image pane goes through the main process for authorisation', async () => {
  await goToImageCompare(win)

  // A File the page builds has no path behind it, so preload resolves nothing
  // and the view has to say so. That the renderer cannot name its own path is
  // the point of routing the File objects through preload.
  await win.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'C:\\nowhere\\forged.png', { type: 'image/png' }))
    const pane = document.querySelector('.ic-canvas-left')
    pane?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })

  await expect(win.locator('#status-message')).toContainText('路徑', { timeout: 5000 })
})
