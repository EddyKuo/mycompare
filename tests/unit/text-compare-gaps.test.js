/**
 * @vitest-environment jsdom
 *
 * Gap-matrix v2 items owned by the text-compare view:
 *   P1-19 — Compare Selection to Clipboard
 *   P2-30 — Manual (user-placed) ignore marks
 *   P2-25 — Unified diff / patch parsing and viewing
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

const {
  TextCompare,
  parseUnifiedDiff,
  buildPatchSides,
  UnifiedDiffParseError,
} = await import('../../src/renderer/src/views/text-compare.js')

/**
 * A TextCompare wired to real (detached) DOM panes so selection and virtual
 * scrolling behave the way they do in the app, without mount()'s index.html
 * dependency.
 * @returns {InstanceType<typeof TextCompare>}
 */
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

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

afterEach(() => {
  window.getSelection()?.removeAllRanges()
})

// ═══════════════════════════════════════════════════════════════════════════
// P2-25 — unified diff parser
// ═══════════════════════════════════════════════════════════════════════════

const SIMPLE_PATCH = [
  '--- a/foo.txt\t2026-01-01',
  '+++ b/foo.txt\t2026-01-02',
  '@@ -1,3 +1,4 @@',
  ' alpha',
  '-beta',
  '+BETA',
  '+gamma',
  ' delta',
  '',
].join('\n')

