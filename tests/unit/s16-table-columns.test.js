/**
 * @vitest-environment jsdom
 *
 * S16 — table-compare column handling suite.
 *
 * Covers:
 *   - parseNumericValue()     numeric parsing and its rejections
 *   - parseDateValue()        multiple date formats, timezone independence
 *   - cellsEqual()            numeric/date tolerance, ignore mode, string fallback
 *   - normaliseKeyColumns()   single-number backward compatibility + multi-column
 *   - buildRowKey()           composite keys and canonical numeric/date forms
 *   - measureColumnWidths()   resize-to-fit sizing from a sampled row set
 *   - alignRows()             ignored columns, tolerant columns, composite keys
 *   - TableCompare            setColumnRule / setKeyColumns / resizeColumnsToFit
 */

import { describe, it, expect } from 'vitest'

import {
  TableCompare,
  parseNumericValue,
  parseDateValue,
  cellsEqual,
  columnRuleAt,
  normaliseKeyColumns,
  buildRowKey,
  measureColumnWidths,
  alignRows,
  computeRowStatus,
  computeCellDiffs,
  DEFAULT_COLUMN_RULE,
} from '../../src/renderer/src/views/table-compare.js'

/**
 * @param {'text'|'numeric'|'date'|'ignore'} mode
 * @param {number} [tolerance]
 * @returns {{ mode: 'text'|'numeric'|'date'|'ignore', tolerance: number }}
 */
const rule = (mode, tolerance = 0) => ({ mode, tolerance })

// ── parseNumericValue ─────────────────────────────────────────────────────────

describe('parseNumericValue()', () => {
  it('parses integers, decimals, signs and exponents', () => {
    expect(parseNumericValue('100')).toBe(100)
    expect(parseNumericValue('100.00')).toBe(100)
    expect(parseNumericValue('-3.5')).toBe(-3.5)
    expect(parseNumericValue('+0.25')).toBe(0.25)
    expect(parseNumericValue('.5')).toBe(0.5)
    expect(parseNumericValue('1e3')).toBe(1000)
  })

  it('tolerates surrounding whitespace and thousands separators', () => {
    expect(parseNumericValue('  42 ')).toBe(42)
    expect(parseNumericValue('1,234.5')).toBe(1234.5)
  })

  it('rejects anything Number() would coerce loosely', () => {
    expect(parseNumericValue('')).toBeNull()
    expect(parseNumericValue('   ')).toBeNull()
    expect(parseNumericValue('abc')).toBeNull()
    expect(parseNumericValue('12abc')).toBeNull()
    expect(parseNumericValue('0x10')).toBeNull()
    expect(parseNumericValue('Infinity')).toBeNull()
    expect(parseNumericValue(null)).toBeNull()
    expect(parseNumericValue(undefined)).toBeNull()
  })
})

// ── parseDateValue ────────────────────────────────────────────────────────────

describe('parseDateValue()', () => {
  it('parses ISO, slash-ISO and US orderings to the same instant', () => {
    const iso = parseDateValue('2024-01-01')
    expect(iso).toBe(Date.UTC(2024, 0, 1))
    expect(parseDateValue('2024/01/01')).toBe(iso)
    expect(parseDateValue('01/01/2024')).toBe(iso)
    expect(parseDateValue('1/1/2024')).toBe(iso)
    expect(parseDateValue('01-01-2024')).toBe(iso)
  })

  it('distinguishes month and day in the US ordering', () => {
    expect(parseDateValue('03/04/2024')).toBe(Date.UTC(2024, 2, 4))
    expect(parseDateValue('2024-03-04')).toBe(Date.UTC(2024, 2, 4))
  })

  it('parses an optional time part after T or a space', () => {
    expect(parseDateValue('2024-01-01T10:30')).toBe(Date.UTC(2024, 0, 1, 10, 30))
    expect(parseDateValue('2024-01-01 10:30:15')).toBe(Date.UTC(2024, 0, 1, 10, 30, 15))
    expect(parseDateValue('2024-01-01T00:00:00Z')).toBe(Date.UTC(2024, 0, 1))
  })

  it('rejects malformed or overflowing dates instead of rolling them over', () => {
    expect(parseDateValue('2024-02-31')).toBeNull()
    expect(parseDateValue('2024-13-01')).toBeNull()
    expect(parseDateValue('not-a-date')).toBeNull()
    expect(parseDateValue('2024-01-01 25:00')).toBeNull()
    expect(parseDateValue('')).toBeNull()
    expect(parseDateValue(null)).toBeNull()
  })
})

