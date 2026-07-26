/**
 * Plain-text report helpers.
 */
import { describe, it, expect } from 'vitest'
import {
  renderTextTable,
  displayWidth,
  reportHeader,
  reportSummary,
} from '../../src/renderer/src/core/report.js'

describe('displayWidth', () => {
  it('counts ASCII as one cell each', () => {
    expect(displayWidth('hello')).toBe(5)
    expect(displayWidth('')).toBe(0)
  })

  it('counts CJK as two cells', () => {
    expect(displayWidth('相同')).toBe(4)
    expect(displayWidth('a相同b')).toBe(6)
  })

  it('handles astral code points as single characters', () => {
    // One emoji, not two surrogate halves.
    expect(displayWidth('😀')).toBe(2)
  })

  it('tolerates null and undefined', () => {
    expect(displayWidth(null)).toBe(0)
    expect(displayWidth(undefined)).toBe(0)
  })
})

describe('renderTextTable', () => {
  const cols = [{ title: 'Name' }, { title: 'Size', align: 'right' }]

  it('aligns columns to the widest cell', () => {
    const out = renderTextTable(cols, [
      ['a.txt', '10'],
      ['much-longer.txt', '1024'],
    ])
    const lines = out.split('\n')
    expect(lines).toHaveLength(4) // header, rule, two rows
    // Every line's first column occupies the same width.
    const starts = lines.slice(2).map((l) => l.indexOf(' 1'))
    expect(new Set(starts).size).toBeLessThanOrEqual(2)
    expect(out).toContain('much-longer.txt')
  })

  it('right-aligns a column when asked', () => {
    const out = renderTextTable(cols, [['a', '5'], ['b', '1000']])
    const rows = out.split('\n').slice(2)
    // '5' is padded to line up with the last digit of '1000'.
    expect(rows[0].endsWith('   5')).toBe(true)
    expect(rows[1].endsWith('1000')).toBe(true)
  })

  it('keeps CJK columns aligned', () => {
    const out = renderTextTable([{ title: '狀態' }, { title: 'x' }], [
      ['相同', '1'],
      ['僅左側', '2'],
    ])
    const rows = out.split('\n').slice(2)
    // Both value columns start at the same display offset.
    const offsets = rows.map((r) => displayWidth(r.slice(0, r.lastIndexOf(' ') + 1)))
    expect(offsets[0]).toBe(offsets[1])
  })

  it('renders a header and rule even with no rows', () => {
    const out = renderTextTable(cols, [])
    expect(out.split('\n')).toHaveLength(2)
    expect(out).toContain('Name')
  })

  it('tolerates short rows', () => {
    const out = renderTextTable(cols, [['only-name']])
    expect(out).toContain('only-name')
  })

  it('does not leave trailing whitespace', () => {
    const out = renderTextTable(cols, [['a', '1']])
    for (const line of out.split('\n')) {
      expect(line).toBe(line.replace(/\s+$/, ''))
    }
  })
})

describe('reportHeader', () => {
  it('includes both paths and a fixed timestamp', () => {
    const out = reportHeader({
      title: '文字比對報告',
      leftPath: 'C:\\a.txt',
      rightPath: 'C:\\b.txt',
      generatedAt: new Date('2026-07-27T01:02:03Z'),
    })
    expect(out).toContain('C:\\a.txt')
    expect(out).toContain('C:\\b.txt')
    expect(out).toContain('2026-07-27 01:02:03')
  })

  it('marks unknown paths rather than leaving them blank', () => {
    const out = reportHeader({ title: 'x', generatedAt: new Date(0) })
    expect(out).toContain('（未知）')
  })

  it('underlines the title to its display width', () => {
    const lines = reportHeader({ title: '報告', generatedAt: new Date(0) }).split('\n')
    expect(lines[1]).toBe('='.repeat(4))
  })
})

describe('reportSummary', () => {
  const labels = { same: '相同', different: '不同', left_only: '僅左側' }

  it('lists only non-zero counts', () => {
    expect(reportSummary({ same: 3, different: 0, left_only: 2 }, labels))
      .toBe('相同 3，僅左側 2')
  })

  it('reports no differences when everything is zero', () => {
    expect(reportSummary({ same: 0, different: 0 }, labels)).toBe('無差異')
  })

  it('tolerates a missing counts object', () => {
    expect(reportSummary(undefined, labels)).toBe('無差異')
  })

  it('ignores keys with no label', () => {
    expect(reportSummary({ mystery: 5, same: 1 }, labels)).toBe('相同 1')
  })
})
