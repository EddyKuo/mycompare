/**
 * Grammar line weights as an alignment input (BC "line weights").
 *
 * The contract under test is narrow and load-bearing:
 *   1. Omitting weights must reproduce the unweighted result byte for byte.
 *   2. Supplying weights must actually change which lines are paired, in the
 *      direction BC specifies — structural lines outweigh comment/blank filler.
 */

import { describe, it, expect } from 'vitest'
import {
  diffLines, myersDiff, patienceDiff, histogramDiff,
} from '../../src/renderer/src/core/diff-engine.js'
import { getGrammarForPath, computeLineWeights } from '../../src/renderer/src/core/grammar.js'

/**
 * @param {string} text
 * @param {string} path
 * @returns {number[]}
 */
function weightsFor(text, path = 'x.c') {
  const grammar = getGrammarForPath(path)
  return computeLineWeights(grammar, text.split('\n')).weights
}

/** Pairs of (leftLine, rightLine) that the diff considers the same line. */
function alignedPairs(diff) {
  return diff.filter(d => d.type === 'equal').map(d => [d.leftLine, d.rightLine])
}

/** The left-side texts the diff calls unchanged. */
function equalLeftTexts(diff) {
  return diff.filter(d => d.type === 'equal').map(d => (d.leftText ?? '').replace(/\n$/, ''))
}

// ---------------------------------------------------------------------------
// The demonstration case
// ---------------------------------------------------------------------------

describe('line weights change the alignment', () => {
  // A function is moved from below a comment banner to above it. The banner is
  // five interchangeable `//` lines; the function is four lines of code. The
  // longest common subsequence is therefore the banner, so the unweighted diff
  // reports the whole function as deleted-and-reinserted and keeps four banner
  // lines paired. Weighted, the four code lines (2, 2, 2, 1) outrank the five
  // comment lines (0.5 each) and the moved function stays intact.
  const LEFT = [
    '//', '//', '//', '//', '//',
    'int compute(int n) {',
    '  int total = 0;',
    '  return total;',
    '}',
  ].join('\n')

  const RIGHT = [
    'int compute(int n) {',
    '  int total = 0;',
    '  return total;',
    '}',
    '//', '//', '//', '//', '//',
  ].join('\n')

  it('the fixture really does carry the weights the case depends on', () => {
    expect(weightsFor(LEFT)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 2, 2, 2, 1])
  })

  it('without weights the comment banner wins the alignment', () => {
    const plain = equalLeftTexts(diffLines(LEFT, RIGHT))
    expect(plain).toEqual(['//', '//', '//', '//'])
    expect(plain).not.toContain('int compute(int n) {')
  })

  it('with weights the moved function wins the alignment', () => {
    const weighted = diffLines(LEFT, RIGHT, {
      leftWeights: weightsFor(LEFT),
      rightWeights: weightsFor(RIGHT),
    })
    expect(equalLeftTexts(weighted)).toEqual([
      'int compute(int n) {',
      '  int total = 0;',
      '  return total;',
    ])
    // …and it is paired with the right side's copy of the same function.
    expect(alignedPairs(weighted)).toEqual([[6, 1], [7, 2], [8, 3]])
  })

  it('blank-line filler loses to a moved function too', () => {
    const left = ['int alpha(int n) {', '  return n;', '}', '', '', ''].join('\n')
    const right = ['', '', '', 'int alpha(int n) {', '  return n;', '}'].join('\n')

    const plain = equalLeftTexts(diffLines(left, right))
    expect(plain).toEqual(['', ''])

    const weighted = equalLeftTexts(diffLines(left, right, {
      leftWeights: weightsFor(left),
      rightWeights: weightsFor(right),
    }))
    expect(weighted).toEqual(['int alpha(int n) {', '  return n;'])
  })

  it('weights are consulted through the low-level exports as well', () => {
    const l = LEFT.split('\n')
    const r = RIGHT.split('\n')
    const opts = { leftWeights: weightsFor(LEFT), rightWeights: weightsFor(RIGHT) }
    for (const fn of [myersDiff, patienceDiff, histogramDiff]) {
      expect(equalLeftTexts(fn(l, r, opts))).toContain('int compute(int n) {')
    }
  })
})

// ---------------------------------------------------------------------------
// Backwards compatibility
// ---------------------------------------------------------------------------

