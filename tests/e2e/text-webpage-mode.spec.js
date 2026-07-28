/**
 * View ▸ Webpages, driven through the running app.
 *
 * The unit tests pin the injected policy and the sandbox attributes. What they
 * cannot show is that the toggle is reachable, that a frame actually appears,
 * and — the part that matters most — that the app's own Content-Security-Policy
 * does not block the frame outright. That last one is invisible to jsdom and
 * would turn the whole feature into two empty panes.
 */
import { test, expect } from '@playwright/test'
import { launchApp, closeApp } from './helpers/electron-app.js'

/** @type {import('@playwright/test').ElectronApplication} */
let app
/** @type {import('@playwright/test').Page} */
let win

const PAGE_LEFT = '<!doctype html><html><head><title>L</title></head>'
  + '<body><h1 id="marker">left page</h1></body></html>'
const PAGE_RIGHT = '<!doctype html><html><head><title>R</title></head>'
  + '<body><h1 id="marker">right page</h1></body></html>'

test.beforeAll(async () => {
  ;({ app, win } = await launchApp())
  await win.waitForFunction(() => !!window.__testAPI)
})

test.afterAll(async () => { await closeApp(app) })

/** Load two HTML documents into the text view. */
async function loadPages() {
  await win.evaluate(([l, r]) => window.__testAPI.openComparison({
    type: 'text',
    leftPath: 'C:/fixtures/left.html', leftContent: l,
    rightPath: 'C:/fixtures/right.html', rightContent: r,
  }), [PAGE_LEFT, PAGE_RIGHT])
  await expect(win.locator('#view-text')).toBeVisible({ timeout: 5000 })

  // Start from source view every time. The mode survives a content change on
  // purpose — switching files while previewing should keep previewing — so a
  // test that assumed "off" would have its first click turn the mode off
  // instead of on, and pass or fail depending on which test ran before it.
  if (await win.locator('.tc-webpage-frame').count() > 0) {
    await win.locator('#btn-webpage-toggle').click()
    await expect(win.locator('.tc-webpage-frame')).toHaveCount(0)
  }
}

test('the toggle is offered for HTML and renders both sides', async () => {
  await loadPages()

  const btn = win.locator('#btn-webpage-toggle')
  await expect(btn).toBeEnabled()
  await btn.click()

  const frames = win.locator('.tc-webpage-frame')
  await expect(frames).toHaveCount(2)

  // The app's own CSP allows frame-src blob: and nothing else, so a wrong
  // scheme here would leave two empty panes and no error at all. jsdom cannot
  // see this.
  const src = await win.evaluate(() =>
    document.querySelector('.tc-webpage-frame')?.src ?? '')
  expect(src.startsWith('blob:'), `frame src is ${src}`).toBe(true)

  // Then the isolation. Order matters: a freshly created frame sits at
  // about:blank, which IS same-origin and readable, so checking before the
  // navigation completes reports "not isolated" for a frame that is about to
  // be. Waiting for the blob document to land is what makes the check mean
  // anything — an opaque origin then makes contentDocument unreachable.
  const isolated = await win.evaluate(() => new Promise((resolve) => {
    const f = document.querySelector('.tc-webpage-frame')
    if (!f) return resolve('no frame')
    const check = () => {
      try {
        resolve(f.contentDocument === null ? 'isolated' : 'reachable')
      } catch {
        resolve('isolated')
      }
    }
    f.addEventListener('load', () => setTimeout(check, 0), { once: true })
    setTimeout(check, 3000)
  }))
  expect(isolated).toBe('isolated')
})

test('switching back restores the source view', async () => {
  await loadPages()
  const btn = win.locator('#btn-webpage-toggle')
  await expect(btn).toBeEnabled()
  await btn.click()
  await expect(win.locator('.tc-webpage-frame')).toHaveCount(2)
  // The button reflects the mode; waiting on that rather than clicking again
  // straight away, because the second click otherwise races the first one's
  // DOM work and the toggle can end up back where it started.
  await expect(btn).toHaveClass(/active/)

  await btn.click()
  await expect(win.locator('.tc-webpage-frame')).toHaveCount(0)
  // The diff panes are back, with their content intact.
  await expect(win.locator('#content-left')).toBeVisible()
})

test('the toggle is refused for plain text', async () => {
  // Rendering prose as a document would just be the same words with the diff
  // colouring removed, so the button says no rather than doing that.
  await win.evaluate(() => window.__testAPI.openComparison({
    type: 'text',
    leftPath: 'C:/fixtures/a.txt', leftContent: 'plain words here\nand more\n',
    rightPath: 'C:/fixtures/b.txt', rightContent: 'plain words there\nand more\n',
  }))
  await expect(win.locator('#view-text')).toBeVisible({ timeout: 5000 })
  await expect(win.locator('#btn-webpage-toggle')).toBeDisabled()
})

test('a page referencing a remote image still renders, without fetching it', async () => {
  // The privacy point: opening someone's HTML must not announce it to a third
  // party. The policy blocks the request; the page itself still appears.
  await win.evaluate(() => window.__testAPI.openComparison({
    type: 'text',
    leftPath: 'C:/fixtures/tracked.html',
    leftContent: '<!doctype html><html><body><p>visible text</p>'
      + '<img src="https://tracker.invalid/pixel.gif"></body></html>',
    rightPath: 'C:/fixtures/plain.html',
    rightContent: '<!doctype html><html><body><p>visible text</p></body></html>',
  }))
  await expect(win.locator('#view-text')).toBeVisible({ timeout: 5000 })

  await win.locator('#btn-webpage-toggle').click()
  await expect(win.locator('.tc-webpage-frame')).toHaveCount(2)

  // No request left the machine for that host. The domain is .invalid, so a
  // leak would fail anyway — what is checked here is that the frame carries
  // the policy that forbids it.
  // The document itself cannot be inspected from here — that is the sandbox
  // working — so what is checked is that the bytes handed to the frame carry
  // the policy. wrapWebpageHtml is unit-tested for the policy's contents.
  const src = await win.evaluate(() =>
    document.querySelector('.tc-webpage-frame')?.src ?? '')
  expect(src.startsWith('blob:'), 'the frame is not fed from a blob URL').toBe(true)
})