// ── columnRuleAt ──────────────────────────────────────────────────────────────

describe('columnRuleAt()', () => {
  it('falls back to the default text rule', () => {
    expect(columnRuleAt(null, 0)).toEqual(DEFAULT_COLUMN_RULE)
    expect(columnRuleAt({}, 3)).toEqual(DEFAULT_COLUMN_RULE)
    expect(columnRuleAt({ 0: { mode: 'nonsense' } }, 0)).toEqual(DEFAULT_COLUMN_RULE)
  })

  it('normalises tolerance to a finite non-negative number', () => {
    expect(columnRuleAt({ 1: { mode: 'numeric' } }, 1)).toEqual({ mode: 'numeric', tolerance: 0 })
    expect(columnRuleAt({ 1: { mode: 'numeric', tolerance: -2 } }, 1).tolerance).toBe(2)
    expect(columnRuleAt({ 1: { mode: 'numeric', tolerance: 'x' } }, 1).tolerance).toBe(0)
  })
})

// ── cellsEqual ────────────────────────────────────────────────────────────────

describe('cellsEqual() — numeric', () => {
  it('treats differently formatted equal numbers as identical', () => {
    expect(cellsEqual('100', '100.0', rule('numeric'))).toBe(true)
    expect(cellsEqual('100', '100.00', rule('numeric'))).toBe(true)
    expect(cellsEqual('1,000', '1000', rule('numeric'))).toBe(true)
  })

  it('applies the tolerance inclusively', () => {
    expect(cellsEqual('100.00', '100.01', rule('numeric', 0.01))).toBe(true)
    expect(cellsEqual('100.00', '100.02', rule('numeric', 0.01))).toBe(false)
    expect(cellsEqual('100.00', '100.01', rule('numeric'))).toBe(false)
  })

  it('falls back to string comparison when a side cannot be parsed', () => {
    // A wide tolerance must not make unparseable text look equal.
    expect(cellsEqual('N/A', '100', rule('numeric', 1000))).toBe(false)
    expect(cellsEqual('N/A', 'N/A', rule('numeric', 1000))).toBe(true)
    expect(cellsEqual('N/A', 'n/a', rule('numeric', 1000))).toBe(false)
    expect(cellsEqual('', '0', rule('numeric', 1000))).toBe(false)
  })
})

describe('cellsEqual() — date', () => {
  it('treats different date formats of the same day as identical', () => {
    expect(cellsEqual('2024-01-01', '01/01/2024', rule('date'))).toBe(true)
    expect(cellsEqual('2024-01-01', '2024/01/01', rule('date'))).toBe(true)
  })

  it('applies the tolerance in seconds', () => {
    expect(cellsEqual('2024-01-01 00:00:00', '2024-01-01 00:00:30', rule('date', 60))).toBe(true)
    expect(cellsEqual('2024-01-01 00:00:00', '2024-01-01 00:02:00', rule('date', 60))).toBe(false)
    expect(cellsEqual('2024-01-01', '2024-01-02', rule('date', 86400))).toBe(true)
  })

  it('falls back to string comparison when a side cannot be parsed', () => {
    expect(cellsEqual('TBD', '2024-01-01', rule('date', 999999))).toBe(false)
    expect(cellsEqual('TBD', 'TBD', rule('date', 999999))).toBe(true)
  })
})

describe('cellsEqual() — text and ignore', () => {
  it('compares literally by default', () => {
    expect(cellsEqual('100', '100.0')).toBe(false)
    expect(cellsEqual('a', 'a')).toBe(true)
    expect(cellsEqual(undefined, '')).toBe(true)
  })

  it('reports ignored columns as always equal', () => {
    expect(cellsEqual('anything', 'else', rule('ignore'))).toBe(true)
  })
})

// ── normaliseKeyColumns ───────────────────────────────────────────────────────

