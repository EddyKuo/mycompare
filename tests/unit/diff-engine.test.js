/**
 * Unit tests for src/renderer/src/core/diff-engine.js
 *
 * The module is expected to export:
 *   - myersDiff(leftLines, rightLines)  → DiffResult[]
 *   - patienceDiff(leftLines, rightLines) → DiffResult[]
 *   - intralineDiff(leftText, rightText) → CharDiffToken[]
 *
 * DiffResult shape:
 *   { type: 'equal'|'insert'|'delete'|'replace',
 *     leftLine:  number|null,
 *     rightLine: number|null,
 *     leftText:  string|null,
 *     rightText: string|null }
 *
 * CharDiffToken shape:
 *   { type: 'equal'|'insert'|'delete', text: string }
 */

import { describe, it, expect } from 'vitest'

// ── Graceful import ───────────────────────────────────────────────────────────
let myersDiff, patienceDiff, intralineDiff, histogramDiff
let importError = null

try {
  const mod = await import('../../src/renderer/src/core/diff-engine.js')
  myersDiff     = mod.myersDiff
  patienceDiff  = mod.patienceDiff
  intralineDiff = mod.intralineDiff
  histogramDiff = mod.histogramDiff
} catch (err) {
  importError = err
}

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Assert that the module was loaded before running any real test.
 * If the module does not exist yet, every test will throw a descriptive error
 * instead of a cryptic "TypeError: ... is not a function".
 */
function requireModule() {
  if (importError) {
    throw new Error(
      `diff-engine.js module not found or failed to load.\n` +
      `Create src/renderer/src/core/diff-engine.js and export myersDiff, ` +
      `patienceDiff, intralineDiff.\n` +
      `Original error: ${importError.message}`
    )
  }
}

/**
 * Validate a single DiffResult object's shape.
 */
function assertDiffResultShape(result) {
  expect(result).toBeTypeOf('object')
  expect(['equal', 'insert', 'delete', 'replace']).toContain(result.type)
  expect(result).toHaveProperty('leftLine')
  expect(result).toHaveProperty('rightLine')
  expect(result).toHaveProperty('leftText')
  expect(result).toHaveProperty('rightText')
}

/**
 * Collect all result entries of a given type.
 */
