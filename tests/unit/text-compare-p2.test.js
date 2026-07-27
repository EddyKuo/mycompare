/**
 * @vitest-environment jsdom
 *
 * Gap-matrix v3 P2 items owned by the text-compare view:
 *   P2-48 — Text Compare Info
 *   P2-49 — edit-mode typing enters the undo stack
 *   P2-51 — numbered Go To Bookmark
 *   P2-52 — syntax highlighting toggle
 *   P2-53 — whitespace comparison modes
 *   P2-54 — orphan lines are always important
 *   P2-55 — unimportant text list dialog
 *   P2-58 — per-side file format
 *   P2-59 / P2-60 — never align / skew tolerance / closeness matching
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const electronAPI = {
  openFile: vi.fn(),
  saveFile: vi.fn(),
  readFile: vi.fn(),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  onFileChanged: vi.fn(),
}
globalThis.window.electronAPI = electronAPI

const {
  TextCompare,
  applyWhitespaceMode,
  applyAlignmentOptions,
  alignmentOptionsActive,
  lineSimilarity,
} = await import('../../src/renderer/src/views/text-compare.js')

/** @returns {InstanceType<typeof TextCompare>} */
function makeTC() {
  const tc = new TextCompare()
  tc._mounted = true
  const left = document.createElement('div')
  const right = document.createElement('div')
  document.body.append(left, right)
  tc._contentLeft = left
  tc._contentRight = right
  tc._compareArea = document.createElement('div')
  return tc
}

/**
 * @param {InstanceType<typeof TextCompare>} tc
 * @param {string} l
 * @param {string} r
 */
