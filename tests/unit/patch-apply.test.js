/**
 * Applying a patch — the only part of the feature that writes.
 *
 * The cases that matter are the ones where it must refuse: a file that has
 * moved on, two hunks landing on the same lines, a patch made against
 * something else entirely. Half-applying any of those leaves a file that is
 * neither the old one nor the new one, with nothing saying so.
 */
import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff } from '../../src/renderer/src/core/patch.js'
import {
  applyHunks, locateHunk, expectedLines, resultLines, targetPath,
} from '../../src/renderer/src/core/patch-apply.js'

/**
 * @param {string} body
 * @returns {import('../../src/renderer/src/core/patch.js').PatchHunk[]}
 */
const hunksOf = (body) => parseUnifiedDiff(body)[0].hunks

const SIMPLE = [
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -2,3 +2,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '',
].join('\n')

describe('what a hunk expects and leaves', () => {
  it('separates the two sides of a hunk', () => {
    const [h] = hunksOf(SIMPLE)
    expect(expectedLines(h)).toEqual(['one', 'two', 'three'])
    expect(resultLines(h)).toEqual(['one', 'TWO', 'three'])
  })
})

describe('locating a hunk', () => {
  it('finds it where the header says', () => {
    const [h] = hunksOf(SIMPLE)
    expect(locateHunk(['zero', 'one', 'two', 'three'], h)).toBe(1)
  })

  it('finds it after the file has drifted', () => {
    // A patch made against a slightly older copy still applies — this is the
    // tolerance that separates "applies" from "rejected" on real files.
    const [h] = hunksOf(SIMPLE)
    const lines = ['added', 'lines', 'up', 'front', 'one', 'two', 'three']
    expect(locateHunk(lines, h)).toBe(4)
  })

  it('reports -1 when the context is simply not there', () => {
    const [h] = hunksOf(SIMPLE)
    expect(locateHunk(['completely', 'different', 'file'], h)).toBe(-1)
  })

  it('will not look further than the radius allows', () => {
    const [h] = hunksOf(SIMPLE)
    const lines = Array.from({ length: 400 }, (_, i) => `pad${i}`)
      .concat(['one', 'two', 'three'])
    expect(locateHunk(lines, h, 5)).toBe(-1)
    expect(locateHunk(lines, h, 500)).toBe(400)
  })
})

describe('applying', () => {
  it('rewrites the matching lines and leaves the rest alone', () => {
    const out = applyHunks('zero\none\ntwo\nthree\nfour', hunksOf(SIMPLE))
    expect(out.ok).toBe(true)
    expect(out.applied).toBe(1)
    expect(out.text).toBe('zero\none\nTWO\nthree\nfour')
  })

  it('applies several hunks in one file', () => {
    const patch = [
      '--- a/f', '+++ b/f',
      '@@ -1,2 +1,2 @@', '-a', '+A', ' b',
      '@@ -5,2 +5,2 @@', ' e', '-f', '+F',
      '',
    ].join('\n')
    const out = applyHunks('a\nb\nc\nd\ne\nf\ng', hunksOf(patch))
    expect(out.ok).toBe(true)
    expect(out.applied).toBe(2)
    expect(out.text).toBe('A\nb\nc\nd\ne\nF\ng')
  })

  it('changes nothing at all when one hunk cannot be placed', () => {
    // The point of the whole module: a half-applied file is worse than an
    // unapplied one, because nothing on disk says which it is.
    const patch = [
      '--- a/f', '+++ b/f',
      '@@ -1,2 +1,2 @@', '-a', '+A', ' b',
      '@@ -5,2 +5,2 @@', ' NOPE', '-f', '+F',
      '',
    ].join('\n')
    const source = 'a\nb\nc\nd\ne\nf\ng'
    const out = applyHunks(source, hunksOf(patch))

    expect(out.ok).toBe(false)
    expect(out.applied).toBe(0)
    expect(out.text).toBe(source)
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0].reason).toMatch(/找不到/)
  })

  it('refuses two hunks that resolve onto the same lines', () => {
    // Applying both would corrupt each other; the second would rewrite text the
    // first had already replaced.
    const patch = [
      '--- a/f', '+++ b/f',
      '@@ -1,2 +1,2 @@', ' x', '-y', '+Y',
      '@@ -2,2 +2,2 @@', '-y', '+Z', ' z',
      '',
    ].join('\n')
    const out = applyHunks('x\ny\nz', hunksOf(patch))
    expect(out.ok).toBe(false)
    expect(out.failures.some((f) => /重疊/.test(f.reason))).toBe(true)
  })

  it('names every failure rather than only the first', () => {
    const patch = [
      '--- a/f', '+++ b/f',
      '@@ -1,1 +1,1 @@', '-nope1', '+x',
      '@@ -9,1 +9,1 @@', '-nope2', '+y',
      '',
    ].join('\n')
    const out = applyHunks('a\nb\nc', hunksOf(patch))
    expect(out.failures).toHaveLength(2)
  })

  it('inserts into an empty file, leaving the lines terminated', () => {
    // The trailing newline is not an artefact: an empty file is one empty line,
    // and inserting above it gives two terminated lines — the same bytes
    // `patch(1)` writes.
    const patch = ['--- a/f', '+++ b/f', '@@ -0,0 +1,2 @@', '+first', '+second', ''].join('\n')
    const out = applyHunks('', hunksOf(patch))
    expect(out.ok).toBe(true)
    expect(out.text).toBe('first\nsecond\n')
  })

  it('handles a patch with no hunks as a no-op rather than an error', () => {
    const out = applyHunks('unchanged', [])
    expect(out.ok).toBe(true)
    expect(out.text).toBe('unchanged')
    expect(out.applied).toBe(0)
  })

  it('is idempotent in the sense that re-applying is refused, not doubled', () => {
    // The context no longer matches once the change is in, so the second run
    // fails instead of applying it twice.
    const first = applyHunks('zero\none\ntwo\nthree', hunksOf(SIMPLE))
    expect(first.ok).toBe(true)
    const second = applyHunks(first.text, hunksOf(SIMPLE))
    expect(second.ok).toBe(false)
  })
})

describe('choosing where to write', () => {
  it('strips the a/ and b/ prefixes git puts on', () => {
    // Writing to a literal "b/src/x.js" would create a directory nobody asked
    // for, next to the file that was supposed to change.
    expect(targetPath({ oldPath: 'a/src/x.js', newPath: 'b/src/x.js' })).toBe('src/x.js')
  })

  it('falls back to the old path when the new one is /dev/null', () => {
    expect(targetPath({ oldPath: 'a/gone.txt', newPath: '/dev/null' })).toBe('gone.txt')
  })

  it('leaves a plain path alone', () => {
    expect(targetPath({ oldPath: 'src/x.js', newPath: 'src/x.js' })).toBe('src/x.js')
  })
})