describe('normaliseKeyColumns()', () => {
  it('keeps the legacy single-number form working', () => {
    expect(normaliseKeyColumns(0)).toEqual([0])
    expect(normaliseKeyColumns(2)).toEqual([2])
    expect(normaliseKeyColumns(-1)).toEqual([])
  })

  it('accepts multi-column arrays and preserves order', () => {
    expect(normaliseKeyColumns([0, 2])).toEqual([0, 2])
    expect(normaliseKeyColumns([2, 0])).toEqual([2, 0])
  })

  it('drops duplicates, negatives and non-integers', () => {
    expect(normaliseKeyColumns([0, 0, 1])).toEqual([0, 1])
    expect(normaliseKeyColumns([0, -1, 1.5, NaN, 2])).toEqual([0, 2])
    expect(normaliseKeyColumns(null)).toEqual([])
    expect(normaliseKeyColumns(undefined)).toEqual([])
  })

  it('parses string input from the toolbar field', () => {
    expect(normaliseKeyColumns(['0', ' 2 '])).toEqual([0, 2])
    expect(normaliseKeyColumns(['-1'])).toEqual([])
    expect(normaliseKeyColumns([''])).toEqual([])
  })
})

// ── buildRowKey ───────────────────────────────────────────────────────────────

describe('buildRowKey()', () => {
  it('combines several columns into one key', () => {
    const k = buildRowKey(['Amy', 'x', '2024-01-01'], [0, 2])
    expect(k).toBe(buildRowKey(['Amy', 'y', '2024-01-01'], [0, 2]))
    expect(k).not.toBe(buildRowKey(['Amy', 'x', '2024-01-02'], [0, 2]))
  })

  it('cannot be spoofed by a value containing the separator characters', () => {
    expect(buildRowKey(['a,b', 'c'], [0, 1])).not.toBe(buildRowKey(['a', 'b,c'], [0, 1]))
  })

  it('canonicalises numeric and date key columns', () => {
    const rules = { 0: rule('numeric'), 1: rule('date') }
    expect(buildRowKey(['100', '2024-01-01'], [0, 1], rules))
      .toBe(buildRowKey(['100.00', '01/01/2024'], [0, 1], rules))
  })

  it('keeps the raw text when the value does not parse', () => {
    const rules = { 0: rule('numeric') }
    expect(buildRowKey(['N/A'], [0], rules)).toBe('N/A')
  })

  it('returns an empty key for missing cells', () => {
    expect(buildRowKey(null, [0])).toBe('')
    expect(buildRowKey(['a'], [5])).toBe('')
  })
})

// ── measureColumnWidths ───────────────────────────────────────────────────────

describe('measureColumnWidths()', () => {
  const sample = [
    ['a', 'a-much-longer-cell-value'],
    ['bb', 'short'],
    null,
  ]

  it('sizes wider content to a wider column', () => {
    const w = measureColumnWidths(sample, 2)
    expect(w).toHaveLength(2)
    expect(w[1]).toBeGreaterThan(w[0])
  })

  it('clamps to the min/max bounds', () => {
    const w = measureColumnWidths(sample, 2, null, { min: 60, max: 80 })
    expect(w.every((x) => x >= 60 && x <= 80)).toBe(true)
  })

  it('accounts for the header text', () => {
    const withHeader = measureColumnWidths([['a']], 1, ['a-very-long-header-name'])
    const without = measureColumnWidths([['a']], 1, null)
    expect(withHeader[0]).toBeGreaterThan(without[0])
  })

  it('counts fullwidth glyphs as two cells', () => {
    const wide = measureColumnWidths([['中文字串']], 1, null, { max: 9999 })
    const narrow = measureColumnWidths([['abcd']], 1, null, { max: 9999 })
    expect(wide[0]).toBeGreaterThan(narrow[0])
  })

  it('only looks at the rows it is given', () => {
    // The caller samples the virtual window; a row outside it must not widen anything.
    const windowed = measureColumnWidths([['a']], 1, null, { max: 9999 })
    const full = measureColumnWidths([['a'], ['aaaaaaaaaaaaaaaaaaaa']], 1, null, { max: 9999 })
    expect(full[0]).toBeGreaterThan(windowed[0])
  })

  it('returns [] for zero columns', () => {
    expect(measureColumnWidths(sample, 0)).toEqual([])
  })
})

// ── computeRowStatus / computeCellDiffs with rules ────────────────────────────

