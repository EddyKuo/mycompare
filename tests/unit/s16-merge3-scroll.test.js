/**
 * @vitest-environment jsdom
 *
 * Sprint 16 — 3-Way Merge virtual scrolling, instance isolation and the
 * getConfig / applyConfig contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ThreeWayCompare,
  computeVisibleRange,
  conflictPaneRow,
  diffToPaneRows,
  buildPaneRows,
} from '../../src/renderer/src/views/three-way-compare.js'
import { SettingsStore } from '../../src/renderer/src/core/settings-store.js'

const ROW_HEIGHT = 18

/**
 * A file large enough that rendering every row would be the bug under test.
 * @param {number} n
 * @param {number[]} [changedAt]
 * @param {string} [tag]
 */
function bigText(n, changedAt = [], tag = '') {
  return Array.from({ length: n }, (_, i) =>
    (changedAt.includes(i) ? `${tag}${i}` : `line${i}`)).join('\n')
}

/**
 * Mount into document.body — instance isolation is exactly what these tests
 * are about, so keeping hosts detached would hide the failure mode.
 *
 * @param {{ left?: string, base?: string, right?: string }} [contents]
 */
function mountView(contents = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new ThreeWayCompare()
  view.mount(host)
  view.setSide('base', contents.base ?? 'a\nb\nc')
  view.setSide('left', contents.left ?? 'a\nL\nc')
  view.setSide('right', contents.right ?? 'a\nR\nc')
  return { view, host }
}

/** @param {HTMLElement} host */
const lineCount = (host) => host.querySelectorAll('.mw-content-left .mw-line').length

/** @param {HTMLElement} host */
const renderedTexts = (host) =>
  [...host.querySelectorAll('.mw-content-left .mw-linetext')].map((el) => el.textContent)

beforeEach(() => {
  window.electronAPI = { openFile: vi.fn(), saveFile: vi.fn() }
  const settings = new SettingsStore()
  // These cover virtualisation, so the cursor must stay put until they move it.
  settings.setPref('navFirstDiffOnLoad', false)
  settings.setPref('navWrapAround', true)
  settings.setPref('navNextAfterCopy', false)
})

