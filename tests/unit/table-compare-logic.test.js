/**
 * Unit tests for table-compare.js — pure logic functions and TableCompare methods.
 *
 * Environment: node (no DOM needed for pure logic; TableCompare getStats() is
 * also tested here via a minimal stub instance).
 *
 * Test coverage:
 *   - parseTable()          (existing path; sanity checks)
 *   - alignRows()           (existing path)
 *   - computeRowStatus()    (existing path)
 *   - T15 sort logic        — sort-before-compare aligns out-of-order rows
 *   - T22 getStats()        — returns correct counts and columnDiffCounts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Module-level mock setup ───────────────────────────────────────────────────
// table-compare.js calls document.createElement etc. in _injectStyle / _render.
// We only import the named pure-function exports, so we don't need a full DOM.
// However the module top-level code does NOT call DOM APIs on import — the class
// constructor is side-effect free, so we can safely import in node env.

// Provide a minimal window stub so the module doesn't crash on parse.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    electronAPI: { saveFile: vi.fn(), openFile: vi.fn() },
    alert: vi.fn(),
  }
} else {
  globalThis.window.electronAPI = globalThis.window.electronAPI ?? {
    saveFile: vi.fn(),
    openFile: vi.fn(),
  }
  globalThis.window.alert = globalThis.window.alert ?? vi.fn()
}

// Stub minimal document APIs needed by the TableCompare constructor
// (constructor itself doesn't touch DOM, but we add a guard anyway)
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: vi.fn(() => ({
      className: '',
      appendChild: vi.fn(),
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
    })),
    createTextNode: vi.fn(() => ({})),
    head: { appendChild: vi.fn() },
  }
}

// ── Import under test ─────────────────────────────────────────────────────────

const {
  parseTable,
  alignRows,
  computeRowStatus,
  computeCellDiffs,
  TableCompare,
} = await import('../../src/renderer/src/views/table-compare.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal TableCompare instance with _alignedRows pre-populated,
 * bypassing the DOM entirely.
 *
 * @param {import('../../src/renderer/src/views/table-compare.js').AlignedRow[]} alignedRows
 * @param {{ hasHeader?: boolean, leftHeaders?: string[]|null, leftParsed?: string[][]|null }} [opts]
 * @returns {InstanceType<typeof TableCompare>}
 */
function makeStubTC(alignedRows, opts = {}) {
  const tc = new TableCompare({ hasHeader: opts.hasHeader ?? false })
  tc._alignedRows      = alignedRows
  tc._lastCompareTime  = opts.compareTime ?? 1000
  tc._leftHeaders      = opts.leftHeaders  ?? null
  tc._rightHeaders     = opts.leftHeaders  ?? null   // same headers for simplicity
  tc._leftParsed       = opts.leftParsed   ?? null
  tc._rightParsed      = opts.leftParsed   ?? null
  return tc
}

// ── parseTable ────────────────────────────────────────────────────────────────

describe('parseTable', () => {
  it('should parse simple CSV', () => {
    const result = parseTable('a,b,c\n1,2,3')
    expect(result).toEqual([['a','b','c'],['1','2','3']])
  })

  it('should parse TSV when tab present in first line', () => {
    const result = parseTable('a\tb\tc\n1\t2\t3')
    expect(result).toEqual([['a','b','c'],['1','2','3']])
  })

  it('should handle quoted fields containing commas', () => {
    const result = parseTable('"hello, world",2')
    expect(result).toEqual([['hello, world','2']])
  })

  it('should skip empty trailing line', () => {
    const result = parseTable('a,b\n1,2\n')
    expect(result).toEqual([['a','b'],['1','2']])
  })
})

// ── computeRowStatus ──────────────────────────────────────────────────────────

describe('computeRowStatus', () => {
  it('should return same for identical rows', () => {
    expect(computeRowStatus(['a','b'], ['a','b'])).toBe('same')
  })

  it('should return different when cells differ', () => {
    expect(computeRowStatus(['a','b'], ['a','X'])).toBe('different')
  })

  it('should return left-only when right is null', () => {
    expect(computeRowStatus(['a'], null)).toBe('left-only')
  })

  it('should return right-only when left is null', () => {
    expect(computeRowStatus(null, ['b'])).toBe('right-only')
  })
})

// ── T15: sort before compare ──────────────────────────────────────────────────

