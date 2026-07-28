/**
 * @vitest-environment jsdom
 *
 * BC's View ▸ Webpages: show two HTML files as rendered pages.
 *
 * The interesting half is not the rendering, it is what the rendered document
 * is allowed to do. A compared file is somebody else's HTML, and an ordinary
 * page pulls in remote images, fonts, stylesheets and trackers. Rendering one
 * naively would tell a third party that this file was opened — which a local
 * diff tool has no business doing — and, worse, would run whatever script the
 * file contains inside the application's own window.
 *
 * So the wrapper and the sandbox are what these tests are mostly about.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TextCompare } from '../../src/renderer/src/views/text-compare.js'

vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: () => {},
}))

const PAGE = '<!doctype html><html><head><title>t</title></head><body><h1>hi</h1></body></html>'

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = `
    <button id="btn-webpage-toggle"></button>
    <div class="compare-area" id="compare-area">
      <div class="pane" id="pane-left"><div class="pane-content" id="content-left"></div></div>
      <div class="pane" id="pane-right"><div class="pane-content" id="content-right"></div></div>
      <div class="minimap" id="minimap"><div id="minimap-viewport"></div></div>
    </div>`
  // jsdom has no object URLs.
  let n = 0
  globalThis.URL.createObjectURL = () => `blob:mock/${++n}`
  globalThis.URL.revokeObjectURL = () => {}
})

afterEach(() => { document.body.innerHTML = '' })

/** @returns {TextCompare} */
function makeTC() {
  const tc = new TextCompare()
  tc._mounted = true
  tc._compareArea = document.getElementById('compare-area')
  tc._contentLeft = document.getElementById('content-left')
  tc._contentRight = document.getElementById('content-right')
  tc._minimap = document.getElementById('minimap')
  tc._minimapViewport = document.getElementById('minimap-viewport')
  tc._btnWebpage = document.getElementById('btn-webpage-toggle')
  for (const el of [tc._contentLeft, tc._contentRight]) {
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
  }
  return tc
}

describe('the injected policy', () => {
  const wrap = TextCompare.wrapWebpageHtml

  it('blocks everything by default', () => {
    expect(wrap(PAGE)).toMatch(/default-src 'none'/)
  })

  it('permits no remote origin of any kind', () => {
    // The failure this guards: opening a file quietly fetching from a server.
    const out = wrap('<img src="https://tracker.example/pixel.gif">')
    expect(out).not.toMatch(/img-src[^"]*https?:/)
    expect(out).not.toMatch(/default-src[^"]*\*/)
    // data: images are allowed so a self-contained page still renders.
    expect(out).toMatch(/img-src data:/)
  })

  it('never allows script, in the policy or otherwise', () => {
    const out = wrap('<script>fetch("https://x")</script>')
    expect(out).not.toMatch(/script-src/)
    expect(out).toMatch(/default-src 'none'/)
  })

  it('puts the policy first inside an existing head', () => {
    // A meta after a <link> would not govern that link.
    const out = wrap('<html><head><link rel="stylesheet" href="http://x/a.css"></head></html>')
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<link'))
  })

  it('builds a document around a fragment that has no head', () => {
    const out = wrap('<p>just a fragment</p>')
    expect(out).toMatch(/^<!doctype html>/i)
    expect(out).toContain('Content-Security-Policy')
    expect(out).toContain('just a fragment')
  })

  it('handles empty and non-string input without throwing', () => {
    expect(() => wrap('')).not.toThrow()
    expect(() => wrap(null)).not.toThrow()
    expect(wrap(null)).toContain('Content-Security-Policy')
  })
})

describe('when the toggle is available', () => {
  it('offers itself for markup', () => {
    const tc = makeTC()
    tc.setLeft('/a.html', PAGE, 'UTF-8')
    expect(tc.canRenderWebpage()).toBe(true)
  })

  it('stays unavailable for prose, where it would only remove the diff colours', () => {
    const tc = makeTC()
    tc.setLeft('/a.txt', 'just some words\nand more words\n', 'UTF-8')
    tc.setRight('/b.txt', 'other words\n', 'UTF-8')
    expect(tc.canRenderWebpage()).toBe(false)
    expect(tc.setWebpageMode(true)).toBe(false)
  })

  it('sniffs the content rather than trusting the extension', () => {
    // A .txt holding a page is still a page.
    const tc = makeTC()
    tc.setLeft('/a.txt', PAGE, 'UTF-8')
    expect(tc.canRenderWebpage()).toBe(true)
  })
})

describe('the frames it creates', () => {
  it('sandboxes them with no script and no same-origin', () => {
    // Belt and braces with the policy above: either alone would be enough,
    // and a document running script in this window is the one failure that
    // would actually matter.
    const tc = makeTC()
    tc.setLeft('/a.html', PAGE, 'UTF-8')
    tc.setRight('/b.html', PAGE, 'UTF-8')
    tc.setWebpageMode(true)

    const frames = document.querySelectorAll('.tc-webpage-frame')
    expect(frames.length).toBe(2)
    for (const f of frames) {
      expect(f.getAttribute('sandbox')).toBe('')
      expect(f.getAttribute('sandbox')).not.toContain('allow-scripts')
      expect(f.getAttribute('sandbox')).not.toContain('allow-same-origin')
      expect(f.getAttribute('referrerpolicy')).toBe('no-referrer')
    }
  })

  it('hides the source view rather than destroying it', () => {
    const tc = makeTC()
    tc.setLeft('/a.html', PAGE, 'UTF-8')
    tc.setWebpageMode(true)
    expect(document.getElementById('content-left').style.display).toBe('none')

    tc.setWebpageMode(false)
    expect(document.getElementById('content-left').style.display).toBe('')
    expect(document.querySelectorAll('.tc-webpage-frame').length).toBe(0)
  })

  it('releases its blob URLs when switched off', () => {
    const revoked = []
    globalThis.URL.revokeObjectURL = (u) => revoked.push(u)
    const tc = makeTC()
    tc.setLeft('/a.html', PAGE, 'UTF-8')
    tc.setRight('/b.html', PAGE, 'UTF-8')
    tc.setWebpageMode(true)
    tc.setWebpageMode(false)
    // Two frames were made, so two URLs must come back.
    expect(revoked.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to source when the content stops being markup', () => {
    // Otherwise the panes are left showing two blank frames.
    const tc = makeTC()
    tc.setLeft('/a.html', PAGE, 'UTF-8')
    tc.setWebpageMode(true)
    expect(tc.isWebpageMode()).toBe(true)

    tc.setLeft('/a.txt', 'plain words only\n', 'UTF-8')
    tc.setRight('/b.txt', 'plain words only too\n', 'UTF-8')
    expect(tc.isWebpageMode()).toBe(false)
    expect(document.querySelectorAll('.tc-webpage-frame').length).toBe(0)
  })
})

describe('config round trip', () => {
  it('carries the mode', () => {
    const tc = makeTC()
    tc.setLeft('/a.html', PAGE, 'UTF-8')
    tc.setWebpageMode(true)
    expect(tc.getConfig().webpageMode).toBe(true)
  })

  it('a stored true does not force the mode onto plain text', () => {
    // The saved setting is a preference, not an instruction to render prose
    // as a blank document.
    const tc = makeTC()
    tc.setLeft('/a.txt', 'nothing but words\n', 'UTF-8')
    tc.applyConfig({ __type: 'text', webpageMode: true })
    expect(tc.isWebpageMode()).toBe(false)
  })
})
