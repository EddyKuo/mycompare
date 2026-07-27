/**
 * @vitest-environment jsdom
 *
 * Gap-matrix v2 §1.4 (Edit menu) and §1.5 (Search menu) for the text view:
 * per-line copies, line insert/delete, indent, Select Section, in-line and
 * edit navigation, Align With and Isolate.
 *
 * The two things this file exists to prove, beyond "the function returns the
 * right string":
 *   - every command is reachable from a shortcut *and* from the context menu
 *     (this project has shipped five features with no caller at all)
 *   - edit state lives in the model, so scrolling a 40 000-line file away and
 *     back leaves the caret and the marks intact
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks required before importing the view ─────────────────────────────────

const electronAPI = {
  openFile: vi.fn(),
  saveFile: vi.fn(),
  readFile: vi.fn(),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  onFileChanged: vi.fn(),
}
globalThis.window.electronAPI = electronAPI

const clipboard = { readText: vi.fn(), writeText: vi.fn() }
Object.defineProperty(globalThis.navigator, 'clipboard', {
  value: clipboard,
  configurable: true,
  writable: true,
})

const menuCalls = []
vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: (event, items) => { menuCalls.push(items) },
}))

const toastCalls = []
vi.mock('../../src/renderer/src/core/toast.js', () => ({
  toast: (msg, opts) => { toastCalls.push({ msg, opts }) },
}))

vi.mock('../../src/renderer/src/core/active-view.js', () => ({
  isActive: () => true,
  setActiveView: () => {},
}))

const {
  TextCompare,
  splitLinesKeepEol,
  splitEol,
  insertBlankLine,
  removeLine,
  replaceLineBody,
  wordBoundsAt,
  indentLines,
  anchorsConflict,
  normaliseAnchors,
  splitByAnchors,
  offsetDiffLines,
  diffWithAnchors,
  isolateRanges,
  inlineSegments,
  rebaseEditMarks,
} = await import('../../src/renderer/src/views/text-compare.js')

/**
 * A TextCompare wired to detached panes: real DOM, real virtual scrolling,
 * without mount()'s dependency on index.html.
 * @param {string} [left]
 * @param {string} [right]
 * @returns {InstanceType<typeof TextCompare>}
 */
function makeTC(left, right) {
  const tc = new TextCompare()
  tc._mounted = true
  const l = document.createElement('div')
  const r = document.createElement('div')
  // jsdom reports 0 for every layout box; give the panes a viewport so the
  // virtual scroller renders a realistic window rather than everything.
  for (const el of [l, r]) {
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
  }
  document.body.append(l, r)
  tc._contentLeft = l
  tc._contentRight = r
  tc._compareArea = document.createElement('div')
  if (left != null) tc.setLeft('L.txt', left)
  if (right != null) tc.setRight('R.txt', right)
  return tc
}

beforeEach(() => {
  vi.clearAllMocks()
  menuCalls.length = 0
  toastCalls.length = 0
  document.body.innerHTML = ''
})

afterEach(() => {
  window.getSelection()?.removeAllRanges()
})

// ═══════════════════════════════════════════════════════════════════════════
// Pure primitives
// ═══════════════════════════════════════════════════════════════════════════

describe('splitLinesKeepEol / splitEol', () => {
  it('keeps each terminator with its own line', () => {
    expect(splitLinesKeepEol('a\nb\n')).toEqual(['a\n', 'b\n'])
    expect(splitLinesKeepEol('a\nb')).toEqual(['a\n', 'b'])
    expect(splitLinesKeepEol('')).toEqual([])
  })

  it('agrees with the diff engine on line count, so index N is line N+1', () => {
    // "a\nb\n" is two lines, not three — a trailing empty line is not a line.
    expect(splitLinesKeepEol('a\nb\n')).toHaveLength(2)
  })

  it('separates body from terminator, CRLF included', () => {
    expect(splitEol('x\r\n')).toEqual({ body: 'x', eol: '\r\n' })
    expect(splitEol('x\n')).toEqual({ body: 'x', eol: '\n' })
    expect(splitEol('x')).toEqual({ body: 'x', eol: '' })
  })
})

describe('insertBlankLine', () => {
  it('inserts before', () => {
    expect(insertBlankLine('a\nb\n', 1, 'before')).toBe('a\n\nb\n')
  })

  it('inserts after', () => {
    expect(insertBlankLine('a\nb\n', 0, 'after')).toBe('a\n\nb\n')
  })

  it('terminates the old last line when appending past the end', () => {
    expect(insertBlankLine('a', 0, 'after')).toBe('a\n\n')
  })

  it('honours a CRLF file', () => {
    expect(insertBlankLine('a\r\n', 0, 'after', '\r\n')).toBe('a\r\n\r\n')
  })

  it('turns an empty file into one blank line', () => {
    expect(insertBlankLine('', 0, 'after')).toBe('\n')
  })
})

describe('removeLine / replaceLineBody', () => {
  it('removes a line with its terminator', () => {
    expect(removeLine('a\nb\nc\n', 1)).toBe('a\nc\n')
  })

  it('is a no-op out of range', () => {
    expect(removeLine('a\n', 5)).toBe('a\n')
    expect(removeLine('a\n', -1)).toBe('a\n')
  })

  it('keeps the terminator when replacing a body', () => {
    expect(replaceLineBody('a\r\nb\n', 0, 'ZZ')).toBe('ZZ\r\nb\n')
    expect(replaceLineBody('a', 0, 'ZZ')).toBe('ZZ')
  })
})

describe('wordBoundsAt', () => {
  it('takes the word to the right of the caret', () => {
    expect(wordBoundsAt('hello world', 0)).toEqual({ start: 0, end: 5 })
  })

  it('eats leading whitespace then the word', () => {
    expect(wordBoundsAt('hello world', 5)).toEqual({ start: 5, end: 11 })
  })

  it('treats a punctuation run as one unit', () => {
    expect(wordBoundsAt('a->b', 1)).toEqual({ start: 1, end: 3 })
  })

  it('deletes nothing at end of line', () => {
    expect(wordBoundsAt('abc', 3)).toEqual({ start: 3, end: 3 })
  })

  it('handles non-ASCII identifiers as words', () => {
    expect(wordBoundsAt('變數 x', 0)).toEqual({ start: 0, end: 2 })
  })
})