describe('T15 sort logic', () => {
  /**
   * Helper that exercises the same sorting logic as TableCompare._compare()
   * without needing a DOM-mounted instance.
   *
   * @param {string[][]} leftData
   * @param {string[][]} rightData
   * @param {number} keyCol  key column used for sorting AND alignRows
   * @returns {import('../../src/renderer/src/views/table-compare.js').AlignedRow[]}
   */
  function sortAndAlign(leftData, rightData, keyCol = 0) {
    const sortCol = keyCol >= 0 ? keyCol : 0
    const sortFn  = (a, b) => {
      const av = a[sortCol] ?? ''
      const bv = b[sortCol] ?? ''
      return av < bv ? -1 : av > bv ? 1 : 0
    }
    const sortedLeft  = leftData.slice().sort(sortFn)
    const sortedRight = rightData.slice().sort(sortFn)
    return alignRows(sortedLeft, sortedRight, keyCol, null, null, false)
  }

  it('should produce all-same after sorting when rows are in different order (key col 0)', () => {
    const leftData  = [['b','2'],['a','1']]
    const rightData = [['a','1'],['b','2']]

    const aligned = sortAndAlign(leftData, rightData, 0)
    expect(aligned.every(r => r.status === 'same')).toBe(true)
  })

  it('should produce all-same after sorting with three rows out of order', () => {
    const leftData  = [['c','3'],['a','1'],['b','2']]
    const rightData = [['b','2'],['c','3'],['a','1']]

    const aligned = sortAndAlign(leftData, rightData, 0)
    expect(aligned.length).toBe(3)
    expect(aligned.every(r => r.status === 'same')).toBe(true)
  })

  it('should NOT produce all-same without sorting when rows are out of order (baseline check)', () => {
    const leftData  = [['b','2'],['a','1']]
    const rightData = [['a','1'],['b','2']]

    // Without sorting, align by position → rows differ
    const aligned = alignRows(leftData, rightData, -1, null, null, false)
    expect(aligned.some(r => r.status === 'different')).toBe(true)
  })

  it('should still detect actual differences after sorting', () => {
    const leftData  = [['a','1'],['b','2']]
    const rightData = [['b','X'],['a','1']]   // 'b' row has different value

    const aligned = sortAndAlign(leftData, rightData, 0)
    const bRow = aligned.find(r => r.leftRow?.[0] === 'b' || r.rightRow?.[0] === 'b')
    expect(bRow?.status).toBe('different')
  })

  it('should handle sort with keyColumn=-1 by using col 0 as sort key', () => {
    const leftData  = [['b','2'],['a','1']]
    const rightData = [['a','1'],['b','2']]

    // keyCol=-1 → positional align after sort-by-col-0
    const aligned = sortAndAlign(leftData, rightData, -1)
    expect(aligned.every(r => r.status === 'same')).toBe(true)
  })
})

// ── T22: getStats() ───────────────────────────────────────────────────────────

describe('T22 getStats()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should return zero counts when no rows', () => {
    const tc = makeStubTC([])
    const s = tc.getStats()
    expect(s.total).toBe(0)
    expect(s.same).toBe(0)
    expect(s.different).toBe(0)
    expect(s.leftOnly).toBe(0)
    expect(s.rightOnly).toBe(0)
    expect(s.columnDiffCounts).toEqual({})
  })

  it('should count same, different, leftOnly, rightOnly correctly', () => {
    const rows = [
      { status: 'same',       leftRow: ['a'], rightRow: ['a'], leftIdx: 0, rightIdx: 0 },
      { status: 'same',       leftRow: ['b'], rightRow: ['b'], leftIdx: 1, rightIdx: 1 },
      { status: 'different',  leftRow: ['c','1'], rightRow: ['c','2'], leftIdx: 2, rightIdx: 2 },
      { status: 'left-only',  leftRow: ['d'], rightRow: null, leftIdx: 3, rightIdx: -1 },
      { status: 'right-only', leftRow: null, rightRow: ['e'], leftIdx: -1, rightIdx: 3 },
    ]
    const tc = makeStubTC(rows, {
      leftParsed: [['col0','col1'], ['a','-'], ['b','-'], ['c','1'], ['d','-']],
    })
    const s = tc.getStats()
    expect(s.total).toBe(5)
    expect(s.same).toBe(2)
    expect(s.different).toBe(1)
    expect(s.leftOnly).toBe(1)
    expect(s.rightOnly).toBe(1)
  })

  it('should populate columnDiffCounts for named columns (hasHeader=true)', () => {
    const rows = [
      { status: 'different', leftRow: ['X','same','diff1'], rightRow: ['X','same','diff2'], leftIdx: 0, rightIdx: 0 },
      { status: 'different', leftRow: ['Y','diff3','same'], rightRow: ['Y','diff4','same'], leftIdx: 1, rightIdx: 1 },
    ]
    const tc = makeStubTC(rows, {
      hasHeader:   true,
      leftHeaders: ['id','name','value'],
      leftParsed:  [['id','name','value'], ['X','same','diff1'], ['Y','diff3','same']],
    })
    const s = tc.getStats()
    // column 'value' differs in row 0, column 'name' differs in row 1
    expect(s.columnDiffCounts['value']).toBe(1)
    expect(s.columnDiffCounts['name']).toBe(1)
    expect(s.columnDiffCounts['id']).toBeUndefined()
  })

  it('should use col0/col1 names when hasHeader=false', () => {
    const rows = [
      { status: 'different', leftRow: ['a','X'], rightRow: ['a','Y'], leftIdx: 0, rightIdx: 0 },
    ]
    const tc = makeStubTC(rows, { hasHeader: false, leftParsed: [['a','X']] })
    const s = tc.getStats()
    // no headers → key is 'col1' (zero-based index 1)
    expect(s.columnDiffCounts['col1']).toBe(1)
    expect(s.columnDiffCounts['col0']).toBeUndefined()
  })

  it('should return the stored compareTime', () => {
    const tc = makeStubTC([], { compareTime: 1718000000000 })
    expect(tc.getStats().compareTime).toBe(1718000000000)
  })

  it('should accumulate counts across multiple different rows with same column', () => {
    const rows = [
      { status: 'different', leftRow: ['A','1'], rightRow: ['A','2'], leftIdx: 0, rightIdx: 0 },
      { status: 'different', leftRow: ['B','3'], rightRow: ['B','4'], leftIdx: 1, rightIdx: 1 },
      { status: 'different', leftRow: ['C','5'], rightRow: ['C','6'], leftIdx: 2, rightIdx: 2 },
    ]
    const tc = makeStubTC(rows, {
      hasHeader:   true,
      leftHeaders: ['key','amount'],
      leftParsed:  [['key','amount'], ['A','1'], ['B','3'], ['C','5']],
    })
    const s = tc.getStats()
    expect(s.columnDiffCounts['amount']).toBe(3)
    expect(s.different).toBe(3)
  })
})