describe('computeRowStatus() with column rules', () => {
  it('stays same when the only difference is inside the tolerance', () => {
    const rules = { 1: rule('numeric', 0.01) }
    expect(computeRowStatus(['a', '100.00'], ['a', '100.01'], rules)).toBe('same')
    expect(computeRowStatus(['a', '100.00'], ['a', '100.5'], rules)).toBe('different')
  })

  it('ignores columns marked ignore when deciding row status', () => {
    const rules = { 2: rule('ignore') }
    const left = ['1', 'Amy', '2024-01-01T09:00']
    const right = ['1', 'Amy', '2024-06-30T23:59']
    expect(computeRowStatus(left, right)).toBe('different')
    expect(computeRowStatus(left, right, rules)).toBe('same')
  })

  it('keeps the default two-argument behaviour', () => {
    expect(computeRowStatus(['a'], ['a'])).toBe('same')
    expect(computeRowStatus(['a'], ['b'])).toBe('different')
    expect(computeRowStatus(['a'], null)).toBe('left-only')
    expect(computeRowStatus(null, ['a'])).toBe('right-only')
  })
})

describe('computeCellDiffs() with column rules', () => {
  it('never marks an ignored column as a cell diff', () => {
    const rules = { 1: rule('ignore') }
    expect(computeCellDiffs(['a', 'x'], ['b', 'y'], 2, rules)).toEqual([true, false])
  })

  it('respects numeric tolerance per column', () => {
    const rules = { 0: rule('numeric', 0.5) }
    expect(computeCellDiffs(['1.2'], ['1.5'], 1, rules)).toEqual([false])
    expect(computeCellDiffs(['1.2'], ['9.9'], 1, rules)).toEqual([true])
  })
})

// ── alignRows ─────────────────────────────────────────────────────────────────

describe('alignRows() with column rules and composite keys', () => {
  it('aligns on a composite key when one column alone is ambiguous', () => {
    const left = [
      ['Amy', 'a', '2024-01-01'],
      ['Amy', 'b', '2024-02-01'],
    ]
    const right = [
      ['Amy', 'b', '2024-02-01'],
      ['Amy', 'a', '2024-01-01'],
    ]

    // Single-column key: both rows share key "Amy", so they pair by arrival
    // order and both look different.
    const single = alignRows(left, right, 0, null, null, false)
    expect(single.map((r) => r.status)).toEqual(['different', 'different'])

    // Composite key on name+date pairs them correctly.
    const composite = alignRows(left, right, [0, 2], null, null, false)
    expect(composite).toHaveLength(2)
    expect(composite.every((r) => r.status === 'same')).toBe(true)
  })

  it('still treats -1 as align-by-position', () => {
    const left = [['b'], ['a']]
    const right = [['b'], ['a']]
    const aligned = alignRows(left, right, -1, null, null, false)
    expect(aligned.map((r) => r.status)).toEqual(['same', 'same'])
  })

  it('matches key rows whose numeric key is formatted differently', () => {
    const rules = { 0: rule('numeric') }
    const left = [['100', 'x']]
    const right = [['100.00', 'x']]
    expect(alignRows(left, right, 0, null, null, false).map((r) => r.status))
      .toEqual(['left-only', 'right-only'])
    expect(alignRows(left, right, 0, null, null, false, rules).map((r) => r.status))
      .toEqual(['same'])
  })

  it('reports rows as same when every difference sits in ignored columns', () => {
    const rules = { 2: rule('ignore') }
    const left = [['1', 'Amy', '2024-01-01']]
    const right = [['1', 'Amy', '2099-12-31']]
    expect(alignRows(left, right, 0, null, null, false, rules).map((r) => r.status))
      .toEqual(['same'])
  })
})

// ── TableCompare integration ──────────────────────────────────────────────────

const LEFT_CSV = [
  'id,amount,updated_at,name',
  '1,100,2024-01-01,Amy',
  '2,200,2024-01-02,Bob',
].join('\n')

const RIGHT_CSV = [
  'id,amount,updated_at,name',
  '1,100.00,01/01/2024,Amy',
  '2,200.005,2024-06-30 23:59:59,Bob',
].join('\n')

/** @returns {TableCompare} */
function makeLoaded(options = {}) {
  const tc = new TableCompare({ hasHeader: true, keyColumn: 0, ...options })
  tc.setLeft('L.csv', LEFT_CSV)
  tc.setRight('R.csv', RIGHT_CSV)
  return tc
}

