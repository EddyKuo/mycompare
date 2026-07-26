/**
 * @vitest-environment jsdom
 *
 * Sprint 16 — 3-Way Merge conflict navigation, filtering, Take Center
 * and batch resolve.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  ThreeWayCompare,
  collectConflictIds,
  wrapConflictIndex,
  filterSegmentsForConflicts,
  buildMergedText,
  segmentsToPaneLines,
} from '../../src/renderer/src/views/three-way-compare.js'

/** Base / left / right that produce exactly two conflicting hunks. */
const BASE  = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
const LEFT  = ['a', 'L1', 'c', 'd', 'e', 'L2', 'g'].join('\n')
const RIGHT = ['a', 'R1', 'c', 'd', 'e', 'R2', 'g'].join('\n')

/**
 * @param {{ left?: string, base?: string, right?: string }} [contents]
 * @returns {{ view: ThreeWayCompare, host: HTMLElement }}
 */
function mountView(contents = {}) {
  // Kept out of document.body on purpose: several instances coexist across
  // tests and jsdom's `#id` lookup resolves duplicates document-wide.
  const host = document.createElement('div')
  const view = new ThreeWayCompare()
  view.mount(host)
  view.setSide('base', contents.base ?? BASE)
  view.setSide('left', contents.left ?? LEFT)
  view.setSide('right', contents.right ?? RIGHT)
  return { view, host }
}

describe('S16 merge3 — pure helpers', () => {
  const segments = [
    { type: 'normal', lines: ['a', 'b', 'c', 'd'] },
    { type: 'conflict', id: 0, leftLines: ['L'], baseLines: ['B'], rightLines: ['R'] },
    { type: 'normal', lines: ['e', 'f', 'g', 'h', 'i'] },
    { type: 'conflict', id: 1, leftLines: ['L2'], baseLines: ['B2'], rightLines: ['R2'] },
    { type: 'normal', lines: ['x', 'y', 'z'] },
  ]

  it('collectConflictIds returns ids in document order', () => {
    expect(collectConflictIds(segments)).toEqual([0, 1])
    expect(collectConflictIds([])).toEqual([])
    expect(collectConflictIds(null)).toEqual([])
  })

  it('wrapConflictIndex wraps in both directions', () => {
    expect(wrapConflictIndex(-1, 1, 3)).toBe(0)
    expect(wrapConflictIndex(-1, -1, 3)).toBe(2)
    expect(wrapConflictIndex(2, 1, 3)).toBe(0)
    expect(wrapConflictIndex(0, -1, 3)).toBe(2)
    expect(wrapConflictIndex(1, 1, 3)).toBe(2)
  })

  it('wrapConflictIndex returns -1 when there is nothing to select', () => {
    expect(wrapConflictIndex(-1, 1, 0)).toBe(-1)
    expect(wrapConflictIndex(0, -1, 0)).toBe(-1)
    expect(wrapConflictIndex(0, 1, NaN)).toBe(-1)
  })

  it('filterSegmentsForConflicts keeps conflicts plus limited context', () => {
    const out = filterSegmentsForConflicts(segments, 2)
    expect(out.map(s => s.type)).toEqual(['normal', 'conflict', 'normal', 'conflict', 'normal'])
    expect(out[0].lines).toEqual(['c', 'd'])          // tail context before conflict 0
    expect(out[2].lines).toEqual(['e', 'f', 'h', 'i']) // head + tail around both conflicts
    expect(out[4].lines).toEqual(['x', 'y'])          // head context after conflict 1
  })

  it('filterSegmentsForConflicts drops normals not adjacent to a conflict', () => {
    const out = filterSegmentsForConflicts([{ type: 'normal', lines: ['a', 'b'] }])
    expect(out).toEqual([])
  })

  it('buildMergedText honours every choice including base', () => {
    const one = [{ type: 'conflict', id: 0, leftLines: ['L'], baseLines: ['B'], rightLines: ['R'] }]
    expect(buildMergedText(one, new Map([[0, 'left']]))).toBe('L')
    expect(buildMergedText(one, new Map([[0, 'right']]))).toBe('R')
    expect(buildMergedText(one, new Map([[0, 'base']]))).toBe('B')
    expect(buildMergedText(one, new Map([[0, 'both']]))).toBe('L\nR')
    expect(buildMergedText(one, new Map([[0, null]]))).toContain('<<<<<<< LEFT')
  })

  it('segmentsToPaneLines flattens per side and flags conflict lines', () => {
    expect(segmentsToPaneLines(segments, 'base').filter(l => l.conflict).map(l => l.text))
      .toEqual(['B', 'B2'])
    expect(segmentsToPaneLines(segments, 'left').filter(l => l.conflict).map(l => l.text))
      .toEqual(['L', 'L2'])
  })
})

