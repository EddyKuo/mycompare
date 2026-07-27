/**
 * @vitest-environment jsdom
 *
 * S16 — Folder Compare 欄位設定 / 排序 / 虛擬捲動
 *
 *   1. 欄位顯示設定：normalizeColumns 正規化與非法值、localStorage 持久化
 *   2. 欄位排序：各欄比較器、目錄優先、反向
 *   3. 可見樹攤平：只包含展開節點、可見性過濾、未載入子項的 loading 標記
 *   4. 虛擬捲動：只渲染視窗內的列
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  FolderCompare,
  FOLDER_COLUMN_DEFS,
  DEFAULT_FOLDER_COLUMNS,
  normalizeColumns,
  loadFolderColumns,
  saveFolderColumns,
  extensionOf,
  entryAttrText,
  entryAttrTitle,
  columnSortValue,
  compareRowsBy,
  sortRows,
  flattenVisibleRows,
} from '../../src/renderer/src/views/folder-compare.js'

const COLUMNS_KEY = 'mycompare:folderColumns'

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @returns {import('../../src/renderer/src/views/folder-compare.js').CompareRow}
 */
function mkRow({
  name = 'file.txt',
  size = 100,
  mtime = '2024-01-01T00:00:00.000Z',
  isDir = false,
  isSymbolicLink = false,
  status = 'same',
  children = null,
  dir = '',
} = {}) {
  const shared = { name, isDirectory: isDir, isSymbolicLink, size, mtime }
  return {
    name,
    status,
    left: { ...shared, path: `/l${dir}/${name}` },
    right: { ...shared, path: `/r${dir}/${name}` },
    children,
  }
}

/** Names in the order a comparator produced. */
const names = (rows) => rows.map((r) => r.name)

function stubElectronAPI() {
  window.electronAPI = {
    readDir: vi.fn().mockResolvedValue([]),
    copyFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    openFolder: vi.fn().mockResolvedValue(null),
    showInExplorer: vi.fn(),
  }
}

/** Mount a FolderCompare with no paths so mount() does not kick off a scan. */
function mountFC() {
  stubElectronAPI()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const fc = new FolderCompare({})
  fc.mount(host)
  return fc
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
})

// ── 1. Column configuration ─────────────────────────────────────────────────

describe('normalizeColumns', () => {
  it('falls back to the default set for non-array input', () => {
    for (const bad of [null, undefined, 'name,size', 42, {}, { columns: ['size'] }]) {
      expect(normalizeColumns(bad)).toEqual(DEFAULT_FOLDER_COLUMNS)
    }
  })

  it('falls back to the default set when nothing recognisable survives', () => {
    expect(normalizeColumns([])).toEqual(DEFAULT_FOLDER_COLUMNS)
    expect(normalizeColumns(['bogus', 'nope'])).toEqual(DEFAULT_FOLDER_COLUMNS)
    expect(normalizeColumns([1, null, {}])).toEqual(DEFAULT_FOLDER_COLUMNS)
  })

  it('always keeps the name column, which carries the tree affordances', () => {
    expect(normalizeColumns(['size'])).toEqual(['name', 'size'])
    expect(normalizeColumns(['attrs'])).toContain('name')
  })

  it('drops unknown ids but keeps the recognised ones', () => {
    expect(normalizeColumns(['ext', 'wat', 'relpath'])).toEqual(['name', 'ext', 'relpath'])
  })

  it('de-duplicates and re-imposes the canonical display order', () => {
    expect(normalizeColumns(['mtime', 'size', 'mtime', 'name'])).toEqual(['name', 'size', 'mtime'])
    expect(normalizeColumns(['attrs', 'ext'])).toEqual(['name', 'ext', 'attrs'])
  })

  it('accepts every declared column', () => {
    const all = FOLDER_COLUMN_DEFS.map((c) => c.id)
    expect(normalizeColumns([...all].reverse())).toEqual(all)
  })
})