describe('indentLines', () => {
  it('indents a range with spaces', () => {
    expect(indentLines('a\nb\nc\n', 0, 1, 1, 2)).toBe('  a\n  b\nc\n')
  })

  it('indents with a tab when asked', () => {
    expect(indentLines('a\n', 0, 0, 1, 4, true)).toBe('\ta\n')
  })

  it('leaves blank lines alone when indenting', () => {
    expect(indentLines('a\n\nb\n', 0, 2, 1, 2)).toBe('  a\n\n  b\n')
  })

  it('removes one tab, or up to tabWidth spaces', () => {
    expect(indentLines('\ta\n', 0, 0, -1, 4)).toBe('a\n')
    expect(indentLines('    a\n', 0, 0, -1, 4)).toBe('a\n')
    expect(indentLines('  a\n', 0, 0, -1, 4)).toBe('a\n')
  })

  it('is a no-op when there is nothing left to outdent', () => {
    expect(indentLines('a\n', 0, 0, -1, 4)).toBe('a\n')
  })

  it('preserves CRLF', () => {
    expect(indentLines('a\r\n', 0, 0, 1, 2)).toBe('  a\r\n')
  })
})

describe('rebaseEditMarks', () => {
  it('shifts marks after an insertion', () => {
    expect(rebaseEditMarks([1, 5, 9], 5, 1)).toEqual([1, 6, 10])
  })

  it('drops marks that sat on removed lines', () => {
    expect(rebaseEditMarks([1, 5, 6, 9], 5, -2)).toEqual([1, 7])
  })

  it('de-duplicates and sorts', () => {
    expect(rebaseEditMarks([9, 1, 1], 1, 0)).toEqual([1, 9])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Align With — pure core
// ═══════════════════════════════════════════════════════════════════════════

describe('anchorsConflict / normaliseAnchors', () => {
  it('calls two anchors on the same left line a conflict', () => {
    expect(anchorsConflict({ left: 3, right: 4 }, { left: 3, right: 9 })).toBe(true)
  })

  it('calls two anchors on the same right line a conflict', () => {
    expect(anchorsConflict({ left: 3, right: 4 }, { left: 8, right: 4 })).toBe(true)
  })

  it('calls crossing anchors a conflict', () => {
    expect(anchorsConflict({ left: 2, right: 9 }, { left: 5, right: 3 })).toBe(true)
  })

  it('accepts a monotonic pair', () => {
    expect(anchorsConflict({ left: 2, right: 3 }, { left: 5, right: 9 })).toBe(false)
  })

  it('sorts, drops out-of-range and drops crossings', () => {
    const out = normaliseAnchors(
      [{ left: 5, right: 5 }, { left: 2, right: 2 }, { left: 3, right: 1 }, { left: 99, right: 1 }],
      10, 10,
    )
    expect(out).toEqual([{ left: 2, right: 2 }, { left: 5, right: 5 }])
  })

  it('survives garbage without throwing', () => {
    expect(normaliseAnchors(null, 5, 5)).toEqual([])
    expect(normaliseAnchors([{ left: 'x', right: 1 }, {}, 7], 5, 5)).toEqual([])
  })
})

describe('splitByAnchors', () => {
  it('cuts the files into diff regions separated by the pinned pairs', () => {
    const segs = splitByAnchors(6, 8, [{ left: 3, right: 5 }])
    expect(segs).toEqual([
      { kind: 'diff', leftStart: 0, leftEnd: 2, rightStart: 0, rightEnd: 4 },
      { kind: 'anchor', leftStart: 2, leftEnd: 3, rightStart: 4, rightEnd: 5 },
      { kind: 'diff', leftStart: 3, leftEnd: 6, rightStart: 5, rightEnd: 8 },
    ])
  })

  it('drops empty regions but keeps the anchors', () => {
    const segs = splitByAnchors(1, 1, [{ left: 1, right: 1 }])
    expect(segs).toEqual([
      { kind: 'anchor', leftStart: 0, leftEnd: 1, rightStart: 0, rightEnd: 1 },
    ])
  })
})

describe('offsetDiffLines', () => {
  it('shifts real line numbers and leaves nulls alone', () => {
    const out = offsetDiffLines(
      [{ type: 'insert', leftLine: null, rightLine: 1, leftText: '', rightText: 'x' }], 5, 7)
    expect(out[0].leftLine).toBeNull()
    expect(out[0].rightLine).toBe(8)
  })
})

describe('diffWithAnchors', () => {
  const L = 'a\nb\nc\nd\n'
  const R = 'a\nX\nY\nc\nd\n'

  it('falls straight through when there are no anchors', () => {
    const spy = vi.fn(() => [])
    diffWithAnchors(L, R, [], { algorithm: 'myers' }, spy)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(L, R, { algorithm: 'myers' })
  })

  it('forces the pinned lines onto the same row', () => {
    // Pin left line 2 ("b") to right line 3 ("Y") — an alignment no diff
    // algorithm would choose on its own.
    const out = diffWithAnchors(L, R, [{ left: 2, right: 3 }])
    const pinned = out.find(d => d.alignAnchor)
    expect(pinned).toBeDefined()
    expect(pinned.leftLine).toBe(2)
    expect(pinned.rightLine).toBe(3)
    expect(pinned.leftText).toBe('b\n')
    expect(pinned.rightText).toBe('Y\n')
    expect(pinned.type).toBe('replace')
  })

  it('marks an anchor equal when both lines match', () => {
    const out = diffWithAnchors('a\nb\n', 'a\nb\n', [{ left: 2, right: 2 }])
    expect(out.find(d => d.alignAnchor).type).toBe('equal')
  })

  it('renumbers every sub-region back into whole-file coordinates', () => {
    const out = diffWithAnchors(L, R, [{ left: 2, right: 3 }])
    const lefts = out.map(d => d.leftLine).filter(n => n != null)
    const rights = out.map(d => d.rightLine).filter(n => n != null)
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b))
    expect(rights).toEqual([...rights].sort((a, b) => a - b))
    expect(lefts).toEqual([1, 2, 3, 4])
    expect(rights).toEqual([1, 2, 3, 4, 5])
  })

  it('slices per-line weights to match each region', () => {
    const seen = []
    const spy = (l, r, o) => { seen.push(o); return [] }
    diffWithAnchors(L, R, [{ left: 2, right: 3 }],
      { leftWeights: [1, 2, 3, 4], rightWeights: [1, 2, 3, 4, 5] }, spy)
    expect(seen[0].leftWeights).toEqual([1])
    expect(seen[0].rightWeights).toEqual([1, 2])
    expect(seen[1].leftWeights).toEqual([3, 4])
    expect(seen[1].rightWeights).toEqual([4, 5])
  })

  it('never loses or duplicates a line', () => {
    const out = diffWithAnchors(L, R, [{ left: 2, right: 3 }])
    expect(out.map(d => d.leftText).join('')).toBe(L)
    expect(out.map(d => d.rightText).join('')).toBe(R)
  })

  it('ignores an anchor pointing past the end of a file', () => {
    const out = diffWithAnchors(L, R, [{ left: 99, right: 1 }])
    expect(out.some(d => d.alignAnchor)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Isolate — pure core
// ═══════════════════════════════════════════════════════════════════════════

describe('isolateRanges', () => {
  const L = 'a\nb\nc\nd\n'
  const R = '1\n2\n3\n'

  it('extracts an inclusive 1-based range from each side', () => {
    expect(isolateRanges(L, R, { start: 2, end: 3 }, { start: 1, end: 2 }))
      .toEqual({ left: 'b\nc\n', right: '1\n2\n' })
  })

  it('allows a side with no range at all', () => {
    expect(isolateRanges(L, R, { start: 1, end: 1 }, null))
      .toEqual({ left: 'a\n', right: '' })
  })

  it('clamps to the file rather than throwing', () => {
    expect(isolateRanges(L, R, { start: 0, end: 99 }, { start: 3, end: 3 }))
      .toEqual({ left: L, right: '3\n' })
  })

  it('returns empty for an inverted range', () => {
    expect(isolateRanges(L, R, { start: 3, end: 1 }, null).left).toBe('')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// In-line difference segments
// ═══════════════════════════════════════════════════════════════════════════

describe('inlineSegments', () => {
  it('returns nothing for an all-equal line', () => {
    expect(inlineSegments([{ type: 'equal', text: 'abc' }])).toEqual([])
  })

  it('merges an adjacent delete+insert into one replacement', () => {
    const segs = inlineSegments([
      { type: 'equal', text: 'a' },
      { type: 'delete', text: 'XY' },
      { type: 'insert', text: 'Z' },
      { type: 'equal', text: 'b' },
    ])
    expect(segs).toEqual([{ leftStart: 1, leftEnd: 3, rightStart: 1, rightEnd: 2 }])
  })

  it('keeps runs separated by equal text apart', () => {
    const segs = inlineSegments([
      { type: 'delete', text: 'A' },
      { type: 'equal', text: '---' },
      { type: 'insert', text: 'B' },
    ])
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ leftStart: 0, leftEnd: 1, rightStart: 0, rightEnd: 0 })
    expect(segs[1]).toEqual({ leftStart: 4, leftEnd: 4, rightStart: 3, rightEnd: 4 })
  })

  it('tolerates garbage', () => {
    expect(inlineSegments(null)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Entry points — every command reachable from a shortcut AND from the menu
// ═══════════════════════════════════════════════════════════════════════════

const ALL_COMMAND_IDS = [
  'text.copyLineRight', 'text.copyLineLeft', 'text.copyLineOther', 'text.copyOtherSide',
  'text.insertLineBefore', 'text.insertLineAfter',
  'text.deleteLine', 'text.deleteToStartOfLine', 'text.deleteToEndOfLine', 'text.deleteWord',
  'text.increaseIndent', 'text.decreaseIndent',
  'text.selectSection', 'text.selectAll',
  'text.nextInlineDiff', 'text.prevInlineDiff', 'text.nextEdit', 'text.prevEdit',
  'text.alignWith', 'text.clearAlignAnchors', 'text.isolate',
]

describe('command entry points', () => {
  it('implements every §1.4/§1.5 command the sprint asked for', () => {
    const tc = makeTC('a\n', 'b\n')
    expect(tc.editCommands().map(c => c.id).sort()).toEqual([...ALL_COMMAND_IDS].sort())
  })

  it('gives every command a shortcut and a callable run()', () => {
    const tc = makeTC('a\n', 'b\n')
    for (const cmd of tc.editCommands()) {
      expect(cmd.combo, cmd.id).toMatch(/\S/)
      expect(typeof cmd.run, cmd.id).toBe('function')
      expect(cmd.label, cmd.id).toMatch(/\S/)
    }
  })

  it('binds no two commands to the same shortcut', () => {
    const combos = makeTC('a\n', 'b\n').editCommands().map(c => c.combo)
    expect(new Set(combos).size).toBe(combos.length)
  })

  it('offers every command in the context menu', () => {
    const tc = makeTC('a\nb\n', 'a\nc\n')
    tc._handleContextMenu(new MouseEvent('contextmenu'), 'left')
    const labels = menuCalls.at(-1).filter(i => !i.separator).map(i => i.label)
    for (const cmd of tc.editCommands()) {
      expect(labels.some(l => l.includes(cmd.label.split('（')[0].split(' (')[0])), cmd.id).toBe(true)
    }
  })

  it('routes each shortcut to the command that declares it', () => {
    const tc = makeTC('a\nb\n', 'a\nc\n')
    for (const cmd of tc.editCommands()) {
      const parts = cmd.combo.split('+')
      const key = parts[parts.length - 1]
      const ev = new KeyboardEvent('keydown', {
        key: key.length === 1 ? key : key,
        ctrlKey: parts.includes('Ctrl'),
        shiftKey: parts.includes('Shift'),
        altKey: parts.includes('Alt'),
      })
      expect(tc._matchEditCommand(ev), cmd.id).toBeTypeOf('function')
    }
  })

  it('registers and unregisters its keydown listener with the view', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const tc = new TextCompare()
    // mount() needs index.html; exercise the two halves the listener uses.
    tc._onKeyDownEditCmds = () => {}
    document.addEventListener('keydown', tc._onKeyDownEditCmds)
    tc._mounted = true
    tc.destroy()
    expect(add).toHaveBeenCalledWith('keydown', tc._onKeyDownEditCmds)
    expect(remove).toHaveBeenCalledWith('keydown', tc._onKeyDownEditCmds)
    add.mockRestore()
    remove.mockRestore()
  })

  it('does not hijack keys typed into the find bar', () => {
    const tc = makeTC('a\n', 'b\n')
    tc._onKeyDownEditCmds = null
    // Rebuild the guard the mount() handler applies.
    const input = document.createElement('input')
    document.body.appendChild(input)
    const handled = (target) => {
      const tag = target instanceof Element ? target.tagName : ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false
      return true
    }
    expect(handled(input)).toBe(false)
    expect(handled(tc._contentLeft)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Copy Line / Copy to Other Side
// ═══════════════════════════════════════════════════════════════════════════

describe('Copy Line', () => {
  it('copies one line, not the whole difference block', () => {
    // One block spanning three rows (delete / replace / insert). Copying the
    // caret's row alone must leave the other two as they were — copying the
    // block would have made the right side identical to the left.
    const tc = makeTC('a\nb\nc\nd\n', 'a\nY\nZ\nd\n')
    tc.setCaret('left', 3)
    expect(tc.copyLineToRight()).toBe(true)
    expect(tc.getContent('right')).toBe('a\nc\nZ\nd\n')
    expect(tc.getContent('right')).not.toBe(tc.getContent('left'))
    expect(tc.getContent('left')).toBe('a\nb\nc\nd\n')
  })

  it('copies right → left', () => {
    const tc = makeTC('a\nb\nc\nd\n', 'a\nY\nZ\nd\n')
    tc.setCaret('right', 2)
    expect(tc.copyLineToLeft()).toBe(true)
    expect(tc.getContent('left')).toBe('a\nb\nY\nd\n')
  })

  it('removes the target line when the caret sits on a source-only row', () => {
    // Right has an extra line; copying that row left-to-right deletes it.
    const tc = makeTC('a\nc\n', 'a\nb\nc\n')
    tc.setCaret('right', 2)
    tc._currentSide = 'right'
    tc.copyLineToLeft()
    expect(tc.getContent('left')).toBe('a\nb\nc\n')
  })

  it('sends the line to the pane the user is NOT on', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nY\nc\n')
    tc.setCaret('left', 2)
    expect(tc.otherSide()).toBe('right')
    tc.copyLineToOtherSide()
    expect(tc.getContent('right')).toBe('a\nb\nc\n')
  })

  it('follows the active side when it changes', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nY\nc\n')
    tc.setCaret('right', 2)
    expect(tc.otherSide()).toBe('left')
    tc.copyLineToOtherSide()
    expect(tc.getContent('left')).toBe('a\nY\nc\n')
  })

  it('copies the whole section to the other side', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nQ\nc\n')
    tc.setCaret('left', 2)
    tc.copyToOtherSide()
    expect(tc.getContent('right')).toBe('a\nb\nc\n')
  })

  it('complains rather than silently doing nothing with no caret', () => {
    const tc = makeTC('a\n', 'b\n')
    tc._currentRowIdx = -1
    expect(tc.copyLineToRight()).toBe(false)
    expect(toastCalls.at(-1).msg).toContain('請先點選')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Insert / Delete
// ═══════════════════════════════════════════════════════════════════════════

describe('Insert & Delete line commands', () => {
  it('inserts a blank line before the caret', () => {
    const tc = makeTC('a\nb\n', 'a\nb\n')
    tc.setCaret('left', 2)
    expect(tc.insertLineBefore()).toBe(true)
    expect(tc.getContent('left')).toBe('a\n\nb\n')
  })

  it('inserts a blank line after the caret', () => {
    const tc = makeTC('a\nb\n', 'a\nb\n')
    tc.setCaret('left', 1)
    expect(tc.insertLineAfter()).toBe(true)
    expect(tc.getContent('left')).toBe('a\n\nb\n')
  })

  it('uses the side\'s own line terminator', () => {
    const tc = makeTC('a\r\nb\r\n', 'a\n')
    tc.setCaret('left', 1)
    tc.insertLineAfter()
    expect(tc.getContent('left')).toBe('a\r\n\r\nb\r\n')
  })

  it('deletes the caret line', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nb\nc\n')
    tc.setCaret('left', 2)
    expect(tc.deleteLine()).toBe(true)
    expect(tc.getContent('left')).toBe('a\nc\n')
  })

  it('deletes to the start of the line from the caret column', () => {
    const tc = makeTC('hello world\n', 'x\n')
    tc.setCaret('left', 1)
    tc._caretCol = 6
    expect(tc.deleteToStartOfLine()).toBe(true)
    expect(tc.getContent('left')).toBe('world\n')
  })

  it('deletes to the end of the line from the caret column', () => {
    const tc = makeTC('hello world\n', 'x\n')
    tc.setCaret('left', 1)
    tc._caretCol = 5
    expect(tc.deleteToEndOfLine()).toBe(true)
    expect(tc.getContent('left')).toBe('hello\n')
  })

  it('deletes one word', () => {
    const tc = makeTC('hello world\n', 'x\n')
    tc.setCaret('left', 1)
    tc._caretCol = 0
    expect(tc.deleteWord()).toBe(true)
    expect(tc.getContent('left')).toBe(' world\n')
  })

  it('acts on the right pane when that is the active side', () => {
    const tc = makeTC('a\nb\n', 'a\nb\n')
    tc.setCaret('right', 1)
    tc.deleteLine()
    expect(tc.getContent('right')).toBe('b\n')
    expect(tc.getContent('left')).toBe('a\nb\n')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Indent
// ═══════════════════════════════════════════════════════════════════════════

describe('Increase / Decrease Indent', () => {
  it('indents the caret line with the current tab width', () => {
    const tc = makeTC('a\nb\n', 'a\nb\n')
    tc.setTabWidth(2)
    tc.setCaret('left', 1)
    expect(tc.increaseIndent()).toBe(true)
    expect(tc.getContent('left')).toBe('  a\nb\n')
  })

  it('indents every line of a multi-line selection', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nb\nc\n')
    tc.setTabWidth(2)
    // Stand in for a DOM selection covering lines 1–3 on the left.
    vi.spyOn(tc, '_selectedLineNumbers').mockImplementation((s) => (s === 'left' ? [1, 2, 3] : []))
    vi.spyOn(tc, '_selectionSide').mockReturnValue('left')
    expect(tc.increaseIndent()).toBe(true)
    expect(tc.getContent('left')).toBe('  a\n  b\n  c\n')
  })

  it('outdents the same selection back', () => {
    const tc = makeTC('  a\n  b\n', 'x\n')
    tc.setTabWidth(2)
    vi.spyOn(tc, '_selectedLineNumbers').mockImplementation((s) => (s === 'left' ? [1, 2] : []))
    vi.spyOn(tc, '_selectionSide').mockReturnValue('left')
    expect(tc.decreaseIndent()).toBe(true)
    expect(tc.getContent('left')).toBe('a\nb\n')
  })

  it('uses tabs when configured to', () => {
    const tc = makeTC('a\n', 'x\n')
    tc.setTabWidth(4, true)
    tc.setCaret('left', 1)
    tc.increaseIndent()
    expect(tc.getContent('left')).toBe('\ta\n')
  })

  it('says so instead of doing nothing when there is no indent to remove', () => {
    const tc = makeTC('a\n', 'x\n')
    tc.setCaret('left', 1)
    expect(tc.decreaseIndent()).toBe(false)
    expect(toastCalls.at(-1).msg).toContain('縮排')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Single-side lock (setSideReadOnly) and edit mode
// ═══════════════════════════════════════════════════════════════════════════

describe('every edit command respects setSideReadOnly', () => {
  /** @type {Array<[string, (tc: InstanceType<typeof TextCompare>) => unknown]>} */
  const MUTATORS = [
    ['copyLineToRight', (tc) => tc.copyLineToRight()],
    ['insertLineBefore', (tc) => tc.insertLineBefore()],
    ['insertLineAfter', (tc) => tc.insertLineAfter()],
    ['deleteLine', (tc) => tc.deleteLine()],
    ['deleteToStartOfLine', (tc) => tc.deleteToStartOfLine()],
    ['deleteToEndOfLine', (tc) => tc.deleteToEndOfLine()],
    ['deleteWord', (tc) => tc.deleteWord()],
    ['increaseIndent', (tc) => tc.increaseIndent()],
    ['decreaseIndent', (tc) => tc.decreaseIndent()],
  ]

  for (const [name, run] of MUTATORS) {
    it(`${name} refuses a locked target and says why`, () => {
      const tc = makeTC('  hello world\nb\n', '  hello world\nb\n')
      // Lock both sides so it makes no difference which one the command targets.
      tc.setSideReadOnly('left', true)
      tc.setSideReadOnly('right', true)
      tc.setCaret('left', 1)
      tc._caretCol = 3
      const before = { l: tc.getContent('left'), r: tc.getContent('right') }
      expect(run(tc)).toBe(false)
      expect(tc.getContent('left')).toBe(before.l)
      expect(tc.getContent('right')).toBe(before.r)
      expect(toastCalls.some(t => t.msg.includes('鎖定'))).toBe(true)
    })
  }

  it('greys the commands out in the context menu when the target is locked', () => {
    const tc = makeTC('a\n', 'b\n')
    tc.setSideReadOnly('right', true)
    const cmd = tc.editCommands().find(c => c.id === 'text.copyLineRight')
    expect(cmd.disabled).toBe(true)
  })

  it('still allows a command aimed at the unlocked side', () => {
    const tc = makeTC('a\nb\n', 'X\nY\n')
    tc.setSideReadOnly('left', true)
    tc.setCaret('right', 1)
    expect(tc.deleteLine()).toBe(true)
    expect(tc.getContent('right')).toBe('Y\n')
  })

  it('keeps the edit-mode textarea in sync with a command-driven edit', () => {
    const tc = makeTC('a\nb\n', 'a\nb\n')
    // toggleEditMode() needs #pane-left/#pane-right, so attach the textareas
    // the way _createEditTextarea would.
    tc._textareaLeft = document.createElement('textarea')
    tc._textareaRight = document.createElement('textarea')
    tc._editMode = true
    tc._textareaLeft.value = tc.getContent('left')
    tc.setCaret('left', 1)
    tc.deleteLine()
    expect(tc._textareaLeft.value).toBe('b\n')
    expect(tc._textareaLeft.value).toBe(tc.getContent('left'))
  })

  it('marks the side modified so the tab-close guard sees it', () => {
    const tc = makeTC('a\nb\n', 'a\nb\n')
    tc.setCaret('left', 1)
    tc.deleteLine()
    expect(tc._modified.left).toBe(true)
    expect(tc._modified.right).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Undo / Redo
// ═══════════════════════════════════════════════════════════════════════════

describe('every edit command goes through undo/redo', () => {
  /** @type {Array<[string, (tc: InstanceType<typeof TextCompare>) => unknown]>} */
  const MUTATORS = [
    ['copyLineToRight', (tc) => tc.copyLineToRight()],
    ['copyLineToLeft', (tc) => tc.copyLineToLeft()],
    ['insertLineBefore', (tc) => tc.insertLineBefore()],
    ['insertLineAfter', (tc) => tc.insertLineAfter()],
    ['deleteLine', (tc) => tc.deleteLine()],
    ['deleteToStartOfLine', (tc) => tc.deleteToStartOfLine()],
    ['deleteToEndOfLine', (tc) => tc.deleteToEndOfLine()],
    ['deleteWord', (tc) => tc.deleteWord()],
    ['increaseIndent', (tc) => tc.increaseIndent()],
    ['decreaseIndent', (tc) => tc.decreaseIndent()],
  ]

  for (const [name, run] of MUTATORS) {
    it(`${name} is undoable and redoable`, () => {
      const tc = makeTC('    hello world\nbeta\n', 'X\nY\n')
      tc.setCaret('left', 1)
      tc._caretCol = 4
      const before = { l: tc.getContent('left'), r: tc.getContent('right') }
      expect(run(tc), name).toBe(true)
      const after = { l: tc.getContent('left'), r: tc.getContent('right') }
      expect(after).not.toEqual(before)

      expect(tc.undo()).toBe(true)
      expect({ l: tc.getContent('left'), r: tc.getContent('right') }).toEqual(before)

      expect(tc.redo()).toBe(true)
      expect({ l: tc.getContent('left'), r: tc.getContent('right') }).toEqual(after)
    })
  }

  it('pushes exactly one undo entry per command', () => {
    const tc = makeTC('a\nb\n', 'a\nb\n')
    tc.setCaret('left', 1)
    const depth = tc._undoStack.length
    tc.deleteLine()
    expect(tc._undoStack.length).toBe(depth + 1)
  })

  it('pushes nothing when the command was a no-op', () => {
    const tc = makeTC('a\n', 'x\n')
    tc.setCaret('left', 1)
    const depth = tc._undoStack.length
    expect(tc.decreaseIndent()).toBe(false)
    expect(tc._undoStack.length).toBe(depth)
  })

  it('pushes nothing when the side is locked', () => {
    const tc = makeTC('a\nb\n', 'x\n')
    tc.setSideReadOnly('left', true)
    tc.setCaret('left', 1)
    const depth = tc._undoStack.length
    tc.deleteLine()
    expect(tc._undoStack.length).toBe(depth)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Select Section / Select All
// ═══════════════════════════════════════════════════════════════════════════

describe('Select Section / Select All', () => {
  it('selects the difference block the caret sits in', () => {
    const tc = makeTC('a\nb\nc\nd\n', 'a\nX\nY\nd\n')
    tc._render()
    tc.setCaret('left', 2)
    expect(tc.selectSection()).toBe(true)
    const sel = window.getSelection()
    expect(sel.rangeCount).toBe(1)
    expect(sel.toString()).toContain('b')
  })

  it('refuses, loudly, when the caret is not in a difference', () => {
    const tc = makeTC('a\nb\n', 'a\nb\n')
    tc._render()
    tc.setCaret('left', 1)
    tc._currentDiff = -1
    expect(tc.selectSection()).toBe(false)
    expect(toastCalls.at(-1).msg).toContain('差異')
  })

  it('selects the whole active pane', () => {
    const tc = makeTC('a\nb\n', 'X\nY\n')
    tc._render()
    tc._currentSide = 'right'
    expect(tc.selectAll()).toBe(true)
    expect(window.getSelection().toString()).toContain('X')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// In-line and edit navigation
// ═══════════════════════════════════════════════════════════════════════════

describe('in-line difference navigation', () => {
  it('walks the changed runs inside a line before moving on', () => {
    const tc = makeTC('aXbYc\nsame\naZb\n', 'a1bY2c\nsame\naQb\n')
    tc._render()
    expect(tc.nextInlineDiff()).toBe(true)
    const first = { ...tc._inlineCursor }
    expect(tc.nextInlineDiff()).toBe(true)
    const second = { ...tc._inlineCursor }
    // Either another run in the same line, or the next replace line.
    expect(second).not.toEqual(first)
    expect(second.diffIndex >= first.diffIndex).toBe(true)
  })

  it('goes back the way it came', () => {
    // The equal run between the two changes must be long enough that the
    // char-diff does not absorb it into a single replacement.
    const tc = makeTC('aaXbbbbbbYcc\n', 'aa1bbbbbb2cc\n')
    tc._render()
    tc.nextInlineDiff()
    const first = { ...tc._inlineCursor }
    tc.nextInlineDiff()
    expect(tc.prevInlineDiff()).toBe(true)
    expect(tc._inlineCursor).toEqual(first)
  })

  it('stops at the end and says so rather than wrapping silently', () => {
    const tc = makeTC('aXc\n', 'aYc\n')
    tc._render()
    expect(tc.nextInlineDiff()).toBe(true)
    expect(tc.nextInlineDiff()).toBe(false)
    expect(toastCalls.at(-1).msg).toContain('行內差異')
  })

  it('reports there is nothing to navigate on identical files', () => {
    const tc = makeTC('a\n', 'a\n')
    tc._render()
    expect(tc.nextInlineDiff()).toBe(false)
  })

  it('paints the cursor onto the rendered row', () => {
    const tc = makeTC('aXc\n', 'aYc\n')
    tc._render()
    tc.nextInlineDiff()
    expect(tc._contentLeft.querySelectorAll('.char-diff--current').length +
           tc._contentRight.querySelectorAll('.char-diff--current').length).toBeGreaterThan(0)
  })

  it('re-paints the cursor after a re-render, because it lives in the model', () => {
    const tc = makeTC('aXc\n', 'aYc\n')
    tc._render()
    tc.nextInlineDiff()
    tc._render()
    expect(tc._contentLeft.querySelectorAll('.char-diff--current').length +
           tc._contentRight.querySelectorAll('.char-diff--current').length).toBeGreaterThan(0)
  })
})

describe('Next / Previous Edit', () => {
  it('jumps between the lines the edit commands touched', () => {
    const tc = makeTC('a\nb\nc\nd\ne\n', 'a\nb\nc\nd\ne\n')
    tc.setCaret('left', 2)
    tc.deleteToEndOfLine()      // marks line 2
    tc.setCaret('left', 5)
    tc.deleteToEndOfLine()      // marks line 5
    expect(tc.getEditMarks().left).toEqual([2, 5])

    tc.setCaret('left', 1)
    expect(tc.nextEdit()).toBe(true)
    expect(tc.caretLine('left')).toBe(2)
    expect(tc.nextEdit()).toBe(true)
    expect(tc.caretLine('left')).toBe(5)
    expect(tc.nextEdit()).toBe(false)

    expect(tc.prevEdit()).toBe(true)
    expect(tc.caretLine('left')).toBe(2)
  })

  it('rebases the marks when a later command inserts a line above them', () => {
    const tc = makeTC('a\nb\nc\nd\n', 'a\nb\nc\nd\n')
    tc.setCaret('left', 4)
    tc.deleteToEndOfLine()
    expect(tc.getEditMarks().left).toEqual([4])
    tc.setCaret('left', 1)
    tc.insertLineAfter()
    expect(tc.getEditMarks().left).toContain(5)
  })

  it('forgets the marks when the document is replaced', () => {
    const tc = makeTC('a\nb\n', 'a\nb\n')
    tc.setCaret('left', 2)
    tc.deleteToEndOfLine()
    expect(tc.getEditMarks().left).toEqual([2])
    // Line 2 of a different file is unrelated text; keeping the mark would
    // send Next Edit somewhere the user never touched.
    tc.setLeft('other.txt', 'zzz\nyyy\n')
    expect(tc.getEditMarks().left).toEqual([])
    expect(tc.nextEdit()).toBe(false)
  })

  it('drops the alignment anchors when the document is replaced', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nb\nc\n')
    tc.alignWith(2, 3)
    tc.setRight('other.txt', 'q\nw\ne\n')
    expect(tc.getAlignAnchors()).toEqual([])
  })

  it('says so when the side has no edits yet', () => {
    const tc = makeTC('a\n', 'b\n')
    expect(tc.nextEdit()).toBe(false)
    expect(toastCalls.at(-1).msg).toContain('編輯')
  })

  it('tracks each side separately', () => {
    const tc = makeTC('a\nb\n', 'a\nb\n')
    tc.setCaret('right', 2)
    tc.deleteToEndOfLine()
    expect(tc.getEditMarks().right).toEqual([2])
    expect(tc.getEditMarks().left).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Align With — through the view
// ═══════════════════════════════════════════════════════════════════════════

describe('Align With through the view', () => {
  it('pins two lines together and re-diffs', () => {
    const tc = makeTC('a\nb\nc\nd\n', 'a\nX\nY\nc\nd\n')
    expect(tc.alignWith(2, 3)).toBe(true)
    const pinned = tc._diffResult.find(d => d.alignAnchor)
    expect(pinned.leftLine).toBe(2)
    expect(pinned.rightLine).toBe(3)
    expect(tc.getAlignAnchors()).toEqual([{ left: 2, right: 3 }])
  })

  it('rejects a line number outside the file, loudly', () => {
    const tc = makeTC('a\n', 'b\n')
    expect(tc.alignWith(9, 1)).toBe(false)
    expect(toastCalls.at(-1).opts?.type).toBe('error')
  })

  it('replaces a conflicting anchor and reports how many it dropped', () => {
    const tc = makeTC('a\nb\nc\nd\n', 'a\nb\nc\nd\n')
    tc.alignWith(2, 2)
    tc.alignWith(2, 3)
    expect(tc.getAlignAnchors()).toEqual([{ left: 2, right: 3 }])
    expect(toastCalls.at(-1).msg).toContain('取代')
  })

  it('takes two steps from the menu: mark one side, then the other', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nb\nc\n')
    tc.setCaret('left', 2)
    expect(tc.markAlignAnchor()).toBe(false)      // half-done
    expect(toastCalls.at(-1).msg).toContain('已標記')
    tc.setCaret('right', 3)
    expect(tc.markAlignAnchor()).toBe(true)
    expect(tc.getAlignAnchors()).toEqual([{ left: 2, right: 3 }])
  })

  it('clears every anchor and restores the computed alignment', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nX\nc\n')
    tc.alignWith(2, 2)
    expect(tc.clearAlignAnchors()).toBe(1)
    expect(tc.getAlignAnchors()).toEqual([])
    expect(tc._diffResult.some(d => d.alignAnchor)).toBe(false)
  })

  it('marks the pinned row in the DOM', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nX\nc\n')
    tc.alignWith(2, 2)
    tc._render()
    expect(tc._contentLeft.querySelector('.diff-line.align-anchor')).toBeTruthy()
  })

  it('round-trips through getConfig / applyConfig', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nb\nc\n')
    tc.alignWith(2, 3)
    tc.setTabWidth(2, true)
    const cfg = tc.getConfig()

    const other = makeTC('a\nb\nc\n', 'a\nb\nc\n')
    other.applyConfig(cfg)
    expect(other.getAlignAnchors()).toEqual([{ left: 2, right: 3 }])
    expect(other.getTabSettings()).toEqual({ width: 2, useTabs: true })
  })

  it('drops a saved anchor that no longer fits the current files', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nb\nc\n')
    tc.alignWith(3, 3)
    const cfg = tc.getConfig()
    const small = makeTC('a\n', 'a\n')
    small.applyConfig(cfg)
    expect(small.getAlignAnchors()).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Isolate — through the view
// ═══════════════════════════════════════════════════════════════════════════

describe('Isolate through the view', () => {
  /**
   * @param {InstanceType<typeof TextCompare>} tc
   * @param {number[]} left
   * @param {number[]} right
   */
  function fakeSelection(tc, left, right) {
    vi.spyOn(tc, '_selectedLineNumbers').mockImplementation((s) => (s === 'left' ? left : right))
  }

  it('pulls the selected lines out into their own comparison', () => {
    const tc = makeTC('a\nb\nc\nd\n', '1\n2\n3\n4\n')
    fakeSelection(tc, [2, 3], [2, 3])
    expect(tc.isolate()).toBe(true)
    expect(tc.getContent('left')).toBe('b\nc\n')
    expect(tc.getContent('right')).toBe('2\n3\n')
    expect(tc.isIsolated()).toBe(true)
  })

  it('falls back to the caret difference block with no selection', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nX\nc\n')
    tc._render()
    tc.setCaret('left', 2)
    expect(tc.isolate()).toBe(true)
    expect(tc.getContent('left')).toBe('b\n')
    expect(tc.getContent('right')).toBe('X\n')
  })

  it('puts the whole files back on the way out', () => {
    const tc = makeTC('a\nb\nc\nd\n', '1\n2\n3\n4\n')
    fakeSelection(tc, [2, 3], [2, 3])
    tc.isolate()
    expect(tc.endIsolate()).toBe(true)
    expect(tc.getContent('left')).toBe('a\nb\nc\nd\n')
    expect(tc.getContent('right')).toBe('1\n2\n3\n4\n')
    expect(tc.isIsolated()).toBe(false)
  })

  it('restores the alignment anchors that were suspended during Isolate', () => {
    const tc = makeTC('a\nb\nc\nd\n', 'a\nb\nc\nd\n')
    tc.alignWith(2, 3)
    fakeSelection(tc, [1, 2], [1, 2])
    tc.isolate()
    expect(tc.getAlignAnchors()).toEqual([])
    tc.endIsolate()
    expect(tc.getAlignAnchors()).toEqual([{ left: 2, right: 3 }])
  })

  it('toggles from a single entry point', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nX\nc\n')
    tc._render()
    tc.setCaret('left', 2)
    tc.toggleIsolate()
    expect(tc.isIsolated()).toBe(true)
    tc.toggleIsolate()
    expect(tc.isIsolated()).toBe(false)
  })

  it('refuses to isolate over unsaved edits instead of losing them', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nb\nc\n')
    tc.setCaret('left', 1)
    tc.deleteLine()
    fakeSelection(tc, [1], [1])
    expect(tc.isolate()).toBe(false)
    expect(toastCalls.at(-1).msg).toContain('未儲存')
  })

  it('warns before discarding edits made inside Isolate', () => {
    const tc = makeTC('a\nb\nc\n', 'a\nb\nc\n')
    fakeSelection(tc, [1, 2], [1, 2])
    tc.isolate()
    tc._selectedLineNumbers.mockRestore?.()
    tc.setCaret('left', 1)
    tc.deleteLine()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    expect(tc.endIsolate()).toBe(false)
    expect(tc.isIsolated()).toBe(true)
    confirmSpy.mockReturnValue(true)
    expect(tc.endIsolate()).toBe(true)
    confirmSpy.mockRestore()
  })

  it('says so when asked to leave and it is not isolated', () => {
    const tc = makeTC('a\n', 'b\n')
    expect(tc.endIsolate()).toBe(false)
    expect(toastCalls.at(-1).msg).toContain('Isolate')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Tens of thousands of lines: the state must be in the model, not the DOM
// ═══════════════════════════════════════════════════════════════════════════

describe('40 000-line file: edit state survives scrolling out and back', () => {
  const N = 40000
  // Every 500th line differs, so after context folding _rows is still in the
  // thousands — otherwise the virtual scroller would have nothing to do and
  // the test would prove nothing.
  const CHANGED = (i) => i % 500 === 0
  const build = (mutate) => {
    const lines = []
    for (let i = 1; i <= N; i++) lines.push(mutate ? mutate(i) : `line ${i}`)
    return lines.join('\n') + '\n'
  }

  /** @returns {InstanceType<typeof TextCompare>} */
  function bigTC() {
    const left = build()
    const right = build((i) => (CHANGED(i) ? `line ${i} CHANGED` : `line ${i}`))
    const tc = makeTC(left, right)
    tc._render()
    return tc
  }

  it('renders only a window of rows, so the DOM cannot be the store', () => {
    const tc = bigTC()
    expect(tc._diffResult.length).toBe(N)
    expect(tc._rows.length).toBeGreaterThan(1000)
    expect(tc._contentLeft.querySelectorAll('.diff-line').length).toBeLessThan(200)
  })

  it('keeps the caret after scrolling away and back, and edits the right line', () => {
    const tc = bigTC()
    tc.setCaret('left', 30000)
    expect(tc.caretLine('left')).toBe(30000)

    // Scroll to the top: the caret's row leaves the DOM entirely.
    tc._contentLeft.scrollTop = 0
    tc._contentRight.scrollTop = 0
    tc._renderVisibleRows()
    expect(tc._contentLeft.querySelector('[data-row-idx]')?.dataset.rowIdx).toBe('0')
    expect(tc.caretLine('left')).toBe(30000)

    // …and back again.
    tc._contentLeft.scrollTop = 30000 * tc._rowHeight
    tc._renderVisibleRows()

    tc.deleteLine()
    const lines = tc.getContent('left').split('\n')
    expect(lines[29998]).toBe('line 29999')
    expect(lines[29999]).toBe('line 30001')
  })

  it('keeps the edit marks after scrolling away, so Next Edit still works', () => {
    const tc = bigTC()
    tc.setCaret('left', 30000)
    tc._caretCol = 4
    tc.deleteToEndOfLine()
    expect(tc.getEditMarks().left).toContain(30000)

    tc._contentLeft.scrollTop = 0
    tc._renderVisibleRows()
    tc.setCaret('left', 1)
    expect(tc.nextEdit()).toBe(true)
    expect(tc.caretLine('left')).toBe(30000)
  })

  it('keeps the alignment anchor after scrolling away', () => {
    const tc = bigTC()
    tc.alignWith(20000, 20001)
    tc._contentLeft.scrollTop = 0
    tc._renderVisibleRows()
    expect(tc.getAlignAnchors()).toEqual([{ left: 20000, right: 20001 }])
    expect(tc._diffResult.some(d => d.alignAnchor && d.leftLine === 20000)).toBe(true)
  })

  it('keeps the in-line cursor after scrolling away and re-paints on return', () => {
    const tc = bigTC()
    tc.setCaret('left', 30000)
    expect(tc.nextInlineDiff()).toBe(true)
    const cursor = { ...tc._inlineCursor }

    tc._contentLeft.scrollTop = 0
    tc._renderVisibleRows()
    expect(tc._contentLeft.querySelectorAll('.char-diff--current')).toHaveLength(0)
    expect(tc._inlineCursor).toEqual(cursor)

    const rowIdx = tc._rows.findIndex(r => r.kind === 'line' && r.diffLine.leftLine === 30000)
    tc._contentLeft.scrollTop = rowIdx * tc._rowHeight
    tc._renderVisibleRows()
    expect(tc._contentLeft.querySelectorAll('.char-diff--current').length +
           tc._contentRight.querySelectorAll('.char-diff--current').length).toBeGreaterThan(0)
  })

  it('undoes a deep edit exactly', () => {
    const tc = bigTC()
    const before = tc.getContent('left')
    tc.setCaret('left', 35000)
    tc.deleteLine()
    expect(tc.getContent('left')).not.toBe(before)
    expect(tc.undo()).toBe(true)
    expect(tc.getContent('left')).toBe(before)
  })
})
