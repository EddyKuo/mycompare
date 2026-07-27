/**
 * @vitest-environment jsdom
 *
 * Folder Compare — the four Options preferences that the dialog stored and
 * nothing read back.
 *
 * The load-bearing property of every test here is *not* "the function behaves
 * correctly"; it is "the stored value reaches the behaviour at all". Each one
 * therefore drives the real entry point (a delete, a scan, a render) with the
 * preference written through the same SettingsStore the Options dialog uses,
 * and asserts on the observable outcome — the IPC call, the model's `_expanded`
 * set, the flattened row order — rather than on a getter.
 *
 * The recycle-bin polarity is the reason two of these are assertions on
 * `deleteFile`'s exact arguments: `{ permanent: true }` when the user asked
 * for the bin is unrecoverable data loss, and only the argument proves it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { SettingsStore, DEFAULT_PREFS } from '../../src/renderer/src/core/settings-store.js'
import { setActiveView } from '../../src/renderer/src/core/active-view.js'
import {
  FolderCompare,
  sortRows,
  compareRowsBy,
} from '../../src/renderer/src/views/folder-compare.js'

vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: () => {},
}))

const settings = new SettingsStore()

/** @type {string[]} */
let alerts = []
/** @type {string[]} */
let confirms = []
/** @type {FolderCompare[]} */
let mountedViews = []

beforeEach(() => {
  alerts = []
  confirms = []
  vi.stubGlobal('alert', (msg) => { alerts.push(String(msg)) })
  vi.stubGlobal('confirm', (msg) => { confirms.push(String(msg)); return false })
  localStorage.clear()
  setActiveView('folder')
})

afterEach(() => {
  for (const fc of mountedViews) fc.destroy()
  mountedViews = []
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  delete window.electronAPI
})

/**
 * @param {object} [over]
 * @returns {object} the stubbed electronAPI
 */
function stubApi(over = {}) {
  const api = {
    readDir: vi.fn().mockResolvedValue([]),
    openFolder: vi.fn().mockResolvedValue(null),
    copyFile: vi.fn().mockResolvedValue({ copied: true }),
    deleteFile: vi.fn().mockResolvedValue({ deleted: true, permanent: false }),
    renameFile: vi.fn().mockResolvedValue(undefined),
    mkdirFolder: vi.fn().mockResolvedValue(undefined),
    showInExplorer: vi.fn(),
    hashFile: vi.fn().mockResolvedValue('h'),
    ...over,
  }
  window.electronAPI = api
  return api
}

/**
 * A really-mounted view; the toolbar, the virtual list and the document-level
 * key handlers all exist, which is what makes these end-to-end within the view.
 * @param {object} [options]
 * @returns {FolderCompare}
 */
function mounted(options = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const fc = new FolderCompare(options)
  fc.mount(host)
  mountedViews.push(fc)
  return fc
}

/**
 * @param {string} name
 * @param {object} [over]
 * @returns {object} a FileEntry
 */
function entry(name, over = {}) {
  return {
    name,
    path: `/left/${name}`,
    isDirectory: false,
    size: 10,
    mtime: '2024-01-01T00:00:00.000Z',
    ...over,
  }
}

/**
 * A two-sided row whose left entry is a plain, writable file.
 * @param {string} name
 * @returns {object} a CompareRow
 */
function fileRow(name) {
  return {
    name,
    status: 'left-only',
    left: entry(name),
    right: null,
    children: null,
  }
}

// ── 1. folderConfirmDelete ──────────────────────────────────────────────────