describe('folder column persistence', () => {
  it('returns the default set when nothing is stored', () => {
    expect(loadFolderColumns()).toEqual(DEFAULT_FOLDER_COLUMNS)
  })

  it('round-trips a saved set', () => {
    saveFolderColumns(['name', 'ext', 'relpath'])
    expect(loadFolderColumns()).toEqual(['name', 'ext', 'relpath'])
  })

  it('normalises on the way in, so garbage can never be stored', () => {
    expect(saveFolderColumns(['relpath', 'junk'])).toEqual(['name', 'relpath'])
    expect(JSON.parse(localStorage.getItem(COLUMNS_KEY)).columns).toEqual(['name', 'relpath'])
  })

  it('recovers from a corrupt entry', () => {
    localStorage.setItem(COLUMNS_KEY, '{not json')
    expect(loadFolderColumns()).toEqual(DEFAULT_FOLDER_COLUMNS)
  })

  it('recovers from a structurally wrong entry', () => {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify({ __schema: 1, columns: 'size' }))
    expect(loadFolderColumns()).toEqual(DEFAULT_FOLDER_COLUMNS)
  })

  it('tolerates a hand-edited bare array', () => {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(['size', 'name']))
    expect(loadFolderColumns()).toEqual(['name', 'size'])
  })

  it('survives a storage that throws on write', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => saveFolderColumns(['name', 'ext'])).not.toThrow()
    expect(saveFolderColumns(['name', 'ext'])).toEqual(['name', 'ext'])
    spy.mockRestore()
  })
})

describe('FolderCompare column API', () => {
  it('toggles a column on and off and persists each change', () => {
    const fc = mountFC()
    expect(fc.getColumns()).toEqual(DEFAULT_FOLDER_COLUMNS)

    fc.toggleColumn('ext')
    expect(fc.getColumns()).toEqual(['name', 'size', 'mtime', 'ext'])
    expect(loadFolderColumns()).toEqual(['name', 'size', 'mtime', 'ext'])

    fc.toggleColumn('ext')
    expect(fc.getColumns()).toEqual(DEFAULT_FOLDER_COLUMNS)
  })

  it('refuses to drop the name column', () => {
    const fc = mountFC()
    fc.toggleColumn('name')
    expect(fc.getColumns()).toContain('name')
  })

  it('picks up the stored set on construction', () => {
    saveFolderColumns(['name', 'relpath'])
    const fc = mountFC()
    expect(fc.getColumns()).toEqual(['name', 'relpath'])
  })

  it('renders one header cell per visible column, per side', () => {
    const fc = mountFC()
    fc.setColumns(['name', 'size'])
    const header = fc._dom.header
    expect(header.querySelectorAll('[data-column]')).toHaveLength(4)
    expect(header.querySelectorAll('[data-column="mtime"]')).toHaveLength(0)
  })

  it('renders only the visible columns in each row cell', () => {
    const fc = mountFC()
    fc.setColumns(['name', 'ext', 'attrs'])
    fc._rows = [mkRow({ name: 'a.txt' })]
    fc._applyFilterAndRender()

    const cell = fc._dom.list.querySelector('.fc-cell-left')
    expect(cell.querySelector('.fc-name').textContent).toBe('a.txt')
    expect(cell.querySelector('.fc-ext').textContent).toBe('txt')
    expect(cell.querySelector('.fc-size')).toBeNull()
    expect(cell.querySelector('.fc-mtime')).toBeNull()
  })
})

// ── 2. Sorting ──────────────────────────────────────────────────────────────

describe('extensionOf / entryAttrText', () => {
  it('reads the extension without the dot', () => {
    expect(extensionOf('a.TXT')).toBe('txt')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
  })

  it('treats a leading dot as part of the name', () => {
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('Makefile')).toBe('')
    expect(extensionOf(undefined)).toBe('')
  })

  it('reports the flags read-dir returns, marking an unknown hidden bit', () => {
    // `hidden` absent or null means "the platform cannot tell", which must not
    // render the same as a known-false.
    expect(entryAttrText({ isDirectory: true })).toBe('D?')
    expect(entryAttrText({ isSymbolicLink: true })).toBe('L?')
    expect(entryAttrText({ isDirectory: true, isSymbolicLink: true })).toBe('DL?')
    expect(entryAttrText(null)).toBe('')
  })

  it('renders read-only and hidden once read-dir supplies them', () => {
    expect(entryAttrText({ readOnly: true, hidden: false })).toBe('R')
    expect(entryAttrText({ readOnly: false, hidden: true })).toBe('H')
    expect(entryAttrText({ isDirectory: true, readOnly: true, hidden: true })).toBe('DRH')
    expect(entryAttrText({ readOnly: false, hidden: false })).toBe('')
    // Windows reports null: unknown, not "no".
    expect(entryAttrText({ readOnly: false, hidden: null })).toBe('?')
  })

  it('explains every flag in the tooltip, including the unknown case', () => {
    expect(entryAttrTitle({ readOnly: true, hidden: true })).toContain('唯讀')
    expect(entryAttrTitle({ readOnly: true, hidden: true })).toContain('隱藏')
    expect(entryAttrTitle({ readOnly: false, hidden: null })).toContain('未知')
    expect(entryAttrTitle(null)).toBe('')
  })
})