describe('TableCompare column rules', () => {
  it('reports plain string differences before any rule is set', () => {
    const tc = makeLoaded()
    expect(tc._visibleRows.map((r) => r.status)).toEqual(['different', 'different'])
    expect(tc.getColumnRules()).toEqual({})
  })

  it('collapses formatting-only differences once rules are applied', () => {
    const tc = makeLoaded()
    tc.setColumnRule(1, { mode: 'numeric', tolerance: 0.01 })
    tc.setColumnRule(2, { mode: 'date' })
    // Row 0 now matches on both columns; row 1's timestamp is still far apart.
    expect(tc._visibleRows.map((r) => r.status)).toEqual(['same', 'different'])

    tc.setColumnRule(2, { mode: 'ignore' })
    expect(tc._visibleRows.map((r) => r.status)).toEqual(['same', 'same'])
  })

  it('restores the default rule when passed text or null', () => {
    const tc = makeLoaded()
    tc.setColumnRule(1, { mode: 'numeric' })
    expect(tc.getColumnRules()[1]).toEqual({ mode: 'numeric', tolerance: 0 })

    tc.setColumnRule(1, { mode: 'text' })
    expect(tc.getColumnRules()).toEqual({})

    tc.setColumnRule(2, { mode: 'ignore' })
    tc.setColumnRule(2, null)
    expect(tc.getColumnRules()).toEqual({})
  })

  it('ignores an out-of-range column index', () => {
    const tc = makeLoaded()
    tc.setColumnRule(-1, { mode: 'ignore' })
    expect(tc.getColumnRules()).toEqual({})
  })

  it('accepts rules through the constructor', () => {
    const tc = makeLoaded({ columnRules: { 1: { mode: 'numeric', tolerance: 1 }, 2: { mode: 'ignore' } } })
    expect(tc.getColumnRules()).toEqual({
      1: { mode: 'numeric', tolerance: 1 },
      2: { mode: 'ignore', tolerance: 0 },
    })
    expect(tc._visibleRows.map((r) => r.status)).toEqual(['same', 'same'])
  })

  it('keeps ignored columns out of the cell-diff marks and column stats', () => {
    const tc = makeLoaded({ columnRules: { 2: { mode: 'ignore' } } })
    const stats = tc.getStats()
    expect(stats.columnDiffCounts['updated_at']).toBeUndefined()
    expect(stats.columnDiffCounts['amount']).toBe(2)
  })

  it('replaces the whole rule set with setColumnRules()', () => {
    const tc = makeLoaded({ columnRules: { 1: { mode: 'numeric' } } })
    tc.setColumnRules({ 2: { mode: 'ignore' } })
    expect(tc.getColumnRules()).toEqual({ 2: { mode: 'ignore', tolerance: 0 } })
    tc.setColumnRules(null)
    expect(tc.getColumnRules()).toEqual({})
  })
})

describe('TableCompare key columns', () => {
  it('defaults to the single column 0 key for backward compatibility', () => {
    expect(new TableCompare().getKeyColumns()).toEqual([0])
    expect(new TableCompare({ keyColumn: -1 }).getKeyColumns()).toEqual([])
    expect(new TableCompare({ keyColumn: 2 }).getKeyColumns()).toEqual([2])
  })

  it('accepts a composite key from the constructor and from setKeyColumns()', () => {
    const tc = makeLoaded({ keyColumn: [0, 3] })
    expect(tc.getKeyColumns()).toEqual([0, 3])

    tc.setKeyColumns(1)
    expect(tc.getKeyColumns()).toEqual([1])

    tc.setKeyColumns([0, 3])
    expect(tc.getKeyColumns()).toEqual([0, 3])
  })

  it('re-aligns rows after the key changes', () => {
    const tc = makeLoaded({ keyColumn: [0, 3] })
    expect(tc._visibleRows.map((r) => r.status)).toEqual(['different', 'different'])

    // Aligning on the amount column instead: 100 vs 100.00 no longer pair up
    // while the rule is plain text.
    tc.setKeyColumns([1])
    expect(tc._visibleRows.map((r) => r.status))
      .toEqual(['left-only', 'left-only', 'right-only', 'right-only'])
  })
})

