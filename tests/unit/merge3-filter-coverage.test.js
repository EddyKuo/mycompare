/**
 * @vitest-environment jsdom
 *
 * Properties the eight display filters must hold as a set.
 *
 * The per-mode tests check each filter against the rows it should keep. These
 * check the modes against each other: that no kind of segment is invisible in
 * every mode, that the two extremes really are extremes, and that filtering
 * does not disturb the segments it is handed — the filter runs on every
 * repaint, so a mutation would compound.
 */
import { describe, it, expect } from 'vitest'
import {
  SHOW_FILTER_MODES,
  segmentMatchesFilter,
  filterSegments,
} from '../../src/renderer/src/views/three-way-compare.js'

/** Every kind a merge segment can have. */
const KINDS = ['same', 'left', 'right', 'both', 'conflict']

/** Segments always carry their lines; the conflict filter reads them for context. */
const seg = (kind) => (kind === 'conflict'
  ? { type: 'conflict', left: ['L'], base: ['B'], right: ['R'], lines: ['L'] }
  : { type: 'normal', kind, lines: [`${kind} line`] })

describe('display filters, as a set', () => {
  it('leaves no kind of segment invisible under every mode', () => {
    // A kind no mode shows is content the user cannot reach at all.
    const unreachable = KINDS.filter(
      (k) => !SHOW_FILTER_MODES.some((m) => segmentMatchesFilter(seg(k), m)))
    expect(unreachable).toEqual([])
  })

  it('has an "all" that shows everything and a "none" that shows nothing', () => {
    expect(KINDS.every((k) => segmentMatchesFilter(seg(k), 'all'))).toBe(true)
    expect(KINDS.some((k) => segmentMatchesFilter(seg(k), 'none'))).toBe(false)
  })

  it('distinguishes unchanged from same on exactly the both-sides-agree case', () => {
    // The two only differ where both sides made the identical edit: changed
    // against base, identical to each other. If they agreed everywhere, one of
    // them would be redundant.
    const differing = KINDS.filter((k) =>
      segmentMatchesFilter(seg(k), 'unchanged') !== segmentMatchesFilter(seg(k), 'same'))
    expect(differing).toEqual(['both'])
  })

  it('does not mutate the segments handed to it', () => {
    const input = KINDS.map(seg)
    const before = JSON.stringify(input)
    for (const m of SHOW_FILTER_MODES) filterSegments(input, m)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('offers the whole set the manual describes', () => {
    for (const m of ['all', 'changes', 'left-changes', 'right-changes', 'conflicts',
      'mergeable', 'unchanged', 'same', 'none']) {
      expect(SHOW_FILTER_MODES).toContain(m)
    }
  })
})
