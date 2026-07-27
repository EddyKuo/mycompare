/**
 * @vitest-environment jsdom
 *
 * Every algorithm must emit an edit script whose equal ops step strictly
 * forward on both sides.
 *
 * Histogram did not: it builds every pairing of the rarest common line and
 * then takes a longest increasing subsequence over the *right* index only, so
 * two pairs sharing a left line both qualified and that line was matched
 * twice. Roughly half of random inputs produced such a script. Nothing
 * downstream expects an index to go backwards, and the visible result is rows
 * pairing with the wrong lines.
 *
 * The detector is self-checked first. A well-formedness test that cannot
 * recognise a malformed script passes on everything, which is how this went
 * unnoticed in the first place.
 */
import { describe, it, expect } from 'vitest'
import { myersDiff, patienceDiff, histogramDiff } from '../../src/renderer/src/core/diff-engine.js'

/** @param {{type: string, leftLine: number, rightLine: number}[]} ops */
function firstBackwardsStep(ops) {
  let li = 0
  let ri = 0
  for (const op of ops) {
    if (op.type !== 'equal') continue
    if (op.leftLine <= li || op.rightLine <= ri) return { op, li, ri }
    li = op.leftLine
    ri = op.rightLine
  }
  return null
}

const ALGORITHMS = [
  ['myers', myersDiff],
  ['patience', patienceDiff],
  ['histogram', histogramDiff],
]

describe('edit script well-formedness', () => {
  it('detects a script that steps backwards', () => {
    expect(firstBackwardsStep([
      { type: 'equal', leftLine: 3, rightLine: 3 },
      { type: 'equal', leftLine: 3, rightLine: 4 },
    ])).not.toBeNull()
    expect(firstBackwardsStep([
      { type: 'equal', leftLine: 1, rightLine: 1 },
      { type: 'equal', leftLine: 2, rightLine: 2 },
    ])).toBeNull()
  })

  it.each(ALGORITHMS)('%s never steps backwards over 2000 random inputs', (name, diff) => {
    // The alphabet is small and repetitive on purpose: repeated lines are what
    // make one line matchable at several positions.
    let seed = 987654321
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const alphabet = ['a', 'b', 'c', 'd', '', '}', '// --']
    const mk = (n) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)])

    for (let t = 0; t < 2000; t++) {
      const left = mk(3 + Math.floor(rnd() * 12))
      const right = mk(3 + Math.floor(rnd() * 12))
      const bad = firstBackwardsStep(diff(left, right))
      expect(bad, `${name} on ${JSON.stringify({ left, right })}`).toBeNull()
    }
  })

  it.each(ALGORITHMS)('%s pairs each line at most once', (name, diff) => {
    const left = ['x', 'a', 'x', 'b', 'x']
    const right = ['x', 'b', 'x', 'a', 'x']
    const ops = diff(left, right).filter((o) => o.type === 'equal')
    expect(new Set(ops.map((o) => o.leftLine)).size).toBe(ops.length)
    expect(new Set(ops.map((o) => o.rightLine)).size).toBe(ops.length)
  })
})

describe('large inputs', () => {
  it.each(ALGORITHMS)('%s finishes on 50,000 distinct lines', (name, diff) => {
    // The anchor-based algorithms recurse once per anchor and rescan their
    // region each level, so distinct lines are their worst case: this used to
    // exhaust the stack, and then — once depth was capped — took 58 seconds.
    const left = Array.from({ length: 50000 }, (_, i) => `line ${i}`)
    const right = left.slice()
    right[25000] = 'changed'

    const started = Date.now()
    const ops = diff(left, right)
    expect(ops.length).toBeGreaterThan(0)
    expect(firstBackwardsStep(ops)).toBeNull()
    expect(Date.now() - started).toBeLessThan(20000)
  }, 60000)
})