describe('parseUnifiedDiff — well-formed input', () => {
  it('parses paths, hunk header and line markers', () => {
    const files = parseUnifiedDiff(SIMPLE_PATCH)
    expect(files).toHaveLength(1)
    expect(files[0].oldPath).toBe('a/foo.txt')
    expect(files[0].newPath).toBe('b/foo.txt')
    expect(files[0].hunks).toHaveLength(1)

    const h = files[0].hunks[0]
    expect(h.oldStart).toBe(1)
    expect(h.oldCount).toBe(3)
    expect(h.newStart).toBe(1)
    expect(h.newCount).toBe(4)
    expect(h.lines.map(l => l.type)).toEqual([' ', '-', '+', '+', ' '])
    expect(h.lines.map(l => l.text)).toEqual(['alpha', 'beta', 'BETA', 'gamma', 'delta'])
  })

  it('treats an omitted count as 1 (`@@ -3 +3 @@`)', () => {
    const files = parseUnifiedDiff('@@ -3 +3 @@\n-old\n+new\n')
    // Both counts are 1, so one delete plus one insert exactly fills the hunk.
    const h = files[0].hunks[0]
    expect(h.oldCount).toBe(1)
    expect(h.newCount).toBe(1)
    expect(h.lines).toHaveLength(2)
  })

  it('parses multiple files, each with multiple hunks', () => {
    const patch = [
      'diff --git a/one.txt b/one.txt',
      'index 1111111..2222222 100644',
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      '@@ -10,2 +10,2 @@ inside func()',
      ' keep',
      '-b',
      '+B',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -5,0 +6,1 @@',
      '+added',
      '',
    ].join('\n')
    const files = parseUnifiedDiff(patch)
    expect(files.map(f => f.oldPath)).toEqual(['a/one.txt', 'a/two.txt'])
    expect(files[0].hunks).toHaveLength(2)
    expect(files[0].hunks[1].section).toBe(' inside func()')
    expect(files[1].hunks[0].lines).toEqual([{ type: '+', text: 'added', noNewline: false }])
  })

  it('attaches "\\ No newline at end of file" to the preceding line', () => {
    const patch = [
      '--- a', '+++ b',
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const h = parseUnifiedDiff(patch)[0].hunks[0]
    expect(h.lines[0]).toEqual({ type: '-', text: 'old', noNewline: true })
    expect(h.lines[1]).toEqual({ type: '+', text: 'new', noNewline: true })
  })

  it('accepts an empty context line written without its leading space', () => {
    const patch = ['@@ -1,3 +1,3 @@', ' a', '', '-c', '+C', ''].join('\n')
    const h = parseUnifiedDiff(patch)[0].hunks[0]
    expect(h.lines.map(l => l.type)).toEqual([' ', ' ', '-', '+'])
    expect(h.lines[1].text).toBe('')
  })

  it('accepts a bare hunk with no file header', () => {
    const files = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-x\n+y\n')
    expect(files).toHaveLength(1)
    expect(files[0].oldPath).toBe('(old)')
  })

  it('handles CRLF line endings', () => {
    const files = parseUnifiedDiff(SIMPLE_PATCH.replace(/\n/g, '\r\n'))
    expect(files[0].hunks[0].lines).toHaveLength(5)
  })
})

describe('parseUnifiedDiff — malformed input must throw, never guess', () => {
  /**
   * @param {string} input
   * @param {RegExp} match
   */
  const rejects = (input, match) => {
    expect(() => parseUnifiedDiff(input)).toThrow(UnifiedDiffParseError)
    expect(() => parseUnifiedDiff(input)).toThrow(match)
  }

  it('rejects a truncated hunk (input ends mid-hunk)', () => {
    rejects('@@ -1,3 +1,3 @@\n a\n-b\n', /截斷/)
  })

  it('rejects a hunk with fewer body lines than declared, followed by a new hunk', () => {
    // The second @@ appears while the first hunk still owes 2 lines.
    rejects('@@ -1,3 +1,3 @@\n a\n@@ -9,1 +9,1 @@\n-x\n+y\n', /無法解析的行/)
  })

  it('rejects more context lines than the header declares', () => {
    rejects('@@ -1,2 +1,2 @@\n a\n b\n c\n', /超過標頭宣告/)
  })

  it('rejects more deletions than the declared old count', () => {
    rejects('@@ -1,1 +1,2 @@\n-a\n-b\n+c\n+d\n', /刪除行數超過/)
  })

  it('rejects more insertions than the declared new count', () => {
    // New-side budget runs out while the old side still owes lines.
    rejects('@@ -1,2 +1,1 @@\n+c\n+d\n-a\n-b\n', /新增行數超過/)
  })

  it('rejects body lines trailing a hunk whose counts are already satisfied', () => {
    rejects('@@ -1,2 +1,1 @@\n-a\n-b\n+c\n+d\n', /超過標頭宣告/)
  })

  it('rejects a malformed @@ header', () => {
    rejects('@@ -1,3 +x,3 @@\n a\n', /無法解析的 hunk 標頭/)
    rejects('@@@ -1,3 +1,3 @@\n a\n', /無法解析的 hunk 標頭/)
    rejects('@@ -1,3 1,3 @@\n a\n', /無法解析的 hunk 標頭/)
  })

  it('rejects a `---` header with no matching `+++`', () => {
    rejects('--- a/foo.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n', /缺少對應的 `\+\+\+`/)
  })

  it('rejects input containing no hunk at all', () => {
    rejects('just some prose\nnothing to see here\n', /找不到任何 unified diff hunk/)
    rejects('', /找不到任何 unified diff hunk/)
  })

  it('rejects a "\\ No newline" marker before any hunk line', () => {
    rejects('@@ -1,1 +1,1 @@\n\\ No newline at end of file\n-a\n+b\n', /沒有任何 hunk 行/)
  })

  it('rejects non-string input', () => {
    rejects(/** @type {never} */ (null), /必須是字串/)
    rejects(/** @type {never} */ (undefined), /必須是字串/)
  })

  it('reports the offending line number', () => {
    try {
      parseUnifiedDiff('--- a\n+++ b\n@@ -1,2 +1,2 @@\n a\n b\n c\n')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UnifiedDiffParseError)
      expect(err.lineNumber).toBe(6)
      expect(err.message).toContain('第 6 行')
    }
  })
})

