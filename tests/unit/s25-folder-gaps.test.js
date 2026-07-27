/**
 * @vitest-environment jsdom
 *
 * S25 — 資料夾比對的十項缺口。
 *
 * 每一項都同時斷言兩件事：行為對不對，以及**使用者到不到得了**。
 * 這個專案已經九次以上出現「模組完整、單元測試齊全、但沒有任何呼叫端」的功能，
 * 所以下面每個 describe 都有一條「入口」測試，去工具列／批次選單／右鍵選單裡
 * 真的找出那個項目並點下去。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { setActiveView } from '../../src/renderer/src/core/active-view.js'
import {
  FolderCompare,
  parseSizeInput,
  parseDateInput,
  normalizeOtherFilters,
  otherFiltersActive,
  matchesOtherFilters,
  EMPTY_OTHER_FILTERS,
  normalizeArchiveOptions,
  isArchiveName,
  classifyArchivePair,
  pairFlatEntries,
  buildSyncOps,
  syncModeLabel,
} from '../../src/renderer/src/views/folder-compare.js'

/** Items handed to the shared context menu by the last right-click. */
let menuItems = []
vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: (_e, items) => { menuItems = items },
  closeContextMenu: () => {},
}))

/** @type {string[]} */
let alerts = []
/** @type {string[]} */
let confirms = []
/** @type {boolean|((msg: string) => boolean)} */
let confirmAnswer = true

beforeEach(() => {
  alerts = []
  confirms = []
  menuItems = []
  confirmAnswer = true
  vi.stubGlobal('alert', (msg) => { alerts.push(String(msg)) })
  vi.stubGlobal('confirm', (msg) => {
    confirms.push(String(msg))
    return typeof confirmAnswer === 'function' ? confirmAnswer(String(msg)) : confirmAnswer
  })
  localStorage.clear()
  setActiveView('folder')
})

let mountedViews = []

