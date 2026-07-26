/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest'
import { computeHexDiffRegions, hexCompleteByteDiff } from '../../src/renderer/src/views/hex-compare.js'

const U = (...b) => new Uint8Array(b)

describe('hex diff regions — behaviour spot-check', () => {
  it('coalesces a contiguous run into one region', () => {
    const r = computeHexDiffRegions(U(1,2,3,4,5), U(1,9,9,9,5))
    expect(r).toEqual([{ start: 1, end: 4, length: 3 }])
  })
  it('separates runs split by a matching byte', () => {
    const r = computeHexDiffRegions(U(1,2,3,4,5), U(1,9,3,9,5))
    expect(r.map(x => [x.start, x.end])).toEqual([[1,2],[3,4]])
  })
  it('treats the tail of a longer side as a difference', () => {
    const r = computeHexDiffRegions(U(1,2,3), U(1))
    expect(r).toEqual([{ start: 1, end: 3, length: 2 }])
  })
  it('reports nothing for identical input', () => {
    expect(computeHexDiffRegions(U(1,2,3), U(1,2,3))).toEqual([])
  })
  it('a single inserted byte is one region in Complete mode', () => {
    const a = U(1,2,3,4,5)
    const b = U(9,1,2,3,4,5)
    const { leftClass, rightClass } = hexCompleteByteDiff(a, b)
    const r = computeHexDiffRegions(a, b, { leftClass, rightClass })
    // Fast mode would flag nearly everything; Complete should isolate the insert.
    const fast = computeHexDiffRegions(a, b)
    expect(r.reduce((s,x)=>s+x.length,0)).toBeLessThan(fast.reduce((s,x)=>s+x.length,0))
  })
  it('handles null inputs', () => {
    expect(computeHexDiffRegions(null, null)).toEqual([])
    expect(computeHexDiffRegions(null, U(1,2))).toEqual([{ start: 0, end: 2, length: 2 }])
  })
})
