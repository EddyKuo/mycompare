/**
 * @vitest-environment jsdom
 *
 * P2-21 — table cell editing, undo/redo, dirty tracking, saving.
 * P2-33 — multiple Excel sheets / multiple HTML tables.
 *
 * The scale case matters most here: this view is virtually scrolled, so an
 * edit that only reached the DOM would disappear the moment the row scrolled
 * out. Every editing assertion below is made after forcing a repaint.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  TableCompare,
  MAX_EDIT_HISTORY,
  serializeTable,
  parseHtmlTables,
  csvPathFor,
} from '../../src/renderer/src/views/table-compare.js'

/** @type {TableCompare|null} */
let view = null
/** @type {HTMLElement|null} */
let host = null

/**
 * @param {object} [opts]
 * @returns {TableCompare}
 */
function mountView(opts = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  view = new TableCompare(opts)
  view.mount(host)
  return view
}

beforeEach(() => {
  // The view calls these on error and on save; unstubbed jsdom throws "not implemented".
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.stubGlobal('alert', vi.fn())
  window.electronAPI = /** @type {never} */ ({
    saveFile: vi.fn(async () => ({ saved: true, path: 'C:/out.csv' })),
    readExcel: vi.fn(),
    readFile: vi.fn(),
    openFile: vi.fn(),
  })
})

afterEach(() => {
  view?.destroy()
  view = null
  host?.remove()
  host = null
  vi.unstubAllGlobals()
  delete window.electronAPI
})

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('serializeTable()', () => {
  it('round-trips through the CSV parser', () => {
    const rows = [['a', 'b'], ['1', 'x,y'], ['2', 'he said "hi"'], ['3', 'line\nbreak']]
    const text = serializeTable(rows)
    expect(text.split('\n')[0]).toBe('a,b')
    const tc = mountView()
    tc.setLeft('a.csv', text)
    expect(tc.getStats().total).toBe(3)
  })

  it('honours a tab delimiter and quotes only what needs it', () => {
    expect(serializeTable([['a', 'b c'], ['1', '2']], '\t')).toBe('a\tb c\n1\t2')
    expect(serializeTable([['a\tb']], '\t')).toBe('"a\tb"')
  })

  it('renders null and undefined cells as empty', () => {
    expect(serializeTable([[/** @type {never} */ (null), 'x']])).toBe(',x')
  })
})

describe('parseHtmlTables()', () => {
  it('extracts each top-level table with its caption as the name', () => {
    const tables = parseHtmlTables(`
      <html><body>
        <table><caption>員工</caption>
          <tr><th>id</th><th>name</th></tr>
          <tr><td>1</td><td>Ann</td></tr>
        </table>
        <table><tr><td>only</td></tr></table>
      </body></html>`)
    expect(tables).toHaveLength(2)
    expect(tables[0].name).toBe('員工')
    expect(tables[0].rows).toEqual([['id', 'name'], ['1', 'Ann']])
    expect(tables[1].name).toBe('表格 2')
  })

  it('expands colspan so both sides keep matching column indices', () => {
    const [t] = parseHtmlTables('<table><tr><td colspan="3">wide</td><td>x</td></tr></table>')
    expect(t.rows[0]).toEqual(['wide', 'wide', 'wide', 'x'])
  })

  it('does not fold a nested table into its parent', () => {
    const tables = parseHtmlTables(
      '<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table>')
    expect(tables[0].rows).toHaveLength(1)
    expect(tables[1].rows).toEqual([['inner']])
  })

  it('returns nothing for markup without tables', () => {
    expect(parseHtmlTables('<p>no tables here</p>')).toEqual([])
  })
})

describe('csvPathFor()', () => {
  it('swaps the extension and strips the sheet suffix', () => {
    expect(csvPathFor('C:/data/book.xlsx')).toBe('C:/data/book.csv')
    expect(csvPathFor('C:/data/book.xlsx [Sheet2]')).toBe('C:/data/book.csv')
    expect(csvPathFor('')).toBe('table.csv')
  })
})

// ── Cell editing ──────────────────────────────────────────────────────────────