describe('columnSortValue', () => {
  it('reads numeric keys for size and mtime', () => {
    const row = mkRow({ name: 'a', size: 42, mtime: '2024-06-01T00:00:00.000Z' })
    expect(columnSortValue(row, 'size')).toBe(42)
    expect(columnSortValue(row, 'mtime')).toBe(Date.parse('2024-06-01T00:00:00.000Z'))
  })

  it('gives directories no size of their own', () => {
    expect(columnSortValue(mkRow({ name: 'd', isDir: true, size: 4096 }), 'size')).toBe(-1)
  })

  it('degrades gracefully on an unparsable mtime', () => {
    expect(columnSortValue(mkRow({ name: 'a', mtime: 'nonsense' }), 'mtime')).toBe(-1)
  })

  it('falls back to the name for an unknown key', () => {
    expect(columnSortValue(mkRow({ name: 'zz' }), 'wat')).toBe('zz')
  })

  it('uses the right-hand entry when the row is a right orphan', () => {
    const row = mkRow({ name: 'r.txt', size: 7 })
    row.left = null
    expect(columnSortValue(row, 'size')).toBe(7)
  })
})

describe('compareRowsBy / sortRows', () => {
  const tree = () => [
    mkRow({ name: 'b.txt', size: 300, mtime: '2024-03-01T00:00:00.000Z' }),
    mkRow({ name: 'zeta', isDir: true }),
    mkRow({ name: 'a.zip', size: 100, mtime: '2024-05-01T00:00:00.000Z' }),
    mkRow({ name: 'alpha', isDir: true }),
    mkRow({ name: 'c.js', size: 200, mtime: '2024-01-01T00:00:00.000Z' }),
  ]

  it('sorts by name ascending with directories first', () => {
    expect(names(sortRows(tree(), 'name', 1))).toEqual(['alpha', 'zeta', 'a.zip', 'b.txt', 'c.js'])
  })

  it('reverses within each group but keeps directories first', () => {
    expect(names(sortRows(tree(), 'name', -1))).toEqual(['zeta', 'alpha', 'c.js', 'b.txt', 'a.zip'])
  })

  it('sorts by size in both directions', () => {
    expect(names(sortRows(tree(), 'size', 1)).slice(2)).toEqual(['a.zip', 'c.js', 'b.txt'])
    expect(names(sortRows(tree(), 'size', -1)).slice(2)).toEqual(['b.txt', 'c.js', 'a.zip'])
  })

  it('sorts by modification time', () => {
    expect(names(sortRows(tree(), 'mtime', 1)).slice(2)).toEqual(['c.js', 'b.txt', 'a.zip'])
    expect(names(sortRows(tree(), 'mtime', -1)).slice(2)).toEqual(['a.zip', 'b.txt', 'c.js'])
  })

  it('sorts by extension', () => {
    expect(names(sortRows(tree(), 'ext', 1)).slice(2)).toEqual(['c.js', 'b.txt', 'a.zip'])
  })

  it('sorts by relative path', () => {
    const rows = [
      mkRow({ name: 'x.txt', dir: '/zzz' }),
      mkRow({ name: 'y.txt', dir: '/aaa' }),
    ]
    expect(names(sortRows(rows, 'relpath', 1))).toEqual(['y.txt', 'x.txt'])
    expect(names(sortRows(rows, 'relpath', -1))).toEqual(['x.txt', 'y.txt'])
  })

  it('sorts by attributes', () => {
    const rows = [
      mkRow({ name: 'link', isSymbolicLink: true }),
      mkRow({ name: 'plain' }),
    ]
    expect(names(sortRows(rows, 'attrs', 1))).toEqual(['plain', 'link'])
  })

  it('breaks ties on the name so equal values render stably', () => {
    const rows = [
      mkRow({ name: 'b.txt', size: 10 }),
      mkRow({ name: 'a.txt', size: 10 }),
    ]
    expect(names(sortRows(rows, 'size', 1))).toEqual(['a.txt', 'b.txt'])
    // Descending flips the tiebreak too, but directories-first is unaffected.
    expect(names(sortRows(rows, 'size', -1))).toEqual(['b.txt', 'a.txt'])
  })

  it('keeps directories above files regardless of the column', () => {
    const rows = [
      mkRow({ name: 'huge.bin', size: 9_000_000, mtime: '2030-01-01T00:00:00.000Z' }),
      mkRow({ name: 'zzz', isDir: true }),
    ]
    for (const key of ['name', 'size', 'mtime', 'ext', 'relpath', 'attrs']) {
      for (const dir of [1, -1]) {
        expect(names(sortRows(rows, key, dir))[0], `${key}/${dir}`).toBe('zzz')
      }
    }
  })

  it('does not mutate the input array', () => {
    const rows = tree()
    const before = names(rows)
    sortRows(rows, 'size', -1)
    expect(names(rows)).toEqual(before)
  })

  it('keeps row object identity so expand bookkeeping survives a sort', () => {
    const rows = tree()
    expect(sortRows(rows, 'name', 1)).toContain(rows[1])
  })

  it('compareRowsBy is usable standalone', () => {
    const a = mkRow({ name: 'a.txt' })
    const b = mkRow({ name: 'b.txt' })
    expect(compareRowsBy(a, b, 'name', 1)).toBeLessThan(0)
    expect(compareRowsBy(a, b, 'name', -1)).toBeGreaterThan(0)
  })
})