describe('buildPatchSides', () => {
  it('emits context on both sides, deletions only left, insertions only right', () => {
    const { oldText, newText } = buildPatchSides(parseUnifiedDiff(SIMPLE_PATCH))
    const left = oldText.split('\n')
    const right = newText.split('\n')

    expect(left).toContain('beta')
    expect(right).not.toContain('beta')
    expect(right).toContain('BETA')
    expect(right).toContain('gamma')
    expect(left).not.toContain('gamma')
    // Context and headers must be byte-identical so they diff as equal.
    expect(left).toContain('alpha')
    expect(right).toContain('alpha')
    expect(left[0]).toBe(right[0])
  })

  it('keeps per-file and per-hunk headers identical on both sides', () => {
    const patch = [
      '--- a/x', '+++ b/x', '@@ -1,1 +1,1 @@', '-a', '+A',
      '--- a/y', '+++ b/y', '@@ -2,1 +2,1 @@', '-b', '+B', '',
    ].join('\n')
    const { oldText, newText } = buildPatchSides(parseUnifiedDiff(patch))
    const headers = (s) => s.split('\n').filter(l => l.startsWith('═══') || l.startsWith('@@'))
    expect(headers(oldText)).toEqual(headers(newText))
    expect(headers(oldText)).toHaveLength(4)
  })
})

