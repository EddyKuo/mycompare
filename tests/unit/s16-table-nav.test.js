/**
 * @vitest-environment jsdom
 *
 * S16 — table-compare navigation suite.
 *
 * Covers:
 *   - findCellMatches()   search hits: case sensitivity, no-hit, both sides, ordering
 *   - diffRowIndices()    row-level difference index
 *   - stepIndexClamped()  difference navigation (clamped, like text-compare)
 *   - stepIndexWrapped()  find navigation (wrap-around, like text-compare)
 *   - TableCompare        nextDifference/prevDifference/first/last, swap(),
 *                         find highlighting through the virtual-scroll window
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { setActiveView } from '../../src/renderer/src/core/active-view.js'
import {
  TableCompare,
  findCellMatches,
  diffRowIndices,
  stepIndexClamped,
  stepIndexWrapped,
} from '../../src/renderer/src/views/table-compare.js'

const LEFT_CSV = [
  'id,name,city',
  '1,Alice,Taipei',
  '2,Bob,Tokyo',
  '3,Carol,Osaka',
].join('\n')

const RIGHT_CSV = [
  'id,name,city',
  '1,Alice,Taipei',
  '2,Bobby,Tokyo',
  '4,Dave,Kyoto',
].join('\n')

/** @returns {import('../../src/renderer/src/views/table-compare.js').TableCompare} */
function makeLoaded() {
  const tc = new TableCompare({ hasHeader: true, keyColumn: 0 })
  tc.setLeft('L.csv', LEFT_CSV)
  tc.setRight('R.csv', RIGHT_CSV)
  return tc
}

// ── Pure: findCellMatches ─────────────────────────────────────────────────────

describe('findCellMatches()', () => {
  /** @type {import('../../src/renderer/src/views/table-compare.js').AlignedRow[]} */
  let rows

  beforeEach(() => {
    rows = makeLoaded()._visibleRows
  })

  it('returns [] for an empty query', () => {
    expect(findCellMatches(rows, '')).toEqual([])
  })

  it('returns [] when nothing matches', () => {
    expect(findCellMatches(rows, 'zzz-nope')).toEqual([])
  })

  it('is case-insensitive by default', () => {
    const hits = findCellMatches(rows, 'bob')
    expect(hits).toHaveLength(2)
    expect(hits.map((h) => h.side)).toEqual(['left', 'right'])
  })

  it('honours the case-sensitive flag', () => {
    expect(findCellMatches(rows, 'bob', true)).toEqual([])
    expect(findCellMatches(rows, 'Bob', true)).toHaveLength(2)
  })

  it('finds hits on both sides of the same row and reports left before right', () => {
    const hits = findCellMatches(rows, 'Taipei')
    expect(hits).toEqual([
      { rowIndex: 0, side: 'left', col: 2 },
      { rowIndex: 0, side: 'right', col: 2 },
    ])
  })

  it('skips the phantom half of an orphan row', () => {
    const hits = findCellMatches(rows, 'Carol')
    expect(hits).toEqual([{ rowIndex: 2, side: 'left', col: 1 }])
  })

  it('walks rows in order', () => {
    const hits = findCellMatches(rows, 'o')
    const seen = hits.map((h) => h.rowIndex)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })
})

// ── Pure: diffRowIndices ──────────────────────────────────────────────────────

describe('diffRowIndices()', () => {
  it('lists only non-same rows', () => {
    const rows = makeLoaded()._visibleRows
    expect(rows.map((r) => r.status)).toEqual(['same', 'different', 'left-only', 'right-only'])
    expect(diffRowIndices(rows)).toEqual([1, 2, 3])
  })

  it('returns [] when everything matches', () => {
    const tc = new TableCompare({ hasHeader: true, keyColumn: 0 })
    tc.setLeft('L.csv', LEFT_CSV)
    tc.setRight('R.csv', LEFT_CSV)
    expect(diffRowIndices(tc._visibleRows)).toEqual([])
  })

  it('returns [] for no rows', () => {
    expect(diffRowIndices([])).toEqual([])
  })
})

