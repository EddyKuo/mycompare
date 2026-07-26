/**
 * @vitest-environment jsdom
 *
 * Table compare plain-text report.
 */
import { describe, it, expect, vi } from 'vitest'
import { TableCompare } from '../../src/renderer/src/views/table-compare.js'

const AT = new Date('2026-07-27T00:00:00Z')
const LEFT_PATH = 'C:/tmp/left.csv'
const RIGHT_PATH = 'C:/tmp/right.csv'

/**
 * @param {string} l
 * @param {string} r
 * @returns {TableCompare}
 */
function withCsv(l, r) {
  window.electronAPI = { saveFile: vi.fn() }
  const tc = new TableCompare()
  tc.setLeft(LEFT_PATH, l)
  tc.setRight(RIGHT_PATH, r)
  return tc
}

describe('TableCompare.buildTextReport', () => {
  it('lists differing rows with both sides', () => {
    const out = withCsv(
      'id,name\n1,Alice\n2,Bob\n',
      'id,name\n1,Alice\n2,Bobby\n',
    ).buildTextReport({ generatedAt: AT })

    expect(out).toContain('表格比對報告')
    expect(out).toContain(LEFT_PATH)
    expect(out).toContain('Bob')
    expect(out).toContain('Bobby')
    expect(out).toContain('不同')
    // Identical rows are not listed.
    expect(out.split('Alice').length - 1).toBeLessThanOrEqual(1)
  })

  it('labels orphan rows by side', () => {
    const out = withCsv(
      'id,name\n1,Alice\n2,Bob\n',
      'id,name\n1,Alice\n',
    ).buildTextReport({ generatedAt: AT })
    expect(out).toContain('僅左側')
  })

  it('says so when the tables match', () => {
    const csv = 'id,name\n1,Alice\n'
    const out = withCsv(csv, csv).buildTextReport({ generatedAt: AT })
    expect(out).toContain('兩側內容相同')
  })

  it('caps the listing and reports the remainder', () => {
    const rows = (tweak) => ['id,v', ...Array.from({ length: 30 },
      (_, i) => `${i},${tweak ? i + 1 : i}`)].join('\n')
    const out = withCsv(rows(false), rows(true))
      .buildTextReport({ generatedAt: AT, maxRows: 3 })
    expect(out).toMatch(/另有 \d+ 列未列出/)
  })

  it('is reproducible for a given timestamp', () => {
    const a = withCsv('a\n1\n', 'a\n2\n').buildTextReport({ generatedAt: AT })
    const b = withCsv('a\n1\n', 'a\n2\n').buildTextReport({ generatedAt: AT })
    expect(a).toBe(b)
  })

  it('handles an empty table without producing undefined', () => {
    const out = withCsv('', '').buildTextReport({ generatedAt: AT })
    expect(out).toContain('表格比對報告')
    expect(out).not.toContain('undefined')
  })
})