describe('cell editing', () => {
  /** @returns {TableCompare} */
  const withData = () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('l.csv', 'id,name,qty\n1,Ann,10\n2,Bob,20')
    tc.setRight('r.csv', 'id,name,qty\n1,Ann,10\n2,Bob,20')
    return tc
  }

  it('writes the edit into the model, not just the DOM', () => {
    const tc = withData()
    expect(tc.editCell('left', 1, 1, 'Robert')).toBe(true)
    expect(tc.getCellValue('left', 1, 1)).toBe('Robert')
  })

  it('recomputes the row status after an edit', () => {
    const tc = withData()
    expect(tc.getStats().different).toBe(0)
    tc.editCell('left', 1, 2, '99')
    expect(tc.getStats().different).toBe(1)
    tc.editCell('right', 1, 2, '99')
    expect(tc.getStats().different).toBe(0)
  })

  it('refuses phantom cells (no source row on that side)', () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('l.csv', 'id,name\n1,Ann')
    tc.setRight('r.csv', 'id,name\n2,Bob')
    // Row 0 is left-only, so its right pane has nothing to edit.
    expect(tc.getCellValue('right', 0, 1)).toBeNull()
    expect(tc.editCell('right', 0, 1, 'x')).toBe(false)
  })

  it('refuses out-of-range rows and negative columns', () => {
    const tc = withData()
    expect(tc.editCell('left', 999, 0, 'x')).toBe(false)
    expect(tc.editCell('left', 0, -1, 'x')).toBe(false)
  })

  it('maps the display column back to the source column when column order is ignored', () => {
    const tc = mountView({ keyColumn: 0, ignoreColumnOrder: true })
    tc.setLeft('l.csv', 'id,name,qty\n1,Ann,10')
    // Right file stores the same columns in a different order.
    tc.setRight('r.csv', 'id,qty,name\n1,10,Ann')
    expect(tc.getStats().different).toBe(0)
    // Display column 1 is "name" on both sides; on disk it is the right file's
    // column 2, and writing to column 1 there would corrupt "qty".
    expect(tc.editCell('right', 0, 1, 'Zoe')).toBe(true)
    expect(tc._rightParsed[1]).toEqual(['1', '10', 'Zoe'])
  })

  it('pads ragged rows rather than leaving holes', () => {
    const tc = mountView({ keyColumn: -1 })
    tc.setLeft('l.csv', 'a,b,c\n1')
    tc.setRight('r.csv', 'a,b,c\n1,2,3')
    expect(tc.editCell('left', 0, 2, 'z')).toBe(true)
    expect(tc._leftParsed[1]).toEqual(['1', '', 'z'])
  })

  it('keeps the serialised content in sync so a refresh preserves the edit', () => {
    const tc = withData()
    tc.editCell('left', 1, 1, 'Robert')
    tc.refresh()
    expect(tc.getCellValue('left', 1, 1)).toBe('Robert')
  })

  it('preserves the detected tab delimiter when re-serialising', () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('l.tsv', 'id\tname\n1\tAnn')
    tc.editCell('left', 0, 1, 'Bea')
    expect(tc._leftContent).toBe('id\tname\n1\tBea')
  })
})

// ── Undo / redo ───────────────────────────────────────────────────────────────