describe('folderConfirmDelete', () => {
  it('預設為 true', () => {
    expect(DEFAULT_PREFS.folderConfirmDelete).toBe(true)
  })

  it('開啟（預設）時仍會先顯示確認對話框', async () => {
    const api = stubApi()
    const fc = mounted({ leftPath: '/left' })
    const dialog = vi.spyOn(fc, '_confirmDelete')
      .mockResolvedValue({ ok: true, permanent: false })

    await fc._runDelete([{ path: '/left/a.txt' }])

    expect(dialog).toHaveBeenCalledTimes(1)
    expect(api.deleteFile).toHaveBeenCalledWith('/left/a.txt', undefined)
  })

  it('關閉時直接刪除，完全不顯示對話框', async () => {
    settings.setPref('folderConfirmDelete', false)
    const api = stubApi()
    const fc = mounted({ leftPath: '/left' })
    const dialog = vi.spyOn(fc, '_confirmDelete')

    const deleted = await fc._runDelete([{ path: '/left/a.txt' }])

    expect(dialog).not.toHaveBeenCalled()
    expect(deleted).toBe(true)
    expect(api.deleteFile).toHaveBeenCalledWith('/left/a.txt', undefined)
    // Nothing in the DOM either — a dialog that renders and auto-dismisses
    // would still steal focus.
    expect(document.querySelector('.fc-modal-backdrop')).toBeNull()
  })

  it('關閉時不再以 alert 打斷，但仍記在狀態列與紀錄面板', async () => {
    settings.setPref('folderConfirmDelete', false)
    stubApi()
    const fc = mounted({ leftPath: '/left' })
    vi.spyOn(fc, '_confirmDelete')

    await fc._runDelete([{ path: '/left/a.txt' }])

    // A silent delete that leaves no trace is the failure this guards against.
    expect(alerts).toEqual([])
    expect(fc.getLog().join('\n')).toMatch(/已移至資源回收桶：1 項/)
  })

  it('關閉確認時不會自作主張改為永久刪除', async () => {
    // The recycle bin is unavailable, which normally prompts "delete
    // permanently instead?". With confirmations off that escalation must not
    // happen silently: the files are left alone and the failure is reported.
    settings.setPref('folderConfirmDelete', false)
    const api = stubApi({
      deleteFile: vi.fn().mockRejectedValue(new Error('無法移至資源回收桶：ENOSYS')),
    })
    const fc = mounted({ leftPath: '/left' })

    const deleted = await fc._runDelete([{ path: '/left/a.txt' }])

    expect(deleted).toBe(false)
    expect(confirms).toEqual([])
    expect(api.deleteFile).toHaveBeenCalledTimes(1)
    expect(api.deleteFile).not.toHaveBeenCalledWith('/left/a.txt', { permanent: true })
    expect(fc.getLog().join('\n')).toMatch(/ENOSYS/)
  })
})

// ── 2. folderUseRecycleBin ──────────────────────────────────────────────────

