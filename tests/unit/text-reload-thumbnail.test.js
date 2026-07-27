/**
 * @vitest-environment jsdom
 *
 * Two gaps the text view was the last one to have:
 *
 *  1. A manual reload from disk. The view relied entirely on the file watcher,
 *     which misses network drives and every editor that saves by writing a temp
 *     file and renaming it over the original. The dangerous half is the
 *     confirmation — a reload destroys unsaved edits exactly as closing would,
 *     so the "user says no" branch matters more than the happy path.
 *
 *  2. Showing/hiding the difference thumbnail, and making it precise enough to
 *     be worth the space: block grouping drew one clamped sliver per contiguous
 *     run, so an isolated change in a long file was invisible.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TextCompare } from '../../src/renderer/src/views/text-compare.js'

/** @type {TextCompare} */
let view
/** @type {Map<string, string>} what readFile will return per path */
let disk

/** The static DOM ids mount() reaches for. */
function buildDom() {
  document.body.innerHTML = `
    <div id="compare-area">
      <div id="pane-left"><div id="content-left"></div></div>
      <div id="splitter"><canvas id="tc-gutter-canvas"></canvas><div id="tc-gutter-overlay"></div></div>
      <div id="pane-right"><div id="content-right"></div></div>
      <div id="minimap"><div id="minimap-viewport"></div></div>
    </div>
    <div id="path-left"></div><div id="path-right"></div>
    <div id="diff-counter"></div><div id="status-message"></div>
    <div id="status-lines"></div><div id="status-encoding"></div><div id="status-eol"></div>
  `
}

beforeEach(() => {
  disk = new Map()
  buildDom()
  globalThis.window.electronAPI = {
    readFile: vi.fn(async (p) => {
      if (!disk.has(p)) throw new Error(`no such file: ${p}`)
      return { path: p, content: disk.get(p), encoding: 'UTF-8' }
    }),
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
    onFileChanged: vi.fn(() => () => {}),
  }
  vi.spyOn(window, 'confirm').mockReturnValue(true)

  view = new TextCompare()
  view.mount()
})

afterEach(() => {
  view?.destroy?.()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  delete globalThis.window.electronAPI
})

/** @param {string} path @param {string} text */
function loadLeft(path, text) {
  disk.set(path, text)
  view.setLeft(path, text)
}

/** @param {string} path @param {string} text */
function loadRight(path, text) {
  disk.set(path, text)
  view.setRight(path, text)
}

