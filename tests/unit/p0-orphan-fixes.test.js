/**
 * @vitest-environment jsdom
 *
 * The last two capabilities the audit found with no way to reach them.
 *
 * Text compare was the only view without an "show in Explorer" entry, and
 * image compare was the only one without Swap. Both were reported by an audit
 * rather than by a user, which is the whole problem with this class of gap:
 * nothing fails, the feature simply is not there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TextCompare } from '../../src/renderer/src/views/text-compare.js'
import { ImageCompare } from '../../src/renderer/src/views/image-compare.js'

/** Captures what the view passes to showContextMenu. */
const menuCalls = []
vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: (_e, items) => { menuCalls.push(items) },
  closeContextMenu: () => {},
}))

beforeEach(() => {
  menuCalls.length = 0
  document.body.innerHTML = ''
  window.electronAPI = {
    showInExplorer: vi.fn().mockResolvedValue(undefined),
    openWith: vi.fn().mockResolvedValue({ opened: true }),
    readFile: vi.fn(),
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
    onFileChanged: vi.fn(),
  }
})

/** A text view with both sides loaded, without needing index.html. */
function makeText(leftPath = 'C:/tmp/a.txt', rightPath = 'C:/tmp/b.txt') {
  const tc = new TextCompare()
  tc._mounted = true
  const l = document.createElement('div')
  const r = document.createElement('div')
  document.body.append(l, r)
  tc._contentLeft = l
  tc._contentRight = r
  tc._compareArea = document.createElement('div')
  tc.setLeft(leftPath, 'one\ntwo\n')
  tc.setRight(rightPath, 'one\nthree\n')
  return tc
}

describe('text compare — reveal in Explorer', () => {
  it('offers the entry for a real file', () => {
    const tc = makeText()
    tc._handleContextMenu(new MouseEvent('contextmenu'), 'left')
    const labels = (menuCalls.at(-1) ?? []).map((i) => i.label)
    expect(labels).toContain('在檔案總管中顯示')
    expect(labels).toContain('以預設程式開啟')
  })

  it('withholds it for an archive entry, which has no folder to open', () => {
    // The path validator refuses `::` paths, so an entry here would be a menu
    // item that can only produce an error.
    const tc = makeText('C:/tmp/pack.zip::inner/a.txt')
    tc._handleContextMenu(new MouseEvent('contextmenu'), 'left')
    expect((menuCalls.at(-1) ?? []).map((i) => i.label))
      .not.toContain('在檔案總管中顯示')
  })

  it('withholds it for a remote or snapshot path', () => {
    for (const p of ['remote://p1/a.txt', 'snapshot://a.txt', 'patch://x']) {
      menuCalls.length = 0
      const tc = makeText(p)
      tc._handleContextMenu(new MouseEvent('contextmenu'), 'left')
      expect((menuCalls.at(-1) ?? []).map((i) => i.label), p)
        .not.toContain('在檔案總管中顯示')
    }
  })

  it('calls the IPC when the entry is chosen', async () => {
    const tc = makeText()
    tc._handleContextMenu(new MouseEvent('contextmenu'), 'left')
    const entry = (menuCalls.at(-1) ?? []).find((i) => i.label === '在檔案總管中顯示')
    entry.action()
    await Promise.resolve()
    expect(window.electronAPI.showInExplorer).toHaveBeenCalledWith('C:/tmp/a.txt')
  })
})

describe('image compare — swap', () => {
  /** An image view with its canvases stubbed; jsdom has no 2d context. */
  function makeImage() {
    const ic = new ImageCompare({})
    ic._dom = {
      canvasLeft: document.createElement('canvas'),
      canvasRight: document.createElement('canvas'),
      dispLeft: document.createElement('span'),
      dispRight: document.createElement('span'),
      sizeLeft: document.createElement('span'),
      sizeRight: document.createElement('span'),
    }
    ic._leftCtx = { clearRect: vi.fn() }
    ic._rightCtx = { clearRect: vi.fn() }
    ic._drawImage = vi.fn()
    ic._runDiff = vi.fn().mockResolvedValue(undefined)
    return ic
  }

  const img = (w, h) => ({ naturalWidth: w, naturalHeight: h })

  it('exchanges the two sides', async () => {
    const ic = makeImage()
    ic._left = { path: 'L.png', ext: 'png', img: img(10, 10), bytes: 1, depth: null }
    ic._right = { path: 'R.png', ext: 'png', img: img(20, 20), bytes: 2, depth: null }

    await ic.swap()

    expect(ic._left.path).toBe('R.png')
    expect(ic._right.path).toBe('L.png')
  })

  it('re-runs the comparison, since the diff is direction-dependent', async () => {
    const ic = makeImage()
    ic._left = { path: 'L.png', ext: 'png', img: img(10, 10), bytes: 1, depth: null }
    ic._right = { path: 'R.png', ext: 'png', img: img(20, 20), bytes: 2, depth: null }
    await ic.swap()
    expect(ic._runDiff).toHaveBeenCalled()
  })

  it('clears the pane left empty when only one image is loaded', async () => {
    // Without this the canvas keeps painting the image that just moved across.
    const ic = makeImage()
    ic._left = { path: 'L.png', ext: 'png', img: img(10, 10), bytes: 1, depth: null }
    ic._right = null

    await ic.swap()

    expect(ic._left).toBeNull()
    expect(ic._right.path).toBe('L.png')
    expect(ic._leftCtx.clearRect).toHaveBeenCalled()
  })

  it('says so rather than throwing when there is nothing to swap', async () => {
    const ic = makeImage()
    const status = []
    ic.on('status', (p) => status.push(p))
    await ic.swap()
    expect(status.some((s) => s.level === 'warn')).toBe(true)
  })

  it('reports the swapped paths so the tab and session record follow', async () => {
    const ic = makeImage()
    ic._left = { path: 'L.png', ext: 'png', img: img(10, 10), bytes: 1, depth: null }
    ic._right = { path: 'R.png', ext: 'png', img: img(20, 20), bytes: 2, depth: null }
    const seen = []
    ic.on('paths-changed', (p) => seen.push(p))
    await ic.swap()
    expect(seen.at(-1)).toEqual({ left: 'R.png', right: 'L.png' })
  })
})
