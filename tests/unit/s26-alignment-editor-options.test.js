/**
 * @vitest-environment jsdom
 *
 * @file s26-alignment-editor-options.test.js
 * BC Session Settings ▸ Alignment (1.7) and Tools ▸ Options ▸ Text (1.9).
 *
 * The first block is the regression pin: with no new option supplied the
 * engine must produce exactly what it produced before these options existed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  diffLines, myersDiff, patienceDiff, histogramDiff,
  ALIGNMENT_MODES, normaliseAlignmentMode, positionalOps, splitAlignedPairs,
} from '../../src/renderer/src/core/diff-engine.js'
import {
  computeAutoIndent, computeBackspaceUnindent, computeBeyondEolPad,
  lineBoundsAt, visualColumn, navAvailability,
} from '../../src/renderer/src/views/text-compare.js'

// ---------------------------------------------------------------------------
// Defaults must not move
// ---------------------------------------------------------------------------

describe('default output is unchanged by the new options', () => {
  const samples = [
    ['', ''],
    ['a\n', 'a\n'],
    ['a\nb\nc\n', 'a\nx\nc\n'],
    ['a\nb\nc\nd\ne\n', 'c\nd\ne\nf\ng\n'],
    ['one\ntwo\nthree\n', ''],
    ['', 'one\ntwo\nthree\n'],
    ['x\n'.repeat(50), 'y\n'.repeat(50)],
  ]

  for (const algorithm of ['myers', 'patience', 'histogram']) {
    it(`${algorithm}: omitting alignMode equals alignMode:'standard'`, () => {
      for (const [l, r] of samples) {
        const bare = diffLines(l, r, { algorithm })
        expect(diffLines(l, r, { algorithm, alignMode: 'standard' })).toEqual(bare)
        // An unrecognised value must also fall back rather than change output.
        expect(diffLines(l, r, { algorithm, alignMode: 'nonsense' })).toEqual(bare)
        expect(diffLines(l, r, { algorithm, alignMode: undefined })).toEqual(bare)
      }
    })
  }

  it('the array-input exports are untouched', () => {
    const L = ['a\n', 'b\n', 'c\n']
    const R = ['a\n', 'x\n', 'c\n']
    for (const fn of [myersDiff, patienceDiff, histogramDiff]) {
      const out = fn(L, R)
      expect(out.map((d) => d.type)).toContain('replace')
    }
  })
})

// ---------------------------------------------------------------------------
// Mode plumbing
// ---------------------------------------------------------------------------

describe('normaliseAlignmentMode', () => {
  it('accepts the three modes and rejects everything else', () => {
    expect([...ALIGNMENT_MODES]).toEqual(['standard', 'unaligned', 'never'])
    for (const m of ALIGNMENT_MODES) expect(normaliseAlignmentMode(m)).toBe(m)
    for (const bad of [null, undefined, '', 'Standard', 0, {}, []]) {
      expect(normaliseAlignmentMode(bad)).toBe('standard')
    }
  })
})

describe("alignMode: 'unaligned'", () => {
  it('pairs row i with row i and never searches', () => {
    // Standard alignment finds the shared "b"; unaligned must not.
    const l = 'b\nc\n'
    const r = 'a\nb\nc\n'
    const out = diffLines(l, r, { alignMode: 'unaligned' })
    expect(out.map((d) => [d.type, d.leftText.trim(), d.rightText.trim()])).toEqual([
      ['replace', 'b', 'a'],
      ['replace', 'c', 'b'],
      ['insert', '', 'c'],
    ])
  })

  it('equal rows stay equal', () => {
    const out = diffLines('a\nb\n', 'a\nz\n', { alignMode: 'unaligned' })
    expect(out.map((d) => d.type)).toEqual(['equal', 'replace'])
  })

  it('honours the normalisation options', () => {
    const out = diffLines('A\n', ' a \n', { alignMode: 'unaligned', ignoreCase: true, ignoreWhitespace: true })
    expect(out.map((d) => d.type)).toEqual(['equal'])
  })

  it('emits trailing orphans on the longer side only', () => {
    expect(diffLines('a\nb\nc\n', 'a\n', { alignMode: 'unaligned' }).map((d) => d.type))
      .toEqual(['equal', 'delete', 'delete'])
    expect(diffLines('a\n', 'a\nb\nc\n', { alignMode: 'unaligned' }).map((d) => d.type))
      .toEqual(['equal', 'insert', 'insert'])
  })

  it('positionalOps is linear and allocates nothing per candidate pair', () => {
    const n = 200_000
    const L = Array.from({ length: n }, (_, i) => `l${i}\n`)
    const R = Array.from({ length: n }, (_, i) => (i % 2 ? `l${i}\n` : `r${i}\n`))
    const t0 = Date.now()
    const ops = positionalOps(L, R)
    // n/2 equals + n/2 delete/insert pairs
    expect(ops.length).toBe(n / 2 + n)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe("alignMode: 'never'", () => {
  it('produces no replace rows', () => {
    const out = diffLines('a\nb\nc\n', 'a\nx\nc\n', { alignMode: 'never' })
    expect(out.map((d) => d.type)).toEqual(['equal', 'delete', 'insert', 'equal'])
    expect(out.some((d) => d.type === 'replace')).toBe(false)
  })

  it('groups a run as one deleted block then one inserted block', () => {
    const out = diffLines('a\nb\nc\nd\n', 'a\nx\ny\nd\n', { alignMode: 'never' })
    expect(out.map((d) => `${d.type}:${(d.leftText || d.rightText).trim()}`)).toEqual([
      'equal:a', 'delete:b', 'delete:c', 'insert:x', 'insert:y', 'equal:d',
    ])
  })

  it('splitAlignedPairs is idempotent', () => {
    const once = splitAlignedPairs(diffLines('a\nb\n', 'a\nx\n'))
    expect(splitAlignedPairs(once)).toEqual(once)
  })

  it('leaves a manual align anchor alone', () => {
    const rows = [
      { type: 'replace', leftLine: 1, rightLine: 1, leftText: 'a', rightText: 'A', alignAnchor: true },
      { type: 'replace', leftLine: 2, rightLine: 2, leftText: 'b', rightText: 'B' },
    ]
    const out = splitAlignedPairs(rows)
    expect(out[0]).toEqual(rows[0])
    expect(out.slice(1).map((d) => d.type)).toEqual(['delete', 'insert'])
  })

  it('handles inputs that are all one-sided', () => {
    expect(splitAlignedPairs([])).toEqual([])
    const only = diffLines('a\nb\n', '', { alignMode: 'never' })
    expect(only.map((d) => d.type)).toEqual(['delete', 'delete'])
  })
})

// ---------------------------------------------------------------------------
// Performance ceiling: tens of thousands of lines, not five
// ---------------------------------------------------------------------------

describe('scale', () => {
  it('unaligned mode handles 50k lines per side', () => {
    const n = 50_000
    const l = Array.from({ length: n }, (_, i) => `line ${i}\n`).join('')
    const r = Array.from({ length: n }, (_, i) => `line ${i % 7 === 0 ? -i : i}\n`).join('')
    const t0 = Date.now()
    const out = diffLines(l, r, { alignMode: 'unaligned' })
    expect(out.length).toBe(n)
    expect(Date.now() - t0).toBeLessThan(10_000)
  })

  it('never-align mode handles 50k lines per side', () => {
    const n = 50_000
    const l = Array.from({ length: n }, (_, i) => `line ${i}\n`).join('')
    const r = Array.from({ length: n }, (_, i) => `line ${i % 500 === 0 ? -i : i}\n`).join('')
    const t0 = Date.now()
    const out = diffLines(l, r, { alignMode: 'never' })
    expect(out.some((d) => d.type === 'replace')).toBe(false)
    expect(Date.now() - t0).toBeLessThan(20_000)
  })
})

// ---------------------------------------------------------------------------
// 1.9 editor behaviour (pure)
// ---------------------------------------------------------------------------

describe('lineBoundsAt / visualColumn', () => {
  it('finds the line around a caret', () => {
    const t = 'aa\nbbb\ncc'
    expect(lineBoundsAt(t, 0)).toEqual({ start: 0, end: 2 })
    expect(lineBoundsAt(t, 2)).toEqual({ start: 0, end: 2 })
    expect(lineBoundsAt(t, 3)).toEqual({ start: 3, end: 6 })
    expect(lineBoundsAt(t, 9)).toEqual({ start: 7, end: 9 })
  })

  it('clamps out-of-range carets instead of throwing', () => {
    expect(lineBoundsAt('abc', -5)).toEqual({ start: 0, end: 3 })
    expect(lineBoundsAt('abc', 99)).toEqual({ start: 0, end: 3 })
  })

  it('expands tabs to the next stop', () => {
    expect(visualColumn('', 4)).toBe(0)
    expect(visualColumn('  ', 4)).toBe(2)
    expect(visualColumn('\t', 4)).toBe(4)
    expect(visualColumn(' \t', 4)).toBe(4)
    expect(visualColumn('\t\t', 4)).toBe(8)
    expect(visualColumn('\t ', 4)).toBe(5)
    expect(visualColumn('\t', 0)).toBe(4)
  })
})

describe('computeAutoIndent', () => {
  it('carries the leading whitespace of the current line', () => {
    const r = computeAutoIndent('    foo', 7)
    expect(r.text).toBe('    foo\n    ')
    expect(r.caret).toBe(12)
  })

  it('copies tabs verbatim', () => {
    expect(computeAutoIndent('\t\tx', 3).text).toBe('\t\tx\n\t\t')
  })

  it('copies only the indentation already before the caret', () => {
    // Caret sits after two of the four leading spaces.
    expect(computeAutoIndent('    foo', 2).text).toBe('  \n    foo')
  })

  it('adds nothing for an unindented line', () => {
    expect(computeAutoIndent('foo', 3).text).toBe('foo\n')
  })

  it('uses the line the caret is on, not the first line', () => {
    expect(computeAutoIndent('a\n  b', 5).text).toBe('a\n  b\n  ')
  })
})

describe('computeBackspaceUnindent', () => {
  it('falls back to the previous tab stop', () => {
    const r = computeBackspaceUnindent('        x', 8, 4)
    expect(r).toEqual({ text: '    x', caret: 4 })
  })

  it('goes to the nearest stop when not on one', () => {
    expect(computeBackspaceUnindent('      x', 6, 4)).toEqual({ text: '    x', caret: 4 })
  })

  it('removes a whole tab character', () => {
    expect(computeBackspaceUnindent('\t\tx', 2, 4)).toEqual({ text: '\tx', caret: 1 })
  })

  it('declines outside the leading whitespace', () => {
    expect(computeBackspaceUnindent('    foo', 7, 4)).toBeNull()
    expect(computeBackspaceUnindent('foo', 3, 4)).toBeNull()
  })

  it('declines at the very start of a line', () => {
    expect(computeBackspaceUnindent('  a\n  b', 4, 4)).toBeNull()
    expect(computeBackspaceUnindent('  a', 0, 4)).toBeNull()
  })

  it('works on a line other than the first', () => {
    expect(computeBackspaceUnindent('a\n    b', 6, 4)).toEqual({ text: 'a\nb', caret: 2 })
  })
})

describe('computeBeyondEolPad', () => {
  it('appends one space at end of line', () => {
    expect(computeBeyondEolPad('ab', 2)).toEqual({ text: 'ab ', caret: 3 })
  })

  it('pads before the newline, not after it', () => {
    expect(computeBeyondEolPad('ab\ncd', 2)).toEqual({ text: 'ab \ncd', caret: 3 })
  })

  it('declines mid-line', () => {
    expect(computeBeyondEolPad('ab', 1)).toBeNull()
  })

  it('handles an empty line', () => {
    expect(computeBeyondEolPad('a\n\nb', 2)).toEqual({ text: 'a\n \nb', caret: 3 })
  })
})

// ---------------------------------------------------------------------------
// Navigation availability
// ---------------------------------------------------------------------------

describe('navAvailability', () => {
  it('is all-off with no differences', () => {
    expect(navAvailability(-1, 0, false)).toEqual({ first: false, prev: false, next: false, last: false })
    expect(navAvailability(-1, 0, true)).toEqual({ first: false, prev: false, next: false, last: false })
  })

  it('dims prev/first at the top and next/last at the bottom', () => {
    expect(navAvailability(0, 3, false)).toEqual({ first: false, prev: false, next: true, last: true })
    expect(navAvailability(1, 3, false)).toEqual({ first: true, prev: true, next: true, last: true })
    expect(navAvailability(2, 3, false)).toEqual({ first: true, prev: true, next: false, last: false })
  })

  it('dims everything on a lone difference already selected', () => {
    expect(navAvailability(0, 1, false)).toEqual({ first: false, prev: false, next: false, last: false })
    expect(navAvailability(0, 1, true)).toEqual({ first: false, prev: false, next: false, last: false })
  })

  it('keeps stepping enabled with wrap-around', () => {
    expect(navAvailability(0, 3, true)).toEqual({ first: false, prev: true, next: true, last: true })
    expect(navAvailability(2, 3, true)).toEqual({ first: true, prev: true, next: true, last: false })
  })

  it('treats "nothing selected" as able to move anywhere', () => {
    expect(navAvailability(-1, 3, false)).toEqual({ first: true, prev: false, next: true, last: true })
  })

  it('survives junk input', () => {
    expect(navAvailability(NaN, NaN, false)).toEqual({ first: false, prev: false, next: false, last: false })
  })
})

// ---------------------------------------------------------------------------
// TextCompare integration (headless — no DOM mount)
// ---------------------------------------------------------------------------

describe('TextCompare alignment / editor options', () => {
  /** @type {import('../../src/renderer/src/views/text-compare.js').TextCompare} */
  let tc
  /** @type {typeof import('../../src/renderer/src/views/text-compare.js').TextCompare} */
  let TextCompare

  beforeEach(async () => {
    vi.resetModules()
    ;({ TextCompare } = await import('../../src/renderer/src/views/text-compare.js'))
    tc = new TextCompare()
  })

  it('defaults to standard alignment and every editor option off', () => {
    expect(tc.getAlignmentMode()).toBe('standard')
    expect(tc.getEditorOptions()).toEqual({
      autoIndent: false, backspaceUnindents: false, allowBeyondEol: false,
    })
    // Defaults on: the status bar has always reported the hidden count.
    expect(tc.getShowFilteredLineCounts()).toBe(true)
  })

  it('rejects an unknown mode without leaving the session stuck', () => {
    expect(tc.setAlignmentMode('sideways')).toBe('standard')
    expect(tc.getAlignmentMode()).toBe('standard')
  })

  it('round-trips through getConfig / applyConfig', () => {
    tc.setAlignmentMode('never')
    tc.setEditorOption('autoIndent', true)
    tc.setEditorOption('backspaceUnindents', true)
    tc.setShowFilteredLineCounts(false)
    const cfg = tc.getConfig()

    const other = new TextCompare()
    other.applyConfig(cfg)
    expect(other.getAlignmentMode()).toBe('never')
    expect(other.getEditorOptions()).toEqual({
      autoIndent: true, backspaceUnindents: true, allowBeyondEol: false,
    })
    expect(other.getShowFilteredLineCounts()).toBe(false)
  })

  it('a config carrying a bogus mode lands on standard', () => {
    const cfg = tc.getConfig()
    cfg.alignMode = 'wat'
    const other = new TextCompare()
    other.applyConfig(cfg)
    expect(other.getAlignmentMode()).toBe('standard')
  })

  it('setEditorOption reports an unknown name instead of storing it', () => {
    expect(tc.setEditorOption('nope', true)).toBe(false)
    expect(Object.keys(tc.getEditorOptions())).toEqual(
      ['autoIndent', 'backspaceUnindents', 'allowBeyondEol'])
  })

  it('getNavAvailability is all-off before any files are loaded', () => {
    expect(tc.getNavAvailability()).toEqual({
      first: false, prev: false, next: false, last: false,
    })
  })
})