describe('folderUseRecycleBin', () => {
  it('預設為 true', () => {
    expect(DEFAULT_PREFS.folderUseRecycleBin).toBe(true)
  })

  it('開啟時預設不永久刪除——不傳 options 就是回收桶請求', async () => {
    settings.setPref('folderUseRecycleBin', true)
    settings.setPref('folderConfirmDelete', false)
    const api = stubApi()
    const fc = mounted({ leftPath: '/left' })

    await fc._runDelete([{ path: '/left/a.txt' }])

    expect(api.deleteFile).toHaveBeenCalledWith('/left/a.txt', undefined)
  })

  it('關閉時才永久刪除', async () => {
    settings.setPref('folderUseRecycleBin', false)
    settings.setPref('folderConfirmDelete', false)
    const api = stubApi({
      deleteFile: vi.fn().mockResolvedValue({ deleted: true, permanent: true }),
    })
    const fc = mounted({ leftPath: '/left' })

    await fc._runDelete([{ path: '/left/a.txt' }])

    expect(api.deleteFile).toHaveBeenCalledWith('/left/a.txt', { permanent: true })
  })

  it('極性：勾選「使用回收桶」永遠不會傳 permanent:true', async () => {
    // Stated as its own test because getting this backwards destroys files the
    // user explicitly asked to keep recoverable.
    settings.setPref('folderUseRecycleBin', true)
    settings.setPref('folderConfirmDelete', false)
    const api = stubApi()
    const fc = mounted({ leftPath: '/left' })

    await fc._runDelete([{ path: '/a' }, { path: '/b' }, { path: '/c' }])

    for (const call of api.deleteFile.mock.calls) {
      expect(call[1]).toBeUndefined()
    }
  })

  it('偏好設定成為確認對話框的預設勾選狀態', async () => {
    settings.setPref('folderUseRecycleBin', false)
    stubApi()
    const fc = mounted({ leftPath: '/left' })
    const dialog = vi.spyOn(fc, '_confirmDelete')
      .mockResolvedValue({ ok: false, permanent: true })

    await fc._runDelete([{ path: '/left/a.txt' }])

    expect(dialog).toHaveBeenCalledWith(['/left/a.txt'],
      expect.objectContaining({ permanent: true }))
  })

  it('對話框的預設勾選在偏好為「使用回收桶」時是未勾選', async () => {
    settings.setPref('folderUseRecycleBin', true)
    stubApi()
    const fc = mounted({ leftPath: '/left' })
    const dialog = vi.spyOn(fc, '_confirmDelete')
      .mockResolvedValue({ ok: false, permanent: false })

    await fc._runDelete([{ path: '/left/a.txt' }])

    expect(dialog).toHaveBeenCalledWith(['/left/a.txt'],
      expect.objectContaining({ permanent: false }))
  })

  it('Shift+Delete 仍可覆寫偏好，但一般 Delete 不會覆寫', async () => {
    // The keyboard path always passes a boolean, so `opts.permanent ?? pref`
    // would let a plain Delete silently undo a stored "never use the bin".
    settings.setPref('folderUseRecycleBin', false)
    settings.setPref('folderConfirmDelete', false)
    const api = stubApi({
      deleteFile: vi.fn().mockResolvedValue({ deleted: true, permanent: true }),
    })
    const fc = mounted({ leftPath: '/left' })
    // _runDelete refreshes on success, and the stubbed readDir returns nothing,
    // so the row has to be put back before each attempt.
    const arm = () => {
      fc._rows = [fileRow('a.txt')]
      fc._selectedNames = new Set(['/left/a.txt'])
    }

    arm()
    await fc.deleteSelected({ permanent: false })
    expect(api.deleteFile).toHaveBeenLastCalledWith('/left/a.txt', { permanent: true })

    settings.setPref('folderUseRecycleBin', true)
    arm()
    await fc.deleteSelected({ permanent: true })
    expect(api.deleteFile).toHaveBeenLastCalledWith('/left/a.txt', { permanent: true })

    arm()
    await fc.deleteSelected({ permanent: false })
    expect(api.deleteFile).toHaveBeenLastCalledWith('/left/a.txt', undefined)
    expect(api.deleteFile).toHaveBeenCalledTimes(3)
  })
})

// ── 3. folderExpandOnOpen ───────────────────────────────────────────────────