function load(tc, l, r) {
  tc._leftContent = l
  tc._rightContent = r
  tc._runDiff()
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

// ── P2-53 whitespace modes ───────────────────────────────────────────────────

describe('P2-53 whitespace comparison modes', () => {
  it('applyWhitespaceMode leaves engine-expressible modes untouched', () => {
    const text = '  a  b  \n'
    expect(applyWhitespaceMode(text, 'none')).toBe(text)
    expect(applyWhitespaceMode(text, 'leading')).toBe(text)
    expect(applyWhitespaceMode(text, 'amount')).toBe(text)
  })

  it('strips all whitespace / trailing whitespace, keeping line count', () => {
    const text = '  a  b  \n\tc\t\n'
    expect(applyWhitespaceMode(text, 'all')).toBe('ab\nc\n')
    expect(applyWhitespaceMode(text, 'trailing')).toBe('  a  b\n\tc\n')
    expect(applyWhitespaceMode(text, 'all').split('\n').length).toBe(text.split('\n').length)
  })

  it('trailing mode makes a trailing-space-only change compare equal', () => {
    const tc = makeTC()
    load(tc, 'alpha   \nbeta\n', 'alpha\nbeta\n')
    expect(tc._diffResult.some(d => d.type !== 'equal')).toBe(true)
    tc.setWhitespaceMode('trailing')
    expect(tc._diffResult.every(d => d.type === 'equal')).toBe(true)
  })

  it('all mode ignores internal whitespace that amount mode also ignores', () => {
    const tc = makeTC()
    load(tc, 'a   b\n', 'a b\n')
    tc.setWhitespaceMode('all')
    expect(tc._diffResult.every(d => d.type === 'equal')).toBe(true)
  })

  it('the panes still show the original text after a rewrite mode', () => {
    const tc = makeTC()
    load(tc, 'alpha   \n', 'alpha\n')
    tc.setWhitespaceMode('trailing')
    expect(tc._diffResult[0].leftText).toBe('alpha   \n')
  })

  it('modes are mutually exclusive and derive back from the legacy flags', () => {
    const tc = makeTC()
    expect(tc.getWhitespaceMode()).toBe('none')
    tc.setWhitespaceMode('amount')
    expect(tc._opts.ignoreWhitespace).toBe(true)
    expect(tc.getWhitespaceMode()).toBe('amount')
    tc.setWhitespaceMode('leading')
    expect(tc._opts.ignoreWhitespace).toBe(false)
    expect(tc._opts.ignoreIndent).toBe(true)
    tc.setWhitespaceMode('trailing')
    expect(tc._opts.ignoreIndent).toBe(false)
    expect(tc.getWhitespaceMode()).toBe('trailing')
    tc.setWhitespaceMode('none')
    expect(tc.getWhitespaceMode()).toBe('none')
  })

  it('an unrecognised mode falls back to none rather than throwing', () => {
    const tc = makeTC()
    expect(tc.setWhitespaceMode(/** @type {never} */ ('sideways'))).toBe('none')
  })
})

// ── P2-59 / P2-60 alignment options ──────────────────────────────────────────

describe('P2-59 / P2-60 alignment options', () => {
  it('is inert until an option is set, so the default diff is unchanged', () => {
    expect(alignmentOptionsActive({})).toBe(false)
    const diff = [{ type: 'replace', leftLine: 1, rightLine: 1, leftText: 'a', rightText: 'b' }]
    expect(applyAlignmentOptions(diff, {})).toBe(diff)
  })

  it('lineSimilarity is 1 for identical, 0 for disjoint', () => {
    expect(lineSimilarity('hello', 'hello')).toBe(1)
    expect(lineSimilarity('abcd', 'wxyz')).toBe(0)
    expect(lineSimilarity('foo(bar)', 'foo(baz)')).toBeGreaterThan(0.5)
  })

  it('never-align splits a paired row into two orphans', () => {
    const diff = [{ type: 'replace', leftLine: 1, rightLine: 1, leftText: '// x', rightText: 'y' }]
    const out = applyAlignmentOptions(diff, { neverAlign: [/^\/\//] })
    expect(out.map(d => d.type)).toEqual(['delete', 'insert'])
    expect(out[0].leftText).toBe('// x')
    expect(out[1].rightText).toBe('y')
  })

  it('skew tolerance refuses a pairing that sits too far apart in the run', () => {
    const diff = [
      { type: 'delete', leftLine: 1, rightLine: null, leftText: 'a', rightText: '' },
      { type: 'delete', leftLine: 2, rightLine: null, leftText: 'b', rightText: '' },
      { type: 'delete', leftLine: 3, rightLine: null, leftText: 'c', rightText: '' },
      { type: 'insert', leftLine: null, rightLine: 1, leftText: '', rightText: 'z' },
    ]
    const loose = applyAlignmentOptions(diff, { skewTolerance: 5 })
    expect(loose.filter(d => d.type === 'replace')).toHaveLength(1)
    // 'z' is index 0 on the right; with a tolerance of 0 only left index 0 may
    // pair with it, and that pairing is the one the engine already had.
    const tight = applyAlignmentOptions(diff, { skewTolerance: 1 })
    expect(tight.filter(d => d.type === 'replace').every(d => d.leftLine <= 2)).toBe(true)
  })

  it('closeness matching pairs a moved-and-edited line with its counterpart', () => {
    const diff = [
      { type: 'delete', leftLine: 1, rightLine: null, leftText: 'totally different text', rightText: '' },
      { type: 'delete', leftLine: 2, rightLine: null, leftText: 'const answer = 42;', rightText: '' },
      { type: 'insert', leftLine: null, rightLine: 1, leftText: '', rightText: 'const answer = 43;' },
    ]
    const out = applyAlignmentOptions(diff, { useCloseness: true, closenessThreshold: 0.5 })
    const pair = out.find(d => d.type === 'replace')
    expect(pair).toBeDefined()
    expect(pair.leftLine).toBe(2)
    expect(pair.rightLine).toBe(1)
  })

  it('closeness matching leaves dissimilar lines as orphans', () => {
    const diff = [
      { type: 'replace', leftLine: 1, rightLine: 1, leftText: 'aaaa', rightText: 'zzzz' },
    ]
    const out = applyAlignmentOptions(diff, { useCloseness: true, closenessThreshold: 0.5 })
    expect(out.map(d => d.type)).toEqual(['delete', 'insert'])
  })

  it('output keeps file order on both sides', () => {
    const diff = [
      { type: 'replace', leftLine: 1, rightLine: 1, leftText: 'one', rightText: 'uno' },
      { type: 'replace', leftLine: 2, rightLine: 2, leftText: 'two', rightText: 'dos' },
      { type: 'replace', leftLine: 3, rightLine: 3, leftText: 'three', rightText: 'tres' },
    ]
    const out = applyAlignmentOptions(diff, { useCloseness: true, closenessThreshold: 0 })
    const ls = out.map(d => d.leftLine).filter(n => n != null)
    const rs = out.map(d => d.rightLine).filter(n => n != null)
    expect(ls).toEqual([...ls].sort((a, b) => a - b))
    expect(rs).toEqual([...rs].sort((a, b) => a - b))
  })

  it('leaves oversized runs alone rather than going quadratic on them', () => {
    const diff = Array.from({ length: 400 }, (_, i) => (
      { type: 'replace', leftLine: i + 1, rightLine: i + 1, leftText: `l${i}`, rightText: `r${i}` }))
    const out = applyAlignmentOptions(diff, { useCloseness: true })
    expect(out).toHaveLength(400)
    expect(out.every(d => d.type === 'replace')).toBe(true)
  })

  it('setNeverAlignPatterns reports patterns that will not compile', () => {
    const tc = makeTC()
    const bad = tc.setNeverAlignPatterns(['^ok', '([unclosed'])
    expect(bad).toEqual(['([unclosed'])
    expect(tc.getNeverAlignPatterns()).toEqual(['^ok', '([unclosed'])
    expect(tc._neverAlignCompiled).toHaveLength(1)
  })

  it('counts the lines the never-align patterns exclude', () => {
    const tc = makeTC()
    tc._leftContent = '// a\nb\n// c\n'
    tc._rightContent = 'b\n'
    tc.setNeverAlignPatterns(['^//'])
    expect(tc.getUnalignedLineCounts()).toEqual({ left: 2, right: 0 })
  })

  it('skew tolerance is clamped to a sane range', () => {
    const tc = makeTC()
    expect(tc.setSkewTolerance(-4)).toBe(0)
    expect(tc.setSkewTolerance(99999)).toBe(1000)
    expect(tc.setSkewTolerance('nope')).toBe(0)
  })
})

// ── P2-54 orphan importance ──────────────────────────────────────────────────

describe('P2-54 orphan lines are always important', () => {
  it('an unimportant pattern no longer downgrades a one-sided line', () => {
    const tc = makeTC()
    tc.setIgnorePatterns([], ['^import'])
    load(tc, 'import os\nbody\n', 'body\n')
    const orphan = tc._diffResult.find(d => d.type === 'delete')
    expect(orphan.unimportant).toBe(true)

    tc.setOrphansAlwaysImportant(true)
    const again = tc._diffResult.find(d => d.type === 'delete')
    expect(again.unimportant).toBe(false)
  })

  it('still downgrades a changed line that exists on both sides', () => {
    const tc = makeTC()
    tc.setOrphansAlwaysImportant(true)
    tc.setIgnorePatterns([], ['^import'])
    load(tc, 'import os\n', 'import sys\n')
    expect(tc._diffResult[0].type).toBe('replace')
    expect(tc._diffResult[0].unimportant).toBe(true)
  })

  it('a manual mark still wins over the orphan rule', () => {
    const tc = makeTC()
    tc.setOrphansAlwaysImportant(true)
    load(tc, 'gone\nkept\n', 'kept\n')
    tc._manualIgnore.left.add(1)
    tc._runDiff()
    const orphan = tc._diffResult.find(d => d.type === 'delete')
    expect(orphan.unimportant).toBe(true)
  })

  it('protected orphans survive Ignore Unimportant Differences', () => {
    const tc = makeTC()
    tc.setIgnorePatterns([], ['^import'])
    tc.setOrphansAlwaysImportant(true)
    tc.setIgnoreUnimportant(true)
    load(tc, 'import os\nbody\n', 'body\n')
    expect(tc._diffResult.some(d => d.type === 'delete')).toBe(true)
  })
})

// ── P2-52 syntax highlighting toggle ─────────────────────────────────────────

describe('P2-52 syntax highlighting toggle', () => {
  it('defaults on and toggles', () => {
    const tc = makeTC()
    expect(tc.syntaxHighlighting).toBe(true)
    expect(tc.setSyntaxHighlighting()).toBe(false)
    expect(tc.setSyntaxHighlighting(true)).toBe(true)
  })

  it('withholds the highlighter from the render path when off', () => {
    const tc = makeTC()
    const fake = { hljs: {}, langId: 'javascript' }
    tc._hlLeft = fake
    tc._hlRight = fake
    expect(tc._hl('left')).toBe(fake)
    tc.setSyntaxHighlighting(false)
    expect(tc._hl('left')).toBeNull()
    expect(tc._hl('right')).toBeNull()
  })
})

// ── P2-58 file format ────────────────────────────────────────────────────────

describe('P2-58 per-side file format', () => {
  it('lists the registered formats', () => {
    const tc = makeTC()
    expect(tc.listFileFormats()).toContain('Python')
  })

  it('forcing a format overrides the extension', () => {
    const tc = makeTC()
    tc._leftPath = '/tmp/a.txt'
    tc._rightPath = '/tmp/b.txt'
    expect(tc.setFileFormat('left', 'Python')).toBe(true)
    expect(tc.getGrammarInfo().left).toBe('Python')
  })

  it('"same as left" follows a later change to the left side', () => {
    const tc = makeTC()
    tc.setFileFormat('right', 'same-as-left')
    tc.setFileFormat('left', 'Python')
    expect(tc.getGrammarInfo().right).toBe('Python')
    tc.setFileFormat('left', 'XML / HTML')
    expect(tc.getGrammarInfo().right).toBe('XML / HTML')
  })

  it('rejects an unknown format and "same as left" on the left side', () => {
    const tc = makeTC()
    expect(tc.setFileFormat('left', 'Klingon')).toBe(false)
    expect(tc.setFileFormat('left', 'same-as-left')).toBe(false)
    expect(tc.getFileFormats().left).toBeNull()
  })

  it('null goes back to detecting from the filename', () => {
    const tc = makeTC()
    tc._leftPath = '/tmp/a.py'
    tc.setFileFormat('left', 'XML / HTML')
    expect(tc.getGrammarInfo().left).toBe('XML / HTML')
    tc.setFileFormat('left', null)
    expect(tc.getGrammarInfo().left).toBe('Python')
  })
})

// ── P2-48 Text Compare Info ──────────────────────────────────────────────────

describe('P2-48 Text Compare Info', () => {
  it('reports per-side and diff statistics', () => {
    const tc = makeTC()
    tc._leftPath = '/tmp/a.txt'
    load(tc, 'one\ntwo\nthree\n', 'one\n2\nthree\nfour\n')
    const info = tc.getCompareInfo()
    expect(info.left.lines).toBe(3)
    expect(info.right.lines).toBe(4)
    expect(info.left.chars).toBe('one\ntwo\nthree\n'.length)
    expect(info.left.path).toBe('/tmp/a.txt')
    expect(info.diff.equal).toBe(2)
    expect(info.diff.replace).toBe(1)
    expect(info.diff.insert).toBe(1)
  })

  it('counts bytes, not characters, for non-ASCII text', () => {
    const tc = makeTC()
    load(tc, '中文\n', '中文\n')
    const info = tc.getCompareInfo()
    expect(info.left.chars).toBe(3)
    expect(info.left.bytes).toBe(7)
  })

  it('opens a dialog carrying the numbers', () => {
    const tc = makeTC()
    load(tc, 'a\n', 'b\n')
    tc.openInfoDialog()
    const dlg = document.querySelector('dialog')
    expect(dlg).toBeTruthy()
    expect(dlg.textContent).toContain('文字比對資訊')
    expect(dlg.textContent).toContain('差異區塊')
  })
})

// ── P2-51 numbered bookmarks ─────────────────────────────────────────────────

describe('P2-51 numbered Go To Bookmark', () => {
  it('jumps to the Nth bookmark in line order', () => {
    const tc = makeTC()
    tc._rowHeight = 20
    tc._renderVisibleRows = vi.fn()
    tc._bookmarks = new Set([40, 5, 17])
    expect(tc.gotoBookmark(1)).toBe(true)
    expect(tc._contentLeft.scrollTop).toBe(100)
    expect(tc.gotoBookmark(3)).toBe(true)
    expect(tc._contentLeft.scrollTop).toBe(800)
  })

  it('says so instead of doing nothing when out of range', () => {
    const tc = makeTC()
    tc._renderVisibleRows = vi.fn()
    expect(tc.gotoBookmark(1)).toBe(false)
    tc._bookmarks = new Set([3])
    expect(tc.gotoBookmark(9)).toBe(false)
    expect(tc.gotoBookmark(0)).toBe(false)
  })
})

// ── P2-55 unimportant text list ──────────────────────────────────────────────

describe('P2-55 unimportant text list dialog', () => {
  it('renders one editable row per existing rule', () => {
    const tc = makeTC()
    tc.setIgnorePatterns([], ['^import', '^\\s*#'])
    tc.openUnimportantTextDialog()
    const inputs = document.querySelectorAll('dialog input[type="text"]')
    expect(inputs).toHaveLength(2)
    expect(inputs[0].value).toBe('^import')
  })

  it('a rule that will not compile keeps the dialog open', () => {
    const tc = makeTC()
    tc.setIgnorePatterns([], ['([unclosed'])
    tc.openUnimportantTextDialog()
    const dlg = document.querySelector('dialog')
    const ok = [...dlg.querySelectorAll('button')].find(b => b.textContent === '套用')
    ok.click()
    expect(document.querySelector('dialog')).toBeTruthy()
    expect(tc._opts.unimportantPatterns).toEqual(['([unclosed'])
  })

  it('applying a valid list replaces the rules and closes', () => {
    const tc = makeTC()
    tc.setIgnorePatterns(['^KEEP'], ['^old'])
    tc.openUnimportantTextDialog()
    const dlg = document.querySelector('dialog')
    const input = dlg.querySelector('input[type="text"]')
    input.value = '^new'
    input.dispatchEvent(new Event('input'))
    const ok = [...dlg.querySelectorAll('button')].find(b => b.textContent === '套用')
    ok.click()
    expect(tc._opts.unimportantPatterns).toEqual(['^new'])
    // The hard-ignore list is a separate control and must survive.
    expect(tc._opts.ignorePatterns).toEqual(['^KEEP'])
  })

  it('the delete button drops a rule', () => {
    const tc = makeTC()
    tc.setIgnorePatterns([], ['^a', '^b'])
    tc.openUnimportantTextDialog()
    const dlg = document.querySelector('dialog')
    const del = [...dlg.querySelectorAll('button')].find(b => b.textContent === '刪除')
    del.click()
    expect(dlg.querySelectorAll('input[type="text"]')).toHaveLength(1)
  })
})

// ── P2-49 edit-mode undo ─────────────────────────────────────────────────────

describe('P2-49 edit-mode typing enters the undo stack', () => {
  it('snapshots once per typing burst, not per keystroke', () => {
    vi.useFakeTimers()
    const tc = makeTC()
    tc._leftContent = 'before\n'
    tc._runDiff = vi.fn()
    const pane = document.createElement('div')
    pane.id = 'pane-left'
    document.body.appendChild(pane)
    const ta = tc._createEditTextarea('left')

    ta.value = 'a'
    ta.dispatchEvent(new Event('input'))
    ta.value = 'ab'
    ta.dispatchEvent(new Event('input'))
    expect(tc._undoStack).toHaveLength(1)

    vi.advanceTimersByTime(400)
    expect(tc._leftContent).toBe('ab')

    ta.value = 'abc'
    ta.dispatchEvent(new Event('input'))
    expect(tc._undoStack).toHaveLength(2)
    vi.useRealTimers()
  })

  it('undo restores the pre-edit text and refreshes the overlay', () => {
    vi.useFakeTimers()
    const tc = makeTC()
    tc._leftContent = 'before\n'
    tc._runDiff = vi.fn()
    const pane = document.createElement('div')
    pane.id = 'pane-left'
    document.body.appendChild(pane)
    const ta = tc._createEditTextarea('left')
    tc._textareaLeft = ta
    tc._editMode = true

    ta.value = 'after\n'
    ta.dispatchEvent(new Event('input'))
    vi.advanceTimersByTime(400)
    expect(tc._leftContent).toBe('after\n')

    expect(tc.undo()).toBe(true)
    expect(tc._leftContent).toBe('before\n')
    expect(ta.value).toBe('before\n')
    vi.useRealTimers()
  })
})

// ── Regression: the new options survive a config round trip ─────────────────

describe('P2 options round-trip through getConfig/applyConfig', () => {
  it('restores every new option', () => {
    const tc = makeTC()
    tc.setWhitespaceMode('trailing')
    tc.setSyntaxHighlighting(false)
    tc.setOrphansAlwaysImportant(true)
    tc.setNeverAlignPatterns(['^//'])
    tc.setSkewTolerance(7)
    tc.setClosenessMatching(true, 0.75)
    tc.setFileFormat('left', 'Python')
    tc.setFileFormat('right', 'same-as-left')
    const snapshot = tc.getConfig()

    const fresh = makeTC()
    fresh.applyConfig(snapshot)
    expect(fresh.getWhitespaceMode()).toBe('trailing')
    expect(fresh.syntaxHighlighting).toBe(false)
    expect(fresh._opts.orphansAlwaysImportant).toBe(true)
    expect(fresh.getNeverAlignPatterns()).toEqual(['^//'])
    expect(fresh.getSkewTolerance()).toBe(7)
    expect(fresh._opts.useClosenessMatching).toBe(true)
    expect(fresh._opts.closenessThreshold).toBe(0.75)
    expect(fresh.getFileFormats()).toEqual({ left: 'Python', right: 'same-as-left' })
  })
})

// ── Virtual scrolling is unaffected by the alignment pass ───────────────────

describe('virtual scrolling still renders only visible rows', () => {
  it('20000 lines with alignment options on renders a bounded set', () => {
    const tc = makeTC()
    tc._rowHeight = 20
    tc._contentLeft.getBoundingClientRect = () => ({ height: 600 })
    tc._contentRight.getBoundingClientRect = () => ({ height: 600 })
    Object.defineProperty(tc._contentLeft, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(tc._contentRight, 'clientHeight', { value: 600, configurable: true })
    tc.setSkewTolerance(3)
    tc.setClosenessMatching(true, 0.4)

    const left = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const right = Array.from({ length: 20000 }, (_, i) => (i % 500 === 0 ? `line ${i}!` : `line ${i}`)).join('\n') + '\n'
    load(tc, left, right)

    expect(tc._diffResult.length).toBeGreaterThanOrEqual(20000)
    const rendered = tc._contentLeft.querySelectorAll('.diff-line').length
    expect(rendered).toBeLessThan(300)
  })
})