// ── Pure: step helpers ────────────────────────────────────────────────────────

describe('stepIndexClamped()', () => {
  it('advances and retreats within range', () => {
    expect(stepIndexClamped(1, 5, 1)).toBe(2)
    expect(stepIndexClamped(1, 5, -1)).toBe(0)
  })

  it('stops at both ends instead of wrapping', () => {
    expect(stepIndexClamped(4, 5, 1)).toBe(4)
    expect(stepIndexClamped(0, 5, -1)).toBe(0)
  })

  it('reports -1 when there is nothing to navigate', () => {
    expect(stepIndexClamped(0, 0, 1)).toBe(-1)
  })
})

describe('stepIndexWrapped()', () => {
  it('wraps forward past the end', () => {
    expect(stepIndexWrapped(4, 5, 1)).toBe(0)
  })

  it('wraps backward past the start', () => {
    expect(stepIndexWrapped(0, 5, -1)).toBe(4)
  })

  it('handles an unset current index', () => {
    expect(stepIndexWrapped(-1, 3, 1)).toBe(0)
  })

  it('reports -1 when there is nothing to navigate', () => {
    expect(stepIndexWrapped(0, 0, 1)).toBe(-1)
  })
})

// ── Difference navigation ─────────────────────────────────────────────────────

describe('TableCompare difference navigation', () => {
  it('walks the difference rows and clamps at both ends', () => {
    const tc = makeLoaded()
    expect(tc._diffRows).toEqual([1, 2, 3])

    tc.firstDifference()
    expect(tc._currentDiffIdx).toBe(0)

    tc.prevDifference()
    expect(tc._currentDiffIdx).toBe(0)

    tc.nextDifference()
    tc.nextDifference()
    expect(tc._currentDiffIdx).toBe(2)

    tc.nextDifference()
    expect(tc._currentDiffIdx).toBe(2)

    tc.lastDifference()
    expect(tc._currentDiffIdx).toBe(2)
  })

  it('is a no-op when there are no differences', () => {
    const tc = new TableCompare({ hasHeader: true, keyColumn: 0 })
    tc.setLeft('L.csv', LEFT_CSV)
    tc.setRight('R.csv', LEFT_CSV)
    tc.nextDifference()
    tc.lastDifference()
    expect(tc._diffRows).toEqual([])
    expect(tc._currentDiffIdx).toBe(0)
  })

  it('never leaves the current index past the end after a re-compare', () => {
    const tc = makeLoaded()
    tc.lastDifference()
    expect(tc._currentDiffIdx).toBe(2)
    tc.setRight('R.csv', LEFT_CSV)
    expect(tc._diffRows).toEqual([])
    expect(tc._currentDiffIdx).toBe(0)
  })
})

// ── swap() ────────────────────────────────────────────────────────────────────

describe('TableCompare.swap()', () => {
  it('exchanges every paired side state and re-compares', () => {
    const tc = makeLoaded()
    const beforeHeaders = tc._leftHeaders

    tc.swap()

    expect(tc._leftPath).toBe('R.csv')
    expect(tc._rightPath).toBe('L.csv')
    expect(tc._leftContent).toBe(RIGHT_CSV)
    expect(tc._rightContent).toBe(LEFT_CSV)
    expect(tc._leftParsed[1]).toEqual(['1', 'Alice', 'Taipei'])
    expect(tc._rightParsed[3]).toEqual(['3', 'Carol', 'Osaka'])
    expect(beforeHeaders).toEqual(tc._rightHeaders)

    // Orphan sides invert; the shared rows keep their status.
    expect(tc._visibleRows.map((r) => r.status))
      .toEqual(['same', 'different', 'left-only', 'right-only'])
    expect(tc._visibleRows[2].leftRow).toEqual(['4', 'Dave', 'Kyoto'])
    expect(tc._visibleRows[3].rightRow).toEqual(['3', 'Carol', 'Osaka'])
  })

  it('resets difference navigation and emits paths-changed', () => {
    const tc = makeLoaded()
    /** @type {unknown[]} */
    const events = []
    tc.on('paths-changed', (p) => events.push(p))

    tc.lastDifference()
    tc.swap()

    expect(tc._currentDiffIdx).toBe(0)
    expect(events).toEqual([{ left: 'R.csv', right: 'L.csv' }])
  })

  it('round-trips back to the original state', () => {
    const tc = makeLoaded()
    tc.swap()
    tc.swap()
    expect(tc._leftPath).toBe('L.csv')
    expect(tc._leftContent).toBe(LEFT_CSV)
    expect(tc._rightContent).toBe(RIGHT_CSV)
  })
})