afterEach(() => {
  for (const fc of mountedViews) fc.destroy()
  mountedViews = []
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** @param {object} over */
function stubApi(over = {}) {
  const api = {
    readDir: vi.fn().mockResolvedValue([]),
    openFolder: vi.fn().mockResolvedValue({ path: '/dest' }),
    openFileBinary: vi.fn().mockResolvedValue(null),
    readArchive: vi.fn().mockResolvedValue({ format: 'zip', entries: [] }),
    readMetadata: vi.fn().mockResolvedValue(null),
    copyFile: vi.fn().mockResolvedValue({ copied: true }),
    deleteFile: vi.fn().mockResolvedValue({ deleted: true, permanent: false }),
    renameFile: vi.fn().mockResolvedValue(undefined),
    mkdirFolder: vi.fn().mockResolvedValue(undefined),
    setMtime: vi.fn().mockResolvedValue(undefined),
    hashFile: vi.fn().mockResolvedValue('h'),
    showInExplorer: vi.fn(),
    openWith: vi.fn().mockResolvedValue({ opened: true }),
    ...over,
  }
  window.electronAPI = api
  return api
}

function mounted(options = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const fc = new FolderCompare(options)
  fc.mount(host)
  mountedViews.push(fc)
  return { fc, host }
}

/** @param {object} o */
function entry(o = {}) {
  return {
    name: o.name ?? 'a.txt',
    path: o.path ?? '/left/a.txt',
    isDirectory: !!o.isDirectory,
    size: o.size ?? 10,
    mtime: o.mtime ?? '2024-01-01T00:00:00.000Z',
    readOnly: !!o.readOnly,
    ...(o.hidden === undefined ? {} : { hidden: o.hidden }),
  }
}

/**
 * A row with whatever sides were named.
 * @param {object} o
 */
function row(o = {}) {
  return {
    name: o.name ?? 'a.txt',
    status: o.status ?? 'different',
    left: o.left === null ? null : entry({ name: o.name, path: `/left/${o.name ?? 'a.txt'}`, ...o.left }),
    right: o.right === null ? null : entry({ name: o.name, path: `/right/${o.name ?? 'a.txt'}`, ...o.right }),
    children: o.children ?? null,
  }
}

/** Labels of the toolbar's 進階選取 dropdown. */
function selectMenuLabels(host) {
  return [...host.querySelectorAll('.fc-select-item')].map((b) => b.textContent)
}

/** Labels of the toolbar's 批次操作 dropdown. */
function batchMenuLabels(host) {
  return [...host.querySelectorAll('.fc-batch-item')].map((b) => b.textContent)
}

/** Right-click the first rendered row and return the menu labels. */
function openRowMenu(host) {
  const rowEl = host.querySelector('.fc-row')
  expect(rowEl).toBeTruthy()
  rowEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
  return menuItems
}

// ── 1. Select All Files ─────────────────────────────────────────────────────

describe('Select All Files（只選檔案，不選資料夾）', () => {
  it('選取所有檔案並跳過資料夾，含已展開的子項', () => {
    const { fc } = mounted()
    fc._rows = [
      row({ name: 'dir', left: { isDirectory: true, path: '/left/dir' }, right: { isDirectory: true, path: '/right/dir' },
        children: [row({ name: 'deep.txt', left: { path: '/left/dir/deep.txt' }, right: { path: '/right/dir/deep.txt' } })] }),
      row({ name: 'a.txt' }),
      row({ name: 'b.txt', right: null, status: 'left-only' }),
    ]

    const count = fc.selectAllFiles()

    expect(count).toBe(3)
    expect([...fc._selectedNames].sort())
      .toEqual(['/left/a.txt', '/left/b.txt', '/left/dir/deep.txt'])
  })

  it('與工具列的「全選」不同：全選會連資料夾一起勾', () => {
    const { fc } = mounted()
    fc._rows = [
      row({ name: 'dir', left: { isDirectory: true, path: '/left/dir' }, right: { isDirectory: true, path: '/right/dir' } }),
      row({ name: 'a.txt' }),
    ]
    fc._applyFilterAndRender()

    fc._dom.cbSelectAll.checked = true
    fc._dom.cbSelectAll.dispatchEvent(new Event('change'))
    expect(fc._selectedNames.size).toBe(2)

    fc.selectAllFiles()
    expect([...fc._selectedNames]).toEqual(['/left/a.txt'])
  })

  it('入口：進階選取下拉與右鍵選單都有這一項，點下去真的會選取', () => {
    const { fc, host } = mounted()
    fc._rows = [row({ name: 'a.txt' })]
    fc._applyFilterAndRender()

    expect(selectMenuLabels(host)).toContain('選取全部檔案（不含資料夾）')

    const item = host.querySelector('.fc-select-item[data-action="select-all-files"]')
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(fc._selectedNames.has('/left/a.txt')).toBe(true)

    fc._selectedNames.clear()
    const labels = openRowMenu(host).filter((i) => !i.separator).map((i) => i.label)
    expect(labels).toContain('選取全部檔案（不含資料夾）')
  })

  it('入口：兩側孤兒的選取也補上了', () => {
    const { fc, host } = mounted()
    fc._rows = [
      row({ name: 'l.txt', right: null, status: 'left-only' }),
      row({ name: 'r.txt', left: null, status: 'right-only' }),
      row({ name: 'same.txt', status: 'same' }),
    ]
    expect(selectMenuLabels(host)).toContain('選取兩側孤兒')
    fc.selectOrphansBoth()
    expect([...fc._selectedNames].sort()).toEqual(['/left/l.txt', '/right/r.txt'])
  })
})

// ── 2. Move to Folder ───────────────────────────────────────────────────────

describe('Move to Folder（移動到任意資料夾）', () => {
  it('rename 成功即完成，並先建立目的地的子資料夾', async () => {
    const api = stubApi({ openFolder: vi.fn().mockResolvedValue({ path: 'D:\\out' }) })
    const { fc } = mounted({ leftPath: 'D:\\left', rightPath: 'D:\\right' })
    fc._leftPath = 'D:\\left'
    fc._rightPath = 'D:\\right'
    const r = row({ name: 'a.txt', left: { path: 'D:\\left\\sub\\a.txt' }, right: null, status: 'left-only' })
    fc._rows = [r]

    await fc._moveRowsToFolder([r], 'left')

    expect(api.mkdirFolder).toHaveBeenCalledWith('D:\\out\\sub')
    expect(api.renameFile).toHaveBeenCalledWith('D:\\left\\sub\\a.txt', 'D:\\out\\sub\\a.txt')
    expect(api.copyFile).not.toHaveBeenCalled()
    expect(alerts.join('\n')).toContain('1 項成功')
  })

  it('rename 失敗時退回 copy + delete', async () => {
    const api = stubApi({
      openFolder: vi.fn().mockResolvedValue({ path: '/out' }),
      renameFile: vi.fn().mockRejectedValue(new Error('EXDEV')),
    })
    const { fc } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    const r = row({ name: 'a.txt', right: null, status: 'left-only' })
    fc._rows = [r]

    await fc._moveRowsToFolder([r], 'left')

    expect(api.copyFile).toHaveBeenCalledWith('/left/a.txt', '/out/a.txt')
    expect(api.deleteFile).toHaveBeenCalledWith('/left/a.txt')
  })

  it('複製成功但刪不掉來源時，摘要必須說出「兩側都在」的中途狀態', async () => {
    stubApi({
      openFolder: vi.fn().mockResolvedValue({ path: '/out' }),
      renameFile: vi.fn().mockRejectedValue(new Error('EXDEV')),
      deleteFile: vi.fn().mockRejectedValue(new Error('EBUSY')),
    })
    const { fc } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    const r = row({ name: 'a.txt', right: null, status: 'left-only' })
    fc._rows = [r]

    await fc._moveRowsToFolder([r], 'left')

    const text = alerts.join('\n')
    expect(text).toContain('只完成一半')
    expect(text).toContain('EBUSY')
    expect(text).toContain('/left/a.txt')
  })

  it('建立目的地資料夾失敗時，來源不動，且失敗被明確列出', async () => {
    const api = stubApi({
      openFolder: vi.fn().mockResolvedValue({ path: '/out' }),
      mkdirFolder: vi.fn().mockRejectedValue(new Error('EACCES')),
    })
    const { fc } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    const r = row({ name: 'a.txt', left: { path: '/left/sub/a.txt' }, right: null, status: 'left-only' })
    fc._rows = [r]

    await fc._moveRowsToFolder([r], 'left')

    expect(api.renameFile).not.toHaveBeenCalled()
    expect(api.copyFile).not.toHaveBeenCalled()
    expect(alerts.join('\n')).toContain('EACCES')
    expect(alerts.join('\n')).toContain('來源未動')
  })

  it('取消確認就什麼都不做', async () => {
    const api = stubApi({ openFolder: vi.fn().mockResolvedValue({ path: '/out' }) })
    confirmAnswer = false
    const { fc } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    const r = row({ name: 'a.txt', right: null, status: 'left-only' })

    await fc._moveRowsToFolder([r], 'left')

    expect(api.renameFile).not.toHaveBeenCalled()
    expect(confirms.join('\n')).toContain('來源檔案會被刪除')
  })

  it('入口：批次選單與右鍵選單都有「移動到其他資料夾」', () => {
    stubApi()
    const { fc, host } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    fc._rows = [row({ name: 'a.txt' })]
    fc._applyFilterAndRender()

    expect(batchMenuLabels(host)).toContain('移動選取到其他資料夾…')
    const labels = openRowMenu(host).filter((i) => !i.separator).map((i) => i.label)
    expect(labels).toContain('移動左側到其他資料夾…（來源會被刪除）')
    expect(labels).toContain('移動右側到其他資料夾…（來源會被刪除）')
  })

  it('與既有的左右互移是不同功能，兩者都還在', () => {
    stubApi()
    const { fc, host } = mounted()
    expect(typeof fc.moveSelectedTo).toBe('function')
    expect(typeof fc.moveSelectedToFolder).toBe('function')
    expect(batchMenuLabels(host)).toContain('移動選取到右側')
  })
})

// ── 3. Version 作為比對條件 ─────────────────────────────────────────────────

describe('Version 作為比對條件', () => {
  const peMeta = (version) => ({ kind: 'pe', fields: { FileVersion: version } })

  it('版本不同即判定為差異', async () => {
    stubApi({
      readMetadata: vi.fn(async (p) => peMeta(p.startsWith('/left') ? '1.0.0.0' : '2.0.0.0')),
    })
    const { fc } = mounted()
    const r = row({ name: 'app.exe', status: 'same' })
    fc._rows = [r]
    fc._compareVersion = true

    await fc._applyVersionCompare(fc._rows)

    expect(r.status).toBe('different')
  })

  it('版本相同不會反過來把不同的檔案判為相同', async () => {
    stubApi({ readMetadata: vi.fn().mockResolvedValue(peMeta('1.0.0.0')) })
    const { fc } = mounted()
    const r = row({ name: 'app.exe', status: 'different' })
    fc._rows = [r]

    await fc._applyVersionCompare(fc._rows)

    expect(r.status).toBe('different')
  })

  it('沒有版本資源的副檔名不會發出任何 IPC', async () => {
    const api = stubApi()
    const { fc } = mounted()
    fc._rows = [row({ name: 'a.txt', status: 'same' })]

    await fc._applyVersionCompare(fc._rows)

    expect(api.readMetadata).not.toHaveBeenCalled()
  })

  it('讀取失敗不會被當成差異，但會留下警告', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubApi({ readMetadata: vi.fn().mockRejectedValue(new Error('boom')) })
    const { fc } = mounted()
    const r = row({ name: 'app.exe', status: 'same' })
    fc._rows = [r]

    await fc._applyVersionCompare(fc._rows)

    expect(r.status).toBe('same')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('入口：規則面板有「比對版本」核取方塊，套用後生效並存進 config', () => {
    stubApi()
    const { fc, host } = mounted()
    const cb = host.querySelector('.fc-compare-version')
    expect(cb).toBeTruthy()

    cb.checked = true
    host.querySelector('.fc-rules-apply').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(fc.getCompareVersion()).toBe(true)
    expect(fc.getConfig().compareVersion).toBe(true)
  })

  it('config 可以往返', () => {
    stubApi()
    const { fc } = mounted()
    fc.setCompareVersion(true)
    const cfg = fc.getConfig()

    const { fc: other } = mounted()
    expect(other.getCompareVersion()).toBe(false)
    other.applyConfig(cfg)
    expect(other.getCompareVersion()).toBe(true)
  })
})

// ── 4. Compare Files Only ───────────────────────────────────────────────────

describe('Compare Files Only（忽略資料夾結構差異）', () => {
  /** A tree with a left-only folder holding one identical file. */
  function treeView() {
    stubApi()
    const { fc, host } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    fc._rows = [
      row({
        name: 'onlyleft',
        status: 'left-only',
        left: { isDirectory: true, path: '/left/onlyleft' },
        right: null,
      }),
      row({ name: 'a.txt', status: 'different' }),
    ]
    return { fc, host }
  }

  it('資料夾不再列入差異計數', () => {
    const { fc } = treeView()
    expect(fc.getRowStats().left_only).toBe(1)

    fc.setFilesOnly(true)

    expect(fc.getRowStats().left_only).toBe(0)
    expect(fc.getRowStats().different).toBe(1)
  })

  it('資料夾不再列入差異導航', () => {
    const { fc } = treeView()
    fc._applyFilterAndRender()
    expect(fc.getDiffIndices()).toHaveLength(2)

    fc.setFilesOnly(true)
    expect(fc.getDiffIndices()).toHaveLength(1)
  })

  it('資料夾仍然看得到——否則底下的檔案就再也打不開', () => {
    const { fc } = treeView()
    fc.setFilesOnly(true)
    fc.setViewPreset('same')

    const names = fc._visibleRows.map((f) => f.row.name)
    expect(names).toContain('onlyleft')
    expect(names).not.toContain('a.txt')
  })

  it('入口：工具列核取方塊', () => {
    const { fc, host } = treeView()
    const cb = host.querySelector('#fc-files-only')
    expect(cb).toBeTruthy()
    cb.checked = true
    cb.dispatchEvent(new Event('change'))
    expect(fc.getFilesOnly()).toBe(true)
  })
})

// ── 5. Ignore Folder Structure（攤平） ──────────────────────────────────────

describe('Ignore Folder Structure（攤平比對）', () => {
  it('依檔名配對，不看路徑', () => {
    const rows = pairFlatEntries(
      [entry({ name: 'x.js', path: '/l/a/x.js', size: 1 })],
      [entry({ name: 'x.js', path: '/r/deep/b/x.js', size: 1 })],
      'size')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('same')
  })

  it('同名重複時依路徑順序配對，多出來的變成孤兒', () => {
    const rows = pairFlatEntries(
      [entry({ name: 'x.js', path: '/l/a/x.js' }), entry({ name: 'x.js', path: '/l/b/x.js' })],
      [entry({ name: 'x.js', path: '/r/a/x.js' })],
      'size')
    expect(rows).toHaveLength(2)
    expect(rows[0].status).toBe('same')
    expect(rows[1].status).toBe('left-only')
    expect(rows[1].left.path).toBe('/l/b/x.js')
  })

  it('目錄不會出現在攤平結果裡', () => {
    const rows = pairFlatEntries(
      [entry({ name: 'sub', path: '/l/sub', isDirectory: true }), entry({ name: 'x.js', path: '/l/sub/x.js' })],
      [], 'size')
    expect(rows.map((r) => r.name)).toEqual(['x.js'])
  })

  it('開啟後會完整走訪兩側目錄樹', async () => {
    const api = stubApi({
      readDir: vi.fn(async (p) => {
        if (p === '/left') return [entry({ name: 'sub', path: '/left/sub', isDirectory: true })]
        if (p === '/left/sub') return [entry({ name: 'deep.txt', path: '/left/sub/deep.txt', size: 5 })]
        if (p === '/right') return [entry({ name: 'deep.txt', path: '/right/deep.txt', size: 5 })]
        return []
      }),
    })
    const { fc } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    await fc._scan()

    // Nested on the left, top level on the right: only flat mode pairs them.
    expect(fc._rows.find((r) => r.name === 'deep.txt')?.status).toBe('right-only')

    await fc.setFlatMode(true)

    expect(api.readDir).toHaveBeenCalledWith('/left/sub')
    const pair = fc._rows.find((r) => r.name === 'deep.txt')
    expect(pair.status).toBe('same')
    expect(pair.left.path).toBe('/left/sub/deep.txt')
    expect(pair.right.path).toBe('/right/deep.txt')
  })

  it('攤平模式下複製到對側寫回對側原本的路徑，而不是照來源的相對路徑另開一個檔', () => {
    stubApi()
    const { fc } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    const r = {
      name: 'x.js',
      status: 'different',
      left: entry({ name: 'x.js', path: '/left/a/x.js' }),
      right: entry({ name: 'x.js', path: '/right/b/x.js' }),
      children: [],
    }
    expect(fc._destPathFor(r, 'right')).toBe('/right/b/x.js')
  })

  it('無法讀取的目錄會被說出來，而不是靜靜地少掉一批檔案', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubApi({
      readDir: vi.fn(async (p) => {
        if (p === '/left') return [entry({ name: 'sub', path: '/left/sub', isDirectory: true })]
        if (p === '/left/sub') throw new Error('EPERM')
        return []
      }),
    })
    const { fc } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'

    await fc._collectFiles('left', '/left', { loaded: 0 })

    expect(fc._dom.scanStatus.textContent).toContain('EPERM')
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('三萬列時虛擬捲動只渲染視窗內的列', () => {
    stubApi()
    const { fc, host } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    const left = []
    const right = []
    for (let i = 0; i < 30000; i++) {
      left.push(entry({ name: `f${i}.txt`, path: `/left/d${i % 50}/f${i}.txt`, size: i }))
      right.push(entry({ name: `f${i}.txt`, path: `/right/e${i % 7}/f${i}.txt`, size: i }))
    }
    fc._rows = pairFlatEntries(left, right, 'size')

    fc._applyFilterAndRender()

    expect(fc._visibleRows).toHaveLength(30000)
    const rendered = host.querySelectorAll('.fc-row').length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(200)
    // The scroll surface still has to be tall enough to reach row 30000.
    expect(parseInt(host.querySelector('.fc-vlist').style.height, 10))
      .toBeGreaterThan(30000 * 20)
  })

  it('入口：工具列核取方塊', () => {
    stubApi()
    const { fc, host } = mounted()
    const cb = host.querySelector('#fc-flat-mode')
    expect(cb).toBeTruthy()
    cb.checked = true
    cb.dispatchEvent(new Event('change'))
    expect(fc.getFlatMode()).toBe(true)
  })
})

// ── 6. Ignore Unimportant Differences ───────────────────────────────────────

describe('Ignore Unimportant Differences（資料夾層級總開關）', () => {
  function withUnimportant() {
    stubApi()
    const { fc, host } = mounted()
    const r = row({ name: 'a.txt', status: 'same' })
    r.unimportant = true
    fc._rows = [r, row({ name: 'b.txt', status: 'different' })]
    fc._applyFilterAndRender()
    return { fc, host, r }
  }

  it('關閉時，不重要差異在「只顯示差異」下仍看得到', () => {
    const { fc } = withUnimportant()
    fc.setViewPreset('differences')
    expect(fc._visibleRows.map((f) => f.row.name)).toContain('a.txt')
  })

  it('開啟後，不重要差異等同相同：在「只顯示差異」下被藏起來', () => {
    const { fc } = withUnimportant()
    fc.setIgnoreUnimportant(true)
    fc.setViewPreset('differences')
    expect(fc._visibleRows.map((f) => f.row.name)).not.toContain('a.txt')
    expect(fc._visibleRows.map((f) => f.row.name)).toContain('b.txt')
  })

  it('開啟後也不列入差異導航', () => {
    const { fc, r } = withUnimportant()
    r.status = 'different'
    fc._applyFilterAndRender()
    expect(fc.getDiffIndices()).toHaveLength(2)

    fc.setIgnoreUnimportant(true)
    expect(fc.getDiffIndices()).toHaveLength(1)
  })

  it('入口：工具列核取方塊，且狀態進得了 config', () => {
    const { fc, host } = withUnimportant()
    const cb = host.querySelector('#fc-ignore-unimportant')
    expect(cb).toBeTruthy()
    cb.checked = true
    cb.dispatchEvent(new Event('change'))
    expect(fc.getIgnoreUnimportant()).toBe(true)
    expect(fc.getConfig().ignoreUnimportant).toBe(true)
  })
})

// ── 7. Compare within Archives ──────────────────────────────────────────────

describe('Compare within Archives（比對條件對話框）', () => {
  it('normalizeArchiveOptions 補齊缺項並拒絕空遮罩', () => {
    expect(normalizeArchiveOptions(null).expand).toBe(false)
    expect(normalizeArchiveOptions({ extensions: '  ' }).extensions).toContain('*.zip')
    expect(normalizeArchiveOptions({ expand: true }).expand).toBe(true)
  })

  it('isArchiveName 依遮罩判定', () => {
    const ext = normalizeArchiveOptions({}).extensions
    expect(isArchiveName('a.zip', ext)).toBe(true)
    expect(isArchiveName('a.7z', ext)).toBe(true)
    expect(isArchiveName('a.txt', ext)).toBe(false)
  })

  it('classifyArchivePair 只看內容清單，忽略容器本身', () => {
    const a = [{ name: 'x', size: 1 }, { name: 'y', size: 2 }]
    const b = [{ name: 'y', size: 2 }, { name: 'x', size: 1 }]
    expect(classifyArchivePair(a, b)).toBe('same')
    expect(classifyArchivePair(a, [{ name: 'x', size: 9 }, { name: 'y', size: 2 }])).toBe('different')
    expect(classifyArchivePair(a, [{ name: 'x', size: 1 }])).toBe('different')
  })

  it('開啟「以內容清單判定」後，重新壓縮的同一份內容會被判為相同', async () => {
    stubApi({
      readArchive: vi.fn(async (p) => ({
        format: 'zip',
        entries: [{ path: 'a.txt', size: 3, mtime: p.startsWith('/left') ? '2024-01-01' : '2025-01-01' }],
      })),
    })
    const { fc } = mounted()
    const r = row({ name: 'pkg.zip', status: 'different', left: { size: 100 }, right: { size: 130 } })
    fc._rows = [r]
    fc._archiveOptions = normalizeArchiveOptions({ compareContents: true })

    await fc._applyArchiveCompare(fc._rows)

    expect(r.status).toBe('same')
  })

  it('讀不到封存檔時維持原判定，並把錯誤說出來', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubApi({ readArchive: vi.fn().mockRejectedValue(new Error('壞掉的檔頭')) })
    const { fc } = mounted()
    const r = row({ name: 'pkg.zip', status: 'different' })
    fc._rows = [r]
    fc._archiveOptions = normalizeArchiveOptions({ compareContents: true })

    await fc._applyArchiveCompare(fc._rows)

    expect(r.status).toBe('different')
    expect(fc._dom.scanStatus.textContent).toContain('壞掉的檔頭')
    err.mockRestore()
  })

  it('開啟「當成資料夾」後，封存檔列可展開並列出裡面的檔案', async () => {
    stubApi({
      readArchive: vi.fn(async () => ({
        format: 'zip',
        entries: [{ path: 'a.txt', size: 3, mtime: '2024-01-01T00:00:00.000Z' }],
      })),
    })
    const { fc } = mounted()
    fc._archiveOptions = normalizeArchiveOptions({ expand: true })
    const r = row({ name: 'pkg.zip', status: 'different' })
    fc._rows = [r]
    fc._markArchiveContainers(fc._rows)

    expect(r.container).toBe(true)

    await fc._loadChildren(r)

    expect(r.children.map((c) => c.name)).toEqual(['a.txt'])
    expect(r.children[0].status).toBe('same')
  })

  it('關閉選項會把 container 旗標清掉，封存檔回到一般檔案', () => {
    stubApi()
    const { fc } = mounted()
    const r = row({ name: 'pkg.zip' })
    fc._archiveOptions = normalizeArchiveOptions({ expand: true })
    fc._markArchiveContainers([r])
    expect(r.container).toBe(true)

    fc._archiveOptions = normalizeArchiveOptions({ expand: false })
    fc._markArchiveContainers([r])
    expect(r.container).toBe(false)
  })

  it('入口：規則面板的「封存檔…」開啟對話框，套用後寫入設定', async () => {
    stubApi()
    const { fc, host } = mounted()
    const btn = host.querySelector('.fc-rules-archives')
    expect(btn).toBeTruthy()

    const pending = fc.openArchiveOptionsDialog()
    host.querySelector('.fc-archive-expand').checked = true
    host.querySelector('.fc-archive-contents').checked = true
    host.querySelector('.fc-modal-ok').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const applied = await pending

    expect(applied.expand).toBe(true)
    expect(applied.compareContents).toBe(true)
    expect(fc.getConfig().archiveOptions.expand).toBe(true)
  })

  it('對話框拒絕空的副檔名遮罩', async () => {
    stubApi()
    const { fc, host } = mounted()
    const pending = fc.openArchiveOptionsDialog()
    host.querySelector('.fc-archive-extensions').value = '   '
    host.querySelector('.fc-modal-ok').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(alerts.join('\n')).toContain('不可空白')
    host.querySelector('.fc-modal-cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(await pending).toBe(null)
  })
})

// ── 8. Update vs Mirror ─────────────────────────────────────────────────────

describe('Update vs Mirror', () => {
  const destFor = (src, side) => src.replace(/^\/(left|right)/, `/${side}`)
  const rows = () => [
    row({ name: 'l.txt', status: 'left-only', right: null }),
    row({ name: 'r.txt', status: 'right-only', left: null }),
    row({ name: 'ln.txt', status: 'left-newer' }),
    row({ name: 'rn.txt', status: 'right-newer' }),
    row({ name: 'd.txt', status: 'different' }),
    row({ name: 's.txt', status: 'same' }),
  ]

  it('Update 左→右：不刪除，也不覆寫右側較新的檔案', () => {
    const ops = buildSyncOps(rows(), { direction: 'left-to-right', action: 'update', destFor })
    expect(ops.filter((o) => o.op === 'delete')).toHaveLength(0)
    expect(ops.map((o) => o.src)).toEqual(['/left/l.txt', '/left/ln.txt', '/left/d.txt'])
  })

  it('Mirror 左→右：覆寫右側較新的檔案，並刪除右側多出來的檔案', () => {
    const ops = buildSyncOps(rows(), { direction: 'left-to-right', action: 'mirror', destFor })
    expect(ops.filter((o) => o.op === 'copy').map((o) => o.src))
      .toEqual(['/left/l.txt', '/left/ln.txt', '/left/rn.txt', '/left/d.txt'])
    expect(ops.filter((o) => o.op === 'delete').map((o) => o.path)).toEqual(['/right/r.txt'])
  })

  it('Mirror 右→左 的方向是對稱的', () => {
    const ops = buildSyncOps(rows(), { direction: 'right-to-left', action: 'mirror', destFor })
    expect(ops.filter((o) => o.op === 'delete').map((o) => o.path)).toEqual(['/left/l.txt'])
  })

  it('雙向永遠是 Update：不產生任何刪除', () => {
    for (const action of ['update', 'mirror']) {
      const ops = buildSyncOps(rows(), { direction: 'bidirectional', action, destFor })
      expect(ops.filter((o) => o.op === 'delete')).toHaveLength(0)
    }
  })

  it('目錄不參與，唯讀旗標隨著 op 傳遞', () => {
    const r = row({ name: 'dir', status: 'left-only', left: { isDirectory: true }, right: null })
    expect(buildSyncOps([r], { direction: 'left-to-right', action: 'mirror', destFor })).toHaveLength(0)

    const ro = row({ name: 'a.txt', status: 'different', right: { readOnly: true } })
    const [op] = buildSyncOps([ro], { direction: 'left-to-right', action: 'update', destFor })
    expect(op.targetReadOnly).toBe(true)
  })

  it('文案把兩者分開，鏡像那句必須說出「刪除」', () => {
    expect(syncModeLabel('left-to-right', 'update')).toContain('不刪除')
    expect(syncModeLabel('left-to-right', 'mirror')).toContain('刪除')
  })

  it('已展開的子目錄也會納入同步，不只頂層', async () => {
    stubApi()
    const { fc } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    fc._rows = [row({
      name: 'sub',
      status: 'different',
      left: { isDirectory: true, path: '/left/sub' },
      right: { isDirectory: true, path: '/right/sub' },
      children: [row({ name: 'deep.txt', status: 'left-newer', left: { path: '/left/sub/deep.txt' }, right: { path: '/right/sub/deep.txt' } })],
    })]
    fc._syncDirection = 'left-to-right'
    fc._syncAction = 'update'

    await fc._buildSyncOps()

    expect(fc._syncOps.map((o) => o.src)).toEqual(['/left/sub/deep.txt'])
  })

  it('鏡像的刪除需要額外的明確確認，取消就完全不動', async () => {
    const api = stubApi()
    confirmAnswer = false
    const { fc } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    fc._syncMode = true
    fc._syncAction = 'mirror'
    fc._syncOps = [
      { op: 'copy', src: '/left/a.txt', dest: '/right/a.txt', label: 'a', targetReadOnly: false },
      { op: 'delete', path: '/right/x.txt', label: 'x', targetReadOnly: false },
    ]

    await fc._executeSyncOps()

    expect(confirms.join('\n')).toContain('鏡像同步會刪除')
    expect(api.deleteFile).not.toHaveBeenCalled()
    expect(api.copyFile).not.toHaveBeenCalled()
  })

  it('鏡像中途刪除失敗時，摘要要把失敗的路徑說出來', async () => {
    stubApi({ deleteFile: vi.fn().mockRejectedValue(new Error('EBUSY')) })
    const { fc } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    fc._syncMode = true
    fc._syncAction = 'mirror'
    // The recycle-bin dialog is answered by its own test; here the interesting
    // part is what the summary says once a delete fails halfway through.
    fc._confirmDelete = async () => ({ ok: true, permanent: false })
    fc._syncOps = [
      { op: 'copy', src: '/left/a.txt', dest: '/right/a.txt', label: 'a', targetReadOnly: false },
      { op: 'delete', path: '/right/x.txt', label: 'x', targetReadOnly: false },
    ]

    await fc._executeSyncOps()

    const text = alerts.join('\n')
    expect(text).toContain('1 項成功')
    expect(text).toContain('1 項失敗')
    expect(text).toContain('/right/x.txt')
  })

  it('入口：同步面板有 Update / Mirror 兩顆按鈕，雙向時 Mirror 會被停用', () => {
    stubApi()
    const { fc, host } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    fc.toggleSyncMode()

    const mirror = host.querySelector('input[name="sync-action"][value="mirror"]')
    expect(mirror).toBeTruthy()

    mirror.checked = true
    mirror.dispatchEvent(new Event('change'))
    expect(fc._syncAction).toBe('mirror')

    const bidi = host.querySelector('input[name="sync-dir"][value="bidirectional"]')
    bidi.checked = true
    bidi.dispatchEvent(new Event('change'))
    expect(mirror.disabled).toBe(true)
    expect(fc._syncAction).toBe('update')
  })
})

// ── 9. Open With（既有功能，守門用） ────────────────────────────────────────

describe('Open With（既有）', () => {
  it('右鍵選單仍然提供以預設程式開啟', () => {
    stubApi()
    const { fc, host } = mounted()
    fc._leftPath = '/left'
    fc._rightPath = '/right'
    fc._rows = [row({ name: 'a.txt' })]
    fc._applyFilterAndRender()

    const labels = openRowMenu(host).filter((i) => !i.separator).map((i) => i.label)
    expect(labels).toContain('以預設程式開啟（左側）')
    expect(labels).toContain('以預設程式開啟（右側）')
  })
})

// ── 10. Other Filters ───────────────────────────────────────────────────────

describe('Other Filters（大小 / 日期 / 屬性）', () => {
  it('parseSizeInput 認得後綴，也認得亂寫', () => {
    expect(parseSizeInput('100')).toBe(100)
    expect(parseSizeInput('64K')).toBe(65536)
    expect(parseSizeInput('2.5m')).toBe(2621440)
    expect(parseSizeInput('1 GB')).toBe(1073741824)
    expect(parseSizeInput('')).toBe(null)
    expect(parseSizeInput('一百')).toBe(null)
    expect(parseSizeInput('10 apples')).toBe(null)
  })

  it('parseDateInput 只收 YYYY-MM-DD，且迄日含當天', () => {
    expect(parseDateInput('')).toBe(null)
    expect(parseDateInput('2024-13-99')).toBe(null)
    const start = parseDateInput('2024-01-01')
    const end = parseDateInput('2024-01-01', true)
    expect(end - start).toBe(86399999)
  })

  it('沒有任何設定時一律通過', () => {
    expect(otherFiltersActive(EMPTY_OTHER_FILTERS)).toBe(false)
    expect(matchesOtherFilters(row({}), EMPTY_OTHER_FILTERS)).toBe(true)
  })

  it('大小範圍', () => {
    const r = row({ left: { size: 500 }, right: { size: 500 } })
    expect(matchesOtherFilters(r, normalizeOtherFilters({ minSize: '1K' }))).toBe(false)
    expect(matchesOtherFilters(r, normalizeOtherFilters({ minSize: '100' }))).toBe(true)
    expect(matchesOtherFilters(r, normalizeOtherFilters({ maxSize: '100' }))).toBe(false)
  })

  it('日期範圍', () => {
    const r = row({
      left: { mtime: '2024-06-01T12:00:00.000Z' },
      right: { mtime: '2024-06-01T12:00:00.000Z' },
    })
    expect(matchesOtherFilters(r, normalizeOtherFilters({ modifiedAfter: '2025-01-01' }))).toBe(false)
    expect(matchesOtherFilters(r, normalizeOtherFilters({ modifiedBefore: '2025-01-01' }))).toBe(true)
  })

  it('屬性：未讀取屬性時，hidden 篩選不會誤判成「不是隱藏」', () => {
    const r = row({})
    expect(matchesOtherFilters(r, normalizeOtherFilters({ hidden: 'no' }))).toBe(false)

    const known = row({ left: { hidden: false }, right: { hidden: false } })
    expect(matchesOtherFilters(known, normalizeOtherFilters({ hidden: 'no' }))).toBe(true)
    expect(matchesOtherFilters(known, normalizeOtherFilters({ hidden: 'yes' }))).toBe(false)
  })

  it('唯讀篩選', () => {
    const r = row({ left: { readOnly: true }, right: { readOnly: true } })
    expect(matchesOtherFilters(r, normalizeOtherFilters({ readOnly: 'yes' }))).toBe(true)
    expect(matchesOtherFilters(r, normalizeOtherFilters({ readOnly: 'no' }))).toBe(false)
  })

  it('資料夾永遠不被大小或日期擋掉，否則底下的檔案會一起消失', () => {
    const dir = row({ name: 'sub', left: { isDirectory: true, size: 0 }, right: { isDirectory: true, size: 0 } })
    expect(matchesOtherFilters(dir, normalizeOtherFilters({ minSize: '1M' }))).toBe(true)
  })

  it('只要有一側通過就顯示，不會拆散一對', () => {
    const r = row({ left: { size: 5000 }, right: { size: 1 } })
    expect(matchesOtherFilters(r, normalizeOtherFilters({ minSize: '1K' }))).toBe(true)
  })

  it('入口：篩選面板有兩個分頁，其他篩選套用後真的過濾', () => {
    stubApi()
    const { fc, host } = mounted()
    fc._rows = [
      row({ name: 'small.txt', left: { size: 10 }, right: { size: 10 } }),
      row({ name: 'big.txt', left: { size: 100000 }, right: { size: 100000 } }),
    ]
    fc._applyFilterAndRender()

    const tabs = [...host.querySelectorAll('.fc-filter-tab')].map((b) => b.textContent)
    expect(tabs).toEqual(['名稱遮罩', '其他篩選'])

    host.querySelector('.fc-filter-tab[data-tab="other"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(host.querySelector('.fc-filter-page--other').style.display).toBe('flex')
    expect(host.querySelector('.fc-filter-page--masks').style.display).toBe('none')

    host.querySelector('.fc-other-input[data-other="minSize"]').value = '1K'
    host.querySelector('.fc-filter-apply').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(fc._visibleRows.map((f) => f.row.name)).toEqual(['big.txt'])
  })

  it('大小欄位寫錯時明講，而不是靜靜地什麼都不篩', () => {
    stubApi()
    const { fc, host } = mounted()
    host.querySelector('.fc-other-input[data-other="minSize"]').value = '一大堆'
    host.querySelector('.fc-filter-apply').dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(alerts.join('\n')).toContain('不是可辨識的大小')
    expect(fc.getOtherFilters().minSize).toBe('')
  })

  it('清除會一併清掉其他篩選，設定也能往返', () => {
    stubApi()
    const { fc } = mounted()
    fc.setOtherFilters({ minSize: '1K', hidden: 'yes' })
    const cfg = fc.getConfig()
    expect(cfg.otherFilters.minSize).toBe('1K')

    fc.clearFilters()
    expect(fc.getOtherFilters()).toEqual(EMPTY_OTHER_FILTERS)

    fc.applyConfig(cfg)
    expect(fc.getOtherFilters().minSize).toBe('1K')
  })

  it('hidden 篩選會讓目錄列舉改成要求屬性', () => {
    stubApi()
    const { fc } = mounted()
    expect(fc._needsAttributes()).toBe(false)
    fc.setOtherFilters({ hidden: 'yes' })
    expect(fc._needsAttributes()).toBe(true)
  })
})