describe('S16 merge3 — conflict navigation', () => {
  /** @type {ThreeWayCompare} */
  let view
  /** @type {HTMLElement} */
  let host

  beforeEach(() => { ({ view, host } = mountView()) })
  afterEach(() => { view.destroy(); host.remove() })

  it('detects two conflicts and starts with no cursor', () => {
    expect(view.getConflictCount()).toBe(2)
    expect(view.getCurrentConflictIndex()).toBe(-1)
  })

  it('next/prev wrap around', () => {
    expect(view.nextConflict()).toBe(0)
    expect(view.nextConflict()).toBe(1)
    expect(view.nextConflict()).toBe(0) // wrapped
    expect(view.prevConflict()).toBe(1) // wrapped backwards
  })

  it('prev from a fresh cursor selects the last conflict', () => {
    expect(view.prevConflict()).toBe(1)
  })

  it('first/last jump to the ends', () => {
    expect(view.lastConflict()).toBe(1)
    expect(view.firstConflict()).toBe(0)
  })

  it('highlights only the current conflict card', () => {
    view.nextConflict()
    const current = host.querySelectorAll('.mw-conflict-card--current')
    expect(current.length).toBe(1)
    expect(current[0].dataset.conflictId).toBe('0')

    view.nextConflict()
    expect(host.querySelectorAll('.mw-conflict-card--current').length).toBe(1)
    expect(host.querySelector('.mw-conflict-card--current').dataset.conflictId).toBe('1')
  })

  it('keeps the highlight after a choice re-renders the cards', () => {
    view.nextConflict()
    view.setConflictChoice(0, 'base')
    expect(host.querySelector('.mw-conflict-card--current')?.dataset.conflictId).toBe('0')
  })

  it('updates the toolbar counter', () => {
    const counter = host.querySelector('#mw-conflict-counter')
    expect(counter.textContent).toContain('/ 2')
    view.nextConflict()
    expect(counter.textContent).toBe('第 1 / 2 個衝突')
  })

  it('toolbar ▲▼ buttons drive navigation', () => {
    host.querySelector('#mw-btn-next').click()
    expect(view.getCurrentConflictIndex()).toBe(0)
    host.querySelector('#mw-btn-prev').click()
    expect(view.getCurrentConflictIndex()).toBe(1)
  })

  it('does not throw when there are no conflicts', () => {
    const { view: clean, host: cleanHost } = mountView({
      base: 'a\nb\nc', left: 'a\nb\nc', right: 'a\nb\nc',
    })
    expect(clean.getConflictCount()).toBe(0)
    expect(clean.nextConflict()).toBe(-1)
    expect(clean.prevConflict()).toBe(-1)
    expect(clean.firstConflict()).toBe(-1)
    expect(clean.lastConflict()).toBe(-1)
    expect(cleanHost.querySelector('#mw-conflict-counter').textContent).toBe('無衝突')
    expect(clean.resolveAll('left')).toBe(0)
    clean.destroy()
    cleanHost.remove()
  })

  it('does not throw when every pane is empty', () => {
    const { view: empty, host: emptyHost } = mountView({ base: '', left: '', right: '' })
    expect(() => { empty.nextConflict(); empty.setShowFilter('conflicts') }).not.toThrow()
    empty.destroy()
    emptyHost.remove()
  })
})

