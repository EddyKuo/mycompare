/**
 * @vitest-environment jsdom
 *
 * Hex compare plain-text report.
 */
import { describe, it, expect, vi } from 'vitest'
import { HexCompare } from '../../src/renderer/src/views/hex-compare.js'

const AT = new Date('2026-07-27T00:00:00Z')
// Forward slashes deliberately: a backslash path would be an escape hazard in
// the expectations without adding anything to what is under test.
const LEFT_PATH = 'C:/tmp/a.bin'
const RIGHT_PATH = 'C:/tmp/b.bin'

/**
 * @param {number[]} l
 * @param {number[]} r
 * @returns {HexCompare}
 */
function withBytes(l, r) {
  window.electronAPI = { saveFile: vi.fn() }
  const hc = new HexCompare()
  const b64 = (arr) => btoa(String.fromCharCode(...arr))
  hc.setLeft(LEFT_PATH, b64(l))
  hc.setRight(RIGHT_PATH, b64(r))
  return hc
}

describe('HexCompare.getStats', () => {
  it('counts regions and differing bytes', () => {
    const s = withBytes([1, 2, 3, 4], [1, 9, 9, 4]).getStats()
    expect(s.leftBytes).toBe(4)
    expect(s.rightBytes).toBe(4)
    expect(s.regions).toBe(1)
    expect(s.diffBytes).toBe(2)
  })

  it('counts several separated regions', () => {
    // Differences at index 1 and 3, with a matching byte between them.
    const s = withBytes([1, 2, 3, 4, 5], [1, 9, 3, 9, 5]).getStats()
    expect(s.regions).toBe(2)
    expect(s.diffBytes).toBe(2)
  })

  it('reports zeroes for identical input', () => {
    const s = withBytes([1, 2], [1, 2]).getStats()
    expect(s.regions).toBe(0)
    expect(s.diffBytes).toBe(0)
  })
})

describe('HexCompare.buildTextReport', () => {
  it('lists each differing region with both sides', () => {
    const out = withBytes([1, 2, 3], [1, 9, 3]).buildTextReport({ generatedAt: AT })
    expect(out).toContain('Hex 比對報告')
    expect(out).toContain(LEFT_PATH)
    expect(out).toContain(RIGHT_PATH)
    expect(out).toContain('0x00000001')
    expect(out).toContain('02')
    expect(out).toContain('09')
  })

  it('says so when the files match', () => {
    const out = withBytes([7, 7], [7, 7]).buildTextReport({ generatedAt: AT })
    expect(out).toContain('無差異')
    expect(out).toContain('兩側內容相同')
  })

  it('caps the listing and says how many were omitted', () => {
    // Every other byte matches, so each differing byte becomes its own region.
    const left = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0 : i))
    const right = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0 : i + 100))
    const hc = withBytes(left, right)
    expect(hc.getStats().regions).toBeGreaterThan(2)

    const out = hc.buildTextReport({ generatedAt: AT, maxRegions: 2 })
    expect(out).toMatch(/另有 \d+ 個差異區塊未列出/)
  })

  it('clips a long region preview rather than dumping it', () => {
    const left = Array.from({ length: 40 }, () => 1)
    const right = Array.from({ length: 40 }, () => 2)
    const out = withBytes(left, right).buildTextReport({ generatedAt: AT })
    expect(out).toContain('…')
  })

  it('handles one side being absent', () => {
    window.electronAPI = { saveFile: vi.fn() }
    const hc = new HexCompare()
    hc.setLeft(LEFT_PATH, btoa('abc'))
    const out = hc.buildTextReport({ generatedAt: AT })
    expect(out).toContain('Hex 比對報告')
    expect(out).not.toContain('undefined')
  })

  it('is reproducible for a given timestamp', () => {
    const a = withBytes([1], [2]).buildTextReport({ generatedAt: AT })
    const b = withBytes([1], [2]).buildTextReport({ generatedAt: AT })
    expect(a).toBe(b)
    expect(a).toContain('2026-07-27 00:00:00')
  })
})
