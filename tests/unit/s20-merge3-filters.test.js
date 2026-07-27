/**
 * @vitest-environment jsdom
 *
 * P1-16 / P2-35 — the eight-state display filter and the alignment algorithm
 * picker for the three-way merge view.
 *
 * The filter has to act on the row *data*: the panes are virtualised, so a
 * mode that hid rows in CSS would leave the spacer sized for rows that are not
 * there. Every mode below is therefore checked twice — once for what it keeps,
 * once for how much of it reaches the DOM at 20k lines.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ThreeWayCompare,
  SHOW_FILTER_MODES,
  filterSegments,
  segmentKind,
  segmentMatchesFilter,
  isShowFilterMode,
  conflictPaneRow,
} from '../../src/renderer/src/views/three-way-compare.js'
import { SettingsStore } from '../../src/renderer/src/core/settings-store.js'

const ROW_HEIGHT = 18

/** @param {{ left?: string, base?: string, right?: string }} [contents] */
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

/**
 * A ten-line document carrying one of every segment kind:
 *   line 1 left-only, line 3 right-only, line 5 identical on both,
 *   line 7 conflicting.
 */
const SMALL = {
  base:  Array.from({ length: 10 }, (_, i) => `b${i}`).join('\n'),
  left:  Array.from({ length: 10 }, (_, i) =>
    i === 1 ? 'L1' : i === 5 ? 'X5' : i === 7 ? 'L7' : `b${i}`).join('\n'),
  right: Array.from({ length: 10 }, (_, i) =>
    i === 3 ? 'R3' : i === 5 ? 'X5' : i === 7 ? 'R7' : `b${i}`).join('\n'),
}

/** @param {HTMLElement} host @param {'left'|'base'|'right'} side */
const lineCount = (host, side = 'left') =>
  host.querySelectorAll(`.mw-content-${side} .mw-line`).length

/** @param {HTMLElement} host */
const renderedTexts = (host) =>
  [...host.querySelectorAll('.mw-content-left .mw-linetext')].map((el) => el.textContent)

beforeEach(() => {
  window.electronAPI = { openFile: vi.fn(), saveFile: vi.fn() }
  const settings = new SettingsStore()
  settings.setPref('navFirstDiffOnLoad', false)
  settings.setPref('navWrapAround', true)
  settings.setPref('navNextAfterCopy', false)
})

afterEach(() => { document.body.innerHTML = '' })

// ---------------------------------------------------------------------------

describe('P1-16 — the filter vocabulary', () => {
  it('offers exactly the nine BC modes', () => {
    expect(SHOW_FILTER_MODES).toEqual([
      'all', 'changes', 'left-changes', 'right-changes',
      'conflicts', 'mergeable', 'unchanged', 'same', 'none',
    ])
  })

  it('recognises every mode and nothing else', () => {
    for (const mode of SHOW_FILTER_MODES) expect(isShowFilterMode(mode)).toBe(true)
    for (const junk of ['bogus', '', null, undefined, 42, {}]) {
      expect(isShowFilterMode(junk)).toBe(false)
    }
  })

  it('treats an untagged normal segment as unchanged', () => {
    expect(segmentKind({ type: 'normal', lines: ['a'] })).toBe('same')
    expect(segmentKind(null)).toBe('same')
    expect(segmentKind({ type: 'conflict', id: 0, leftLines: [], baseLines: [], rightLines: [] }))
      .toBe('conflict')
  })
})

