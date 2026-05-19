/**
 * @vitest-environment jsdom
 *
 * Sprint 12 tests:
 *   T64 — Undo/Redo stack (TextCompare snapshot push/undo/redo, cap at 50)
 *   T68 — diff-engine ignoreIndent / ignoreCrlf options
 *   T75 — SettingsStore CRUD + keyComboMatches / parseCombo / eventToCombo
 *   T76 — Table sort-before-compare (verified via existing table-compare)
 *   T78 — Hex Complete-mode byte diff (LCS-based classification)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

if (!globalThis.window) {
  Object.defineProperty(globalThis, 'window', { value: globalThis, writable: true })
}
globalThis.window.electronAPI ??= {
  openFile:    vi.fn(),
  saveFile:    vi.fn(),
  readFile:    vi.fn(),
  watchFile:   vi.fn(),
  unwatchFile: vi.fn(),
  onFileChanged: vi.fn(),
}

import { diffLines } from '../../src/renderer/src/core/diff-engine.js'
import { TextCompare } from '../../src/renderer/src/views/text-compare.js'
import {
  SettingsStore,
  DEFAULT_SHORTCUTS,
  parseCombo,
  eventToCombo,
  keyComboMatches,
} from '../../src/renderer/src/core/settings-store.js'
import { hexCompleteByteDiff } from '../../src/renderer/src/views/hex-compare.js'

beforeEach(() => {
  localStorage.clear()
})

// ── T68 diff-engine new options ────────────────────────────────────────────

describe('T68 diff-engine ignoreIndent', () => {
  it('treats differently-indented identical content as equal', () => {
    const left  = 'hello\n  world\n'
    const right = 'hello\n    world\n'
    const result = diffLines(left, right, { ignoreIndent: true })
    const types = result.map((r) => r.type)
    expect(types.every((t) => t === 'equal')).toBe(true)
  })

  it('without ignoreIndent, indented lines diff', () => {
    const left  = 'hello\n  world\n'
    const right = 'hello\n    world\n'
    const result = diffLines(left, right, { ignoreIndent: false })
    const hasDiff = result.some((r) => r.type !== 'equal')
    expect(hasDiff).toBe(true)
  })
})

describe('T68 diff-engine ignoreCrlf', () => {
  it('treats CRLF and LF as equal when ignoreCrlf is on', () => {
    const left  = 'a\r\nb\r\nc\r\n'
    const right = 'a\nb\nc\n'
    const result = diffLines(left, right, { ignoreCrlf: true })
    expect(result.every((r) => r.type === 'equal')).toBe(true)
  })

  it('ignoreCrlf does NOT collapse other whitespace', () => {
    const left  = 'a  b\n'
    const right = 'a b\n'
    const result = diffLines(left, right, { ignoreCrlf: true })
    // double-space vs single-space → should still differ
    expect(result.some((r) => r.type !== 'equal')).toBe(true)
  })
})

// ── T64 Undo/Redo stack ─────────────────────────────────────────────────────

describe('T64 TextCompare undo/redo stack', () => {
  /**
   * Lightweight harness: skip mount() to avoid DOM dependencies — push/undo
   * only touch `_undoStack`, `_redoStack`, `_leftContent`, `_rightContent`.
   * We patch `_runDiff` to a no-op so the public methods don't blow up.
   */
  function makeTC() {
    const tc = new TextCompare()
    tc._runDiff = () => {}
    return tc
  }

  it('push snapshot then undo restores prior state', () => {
    const tc = makeTC()
    tc._leftContent = 'A'
    tc._rightContent = 'B'
    tc._pushUndoSnapshot()
    tc._leftContent = 'A2'
    tc._rightContent = 'B2'
    expect(tc.undo()).toBe(true)
    expect(tc._leftContent).toBe('A')
    expect(tc._rightContent).toBe('B')
  })

  it('redo re-applies the undone mutation', () => {
    const tc = makeTC()
    tc._leftContent = 'A'
    tc._rightContent = 'B'
    tc._pushUndoSnapshot()
    tc._leftContent = 'A2'
    tc._rightContent = 'B2'
    tc.undo()
    expect(tc.redo()).toBe(true)
    expect(tc._leftContent).toBe('A2')
    expect(tc._rightContent).toBe('B2')
  })

  it('undo with empty stack returns false', () => {
    const tc = makeTC()
    expect(tc.undo()).toBe(false)
    expect(tc.redo()).toBe(false)
  })

  it('a new mutation clears the redo stack', () => {
    const tc = makeTC()
    tc._leftContent = 'A'
    tc._pushUndoSnapshot()
    tc._leftContent = 'A2'
    tc.undo()
    tc._pushUndoSnapshot()
    tc._leftContent = 'A3'
    // redo should now find nothing because the new push cleared it
    expect(tc.redo()).toBe(false)
  })

  it('caps the stack at 50 snapshots', () => {
    const tc = makeTC()
    tc._leftContent = '0'
    for (let i = 0; i < 100; i++) {
      tc._pushUndoSnapshot()
      tc._leftContent = String(i + 1)
    }
    expect(tc._undoStack.length).toBe(50)
  })

  it('copyAllToRight pushes a snapshot recoverable via undo', () => {
    const tc = makeTC()
    tc._leftContent  = 'LEFT'
    tc._rightContent = 'RIGHT'
    tc.copyAllToRight()
    expect(tc._rightContent).toBe('LEFT')
    tc.undo()
    expect(tc._rightContent).toBe('RIGHT')
  })
})