describe('undo / redo', () => {
  /** @returns {TableCompare} */
  const withData = () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('l.csv', 'id,name\n1,Ann\n2,Bob')
    tc.setRight('r.csv', 'id,name\n1,Ann\n2,Bob')
    return tc
  }

  it('restores and reapplies a single edit', () => {
    const tc = withData()
    tc.editCell('left', 0, 1, 'Amy')
    expect(tc.canUndo()).toBe(true)
    expect(tc.undo()).toBe(true)
    expect(tc.getCellValue('left', 0, 1)).toBe('Ann')
    expect(tc.canRedo()).toBe(true)
    expect(tc.redo()).toBe(true)
    expect(tc.getCellValue('left', 0, 1)).toBe('Amy')
  })

  it('unwinds several edits in reverse order across both sides', () => {
    const tc = withData()
    tc.editCell('left', 0, 1, 'A1')
    tc.editCell('right', 1, 1, 'B1')
    tc.undo()
    expect(tc.getCellValue('right', 1, 1)).toBe('Bob')
    expect(tc.getCellValue('left', 0, 1)).toBe('A1')
    tc.undo()
    expect(tc.getCellValue('left', 0, 1)).toBe('Ann')
    expect(tc.undo()).toBe(false)
  })

  it('drops the redo branch once a new edit lands', () => {
    const tc = withData()
    tc.editCell('left', 0, 1, 'A1')
    tc.undo()
    expect(tc.canRedo()).toBe(true)
    tc.editCell('left', 1, 1, 'B1')
    expect(tc.canRedo()).toBe(false)
  })

  it('caps the history instead of growing without bound', () => {
    const tc = withData()
    for (let i = 0; i < MAX_EDIT_HISTORY + 50; i++) {
      tc.editCell('left', 0, 1, `v${i}`)
    }
    expect(tc._undoStack.length).toBe(MAX_EDIT_HISTORY)
    // Undoing everything still leaves the stack empty and does not throw.
    let steps = 0
    while (tc.undo()) steps++
    expect(steps).toBe(MAX_EDIT_HISTORY)
  })

  it('is discarded when a side is reloaded, because row indices no longer apply', () => {
    const tc = withData()
    tc.editCell('left', 0, 1, 'A1')
    tc.setLeft('l2.csv', 'id,name\n9,Zed')
    expect(tc.canUndo()).toBe(false)
    expect(tc.canRedo()).toBe(false)
  })

  it('is discarded on swap, so undo cannot hit the wrong file', () => {
    const tc = withData()
    tc.editCell('left', 0, 1, 'A1')
    tc.swap()
    expect(tc.canUndo()).toBe(false)
  })
})

// ── Dirty state and saving ────────────────────────────────────────────────────

describe('unsaved-change tracking and saving', () => {
  it('marks the edited side, shows a star, and emits an event', () => {
    const tc = mountView({ keyColumn: 0 })
    const seen = []
    tc.on('modified-changed', (p) => seen.push(p))
    tc.setLeft('l.csv', 'id,name\n1,Ann')
    tc.setRight('r.csv', 'id,name\n1,Ann')
    expect(tc.hasUnsavedChanges()).toBe(false)

    tc.editCell('left', 0, 1, 'Amy')
    expect(tc.hasUnsavedChanges()).toBe(true)
    expect(tc.getModified()).toEqual({ left: true, right: false })
    expect(seen.at(-1)).toEqual({ left: true, right: false })
    expect(tc._dom.dispLeft.textContent).toBe('l.csv *')
    expect(tc._dom.dispRight.textContent).toBe('r.csv')
  })

  it('confirmDiscardChanges only prompts when something is unsaved', () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('l.csv', 'id,name\n1,Ann')
    expect(tc.confirmDiscardChanges()).toBe(true)
    expect(window.confirm).not.toHaveBeenCalled()

    tc.editCell('left', 0, 1, 'Amy')
    expect(tc.confirmDiscardChanges()).toBe(true)
    expect(window.confirm).toHaveBeenCalledTimes(1)

    vi.mocked(window.confirm).mockReturnValueOnce(false)
    expect(tc.confirmDiscardChanges()).toBe(false)
  })

  it('writes CSV and clears the flag on a successful save', async () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('C:/l.csv', 'id,name\n1,Ann')
    tc.editCell('left', 0, 1, 'Amy')

    expect(await tc.saveLeft()).toBe(true)
    const [defaultPath, content] = vi.mocked(window.electronAPI.saveFile).mock.calls[0]
    expect(defaultPath).toBe('C:/l.csv')
    expect(content).toBe('id,name\n1,Amy')
    expect(tc.hasUnsavedChanges()).toBe(false)
  })

  it('keeps the edits marked unsaved when the save dialog is cancelled', async () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('C:/l.csv', 'id,name\n1,Ann')
    tc.editCell('left', 0, 1, 'Amy')
    vi.mocked(window.electronAPI.saveFile).mockResolvedValueOnce(false)

    expect(await tc.saveLeft()).toBe(false)
    expect(tc.hasUnsavedChanges()).toBe(true)
  })

  it('surfaces a save failure instead of swallowing it', async () => {
    const tc = mountView({ keyColumn: 0 })
    const errors = []
    tc.on('status', (p) => errors.push(p))
    tc.setLeft('C:/l.csv', 'id,name\n1,Ann')
    tc.editCell('left', 0, 1, 'Amy')
    vi.mocked(window.electronAPI.saveFile).mockRejectedValueOnce(new Error('EACCES'))

    expect(await tc.saveLeft()).toBe(false)
    expect(errors.at(-1).message).toContain('EACCES')
    expect(tc.hasUnsavedChanges()).toBe(true)
  })

  it('refuses to save a side with no data, and says so', async () => {
    const tc = mountView()
    const errors = []
    tc.on('status', (p) => errors.push(p))
    expect(await tc.saveLeft()).toBe(false)
    expect(errors.at(-1).message).toContain('無法儲存')
  })
})