// ── Find through the virtual-scroll window ────────────────────────────────────

describe('TableCompare find (mounted)', () => {
  /** @type {HTMLElement} */
  let host
  /** @type {import('../../src/renderer/src/views/table-compare.js').TableCompare} */
  let tc

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    setActiveView('table')
    tc = new TableCompare({ hasHeader: true, keyColumn: 0 })
    tc.mount(host)
    tc.setLeft('L.csv', LEFT_CSV)
    tc.setRight('R.csv', RIGHT_CSV)
  })

  afterEach(() => {
    tc.destroy()
    host.remove()
    setActiveView('home')
  })

  /**
   * @param {string} query
   */
  function type(query) {
    tc._dom.findInput.value = query
    tc._dom.findInput.dispatchEvent(new Event('input'))
  }

  it('opens on Ctrl+F and closes on the close button', () => {
    expect(tc._dom.findBar.style.display).toBe('none')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))
    expect(tc._dom.findBar.style.display).toBe('flex')
    tc._dom.btnFindClose.click()
    expect(tc._dom.findBar.style.display).toBe('none')
  })

  it('marks hits inside the rendered window and reports the count', () => {
    type('bob')
    expect(tc._findMatches).toHaveLength(2)
    expect(tc._dom.findCount.textContent).toBe('第 1 / 2 筆')

    const leftCell = tc._dom.leftTbody.children[1].children[2]
    expect(leftCell.classList.contains('tc-cell--match')).toBe(true)
    expect(leftCell.classList.contains('tc-cell--match-current')).toBe(true)
  })

  it('moves the current mark on findNext and wraps around', () => {
    type('bob')
    tc.findNext()
    expect(tc._dom.findCount.textContent).toBe('第 2 / 2 筆')

    const leftCell = tc._dom.leftTbody.children[1].children[2]
    const rightCell = tc._dom.rightTbody.children[1].children[2]
    expect(leftCell.classList.contains('tc-cell--match')).toBe(true)
    expect(leftCell.classList.contains('tc-cell--match-current')).toBe(false)
    expect(rightCell.classList.contains('tc-cell--match-current')).toBe(true)

    tc.findNext()
    expect(tc._findCurrentIdx).toBe(0)
  })

  it('respects the case-sensitive toggle', () => {
    tc._dom.cbFindCase.checked = true
    tc._dom.cbFindCase.dispatchEvent(new Event('change'))
    type('bob')
    expect(tc._findMatches).toHaveLength(0)
    expect(tc._dom.findCount.textContent).toBe('無相符')
  })

  it('drops all marks when the find bar is closed', () => {
    type('bob')
    tc.closeFind()
    expect(tc._findMatches).toHaveLength(0)
    expect(host.querySelectorAll('.tc-cell--match')).toHaveLength(0)
  })

  it('re-indexes matches after a swap so marks land on the new side', () => {
    type('Carol')
    expect(tc._findMatches).toEqual([{ rowIndex: 2, side: 'left', col: 1 }])
    tc.swap()
    expect(tc._findMatches).toEqual([{ rowIndex: 3, side: 'right', col: 1 }])
  })
})