describe('S16 merge3 — Take Center', () => {
  it('採用中間 button writes the base lines into the output', () => {
    const { view, host } = mountView()
    const btn = host.querySelector('.mw-conflict-card[data-conflict-id="0"] .mw-choice-base')
    expect(btn.textContent).toBe('採用中間')
    btn.click()

    const output = host.querySelector('#mw-output').value
    expect(output).toContain('\nb\n')       // base version of conflict 0
    expect(output).not.toContain('L1')
    expect(output).not.toContain('R1')
    expect(output).toContain('<<<<<<< LEFT') // conflict 1 still unresolved
    view.destroy(); host.remove()
  })

  it('marks the base button active and clears sibling choices', () => {
    const { view, host } = mountView()
    const card = host.querySelector('.mw-conflict-card[data-conflict-id="0"]')
    card.querySelector('.mw-choice-left').click()
    card.querySelector('.mw-choice-base').click()
    const active = host.querySelector('.mw-conflict-card[data-conflict-id="0"] .mw-choice-btn.active')
    expect(active.classList.contains('mw-choice-base')).toBe(true)
    view.destroy(); host.remove()
  })
})

describe('S16 merge3 — resolveAll', () => {
  it('applies one choice to all conflicts', () => {
    const { view, host } = mountView()
    expect(view.resolveAll('right')).toBe(2)
    const output = host.querySelector('#mw-output').value
    expect(output).toBe(['a', 'R1', 'c', 'd', 'e', 'R2', 'g'].join('\n'))
    expect(output).not.toContain('<<<<<<<')
    view.destroy(); host.remove()
  })

  it('resolveAll("base") restores the base text', () => {
    const { view, host } = mountView()
    view.resolveAll('base')
    expect(host.querySelector('#mw-output').value).toBe(BASE)
    view.destroy(); host.remove()
  })

  it('leaves already-resolved conflicts untouched', () => {
    const { view, host } = mountView()
    view.setConflictChoice(0, 'left')
    expect(view.resolveAll('right')).toBe(1)
    expect(host.querySelector('#mw-output').value)
      .toBe(['a', 'L1', 'c', 'd', 'e', 'R2', 'g'].join('\n'))
    view.destroy(); host.remove()
  })

  it('ignores an unknown choice', () => {
    const { view, host } = mountView()
    expect(view.resolveAll(/** @type {'left'} */ ('nope'))).toBe(0)
    expect(host.querySelector('#mw-output').value).toContain('<<<<<<<')
    view.destroy(); host.remove()
  })

  it('toolbar batch buttons resolve everything', () => {
    const { view, host } = mountView()
    host.querySelector('#mw-btn-all-left').click()
    expect(host.querySelector('#mw-output').value).toBe(LEFT)
    view.destroy(); host.remove()
  })
})

describe('S16 merge3 — show filter', () => {
  it('conflicts mode renders far fewer lines than all mode', () => {
    const { view, host } = mountView({
      base: Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n'),
      left: Array.from({ length: 40 }, (_, i) => (i === 20 ? 'LEFT!' : `line${i}`)).join('\n'),
      right: Array.from({ length: 40 }, (_, i) => (i === 20 ? 'RIGHT!' : `line${i}`)).join('\n'),
    })
    expect(view.getConflictCount()).toBe(1)

    const allCount = host.querySelectorAll('#mw-content-left .mw-line').length
    view.setShowFilter('conflicts')
    expect(view.getShowFilter()).toBe('conflicts')
    const filteredCount = host.querySelectorAll('#mw-content-left .mw-line').length
    expect(filteredCount).toBeLessThan(allCount)
    expect(filteredCount).toBe(5) // 2 context + 1 conflict line + 2 context
    expect(host.querySelectorAll('#mw-content-left .mw-line--conflict').length).toBe(1)

    view.setShowFilter('all')
    expect(host.querySelectorAll('#mw-content-left .mw-line').length).toBe(allCount)
    view.destroy(); host.remove()
  })

  it('filter button toggles label and state', () => {
    const { view, host } = mountView()
    const btn = host.querySelector('#mw-btn-filter')
    expect(btn.textContent).toBe('顯示：全部')
    btn.click()
    expect(view.getShowFilter()).toBe('conflicts')
    expect(btn.textContent).toBe('顯示：僅衝突')
    expect(btn.classList.contains('active')).toBe(true)
    btn.click()
    expect(view.getShowFilter()).toBe('all')
    view.destroy(); host.remove()
  })

  it('ignores an invalid filter mode', () => {
    const { view, host } = mountView()
    view.setShowFilter(/** @type {'all'} */ ('bogus'))
    expect(view.getShowFilter()).toBe('all')
    view.destroy(); host.remove()
  })
})