// ── Excel workbooks with several sheets ───────────────────────────────────────

describe('P2-33 — Excel sheets', () => {
  const workbook = {
    sheetNames: ['Q1', 'Q2', 'Notes'],
    sheets: {
      Q1: 'id,amount\n1,100',
      Q2: 'id,amount\n1,200',
      Notes: 'note\nhello',
    },
  }

  it('loads the first sheet and offers the rest', async () => {
    const tc = mountView({ keyColumn: 0 })
    vi.mocked(window.electronAPI.readExcel).mockResolvedValue(workbook)
    await tc._openExcel('left', 'C:/book.xlsx')

    expect(tc.getSourceParts('left')).toEqual(['Q1', 'Q2', 'Notes'])
    expect(tc.getActiveSourcePart('left')).toBe('Q1')
    expect(tc._dom.selLeft.style.display).not.toBe('none')
    expect(tc._dom.dispLeft.textContent).toBe('C:/book.xlsx [Q1]')
  })

  it('switches sheets and actually repaints the panes', async () => {
    const tc = mountView({ keyColumn: 0 })
    vi.mocked(window.electronAPI.readExcel).mockResolvedValue(workbook)
    await tc._openExcel('left', 'C:/book.xlsx')
    expect(tc.getCellValue('left', 0, 1)).toBe('100')

    expect(tc.selectSourcePart('left', 'Q2')).toBe(true)
    expect(tc.getCellValue('left', 0, 1)).toBe('200')
    // The virtual scroller short-circuits on an unchanged window; a source
    // switch has to invalidate it or the pane keeps showing the old sheet.
    expect(tc._dom.leftTbody.children[0].textContent).toContain('200')
  })

  it('prefers the sheet whose name matches the other side, but allows any pairing', async () => {
    const tc = mountView({ keyColumn: 0 })
    vi.mocked(window.electronAPI.readExcel).mockResolvedValue(workbook)
    await tc._openExcel('left', 'C:/a.xlsx')
    tc.selectSourcePart('left', 'Q2')

    vi.mocked(window.electronAPI.readExcel).mockResolvedValue({
      sheetNames: ['Intro', 'Q2'],
      sheets: { Intro: 'x\n1', Q2: 'id,amount\n1,200' },
    })
    await tc._openExcel('right', 'C:/b.xlsx')
    expect(tc.getActiveSourcePart('right')).toBe('Q2')
    expect(tc.getStats().different).toBe(0)

    // Differently-named sheets still pair, because each side picks its own.
    expect(tc.selectSourcePart('right', 'Intro')).toBe(true)
    expect(tc.getActiveSourcePart('right')).toBe('Intro')
  })

  it('reports a read failure rather than loading nothing silently', async () => {
    const tc = mountView()
    const errors = []
    tc.on('status', (p) => errors.push(p))
    vi.mocked(window.electronAPI.readExcel).mockRejectedValueOnce(new Error('bad zip'))
    await tc._openExcel('left', 'C:/broken.xlsx')
    expect(errors.at(-1).message).toContain('bad zip')

    vi.mocked(window.electronAPI.readExcel).mockResolvedValueOnce({ sheetNames: [], sheets: {} })
    await tc._openExcel('left', 'C:/empty.xlsx')
    expect(errors.at(-1).message).toContain('沒有任何工作表')
  })

  it('warns that an Excel source can only be saved as CSV, and lets the user refuse', async () => {
    const tc = mountView({ keyColumn: 0 })
    vi.mocked(window.electronAPI.readExcel).mockResolvedValue(workbook)
    await tc._openExcel('left', 'C:/book.xlsx')
    tc.editCell('left', 0, 1, '150')

    vi.mocked(window.confirm).mockReturnValueOnce(false)
    expect(await tc.saveLeft()).toBe(false)
    expect(window.electronAPI.saveFile).not.toHaveBeenCalled()
    expect(tc.hasUnsavedChanges()).toBe(true)

    expect(await tc.saveLeft()).toBe(true)
    expect(vi.mocked(window.electronAPI.saveFile).mock.calls[0][0]).toBe('C:/book.csv')
    expect(tc.hasUnsavedChanges()).toBe(false)
    // Saved as plain CSV — the sheet picker no longer applies.
    expect(tc.getSourceParts('left')).toEqual([])
  })
})