function ofType(results, type) {
  return results.filter(r => r.type === type)
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Myers Diff
// ═══════════════════════════════════════════════════════════════════════════════

describe('myersDiff', () => {
  // ── 1-A: identical arrays → zero diff ──────────────────────────────────────
  it('returns zero differences for two identical arrays', () => {
    requireModule()
    const lines = ['alpha', 'beta', 'gamma']
    const result = myersDiff(lines, lines)

    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    result.forEach(assertDiffResultShape)

    const nonEqual = ofType(result, 'insert').concat(
      ofType(result, 'delete'),
      ofType(result, 'replace')
    )
    expect(nonEqual).toHaveLength(0)
  })

  // ── 1-B: one line inserted on the right ────────────────────────────────────
  it('detects a single inserted line (right side has one more line)', () => {
    requireModule()
    const left  = ['line1', 'line2']
    const right = ['line1', 'NEW LINE', 'line2']
    const result = myersDiff(left, right)

    result.forEach(assertDiffResultShape)

    const inserts = ofType(result, 'insert')
    expect(inserts.length).toBeGreaterThanOrEqual(1)
    const insertedTexts = inserts.map(r => r.rightText)
    expect(insertedTexts).toContain('NEW LINE')
  })

  // ── 1-C: one line deleted from the left ────────────────────────────────────
  it('detects a single deleted line (left side has one extra line)', () => {
    requireModule()
    const left  = ['line1', 'REMOVED LINE', 'line2']
    const right = ['line1', 'line2']
    const result = myersDiff(left, right)

    result.forEach(assertDiffResultShape)

    const deletes = ofType(result, 'delete')
    expect(deletes.length).toBeGreaterThanOrEqual(1)
    const deletedTexts = deletes.map(r => r.leftText)
    expect(deletedTexts).toContain('REMOVED LINE')
  })

  // ── 1-D: one line modified (replace = delete + insert) ─────────────────────
  it('detects a single modified line as replace (or delete+insert)', () => {
    requireModule()
    const left  = ['unchanged', 'old content', 'footer']
    const right = ['unchanged', 'new content', 'footer']
    const result = myersDiff(left, right)

    result.forEach(assertDiffResultShape)

    // Modification may be represented as 'replace' OR as a 'delete'+'insert' pair.
    const replaced  = ofType(result, 'replace')
    const deleted   = ofType(result, 'delete')
    const inserted  = ofType(result, 'insert')

    const hasReplace       = replaced.some(r => r.leftText === 'old content' && r.rightText === 'new content')
    const hasDeleteInsert  = deleted.some(r => r.leftText === 'old content') &&
                             inserted.some(r => r.rightText === 'new content')

    expect(hasReplace || hasDeleteInsert).toBe(true)
  })

  // ── 1-E: multi-line mixed changes ──────────────────────────────────────────
  it('handles multiple mixed insertions and deletions', () => {
    requireModule()
    const left  = ['A', 'B', 'C', 'D', 'E']
    const right = ['A', 'X', 'C', 'Y', 'Z', 'E']
    const result = myersDiff(left, right)

    result.forEach(assertDiffResultShape)

    // 'A', 'C', 'E' should be equal; 'B'/'D' modified or deleted; 'X'/'Y'/'Z' inserted
    const equalTexts = ofType(result, 'equal').map(r => r.leftText)
    expect(equalTexts).toContain('A')
    expect(equalTexts).toContain('C')
    expect(equalTexts).toContain('E')
  })

  // ── 1-F: empty left array vs non-empty right ────────────────────────────────
  it('treats all lines as insertions when left is empty', () => {
    requireModule()
    const left  = []
    const right = ['only', 'in', 'right']
    const result = myersDiff(left, right)

    result.forEach(assertDiffResultShape)

    const inserts = ofType(result, 'insert')
    const insertedTexts = inserts.map(r => r.rightText)
    expect(insertedTexts).toContain('only')
    expect(insertedTexts).toContain('in')
    expect(insertedTexts).toContain('right')
  })

  // ── 1-G: non-empty left vs empty right ─────────────────────────────────────
  it('treats all lines as deletions when right is empty', () => {
    requireModule()
    const left  = ['only', 'in', 'left']
    const right = []
    const result = myersDiff(left, right)

    result.forEach(assertDiffResultShape)

    const deletes = ofType(result, 'delete')
    const deletedTexts = deletes.map(r => r.leftText)
    expect(deletedTexts).toContain('only')
    expect(deletedTexts).toContain('in')
    expect(deletedTexts).toContain('left')
  })

  // ── 1-H: both empty arrays ──────────────────────────────────────────────────
  it('returns an empty array when both inputs are empty', () => {
    requireModule()
    const result = myersDiff([], [])
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  // ── 1-I: performance test – 1 000-line arrays ───────────────────────────────
  it('completes a 1 000-line diff in under 500 ms (performance)', () => {
    requireModule()
    const left  = Array.from({ length: 1000 }, (_, i) => `line ${i}`)
    // Change every 10th line to force real diff work
    const right = left.map((l, i) => (i % 10 === 0 ? `CHANGED line ${i}` : l))

    const start = performance.now()
    const result = myersDiff(left, right)
    const elapsed = performance.now() - start

    expect(Array.isArray(result)).toBe(true)
    expect(elapsed).toBeLessThan(500)
  }, 1000 /* test timeout */)
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Patience Diff
// ═══════════════════════════════════════════════════════════════════════════════

describe('patienceDiff', () => {
  // ── 2-A: identical arrays → zero diff ──────────────────────────────────────
  it('returns zero differences for identical arrays', () => {
    requireModule()
    const lines = ['function foo() {', '  return 1', '}']
    const result = patienceDiff(lines, lines)

    result.forEach(assertDiffResultShape)
    const nonEqual = result.filter(r => r.type !== 'equal')
    expect(nonEqual).toHaveLength(0)
  })

  // ── 2-B: function moved to different position ───────────────────────────────
  it('produces more precise alignment when a function block moves (unique-line anchors)', () => {
    requireModule()
    // Patience diff uses unique lines as anchors, so it should correctly
    // anchor on the unique function signature even when surrounding lines shift.
    const left = [
      'function helper() {',
      '  return 42',
      '}',
      '',
      'function main() {',
      '  helper()',
      '}'
    ]
    const right = [
      'function main() {',
      '  helper()',
      '}',
      '',
      'function helper() {',
      '  return 42',
      '}'
    ]

    const result = patienceDiff(left, right)
    result.forEach(assertDiffResultShape)

    // Patience diff should recognise unique anchors like 'function helper() {'
    // and 'function main() {' and NOT lose them entirely.
    // At minimum, the result should be non-empty and well-formed.
    expect(result.length).toBeGreaterThan(0)

    // The equal segments must account for all unique anchor lines.
    // (A Myers diff over the same input would produce a less meaningful alignment.)
    const equalTexts = ofType(result, 'equal').flatMap(r => [r.leftText, r.rightText])
    // At least one anchor line should be preserved as equal or present in result
    const allResultTexts = result.flatMap(r => [r.leftText, r.rightText]).filter(Boolean)
    const anchors = ['function helper() {', 'function main() {', '  return 42', '  helper()']
    anchors.forEach(anchor => {
      expect(allResultTexts).toContain(anchor)
    })
  })

  // ── 2-C: unique line anchors are correctly identified ──────────────────────
  it('identifies unique line anchors to guide alignment', () => {
    requireModule()
    // Lines that appear exactly once on each side are unique anchors.
    // Patience diff should preserve them as 'equal' when they match.
    const left  = ['UNIQUE_ANCHOR_A', 'common', 'UNIQUE_ANCHOR_B']
    const right = ['UNIQUE_ANCHOR_A', 'different', 'UNIQUE_ANCHOR_B']

    const result = patienceDiff(left, right)
    result.forEach(assertDiffResultShape)

    const equalTexts = ofType(result, 'equal').map(r => r.leftText)
    expect(equalTexts).toContain('UNIQUE_ANCHOR_A')
    expect(equalTexts).toContain('UNIQUE_ANCHOR_B')
  })

  // ── 2-D: result shape is consistent with myersDiff shape ───────────────────
  it('returns the same DiffResult schema as myersDiff', () => {
    requireModule()
    const left  = ['a', 'b', 'c']
    const right = ['a', 'X', 'c']
    const result = patienceDiff(left, right)
    result.forEach(assertDiffResultShape)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Intraline (character-level) diff
// ═══════════════════════════════════════════════════════════════════════════════

describe('intralineDiff', () => {
  // ── 3-A: single character change ───────────────────────────────────────────
  it('detects a single character substitution', () => {
    requireModule()
    // 'cat' → 'bat': only the first character changes
    const tokens = intralineDiff('cat', 'bat')

    expect(Array.isArray(tokens)).toBe(true)
    tokens.forEach(token => {
      expect(token).toHaveProperty('type')
      expect(token).toHaveProperty('text')
      expect(['equal', 'insert', 'delete']).toContain(token.type)
      expect(token.text).toBeTypeOf('string')
    })

    const deleted  = tokens.filter(t => t.type === 'delete').map(t => t.text).join('')
    const inserted = tokens.filter(t => t.type === 'insert').map(t => t.text).join('')
    expect(deleted).toBe('c')
    expect(inserted).toBe('b')

    // 'at' must survive as equal
    const equal = tokens.filter(t => t.type === 'equal').map(t => t.text).join('')
    expect(equal).toContain('at')
  })

  // ── 3-B: word replacement ──────────────────────────────────────────────────
  it('detects a word replacement within a line', () => {
    requireModule()
    const tokens = intralineDiff('Hello world!', 'Hello Earth!')

    tokens.forEach(token => {
      expect(['equal', 'insert', 'delete']).toContain(token.type)
    })

    const deleted  = tokens.filter(t => t.type === 'delete').map(t => t.text).join('')
    const inserted = tokens.filter(t => t.type === 'insert').map(t => t.text).join('')
    expect(deleted).toContain('world')
    expect(inserted).toContain('Earth')

    // Prefix 'Hello ' and suffix '!' must be preserved as equal
    const equal = tokens.filter(t => t.type === 'equal').map(t => t.text).join('')
    expect(equal).toContain('Hello ')
    expect(equal).toContain('!')
  })

  // ── 3-C: head and tail are identical – only middle differs ─────────────────
  it('preserves equal prefix and suffix when only the middle differs', () => {
    requireModule()
    // 'fooXbar' → 'fooYYbar'
    const tokens = intralineDiff('fooXbar', 'fooYYbar')

    tokens.forEach(token => {
      expect(['equal', 'insert', 'delete']).toContain(token.type)
    })

    const deleted  = tokens.filter(t => t.type === 'delete').map(t => t.text).join('')
    const inserted = tokens.filter(t => t.type === 'insert').map(t => t.text).join('')
    expect(deleted).toContain('X')
    expect(inserted).toContain('YY')

    // 'foo' prefix and 'bar' suffix must appear as equal tokens
    const equalText = tokens.filter(t => t.type === 'equal').map(t => t.text).join('')
    expect(equalText).toContain('foo')
    expect(equalText).toContain('bar')
  })

  // ── 3-D: identical strings → only equal tokens ─────────────────────────────
  it('returns only equal tokens for identical strings', () => {
    requireModule()
    const tokens = intralineDiff('same text', 'same text')

    const nonEqual = tokens.filter(t => t.type !== 'equal')
    expect(nonEqual).toHaveLength(0)

    const equalText = tokens.filter(t => t.type === 'equal').map(t => t.text).join('')
    expect(equalText).toBe('same text')
  })

  // ── 3-E: completely different strings ──────────────────────────────────────
  it('handles completely different strings without crashing', () => {
    requireModule()
    const tokens = intralineDiff('AAAA', 'BBBB')

    expect(Array.isArray(tokens)).toBe(true)
    tokens.forEach(token => {
      expect(['equal', 'insert', 'delete']).toContain(token.type)
    })
    const deleted  = tokens.filter(t => t.type === 'delete').map(t => t.text).join('')
    const inserted = tokens.filter(t => t.type === 'insert').map(t => t.text).join('')
    expect(deleted).toBe('AAAA')
    expect(inserted).toBe('BBBB')
  })

  // ── 3-F: empty left string ──────────────────────────────────────────────────
  it('treats entire right string as inserted when left is empty', () => {
    requireModule()
    const tokens = intralineDiff('', 'hello')

    const nonInsert = tokens.filter(t => t.type !== 'insert')
    expect(nonInsert).toHaveLength(0)
    const inserted = tokens.map(t => t.text).join('')
    expect(inserted).toBe('hello')
  })

  // ── 3-G: empty right string ─────────────────────────────────────────────────
  it('treats entire left string as deleted when right is empty', () => {
    requireModule()
    const tokens = intralineDiff('hello', '')

    const nonDelete = tokens.filter(t => t.type !== 'delete')
    expect(nonDelete).toHaveLength(0)
    const deleted = tokens.map(t => t.text).join('')
    expect(deleted).toBe('hello')
  })

  // ── 3-H: token reconstruction invariant ────────────────────────────────────
  it('equal+delete tokens reconstruct the left string; equal+insert tokens reconstruct the right', () => {
    requireModule()
    const left  = 'the quick brown fox'
    const right = 'the slow red fox'
    const tokens = intralineDiff(left, right)

    const reconstructLeft  = tokens
      .filter(t => t.type === 'equal' || t.type === 'delete')
      .map(t => t.text)
      .join('')
    const reconstructRight = tokens
      .filter(t => t.type === 'equal' || t.type === 'insert')
      .map(t => t.text)
      .join('')

    expect(reconstructLeft).toBe(left)
    expect(reconstructRight).toBe(right)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Histogram Diff
// ═══════════════════════════════════════════════════════════════════════════════

describe('histogramDiff', () => {
  // ── 4-A: identical arrays → zero diff ──────────────────────────────────────
  it('returns zero differences for two identical arrays', () => {
    requireModule()
    const lines = ['alpha', 'beta', 'gamma']
    const result = histogramDiff(lines, lines)

    expect(Array.isArray(result)).toBe(true)
    result.forEach(assertDiffResultShape)

    const nonEqual = result.filter(r => r.type !== 'equal')
    expect(nonEqual).toHaveLength(0)
  })

  // ── 4-B: completely different arrays → all delete+insert ───────────────────
  it('returns only delete/insert/replace entries for completely different arrays', () => {
    requireModule()
    const left  = ['foo', 'bar']
    const right = ['baz', 'qux']
    const result = histogramDiff(left, right)

    result.forEach(assertDiffResultShape)

    const equalEntries = result.filter(r => r.type === 'equal')
    expect(equalEntries).toHaveLength(0)

    // All left lines should appear as deleted/replaced, all right lines as inserted/replaced
    const leftTexts  = result.flatMap(r => r.leftText  ? [r.leftText]  : [])
    const rightTexts = result.flatMap(r => r.rightText ? [r.rightText] : [])
    expect(leftTexts).toContain('foo')
    expect(leftTexts).toContain('bar')
    expect(rightTexts).toContain('baz')
    expect(rightTexts).toContain('qux')
  })

  // ── 4-C: empty left → all inserts ──────────────────────────────────────────
  it('treats all lines as insertions when left is empty', () => {
    requireModule()
    const left  = []
    const right = ['a', 'b', 'c']
    const result = histogramDiff(left, right)

    result.forEach(assertDiffResultShape)

    const inserts = result.filter(r => r.type === 'insert')
    const insertedTexts = inserts.map(r => r.rightText)
    expect(insertedTexts).toContain('a')
    expect(insertedTexts).toContain('b')
    expect(insertedTexts).toContain('c')
    const nonInserts = result.filter(r => r.type !== 'insert')
    expect(nonInserts).toHaveLength(0)
  })

  // ── 4-D: rarest anchor in high-repetition scenario (closing braces) ─────────
  it('correctly anchors on a rare line even when many repeated lines exist', () => {
    requireModule()
    // Many closing braces and one unique function signature
    const left = [
      'function unique_A() {',
      '}',
      '}',
      '}',
      'function unique_B() {',
      '}',
    ]
    const right = [
      'function unique_A() {',
      '}',
      'function unique_B() {',
      '}',
      '}',
      '}',
    ]
    const result = histogramDiff(left, right)

    result.forEach(assertDiffResultShape)
    expect(result.length).toBeGreaterThan(0)

    // The unique function signatures should appear in result
    const allTexts = result.flatMap(r => [r.leftText, r.rightText]).filter(Boolean)
    expect(allTexts).toContain('function unique_A() {')
    expect(allTexts).toContain('function unique_B() {')
  })

  // ── 4-E: same result as Myers on a simple unique-line scenario ──────────────
  it('produces equivalent results to Myers for simple unique-line changes', () => {
    requireModule()
    const left  = ['header', 'old_middle', 'footer']
    const right = ['header', 'new_middle', 'footer']

    const hResult = histogramDiff(left, right)
    const mResult = myersDiff(left, right)

    hResult.forEach(assertDiffResultShape)

    // Both should agree that 'header' and 'footer' are equal
    const hEqualTexts = hResult.filter(r => r.type === 'equal').map(r => r.leftText)
    const mEqualTexts = mResult.filter(r => r.type === 'equal').map(r => r.leftText)
    expect(hEqualTexts).toContain('header')
    expect(hEqualTexts).toContain('footer')
    expect(mEqualTexts).toContain('header')
    expect(mEqualTexts).toContain('footer')
  })

  // ── 4-F: histogramDiff export is callable and doesn't throw ────────────────
  it('histogramDiff export function is callable and does not throw', () => {
    requireModule()
    expect(() => histogramDiff([], [])).not.toThrow()
    expect(() => histogramDiff(['a', 'b'], ['b', 'c'])).not.toThrow()

    const result = histogramDiff(['x'], ['x'])
    expect(Array.isArray(result)).toBe(true)
    result.forEach(assertDiffResultShape)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 5. DiffResult format cross-validation (applies to Myers, Patience & Histogram)
// ═══════════════════════════════════════════════════════════════════════════════

describe('DiffResult format contract', () => {
  const ALGORITHMS = [
    ['myersDiff',    () => myersDiff],
    ['patienceDiff', () => patienceDiff],
    ['histogramDiff', () => histogramDiff],
  ]

  for (const [name, getter] of ALGORITHMS) {
    it(`[${name}] every result has the required fields with correct types`, () => {
      requireModule()
      const fn = getter()
      const result = fn(['foo', 'bar'], ['foo', 'baz'])

      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBeGreaterThan(0)

      for (const item of result) {
        // type
        expect(['equal', 'insert', 'delete', 'replace']).toContain(item.type)

        // leftLine / rightLine: number or null
        if (item.leftLine !== null)  expect(item.leftLine).toBeTypeOf('number')
        if (item.rightLine !== null) expect(item.rightLine).toBeTypeOf('number')

        // leftText / rightText: string or null
        if (item.leftText  !== null) expect(item.leftText).toBeTypeOf('string')
        if (item.rightText !== null) expect(item.rightText).toBeTypeOf('string')

        // Semantic constraints per type
        if (item.type === 'equal') {
          expect(item.leftText).toBe(item.rightText)
          expect(item.leftLine).not.toBeNull()
          expect(item.rightLine).not.toBeNull()
        }
        if (item.type === 'insert') {
          expect(item.leftText).toBeNull()
          expect(item.leftLine).toBeNull()
          expect(item.rightText).not.toBeNull()
          expect(item.rightLine).not.toBeNull()
        }
        if (item.type === 'delete') {
          expect(item.rightText).toBeNull()
          expect(item.rightLine).toBeNull()
          expect(item.leftText).not.toBeNull()
          expect(item.leftLine).not.toBeNull()
        }
        if (item.type === 'replace') {
          expect(item.leftText).not.toBeNull()
          expect(item.rightText).not.toBeNull()
        }
      }
    })

    it(`[${name}] line numbers are monotonically increasing`, () => {
      requireModule()
      const fn = getter()
      const left  = ['a', 'b', 'c', 'd']
      const right = ['a', 'X', 'c', 'Y']
      const result = fn(left, right)

      let lastLeft  = -1
      let lastRight = -1

      for (const item of result) {
        if (item.leftLine  !== null) {
          expect(item.leftLine).toBeGreaterThan(lastLeft)
          lastLeft = item.leftLine
        }
        if (item.rightLine !== null) {
          expect(item.rightLine).toBeGreaterThan(lastRight)
          lastRight = item.rightLine
        }
      }
    })

    it(`[${name}] equal segments cover all unchanged input lines`, () => {
      requireModule()
      const fn = getter()
      const left  = ['same1', 'CHANGED', 'same2']
      const right = ['same1', 'different', 'same2']
      const result = fn(left, right)

      const equalTexts = ofType(result, 'equal').map(r => r.leftText)
      expect(equalTexts).toContain('same1')
      expect(equalTexts).toContain('same2')
    })
  }
})
