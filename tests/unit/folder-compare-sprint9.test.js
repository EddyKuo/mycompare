/**
 * @vitest-environment jsdom
 *
 * Sprint 9 edge-case tests for FolderCompare (T51–T56).
 *
 * Complements tests/unit/folder-compare.test.js by covering boundary
 * conditions: empty selections, IPC rejection, no-match find, combined
 * filter state, and expand/collapse on mixed row sets.
 *
 * Runs in jsdom. Does not modify production code.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock the context-menu module so we can intercept the items array
// passed to showContextMenu and invoke individual actions directly.
const capturedMenu = { items: null }
vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: (_e, items) => { capturedMenu.items = items },
}))

let FolderCompare
let importError = null

try {
  const mod = await import('../../src/renderer/src/views/folder-compare.js')
  FolderCompare = mod.FolderCompare
} catch (e) {
  importError = e
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow({ name = 'file.txt', status = 'same', leftPath = null, rightPath = null, isDir = false } = {}) {
  return {
    name,
    status,
    left: leftPath ? { path: leftPath, isDirectory: isDir, size: 100, mtime: '2024-01-01T00:00:00.000Z', name } : null,
    right: rightPath ? { path: rightPath, isDirectory: isDir, size: 100, mtime: '2024-01-01T00:00:00.000Z', name } : null,
  }
}

function buildFC(rows = []) {
  if (!FolderCompare) return null
  window.electronAPI = {
    renameFile: vi.fn().mockResolvedValue(undefined),
    mkdirFolder: vi.fn().mockResolvedValue(undefined),
    readDir: vi.fn().mockResolvedValue([]),
    copyFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    openFolder: vi.fn().mockResolvedValue(null),
    showInExplorer: vi.fn(),
  }
  const fc = new FolderCompare({ leftPath: '/left', rightPath: '/right' })
  fc._rows = rows
  fc._leftEntries = []
  fc._rightEntries = []
  fc._dom = {
    list: document.createElement('div'),
    btnBatch: null,
    cbSelectAll: null,
    findBar: null,
    findInput: null,
    findStatus: null,
  }
  return fc
}

/**
 * Trigger the row context menu for a synthetic row element so the rename
 * / mkdir action callbacks become accessible via `capturedMenu.items`.
 */
function openContextMenuForRow(fc, { name, leftPath = '', rightPath = '', status = 'same', isDir = false }) {
  capturedMenu.items = null
  const rowEl = document.createElement('div')
  rowEl.className = 'fc-row'
  rowEl.dataset.name = name
  rowEl.dataset.status = status
  rowEl.dataset.isDir = String(isDir)
  rowEl.dataset.leftPath = leftPath
  rowEl.dataset.rightPath = rightPath
  fc._dom.list.appendChild(rowEl)

  const evt = new MouseEvent('contextmenu', { bubbles: true })
  // jsdom: target normally resolved by dispatch, but _onRowContextMenu reads e.target.closest
  Object.defineProperty(evt, 'target', { value: rowEl })
  fc._onRowContextMenu(evt)
  return capturedMenu.items ?? []
}

beforeEach(() => {
  document.body.innerHTML = ''
  capturedMenu.items = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── T51: Selection edge cases ────────────────────────────────────────────────

describe('T51: invertSelection — empty row set', () => {
  it('should not throw when there are no rows and produce empty selection', () => {
    if (!FolderCompare) return
    const fc = buildFC([])
    expect(() => fc.invertSelection()).not.toThrow()
    expect(fc._selectedNames.size).toBe(0)
  })
})

describe('T51: selectNewerBoth — no "newer" rows present', () => {
  it('should leave _selectedNames empty when no row has left-newer or right-newer status', () => {
    if (!FolderCompare) return
    const fc = buildFC([
      makeRow({ name: 'a.txt', status: 'same', leftPath: '/left/a.txt', rightPath: '/right/a.txt' }),
      makeRow({ name: 'b.txt', status: 'different', leftPath: '/left/b.txt', rightPath: '/right/b.txt' }),
      makeRow({ name: 'c.txt', status: 'left-only', leftPath: '/left/c.txt' }),
    ])
    fc.selectNewerBoth()
    expect(fc._selectedNames.size).toBe(0)
  })
})

// ── T52: Rename IPC failure ──────────────────────────────────────────────────

describe('T52: rename IPC rejection', () => {
  it('should swallow rejection via try/catch and NOT call refresh', async () => {
    if (!FolderCompare) return
    const fc = buildFC()
    fc.refresh = vi.fn().mockResolvedValue(undefined)
    window.electronAPI.renameFile = vi.fn().mockRejectedValue(new Error('EACCES'))
    // Provide alert + prompt stubs (jsdom does not implement them)
    window.prompt = vi.fn().mockReturnValue('new.txt')
    window.alert = vi.fn()

    const items = openContextMenuForRow(fc, {
      name: 'old.txt',
      leftPath: '/left/old.txt',
      status: 'same',
    })
    const renameItem = items.find((it) => it.label === '重新命名…')
    expect(renameItem).toBeDefined()

    // Action should not bubble despite electronAPI rejecting
    await expect(renameItem.action()).resolves.toBeUndefined()

    expect(window.electronAPI.renameFile).toHaveBeenCalledOnce()
    expect(fc.refresh).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('重新命名失敗'))
  })
})

// ── T53: New Folder IPC failure ──────────────────────────────────────────────

describe('T53: mkdirFolder IPC rejection', () => {
  it('should swallow rejection via try/catch and NOT call refresh', async () => {
    if (!FolderCompare) return
    const fc = buildFC()
    fc.refresh = vi.fn().mockResolvedValue(undefined)
    window.electronAPI.mkdirFolder = vi.fn().mockRejectedValue(new Error('EEXIST'))
    window.prompt = vi.fn().mockReturnValue('newdir')
    window.alert = vi.fn()

    const items = openContextMenuForRow(fc, {
      name: 'anything',
      leftPath: '/left/anything',
      status: 'same',
    })
    const mkdirItem = items.find((it) => it.label === '新建資料夾（左側）…')
    expect(mkdirItem).toBeDefined()

    await expect(mkdirItem.action()).resolves.toBeUndefined()

    expect(window.electronAPI.mkdirFolder).toHaveBeenCalledOnce()
    expect(fc.refresh).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('建立失敗'))
  })
})

