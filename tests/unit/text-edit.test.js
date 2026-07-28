/**
 * @vitest-environment jsdom
 *
 * Text Edit — BC's standalone editor.
 *
 * The offset arithmetic is what breaks here: a line command that is off by one
 * eats the newline and joins two lines, and a word command that is off by one
 * leaves a stray character. So the position helpers are pinned directly, and
 * the commands are driven through a mounted view with a real textarea rather
 * than a stub, because the caret lives on that element.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  TextEdit, offsetToLineCol, lineColToOffset, lineBoundsAt, wordBoundsAt,
  showWhitespace,
} from '../../src/renderer/src/views/text-edit.js'

vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: () => {}, closeContextMenu: () => {},
}))
vi.mock('../../src/renderer/src/core/toast.js', () => ({ toast: () => {} }))

/** @type {TextEdit} */
let view

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = '<div id="host"></div>'
  view = new TextEdit()
  view.mount(document.getElementById('host'))
})

afterEach(() => {
  view.destroy()
  document.body.innerHTML = ''
})

/**
 * @param {string} text
 * @param {number} caret
 */
function load(text, caret = 0) {
  view.setContent('C:/t/a.js', text, 'UTF-8')
  const ta = document.querySelector('.te-input')
  ta.value = text
  ta.setSelectionRange(caret, caret)
  return ta
}

describe('position helpers', () => {
  it('maps an offset to a 1-based line and column', () => {
    expect(offsetToLineCol('ab\ncd', 0)).toEqual({ line: 1, column: 1 })
    expect(offsetToLineCol('ab\ncd', 2)).toEqual({ line: 1, column: 3 })
    // Just past the newline is the start of the next line, not the end of this.
    expect(offsetToLineCol('ab\ncd', 3)).toEqual({ line: 2, column: 1 })
  })

  it('round-trips against lineColToOffset', () => {
    const text = 'one\ntwo\nthree'
    for (let i = 0; i <= text.length; i++) {
      const { line, column } = offsetToLineCol(text, i)
      expect(lineColToOffset(text, line, column), `offset ${i}`).toBe(i)
    }
  })

  it('clamps a line past the end instead of returning NaN', () => {
    expect(lineColToOffset('a\nb', 99)).toBe(2)
    expect(lineColToOffset('a\nb', 0)).toBe(0)
  })

  it('excludes the newline from line bounds', () => {
    expect(lineBoundsAt('ab\ncd', 1)).toEqual({ start: 0, end: 2 })
    expect(lineBoundsAt('ab\ncd', 4)).toEqual({ start: 3, end: 5 })
  })

  it('finds the word around an offset', () => {
    expect(wordBoundsAt('foo bar', 5)).toEqual({ start: 4, end: 7 })
    expect(wordBoundsAt('foo bar', 0)).toEqual({ start: 0, end: 3 })
  })
  it('takes the word the caret sits at the end of', () => {
    expect(wordBoundsAt('foo   bar', 3)).toEqual({ start: 0, end: 3 })
  })

  it('takes the run of separators when the caret is between words', () => {
    // Otherwise Delete Word in the gap would do nothing at all.
    expect(wordBoundsAt('foo   bar', 4)).toEqual({ start: 4, end: 6 })
  })

  it('marks whitespace only for display', () => {
    expect(showWhitespace('a b\tc')).toBe('a·b→\tc')
  })
})

describe('line and word commands', () => {
  it('deletes the whole line including its newline', () => {
    load('one\ntwo\nthree', 4)
    view.deleteLine()
    expect(view.getContent()).toBe('one\nthree')
  })

  it('deletes the last line without eating the line before it', () => {
    // A naive `end + 1` runs past the string on the final line.
    load('one\ntwo', 5)
    view.deleteLine()
    expect(view.getContent()).toBe('one\n')
  })

  it('deletes to the start and end of the line', () => {
    load('hello world', 5)
    view.deleteToLineEdge('start')
    expect(view.getContent()).toBe(' world')

    load('hello world', 5)
    view.deleteToLineEdge('end')
    expect(view.getContent()).toBe('hello')
  })

  it('deletes a word and the parts of one', () => {
    load('foo bar baz', 4)
    view.deleteWord()
    expect(view.getContent()).toBe('foo  baz')

    load('foo bar', 5)
    view.deleteToWordEdge('start')
    expect(view.getContent()).toBe('foo ar')

    load('foo bar', 5)
    view.deleteToWordEdge('end')
    expect(view.getContent()).toBe('foo b')
  })

  it('inserts a line before and after the current one', () => {
    load('a\nb', 0)
    view.insertLine('before')
    expect(view.getContent()).toBe('\na\nb')

    load('a\nb', 0)
    view.insertLine('after')
    expect(view.getContent()).toBe('a\n\nb')
  })

  it('indents and unindents every line the selection touches', () => {
    const ta = load('a\nb\nc')
    ta.setSelectionRange(0, 3) // spans lines 1 and 2
    view.indent(1)
    expect(view.getContent()).toBe('  a\n  b\nc')

    view.indent(-1)
    expect(view.getContent()).toBe('a\nb\nc')
  })
})