describe('FolderCompare.sortBy', () => {
  it('flips the direction when the active column is asked for again', () => {
    const fc = mountFC()
    expect(fc.getSort()).toEqual({ key: 'name', dir: 1 })
    fc.sortBy('size')
    expect(fc.getSort()).toEqual({ key: 'size', dir: 1 })
    fc.sortBy('size')
    expect(fc.getSort()).toEqual({ key: 'size', dir: -1 })
    fc.sortBy('mtime')
    expect(fc.getSort()).toEqual({ key: 'mtime', dir: 1 })
  })

  it('ignores an empty key', () => {
    const fc = mountFC()
    fc.sortBy('')
    expect(fc.getSort()).toEqual({ key: 'name', dir: 1 })
  })

  it('marks the sorted column in the header', () => {
    const fc = mountFC()
    fc.sortBy('size')
    const sorted = fc._dom.header.querySelectorAll('.fc-col--sorted')
    expect(sorted).toHaveLength(2)  // one per side
    expect(sorted[0].textContent).toContain('▲')
    fc.sortBy('size')
    expect(fc._dom.header.querySelector('.fc-col--sorted').textContent).toContain('▼')
  })

  it('reorders the rendered rows', () => {
    const fc = mountFC()
    fc._rows = [
      mkRow({ name: 'a.txt', size: 500 }),
      mkRow({ name: 'b.txt', size: 100 }),
    ]
    fc.sortBy('size')
    expect(fc._visibleRows.map((f) => f.row.name)).toEqual(['b.txt', 'a.txt'])
    fc.sortBy('size')
    expect(fc._visibleRows.map((f) => f.row.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('clicking a header column sorts by it', () => {
    const fc = mountFC()
    fc._dom.header.querySelector('[data-column="mtime"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(fc.getSort().key).toBe('mtime')
  })
})

// ── 3. Visible-tree flattening ──────────────────────────────────────────────

describe('flattenVisibleRows', () => {
  const build = () => [
    mkRow({
      name: 'dir',
      isDir: true,
      children: [
        mkRow({ name: 'child-a.txt', dir: '/dir' }),
        mkRow({ name: 'child-b.txt', dir: '/dir' }),
      ],
    }),
    mkRow({ name: 'top.txt' }),
  ]

  it('omits children of collapsed directories', () => {
    const flat = flattenVisibleRows(build())
    expect(flat.map((f) => f.row.name)).toEqual(['dir', 'top.txt'])
    expect(flat[0].expanded).toBe(false)
  })

  it('includes children of expanded directories with the right depth', () => {
    const flat = flattenVisibleRows(build(), { isExpanded: (row) => row.name === 'dir' })
    expect(flat.map((f) => f.row.name)).toEqual(['dir', 'child-a.txt', 'child-b.txt', 'top.txt'])
    expect(flat.map((f) => f.depth)).toEqual([0, 1, 1, 0])
  })

  it('recurses through several levels', () => {
    const rows = [
      mkRow({
        name: 'l1',
        isDir: true,
        children: [
          mkRow({ name: 'l2', isDir: true, children: [mkRow({ name: 'leaf.txt' })] }),
        ],
      }),
    ]
    const flat = flattenVisibleRows(rows, { isExpanded: () => true })
    expect(flat.map((f) => f.depth)).toEqual([0, 1, 2])
    expect(flat.map((f) => f.row.name)).toEqual(['l1', 'l2', 'leaf.txt'])
  })

  it('never expands a file row even if the predicate says yes', () => {
    const flat = flattenVisibleRows([mkRow({ name: 'plain.txt' })], { isExpanded: () => true })
    expect(flat[0].expanded).toBe(false)
    expect(flat[0].loading).toBe(false)
  })

  it('marks an expanded directory whose children have not arrived as loading', () => {
    const rows = [mkRow({ name: 'dir', isDir: true, children: null })]
    const flat = flattenVisibleRows(rows, { isExpanded: () => true })
    expect(flat).toHaveLength(1)
    expect(flat[0].loading).toBe(true)
  })

  it('does not mark a loaded-but-empty directory as loading', () => {
    const rows = [mkRow({ name: 'dir', isDir: true, children: [] })]
    const flat = flattenVisibleRows(rows, { isExpanded: () => true })
    expect(flat[0].loading).toBe(false)
  })

  it('applies the visibility predicate at every level', () => {
    const flat = flattenVisibleRows(build(), {
      isExpanded: () => true,
      isVisible: (row) => row.name !== 'child-a.txt',
    })
    expect(flat.map((f) => f.row.name)).toEqual(['dir', 'child-b.txt', 'top.txt'])
  })

  it('hides a whole subtree when the parent is filtered out', () => {
    const flat = flattenVisibleRows(build(), {
      isExpanded: () => true,
      isVisible: (row) => row.name !== 'dir',
    })
    expect(flat.map((f) => f.row.name)).toEqual(['top.txt'])
  })

  it('applies the sort at every level', () => {
    const flat = flattenVisibleRows(build(), {
      isExpanded: () => true,
      sort: (rows) => sortRows(rows, 'name', -1),
    })
    expect(flat.map((f) => f.row.name)).toEqual(['dir', 'child-b.txt', 'child-a.txt', 'top.txt'])
  })

  it('handles null / empty input', () => {
    expect(flattenVisibleRows(null)).toEqual([])
    expect(flattenVisibleRows([])).toEqual([])
  })
})

// ── 4. Virtual scrolling ────────────────────────────────────────────────────

describe('FolderCompare virtual list', () => {
  /** @param {number} n */
  const manyRows = (n) =>
    Array.from({ length: n }, (_, i) => mkRow({ name: `f${String(i).padStart(4, '0')}.txt` }))

  it('sizes the scroll surface to the whole flattened tree', () => {
    const fc = mountFC()
    fc._rows = manyRows(500)
    fc._applyFilterAndRender()
    expect(fc._visibleRows).toHaveLength(500)
    expect(fc._dom.vlist.style.height).toBe(`${500 * 22}px`)
  })

  it('renders only a window of rows, not the whole tree', () => {
    const fc = mountFC()
    fc._rows = manyRows(500)
    fc._applyFilterAndRender()
    const rendered = fc._dom.list.querySelectorAll('.fc-row')
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(100)
  })

  it('positions each rendered row at its flattened index', () => {
    const fc = mountFC()
    fc._rows = manyRows(50)
    fc._applyFilterAndRender()
    const first = fc._dom.list.querySelector('.fc-row')
    expect(first.dataset.flatIndex).toBe('0')
    expect(first.style.top).toBe('0px')
    const third = fc._dom.list.querySelectorAll('.fc-row')[2]
    expect(third.style.top).toBe(`${2 * 22}px`)
  })

  it('scrolling moves the window rather than growing the DOM', () => {
    const fc = mountFC()
    fc._rows = manyRows(2000)
    fc._applyFilterAndRender()
    const before = fc._dom.list.querySelectorAll('.fc-row').length

    fc._dom.list.scrollTop = 1000 * 22
    fc._renderWindow()

    const after = fc._dom.list.querySelectorAll('.fc-row')
    expect(after.length).toBe(before)
    expect(Number(after[0].dataset.flatIndex)).toBeGreaterThan(900)
  })

  it('virtualises an expanded subtree as one flat sequence', () => {
    const fc = mountFC()
    fc._rows = [
      mkRow({ name: 'dir', isDir: true, children: manyRows(300) }),
      mkRow({ name: 'zzz.txt' }),
    ]
    fc._expanded.add(fc._expandKey(0, fc._rows[0]))
    fc._applyFilterAndRender()

    expect(fc._visibleRows).toHaveLength(302)
    // The trailing top-level row sits after the whole expanded subtree.
    expect(fc._visibleRows[301].row.name).toBe('zzz.txt')
    expect(fc._visibleRows[301].depth).toBe(0)
    expect(fc._dom.list.querySelectorAll('.fc-row').length).toBeLessThan(302)
  })

  it('shows the empty state instead of a scroll surface when nothing matches', () => {
    const fc = mountFC()
    fc._rows = manyRows(3)
    fc._showSame = false
    fc._applyFilterAndRender()
    expect(fc._dom.vlist).toBeNull()
    expect(fc._dom.list.querySelector('.fc-empty-state')).not.toBeNull()
  })

  it('renders a placeholder row for a directory whose children are pending', () => {
    const fc = mountFC()
    fc._rows = [mkRow({ name: 'dir', isDir: true, children: null })]
    fc._expanded.add(fc._expandKey(0, fc._rows[0]))
    fc._applyFilterAndRender()
    expect(fc._dom.list.querySelector('.fc-row--loading')).not.toBeNull()
  })
})

// ── Ctrl+R / Ctrl+L copy ────────────────────────────────────────────────────

describe('FolderCompare.copySelectedTo', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })

  it('copies the checked rows to the right side', async () => {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [mkRow({ name: 'a.txt' }), mkRow({ name: 'b.txt' })]
    fc._selectedNames.add('/l/a.txt')
    fc.refresh = vi.fn()

    await fc.copySelectedTo('right')

    expect(window.electronAPI.copyFile).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.copyFile).toHaveBeenCalledWith('/l/a.txt', '/r/a.txt')
  })

  it('copies the focused row when nothing is checked', async () => {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [mkRow({ name: 'a.txt' })]
    fc._focusedKey = '/l/a.txt'
    fc.refresh = vi.fn()

    await fc.copySelectedTo('left')

    expect(window.electronAPI.copyFile).toHaveBeenCalledWith('/r/a.txt', '/l/a.txt')
  })

  it('skips directories and does nothing when the selection yields no files', async () => {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [mkRow({ name: 'dir', isDir: true })]
    fc._selectedNames.add('/l/dir')
    fc.refresh = vi.fn()

    await fc.copySelectedTo('right')

    expect(window.electronAPI.copyFile).not.toHaveBeenCalled()
  })

  it('reaches rows nested inside an expanded directory', async () => {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [mkRow({
      name: 'dir',
      isDir: true,
      children: [mkRow({ name: 'deep.txt', dir: '/dir' })],
    })]
    fc._selectedNames.add('/l/dir/deep.txt')
    fc.refresh = vi.fn()

    await fc.copySelectedTo('right')

    expect(window.electronAPI.copyFile).toHaveBeenCalledWith('/l/dir/deep.txt', '/r/dir/deep.txt')
  })

  it('bails out when the target side has no folder open', async () => {
    const fc = mountFC()
    fc._rows = [mkRow({ name: 'a.txt' })]
    fc._selectedNames.add('/l/a.txt')
    await fc.copySelectedTo('right')
    expect(window.electronAPI.copyFile).not.toHaveBeenCalled()
  })
})
