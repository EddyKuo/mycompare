/**
 * @vitest-environment jsdom
 *
 * Sprint 7 tests: T42 Find & Replace, T43 Bookmarks,
 * T44 Go To Line, T45 Convert File.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks required before import ─────────────────────────────────────────────

Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: {
      openFile:      vi.fn(),
      saveFile:      vi.fn(),
      readFile:      vi.fn(),
      watchFile:     vi.fn(),
      unwatchFile:   vi.fn(),
      onFileChanged: vi.fn(),
    },
    getSelection: vi.fn(() => null),
  },
  writable: true,
})

const VS_ROW_HEIGHT = 20

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a TextCompare instance with minimal DOM stubs, bypassing mount().
 */
async function makeTC() {
  const mod = await import('../../src/renderer/src/views/text-compare.js')
  const tc  = new mod.TextCompare()
  tc._mounted = true
  tc._contentLeft  = {
    scrollTop: 0, clientHeight: 600, scrollHeight: 1000,
    querySelector:    vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    contains:         vi.fn(() => true),
    style: {},
    scrollTo: vi.fn(),
  }
  tc._contentRight = {
    scrollTop: 0, clientHeight: 600, scrollHeight: 1000,
    querySelector:    vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    contains:         vi.fn(() => false),
    style: {},
    scrollTo: vi.fn(),
  }
  tc._findBar       = null
  tc._findInput     = null
  tc._findCount     = null
  tc._statusEol     = null
  tc._statusEncoding = null
  tc._statusLines   = null
  tc._statusMessage = null
  tc._diffCounter   = null
  tc._minimap       = null
  tc._minimapViewport = null
  tc._pathLeft  = null
  tc._pathRight = null
  tc._compareArea = document.createElement('div')
  tc._compareArea.className = 'compare-area'
  // Stubs commonly used by methods under test:
  tc._renderVisibleRows = vi.fn()
  tc._runDiff           = vi.fn()
  tc._updateStatusBar   = vi.fn()
  return tc
}

/**
 * Build a row containing leftText/rightText for a single "line" row.
 * @param {{leftText?:string,rightText?:string,leftLine?:number|null,rightLine?:number|null,type?:string}} dl
 */