describe('convert file', () => {
  it('trims trailing whitespace without touching the middle', () => {
    load('a  b   \n\tc\t\n')
    view.trimTrailingWhitespace()
    expect(view.getContent()).toBe('a  b\n\tc\n')
  })

  it('converts tabs to spaces', () => {
    load('\tx')
    view.tabsToSpaces(4)
    expect(view.getContent()).toBe('    x')
  })

  it('converts only leading spaces to tabs', () => {
    // A run inside the line is content — aligned columns and string literals
    // would be corrupted by converting it.
    load('        a    b')
    view.spacesToTabs(4)
    expect(view.getContent()).toBe('\t\ta    b')
  })

  it('keeps the line ending beside the text, not inside it', () => {
    // A textarea cannot hold CRLF: the HTML spec normalises its value line
    // breaks to LF, so anything written into the buffer reads back as LF.
    // The style therefore lives on the view and is applied when writing out.
    load('a\r\nb\r\nc')
    expect(view.getLineEndings()).toBe('CRLF')

    view.setLineEndings('lf')
    expect(view.getLineEndings()).toBe('LF')
    expect(view.contentForSave()).toBe('a\nb\nc')

    view.setLineEndings('crlf')
    expect(view.contentForSave()).toBe('a\r\nb\r\nc')

    view.setLineEndings('cr')
    expect(view.contentForSave()).toBe('a\rb\rc')
  })

  it('detects the style the file arrived with', () => {
    load('a\nb')
    expect(view.getLineEndings()).toBe('LF')
  })

  it('marks the file modified only when the style actually changes', () => {
    load('a\nb')
    expect(view.isModified()).toBe(false)
    view.setLineEndings('lf')
    expect(view.isModified()).toBe(false)
    view.setLineEndings('crlf')
    expect(view.isModified()).toBe(true)
  })

  it('ignores a style it does not know rather than writing something wrong', () => {
    load('a\nb')
    expect(view.setLineEndings('nonsense')).toBe('LF')
  })
})

describe('undo and redo', () => {
  it('steps back and forward through edits', () => {
    load('a')
    view.replaceRange(1, 1, 'b')
    expect(view.getContent()).toBe('ab')
    view.undo()
    expect(view.getContent()).toBe('a')
    view.redo()
    expect(view.getContent()).toBe('ab')
  })

  it('drops the redo stack once a new edit lands', () => {
    load('a')
    view.replaceRange(1, 1, 'b')
    view.undo()
    view.replaceRange(1, 1, 'c')
    expect(view.redo()).toBe(false)
    expect(view.getContent()).toBe('ac')
  })

  it('reports nothing to undo on a fresh buffer', () => {
    load('a')
    expect(view.undo()).toBe(false)
  })
})

describe('search within the file', () => {
  it('finds the next match and selects it', () => {
    const ta = load('one two one', 0)
    expect(view.findNext('one')).toBe(true)
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([0, 3])
    expect(view.findNext('one')).toBe(true)
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([8, 11])
  })

  it('wraps rather than reporting nothing when the only match is behind', () => {
    const ta = load('needle tail', 8)
    expect(view.findNext('needle')).toBe(true)
    expect(ta.selectionStart).toBe(0)
  })

  it('is case-insensitive unless asked otherwise', () => {
    load('ABC', 0)
    expect(view.findNext('abc')).toBe(true)
    expect(view.findNext('abc', { caseSensitive: true })).toBe(false)
  })

  it('treats the query literally unless regex is on', () => {
    load('a.b axb', 0)
    expect(view.findNext('a.b')).toBe(true)
    const ta = document.querySelector('.te-input')
    expect(ta.selectionStart).toBe(0)
  })

  it('replaces every occurrence and reports the count', () => {
    load('x x x')
    expect(view.replaceAll('x', 'y')).toBe(3)
    expect(view.getContent()).toBe('y y y')
  })

  it('leaves the buffer alone when nothing matches', () => {
    load('abc')
    expect(view.replaceAll('zzz', 'y')).toBe(0)
    expect(view.getContent()).toBe('abc')
    expect(view.isModified()).toBe(false)
  })
})

describe('bookmarks', () => {
  it('toggles on the caret line and navigates between them', () => {
    load('a\nb\nc\nd', 0)
    view.goToLine(2)
    expect(view.toggleBookmark()).toBe(true)
    view.goToLine(4)
    view.toggleBookmark()
    expect(view.getBookmarks()).toEqual([2, 4])

    view.goToLine(1)
    view.goToBookmark(1)
    expect(offsetToLineCol(view.getContent(),
      document.querySelector('.te-input').selectionStart).line).toBe(2)

    view.clearBookmarks()
    expect(view.getBookmarks()).toEqual([])
    expect(view.goToBookmark(1)).toBe(false)
  })

  it('draws a marker in the gutter for a bookmarked line', () => {
    load('a\nb', 0)
    view.goToLine(2)
    view.toggleBookmark()
    const marks = document.querySelectorAll('.te-gutter .te-bookmarked')
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent).toBe('2')
  })
})

describe('the modified flag', () => {
  it('is set by an edit and cleared by loading new content', () => {
    load('a')
    expect(view.isModified()).toBe(false)
    view.replaceRange(1, 1, 'b')
    expect(view.isModified()).toBe(true)
    view.setContent('C:/t/b.js', 'fresh')
    expect(view.isModified()).toBe(false)
  })

  it('survives a cancelled save rather than claiming the file was written', () => {
    // Cancelling returns falsy. Clearing the flag anyway would let the tab
    // close without a prompt and lose the edits.
    load('a')
    view.replaceRange(1, 1, 'b')
    window.electronAPI = { saveFile: async () => null }
    return view.save().then(() => {
      expect(view.isModified()).toBe(true)
    })
  })
})

describe('the highlighted underlay', () => {
  it('shows the same text the textarea holds', () => {
    load('const x = 1')
    const code = document.querySelector('.te-code')
    expect(code.textContent).toBe('const x = 1')
  })

  it('marks whitespace in the underlay only, never in the buffer', () => {
    load('a b')
    view.setVisibleWhitespace(true)
    expect(document.querySelector('.te-code').textContent).toBe('a·b')
    // The text being edited must not change, or saving would write the dots.
    expect(view.getContent()).toBe('a b')
  })
})