// ── HTML tables ───────────────────────────────────────────────────────────────

describe('P2-33 — HTML tables', () => {
  const html = `
    <table><caption>總表</caption><tr><th>id</th><th>v</th></tr><tr><td>1</td><td>a</td></tr></table>
    <table><tr><th>id</th><th>v</th></tr><tr><td>1</td><td>b</td></tr></table>`

  it('lists every table and loads the first', () => {
    const tc = mountView({ keyColumn: 0 })
    expect(tc._openHtmlContent('left', 'C:/page.html', html)).toBe(true)
    expect(tc.getSourceParts('left')).toEqual(['總表', '表格 2'])
    expect(tc.getCellValue('left', 0, 1)).toBe('a')

    expect(tc.selectSourcePart('left', '表格 2')).toBe(true)
    expect(tc.getCellValue('left', 0, 1)).toBe('b')
  })

  it('says so when the file has no tables', () => {
    const tc = mountView()
    const errors = []
    tc.on('status', (p) => errors.push(p))
    expect(tc._openHtmlContent('left', 'C:/plain.html', '<p>nope</p>')).toBe(false)
    expect(errors.at(-1).message).toContain('找不到')
  })

  it('warns before saving an HTML source as CSV', async () => {
    const tc = mountView({ keyColumn: 0 })
    tc._openHtmlContent('left', 'C:/page.html', html)
    tc.editCell('left', 0, 1, 'z')
    expect(await tc.saveLeft()).toBe(true)
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain('CSV')
    expect(vi.mocked(window.electronAPI.saveFile).mock.calls[0][0]).toBe('C:/page.csv')
  })
})

// ── Scale: virtual scrolling + edit persistence ───────────────────────────────