function lineRow(dl) {
  return {
    kind: 'line',
    diffLine: {
      type:      dl.type      ?? 'replace',
      leftLine:  dl.leftLine  ?? null,
      rightLine: dl.rightLine ?? null,
      leftText:  dl.leftText  ?? '',
      rightText: dl.rightText ?? '',
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── T42: Find & Replace ──────────────────────────────────────────────────────

describe('TextCompare._runFind — T42 find', () => {
  it('finds literal matches in left and right text (case-sensitive)', async () => {
    const tc = await makeTC()
    tc._rows = [
      lineRow({ leftText: 'hello world',  rightText: 'hi planet'  }),
      lineRow({ leftText: 'nothing here', rightText: 'hello again'}),
      lineRow({ leftText: 'foo',          rightText: 'bar'         }),
    ]
    tc._findQuery         = 'hello'
    tc._findCaseSensitive = true
    tc._findRegex         = false

    tc._runFind()

    expect(tc._findMatches.map(m => m.rowIndex)).toEqual([0, 1])
    expect(tc._findCurrentIdx).toBe(0)
  })

  it('performs case-insensitive search when _findCaseSensitive is false', async () => {
    const tc = await makeTC()
    tc._rows = [
      lineRow({ leftText: 'HELLO world', rightText: 'nope' }),
      lineRow({ leftText: 'nope',        rightText: 'Hello again' }),
      lineRow({ leftText: 'no match',    rightText: 'no match' }),
    ]
    tc._findQuery         = 'hello'
    tc._findCaseSensitive = false
    tc._findRegex         = false

    tc._runFind()

    expect(tc._findMatches.map(m => m.rowIndex)).toEqual([0, 1])
  })

  it('matches via regex pattern when _findRegex=true', async () => {
    const tc = await makeTC()
    tc._rows = [
      lineRow({ leftText: 'abc123def', rightText: 'no number' }),
      lineRow({ leftText: 'plain',     rightText: 'plain'     }),
      lineRow({ leftText: 'aaa',       rightText: 'value=42'  }),
    ]
    tc._findQuery         = '\\d+'
    tc._findCaseSensitive = true
    tc._findRegex         = true

    tc._runFind()

    expect(tc._findMatches.map(m => m.rowIndex)).toEqual([0, 2])
  })

  it('clears matches when query is empty', async () => {
    const tc = await makeTC()
    tc._rows = [ lineRow({ leftText: 'something', rightText: 'else' }) ]
    tc._findQuery = ''
    tc._findRegex = false
    tc._findCaseSensitive = true

    tc._runFind()

    expect(tc._findMatches).toEqual([])
    expect(tc._findCurrentIdx).toBe(-1)
  })
})

describe('TextCompare._replaceOne — T42 replace one', () => {
  it('replaces first literal occurrence in left side and updates _leftContent', async () => {
    const tc = await makeTC()
    tc._leftContent  = 'foo bar\nfoo baz\n'
    tc._rightContent = 'unchanged\n'
    tc._rows = [ lineRow({ leftText: 'foo bar', rightText: 'unchanged', type: 'replace' }) ]
    tc._findQuery         = 'foo'
    tc._findRegex         = false
    tc._findCaseSensitive = true
    tc._findMatches       = [ { rowIndex: 0 } ]
    tc._findCurrentIdx    = 0
    tc._replaceInput      = { value: 'XYZ' }
    // Stub side-effect methods so we don't need real diff machinery:
    tc._runFind     = vi.fn()
    tc._navigateFind = vi.fn()

    tc._replaceOne()

    expect(tc._leftContent).toBe('XYZ bar\nfoo baz\n')
    expect(tc._rightContent).toBe('unchanged\n')
    expect(tc._runDiff).toHaveBeenCalledOnce()
    expect(tc._navigateFind).toHaveBeenCalledWith(1)
  })

  it('regex replacement with backreferences ($2$1) swaps groups', async () => {
    const tc = await makeTC()
    tc._leftContent  = 'foobar end\n'
    tc._rightContent = ''
    tc._rows = [ lineRow({ leftText: 'foobar end', rightText: '' }) ]
    tc._findQuery         = '(foo)(bar)'
    tc._findRegex         = true
    tc._findCaseSensitive = true
    tc._findMatches       = [ { rowIndex: 0 } ]
    tc._findCurrentIdx    = 0
    tc._replaceInput      = { value: '$2$1' }
    tc._runFind      = vi.fn()
    tc._navigateFind = vi.fn()

    tc._replaceOne()

    expect(tc._leftContent).toBe('barfoo end\n')
  })

  it('is a no-op when there are no current matches', async () => {
    const tc = await makeTC()
    tc._leftContent  = 'foo bar\n'
    tc._rightContent = 'baz\n'
    tc._rows = [ lineRow({ leftText: 'foo bar', rightText: 'baz' }) ]
    tc._findQuery         = 'foo'
    tc._findRegex         = false
    tc._findCaseSensitive = true
    tc._findMatches       = []   // no matches
    tc._findCurrentIdx    = -1
    tc._replaceInput      = { value: 'X' }
    tc._runFind      = vi.fn()
    tc._navigateFind = vi.fn()

    tc._replaceOne()

    expect(tc._leftContent).toBe('foo bar\n')
    expect(tc._rightContent).toBe('baz\n')
    expect(tc._runDiff).not.toHaveBeenCalled()
  })
})

describe('TextCompare._replaceAll — T42 replace all', () => {
  it('replaces every literal occurrence on both sides (case-sensitive)', async () => {
    const tc = await makeTC()
    tc._leftContent  = 'foo and foo and bar'
    tc._rightContent = 'just foo here'
    tc._findQuery         = 'foo'
    tc._findRegex         = false
    tc._findCaseSensitive = true
    tc._replaceInput      = { value: 'BAR' }
    tc._runFind = vi.fn()

    tc._replaceAll()

    expect(tc._leftContent).toBe('BAR and BAR and bar')
    expect(tc._rightContent).toBe('just BAR here')
  })

  it('case-insensitive replace all uses gi flag and replaces every variant', async () => {
    const tc = await makeTC()
    tc._leftContent  = 'Foo FOO foo'
    tc._rightContent = 'NoMatch'
    tc._findQuery         = 'foo'
    tc._findRegex         = false
    tc._findCaseSensitive = false
    tc._replaceInput      = { value: 'X' }
    tc._runFind = vi.fn()

    tc._replaceAll()

    expect(tc._leftContent).toBe('X X X')
  })

  it('regex replace all (\\d+ → "N") globally substitutes', async () => {
    const tc = await makeTC()
    tc._leftContent  = 'a1 b22 c333'
    tc._rightContent = '4-5-6'
    tc._findQuery         = '\\d+'
    tc._findRegex         = true
    tc._findCaseSensitive = true
    tc._replaceInput      = { value: 'N' }
    tc._runFind = vi.fn()

    tc._replaceAll()

    expect(tc._leftContent).toBe('aN bN cN')
    expect(tc._rightContent).toBe('N-N-N')
  })
})

describe('TextCompare._toggleReplaceMode — T42', () => {
  it('flips _replaceMode flag on each call', async () => {
    const tc = await makeTC()
    tc._replaceMode = false

    tc._toggleReplaceMode()
    expect(tc._replaceMode).toBe(true)

    tc._toggleReplaceMode()
    expect(tc._replaceMode).toBe(false)
  })
})

// ── T43: Bookmarks ───────────────────────────────────────────────────────────

describe('TextCompare._toggleBookmark — T43', () => {
  it('adds row index to _bookmarks set when not present', async () => {
    const tc = await makeTC()
    tc._bookmarks = new Set()

    tc._toggleBookmark(5)

    expect(tc._bookmarks.has(5)).toBe(true)
    expect(tc._bookmarks.size).toBe(1)
  })

  it('removes row index when toggled twice', async () => {
    const tc = await makeTC()
    tc._bookmarks = new Set()

    tc._toggleBookmark(5)
    tc._toggleBookmark(5)

    expect(tc._bookmarks.has(5)).toBe(false)
    expect(tc._bookmarks.size).toBe(0)
  })
})

describe('TextCompare._navigateBookmark — T43', () => {
  it('navigates forward to first bookmark when scroll is before all', async () => {
    const tc = await makeTC()
    tc._bookmarks = new Set([3, 7, 10])
    tc._contentLeft.scrollTop  = 0   // row 0
    tc._contentRight.scrollTop = 0

    tc._navigateBookmark(+1)

    expect(tc._contentLeft.scrollTop).toBe(3 * VS_ROW_HEIGHT)
    expect(tc._contentRight.scrollTop).toBe(3 * VS_ROW_HEIGHT)
  })

  it('wraps to first bookmark when navigating forward past the last', async () => {
    const tc = await makeTC()
    tc._bookmarks = new Set([3, 7, 10])
    tc._contentLeft.scrollTop  = 20 * VS_ROW_HEIGHT   // past last bookmark
    tc._contentRight.scrollTop = 20 * VS_ROW_HEIGHT

    tc._navigateBookmark(+1)

    expect(tc._contentLeft.scrollTop).toBe(3 * VS_ROW_HEIGHT)
  })

  it('navigates backward to last bookmark before current scroll', async () => {
    const tc = await makeTC()
    tc._bookmarks = new Set([3, 7, 10])
    tc._contentLeft.scrollTop  = 20 * VS_ROW_HEIGHT
    tc._contentRight.scrollTop = 20 * VS_ROW_HEIGHT

    tc._navigateBookmark(-1)

    expect(tc._contentLeft.scrollTop).toBe(10 * VS_ROW_HEIGHT)
  })

  it('wraps backward to last bookmark when scrolled before all', async () => {
    const tc = await makeTC()
    tc._bookmarks = new Set([3, 7, 10])
    tc._contentLeft.scrollTop  = 0
    tc._contentRight.scrollTop = 0

    tc._navigateBookmark(-1)

    expect(tc._contentLeft.scrollTop).toBe(10 * VS_ROW_HEIGHT)
  })

  it('is a no-op when bookmarks set is empty', async () => {
    const tc = await makeTC()
    tc._bookmarks = new Set()
    tc._contentLeft.scrollTop  = 42
    tc._contentRight.scrollTop = 42

    tc._navigateBookmark(+1)

    expect(tc._contentLeft.scrollTop).toBe(42)
    expect(tc._contentRight.scrollTop).toBe(42)
  })

  it('with bookmarks [10,3,7], next from row 5 should jump to row 7 (sorted order)', async () => {
    const tc = await makeTC()
    tc._bookmarks = new Set([10, 3, 7])
    tc._contentLeft.scrollTop  = 5 * VS_ROW_HEIGHT
    tc._contentRight.scrollTop = 5 * VS_ROW_HEIGHT

    tc._navigateBookmark(+1)

    expect(tc._contentLeft.scrollTop).toBe(7 * VS_ROW_HEIGHT)
  })
})

// ── T44: Go To Line ──────────────────────────────────────────────────────────

describe('TextCompare._gotoLine — T44', () => {
  it('jumps both pane scrollTops to the matching row', async () => {
    const tc = await makeTC()
    tc._rows = [
      lineRow({ leftLine: 1, rightLine: 1, type: 'equal' }),
      lineRow({ leftLine: 2, rightLine: 2, type: 'equal' }),
      lineRow({ leftLine: 3, rightLine: 3, type: 'equal' }),
    ]
    tc._gotoInput = { value: '3' }

    tc._gotoLine()

    expect(tc._contentLeft.scrollTop).toBe(2 * VS_ROW_HEIGHT)   // 3rd row → index 2
    expect(tc._contentRight.scrollTop).toBe(2 * VS_ROW_HEIGHT)
  })

  it('is a no-op for non-numeric input', async () => {
    const tc = await makeTC()
    tc._rows = [ lineRow({ leftLine: 1, rightLine: 1, type: 'equal' }) ]
    tc._gotoInput = { value: 'abc' }
    tc._contentLeft.scrollTop  = 99
    tc._contentRight.scrollTop = 99

    tc._gotoLine()

    expect(tc._contentLeft.scrollTop).toBe(99)
    expect(tc._contentRight.scrollTop).toBe(99)
  })

  it('is a no-op for line number out of range', async () => {
    const tc = await makeTC()
    tc._rows = [
      lineRow({ leftLine: 1, rightLine: 1, type: 'equal' }),
      lineRow({ leftLine: 2, rightLine: 2, type: 'equal' }),
    ]
    tc._gotoInput = { value: '999' }
    tc._contentLeft.scrollTop  = 11
    tc._contentRight.scrollTop = 11

    tc._gotoLine()

    expect(tc._contentLeft.scrollTop).toBe(11)
    expect(tc._contentRight.scrollTop).toBe(11)
  })

  it('is a no-op for empty input', async () => {
    const tc = await makeTC()
    tc._rows = [ lineRow({ leftLine: 1, rightLine: 1, type: 'equal' }) ]
    tc._gotoInput = { value: '' }
    tc._contentLeft.scrollTop  = 7
    tc._contentRight.scrollTop = 7

    tc._gotoLine()

    expect(tc._contentLeft.scrollTop).toBe(7)
    expect(tc._contentRight.scrollTop).toBe(7)
  })
})

// ── T45: Convert File ────────────────────────────────────────────────────────

describe('TextCompare._convertFile — T45', () => {
  it('trim: removes trailing spaces/tabs but preserves newlines', async () => {
    const tc = await makeTC()
    tc._leftContent  = '  foo  \n\tbar\t\nbaz\n'
    tc._rightContent = 'untouched'

    tc._convertFile('left', 'trim')

    expect(tc._leftContent).toBe('  foo\n\tbar\nbaz\n')
    expect(tc._rightContent).toBe('untouched')
    expect(tc._runDiff).toHaveBeenCalledOnce()
  })

  it('tabs-to-spaces: replaces every tab with 4 spaces', async () => {
    const tc = await makeTC()
    tc._leftContent = '\tfoo\tbar\n'

    tc._convertFile('left', 'tabs-to-spaces')

    expect(tc._leftContent).toBe('    foo    bar\n')
  })

  it('spaces-to-tabs: converts leading 4-space groups to tabs only', async () => {
    const tc = await makeTC()
    tc._leftContent = '        foo    bar\n    baz\n'

    tc._convertFile('left', 'spaces-to-tabs')

    // First line: 8 leading spaces → 2 tabs; the "    " between foo/bar
    // is NOT leading and must be left alone.
    expect(tc._leftContent).toBe('\t\tfoo    bar\n\tbaz\n')
  })

  it('to-crlf: normalizes mixed CR, LF, and CRLF to CRLF', async () => {
    const tc = await makeTC()
    tc._leftContent = 'a\nb\r\nc\rd'

    tc._convertFile('left', 'to-crlf')

    expect(tc._leftContent).toBe('a\r\nb\r\nc\r\nd')
  })

  it('to-lf: normalizes CRLF and CR to LF', async () => {
    const tc = await makeTC()
    tc._leftContent = 'a\r\nb\rc\nd'

    tc._convertFile('left', 'to-lf')

    expect(tc._leftContent).toBe('a\nb\nc\nd')
  })

  it('to-cr: normalizes CRLF and LF to lone CR', async () => {
    const tc = await makeTC()
    tc._leftContent = 'a\r\nb\nc'

    tc._convertFile('left', 'to-cr')

    expect(tc._leftContent).toBe('a\rb\rc')
  })

  it('side="right" operates on _rightContent and leaves _leftContent untouched', async () => {
    const tc = await makeTC()
    tc._leftContent  = '  left  \n'
    tc._rightContent = '  right  \n'

    tc._convertFile('right', 'trim')

    expect(tc._leftContent).toBe('  left  \n')
    expect(tc._rightContent).toBe('  right\n')
  })
})