describe('folderExpandOnOpen', () => {
  /**
   * Two folder pairs, each holding one file, on both sides — deep enough that
   * "expanded" is distinguishable from "top level rendered".
   * @returns {object} an electronAPI stub
   */
  function stubTree() {
    /** @type {Record<string, object[]>} */
    const dirs = {
      '/left':       [{ name: 'sub', path: '/left/sub', isDirectory: true, size: 0, mtime: '2024-01-01T00:00:00.000Z' }],
      '/right':      [{ name: 'sub', path: '/right/sub', isDirectory: true, size: 0, mtime: '2024-01-01T00:00:00.000Z' }],
      '/left/sub':   [{ name: 'deep', path: '/left/sub/deep', isDirectory: true, size: 0, mtime: '2024-01-01T00:00:00.000Z' }],
      '/right/sub':  [{ name: 'deep', path: '/right/sub/deep', isDirectory: true, size: 0, mtime: '2024-01-01T00:00:00.000Z' }],
      '/left/sub/deep':  [entry('x.txt', { path: '/left/sub/deep/x.txt' })],
      '/right/sub/deep': [entry('x.txt', { path: '/right/sub/deep/x.txt' })],
    }
    return stubApi({ readDir: vi.fn(async (p) => dirs[p] ?? []) })
  }

  it('預設為 false', () => {
    expect(DEFAULT_PREFS.folderExpandOnOpen).toBe(false)
  })

  it('關閉（預設）時掃描後只展開頂層', async () => {
    stubTree()
    const fc = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'

    await fc.refresh()

    expect(fc._expanded.size).toBe(0)
    expect(fc._visibleRows.map((r) => r.row.name)).toEqual(['sub'])
  })

  it('開啟時掃描後整棵樹已展開，且狀態在模型上而非 DOM', async () => {
    settings.setPref('folderExpandOnOpen', true)
    stubTree()
    const fc = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'

    await fc.refresh()

    // `_expanded` is the model; the rows are virtualised, so anything stored
    // only in the DOM would be gone by the next repaint.
    expect(fc._expanded.size).toBeGreaterThan(0)
    expect(fc._visibleRows.map((r) => r.row.name)).toEqual(['sub', 'deep', 'x.txt'])

    // Survives a repaint, which a DOM-only flag would not.
    fc._applyFilterAndRender()
    expect(fc._visibleRows.map((r) => r.row.name)).toEqual(['sub', 'deep', 'x.txt'])
  })

  it('開啟時真的把子項讀進模型，而不只是設旗標', async () => {
    settings.setPref('folderExpandOnOpen', true)
    const api = stubTree()
    const fc = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'

    await fc.refresh()

    // The children are in the tree, so the report and the statistics see them.
    expect(fc._rows[0].children?.[0]?.name).toBe('deep')
    expect(fc._rows[0].children?.[0]?.children?.[0]?.name).toBe('x.txt')
    expect(api.readDir).toHaveBeenCalledWith('/left/sub/deep')
  })
})

// ── 4. folderShowFoldersFirst ───────────────────────────────────────────────