describe('scale — tens of thousands of rows', () => {
  const ROWS = 50_000

  /** @returns {string} */
  const bigCsv = (mark = '') => {
    const out = ['id,name,qty']
    for (let i = 0; i < ROWS; i++) out.push(`${i},n${i}${mark},${i}`)
    return out.join('\n')
  }

  it('renders only the visible window, edits deep rows, and keeps them after scrolling', () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('big-l.csv', bigCsv())
    tc.setRight('big-r.csv', bigCsv())

    expect(tc.getStats().total).toBe(ROWS)
    const rendered = tc._dom.leftTbody.children.length
    expect(rendered).toBeGreaterThan(0)
    // A viewport's worth plus overscan — nowhere near 50k <tr>.
    expect(rendered).toBeLessThan(200)

    // Edit a row far outside the rendered window.
    const deep = 40_000
    expect(tc.editCell('left', deep, 1, 'EDITED')).toBe(true)
    expect(tc.getStats().different).toBe(1)
    expect(tc._dom.leftTbody.children.length).toBeLessThan(200)

    // Scroll to it, away, and back: the value must survive every repaint.
    tc._scrollToVisibleRow(deep)
    expect(tc._dom.leftTbody.textContent).toContain('EDITED')
    tc._scrollToVisibleRow(0)
    expect(tc._dom.leftTbody.textContent).not.toContain('EDITED')
    tc._scrollToVisibleRow(deep)
    expect(tc._dom.leftTbody.textContent).toContain('EDITED')
    expect(tc.getCellValue('left', deep, 1)).toBe('EDITED')

    // And it survives an undo/redo round trip at that depth.
    tc.undo()
    expect(tc.getCellValue('left', deep, 1)).toBe('n40000')
    tc.redo()
    expect(tc.getCellValue('left', deep, 1)).toBe('EDITED')
    expect(tc._dom.leftTbody.children.length).toBeLessThan(200)
  })

  it('addresses the right source row even when rows were sorted before comparing', () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('l.csv', 'id,name\n3,C\n1,A\n2,B')
    tc.setRight('r.csv', 'id,name\n1,A\n2,B\n3,C')
    tc._dom.cbSort.checked = true
    tc._dom.cbSort.dispatchEvent(new Event('change'))

    // Visible row 0 is id=1 after sorting; the source row is _leftParsed[2].
    expect(tc.getCellValue('left', 0, 1)).toBe('A')
    expect(tc.editCell('left', 0, 1, 'AA')).toBe(true)
    expect(tc._leftParsed[2]).toEqual(['1', 'AA'])
  })

  it('keeps the scroll position after an edit', () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('l.csv', bigCsv())
    tc.setRight('r.csv', bigCsv())
    tc._dom.leftScroll.scrollTop = 12_000
    tc._renderTableWindow()

    const before = tc._dom.leftScroll.scrollTop
    tc.editCell('left', 500, 1, 'X')
    expect(tc._dom.leftScroll.scrollTop).toBe(before)
  })
})

// ── Inline editor interaction ─────────────────────────────────────────────────

describe('inline editor', () => {
  /** @returns {{ tc: TableCompare, td: HTMLElement }} */
  const openEditor = () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('l.csv', 'id,name\n1,Ann\n2,Bob')
    tc.setRight('r.csv', 'id,name\n1,Ann\n2,Bob')
    const td = tc._dom.leftTbody.children[0].children[2]
    td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return { tc, td }
  }

  it('opens on double-click with the current value selected', () => {
    const { tc, td } = openEditor()
    const input = td.querySelector('input.tc-cell-input')
    expect(input).not.toBeNull()
    expect(input.value).toBe('Ann')
    expect(tc._editing).not.toBeNull()
  })

  it('commits on Enter', () => {
    const { tc, td } = openEditor()
    const input = td.querySelector('input.tc-cell-input')
    input.value = 'Amy'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(tc.getCellValue('left', 0, 1)).toBe('Amy')
    expect(tc._editing).toBeNull()
  })

  it('discards on Escape', () => {
    const { tc, td } = openEditor()
    const input = td.querySelector('input.tc-cell-input')
    input.value = 'Amy'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(tc.getCellValue('left', 0, 1)).toBe('Ann')
    expect(tc.canUndo()).toBe(false)
    expect(td.textContent).toBe('Ann')
  })

  it('commits rather than losing the value when a repaint removes the editor', () => {
    const { tc, td } = openEditor()
    const input = td.querySelector('input.tc-cell-input')
    input.value = 'Amy'
    // A scroll-driven repaint replaces the row that holds the editor.
    tc._dom.leftScroll.scrollTop = 400
    tc._renderTableWindow()
    expect(tc.getCellValue('left', 0, 1)).toBe('Amy')
    expect(tc._editing).toBeNull()
  })

  it('ignores double-clicks on a phantom row', () => {
    const tc = mountView({ keyColumn: 0 })
    tc.setLeft('l.csv', 'id,name\n1,Ann')
    tc.setRight('r.csv', 'id,name\n2,Bob')
    const phantom = [...tc._dom.rightTbody.children].find((tr) => tr.classList.contains('phantom'))
    expect(phantom).toBeDefined()
    phantom.children[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(tc._editing).toBeNull()
  })
})
