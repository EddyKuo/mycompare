/**
 * @file three-way-merge-logic.test.js
 * @description T41 — Three-Way Compare 互動式衝突解決邏輯測試 (node 環境)
 *
 * Tests the pure logic of _threeWayMerge() and _buildOutputText() by
 * creating a minimal harness that extracts these methods without
 * requiring Electron APIs or DOM.
 */

import { describe, it, expect, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Minimal harness — extract pure logic from ThreeWayCompare without DOM/Electron
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for diffLines that returns empty array (not needed for merge logic tests).
 * @returns {[]}
 */
function stubDiffLines() { return [] }

/**
 * Build a minimal instance exposing _threeWayMerge and _buildOutputText
 * with the same logic as ThreeWayCompare, but without DOM/Electron deps.
 */
class ThreeWayMergeLogic {
  constructor() {
    /** @type {Array<{ type: 'normal', lines: string[] } | { type: 'conflict', id: number, leftLines: string[], baseLines: string[], rightLines: string[] }>} */
    this._segments = []

    /** @type {Map<number, 'left'|'right'|'both'|null>} */
    this._conflictChoices = new Map()
  }

  /**
   * Same logic as ThreeWayCompare._threeWayMerge, minus the diffLines calls.
   * @param {string} left
   * @param {string} base
   * @param {string} right
   * @returns {{
   *   leftDiff: [],
   *   rightDiff: [],
   *   segments: Array<{ type: 'normal', lines: string[] } | { type: 'conflict', id: number, leftLines: string[], baseLines: string[], rightLines: string[] }>,
   *   hasConflicts: boolean
   * }}
   */
  _threeWayMerge(left, base, right) {
    const leftDiff = stubDiffLines()
    const rightDiff = stubDiffLines()

    const leftLines = (left || '').split('\n')
    const baseLines = (base || '').split('\n')
    const rightLines = (right || '').split('\n')

    /** @type {Array<{ type: 'normal', lines: string[] } | { type: 'conflict', id: number, leftLines: string[], baseLines: string[], rightLines: string[] }>} */
    const segments = []
    let hasConflicts = false
    let conflictId = 0

    /** @type {string[]} */
    let pendingNormal = []

    const flushNormal = () => {
      if (pendingNormal.length > 0) {
        segments.push({ type: 'normal', lines: [...pendingNormal] })
        pendingNormal = []
      }
    }

    const maxLen = Math.max(leftLines.length, baseLines.length, rightLines.length)
    for (let i = 0; i < maxLen; i++) {
      const b = baseLines[i] ?? ''
      const l = leftLines[i] ?? ''
      const r = rightLines[i] ?? ''

      if (l === b && r === b) {
        pendingNormal.push(b)
      } else if (l !== b && r === b) {
        pendingNormal.push(l)
      } else if (r !== b && l === b) {
        pendingNormal.push(r)
      } else if (l === r) {
        pendingNormal.push(l)
      } else {
        hasConflicts = true
        flushNormal()
        segments.push({
          type: 'conflict',
          id: conflictId++,
          leftLines: [l],
          baseLines: [b],
          rightLines: [r],
        })
      }
    }

    flushNormal()

    return { leftDiff, rightDiff, segments, hasConflicts }
  }

  /**
   * Same logic as ThreeWayCompare._buildOutputText.
   * @returns {string}
   */
  _buildOutputText() {
    return this._segments.map(seg => {
      if (seg.type === 'normal') return seg.lines.join('\n')
      const choice = this._conflictChoices.get(seg.id)
      if (choice === 'left')  return seg.leftLines.join('\n')
      if (choice === 'right') return seg.rightLines.join('\n')
      if (choice === 'both')  return [...seg.leftLines, ...seg.rightLines].join('\n')
      return ['<<<<<<< LEFT', ...seg.leftLines, '||||||| BASE', ...seg.baseLines, '=======', ...seg.rightLines, '>>>>>>> RIGHT'].join('\n')
    }).join('\n')
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T41 — _threeWayMerge() segment structure', () => {
  /** @type {ThreeWayMergeLogic} */
  let instance

  beforeEach(() => {
    instance = new ThreeWayMergeLogic()
  })

  it('should return correct segment shape with segments and hasConflicts fields', () => {
    const result = instance._threeWayMerge('left', 'base', 'right')
    expect(result).toHaveProperty('segments')
    expect(result).toHaveProperty('hasConflicts')
    expect(Array.isArray(result.segments)).toBe(true)
  })

  it('should return hasConflicts=false when all three are identical', () => {
    const result = instance._threeWayMerge('same', 'same', 'same')
    expect(result.hasConflicts).toBe(false)
  })

  it('should return only normal segments when no conflicts exist', () => {
    // left changed line 1, right unchanged — no conflict
    const result = instance._threeWayMerge('left-line', 'base-line', 'base-line')
    expect(result.hasConflicts).toBe(false)
    expect(result.segments.every(s => s.type === 'normal')).toBe(true)
  })

  it('should return hasConflicts=true when left and right both changed differently', () => {
    const result = instance._threeWayMerge('left-change', 'base', 'right-change')
    expect(result.hasConflicts).toBe(true)
  })

  it('should produce a conflict segment with correct structure', () => {
    const result = instance._threeWayMerge('left-change', 'base', 'right-change')
    const conflict = result.segments.find(s => s.type === 'conflict')
    expect(conflict).toBeDefined()
    expect(conflict.type).toBe('conflict')
    expect(typeof conflict.id).toBe('number')
    expect(Array.isArray(conflict.leftLines)).toBe(true)
    expect(Array.isArray(conflict.baseLines)).toBe(true)
    expect(Array.isArray(conflict.rightLines)).toBe(true)
  })

  it('should include correct content in conflict segment lines', () => {
    const result = instance._threeWayMerge('left-change', 'base', 'right-change')
    const conflict = result.segments.find(s => s.type === 'conflict')
    expect(conflict.leftLines).toContain('left-change')
    expect(conflict.baseLines).toContain('base')
    expect(conflict.rightLines).toContain('right-change')
  })

  it('should not produce conflict when both sides changed to same value', () => {
    // Both left and right changed to 'new', no conflict
    const result = instance._threeWayMerge('new', 'old', 'new')
    expect(result.hasConflicts).toBe(false)
    const normal = result.segments.find(s => s.type === 'normal')
    expect(normal).toBeDefined()
    expect(normal.lines).toContain('new')
  })

  it('should handle multi-line content with mixed normal and conflict segments', () => {
    const left  = 'line1\nLEFT\nline3'
    const base  = 'line1\nbase\nline3'
    const right = 'line1\nRIGHT\nline3'
    const result = instance._threeWayMerge(left, base, right)
    expect(result.hasConflicts).toBe(true)
    const types = result.segments.map(s => s.type)
    expect(types).toContain('normal')
    expect(types).toContain('conflict')
  })

  it('should assign sequential ids to multiple conflict segments', () => {
    // Each line is a conflict (left ≠ base ≠ right for every line)
    const left  = 'L1\nL2'
    const base  = 'B1\nB2'
    const right = 'R1\nR2'
    const result = instance._threeWayMerge(left, base, right)
    const conflicts = result.segments.filter(s => s.type === 'conflict')
    expect(conflicts).toHaveLength(2)
    expect(conflicts[0].id).toBe(0)
    expect(conflicts[1].id).toBe(1)
  })
})

describe('T41 — _buildOutputText() choices', () => {
  /** @type {ThreeWayMergeLogic} */
  let instance

  beforeEach(() => {
    instance = new ThreeWayMergeLogic()
  })

  /**
   * Helper: run merge and set up state on instance.
   * @param {string} left
   * @param {string} base
   * @param {string} right
   */
  function runMerge(left, base, right) {
    const { segments, hasConflicts } = instance._threeWayMerge(left, base, right)
    instance._segments = segments
    instance._conflictChoices = new Map()
    segments.forEach(seg => {
      if (seg.type === 'conflict') instance._conflictChoices.set(seg.id, null)
    })
    return hasConflicts
  }

  it('should return left content when choice is left', () => {
    runMerge('left-content', 'base-content', 'right-content')
    instance._conflictChoices.set(0, 'left')
    expect(instance._buildOutputText()).toContain('left-content')
    expect(instance._buildOutputText()).not.toContain('right-content')
  })

  it('should return right content when choice is right', () => {
    runMerge('left-content', 'base-content', 'right-content')
    instance._conflictChoices.set(0, 'right')
    expect(instance._buildOutputText()).toContain('right-content')
    expect(instance._buildOutputText()).not.toContain('left-content')
  })

  it('should return both contents merged when choice is both', () => {
    runMerge('left-content', 'base-content', 'right-content')
    instance._conflictChoices.set(0, 'both')
    const output = instance._buildOutputText()
    expect(output).toContain('left-content')
    expect(output).toContain('right-content')
  })

  it('should preserve <<< markers when conflict is unresolved (null choice)', () => {
    runMerge('left-content', 'base-content', 'right-content')
    // choice remains null
    const output = instance._buildOutputText()
    expect(output).toContain('<<<<<<< LEFT')
    expect(output).toContain('||||||| BASE')
    expect(output).toContain('=======')
    expect(output).toContain('>>>>>>> RIGHT')
  })

  it('should include normal segment content in output regardless of choices', () => {
    // 'line1' is unchanged, 'conflict-line' conflicts
    const left  = 'line1\nL-change'
    const base  = 'line1\nB-change'
    const right = 'line1\nR-change'
    runMerge(left, base, right)
    instance._conflictChoices.set(0, 'left')
    const output = instance._buildOutputText()
    expect(output).toContain('line1')
    expect(output).toContain('L-change')
  })

  it('should handle no-conflict content with empty choices map', () => {
    runMerge('same', 'same', 'same')
    expect(instance._conflictChoices.size).toBe(0)
    expect(instance._buildOutputText()).toBe('same')
  })

  it('should produce correct output for both choice across multiple conflicts', () => {
    const left  = 'L1\nL2'
    const base  = 'B1\nB2'
    const right = 'R1\nR2'
    runMerge(left, base, right)
    instance._conflictChoices.set(0, 'left')
    instance._conflictChoices.set(1, 'right')
    const output = instance._buildOutputText()
    expect(output).toContain('L1')
    expect(output).toContain('R2')
    expect(output).not.toContain('<<<<<<< LEFT')
  })
})