// ── T75 SettingsStore + key combo helpers ───────────────────────────────────

describe('T75 SettingsStore', () => {
  it('load returns defaults when storage is empty', () => {
    const s = new SettingsStore()
    const out = s.load()
    expect(out.shortcuts.nextDiff).toBe(DEFAULT_SHORTCUTS.nextDiff)
    expect(out.shortcuts.undo).toBe('Ctrl+Z')
  })

  it('setShortcut + getShortcut round-trips', () => {
    const s = new SettingsStore()
    s.setShortcut('nextDiff', 'Ctrl+Shift+N')
    expect(s.getShortcut('nextDiff')).toBe('Ctrl+Shift+N')
  })

  it('reset restores defaults', () => {
    const s = new SettingsStore()
    s.setShortcut('nextDiff', 'Ctrl+Shift+N')
    s.reset()
    expect(s.getShortcut('nextDiff')).toBe(DEFAULT_SHORTCUTS.nextDiff)
  })
})

describe('T75 keyComboMatches', () => {
  it('parses Ctrl+Z and matches a matching event', () => {
    const evt = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })
    expect(keyComboMatches(evt, 'Ctrl+Z')).toBe(true)
  })

  it('mismatch on modifier difference', () => {
    const evt = new KeyboardEvent('keydown', { key: 'z' })  // no ctrl
    expect(keyComboMatches(evt, 'Ctrl+Z')).toBe(false)
  })

  it('parseCombo returns null for empty input', () => {
    expect(parseCombo('')).toBeNull()
    expect(parseCombo('   ')).toBeNull()
  })

  it('parseCombo correctly identifies modifier flags', () => {
    const b = parseCombo('Ctrl+Shift+Alt+F7')
    expect(b?.ctrl).toBe(true)
    expect(b?.shift).toBe(true)
    expect(b?.alt).toBe(true)
    expect(b?.key).toBe('F7')
  })

  it('eventToCombo builds a canonical string', () => {
    const evt = new KeyboardEvent('keydown', {
      key: 'F8', ctrlKey: false, shiftKey: false, altKey: false,
    })
    expect(eventToCombo(evt)).toBe('F8')
    const evt2 = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, shiftKey: true })
    expect(eventToCombo(evt2)).toBe('Ctrl+Shift+a')
  })
})

// ── T78 Hex Complete-mode byte diff ─────────────────────────────────────────

describe('T78 hexCompleteByteDiff', () => {
  it('identical inputs → all "same"', () => {
    const a = new Uint8Array([1, 2, 3, 4])
    const b = new Uint8Array([1, 2, 3, 4])
    const { leftClass, rightClass } = hexCompleteByteDiff(a, b)
    expect(Array.from(leftClass)).toEqual([0, 0, 0, 0])
    expect(Array.from(rightClass)).toEqual([0, 0, 0, 0])
  })

  it('insertion in right is classified as diff on the right side', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([1, 9, 2, 3])
    const { leftClass, rightClass } = hexCompleteByteDiff(a, b)
    // All 3 left bytes should align with a 'same' match in right.
    expect(Array.from(leftClass)).toEqual([0, 0, 0])
    // Right has 4 bytes; the inserted 9 at idx 1 is the 'diff'.
    expect(rightClass[0]).toBe(0)
    expect(rightClass[1]).toBe(1)
    expect(rightClass[2]).toBe(0)
    expect(rightClass[3]).toBe(0)
  })

  it('completely different inputs → all diff', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([7, 8, 9])
    const { leftClass, rightClass } = hexCompleteByteDiff(a, b)
    expect(Array.from(leftClass)).toEqual([1, 1, 1])
    expect(Array.from(rightClass)).toEqual([1, 1, 1])
  })

  it('handles empty inputs gracefully', () => {
    const out = hexCompleteByteDiff(new Uint8Array(0), new Uint8Array([1, 2]))
    expect(out.leftClass.length).toBe(0)
    expect(Array.from(out.rightClass)).toEqual([1, 1])
  })
})

// ── T76 Table sort-before-compare ───────────────────────────────────────────
// (Already covered indirectly; here we sanity-check the option flag exists.)

describe('T76 Table sort-before-compare flag', () => {
  it('TableCompare constructor accepts no options and initialises sort flag', async () => {
    const { TableCompare } = await import('../../src/renderer/src/views/table-compare.js')
    const t = new TableCompare()
    expect(t._sortBeforeCompare).toBe(false)
  })
})
