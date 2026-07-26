/**
 * Sprint 16 — remediation regression tests.
 *
 * Covers defects found by the code-review pass that the existing suites
 * missed because they only exercised toy-sized inputs.
 */
import { describe, it, expect } from 'vitest'
import { hexCompleteByteDiff } from '../../src/renderer/src/views/hex-compare.js'

// ── Hex Complete-mode byte diff ─────────────────────────────────────────────

describe('hexCompleteByteDiff — large inputs', () => {
  it('handles multi-MB inputs with a small edit distance without exhausting memory', () => {
    const SIZE = 2 * 1024 * 1024
    const a = new Uint8Array(SIZE)
    for (let i = 0; i < SIZE; i++) a[i] = i & 0xff
    // Single byte flipped in the middle — prefix/suffix trim should reduce the
    // Myers input to (almost) nothing.
    const b = a.slice()
    b[SIZE >> 1] = b[SIZE >> 1] ^ 0xff

    const started = Date.now()
    const { leftClass, rightClass, truncated } = hexCompleteByteDiff(a, b)
    const elapsed = Date.now() - started

    expect(truncated).toBe(false)
    expect(elapsed).toBeLessThan(5000)
    expect(leftClass.length).toBe(SIZE)
    expect(rightClass.length).toBe(SIZE)
    // Exactly one byte differs on each side.
    expect(leftClass.reduce((s, v) => s + v, 0)).toBe(1)
    expect(rightClass.reduce((s, v) => s + v, 0)).toBe(1)
    expect(leftClass[SIZE >> 1]).toBe(1)
  })

  it('degrades gracefully instead of hanging when the edit distance blows the budget', () => {
    const SIZE = 200_000
    const a = new Uint8Array(SIZE)
    const b = new Uint8Array(SIZE)
    // Deterministic pseudo-random, fully dissimilar content.
    let sa = 1
    let sb = 2
    for (let i = 0; i < SIZE; i++) {
      sa = (sa * 1103515245 + 12345) & 0x7fffffff
      sb = (sb * 1103515245 + 54321) & 0x7fffffff
      a[i] = (sa >> 16) & 0xff
      b[i] = (sb >> 16) & 0xff
    }

    const started = Date.now()
    const { leftClass, rightClass, truncated } = hexCompleteByteDiff(a, b, { maxEditDistance: 256 })
    const elapsed = Date.now() - started

    expect(truncated).toBe(true)
    expect(elapsed).toBeLessThan(5000)
    expect(leftClass.length).toBe(SIZE)
    expect(rightClass.length).toBe(SIZE)
    // Positional fallback still marks the ~1/256 coincidental byte matches same.
    const diffCount = leftClass.reduce((s, v) => s + v, 0)
    expect(diffCount).toBeGreaterThan(SIZE * 0.9)
  })

  it('trims a shared prefix and suffix around a differing middle', () => {
    const a = new Uint8Array([1, 2, 3, 10, 11, 8, 9])
    const b = new Uint8Array([1, 2, 3, 20, 8, 9])
    const { leftClass, rightClass, truncated } = hexCompleteByteDiff(a, b)
    expect(truncated).toBe(false)
    expect(Array.from(leftClass)).toEqual([0, 0, 0, 1, 1, 0, 0])
    expect(Array.from(rightClass)).toEqual([0, 0, 0, 1, 0, 0])
  })

  it('classifies a pure deletion at the head correctly', () => {
    const a = new Uint8Array([9, 9, 1, 2, 3])
    const b = new Uint8Array([1, 2, 3])
    const { leftClass, rightClass } = hexCompleteByteDiff(a, b)
    expect(Array.from(leftClass)).toEqual([1, 1, 0, 0, 0])
    expect(Array.from(rightClass)).toEqual([0, 0, 0])
  })

  it('handles one side empty', () => {
    const out = hexCompleteByteDiff(new Uint8Array([1, 2, 3]), new Uint8Array(0))
    expect(Array.from(out.leftClass)).toEqual([1, 1, 1])
    expect(out.rightClass.length).toBe(0)
    expect(out.truncated).toBe(false)
  })

  it('reports every byte as same for identical multi-KB inputs', () => {
    const a = new Uint8Array(50_000)
    for (let i = 0; i < a.length; i++) a[i] = (i * 7) & 0xff
    const { leftClass, rightClass, truncated } = hexCompleteByteDiff(a, a.slice())
    expect(truncated).toBe(false)
    expect(leftClass.reduce((s, v) => s + v, 0)).toBe(0)
    expect(rightClass.reduce((s, v) => s + v, 0)).toBe(0)
  })
})
