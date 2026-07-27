/**
 * @vitest-environment jsdom
 *
 * A three-way merge accounts for every base line.
 *
 * The previous segment builder consumed at most one hunk per side per cluster,
 * so a second edit on the same side within one span fell into a defensive
 * branch and was dropped; and an overlapping conflict emitted only the hunk's
 * own lines, so base lines inside the span that the hunk did not cover
 * vanished. Both lose content silently — the merge completes, the output looks
 * plausible, and a line the user wrote is simply gone.
 *
 * Checked as a property over generated layouts rather than one fixed case,
 * because the shapes that trigger it are the awkward ones: adjacent edits and
 * partially overlapping spans.
 */
import { describe, it, expect } from 'vitest'
import {
  mergeHunkSegments,
  applyHunkRange,
} from '../../src/renderer/src/views/three-way-compare.js'

const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)

/** A hunk replacing base[start..end) with `lines`. */
const hunk = (start, end, lines) => ({ baseStart: start, baseEnd: end, newLines: lines })

describe('applyHunkRange', () => {
  it('returns the span untouched when no hunk covers it', () => {
    expect(applyHunkRange(base, [], 2, 5)).toEqual(base.slice(2, 5))
  })

  it('keeps base lines inside the span that the hunk does not cover', () => {
    // The exact loss: span 2..8, hunk covers only 4..6, and the lines either
    // side of it have to survive.
    const out = applyHunkRange(base, [hunk(4, 6, ['X'])], 2, 8)
    expect(out).toContain('line 3')
    expect(out).toContain('X')
    expect(out).toContain('line 7')
    expect(out).toContain('line 8')
  })

  it('applies every hunk in the span, not just the first', () => {
    const out = applyHunkRange(base, [hunk(2, 3, ['A']), hunk(6, 7, ['B'])], 0, 10)
    expect(out).toContain('A')
    expect(out).toContain('B')
    expect(out).toContain('line 1')
    expect(out).toContain('line 10')
  })
})

describe('mergeHunkSegments', () => {
  it('keeps both of two adjacent edits on the same side', () => {
    // The shape the old loop dropped: two same-side hunks close enough to land
    // in a single cluster, where only the first was consumed.
    const { segments } = mergeHunkSegments(
      base, [hunk(3, 4, ['LA']), hunk(4, 5, ['LB'])], [])
    const text = JSON.stringify(segments)
    expect(text).toContain('LA')
    expect(text).toContain('LB')
  })

  it('keeps an uncovered base line inside a conflict span', () => {
    const { segments } = mergeHunkSegments(
      base, [hunk(2, 4, ['L1'])], [hunk(3, 5, ['R1'])])
    const conflict = segments.find((s) => s.type === 'conflict')
    expect(conflict).toBeTruthy()
    // base[4] is inside the conflict span but covered by neither hunk's
    // replacement on the left, so it has to appear on that side verbatim.
    expect(conflict.leftLines.join('\n')).toContain('line 5')
  })

  it('reproduces one side exactly when only that side has edits', () => {
    // The soundest available invariant: with no edits on the right, the merged
    // result must equal the left file byte for byte. A dropped hunk or a lost
    // base line both break it, and unlike counting segment lines it does not
    // depend on how a changed segment represents itself.
    let seed = 20240727
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }

    for (let t = 0; t < 300; t++) {
      const hunks = []
      let at = 0
      while (at < base.length - 2) {
        at += rnd(3)
        const end = Math.min(base.length, at + 1 + rnd(3))
        if (at < end) hunks.push(hunk(at, end, [`e${t}_${at}`, `f${t}_${at}`].slice(0, 1 + rnd(2))))
        at = end + rnd(2)
      }
      const expected = applyHunkRange(base, hunks, 0, base.length)

      const { segments, hasConflicts } = mergeHunkSegments(base, hunks, [])
      expect(hasConflicts, `iteration ${t}`).toBe(false)

      const merged = segments.flatMap((seg) =>
        (seg.type === 'conflict' ? seg.leftLines : seg.lines) ?? [])
      expect(merged, `iteration ${t}`).toEqual(expected)
    }
  })

  it('reproduces the edited side at every proximity setting', () => {
    // Proximity merges nearby clusters into one conflict, which is where an
    // off-by-one in the span arithmetic would drop or double a line.
    const hunks = [hunk(2, 3, ['L1']), hunk(6, 7, ['L2'])]
    const expected = applyHunkRange(base, hunks, 0, base.length)
    for (const proximity of [0, 1, 3, 8]) {
      const { segments } = mergeHunkSegments(base, hunks, [], { proximity })
      const merged = segments.flatMap((seg) =>
        (seg.type === 'conflict' ? seg.leftLines : seg.lines) ?? [])
      expect(merged, `proximity ${proximity}`).toEqual(expected)
    }
  })
})
