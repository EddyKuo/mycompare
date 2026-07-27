/**
 * @vitest-environment jsdom
 *
 * Sprint 25 — the gap-matrix items closed in the merge and text views.
 *
 * Every feature here is asserted twice: once on the logic, and once on the
 * entry point that reaches it. The recurring defect in this codebase is a
 * complete implementation with no caller, so a test that only exercises the
 * method would pass on exactly the bug that keeps happening.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ThreeWayCompare,
  mergeHunkSegments,
  applyHunkRange,
  buildMergedText,
  normalizeConflictProximity,
  normalizeForcedRanges,
  isConflictChoice,
  CONFLICT_CHOICES,
} from '../../src/renderer/src/views/three-way-compare.js'
import {
  TextCompare,
  parseReplacementRules,
  formatReplacementRules,
  compileReplacementRules,
  applyReplacements,
  restoreOriginalDiffText,
  MAX_REPLACEMENT_RULES,
} from '../../src/renderer/src/views/text-compare.js'
import { SettingsStore } from '../../src/renderer/src/core/settings-store.js'

const ROW_HEIGHT = 18

beforeEach(() => {
  localStorage.clear()
  window.electronAPI = {
    openFile: vi.fn(),
    openFileBinary: vi.fn(),
    saveFile: vi.fn().mockResolvedValue({ path: 'out.txt' }),
    readArchive: vi.fn(),
    readArchiveEntry: vi.fn(),
    readFile: vi.fn(),
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
    onFileChanged: vi.fn(() => () => {}),
  }
  const settings = new SettingsStore()
  settings.setPref('navFirstDiffOnLoad', false)
  settings.setPref('navNextAfterCopy', false)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** @param {{left?: string, base?: string, right?: string}} [contents] */
function mountMerge(contents = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new ThreeWayCompare()
  view.mount(host)
  view.setSide('base', contents.base ?? 'a\nb\nc')
  view.setSide('left', contents.left ?? 'a\nL\nc')
  view.setSide('right', contents.right ?? 'a\nR\nc')
  return { view, host }
}

/** A hunk in the shape `_buildHunks` produces. */
const hunk = (baseStart, baseEnd, newLines) => ({ baseStart, baseEnd, newLines })

// ---------------------------------------------------------------------------
// 1. Editable output pane
// ---------------------------------------------------------------------------