// ── T54: Find — no match ─────────────────────────────────────────────────────

describe('T54: find with no match', () => {
  it('_computeFindMatches returns [] when query matches no row name', () => {
    if (!FolderCompare) return
    const fc = buildFC()
    const rows = [
      makeRow({ name: 'alpha.txt' }),
      makeRow({ name: 'beta.js' }),
    ]
    expect(fc._computeFindMatches(rows, 'nonexistent')).toEqual([])
  })

  it('findNext is a no-op when no .fc-row--match elements exist', () => {
    if (!FolderCompare) return
    const fc = buildFC()
    fc._findQuery = 'zzz'
    fc._findCursor = 0
    // No fc-row--match in DOM → findNext early-returns
    fc.findNext()
    expect(fc._findCursor).toBe(0)
  })
})

// ── T55: Filter combined state ───────────────────────────────────────────────

describe('T55: combined Left/Right Newer filter (both off)', () => {
  it('hides left-newer rows when _showLeftNewer=false', () => {
    if (!FolderCompare) return
    const fc = buildFC()
    fc._showDiff = true
    fc._showLeftNewer = false
    fc._showRightNewer = false
    const row = makeRow({ name: 'a', status: 'left-newer', leftPath: '/left/a', rightPath: '/right/a' })
    expect(fc._isRowVisible(row)).toBe(false)
  })

  it('hides right-newer rows when _showRightNewer=false', () => {
    if (!FolderCompare) return
    const fc = buildFC()
    fc._showDiff = true
    fc._showLeftNewer = false
    fc._showRightNewer = false
    const row = makeRow({ name: 'b', status: 'right-newer', leftPath: '/left/b', rightPath: '/right/b' })
    expect(fc._isRowVisible(row)).toBe(false)
  })
})

// ── T56: Expand/Collapse recursion guards ────────────────────────────────────

describe('T56: expandAll on mixed rows / collapseAll clears set', () => {
  it('expandAll adds only directory rows to _expanded', () => {
    if (!FolderCompare) return
    const fc = buildFC([
      makeRow({ name: 'src',  status: 'same', leftPath: '/left/src',  rightPath: '/right/src',  isDir: true }),
      makeRow({ name: 'docs', status: 'same', leftPath: '/left/docs', rightPath: '/right/docs', isDir: true }),
      makeRow({ name: 'a.js', status: 'same', leftPath: '/left/a.js', rightPath: '/right/a.js', isDir: false }),
      makeRow({ name: 'b.js', status: 'same', leftPath: '/left/b.js', rightPath: '/right/b.js', isDir: false }),
    ])
    fc._applyFilterAndRender = vi.fn()
    fc.expandAll()
    expect(fc._expanded.size).toBe(2)
  })

  it('collapseAll clears _expanded completely', () => {
    if (!FolderCompare) return
    const fc = buildFC()
    fc._applyFilterAndRender = vi.fn()
    fc._expanded.add('0:/left/x|/right/x')
    fc._expanded.add('0:/left/y|/right/y')
    expect(fc._expanded.size).toBe(2)
    fc.collapseAll()
    expect(fc._expanded.size).toBe(0)
  })
})