describe('P1-16 — segmentMatchesFilter', () => {
  const seg = (kind) => (kind === 'conflict'
    ? { type: 'conflict', id: 0, leftLines: ['L'], baseLines: ['B'], rightLines: ['R'] }
    : { type: 'normal', lines: ['x'], kind })

  /** kind → the modes that must keep it */
  const table = {
    same:     ['all', 'unchanged', 'same'],
    left:     ['all', 'changes', 'left-changes', 'mergeable'],
    right:    ['all', 'changes', 'right-changes', 'mergeable'],
    both:     ['all', 'changes', 'left-changes', 'right-changes', 'mergeable', 'same'],
    conflict: ['all', 'changes', 'left-changes', 'right-changes', 'conflicts'],
  }

  for (const [kind, keptBy] of Object.entries(table)) {
    it(`keeps a '${kind}' segment in exactly ${keptBy.join(', ')}`, () => {
      for (const mode of SHOW_FILTER_MODES) {
        expect([mode, segmentMatchesFilter(seg(kind), mode)])
          .toEqual([mode, keptBy.includes(mode)])
      }
    })
  }
})

describe('P1-16 — filterSegments', () => {
  const segments = [
    { type: 'normal', lines: ['s1'], kind: 'same' },
    { type: 'normal', lines: ['l1'], kind: 'left' },
    { type: 'conflict', id: 0, leftLines: ['L'], baseLines: ['B'], rightLines: ['R'], baseStart: 2 },
    { type: 'normal', lines: ['s2'], kind: 'same' },
  ]

  it('returns the input untouched for all', () => {
    expect(filterSegments(segments, 'all')).toBe(segments)
  })

  it('returns nothing for none', () => {
    expect(filterSegments(segments, 'none')).toEqual([])
  })

  it('keeps context around conflicts only in conflicts mode', () => {
    const conflictOnly = filterSegments(segments, 'conflicts')
    expect(conflictOnly.some((s) => s.type === 'conflict')).toBe(true)
    // Context is normal segments carried along with the conflict.
    expect(conflictOnly.length).toBeGreaterThan(1)

    const mergeable = filterSegments(segments, 'mergeable')
    expect(mergeable).toEqual([segments[1]])
  })

  it('survives a null segment list', () => {
    for (const mode of SHOW_FILTER_MODES) {
      expect(() => filterSegments(null, mode)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------

describe('P1-16 — segments carry the kind the filter needs', () => {
  it('labels left-only, right-only, identical and unchanged runs', () => {
    const view = new ThreeWayCompare()
    const { segments } = view._threeWayMerge(SMALL.left, SMALL.base, SMALL.right)
    const kinds = segments.map(segmentKind)

    expect(kinds).toContain('left')
    expect(kinds).toContain('right')
    expect(kinds).toContain('both')
    expect(kinds).toContain('same')
    expect(kinds).toContain('conflict')

    expect(segments.find((s) => segmentKind(s) === 'left').lines).toEqual(['L1'])
    expect(segments.find((s) => segmentKind(s) === 'right').lines).toEqual(['R3'])
    expect(segments.find((s) => segmentKind(s) === 'both').lines).toEqual(['X5'])
  })
})

describe('P1-16 — each mode changes the row list, not the styling', () => {
  /** @type {ThreeWayCompare} */ let view
  /** @type {HTMLElement} */ let host

  beforeEach(() => { ({ view, host } = mountView(SMALL)) })
  afterEach(() => { view.destroy(); host.remove() })

  it('shows the whole left document in all mode', () => {
    expect(view.getPaneRows('left').length).toBe(10)
  })

  const expected = {
    changes: ['L1', 'R3', 'X5', 'L7'],
    'left-changes': ['L1', 'X5', 'L7'],
    'right-changes': ['R3', 'X5', 'L7'],
    mergeable: ['L1', 'R3', 'X5'],
    unchanged: ['b0', 'b2', 'b4', 'b6', 'b8', 'b9'],
    same: ['b0', 'b2', 'b4', 'X5', 'b6', 'b8', 'b9'],
    none: [],
  }

  for (const [mode, texts] of Object.entries(expected)) {
    it(`'${mode}' keeps exactly ${texts.length} left rows`, () => {
      view.setShowFilter(mode)
      expect(view.getPaneRows('left').map((r) => r.text)).toEqual(texts)
      // Data-level filtering means the DOM holds the same rows, no more.
      expect(renderedTexts(host)).toEqual(texts)
    })
  }

  it("'conflicts' still shows the conflict plus context", () => {
    view.setShowFilter('conflicts')
    const texts = view.getPaneRows('left').map((r) => r.text)
    expect(texts).toContain('L7')
    expect(texts.length).toBeGreaterThan(1)
    expect(host.querySelectorAll('.mw-content-left .mw-line--conflict').length).toBe(1)
  })

  it('marks rows by the side that changed them', () => {
    view.setShowFilter('changes')
    const types = view.getPaneRows('left').map((r) => r.type)
    expect(types).toEqual(['left', 'right', 'both', 'conflict'])
    expect(host.querySelectorAll('.mw-content-left .mw-line--left').length).toBe(1)
    expect(host.querySelectorAll('.mw-content-left .mw-line--right').length).toBe(1)
    expect(host.querySelectorAll('.mw-content-left .mw-line--both').length).toBe(1)
  })

  it('filters the base and right panes too', () => {
    view.setShowFilter('unchanged')
    expect(view.getPaneRows('base').map((r) => r.text))
      .toEqual(['b0', 'b2', 'b4', 'b6', 'b8', 'b9'])
    expect(view.getPaneRows('right').map((r) => r.text))
      .toEqual(['b0', 'b2', 'b4', 'b6', 'b8', 'b9'])
  })

  it('none empties the panes and collapses the spacer', () => {
    view.setShowFilter('none')
    expect(view.getPaneRows('left')).toEqual([])
    expect(lineCount(host)).toBe(0)
    expect(host.querySelector('.mw-content-left .mw-vspacer').style.height).toBe('0px')
    expect(() => view.scrollToRow(500)).not.toThrow()
  })

  it('returns to the full document when set back to all', () => {
    view.setShowFilter('none')
    view.setShowFilter('all')
    expect(view.getPaneRows('left').length).toBe(10)
    expect(renderedTexts(host)).toContain('L1')
  })

  it('ignores an unknown mode instead of blanking the view', () => {
    view.setShowFilter('changes')
    view.setShowFilter('telepathy')
    expect(view.getShowFilter()).toBe('changes')
  })

  it('keeps the toolbar button and the picker in step', () => {
    const btn = host.querySelector('.mw-btn-filter')
    const select = host.querySelector('.mw-filter-select')
    expect(select.options.length).toBe(SHOW_FILTER_MODES.length)

    view.setShowFilter('mergeable')
    expect(select.value).toBe('mergeable')
    expect(btn.textContent).toBe('顯示：可自動合併')
    expect(btn.classList.contains('active')).toBe(true)

    view.setShowFilter('all')
    expect(btn.classList.contains('active')).toBe(false)
  })

  it('drives the filter from the picker', () => {
    const select = host.querySelector('.mw-filter-select')
    select.value = 'unchanged'
    select.dispatchEvent(new Event('change'))
    expect(view.getShowFilter()).toBe('unchanged')
    expect(view.getPaneRows('left').length).toBe(6)
  })
})

// ---------------------------------------------------------------------------

describe('P1-16 — every mode stays virtualised at 20k lines', () => {
  const N = 20000

  /**
   * One document per role, with a left-only, a right-only, an identical and a
   * conflicting edit every 400 lines — 50 of each.
   * @param {'base'|'left'|'right'} role
   */
  function doc(role) {
    return Array.from({ length: N }, (_, i) => {
      const slot = i % 400
      if (i > 0 && slot === 0) return role === 'base' ? `line${i}` : `${role === 'left' ? 'L' : 'R'}c${i}`
      if (slot === 100) return role === 'left' ? `Lonly${i}` : `line${i}`
      if (slot === 200) return role === 'right' ? `Ronly${i}` : `line${i}`
      if (slot === 300) return role === 'base' ? `line${i}` : `Xboth${i}`
      return `line${i}`
    }).join('\n')
  }

  /** @type {ThreeWayCompare} */ let view
  /** @type {HTMLElement} */ let host

  beforeEach(() => {
    ({ view, host } = mountView({ base: doc('base'), left: doc('left'), right: doc('right') }))
  })
  afterEach(() => { view.destroy(); host.remove() })

  it('produces the expected mix of segment kinds', () => {
    expect(view.getConflictCount()).toBe(49)
    expect(view.getPaneRows('left').length).toBe(N)
  })

  for (const mode of SHOW_FILTER_MODES) {
    it(`'${mode}' renders only the visible window`, () => {
      view.setShowFilter(mode)
      for (const side of ['left', 'base', 'right']) {
        expect(lineCount(host, side)).toBeLessThan(100)
      }
      if (mode !== 'none') {
        expect(view.getPaneRows('left').length).toBeGreaterThan(0)
        expect(lineCount(host)).toBeGreaterThan(0)
      }

      // The spacer must describe the whole filtered list, or scrolling lands
      // somewhere other than where the scrollbar says it does.
      const rows = view.getPaneRows('left').length
      expect(host.querySelector('.mw-content-left .mw-vspacer').style.height)
        .toBe(`${rows * ROW_HEIGHT}px`)
    })
  }

  it('repaints a different window after scrolling in a filtered mode', () => {
    view.setShowFilter('changes')
    const rows = view.getPaneRows('left').length
    expect(rows).toBeGreaterThan(150)

    const before = renderedTexts(host)
    view.scrollToRow(rows - 20)
    const after = renderedTexts(host)
    expect(after).not.toEqual(before)
    expect(lineCount(host)).toBeLessThan(100)
  })

  it('switching modes never leaves stale rows behind', () => {
    for (const mode of SHOW_FILTER_MODES) {
      view.setShowFilter(mode)
      expect(lineCount(host)).toBeLessThanOrEqual(
        Math.min(view.getPaneRows('left').length, 99))
    }
  })
})

// ---------------------------------------------------------------------------

describe('P1-16 — navigation and resolution under a filter', () => {
  it('scrolls to a conflict in a mode that keeps conflicts', () => {
    const N = 20000
    const big = (tag) => Array.from({ length: N }, (_, i) =>
      (i === 17000 && tag ? `${tag}17000` : `line${i}`)).join('\n')
    const { view, host } = mountView({ base: big(''), left: big('L'), right: big('R') })

    view.setShowFilter('changes')
    view.nextConflict()
    expect(renderedTexts(host)).toContain('L17000')
    expect(host.querySelectorAll('.mw-content-left .mw-line').length).toBeLessThan(100)

    view.destroy(); host.remove()
  })

  it('leaves the scroll alone when the filter hides every conflict', () => {
    const { view, host } = mountView(SMALL)
    view.setShowFilter('mergeable')
    // Not present in the filtered list → no row to scroll to.
    expect(conflictPaneRow(view._segments, 0, 'mergeable')).toBe(-1)
    expect(() => view.nextConflict()).not.toThrow()
    expect(view.getCurrentConflictIndex()).toBe(0)
    view.destroy(); host.remove()
  })

  it('keeps Take Left / Center / Right / Both working in every mode', () => {
    for (const mode of SHOW_FILTER_MODES) {
      const { view, host } = mountView(SMALL)
      view.setShowFilter(mode)

      const output = host.querySelector('.mw-output-textarea')
      view.setConflictChoice(0, 'left')
      expect(output.value).toContain('L7')
      view.setConflictChoice(0, 'base')
      expect(output.value).toContain('b7')
      view.setConflictChoice(0, 'right')
      expect(output.value).toContain('R7')
      view.setConflictChoice(0, 'both')
      expect(output.value).toContain('L7')
      expect(output.value).toContain('R7')

      view.destroy(); host.remove()
    }
  })

  it('keeps batch resolve and the reports working under a filter', () => {
    const { view, host } = mountView(SMALL)
    view.setShowFilter('conflicts')
    expect(view.resolveAll('left')).toBe(1)
    expect(host.querySelector('.mw-output-textarea').value).toContain('L7')

    view.setShowFilter('none')
    const summary = view.getConflictSummary()
    expect(summary.total).toBe(1)
    expect(summary.resolved).toBe(1)
    expect(view.buildTextReport()).toContain('採用左側')
    expect(view.buildHtmlReport()).toContain('三向合併報告')

    view.destroy(); host.remove()
  })
})

// ---------------------------------------------------------------------------

describe('P2-35 — alignment algorithm selection', () => {
  it('exposes the three engines the text view uses', () => {
    const { view, host } = mountView(SMALL)
    const select = host.querySelector('.mw-algo-select')
    expect([...select.options].map((o) => o.value)).toEqual(['myers', 'patience', 'histogram'])
    view.destroy(); host.remove()
  })

  it('re-runs the merge when the picker changes', () => {
    const { view, host } = mountView(SMALL)
    const select = host.querySelector('.mw-algo-select')
    select.value = 'histogram'
    select.dispatchEvent(new Event('change'))

    expect(view.getAlgorithm()).toBe('histogram')
    // Still a working merge, not an empty one.
    expect(view.getConflictCount()).toBe(1)
    expect(view.getPaneRows('left').length).toBe(10)
    view.destroy(); host.remove()
  })

  it('setAlgorithm ignores an unknown engine', () => {
    const { view, host } = mountView(SMALL)
    view.setAlgorithm('telepathy')
    expect(view.getAlgorithm()).toBe('myers')
    view.destroy(); host.remove()
  })

  it('all three engines merge the same document to the same conflict count', () => {
    for (const algorithm of ['myers', 'patience', 'histogram']) {
      const { view, host } = mountView(SMALL)
      view.setAlgorithm(algorithm)
      expect([algorithm, view.getConflictCount()]).toEqual([algorithm, 1])
      view.destroy(); host.remove()
    }
  })

  it('syncs the picker when the algorithm arrives from a config', () => {
    const { view, host } = mountView(SMALL)
    view.applyConfig({ algorithm: 'patience' })
    expect(host.querySelector('.mw-algo-select').value).toBe('patience')
    view.destroy(); host.remove()
  })
})

// ---------------------------------------------------------------------------

describe('P1-16 / P2-35 — session config', () => {
  it('round-trips every filter mode', () => {
    for (const showFilter of SHOW_FILTER_MODES) {
      const a = new ThreeWayCompare()
      a.applyConfig({ showFilter, algorithm: 'histogram' })
      const b = new ThreeWayCompare()
      b.applyConfig(a.getConfig())
      expect(b.getShowFilter()).toBe(showFilter)
      expect(b.getAlgorithm()).toBe('histogram')
    }
  })

  it('still loads a snapshot written when only all/conflicts existed', () => {
    const v = new ThreeWayCompare()
    v.applyConfig({ showFilter: 'conflicts' })
    expect(v.getShowFilter()).toBe('conflicts')
    v.applyConfig({ __v: 1, __view: 'merge3', showFilter: 'all' })
    expect(v.getShowFilter()).toBe('all')
  })

  it('rejects an unknown filter mode without disturbing the current one', () => {
    const v = new ThreeWayCompare()
    v.applyConfig({ showFilter: 'mergeable' })
    v.applyConfig({ showFilter: 'bogus' })
    expect(v.getShowFilter()).toBe('mergeable')
  })

  it('applies a filter to the mounted panes on load', () => {
    const { view, host } = mountView(SMALL)
    view.applyConfig({ showFilter: 'unchanged' })
    expect(view.getPaneRows('left').length).toBe(6)
    expect(host.querySelector('.mw-filter-select').value).toBe('unchanged')
    view.destroy(); host.remove()
  })

  it('captures no paths or contents', () => {
    const { view, host } = mountView(SMALL)
    view.setShowFilter('changes')
    view.setAlgorithm('patience')
    const snap = JSON.stringify(view.getConfig())
    expect(snap).not.toContain('b0')
    expect(snap).toContain('changes')
    expect(snap).toContain('patience')
    view.destroy(); host.remove()
  })
})