afterEach(() => {
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------

describe('computeVisibleRange', () => {
  it('covers the viewport plus overscan on both sides', () => {
    const { start, end } = computeVisibleRange(100 * ROW_HEIGHT, 360, 10000, ROW_HEIGHT, 5)
    expect(start).toBe(95)
    expect(end).toBe(100 + 20 + 5)
  })

  it('clamps to the ends of the list', () => {
    expect(computeVisibleRange(0, 360, 10000, ROW_HEIGHT, 5).start).toBe(0)
    expect(computeVisibleRange(1e9, 360, 30, ROW_HEIGHT, 5).end).toBe(30)
  })

  it('returns an empty range for an empty list', () => {
    expect(computeVisibleRange(0, 360, 0)).toEqual({ start: 0, end: 0 })
    expect(computeVisibleRange(0, 360, -5)).toEqual({ start: 0, end: 0 })
  })

  it('falls back to a usable height when the pane reports none', () => {
    const { start, end } = computeVisibleRange(0, 0, 100000)
    expect(start).toBe(0)
    expect(end).toBeGreaterThan(0)
    expect(end).toBeLessThan(100)
  })

  it('survives NaN inputs rather than producing a NaN range', () => {
    const r = computeVisibleRange(NaN, NaN, 500, NaN, NaN)
    expect(Number.isFinite(r.start)).toBe(true)
    expect(Number.isFinite(r.end)).toBe(true)
    expect(r.end).toBeGreaterThan(r.start)
  })
})

describe('row-list builders', () => {
  it('diffToPaneRows maps every diff op to a row', () => {
    const rows = diffToPaneRows([
      { type: 'equal', leftLine: 1, leftText: 'a\n', rightLine: 1, rightText: 'a\n' },
      { type: 'insert', rightLine: 2, rightText: 'new\n' },
      { type: 'delete', leftLine: 2, leftText: 'gone\n' },
      { type: 'replace', leftLine: 3, leftText: 'old\n', rightLine: 3, rightText: 'newer\n' },
    ])
    expect(rows.map((r) => r.type)).toEqual(['equal', 'insert', 'delete', 'replace'])
    expect(rows.map((r) => r.text)).toEqual(['a', 'new', 'gone', 'newer'])
    expect(rows[2].lineNum).toBeNull()
  })

  it('diffToPaneRows tolerates missing input', () => {
    expect(diffToPaneRows(null)).toEqual([])
  })

  it('buildPaneRows numbers plain content and skips numbers when filtered', () => {
    const plain = buildPaneRows('base', { content: 'a\nb\nc' })
    expect(plain.map((r) => r.lineNum)).toEqual([1, 2, 3])

    const segments = [
      { type: 'normal', lines: ['a', 'b', 'c', 'd'] },
      { type: 'conflict', id: 0, leftLines: ['L'], baseLines: ['B'], rightLines: ['R'] },
      { type: 'normal', lines: ['e', 'f'] },
    ]
    const filtered = buildPaneRows('left', { showFilter: 'conflicts', segments })
    expect(filtered.every((r) => r.lineNum === null)).toBe(true)
    expect(filtered.filter((r) => r.type === 'conflict').map((r) => r.text)).toEqual(['L'])
  })
})

// ---------------------------------------------------------------------------

describe('S16 merge3 — virtual scrolling', () => {
  const N = 20000
  /** @type {ThreeWayCompare} */
  let view
  /** @type {HTMLElement} */
  let host

  beforeEach(() => {
    ({ view, host } = mountView({
      base: bigText(N),
      left: bigText(N, [10, 12000], 'L'),
      right: bigText(N, [10, 12000], 'R'),
    }))
  })

  afterEach(() => { view.destroy(); host.remove() })

  it('keeps the full row list even though the DOM only holds a window', () => {
    expect(view.getPaneRows('left').length).toBe(N)
    expect(view.getPaneRows('base').length).toBe(N)
    expect(lineCount(host)).toBeLessThan(100)
    expect(lineCount(host)).toBeGreaterThan(0)
  })

  it('caps DOM nodes for all three panes, not just the left one', () => {
    for (const side of ['left', 'base', 'right']) {
      expect(host.querySelectorAll(`.mw-content-${side} .mw-line`).length).toBeLessThan(100)
    }
  })

  it('sizes the spacer to the full document height', () => {
    const spacer = host.querySelector('.mw-content-left .mw-vspacer')
    expect(spacer.style.height).toBe(`${N * ROW_HEIGHT}px`)
  })

  it('renders different rows after scrolling, still within the cap', () => {
    const before = renderedTexts(host)
    view.scrollToRow(9000)
    const after = renderedTexts(host)

    expect(after.length).toBeLessThan(100)
    expect(after).not.toEqual(before)
    expect(after).toContain('line9000')
    expect(before).toContain('line0')
    expect(after).not.toContain('line0')
  })

  it('offsets the window so scrolled rows land at the right position', () => {
    view.scrollToRow(500)
    const win = host.querySelector('.mw-content-left .mw-vwindow')
    const offset = Number(/translateY\((-?\d+)px\)/.exec(win.style.transform)?.[1])
    expect(offset).toBeGreaterThan(0)
    expect(offset).toBeLessThanOrEqual(500 * ROW_HEIGHT)
  })

  it('scrolling one pane repaints and syncs the other two', () => {
    const pane = host.querySelector('.mw-content-left')
    pane.scrollTop = 6000 * ROW_HEIGHT
    pane.dispatchEvent(new Event('scroll'))

    expect(host.querySelector('.mw-content-base').scrollTop).toBe(pane.scrollTop)
    expect(renderedTexts(host)).toContain('line6000')
    expect(lineCount(host)).toBeLessThan(100)
  })

  it('shrinks the window when a smaller file replaces the content', () => {
    view.scrollToRow(9000)
    for (const side of ['base', 'left', 'right']) view.setSide(side, bigText(40))

    expect(view.getPaneRows('base').length).toBe(40)
    expect(lineCount(host)).toBeLessThanOrEqual(40)
    expect(host.querySelector('.mw-content-base .mw-vspacer').style.height)
      .toBe(`${40 * ROW_HEIGHT}px`)
  })

  it('virtualises the conflicts filter too', () => {
    const many = 400
    const changed = Array.from({ length: many }, (_, i) => i * 40)
    const { view: v, host: h } = mountView({
      base: bigText(N),
      left: bigText(N, changed, 'L'),
      right: bigText(N, changed, 'R'),
    })
    expect(v.getConflictCount()).toBe(many)

    v.setShowFilter('conflicts')
    const rows = v.getPaneRows('left')
    expect(rows.length).toBeGreaterThan(1000)          // filtered, yet still large
    expect(h.querySelectorAll('.mw-content-left .mw-line').length).toBeLessThan(100)

    const before = [...h.querySelectorAll('.mw-content-left .mw-linetext')].map((e) => e.textContent)
    v.scrollToRow(800)
    const after = [...h.querySelectorAll('.mw-content-left .mw-linetext')].map((e) => e.textContent)
    expect(after).not.toEqual(before)
    expect(h.querySelectorAll('.mw-content-left .mw-line').length).toBeLessThan(100)

    v.destroy(); h.remove()
  })

  it('does not elide the merged text even when the preview is truncated', () => {
    const output = host.querySelector('.mw-output-textarea').value
    expect(output.split('\n').length).toBeGreaterThan(N - 10)

    const previews = [...host.querySelectorAll('.mw-normal-seg')].map((e) => e.textContent)
    expect(previews.some((t) => t.includes('省略'))).toBe(true)
    expect(Math.max(...previews.map((t) => t.split('\n').length))).toBeLessThan(250)
  })
})

describe('S16 merge3 — empty and tiny documents', () => {
  it('renders every row when the document fits the viewport', () => {
    const { view, host } = mountView()
    expect(lineCount(host)).toBe(view.getPaneRows('left').length)
    view.destroy(); host.remove()
  })

  it('renders nothing and does not throw for empty panes', () => {
    const { view, host } = mountView({ base: '', left: '', right: '' })
    expect(() => view.scrollToRow(100)).not.toThrow()
    view.destroy(); host.remove()
  })
})

// ---------------------------------------------------------------------------

describe('S16 merge3 — two instances coexist in one document', () => {
  it('keeps element ids unique across instances', () => {
    const a = mountView()
    const b = mountView()
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id)
    expect(new Set(ids).size).toBe(ids.length)
    a.view.destroy(); b.view.destroy()
  })

  it('routes output, counters and filters to the owning instance only', () => {
    const a = mountView({ base: 'a\nb\nc', left: 'a\nL\nc', right: 'a\nR\nc' })
    const b = mountView({ base: 'x\ny\nz', left: 'x\ny\nz', right: 'x\ny\nz' })

    expect(a.view.getConflictCount()).toBe(1)
    expect(b.view.getConflictCount()).toBe(0)

    a.view.resolveAll('left')
    expect(a.host.querySelector('.mw-output-textarea').value).toBe('a\nL\nc')
    expect(b.host.querySelector('.mw-output-textarea').value).toBe('x\ny\nz')

    expect(a.host.querySelector('.mw-conflict-counter').textContent).toContain('/ 1')
    expect(b.host.querySelector('.mw-conflict-counter').textContent).toBe('無衝突')

    a.view.setShowFilter('conflicts')
    expect(b.view.getShowFilter()).toBe('all')
    expect(b.host.querySelector('.mw-btn-filter').classList.contains('active')).toBe(false)
    expect(a.host.querySelector('.mw-btn-filter').classList.contains('active')).toBe(true)

    a.view.destroy(); b.view.destroy()
  })

  it('scrolls each instance independently', () => {
    const a = mountView({ base: bigText(5000), left: bigText(5000), right: bigText(5000) })
    const b = mountView({ base: bigText(5000), left: bigText(5000), right: bigText(5000) })

    a.view.scrollToRow(2000)
    expect(renderedTexts(a.host)).toContain('line2000')
    expect(renderedTexts(b.host)).toContain('line0')
    expect(renderedTexts(b.host)).not.toContain('line2000')

    a.view.destroy(); b.view.destroy()
  })

  it('destroying one instance leaves the other working', () => {
    const a = mountView()
    const b = mountView()
    a.view.destroy()
    a.host.remove()

    expect(() => b.view.nextConflict()).not.toThrow()
    expect(b.host.querySelector('.mw-output-textarea')).not.toBeNull()
    b.view.destroy()
  })
})

// ---------------------------------------------------------------------------

describe('S16 merge3 — the view owns no element ids', () => {
  it('renders no id attributes at all', () => {
    const { view, host } = mountView()
    expect(host.querySelectorAll('[id]').length).toBe(0)
    view.destroy(); host.remove()
  })

  it('leaves the historical #mw-* handles unresolvable document-wide', () => {
    const a = mountView()
    const b = mountView()
    for (const id of [
      'mw-output', 'mw-output-pane', 'mw-content-left', 'mw-content-base',
      'mw-content-right', 'mw-conflict-counter', 'mw-btn-filter', 'mw-btn-next',
      'mw-btn-prev', 'mw-btn-save', 'mw-divider', 'mw-path-left',
    ]) {
      expect(document.getElementById(id)).toBeNull()
    }
    a.view.destroy(); b.view.destroy()
  })

  it('ships no per-instance <style> block', () => {
    const a = mountView()
    const b = mountView()
    // The stylesheet is imported by the module; duplicating it per mount is
    // what the inline block used to do.
    expect(a.host.querySelectorAll('style').length).toBe(0)
    expect(b.host.querySelectorAll('style').length).toBe(0)
    a.view.destroy(); b.view.destroy()
  })

  it('addresses every pane through its own container', () => {
    const a = mountView({ base: bigText(2000), left: bigText(2000, [500], 'L'), right: bigText(2000, [500], 'R') })
    const b = mountView({ base: bigText(2000), left: bigText(2000), right: bigText(2000) })

    // The toolbars are identical markup in the same document; a document-wide
    // lookup would drive the first instance from the second one's button.
    b.host.querySelector('.mw-btn-filter').click()
    expect(b.view.getShowFilter()).toBe('conflicts')
    expect(a.view.getShowFilter()).toBe('all')
    expect(a.host.querySelector('.mw-btn-filter').classList.contains('active')).toBe(false)

    b.host.querySelector('.mw-btn-all-left').click()
    expect(a.host.querySelector('.mw-output-textarea').value).toContain('L500')

    a.view.destroy(); b.view.destroy()
  })
})

describe('S16 merge3 — conflict navigation scrolls the virtualised panes', () => {
  const N = 20000

  it('computes a row for a conflict in both filter modes', () => {
    const segments = [
      { type: 'normal', lines: ['a', 'b', 'c', 'd'] },
      { type: 'conflict', id: 0, leftLines: ['L'], baseLines: ['B'], rightLines: ['R'], baseStart: 4 },
      { type: 'normal', lines: ['e', 'f', 'g', 'h'] },
      { type: 'conflict', id: 1, leftLines: ['L2'], baseLines: ['B2'], rightLines: ['R2'], baseStart: 9 },
    ]
    expect(conflictPaneRow(segments, 0)).toBe(4)
    expect(conflictPaneRow(segments, 1)).toBe(9)
    expect(conflictPaneRow(segments, 99)).toBe(-1)
    expect(conflictPaneRow(null, 0)).toBe(-1)

    // Filtered mode drops most normal lines, so rows move up.
    expect(conflictPaneRow(segments, 0, 'conflicts')).toBe(2)
    expect(conflictPaneRow(segments, 1, 'conflicts')).toBeLessThan(9)
  })

  it('returns -1 for segments built without positions', () => {
    expect(conflictPaneRow([
      { type: 'conflict', id: 0, leftLines: ['L'], baseLines: ['B'], rightLines: ['R'] },
    ], 0)).toBe(-1)
  })

  it('brings a far-away conflict into the rendered window', () => {
    const { view, host } = mountView({
      base: bigText(N),
      left: bigText(N, [17000], 'L'),
      right: bigText(N, [17000], 'R'),
    })
    expect(view.getConflictCount()).toBe(1)
    expect(renderedTexts(host)).not.toContain('L17000')

    view.nextConflict()
    expect(renderedTexts(host)).toContain('L17000')
    expect(lineCount(host)).toBeLessThan(100)

    view.destroy(); host.remove()
  })

  it('walks a long conflict list without ever growing the DOM', () => {
    const changed = Array.from({ length: 300 }, (_, i) => i * 60)
    const { view, host } = mountView({
      base: bigText(N),
      left: bigText(N, changed, 'L'),
      right: bigText(N, changed, 'R'),
    })
    expect(view.getConflictCount()).toBe(300)

    for (let i = 0; i < 300; i++) {
      view.nextConflict()
      expect(lineCount(host)).toBeLessThan(100)
    }
    // Wrapped exactly once.
    expect(view.getCurrentConflictIndex()).toBe(299)
    expect(renderedTexts(host)).toContain('L17940')

    view.destroy(); host.remove()
  })

  it('navigates independently in two mounted instances', () => {
    const a = mountView({ base: bigText(N), left: bigText(N, [8000], 'L'), right: bigText(N, [8000], 'R') })
    const b = mountView({ base: bigText(N), left: bigText(N, [3000], 'L'), right: bigText(N, [3000], 'R') })

    a.view.nextConflict()
    expect(renderedTexts(a.host)).toContain('L8000')
    expect(renderedTexts(b.host)).toContain('line0')
    expect(renderedTexts(b.host)).not.toContain('L3000')

    b.view.nextConflict()
    expect(renderedTexts(b.host)).toContain('L3000')
    expect(renderedTexts(a.host)).toContain('L8000')

    a.view.destroy(); b.view.destroy()
  })

  it('keeps navigation working in conflicts-only mode', () => {
    const changed = Array.from({ length: 200 }, (_, i) => i * 90)
    const { view, host } = mountView({
      base: bigText(N),
      left: bigText(N, changed, 'L'),
      right: bigText(N, changed, 'R'),
    })
    view.setShowFilter('conflicts')
    view.lastConflict()

    expect(renderedTexts(host)).toContain('L17910')
    expect(lineCount(host)).toBeLessThan(100)
    view.destroy(); host.remove()
  })
})

describe('S16 merge3 — the output pane stays bounded too', () => {
  it('elides a single conflict spanning thousands of lines', () => {
    const N = 6000
    const half = Array.from({ length: N / 2 }, (_, i) => `line${i}`)
    const { view, host } = mountView({
      base: [...half, ...Array.from({ length: N / 2 }, (_, i) => `B${i}`)].join('\n'),
      left: [...half, ...Array.from({ length: N / 2 }, (_, i) => `L${i}`)].join('\n'),
      right: [...half, ...Array.from({ length: N / 2 }, (_, i) => `R${i}`)].join('\n'),
    })
    expect(view.getConflictCount()).toBe(1)

    const previews = [...host.querySelectorAll('.mw-conflict-preview pre')]
    expect(previews.length).toBe(3)
    for (const pre of previews) {
      expect(pre.textContent.split('\n').length).toBeLessThan(250)
      expect(pre.textContent).toContain('省略')
    }
    // Everything the preview hid is still in the saved output.
    view.resolveAll('left')
    expect(host.querySelector('.mw-output-textarea').value).toContain(`L${N / 2 - 1}`)

    view.destroy(); host.remove()
  })

  it('renders conflict text without interpreting markup', () => {
    const { view, host } = mountView({
      base: 'a\nb\nc',
      left: 'a\n<img src=x onerror=alert(1)>\nc',
      right: 'a\nR\nc',
    })
    const pre = host.querySelector('.mw-conflict-left pre')
    expect(pre.textContent).toContain('<img')
    expect(host.querySelectorAll('.mw-conflict-left img').length).toBe(0)
    view.destroy(); host.remove()
  })

  it('keeps the view node count proportional to conflicts, not to lines', () => {
    const conflicts = 200
    const changed = Array.from({ length: conflicts }, (_, i) => i * 90)
    const { view, host } = mountView({
      base: bigText(20000),
      left: bigText(20000, changed, 'L'),
      right: bigText(20000, changed, 'R'),
    })
    expect(view.getConflictCount()).toBe(conflicts)
    // 20k lines × 3 panes unvirtualised would be 60k row elements alone.
    expect(host.querySelectorAll('*').length).toBeLessThan(conflicts * 30)
    view.destroy(); host.remove()
  })
})

describe('S16 merge3 — getConfig / applyConfig', () => {
  it('exposes both halves of the contract', () => {
    const v = new ThreeWayCompare()
    expect(typeof v.getConfig).toBe('function')
    expect(typeof v.applyConfig).toBe('function')
    expect(typeof v.getConfig()).toBe('object')
  })

  it('round-trips a snapshot between instances', () => {
    const a = new ThreeWayCompare()
    a.applyConfig({
      showFilter: 'conflicts', algorithm: 'patience',
      ignoreWhitespace: true, ignoreCase: true,
    })
    const b = new ThreeWayCompare()
    b.applyConfig(a.getConfig())
    expect(b.getConfig()).toEqual({
      __v: 1, __view: 'merge3',
      showFilter: 'conflicts', algorithm: 'patience',
      ignoreWhitespace: true, ignoreCase: true,
    })
  })

  it('never captures paths or file contents', () => {
    const { view, host } = mountView()
    view.setSide('left', 'SECRET CONTENT', 'C:/secret/left.txt')
    const snap = JSON.stringify(view.getConfig())
    expect(snap).not.toContain('secret')
    expect(snap).not.toContain('SECRET')
    view.destroy(); host.remove()
  })

  it('rejects unknown enum values and wrong types', () => {
    const v = new ThreeWayCompare()
    const before = v.getConfig()
    v.applyConfig({
      showFilter: 'bogus', algorithm: 'telepathy',
      ignoreWhitespace: 'yes', ignoreCase: 1,
    })
    expect(v.getConfig()).toEqual(before)
  })

  it('ignores junk input', () => {
    const v = new ThreeWayCompare()
    const before = v.getConfig()
    v.applyConfig(null)
    v.applyConfig('nope')
    v.applyConfig(42)
    expect(v.getConfig()).toEqual(before)
  })

  it('applies the show filter to the mounted panes', () => {
    const { view, host } = mountView({
      base: bigText(60), left: bigText(60, [30], 'L'), right: bigText(60, [30], 'R'),
    })
    const allRows = view.getPaneRows('left').length
    view.applyConfig({ showFilter: 'conflicts' })
    expect(view.getPaneRows('left').length).toBeLessThan(allRows)
    expect(host.querySelector('.mw-btn-filter').classList.contains('active')).toBe(true)
    view.destroy(); host.remove()
  })

  it('an algorithm change re-runs the merge', () => {
    const { view, host } = mountView()
    view.applyConfig({ algorithm: 'patience' })
    expect(view.getConfig().algorithm).toBe('patience')
    expect(view.getConflictCount()).toBe(1)
    view.destroy(); host.remove()
  })

  it('applyConfig works before the view is mounted', () => {
    const v = new ThreeWayCompare()
    expect(() => v.applyConfig({ showFilter: 'conflicts' })).not.toThrow()
    expect(v.getShowFilter()).toBe('conflicts')
  })
})
