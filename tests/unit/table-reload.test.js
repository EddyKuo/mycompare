/**
 * @vitest-environment jsdom
 *
 * Reloading a table from disk.
 *
 * "重新整理" re-runs the comparison over what is already in memory, so an edit
 * made by another program was invisible until the session was closed and the
 * file opened again. Hex Compare has had a real reload since S24; the table
 * view did not, which is the gap this covers.
 *
 * The dangerous half is the confirmation: reloading destroys unsaved cell
 * edits exactly as closing would, so a reload that skipped the prompt would
 * silently discard work.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TableCompare } from '../../src/renderer/src/views/table-compare.js'

/** @type {HTMLElement} */
let host
/** @type {TableCompare} */
let view
/** @type {Map<string, string>} what readFile will return per path */
let disk

beforeEach(() => {
  disk = new Map()
  host = document.createElement('div')
  document.body.appendChild(host)

  globalThis.window.electronAPI = {
    readFile: vi.fn(async (p) => {
      if (!disk.has(p)) throw new Error(`no such file: ${p}`)
      return { path: p, content: disk.get(p), encoding: 'UTF-8' }
    }),
  }
  vi.spyOn(window, 'confirm').mockReturnValue(true)

  view = new TableCompare()
  view.mount(host)
})

afterEach(() => {
  view?.destroy?.()
  host.remove()
  vi.restoreAllMocks()
  delete globalThis.window.electronAPI
})

/** @param {string} path @param {string} csv */
function loadLeft(path, csv) {
  disk.set(path, csv)
  view.setLeft(path, csv)
}

describe('reloadSide', () => {
  it('picks up a change another program made', async () => {
    loadLeft('/tmp/a.csv', 'id,name\n1,alice\n')
    disk.set('/tmp/a.csv', 'id,name\n1,alice\n2,bob\n')

    expect(await view.reloadSide('left')).toBe(true)
    // The point is the new row, not merely that the call returned true.
    expect(view._leftPath).toBe('/tmp/a.csv')
    expect(JSON.stringify(view._leftParsed)).toContain('bob')
  })

  it('refuses a side with no path rather than silently doing nothing', async () => {
    expect(await view.reloadSide('right')).toBe(false)
  })

  it('reports a read failure instead of leaving the old data looking fresh', async () => {
    loadLeft('/tmp/a.csv', 'id\n1\n')
    disk.delete('/tmp/a.csv')

    expect(await view.reloadSide('left')).toBe(false)
    // The previously loaded rows must survive a failed reload — dropping them
    // would turn a transient read error into apparent data loss.
    expect(JSON.stringify(view._leftParsed)).toContain('1')
  })

  it('asks before discarding unsaved edits, and honours a refusal', async () => {
    loadLeft('/tmp/a.csv', 'id,name\n1,alice\n')
    view._modified.left = true
    vi.mocked(window.confirm).mockReturnValue(false)
    disk.set('/tmp/a.csv', 'id,name\n1,CHANGED\n')

    expect(await view.reloadSide('left')).toBe(false)
    expect(window.confirm).toHaveBeenCalled()
    expect(JSON.stringify(view._leftParsed)).toContain('alice')
    expect(JSON.stringify(view._leftParsed)).not.toContain('CHANGED')
  })

  it('does not ask when there is nothing to lose', async () => {
    loadLeft('/tmp/a.csv', 'id\n1\n')
    expect(await view.reloadSide('left')).toBe(true)
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('clears the modified flag once the side is re-read', async () => {
    loadLeft('/tmp/a.csv', 'id\n1\n')
    view._modified.left = true
    expect(await view.reloadSide('left')).toBe(true)
    expect(view.getModified().left).toBe(false)
  })
})

describe('reloadAll', () => {
  it('re-reads both sides and asks only once', async () => {
    loadLeft('/tmp/a.csv', 'id\n1\n')
    disk.set('/tmp/b.csv', 'id\n2\n')
    view.setRight('/tmp/b.csv', 'id\n2\n')
    view._modified.left = true
    view._modified.right = true

    expect(await view.reloadAll()).toBe(true)
    // Two prompts for one action is the behaviour the `confirmed` flag exists
    // to prevent.
    expect(vi.mocked(window.confirm).mock.calls).toHaveLength(1)
  })

  it('refuses when neither side has a path', async () => {
    expect(await view.reloadAll()).toBe(false)
  })

  it('re-reads the one side that has a path', async () => {
    loadLeft('/tmp/a.csv', 'id\n1\n')
    disk.set('/tmp/a.csv', 'id\n99\n')
    expect(await view.reloadAll()).toBe(true)
    expect(JSON.stringify(view._leftParsed)).toContain('99')
  })

  it('a refusal leaves both sides exactly as they were', async () => {
    loadLeft('/tmp/a.csv', 'id\n1\n')
    view._modified.left = true
    vi.mocked(window.confirm).mockReturnValue(false)
    disk.set('/tmp/a.csv', 'id\n99\n')

    expect(await view.reloadAll()).toBe(false)
    expect(JSON.stringify(view._leftParsed)).toContain('1')
    expect(view.getModified().left).toBe(true)
  })
})

describe('format routing is shared with opening', () => {
  it('sends a .csv through the CSV path', async () => {
    loadLeft('/tmp/a.csv', 'id,name\n1,alice\n')
    disk.set('/tmp/a.csv', 'id,name\n1,zoe\n')
    expect(await view.reloadSide('left')).toBe(true)
    expect(JSON.stringify(view._leftParsed)).toContain('zoe')
  })

  it('does not push a workbook through the CSV parser', async () => {
    // Reloading an .xlsx as CSV would fill the grid with the raw zip container
    // and report success, which is why open and reload share one dispatch.
    const spy = vi.spyOn(view, '_openExcel').mockResolvedValue(undefined)
    view._leftPath = '/tmp/book.xlsx'
    disk.set('/tmp/book.xlsx', 'PK binary junk')

    await view.reloadSide('left')
    expect(spy).toHaveBeenCalledWith('left', '/tmp/book.xlsx')
  })
})