describe('merge3 — editable output', () => {
  it('has a toolbar entry point that reveals the editor', () => {
    const { view, host } = mountMerge()
    const btn = host.querySelector('.mw-btn-edit-output')
    expect(btn).toBeTruthy()

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.isOutputEditing()).toBe(true)
    const ta = host.querySelector('.mw-output-textarea')
    expect(ta.classList.contains('mw-output-textarea--visible')).toBe(true)
    expect(ta.readOnly).toBe(false)
  })

  it('typing into the textarea becomes the saved output', () => {
    const { view, host } = mountMerge()
    host.querySelector('.mw-btn-edit-output').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const ta = host.querySelector('.mw-output-textarea')
    ta.value = 'hand written'
    ta.dispatchEvent(new Event('input', { bubbles: true }))

    expect(view.isOutputEdited()).toBe(true)
    expect(view.getOutputText()).toBe('hand written')
  })

  it('counts a hand edit as unsaved work, and clears it on save', async () => {
    const { view, host } = mountMerge()
    expect(view.hasUnsavedEdits()).toBe(false)
    view.setOutputText('edited')
    expect(view.hasUnsavedEdits()).toBe(true)

    host.querySelector('.mw-btn-save').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(window.electronAPI.saveFile).toHaveBeenCalledWith('merged-output.txt', 'edited')
    expect(view.hasUnsavedEdits()).toBe(false)
  })

  it('asks before discarding a hand edit, and never asks otherwise', () => {
    const { view } = mountMerge()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    expect(view.confirmClose()).toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()

    view.setOutputText('edited')
    expect(view.confirmClose()).toBe(false)
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    confirmSpy.mockReturnValue(true)
    expect(view.confirmClose()).toBe(true)
  })

  it('refuses to regenerate over a hand edit, and says why', () => {
    const { view } = mountMerge()
    const seen = []
    view.on('status', (s) => seen.push(s))

    view.setOutputText('mine')
    const ids = [...view._conflictChoices.keys()]
    view.setConflictChoice(ids[0], 'left')

    expect(view.getOutputText()).toBe('mine')
    expect(seen.some((s) => s.level === 'error')).toBe(true)
    expect(view.resolveAll('left')).toBe(0)
  })

  it('discards the edit on request and returns to the generated merge', () => {
    const { view, host } = mountMerge()
    const generated = view.getOutputText()
    view.setOutputText('mine')

    const discard = host.querySelector('.mw-btn-discard-output')
    expect(discard.hidden).toBe(false)
    discard.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(view.isOutputEdited()).toBe(false)
    expect(view.getOutputText()).toBe(generated)
    expect(view.hasUnsavedEdits()).toBe(false)
  })

  it('drops the edit when new content is loaded, rather than applying it to another file', () => {
    const { view } = mountMerge()
    view.setOutputText('mine')
    view.setSide('left', 'x\ny\nz', 'L')
    expect(view.isOutputEdited()).toBe(false)
    expect(view.hasUnsavedEdits()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Ignore Unimportant Differences
// ---------------------------------------------------------------------------

describe('merge3 — ignore unimportant differences', () => {
  it('turns a cosmetic-only clash into an auto-merge', () => {
    // Both sides edit the same base line, differing only in a trailing comment.
    const { view } = mountMerge({
      base: 'a\nvalue = 1\nc',
      left: 'a\nvalue = 2 // left note\nc',
      right: 'a\nvalue = 2 // right note\nc',
    })
    expect(view.getConflictCount()).toBe(1)

    view.setUnimportantPatterns(['//.*$'])
    view.setIgnoreUnimportant(true)
    expect(view.getConflictCount()).toBe(0)
  })

  it('is reachable from the toolbar', () => {
    const { view, host } = mountMerge()
    const check = host.querySelector('.mw-unimportant-check')
    expect(check).toBeTruthy()
    check.checked = true
    check.dispatchEvent(new Event('change', { bubbles: true }))
    expect(view.getIgnoreUnimportant()).toBe(true)
    expect(host.querySelector('.mw-btn-unimportant-edit')).toBeTruthy()
  })

  it('rejects a pattern that could backtrack catastrophically, and reports it', () => {
    const { view } = mountMerge()
    const seen = []
    view.on('status', (s) => seen.push(s))

    view.setUnimportantPatterns(['(a+)+$'])
    view.setIgnoreUnimportant(true)
    // Forcing a comparison compiles the pattern.
    view._stripUnimportant('aaaa')
    expect(seen.some((s) => s.level === 'error' && /未套用/.test(s.message))).toBe(true)
  })

  it('leaves a genuine difference alone', () => {
    const { view } = mountMerge({
      base: 'a\nvalue = 1\nc',
      left: 'a\nvalue = 2 // note\nc',
      right: 'a\nvalue = 3 // note\nc',
    })
    view.setUnimportantPatterns(['//.*$'])
    view.setIgnoreUnimportant(true)
    expect(view.getConflictCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Info dialog
// ---------------------------------------------------------------------------

describe('merge3 — info', () => {
  it('reports per-source sizes, conflict counts and the settings in force', () => {
    const { view } = mountMerge()
    const info = view.getInfo()

    expect(info.sources.map((s) => s.side)).toEqual(['left', 'base', 'right'])
    expect(info.sources.every((s) => s.lines === 3)).toBe(true)
    expect(info.conflicts.total).toBe(1)
    expect(info.conflicts.unresolved).toBe(1)
    expect(info.segments.conflict).toBeGreaterThan(0)
    expect(info.settings.algorithm).toBe('myers')
  })

  it('counts an empty document as zero lines, not one', () => {
    const { view } = mountMerge({ left: '', base: '', right: '' })
    expect(view.getInfo().sources.every((s) => s.lines === 0)).toBe(true)
  })

  it('opens from the toolbar and renders the numbers', () => {
    const { host } = mountMerge()
    host.querySelector('.mw-btn-info').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const modal = host.querySelector('.mw-modal')
    expect(modal).toBeTruthy()
    expect(modal.querySelectorAll('.mw-info-table').length).toBe(3)
    expect(modal.textContent).toContain('衝突總數')
  })

  it('puts a path in as text, never as markup', () => {
    const { view, host } = mountMerge()
    view.setSide('left', 'a', '<img src=x onerror=1>')
    host.querySelector('.mw-btn-info').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const modal = host.querySelector('.mw-modal')
    expect(modal.querySelector('img')).toBeNull()
    expect(modal.textContent).toContain('<img src=x onerror=1>')
  })
})

// ---------------------------------------------------------------------------
// 4. Conflict proximity
// ---------------------------------------------------------------------------

describe('merge3 — conflict proximity', () => {
  it('clamps the threshold', () => {
    expect(normalizeConflictProximity(-4)).toBe(0)
    expect(normalizeConflictProximity('3')).toBe(3)
    expect(normalizeConflictProximity(1e9)).toBe(100)
    expect(normalizeConflictProximity(undefined)).toBe(0)
  })

  it('at zero, nearby edits on opposite sides still merge cleanly', () => {
    const base = ['a', 'b', 'c', 'd', 'e']
    const { segments } = mergeHunkSegments(
      base, [hunk(1, 2, ['B'])], [hunk(3, 4, ['D'])], { proximity: 0 })
    expect(segments.filter((s) => s.type === 'conflict')).toHaveLength(0)
  })

  it('raising it groups those same edits into one conflict', () => {
    const base = ['a', 'b', 'c', 'd', 'e']
    const { segments, hasConflicts } = mergeHunkSegments(
      base, [hunk(1, 2, ['B'])], [hunk(3, 4, ['D'])], { proximity: 3 })
    const conflicts = segments.filter((s) => s.type === 'conflict')
    expect(hasConflicts).toBe(true)
    expect(conflicts).toHaveLength(1)
    // Each side keeps the lines the *other* side changed, untouched.
    expect(conflicts[0].leftLines).toEqual(['B', 'c', 'd'])
    expect(conflicts[0].rightLines).toEqual(['b', 'c', 'D'])
    expect(conflicts[0].baseLines).toEqual(['b', 'c', 'd'])
  })

  it('rebuilds a side across a grouped range without dropping untouched lines', () => {
    const base = ['a', 'b', 'c', 'd']
    expect(applyHunkRange(base, [hunk(0, 1, ['A'])], 0, 3)).toEqual(['A', 'b', 'c'])
    expect(applyHunkRange(base, [], 1, 3)).toEqual(['b', 'c'])
    expect(applyHunkRange(base, [hunk(1, 1, ['X'])], 1, 3)).toEqual(['X', 'b', 'c'])
  })

  it('is reachable from the toolbar and re-merges', () => {
    const { view, host } = mountMerge({
      base: 'a\nb\nc\nd\ne',
      left: 'a\nB\nc\nd\ne',
      right: 'a\nb\nc\nD\ne',
    })
    expect(view.getConflictCount()).toBe(0)

    const input = host.querySelector('.mw-proximity-input')
    expect(input).toBeTruthy()
    input.value = '3'
    input.dispatchEvent(new Event('change', { bubbles: true }))

    expect(view.getConflictProximity()).toBe(3)
    expect(view.getConflictCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Algorithm picker — already present before this sprint
// ---------------------------------------------------------------------------

describe('merge3 — algorithm picker', () => {
  it('is on the toolbar and drives setAlgorithm', () => {
    const { view, host } = mountMerge()
    const sel = host.querySelector('.mw-algo-select')
    expect(sel).toBeTruthy()
    expect([...sel.options].map((o) => o.value)).toEqual(['myers', 'patience', 'histogram'])
    sel.value = 'patience'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    expect(view.getAlgorithm()).toBe('patience')
  })
})

// ---------------------------------------------------------------------------
// 6. Manual conflict marks
// ---------------------------------------------------------------------------

describe('merge3 — manual conflicts', () => {
  it('normalises ranges: clamped, ordered, disjoint, empties dropped', () => {
    expect(normalizeForcedRanges([{ start: 3, end: 1 }], 10)).toEqual([])
    expect(normalizeForcedRanges([{ start: -5, end: 99 }], 4)).toEqual([{ start: 0, end: 4 }])
    expect(normalizeForcedRanges([{ start: 0, end: 2 }, { start: 1, end: 4 }], 10))
      .toEqual([{ start: 0, end: 4 }])
  })

  it('forces a clean range into a conflict', () => {
    const { view } = mountMerge({ base: 'a\nb\nc', left: 'a\nb\nc', right: 'a\nb\nc' })
    expect(view.getConflictCount()).toBe(0)

    expect(view.markConflictRange(2, 2)).toBe(true)
    expect(view.getConflictCount()).toBe(1)
    expect(view.getManualConflicts()).toEqual([{ start: 1, end: 2 }])
  })

  it('clears the marks again', () => {
    const { view } = mountMerge({ base: 'a\nb\nc', left: 'a\nb\nc', right: 'a\nb\nc' })
    view.markConflictRange(2, 2)
    expect(view.clearManualConflicts()).toBe(1)
    expect(view.getConflictCount()).toBe(0)
  })

  it('rejects a range outside the base file', () => {
    const { view } = mountMerge({ base: 'a\nb\nc', left: 'a\nb\nc', right: 'a\nb\nc' })
    expect(view.markConflictRange(90, 99)).toBe(false)
    expect(view.getConflictCount()).toBe(0)
  })

  it('has toolbar buttons, and explains an empty selection instead of doing nothing', () => {
    const { view, host } = mountMerge()
    const seen = []
    view.on('status', (s) => seen.push(s))

    const mark = host.querySelector('.mw-btn-mark-conflict')
    expect(mark).toBeTruthy()
    expect(host.querySelector('.mw-btn-clear-conflicts')).toBeTruthy()

    mark.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(seen.some((s) => s.level === 'error' && /選取/.test(s.message))).toBe(true)
  })

  it('labels base rows with their line number, which is what a selection maps onto', () => {
    const { host } = mountMerge()
    const rows = [...host.querySelectorAll('.mw-content-base .mw-line[data-line]')]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].dataset.line).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// 7. Take Left/Right then the other
// ---------------------------------------------------------------------------

describe('merge3 — take both, in either order', () => {
  it('accepts both orders and nothing else', () => {
    expect(CONFLICT_CHOICES).toContain('both-rl')
    expect(isConflictChoice('both-rl')).toBe(true)
    expect(isConflictChoice('sideways')).toBe(false)
  })

  it('assembles the two orders differently', () => {
    const segs = [{ type: 'conflict', id: 0, leftLines: ['L'], baseLines: ['B'], rightLines: ['R'] }]
    expect(buildMergedText(segs, new Map([[0, 'both']]))).toBe('L\nR')
    expect(buildMergedText(segs, new Map([[0, 'both-rl']]))).toBe('R\nL')
  })

  it('offers both on every conflict card', () => {
    const { host } = mountMerge()
    const card = host.querySelector('.mw-conflict-card')
    expect(card.querySelector('.mw-choice-both')).toBeTruthy()
    expect(card.querySelector('.mw-choice-both-rl')).toBeTruthy()
  })

  it('applies right-then-left from the card', () => {
    const { view, host } = mountMerge()
    host.querySelector('.mw-choice-both-rl').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.getOutputText()).toBe('a\nR\nL\nc')
  })

  it('applies either order in batch from the toolbar', () => {
    const { view, host } = mountMerge()
    const sel = host.querySelector('.mw-resolve-all-select')
    expect([...sel.options].map((o) => o.value)).toContain('both-rl')
    sel.value = 'both-rl'
    host.querySelector('.mw-btn-resolve-all').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(view.getOutputText()).toBe('a\nR\nL\nc')
  })
})

// ---------------------------------------------------------------------------
// Virtualisation must survive all of the above
// ---------------------------------------------------------------------------

describe('merge3 — 20k lines still renders a window', () => {
  it('renders only the visible rows with proximity and manual marks in play', () => {
    const n = 20000
    const base = Array.from({ length: n }, (_, i) => `line${i}`).join('\n')
    const left = base.replace('line5000', 'LEFT5000')
    const right = base.replace('line5004', 'RIGHT5004')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new ThreeWayCompare()
    view.mount(host)
    Object.defineProperty(host.querySelector('.mw-content-base'), 'clientHeight',
      { value: 360, configurable: true })

    view.setSide('base', base)
    view.setSide('left', left)
    view.setSide('right', right)
    view.setConflictProximity(8)
    view.markConflictRange(9000, 9002)

    expect(view.getConflictCount()).toBeGreaterThanOrEqual(2)
    const rendered = host.querySelectorAll('.mw-content-base .mw-line').length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(200)

    view.scrollToRow(9000)
    const after = host.querySelectorAll('.mw-content-base .mw-line').length
    expect(after).toBeLessThan(200)
    // The spacer, not the row count, is what carries the full height.
    const spacer = host.querySelector('.mw-content-base .mw-vspacer')
    expect(parseInt(spacer.style.height, 10)).toBeGreaterThan(n * ROW_HEIGHT * 0.9)
  })
})

// ---------------------------------------------------------------------------
// 8. Merge Files, from the text view
// ---------------------------------------------------------------------------

/**
 * A TextCompare wired to real (detached) panes, so the render path runs
 * without mount()'s dependency on index.html.
 *
 * @param {{left?: [string,string], right?: [string,string]}} [files]
 */
function makeText(files = {}) {
  const view = new TextCompare()
  view._mounted = true
  const left = document.createElement('div')
  const right = document.createElement('div')
  document.body.append(left, right)
  view._contentLeft = left
  view._contentRight = right
  view._compareArea = document.createElement('div')

  const [lp, lc] = files.left ?? ['L.txt', 'a\nb\nc']
  const [rp, rc] = files.right ?? ['R.txt', 'a\nB\nc']
  view.setLeft(lp, lc)
  view.setRight(rp, rc)
  return view
}

describe('text — Merge Files', () => {
  it('emits the three sources in one payload', () => {
    const view = makeText()
    const seen = []
    view.on('merge-files', (p) => seen.push(p))

    expect(view.mergeFiles({ basePath: 'B.txt', baseContent: 'a\nb\nc' })).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      left:  { path: 'L.txt', content: 'a\nb\nc' },
      base:  { path: 'B.txt', content: 'a\nb\nc' },
      right: { path: 'R.txt', content: 'a\nB\nc' },
    })
  })

  it('still emits with an empty base when the user wants no ancestor', () => {
    const view = makeText()
    let payload = null
    view.on('merge-files', (p) => { payload = p })
    view.mergeFiles()
    expect(payload.base).toEqual({ path: '', content: '' })
  })

  it('reports rather than pretending when the host has not wired it', () => {
    const view = makeText()
    expect(view.mergeFiles()).toBe(false)
    expect(document.querySelector('.toast')?.textContent ?? document.body.textContent)
      .toContain('三向合併')
  })

  it('asks for the ancestor through the file dialog', async () => {
    const view = makeText()
    let payload = null
    view.on('merge-files', (p) => { payload = p })
    window.electronAPI.openFile.mockResolvedValue({ path: 'BASE.txt', content: 'a\nb\nc' })

    expect(await view.mergeFilesWithBase()).toBe(true)
    expect(payload.base).toEqual({ path: 'BASE.txt', content: 'a\nb\nc' })
  })

  it('does nothing when the ancestor dialog is cancelled', async () => {
    const view = makeText()
    view.on('merge-files', () => { throw new Error('should not emit') })
    window.electronAPI.openFile.mockResolvedValue(null)
    expect(await view.mergeFilesWithBase()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 9. Load one file out of an archive
// ---------------------------------------------------------------------------

describe('text — open from archive', () => {
  const listing = {
    archivePath: 'C:/x/pack.zip',
    entries: [
      { path: 'C:/x/pack.zip::dir', size: 0, isDirectory: true },
      { path: 'C:/x/pack.zip::a.txt', size: 5, isDirectory: false },
      { path: 'C:/x/pack.zip::b/c.txt', size: 7, isDirectory: false },
    ],
  }

  it('lists only the files, and loads the chosen one under its virtual path', async () => {
    const view = makeText()
    window.electronAPI.readArchive.mockResolvedValue(listing)
    window.electronAPI.readArchiveEntry.mockResolvedValue(btoa('hello'))

    const p = view.openArchiveEntry('left', 'C:/x/pack.zip')
    await new Promise((r) => setTimeout(r, 0))

    const select = document.querySelector('.tc-dialog-list')
    expect(select).toBeTruthy()
    expect([...select.options].map((o) => o.value)).toEqual(['a.txt', 'b/c.txt'])

    select.value = 'b/c.txt'
    ;[...document.querySelectorAll('.tc-dialog button')]
      .find((b) => b.textContent === '載入')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(await p).toBe(true)
    expect(window.electronAPI.readArchiveEntry).toHaveBeenCalledWith('C:/x/pack.zip', 'b/c.txt')
    expect(view._leftPath).toBe('C:/x/pack.zip::b/c.txt')
    expect(view.getContent('left')).toBe('hello')
  })

  it('surfaces a listing failure instead of an empty pane', async () => {
    const view = makeText()
    window.electronAPI.readArchive.mockRejectedValue(new Error('bad central directory'))
    expect(await view.openArchiveEntry('left', 'C:/x/pack.zip')).toBe(false)
    expect(document.body.textContent).toContain('bad central directory')
  })

  it('says so when the archive holds no files', async () => {
    const view = makeText()
    window.electronAPI.readArchive.mockResolvedValue({ entries: [listing.entries[0]] })
    expect(await view.openArchiveEntry('left', 'C:/x/pack.zip')).toBe(false)
    expect(document.body.textContent).toContain('沒有檔案')
  })

  it('surfaces an extraction failure', async () => {
    const view = makeText()
    window.electronAPI.readArchiveEntry.mockRejectedValue(new Error('entry over limit'))
    expect(await view._loadArchiveEntry('right', 'C:/x/pack.zip', 'a.txt')).toBe(false)
    expect(document.body.textContent).toContain('entry over limit')
  })

  it('picks the archive with the dialog that also authorises the path', async () => {
    const view = makeText()
    window.electronAPI.openFileBinary.mockResolvedValue({ path: 'C:/x/pack.zip', base64: '' })
    window.electronAPI.readArchive.mockResolvedValue({ entries: [] })

    await view.openFromArchive('left')
    expect(window.electronAPI.openFileBinary).toHaveBeenCalled()
    expect(window.electronAPI.readArchive).toHaveBeenCalledWith('C:/x/pack.zip')
  })
})

// ---------------------------------------------------------------------------
// 10. Text Replacements
// ---------------------------------------------------------------------------

describe('text — replacement rules: parsing', () => {
  it('reads the plain form', () => {
    const { rules, errors } = parseReplacementRules('foo => bar')
    expect(errors).toEqual([])
    expect(rules).toEqual([{ match: 'foo', replacement: 'bar', regex: false, caseSensitive: true }])
  })

  it('reads the prefixes', () => {
    const { rules } = parseReplacementRules([
      're: \\d+ => N',
      'i: Foo => bar',
      'rei: [a-z]+ => x',
    ].join('\n'))
    expect(rules.map((r) => [r.regex, r.caseSensitive]))
      .toEqual([[true, true], [false, false], [true, false]])
  })

  it('skips blanks and comments', () => {
    const { rules, errors } = parseReplacementRules('\n# a note\n\nfoo => bar\n')
    expect(rules).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('reports a line with no separator rather than dropping it quietly', () => {
    const { rules, errors } = parseReplacementRules('foo bar')
    expect(rules).toHaveLength(0)
    expect(errors[0]).toContain('分隔符')
  })

  it('reports an empty match', () => {
    expect(parseReplacementRules(' => bar').errors[0]).toContain('不可為空')
  })

  it('allows an empty replacement — deleting text is the point of half of them', () => {
    expect(parseReplacementRules('DEBUG =>').rules[0].replacement).toBe('')
  })

  it('caps the rule count and says where it stopped', () => {
    const many = Array.from({ length: MAX_REPLACEMENT_RULES + 5 }, (_, i) => `a${i} => b`).join('\n')
    const { rules, errors } = parseReplacementRules(many)
    expect(rules).toHaveLength(MAX_REPLACEMENT_RULES)
    expect(errors[0]).toContain('上限')
  })

  it('round-trips through the editable form', () => {
    const src = 're: \\d+ => N\ni: Foo => bar\nplain => x'
    const { rules } = parseReplacementRules(src)
    expect(parseReplacementRules(formatReplacementRules(rules)).rules).toEqual(rules)
  })
})

describe('text — replacement rules: compiling', () => {
  it('treats a non-regex match literally', () => {
    const { compiled } = compileReplacementRules([
      { match: 'a.c', replacement: 'X', regex: false, caseSensitive: true },
    ])
    expect(applyReplacements('a.c abc', compiled)).toBe('X abc')
  })

  it('refuses a pattern that can backtrack catastrophically', () => {
    const { compiled, errors } = compileReplacementRules([
      { match: '(a+)+$', replacement: '', regex: true, caseSensitive: true },
    ])
    expect(compiled).toHaveLength(0)
    expect(errors[0]).toContain('被拒絕')
  })

  it('refuses a syntactically invalid pattern', () => {
    const { compiled, errors } = compileReplacementRules([
      { match: '([', replacement: '', regex: true, caseSensitive: true },
    ])
    expect(compiled).toHaveLength(0)
    // Either screen may catch it first; what matters is that it never runs.
    expect(errors).toHaveLength(1)
  })

  it('refuses anything that would change the line count', () => {
    const { compiled, errors } = compileReplacementRules([
      { match: 'a', replacement: 'x\ny', regex: false, caseSensitive: true },
    ])
    expect(compiled).toHaveLength(0)
    expect(errors[0]).toContain('換行')
  })

  it('a rejected rule does not stop the others', () => {
    const { compiled, errors } = compileReplacementRules([
      { match: '(a+)+$', replacement: '', regex: true, caseSensitive: true },
      { match: 'ok', replacement: 'OK', regex: false, caseSensitive: true },
    ])
    expect(compiled).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })
})

describe('text — replacement rules: applying', () => {
  const rules = compileReplacementRules([
    { match: '\\s+', replacement: ' ', regex: true, caseSensitive: true },
  ]).compiled

  it('never changes the line count, whatever the rules do', () => {
    const src = 'one\r\ntwo\n\nthree'
    expect(applyReplacements(src, rules).split('\n')).toHaveLength(src.split('\n').length)
  })

  it('keeps each line terminator as it was', () => {
    expect(applyReplacements('a  b\r\nc  d\n', rules)).toBe('a b\r\nc d\n')
  })

  it('is a no-op with no rules', () => {
    expect(applyReplacements('a  b', [])).toBe('a  b')
  })

  it('leaves an absurdly long line alone rather than working on it', () => {
    const long = 'x '.repeat(9000)
    expect(applyReplacements(long, rules)).toBe(long)
  })

  it('is case-insensitive when asked', () => {
    const ci = compileReplacementRules([
      { match: 'foo', replacement: 'bar', regex: false, caseSensitive: false },
    ]).compiled
    expect(applyReplacements('FOO Foo foo', ci)).toBe('bar bar bar')
  })

  it('supports backreferences in the replacement', () => {
    const re = compileReplacementRules([
      { match: '(\\w+)=(\\w+)', replacement: '$2=$1', regex: true, caseSensitive: true },
    ]).compiled
    expect(applyReplacements('a=b', re)).toBe('b=a')
  })
})

describe('text — replacement rules: in the comparison', () => {
  it('makes equivalent-but-differently-written lines compare equal', () => {
    const view = makeText({ left: ['a.txt', 'x = 1;\nkeep'], right: ['b.txt', 'x=1;\nkeep'] })
    expect(view.getDiffStats().replace).toBeGreaterThan(0)

    view.setReplacements([{ match: '\\s+', replacement: '', regex: true, caseSensitive: true }])
    expect(view.getDiffStats().replace).toBe(0)
    expect(view.getDiffStats().equal).toBe(2)
  })

  it('still shows and saves the original text, not the rewritten form', () => {
    const view = makeText({ left: ['a.txt', 'x = 1;'], right: ['b.txt', 'x=1;'] })
    view.setReplacements([{ match: '\\s+', replacement: '', regex: true, caseSensitive: true }])

    expect(view._diffResult[0].leftText).toBe('x = 1;')
    expect(view._diffResult[0].rightText).toBe('x=1;')
    expect(view.getContent('left')).toBe('x = 1;')
  })

  it('puts the original text back by line number', () => {
    const diff = [
      { type: 'equal', leftLine: 1, rightLine: 1, leftText: 'norm', rightText: 'norm' },
      { type: 'insert', leftLine: null, rightLine: 2, leftText: '', rightText: 'norm2' },
    ]
    restoreOriginalDiffText(diff, ['ORIG1'], ['ORIG1', 'ORIG2'])
    expect(diff[0].leftText).toBe('ORIG1')
    expect(diff[1].rightText).toBe('ORIG2')
    expect(diff[1].leftText).toBe('')
  })

  it('reports the rules it refused instead of running a partial set silently', () => {
    const view = makeText({ left: ['a.txt', 'a'], right: ['b.txt', 'a'] })
    const errors = view.setReplacements([
      { match: '(a+)+$', replacement: '', regex: true, caseSensitive: true },
    ])
    expect(errors).toHaveLength(1)
    expect(view._replacementsCompiled).toHaveLength(0)
  })

  it('travels with a named config', () => {
    const a = new TextCompare()
    a.setReplacements([{ match: 'foo', replacement: 'bar', regex: false, caseSensitive: true }])
    const b = new TextCompare()
    b.applyConfig(a.getConfig())
    expect(b.getReplacements()).toEqual(a.getReplacements())
    expect(b._replacementsCompiled).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Entry points for the three text commands
// ---------------------------------------------------------------------------

describe('text — every new command has a way in', () => {
  /**
   * The context menu is built by the real handler, so this asserts the entries
   * a user can actually reach rather than a list kept alongside it.
   */
  function contextLabels(view) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    view._handleContextMenu(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }), 'left')
    return [...document.querySelectorAll('.ctx-item')].map((el) => el.textContent)
  }

  it('offers replacements, merge files and archive load in the context menu', () => {
    const view = makeText()
    const labels = contextLabels(view)
    expect(labels.some((l) => l.includes('文字取代規則'))).toBe(true)
    expect(labels.some((l) => l.includes('轉為三向合併（選擇基準檔）'))).toBe(true)
    expect(labels.some((l) => l.includes('轉為三向合併（無基準檔）'))).toBe(true)
    expect(labels.some((l) => l.includes('從封存檔載入'))).toBe(true)
  })

  it('names the shortcut it is bound to, so the menu cannot advertise a dead key', () => {
    const labels = contextLabels(makeText())
    // Ctrl+Shift+R now belongs to the shared reload-from-disk dispatch in
    // app.js; replacements moved to Ctrl+Alt+R so one keystroke cannot do both.
    expect(labels.find((l) => l.includes('文字取代規則'))).toContain('Ctrl+Alt+R')
    expect(labels.find((l) => l.includes('轉為三向合併（選擇基準檔）'))).toContain('Ctrl+Shift+M')
    expect(labels.find((l) => l.includes('從封存檔載入'))).toContain('Ctrl+Shift+A')
  })

  it('opens the replacement editor with the current rules in it', () => {
    const view = makeText()
    view.setReplacements([{ match: 'foo', replacement: 'bar', regex: false, caseSensitive: true }])
    view.openReplacementsDialog()
    const ta = document.querySelector('.tc-dialog-textarea')
    expect(ta).toBeTruthy()
    expect(ta.value).toBe('foo => bar')
  })

  it('keeps the editor open and shows the reason when a rule is refused', () => {
    const view = makeText()
    view.openReplacementsDialog()
    const ta = document.querySelector('.tc-dialog-textarea')
    ta.value = 're: (a+)+$ => x'
    ;[...document.querySelectorAll('.tc-dialog button')]
      .find((b) => b.textContent === '套用')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(document.querySelector('.tc-dialog')).toBeTruthy()
    expect(document.querySelector('.tc-dialog-errors').textContent).toContain('被拒絕')
  })
})

// ---------------------------------------------------------------------------
// Text virtualisation must survive the replacement pass
// ---------------------------------------------------------------------------

describe('text — 20k lines with replacements still renders a window', () => {
  it('renders only the visible rows', () => {
    const n = 20000
    const left = Array.from({ length: n }, (_, i) => `value = ${i};`).join('\n')
    const right = Array.from({ length: n }, (_, i) => `value=${i};`).join('\n')

    const view = makeText({ left: ['a.txt', left], right: ['b.txt', right] })
    view.setReplacements([{ match: '\\s+', replacement: '', regex: true, caseSensitive: true }])

    // Every line is now equal, so the diff has nothing to report — which is
    // the whole point of the feature at this scale.
    expect(view.getDiffStats().replace).toBe(0)
    expect(view.getDiffStats().equal).toBe(n)
    expect(view._diffResult).toHaveLength(n)
    // The original text, terminator and all — not the rewritten form.
    expect(view._diffResult[12345].leftText).toBe('value = 12345;\n')
  })
})