describe('TextCompare.openPatch / openPatchFile', () => {
  it('loads a patch into the two panes', () => {
    const tc = makeTC()
    const files = tc.openPatch(SIMPLE_PATCH, 'foo.patch')
    expect(files).toHaveLength(1)
    expect(tc._leftPath).toBe('patch://foo.patch（原始）')
    expect(tc._rightPath).toBe('patch://foo.patch（套用後）')
    expect(tc.getContent('left')).toContain('beta')
    expect(tc.getContent('right')).toContain('BETA')
    expect(tc._diffBlocks.length).toBeGreaterThan(0)
  })

  it('never watches the synthetic patch:// paths', () => {
    const tc = makeTC()
    tc.openPatch(SIMPLE_PATCH, 'foo.patch')
    expect(electronAPI.watchFile).not.toHaveBeenCalled()
  })

  it('propagates parse errors from openPatch', () => {
    const tc = makeTC()
    expect(() => tc.openPatch('not a patch')).toThrow(UnifiedDiffParseError)
  })

  it('openPatchFile surfaces a parse failure instead of swallowing it', async () => {
    const tc = makeTC()
    electronAPI.openFile.mockResolvedValue({ path: 'bad.patch', content: 'nope' })
    const ok = await tc.openPatchFile()
    expect(ok).toBe(false)
    expect(document.querySelector('.mc-toast--error')?.textContent).toMatch(/Patch 格式錯誤/)
    // The panes must be left untouched by a failed open.
    expect(tc._leftPath).toBe('')
  })

  it('openPatchFile returns false when the dialog is cancelled', async () => {
    const tc = makeTC()
    electronAPI.openFile.mockResolvedValue(null)
    expect(await tc.openPatchFile()).toBe(false)
  })

  it('openPatchFile loads a valid patch and reports the hunk count', async () => {
    const tc = makeTC()
    electronAPI.openFile.mockResolvedValue({ path: 'ok.patch', content: SIMPLE_PATCH })
    expect(await tc.openPatchFile()).toBe(true)
    expect(document.querySelector('.mc-toast--success')?.textContent).toMatch(/1 個檔案、1 個 hunk/)
  })

  it('renders only the visible rows for a patch with tens of thousands of lines', () => {
    const tc = makeTC()
    const body = []
    for (let i = 0; i < 30000; i++) body.push(i % 3 === 0 ? `-line ${i}` : ` line ${i}`)
    const oldCount = 30000
    const newCount = 30000 - body.filter(l => l.startsWith('-')).length
    const patch = `@@ -1,${oldCount} +1,${newCount} @@\n${body.join('\n')}\n`

    tc.openPatch(patch, 'big.patch')

    expect(tc._rows.length).toBeGreaterThan(20000)
    const renderedLeft = tc._contentLeft.querySelectorAll('.diff-line').length
    const renderedRight = tc._contentRight.querySelectorAll('.diff-line').length
    // Viewport falls back to 600px → ~30 rows + overscan; anything near the
    // row count would mean virtual scrolling regressed.
    expect(renderedLeft).toBeLessThan(100)
    expect(renderedRight).toBeLessThan(100)
    expect(renderedLeft).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// P2-30 — manual ignore
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {InstanceType<typeof TextCompare>} tc
 */
function loadThreeLineDiff(tc) {
  tc.setLeft('L', 'a\nb\nc\n')
  tc.setRight('R', 'A\nB\nC\n')
}

describe('TextCompare manual ignore (P2-30)', () => {
  it('marks lines and renders them as unimportant', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    expect(tc._diffResult.some(dl => dl.unimportant)).toBe(false)

    expect(tc.markIgnoredLines('left', [2])).toBe(1)
    const line2 = tc._diffResult.find(dl => dl.leftLine === 2)
    expect(line2.unimportant).toBe(true)
    expect(line2.manualIgnored).toBe(true)
    expect(tc._diffResult.find(dl => dl.leftLine === 1).manualIgnored).toBe(false)
  })

  it('applies the manual-ignored CSS class to the rendered row', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    tc.markIgnoredLines('left', [2])
    const el = tc._contentLeft.querySelector('.diff-line.manual-ignored')
    expect(el).not.toBeNull()
    expect(el.classList.contains('unimportant')).toBe(true)
  })

  it('matches a mark placed on the right side too', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    tc.markIgnoredLines('right', [3])
    expect(tc._diffResult.find(dl => dl.rightLine === 3).manualIgnored).toBe(true)
  })

  it('downgrades manually ignored lines to equal when Ignore Unimportant is on', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    tc.markIgnoredLines('left', [1, 2, 3])
    tc.markIgnoredLines('right', [1, 2, 3])
    expect(tc._diffBlocks.length).toBeGreaterThan(0)

    tc.setIgnoreUnimportant(true)
    expect(tc._diffResult.every(dl => dl.type === 'equal')).toBe(true)
    expect(tc._diffBlocks).toHaveLength(0)
  })

  it('unmarks and clears', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    tc.markIgnoredLines('left', [1, 2])
    expect(tc.unmarkIgnoredLines('left', [1, 99])).toBe(1)
    expect(tc.getManualIgnores()).toEqual({ left: [2], right: [] })

    tc.markIgnoredLines('right', [3])
    expect(tc.clearManualIgnores()).toBe(2)
    expect(tc.getManualIgnores()).toEqual({ left: [], right: [] })
    expect(tc.clearManualIgnores()).toBe(0)
  })

  it('toggle marks a mixed run, then unmarks it once fully marked', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    tc.markIgnoredLines('left', [1])
    expect(tc.toggleIgnoredLines('left', [1, 2])).toBe('marked')
    expect(tc.getManualIgnores().left).toEqual([1, 2])
    expect(tc.toggleIgnoredLines('left', [1, 2])).toBe('unmarked')
    expect(tc.getManualIgnores().left).toEqual([])
    expect(tc.toggleIgnoredLines('left', [])).toBe('noop')
  })

  it('ignores non-numeric / non-positive line numbers', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    tc.markIgnoredLines('left', /** @type {never} */ (['x', null, 0, -3, NaN, 2]))
    expect(tc.getManualIgnores().left).toEqual([2])
  })

  it('survives a re-diff (marks are keyed by line number, not row index)', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    tc.markIgnoredLines('left', [2])
    tc.setAlgorithm('patience')
    expect(tc._diffResult.find(dl => dl.leftLine === 2).manualIgnored).toBe(true)
  })

  it('describeManualIgnores collapses consecutive runs into ranges', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    expect(tc.describeManualIgnores()).toBe('目前沒有手動忽略的行')
    tc.markIgnoredLines('left', [3, 7, 8, 9, 10, 12])
    tc.markIgnoredLines('right', [1])
    expect(tc.describeManualIgnores()).toBe('左側：3, 7–10, 12\n右側：1')
  })

  it('round-trips through getConfig / applyConfig', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    tc.markIgnoredLines('left', [2])
    tc.markIgnoredLines('right', [3])
    const cfg = tc.getConfig()

    const other = makeTC()
    loadThreeLineDiff(other)
    other.applyConfig(cfg)
    expect(other.getManualIgnores()).toEqual({ left: [2], right: [3] })
    expect(other._diffResult.find(dl => dl.leftLine === 2).manualIgnored).toBe(true)
  })

  it('applyConfig without the manual keys leaves existing marks alone', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    tc.markIgnoredLines('left', [2])
    tc.applyConfig({ __view: 'text', algorithm: 'patience' })
    expect(tc.getManualIgnores().left).toEqual([2])
    expect(tc._opts.algorithm).toBe('patience')
  })

  it('toggleIgnoreSelection warns instead of failing silently with no selection', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    expect(tc.toggleIgnoreSelection()).toBe(false)
    expect(document.querySelector('.mc-toast--warn')).not.toBeNull()
  })

  it('_selectedLineNumbers reads line numbers out of the selected rows', () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    const rows = tc._contentLeft.querySelectorAll('.diff-line[data-left-line]')
    expect(rows.length).toBeGreaterThan(0)

    const range = document.createRange()
    range.setStartBefore(rows[0])
    range.setEndAfter(rows[rows.length - 1])
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)

    expect(tc._selectedLineNumbers('left')).toEqual([1, 2, 3])
    expect(tc._selectionSide()).toBe('left')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// P1-19 — compare selection to clipboard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Force a non-collapsed selection over one pane.
 * @param {InstanceType<typeof TextCompare>} tc
 * @param {'left'|'right'} side
 */
