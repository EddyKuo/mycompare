/**
 * @vitest-environment jsdom
 *
 * Find pre-fills from the selection, or the word under the caret.
 *
 * The word rule is the part worth testing: an identifier has to come out whole
 * in any script, and the caret sitting just past the last character — where it
 * lands after you finish typing a name — still has to count as inside it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { wordAt, selectedTextOrWordAtCaret } from '../../src/renderer/src/views/text-compare.js'

describe('wordAt', () => {
  it('takes a whole identifier, underscores and digits included', () => {
    const line = 'const foo_bar2 = 1'
    for (const offset of [6, 9, 13]) {
      expect(wordAt(line, offset), `offset ${offset}`).toBe('foo_bar2')
    }
  })

  it('counts the position just past a word as inside it', () => {
    // Where the caret sits after typing a name; requiring a character under it
    // would make Find come up empty in the most common case.
    expect(wordAt('const total', 11)).toBe('total')
  })

  it('does not stop at a non-ASCII character', () => {
    expect(wordAt('const 使用者名稱 = 1', 8)).toBe('使用者名稱')
    expect(wordAt('let café = 2', 5)).toBe('café')
  })

  it('returns nothing when the offset is on punctuation or space', () => {
    expect(wordAt('a + b', 2)).toBe('')
    expect(wordAt('a  b', 2)).toBe('')
  })

  it('tolerates junk input', () => {
    expect(wordAt('', 0)).toBe('')
    expect(wordAt(null, 0)).toBe('')
    expect(wordAt('abc', 999)).toBe('abc')
    expect(wordAt('abc', -5)).toBe('abc')
  })
})

describe('selectedTextOrWordAtCaret', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
  })

  /** Put the caret inside a text node at `offset`, or select a range. */
  function place(text, start, end = start) {
    const node = document.createTextNode(text)
    document.body.appendChild(node)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }

  it('prefers a non-empty selection', () => {
    place('const total = 1', 6, 11)
    expect(selectedTextOrWordAtCaret()).toBe('total')
  })

  it('falls back to the word under the caret', () => {
    place('const total = 1', 8)
    expect(selectedTextOrWordAtCaret()).toBe('total')
  })

  it('ignores a selection spanning lines, which is a range not a term', () => {
    place('one\ntwo', 0, 7)
    expect(selectedTextOrWordAtCaret()).toBe('')
  })

  it('returns nothing when there is no selection at all', () => {
    window.getSelection().removeAllRanges()
    expect(selectedTextOrWordAtCaret()).toBe('')
  })
})
