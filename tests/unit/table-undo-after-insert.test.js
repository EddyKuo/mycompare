/**
 * @vitest-environment jsdom
 *
 * Undo still targets the right row after rows have been inserted.
 *
 * Edit history recorded a row *index*. Inserting a row shifts every index below
 * it, so undoing an earlier edit wrote to a different row than the one it had
 * changed — silently corrupting a cell the user never touched, in a file they
 * are about to save. Written against the public API independently of the
 * implementation's own tests, because that is the failure mode least likely to
 * be noticed by hand.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TableCompare } from '../../src/renderer/src/views/table-compare.js'

const CSV = 'id,name\n1,alpha\n2,beta\n3,gamma\n'

function mount() {
  const host = document.createElement('div')
  Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true })
  document.body.appendChild(host)
  const view = new TableCompare({})
  view.mount(host)
  view.setLeft('L.csv', CSV)
  view.setRight('R.csv', CSV)
  return view
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.electronAPI = { saveFile: vi.fn(), readExcel: vi.fn() }
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

/** Every left-hand value in visible-row order, read through the public getter. */
const column = (view, col) =>
  view._visibleRows.map((_, i) => view.getCellValue('left', i, col))

describe('undo after an insert', () => {
  it('restores the row it actually edited, not whatever now sits at that index', () => {
    const view = mount()
    const rowOfGamma = column(view, 1).indexOf('gamma')
    expect(rowOfGamma).toBeGreaterThan(0)

    expect(view.editCell('left', rowOfGamma, 1, 'GAMMA')).toBe(true)
    expect(view.getCellValue('left', rowOfGamma, 1)).toBe('GAMMA')

    // Insert above it, so every row below shifts down by one.
    expect(view.insertRow('left', 0, 'below')).toBe(true)

    view.undo()   // the insert
    view.undo()   // the cell edit

    const values = column(view, 1)
    // The edit is undone and every neighbour is untouched. An index-keyed undo
    // would have written 'gamma' over one of the others instead.
    expect(values).toContain('gamma')
    expect(values).toContain('alpha')
    expect(values).toContain('beta')
    expect(values).not.toContain('GAMMA')
  })

  it('leaves every other row alone when undoing an insert', () => {
    const view = mount()
    const before = column(view, 1)
    view.insertRow('left', 1, 'below')
    view.undo()
    expect(column(view, 1)).toEqual(before)
  })

  it('redo restores the inserted row', () => {
    const view = mount()
    const before = view._leftParsed.length
    view.insertRow('left', 1, 'below')
    const after = view._leftParsed.length
    expect(after).toBe(before + 1)

    view.undo()
    expect(view._leftParsed.length).toBe(before)
    view.redo()
    expect(view._leftParsed.length).toBe(after)
  })

  it('an edit made after an insert also undoes to the right row', () => {
    // The reverse order: insert first, then edit below the insertion point.
    const view = mount()
    view.insertRow('left', 0, 'below')
    const rowOfBeta = column(view, 1).indexOf('beta')
    expect(rowOfBeta).toBeGreaterThan(0)

    view.editCell('left', rowOfBeta, 1, 'BETA')
    view.undo()

    expect(view.getCellValue('left', rowOfBeta, 1)).toBe('beta')
    expect(column(view, 1)).toContain('gamma')
  })
})