describe('TableCompare.resizeColumnsToFit()', () => {
  /** @returns {{ tc: TableCompare, host: HTMLElement }} */
  function mounted() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const tc = new TableCompare({ hasHeader: true, keyColumn: 0 })
    tc.mount(host)
    tc.setLeft('L.csv', LEFT_CSV)
    tc.setRight('R.csv', RIGHT_CSV)
    return { tc, host }
  }

  it('produces one width per column and writes them into a colgroup', () => {
    const { tc, host } = mounted()
    tc.resizeColumnsToFit()

    expect(tc._colWidths.left).toHaveLength(4)
    const cols = tc._dom.leftTable.querySelectorAll('colgroup col')
    // One extra <col> pairs with the row-number cell.
    expect(cols).toHaveLength(5)
    expect(tc._dom.leftTable.classList.contains('tc-table--fitted')).toBe(true)

    tc.destroy()
    host.remove()
  })

  it('toggles back to automatic widths on a second call', () => {
    const { tc, host } = mounted()
    tc.resizeColumnsToFit()
    tc.resizeColumnsToFit()

    expect(tc._colWidths.left).toBeNull()
    expect(tc._dom.leftTable.querySelector('colgroup')).toBeNull()
    expect(tc._dom.leftTable.classList.contains('tc-table--fitted')).toBe(false)

    tc.destroy()
    host.remove()
  })

  it('survives a re-render', () => {
    const { tc, host } = mounted()
    tc.resizeColumnsToFit()
    tc.refresh()
    expect(tc._dom.leftTable.querySelectorAll('colgroup col')).toHaveLength(5)

    tc.destroy()
    host.remove()
  })

  it('is a no-op when nothing is loaded', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const tc = new TableCompare()
    tc.mount(host)
    tc.resizeColumnsToFit()
    expect(tc._colWidths.left).toEqual([])

    tc.destroy()
    host.remove()
  })
})

describe('TableCompare column settings panel', () => {
  /** @returns {{ tc: TableCompare, host: HTMLElement }} */
  function mounted() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const tc = new TableCompare({ hasHeader: true, keyColumn: 0 })
    tc.mount(host)
    tc.setLeft('L.csv', LEFT_CSV)
    tc.setRight('R.csv', RIGHT_CSV)
    return { tc, host }
  }

  it('opens from the toolbar with one row per column', () => {
    const { tc, host } = mounted()
    tc._dom.btnColumns.click()

    expect(tc._dom.colPanel.style.display).toBe('flex')
    expect(tc._dom.colPanel.querySelectorAll('.tc-col-row')).toHaveLength(4)

    tc.closeColumnSettings()
    expect(tc._dom.colPanel.style.display).toBe('none')

    tc.destroy()
    host.remove()
  })

  it('applies a mode change from the panel to the comparison', () => {
    const { tc, host } = mounted()
    tc.openColumnSettings()

    const rows = tc._dom.colPanel.querySelectorAll('.tc-col-row')
    const modeSel = rows[1].querySelector('.tc-col-mode')
    const tol = rows[1].querySelector('.tc-col-tol')
    modeSel.value = 'numeric'
    tol.value = '0.01'
    modeSel.dispatchEvent(new Event('change'))

    expect(tc.getColumnRules()[1]).toEqual({ mode: 'numeric', tolerance: 0.01 })
    expect(tc._visibleRows[0].status).toBe('different')  // date column still differs
    expect(tc._cellDiffsFor(tc._visibleRows[0])[1]).toBe(false)

    tc.destroy()
    host.remove()
  })

  it('toggles a key column from the panel checkbox', () => {
    const { tc, host } = mounted()
    tc.openColumnSettings()

    const rows = tc._dom.colPanel.querySelectorAll('.tc-col-row')
    const keyBox = rows[3].querySelector('.tc-col-key')
    expect(keyBox.checked).toBe(false)
    keyBox.checked = true
    keyBox.dispatchEvent(new Event('change'))

    expect(tc.getKeyColumns()).toEqual([0, 3])
    expect(tc._dom.keyInput.value).toBe('0,3')

    tc.destroy()
    host.remove()
  })

  it('reads the composite key back from the toolbar field', () => {
    const { tc, host } = mounted()
    tc._dom.keyInput.value = '0, 3'
    tc._dom.keyInput.dispatchEvent(new Event('change'))
    expect(tc.getKeyColumns()).toEqual([0, 3])

    tc._dom.keyInput.value = '-1'
    tc._dom.keyInput.dispatchEvent(new Event('change'))
    expect(tc.getKeyColumns()).toEqual([])

    tc.destroy()
    host.remove()
  })

  it('shows a placeholder when no data is loaded', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const tc = new TableCompare()
    tc.mount(host)
    tc.openColumnSettings()
    expect(tc._dom.colPanel.querySelector('.tc-col-panel-empty')).not.toBeNull()

    tc.destroy()
    host.remove()
  })
})