describe('folderShowFoldersFirst', () => {
  /** Names chosen so the alphabetical order interleaves folders and files. */
  const SORT_KEYS = ['name', 'size', 'mtime', 'ext', 'status', 'relpath', 'abspath']

  /** @returns {object[]} */
  function mixedTree() {
    /**
     * @param {string} name
     * @param {boolean} isDirectory
     * @param {number} size
     * @param {string} mtime
     * @returns {object}
     */
    const row = (name, isDirectory, size, mtime) => ({
      name,
      status: 'same',
      left: { name, path: `/left/${name}`, isDirectory, size, mtime },
      right: { name, path: `/right/${name}`, isDirectory, size, mtime },
      children: isDirectory ? [] : null,
    })
    return [
      row('b.txt', false, 30, '2024-01-03T00:00:00.000Z'),
      row('a_dir', true, 0, '2024-01-01T00:00:00.000Z'),
      row('c.js', false, 10, '2024-01-02T00:00:00.000Z'),
      row('z_dir', true, 0, '2024-01-04T00:00:00.000Z'),
    ]
  }

  /**
   * @param {object[]} rows
   * @returns {boolean[]} isDirectory per row, in order
   */
  const dirFlags = (rows) => rows.map((r) => !!r.left.isDirectory)

  it('預設為 true', () => {
    expect(DEFAULT_PREFS.folderShowFoldersFirst).toBe(true)
  })

  it('開啟（預設）時，每個排序欄與兩個方向都是資料夾在前', () => {
    for (const key of SORT_KEYS) {
      for (const dir of [1, -1]) {
        const flags = dirFlags(sortRows(mixedTree(), key, dir, true))
        expect(flags, `${key}/${dir}`).toEqual([true, true, false, false])
      }
    }
  })

  it('開啟時，群組內仍套用原本的排序', () => {
    const names = (rows) => rows.map((r) => r.name)
    expect(names(sortRows(mixedTree(), 'name', 1, true)))
      .toEqual(['a_dir', 'z_dir', 'b.txt', 'c.js'])
    expect(names(sortRows(mixedTree(), 'name', -1, true)))
      .toEqual(['z_dir', 'a_dir', 'c.js', 'b.txt'])
    // Descending reverses within each group; it does not flip files above
    // folders.
    expect(names(sortRows(mixedTree(), 'size', -1, true)).slice(2))
      .toEqual(['b.txt', 'c.js'])
  })

  it('關閉時資料夾與檔案混排，依欄位值決定', () => {
    const names = (rows) => rows.map((r) => r.name)
    expect(names(sortRows(mixedTree(), 'name', 1, false)))
      .toEqual(['a_dir', 'b.txt', 'c.js', 'z_dir'])
    expect(names(sortRows(mixedTree(), 'name', -1, false)))
      .toEqual(['z_dir', 'c.js', 'b.txt', 'a_dir'])
  })

  it('compareRowsBy 的旗標直接改變兩列的相對順序', () => {
    const [file, dir] = [mixedTree()[0], mixedTree()[3]]  // 'b.txt' vs 'z_dir'
    expect(compareRowsBy(file, dir, 'name', 1, true)).toBeGreaterThan(0)
    expect(compareRowsBy(file, dir, 'name', 1, false)).toBeLessThan(0)
  })

  it('視圖從偏好設定讀取，未設定時視為開啟', () => {
    stubApi()
    const fc = mounted()
    expect(fc._foldersFirst()).toBe(true)

    settings.setPref('folderShowFoldersFirst', false)
    expect(fc._foldersFirst()).toBe(false)

    settings.setPref('folderShowFoldersFirst', true)
    expect(fc._foldersFirst()).toBe(true)
  })

  it('偏好關閉後，實際渲染出來的列順序就是混排的', () => {
    settings.setPref('folderShowFoldersFirst', false)
    stubApi()
    const fc = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    fc._rows = mixedTree()

    fc._applyFilterAndRender()
    expect(fc._visibleRows.map((r) => r.row.name))
      .toEqual(['a_dir', 'b.txt', 'c.js', 'z_dir'])

    // The preference is read at render time, so flipping it takes effect on an
    // already-open comparison without a rescan.
    settings.setPref('folderShowFoldersFirst', true)
    fc._applyFilterAndRender()
    expect(fc._visibleRows.map((r) => r.row.name))
      .toEqual(['a_dir', 'z_dir', 'b.txt', 'c.js'])
  })

  it('每個排序欄、兩個方向，經由視圖都成立', () => {
    stubApi()
    const fc = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    /** @param {object[]} rows */
    const names = (rows) => rows.map((r) => r.name)

    for (const key of SORT_KEYS) {
      for (const dir of [1, -1]) {
        for (const foldersFirst of [true, false]) {
          settings.setPref('folderShowFoldersFirst', foldersFirst)
          fc._rows = mixedTree()
          fc._sortKey = key
          fc._sortDir = dir
          fc._applyFilterAndRender()
          // Asserted against the comparator rather than against a fixed order:
          // for `size` and `mtime` a directory's sort value already puts it
          // first, so "the two settings differ" is not true for every column —
          // but "the view uses the setting" is.
          expect(fc._visibleRows.map((r) => r.row.name), `${key}/${dir}/${foldersFirst}`)
            .toEqual(names(sortRows(mixedTree(), key, dir, foldersFirst)))
        }

        // On the columns where the setting is observable, the grouping is
        // exactly what changes.
        // `ext` is excluded for the same reason as `size`: a directory has no
        // extension, so its sort value already leads.
        if (key === 'name' || key === 'relpath' || key === 'abspath') {
          settings.setPref('folderShowFoldersFirst', true)
          fc._applyFilterAndRender()
          expect(fc._visibleRows.map((r) => !!r.row.left.isDirectory), `on ${key}/${dir}`)
            .toEqual([true, true, false, false])

          settings.setPref('folderShowFoldersFirst', false)
          fc._applyFilterAndRender()
          expect(fc._visibleRows.map((r) => !!r.row.left.isDirectory), `off ${key}/${dir}`)
            .not.toEqual([true, true, false, false])
        }
      }
    }
  })
})
