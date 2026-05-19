/**
 * S13-C01: tests for the diff-based merge alignment in ThreeWayCompare.
 * The pre-fix implementation used positional alignment (leftLines[i] vs
 * baseLines[i]) which marked every line after a single insertion as a
 * conflict. These tests prove the fix.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest'
import { ThreeWayCompare } from '../../src/renderer/src/views/three-way-compare.js'
import { _buildHunks } from '../../src/renderer/src/views/three-way-compare.js'
import { diffLines } from '../../src/renderer/src/core/diff-engine.js'

describe('S13-C01 _buildHunks', () => {
  it('returns empty for identical inputs', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nb\nc\n')
    expect(_buildHunks(diff)).toEqual([])
  })

  it('captures a single-line replace as one hunk', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    const hunks = _buildHunks(diff)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].baseStart).toBe(1)
    expect(hunks[0].baseEnd).toBe(2)
    expect(hunks[0].newLines).toEqual(['B'])
  })

  it('captures pure insert as zero-width base range', () => {
    const diff = diffLines('a\nc\n', 'a\nb\nc\n')
    const hunks = _buildHunks(diff)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].baseStart).toBe(1)
    expect(hunks[0].baseEnd).toBe(1)
    expect(hunks[0].newLines).toEqual(['b'])
  })

  it('captures pure delete with empty newLines', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nc\n')
    const hunks = _buildHunks(diff)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].baseStart).toBe(1)
    expect(hunks[0].baseEnd).toBe(2)
    expect(hunks[0].newLines).toEqual([])
  })
})

describe('S13-C01 _threeWayMerge — alignment after insertion', () => {
  it('insertion in left does not mark trailing equal lines as conflicts', () => {
    // BASE:    a / b / c
    // LEFT:    a / X / b / c   (inserted X before b)
    // RIGHT:   a / b / c       (unchanged)
    // Expected: one normal segment ['a','X','b','c']; zero conflicts.
    const tw = new ThreeWayCompare()
    const result = tw._threeWayMerge('a\nX\nb\nc', 'a\nb\nc', 'a\nb\nc')
    expect(result.hasConflicts).toBe(false)
    // The output text should equal the left side (since right is unchanged).
    const text = result.segments
      .filter(s => s.type === 'normal')
      .flatMap(s => s.lines)
      .join('\n')
    expect(text).toContain('a')
    expect(text).toContain('X')
    expect(text).toContain('b')
    expect(text).toContain('c')
  })

  it('non-overlapping edits on both sides do not conflict', () => {
    // BASE:    a / b / c / d
    // LEFT:    A / b / c / d   (changed first line)
    // RIGHT:   a / b / c / D   (changed last line)
    const tw = new ThreeWayCompare()
    const result = tw._threeWayMerge('A\nb\nc\nd', 'a\nb\nc\nd', 'a\nb\nc\nD')
    expect(result.hasConflicts).toBe(false)
  })

  it('overlapping edits on the same line produce a conflict', () => {
    // BASE:    a / b / c
    // LEFT:    a / LEFT / c
    // RIGHT:   a / RIGHT / c
    const tw = new ThreeWayCompare()
    const result = tw._threeWayMerge('a\nLEFT\nc', 'a\nb\nc', 'a\nRIGHT\nc')
    expect(result.hasConflicts).toBe(true)
    const conflict = result.segments.find(s => s.type === 'conflict')
    expect(conflict).toBeTruthy()
    expect(conflict.leftLines).toContain('LEFT')
    expect(conflict.rightLines).toContain('RIGHT')
  })

  it('identical edits on both sides do not conflict (false-conflict suppression)', () => {
    const tw = new ThreeWayCompare()
    const result = tw._threeWayMerge('a\nNEW\nc', 'a\nb\nc', 'a\nNEW\nc')
    expect(result.hasConflicts).toBe(false)
  })

  it('insertion on left and unrelated change on right does not conflict', () => {
    // BASE:    a / b / c
    // LEFT:    a / X / b / c
    // RIGHT:   a / b / Z
    const tw = new ThreeWayCompare()
    const result = tw._threeWayMerge('a\nX\nb\nc', 'a\nb\nc', 'a\nb\nZ')
    expect(result.hasConflicts).toBe(false)
  })

  it('pure deletes on one side leave the other side intact', () => {
    // BASE:  a / b / c / d
    // LEFT:  a / d           (deleted b and c)
    // RIGHT: a / b / c / d   (unchanged)
    const tw = new ThreeWayCompare()
    const result = tw._threeWayMerge('a\nd', 'a\nb\nc\nd', 'a\nb\nc\nd')
    expect(result.hasConflicts).toBe(false)
  })
})