describe('reloadSide', () => {
  it('picks up a change another program made', async () => {
    loadLeft('/tmp/a.txt', 'one\n')
    disk.set('/tmp/a.txt', 'one\ntwo\n')

    expect(await view.reloadSide('left')).toBe(true)
    expect(view.getContent('left')).toBe('one\ntwo\n')
  })

  it('refuses a side with no path rather than silently doing nothing', async () => {
    expect(await view.reloadSide('right')).toBe(false)
  })

  it('keeps the old text when the read throws', async () => {
    loadLeft('/tmp/a.txt', 'keep me\n')
    disk.delete('/tmp/a.txt')

    expect(await view.reloadSide('left')).toBe(false)
    // A transient read error must not look like the file having been emptied.
    expect(view.getContent('left')).toBe('keep me\n')
  })

  it('keeps the old text when the read resolves without content', async () => {
    loadLeft('/tmp/a.txt', 'keep me\n')
    window.electronAPI.readFile = vi.fn(async () => null)

    expect(await view.reloadSide('left')).toBe(false)
    expect(view.getContent('left')).toBe('keep me\n')
  })

  it('asks before discarding unsaved edits, and honours a refusal', async () => {
    loadLeft('/tmp/a.txt', 'original\n')
    view._modified.left = true
    vi.mocked(window.confirm).mockReturnValue(false)
    disk.set('/tmp/a.txt', 'FROM DISK\n')

    expect(await view.reloadSide('left')).toBe(false)
    expect(window.confirm).toHaveBeenCalled()
    expect(view.getContent('left')).toBe('original\n')
    // Refusing must leave the tab still knowing it has unsaved work.
    expect(view._modified.left).toBe(true)
  })

  it('proceeds and clears the dirty flag when the user accepts', async () => {
    loadLeft('/tmp/a.txt', 'original\n')
    view._modified.left = true
    disk.set('/tmp/a.txt', 'FROM DISK\n')

    expect(await view.reloadSide('left')).toBe(true)
    expect(view.getContent('left')).toBe('FROM DISK\n')
    expect(view._modified.left).toBe(false)
  })

  it('does not prompt when there is nothing to lose', async () => {
    loadLeft('/tmp/a.txt', 'clean\n')
    await view.reloadSide('left')
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('reuses an encoding the user chose by hand instead of re-detecting', async () => {
    loadLeft('/tmp/a.txt', 'abc\n')
    await view.reloadWithEncoding('left', 'Big5')
    vi.mocked(window.electronAPI.readFile).mockClear()

    await view.reloadSide('left')
    expect(window.electronAPI.readFile).toHaveBeenCalledWith('/tmp/a.txt', 'Big5')
  })

  it('leaves detection alone when the user never overrode it', async () => {
    loadLeft('/tmp/a.txt', 'abc\n')
    vi.mocked(window.electronAPI.readFile).mockClear()

    await view.reloadSide('left')
    expect(window.electronAPI.readFile).toHaveBeenCalledWith('/tmp/a.txt')
  })
})

describe('reloadAll', () => {
  it('re-reads both sides', async () => {
    loadLeft('/tmp/a.txt', 'a1\n')
    loadRight('/tmp/b.txt', 'b1\n')
    disk.set('/tmp/a.txt', 'a2\n')
    disk.set('/tmp/b.txt', 'b2\n')

    expect(await view.reloadAll()).toBe(true)
    expect(view.getContent('left')).toBe('a2\n')
    expect(view.getContent('right')).toBe('b2\n')
  })

  it('asks once for both sides, not once each', async () => {
    loadLeft('/tmp/a.txt', 'a1\n')
    loadRight('/tmp/b.txt', 'b1\n')
    view._modified.left = true
    view._modified.right = true

    await view.reloadAll()
    expect(window.confirm).toHaveBeenCalledTimes(1)
  })

  it('reads nothing at all when the user refuses', async () => {
    loadLeft('/tmp/a.txt', 'a1\n')
    loadRight('/tmp/b.txt', 'b1\n')
    view._modified.right = true
    vi.mocked(window.confirm).mockReturnValue(false)
    disk.set('/tmp/a.txt', 'CHANGED\n')
    vi.mocked(window.electronAPI.readFile).mockClear()

    expect(await view.reloadAll()).toBe(false)
    expect(window.electronAPI.readFile).not.toHaveBeenCalled()
    expect(view.getContent('left')).toBe('a1\n')
  })

  it('says so rather than reporting success when no file is loaded', async () => {
    expect(await view.reloadAll()).toBe(false)
  })

  it('reloads the one side that has a path', async () => {
    loadLeft('/tmp/a.txt', 'a1\n')
    disk.set('/tmp/a.txt', 'a2\n')
    expect(await view.reloadAll()).toBe(true)
    expect(view.getContent('left')).toBe('a2\n')
  })
})

describe('thumbnail visibility', () => {
  it('is on by default, matching the behaviour before it could be turned off', () => {
    expect(view.isThumbnailVisible()).toBe(true)
    expect(document.getElementById('compare-area').classList.contains('hide-minimap')).toBe(false)
  })

  it('toggles the class the stylesheet keys off', () => {
    expect(view.toggleThumbnail()).toBe(false)
    expect(document.getElementById('compare-area').classList.contains('hide-minimap')).toBe(true)
    expect(view.toggleThumbnail()).toBe(true)
    expect(document.getElementById('compare-area').classList.contains('hide-minimap')).toBe(false)
  })

  it('paints no marks while hidden', () => {
    loadLeft('/tmp/a.txt', 'a\nb\nc\n')
    loadRight('/tmp/b.txt', 'a\nX\nc\n')
    expect(view.getMinimapBands().length).toBeGreaterThan(0)

    view.setThumbnailVisible(false)
    expect(view.getMinimapBands()).toEqual([])
    expect(document.querySelectorAll('#minimap .minimap-mark').length).toBe(0)
  })

  it('ignores a click while hidden instead of scrolling to NaN', () => {
    loadLeft('/tmp/a.txt', 'a\nb\n')
    loadRight('/tmp/b.txt', 'a\nX\n')
    view.setThumbnailVisible(false)
    const before = document.getElementById('content-left').scrollTop
    view._handleMinimapClick({ offsetY: 40 })
    expect(document.getElementById('content-left').scrollTop).toBe(before)
  })

  it('survives a round trip through getConfig/applyConfig', () => {
    view.setThumbnailVisible(false)
    const cfg = view.getConfig()
    expect(cfg.showThumbnail).toBe(false)

    view.setThumbnailVisible(true)
    view.applyConfig(cfg)
    expect(view.isThumbnailVisible()).toBe(false)
  })
})

describe('thumbnail precision', () => {
  /**
   * jsdom reports clientHeight 0, so the band count falls back to the 400px
   * default inside _buildMinimap — which is what a real strip is roughly worth.
   */
  it('separates two isolated changes far apart in a long file', () => {
    const n = 5000
    const left = Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')
    const rightLines = left.split('\n')
    rightLines[10] = 'CHANGED near the top'
    rightLines[4000] = 'CHANGED near the bottom'
    loadLeft('/tmp/a.txt', left)
    loadRight('/tmp/b.txt', rightLines.join('\n'))

    const bands = view.getMinimapBands()
    // Two separate marks, not one run merged across the whole strip.
    expect(bands.length).toBe(2)
    // And they sit at opposite ends of it, in proportion to where the changes
    // are — a 2px clamp on each would have said nothing about position.
    const last = bands[bands.length - 1]
    expect(last.start - bands[0].end).toBeGreaterThan(2)
  })

  it('ranks a replace above the inserts sharing its band', () => {
    // Two adjacent rows land in the same band once the file is long enough.
    const n = 4000
    const left = Array.from({ length: n }, (_, i) => `line ${i}`)
    const right = [...left]
    right[100] = 'replaced'
    right.splice(101, 0, 'inserted')
    loadLeft('/tmp/a.txt', left.join('\n'))
    loadRight('/tmp/b.txt', right.join('\n'))

    const bands = view.getMinimapBands()
    expect(bands.some((b) => b.type === 'replace')).toBe(true)
  })

  it('keeps the node count bounded on a file with tens of thousands of diffs', () => {
    // Every other line differs: block grouping would emit ~20k marks and the
    // naive per-line version 40k. The band cap has to hold it to the display.
    const n = 40000
    const left = []
    const right = []
    for (let i = 0; i < n; i++) {
      left.push(`line ${i}`)
      right.push(i % 2 === 0 ? `line ${i}` : `CHANGED ${i}`)
    }
    loadLeft('/tmp/a.txt', left.join('\n'))
    loadRight('/tmp/b.txt', right.join('\n'))

    const marks = document.querySelectorAll('#minimap .minimap-mark')
    expect(marks.length).toBeGreaterThan(0)
    expect(marks.length).toBeLessThanOrEqual(1000)
    expect(view.getMinimapBands().length).toBeLessThanOrEqual(1000)
  })
})

describe('entry points', () => {
  /** @returns {string[]} */
  function contextLabels() {
    /** @type {string[]} */
    const labels = []
    const target = document.getElementById('content-left')
    const ev = new window.MouseEvent('contextmenu', { bubbles: true })
    Object.defineProperty(ev, 'target', { value: target })
    view._handleContextMenu(ev, 'left')
    for (const el of document.querySelectorAll('.ctx-item')) {
      labels.push(el.textContent ?? '')
    }
    return labels
  }

  it('offers reload and the thumbnail toggle in the context menu', () => {
    loadLeft('/tmp/a.txt', 'a\n')
    const labels = contextLabels()
    expect(labels.some((l) => l.includes('從磁碟重新載入左側'))).toBe(true)
    expect(labels.some((l) => l.includes('從磁碟重新載入雙側'))).toBe(true)
    expect(labels.some((l) => l.includes('整檔差異縮圖'))).toBe(true)
  })

  it('names Ctrl+Shift+R on the both-sides item, matching the shared dispatch', () => {
    loadLeft('/tmp/a.txt', 'a\n')
    const labels = contextLabels()
    expect(labels.find((l) => l.includes('從磁碟重新載入雙側'))).toContain('Ctrl+Shift+R')
  })

  it('no longer fires the replacements dialog on Ctrl+Shift+R', () => {
    const spy = vi.spyOn(view, 'openReplacementsDialog').mockImplementation(() => {})
    view._handleTextGapKey(new window.KeyboardEvent('keydown', { key: 'R', ctrlKey: true, shiftKey: true }))
    expect(spy).not.toHaveBeenCalled()
    view._handleTextGapKey(new window.KeyboardEvent('keydown', { key: 'R', ctrlKey: true, altKey: true }))
    expect(spy).toHaveBeenCalled()
  })
})