describe('omitting weights leaves the diff untouched', () => {
  const CASES = [
    ['identical', 'a\nb\nc', 'a\nb\nc'],
    ['insert', 'a\nc', 'a\nb\nc'],
    ['delete', 'a\nb\nc', 'a\nc'],
    ['replace', 'a\nb\nc', 'a\nX\nc'],
    ['empty left', '', 'a\nb'],
    ['empty right', 'a\nb', ''],
    ['both empty', '', ''],
    ['all different', 'a\nb\nc\nd', 'w\nx\ny\nz'],
    ['filler heavy', '//\n//\n//\n//\n//\nint f() {\n  return 1;\n}',
      'int f() {\n  return 1;\n}\n//\n//\n//\n//\n//'],
  ]

  for (const algorithm of ['myers', 'patience', 'histogram']) {
    for (const [name, left, right] of CASES) {
      it(`${algorithm}: ${name}`, () => {
        const base = diffLines(left, right, { algorithm })
        expect(diffLines(left, right, { algorithm, leftWeights: undefined, rightWeights: undefined }))
          .toEqual(base)
        expect(diffLines(left, right, { algorithm, leftWeights: [] })).toEqual(base)
        expect(diffLines(left, right, { algorithm })).toEqual(base)
      })
    }
  }

  it('low-level exports called with no options are unchanged', () => {
    const l = ['a', 'b', 'c']
    const r = ['a', 'x', 'c']
    expect(myersDiff(l, r, undefined)).toEqual(myersDiff(l, r))
    expect(patienceDiff(l, r, undefined)).toEqual(patienceDiff(l, r))
    expect(histogramDiff(l, r, undefined)).toEqual(histogramDiff(l, r))
  })
})

// ---------------------------------------------------------------------------
// The weighted script must still be a valid script
// ---------------------------------------------------------------------------

describe('weighted output stays well formed', () => {
  /**
   * Every left line appears exactly once and in order; likewise every right
   * line; and an `equal` row always holds the same text on both sides.
   */
  function assertWellFormed(diff, leftLines, rightLines) {
    const seenLeft = []
    const seenRight = []
    for (const d of diff) {
      if (d.leftLine != null) seenLeft.push(d.leftLine)
      if (d.rightLine != null) seenRight.push(d.rightLine)
      if (d.type === 'equal') expect(d.leftText).toBe(d.rightText)
    }
    expect(seenLeft).toEqual(leftLines.map((_, i) => i + 1))
    expect(seenRight).toEqual(rightLines.map((_, i) => i + 1))
  }

  const left = [
    '#include <a.h>', '', '// helper', 'int f() {', '  return 1;', '}',
    '', '// helper', 'int g() {', '  return 2;', '}',
  ]
  const right = [
    '#include <a.h>', '', '// helper', 'int g() {', '  return 2;', '}',
    '', '// helper', 'int f() {', '  return 1;', '}',
  ]

  for (const algorithm of ['myers', 'patience', 'histogram']) {
    it(algorithm, () => {
      const lt = left.join('\n')
      const rt = right.join('\n')
      const diff = diffLines(lt, rt, {
        algorithm, leftWeights: weightsFor(lt), rightWeights: weightsFor(rt),
      })
      assertWellFormed(diff, left, right)
    })
  }

  it('tolerates weight arrays that are the wrong length or hold junk', () => {
    const lt = 'a\nb\nc\nd'
    const rt = 'a\nx\nc\nd'
    const diff = diffLines(lt, rt, {
      leftWeights: [NaN, 3],
      rightWeights: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    })
    assertWellFormed(diff, lt.split('\n'), rt.split('\n'))
  })
})

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

describe('weighting does not change the cost class', () => {
  it('a 40 000 line pair stays within a small constant factor', () => {
    const left = []
    for (let i = 0; i < 40_000; i += 8) {
      left.push(`// helper ${i}`, `function fn${i}(a, b) {`, `  const total = a * ${i} + b;`,
        `  if (total > ${i % 97}) {`, `    return "value ${i}";`, '  }', '  return total;', '}')
    }
    const right = left.map((l, i) => (i % 101 === 0 ? `${l} // touched` : l))
    const lt = left.join('\n')
    const rt = right.join('\n')
    const lw = weightsFor(lt, 'x.js')
    const rw = weightsFor(rt, 'x.js')

    const t0 = performance.now()
    diffLines(lt, rt, {})
    const plainMs = performance.now() - t0

    const t1 = performance.now()
    diffLines(lt, rt, { leftWeights: lw, rightWeights: rw })
    const weightedMs = performance.now() - t1

    // Generous, because CI timing is noisy; the point is to catch a change
    // that reintroduces an O(N·M) pass, which would be orders of magnitude.
    expect(weightedMs).toBeLessThan(Math.max(300, plainMs * 6))
  })
})