function selectPane(tc, side) {
  const pane = side === 'right' ? tc._contentRight : tc._contentLeft
  const range = document.createRange()
  range.selectNodeContents(pane)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
}

describe('TextCompare.compareSelectionToClipboard (P1-19)', () => {
  it('puts the selection and the clipboard into opposite panes', async () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    selectPane(tc, 'left')
    clipboard.readText.mockResolvedValue('clip-1\nclip-2')

    expect(await tc.compareSelectionToClipboard('left')).toBe(true)
    expect(tc._leftPath).toBe('（選取內容）')
    expect(tc._rightPath).toBe('（剪貼簿）')
    expect(tc.getContent('right')).toBe('clip-1\nclip-2')
    expect(tc.getContent('left').length).toBeGreaterThan(0)
  })

  it('keeps a right-pane selection on the right', async () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    selectPane(tc, 'right')
    clipboard.readText.mockResolvedValue('clip')

    expect(await tc.compareSelectionToClipboard('right')).toBe(true)
    expect(tc._leftPath).toBe('（剪貼簿）')
    expect(tc._rightPath).toBe('（選取內容）')
    expect(tc.getContent('left')).toBe('clip')
  })

  it('warns when nothing is selected', async () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    expect(await tc.compareSelectionToClipboard()).toBe(false)
    expect(clipboard.readText).not.toHaveBeenCalled()
    expect(document.querySelector('.mc-toast--warn')).not.toBeNull()
  })

  it('reports a clipboard read failure rather than swallowing it', async () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    selectPane(tc, 'left')
    clipboard.readText.mockRejectedValue(new Error('denied'))

    expect(await tc.compareSelectionToClipboard('left')).toBe(false)
    expect(document.querySelector('.mc-toast--error')?.textContent).toMatch(/無法讀取剪貼簿.*denied/)
    // Panes untouched.
    expect(tc._leftPath).toBe('L')
  })

  it('warns on an empty clipboard', async () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    selectPane(tc, 'left')
    clipboard.readText.mockResolvedValue('')

    expect(await tc.compareSelectionToClipboard('left')).toBe(false)
    expect(document.querySelector('.mc-toast--warn')?.textContent).toMatch(/剪貼簿是空的/)
    expect(tc._leftPath).toBe('L')
  })

  it('drops stale manual ignore marks when new content is loaded', async () => {
    const tc = makeTC()
    loadThreeLineDiff(tc)
    tc.markIgnoredLines('left', [2])
    selectPane(tc, 'left')
    clipboard.readText.mockResolvedValue('clip')

    await tc.compareSelectionToClipboard('left')
    expect(tc.getManualIgnores()).toEqual({ left: [], right: [] })
  })
})
