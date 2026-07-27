/**
 * @vitest-environment jsdom
 *
 * S18 — 資料夾比對：封存格式接線、唯讀處理、資源回收桶、導覽歷史、
 *       Include/Exclude 四欄遮罩。
 *
 * 這一批的重點不只是「函式對不對」，而是「有沒有人呼叫它」：
 * 例如封存檔按鈕過去呼叫寫死 ZIP 的 openZip()，八種解碼器因此無人可達。
 * 所以下面同時斷言「呼叫了 readArchive」與「沒有呼叫 openZip」。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { setActiveView } from '../../src/renderer/src/core/active-view.js'
import {
  FolderCompare,
  ARCHIVE_DIALOG_FILTERS,
  parentPath,
  normalizeFilterFields,
  matchesFolderFilters,
  readOnlyLabels,
  formatReadOnlyPrompt,
  formatDeleteSummary,
  isRecycleBinUnavailable,
} from '../../src/renderer/src/views/folder-compare.js'

vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: () => {},
}))

/** @type {string[]} */
let alerts = []
/** @type {boolean} */
let confirmAnswer = true
/** @type {string[]} */
let confirms = []

beforeEach(() => {
  alerts = []
  confirms = []
  confirmAnswer = true
  vi.stubGlobal('alert', (msg) => { alerts.push(String(msg)) })
  vi.stubGlobal('confirm', (msg) => { confirms.push(String(msg)); return confirmAnswer })
  localStorage.clear()
  // The document-level shortcuts are gated on the folder view being on screen.
  setActiveView('folder')
})

/** Mounted views to tear down; their keydown handlers live on `document`. */
let mountedViews = []

afterEach(() => {
  for (const fc of mountedViews) fc.destroy()
  mountedViews = []
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** Minimal electronAPI covering everything these tests reach. */
function stubApi(over = {}) {
  const api = {
    readDir: vi.fn().mockResolvedValue([]),
    openFolder: vi.fn().mockResolvedValue(null),
    openZip: vi.fn().mockResolvedValue(null),
    openFileBinary: vi.fn().mockResolvedValue(null),
    readArchive: vi.fn().mockResolvedValue({ format: 'tar', entries: [] }),
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

/** A mounted view, so the toolbar and its handlers really exist. */
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
    size: o.size ?? 1,
    mtime: o.mtime ?? '2024-01-01T00:00:00.000Z',
    readOnly: !!o.readOnly,
  }
}

// ── 1. 封存格式 UI 接線 ────────────────────────────────────────────────────────

describe('封存檔開啟（P0-1）', () => {
  it('對話框篩選涵蓋 archive.js 支援的全部格式', () => {
    const all = ARCHIVE_DIALOG_FILTERS[0].extensions
    for (const ext of ['zip', 'jar', 'war', 'ear', '7z', 'tar', 'tgz', 'tbz2', 'txz', 'gz', 'bz2', 'xz']) {
      expect(all).toContain(ext)
    }
  })

  it('走 readArchive 而不是寫死 ZIP 的 openZip', async () => {
    const api = stubApi({
      openFileBinary: vi.fn().mockResolvedValue({ path: '/t/pkg.tar.gz', base64: '', size: 9 }),
      readArchive: vi.fn().mockResolvedValue({
        format: 'tar.gz',
        entries: [{ path: 'proj/a.txt', size: 3, mtime: '2024-01-01T00:00:00.000Z' }],
      }),
    })
    const { fc } = mounted()

    await fc.openArchiveLeft()

    expect(api.openZip).not.toHaveBeenCalled()
    expect(api.readArchive).toHaveBeenCalledWith('/t/pkg.tar.gz')
    expect(fc._leftPath).toBe('/t/pkg.tar.gz')
    expect(fc._leftSource.kind).toBe('archive')
    // The parent directory tar omits has to exist or the entry has no row.
    expect(fc._leftZipEntries.map((e) => e.path))
      .toEqual(['/t/pkg.tar.gz::proj/', '/t/pkg.tar.gz::proj/a.txt'])
  })

  it('只請求一個位元組——封存檔由主程序自己再讀一次', async () => {
    const api = stubApi({
      openFileBinary: vi.fn().mockResolvedValue({ path: '/t/x.7z', base64: '', size: 4096 }),
    })
    const { fc } = mounted()
    await fc.openArchiveRight()

    const [opts] = api.openFileBinary.mock.calls[0]
    expect(opts.maxBytes).toBe(1)
    expect(opts.filters).toBe(ARCHIVE_DIALOG_FILTERS)
    expect(fc._rightSource.kind).toBe('archive')
  })

  it('取消對話框不動任何狀態', async () => {
    stubApi({ openFileBinary: vi.fn().mockResolvedValue(null) })
    const { fc } = mounted()
    await fc.openArchiveLeft()
    expect(fc._leftPath).toBeNull()
  })

  it('解碼失敗會明確告知使用者，而不是靜默吞掉', async () => {
    stubApi({
      openFileBinary: vi.fn().mockResolvedValue({ path: '/t/bad.7z' }),
      readArchive: vi.fn().mockRejectedValue(new Error('Corrupt 7z archive')),
    })
    const { fc } = mounted()
    await fc.openArchiveLeft()

    expect(alerts.join('\n')).toMatch(/Corrupt 7z archive/)
    expect(fc._leftPath).toBeNull()
  })

  it('工具列按鈕接到封存檔開啟流程', async () => {
    const api = stubApi({
      openFileBinary: vi.fn().mockResolvedValue({ path: '/t/a.tar' }),
      readArchive: vi.fn().mockResolvedValue({ format: 'tar', entries: [] }),
    })
    const { fc, host } = mounted()
    const btn = host.querySelectorAll('.fc-path-cell .fc-open-btn')[1]
    expect(btn.textContent).toContain('封存檔')
    btn.click()
    await vi.waitFor(() => expect(api.readArchive).toHaveBeenCalled())
    expect(fc._leftSource.kind).toBe('archive')
  })
})

// ── 2. 唯讀檔案 ────────────────────────────────────────────────────────────────

describe('唯讀目標（P1-17）', () => {
  it('readOnlyLabels 只挑出目標唯讀的工作', () => {
    expect(readOnlyLabels([
      { label: 'a', targetReadOnly: true },
      { label: 'b' },
      { label: 'c', targetReadOnly: true },
    ])).toEqual(['a', 'c'])
  })

  it('提示文字兩個按鈕都是動作，不是「做/不做」', () => {
    const text = formatReadOnlyPrompt(['/r/a.txt'], '覆寫')
    expect(text).toMatch(/1 個目標檔案是唯讀/)
    expect(text).toMatch(/仍嘗試覆寫/)
    expect(text).toMatch(/略過/)
  })

  it('超過樣本上限時只列前幾筆', () => {
    const text = formatReadOnlyPrompt(Array.from({ length: 12 }, (_, i) => `f${i}`), '刪除')
    expect(text).toMatch(/另有 4 項/)
  })

  it('取消時略過唯讀目標，其餘照常複製', async () => {
    const api = stubApi()
    const { fc } = mounted({ leftPath: '/left', rightPath: '/right' })
    fc._rows = [
      { name: 'ro.txt', status: 'different', left: entry({ path: '/left/ro.txt' }), right: entry({ path: '/right/ro.txt', readOnly: true }) },
      { name: 'ok.txt', status: 'different', left: entry({ path: '/left/ok.txt' }), right: entry({ path: '/right/ok.txt' }) },
    ]
    fc._selectedNames = new Set(['/left/ro.txt', '/left/ok.txt'])
    confirmAnswer = true   // 確定要複製
    let call = 0
    vi.stubGlobal('confirm', (msg) => {
      confirms.push(String(msg))
      call++
      return call === 1   // 第二個問題（唯讀）回答「取消」＝略過
    })

    await fc.copySelectedTo('right')

    expect(confirms.some((c) => /唯讀/.test(c))).toBe(true)
    expect(api.copyFile).toHaveBeenCalledTimes(1)
    expect(api.copyFile).toHaveBeenCalledWith('/left/ok.txt', expect.stringContaining('ok.txt'))
  })

  it('確定時仍嘗試覆寫，失敗原因會顯示出來', async () => {
    const api = stubApi({
      copyFile: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
    })
    const { fc } = mounted({ leftPath: '/left', rightPath: '/right' })
    fc._rows = [
      { name: 'ro.txt', status: 'different', left: entry({ path: '/left/ro.txt' }), right: entry({ path: '/right/ro.txt', readOnly: true }) },
    ]
    fc._selectedNames = new Set(['/left/ro.txt'])
    confirmAnswer = true

    await fc.copySelectedTo('right')

    expect(api.copyFile).toHaveBeenCalledTimes(1)
    expect(alerts.join('\n')).toMatch(/EACCES/)
  })

  it('同步的複製操作帶著目標端的唯讀旗標', async () => {
    stubApi()
    const { fc } = mounted({ leftPath: '/left', rightPath: '/right' })
    fc._syncDirection = 'left-to-right'
    fc._rows = [
      { name: 'a.txt', status: 'different', left: entry({ path: '/left/a.txt' }), right: entry({ path: '/right/a.txt', readOnly: true }) },
      { name: 'b.txt', status: 'left-only', left: entry({ path: '/left/b.txt' }), right: null },
    ]
    await fc._buildSyncOps()
    expect(fc._syncOps.map((op) => [op.op, op.targetReadOnly]))
      .toEqual([['copy', true], ['copy', false]])
  })
})

// ── 3. 資源回收桶 ─────────────────────────────────────────────────────────────

describe('刪除與資源回收桶（P1-18）', () => {
  it('摘要說清楚東西去了哪裡', () => {
    expect(formatDeleteSummary({ trashed: 2, permanent: 0, failures: [] }))
      .toBe('已移至資源回收桶：2 項')
    expect(formatDeleteSummary({ trashed: 0, permanent: 3, failures: [] }))
      .toBe('已永久刪除：3 項')
    const both = formatDeleteSummary({
      trashed: 1, permanent: 1, failures: [{ path: '/x', message: 'EPERM' }],
    })
    expect(both).toMatch(/已移至資源回收桶：1 項/)
    expect(both).toMatch(/已永久刪除：1 項/)
    expect(both).toMatch(/EPERM/)
  })

  it('辨識「平台沒有回收桶」的拒絕', () => {
    expect(isRecycleBinUnavailable([{ message: '無法移至資源回收桶：ENOSYS' }])).toBe(true)
    expect(isRecycleBinUnavailable([{ message: 'EPERM' }])).toBe(false)
    expect(isRecycleBinUnavailable([])).toBe(false)
  })

  it('預設不傳 options，等於走資源回收桶', async () => {
    const api = stubApi()
    const { fc } = mounted({ leftPath: '/left' })
    fc._confirmDelete = vi.fn().mockResolvedValue({ ok: true, permanent: false })

    await fc._runDelete([{ path: '/left/a.txt' }])

    expect(api.deleteFile).toHaveBeenCalledWith('/left/a.txt', undefined)
    expect(alerts.join('\n')).toMatch(/已移至資源回收桶：1 項/)
  })

  it('勾選永久刪除才傳 permanent:true', async () => {
    const api = stubApi({
      deleteFile: vi.fn().mockResolvedValue({ deleted: true, permanent: true }),
    })
    const { fc } = mounted({ leftPath: '/left' })
    fc._confirmDelete = vi.fn().mockResolvedValue({ ok: true, permanent: true })

    await fc._runDelete([{ path: '/left/a.txt' }])

    expect(api.deleteFile).toHaveBeenCalledWith('/left/a.txt', { permanent: true })
    expect(alerts.join('\n')).toMatch(/已永久刪除：1 項/)
  })

  it('取消對話框就什麼都不刪', async () => {
    const api = stubApi()
    const { fc } = mounted({ leftPath: '/left' })
    fc._confirmDelete = vi.fn().mockResolvedValue({ ok: false, permanent: false })

    expect(await fc._runDelete([{ path: '/left/a.txt' }])).toBe(false)
    expect(api.deleteFile).not.toHaveBeenCalled()
  })

  it('沒有回收桶時不自作主張，先問過才永久刪除', async () => {
    const deleteFile = vi.fn()
      .mockRejectedValueOnce(new Error('無法移至資源回收桶：ENOSYS'))
      .mockResolvedValueOnce({ deleted: true, permanent: true })
    stubApi({ deleteFile })
    const { fc } = mounted({ leftPath: '/left' })
    fc._confirmDelete = vi.fn().mockResolvedValue({ ok: true, permanent: false })
    confirmAnswer = true

    await fc._runDelete([{ path: '/left/a.txt' }])

    // 第一次不帶 options；使用者同意後才是明確的 permanent，不是偷偷 fallback。
    expect(deleteFile.mock.calls[0]).toEqual(['/left/a.txt', undefined])
    expect(deleteFile.mock.calls[1]).toEqual(['/left/a.txt', { permanent: true }])
    expect(confirms.join('\n')).toMatch(/永久刪除/)
    expect(alerts.join('\n')).toMatch(/已永久刪除：1 項/)
  })

  it('使用者拒絕改為永久刪除時，失敗就是失敗', async () => {
    const deleteFile = vi.fn().mockRejectedValue(new Error('無法移至資源回收桶：ENOSYS'))
    stubApi({ deleteFile })
    const { fc } = mounted({ leftPath: '/left' })
    fc._confirmDelete = vi.fn().mockResolvedValue({ ok: true, permanent: false })
    confirmAnswer = false

    await fc._runDelete([{ path: '/left/a.txt' }])

    expect(deleteFile).toHaveBeenCalledTimes(1)
    expect(alerts.join('\n')).toMatch(/失敗：1 項/)
  })

  it('永久刪除時唯讀項目會先問過再決定', async () => {
    const api = stubApi({
      deleteFile: vi.fn().mockResolvedValue({ deleted: true, permanent: true }),
    })
    const { fc } = mounted({ leftPath: '/left' })
    fc._confirmDelete = vi.fn().mockResolvedValue({ ok: true, permanent: true })
    confirmAnswer = false   // 取消＝略過唯讀項

    await fc._runDelete([
      { path: '/left/ro.txt', readOnly: true },
      { path: '/left/ok.txt' },
    ])

    expect(api.deleteFile).toHaveBeenCalledTimes(1)
    expect(api.deleteFile).toHaveBeenCalledWith('/left/ok.txt', { permanent: true })
  })

  it('回收桶路徑不會為了唯讀而攔人（trashItem 是搬移，不是寫入）', async () => {
    const api = stubApi()
    const { fc } = mounted({ leftPath: '/left' })
    fc._confirmDelete = vi.fn().mockResolvedValue({ ok: true, permanent: false })

    await fc._runDelete([{ path: '/left/ro.txt', readOnly: true }])

    expect(confirms.some((c) => /唯讀/.test(c))).toBe(false)
    expect(api.deleteFile).toHaveBeenCalledTimes(1)
  })

  it('deleteSelected 只碰可寫入來源上的選取項', async () => {
    const api = stubApi()
    const { fc } = mounted({ leftPath: '/left', rightPath: '/a.zip' })
    fc._rightSource = { kind: 'archive', root: '/a.zip' }
    fc._rows = [{
      name: 'a.txt',
      status: 'different',
      left: entry({ path: '/left/a.txt' }),
      right: entry({ path: '/a.zip::a.txt' }),
    }]
    fc._selectedNames = new Set(['/left/a.txt', '/a.zip::a.txt'])
    fc._confirmDelete = vi.fn().mockResolvedValue({ ok: true, permanent: false })

    await fc.deleteSelected()

    expect(api.deleteFile).toHaveBeenCalledTimes(1)
    expect(api.deleteFile).toHaveBeenCalledWith('/left/a.txt', undefined)
  })

  it('確認對話框有永久刪除選項，且預設不勾', async () => {
    stubApi()
    const { fc, host } = mounted({ leftPath: '/left' })
    const pending = fc._confirmDelete(['/left/a.txt'])

    const cb = host.querySelector('.fc-del-permanent')
    expect(cb).toBeTruthy()
    expect(cb.checked).toBe(false)
    host.querySelector('.fc-modal-ok').click()

    await expect(pending).resolves.toEqual({ ok: true, permanent: false })
    expect(host.querySelector('.fc-modal-backdrop')).toBeNull()
  })

  it('勾選後回報 permanent，Escape 則等於取消', async () => {
    stubApi()
    const { fc, host } = mounted({ leftPath: '/left' })

    const a = fc._confirmDelete(['/left/a.txt'])
    host.querySelector('.fc-del-permanent').checked = true
    host.querySelector('.fc-modal-ok').click()
    await expect(a).resolves.toEqual({ ok: true, permanent: true })

    const b = fc._confirmDelete(['/left/b.txt'])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(b).resolves.toMatchObject({ ok: false })
  })
})

// ── 4. Up One Level / 上一頁 / 下一頁 ─────────────────────────────────────────

describe('導覽（P2-39）', () => {
  it('parentPath 在各種根目錄前停住', () => {
    expect(parentPath('C:\\a\\b')).toBe('C:\\a')
    expect(parentPath('C:\\a')).toBe('C:\\')
    expect(parentPath('C:\\')).toBeNull()
    expect(parentPath('/usr/local/lib')).toBe('/usr/local')
    expect(parentPath('/usr')).toBe('/')
    expect(parentPath('/')).toBeNull()
    expect(parentPath('\\\\srv\\share')).toBeNull()
    expect(parentPath('\\\\srv\\share\\sub')).toBe('\\\\srv\\share')
    expect(parentPath('')).toBeNull()
    expect(parentPath(null)).toBeNull()
    // 尾端分隔符不應該多吃一層
    expect(parentPath('/usr/local/')).toBe('/usr')
  })

  it('上一層兩側同時往上，且只掃描一次', async () => {
    const api = stubApi()
    const { fc } = mounted()
    await fc.setLeft('/base/left/sub')
    await fc.setRight('/base/right/sub')
    api.readDir.mockClear()

    expect(await fc.upOneLevel()).toBe(true)
    expect(fc._leftPath).toBe('/base/left')
    expect(fc._rightPath).toBe('/base/right')
    expect(api.readDir).toHaveBeenCalledTimes(2)   // 一次掃描 = 左右各一
  })

  it('已在最上層時明說，不會把路徑清掉', async () => {
    stubApi()
    const { fc } = mounted()
    await fc.setLeft('/')
    expect(await fc.upOneLevel()).toBe(false)
    expect(fc._leftPath).toBe('/')
    expect(alerts.join('\n')).toMatch(/最上層/)
  })

  it('封存檔那一側不動，檔案系統那一側照樣上一層', async () => {
    stubApi()
    const { fc } = mounted()
    await fc.setLeft('/base/left/sub')
    await fc.setSource('right', { kind: 'archive', root: '/t/a.zip' })

    await fc.upOneLevel()

    expect(fc._leftPath).toBe('/base/left')
    expect(fc._rightPath).toBe('/t/a.zip')
    expect(fc._rightSource.kind).toBe('archive')
  })

  it('上一頁 / 下一頁走訪歷史', async () => {
    stubApi()
    const { fc } = mounted()
    await fc.setLeft('/one')
    await fc.setLeft('/two')
    await fc.setLeft('/three')

    expect(fc.canGoForward()).toBe(false)
    expect(await fc.goBack()).toBe(true)
    expect(fc._leftPath).toBe('/two')
    expect(await fc.goBack()).toBe(true)
    expect(fc._leftPath).toBe('/one')
    expect(await fc.goBack()).toBe(false)      // 已到底

    expect(await fc.goForward()).toBe(true)
    expect(fc._leftPath).toBe('/two')
  })

  it('回上一頁後開新資料夾，會截掉前方歷史', async () => {
    stubApi()
    const { fc } = mounted()
    await fc.setLeft('/one')
    await fc.setLeft('/two')
    await fc.goBack()
    await fc.setLeft('/three')

    expect(fc.canGoForward()).toBe(false)
    await fc.goBack()
    expect(fc._leftPath).toBe('/one')
  })

  it('按鈕的可用狀態跟著歷史走', async () => {
    stubApi()
    const { fc, host } = mounted()
    const back = host.querySelector('.fc-btn-nav[title^="上一頁"]')
    const fwd = host.querySelector('.fc-btn-nav[title^="下一頁"]')
    const up = host.querySelector('.fc-btn-nav[title^="上一層"]')
    expect(back.disabled).toBe(true)
    expect(up.disabled).toBe(true)

    await fc.setLeft('/a/b')
    await fc.setLeft('/a/c')
    expect(back.disabled).toBe(false)
    expect(fwd.disabled).toBe(true)
    expect(up.disabled).toBe(false)

    await fc.goBack()
    expect(fwd.disabled).toBe(false)
  })

  it('Alt+← / Alt+→ / Alt+↑ 接到同樣的動作', async () => {
    stubApi()
    const { fc } = mounted()
    const back = vi.spyOn(fc, 'goBack')
    const forward = vi.spyOn(fc, 'goForward')
    const up = vi.spyOn(fc, 'upOneLevel')

    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true }))
    }
    expect(back).toHaveBeenCalled()
    expect(forward).toHaveBeenCalled()
    expect(up).toHaveBeenCalled()
  })

  it('Delete / Shift+Delete 走刪除流程，且輸入框內不觸發', async () => {
    stubApi()
    const { fc, host } = mounted({ leftPath: '/left' })
    const del = vi.spyOn(fc, 'deleteSelected').mockResolvedValue(false)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    expect(del).toHaveBeenLastCalledWith({ permanent: false })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true }))
    expect(del).toHaveBeenLastCalledWith({ permanent: true })

    del.mockClear()
    host.querySelector('.fc-filter').focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    expect(del).not.toHaveBeenCalled()
  })
})

// ── 5. Include / Exclude 四欄 ────────────────────────────────────────────────

describe('Include/Exclude 篩選（P2-31）', () => {
  it('normalizeFilterFields 補齊欄位並丟掉雜訊', () => {
    expect(normalizeFilterFields({ includeFiles: '*.js', nope: 1 }))
      .toEqual({ includeFiles: '*.js', excludeFiles: '', includeFolders: '', excludeFolders: '' })
    expect(normalizeFilterFields(null).includeFiles).toBe('')
  })

  it('檔案遮罩不決定資料夾的去留', () => {
    const f = { includeFiles: '*.js', excludeFiles: '', includeFolders: '', excludeFolders: '' }
    expect(matchesFolderFilters('a.js', f)).toBe(true)
    expect(matchesFolderFilters('a.ts', f)).toBe(false)
    // 資料夾不套用檔案遮罩，否則整棵樹都會被藏起來、無從展開
    expect(matchesFolderFilters('src', f, { isDirectory: true })).toBe(true)
  })

  it('排除優先於包含', () => {
    const f = normalizeFilterFields({ includeFiles: '*.js', excludeFiles: '*.min.js' })
    expect(matchesFolderFilters('app.js', f)).toBe(true)
    expect(matchesFolderFilters('app.min.js', f)).toBe(false)
  })

  it('資料夾遮罩各自獨立', () => {
    const f = normalizeFilterFields({ excludeFolders: 'node_modules;.git' })
    expect(matchesFolderFilters('node_modules', f, { isDirectory: true })).toBe(false)
    expect(matchesFolderFilters('src', f, { isDirectory: true })).toBe(true)
    // 同名檔案不受資料夾遮罩影響
    expect(matchesFolderFilters('node_modules', f)).toBe(true)

    const g = normalizeFilterFields({ includeFolders: 'src' })
    expect(matchesFolderFilters('src', g, { isDirectory: true })).toBe(true)
    expect(matchesFolderFilters('docs', g, { isDirectory: true })).toBe(false)
  })

  it('_isRowVisible 同時套用快速篩選與四欄遮罩', () => {
    stubApi()
    const { fc } = mounted({ leftPath: '/left', rightPath: '/right' })
    const file = (name) => ({ name, status: 'different', left: entry({ name, path: `/left/${name}` }), right: null })
    const dir = (name) => ({
      name, status: 'different',
      left: entry({ name, path: `/left/${name}`, isDirectory: true }), right: null,
    })

    fc.setFilterFields({ excludeFiles: '*.log' })
    expect(fc._isRowVisible(file('a.js'))).toBe(true)
    expect(fc._isRowVisible(file('a.log'))).toBe(false)

    fc.setFilterFields({ excludeFolders: 'node_modules' })
    expect(fc._isRowVisible(dir('node_modules'))).toBe(false)
    expect(fc._isRowVisible(dir('src'))).toBe(true)

    // 舊的快速篩選欄位行為不變：檔案與資料夾都套用
    fc.clearFilters()
    fc._filterStr = '-src'
    expect(fc._isRowVisible(dir('src'))).toBe(false)
  })

  it('面板的四個輸入框套用後生效，清除會一併清掉快速篩選', () => {
    stubApi()
    const { fc, host } = mounted({ leftPath: '/left' })
    const inputs = host.querySelectorAll('.fc-filter-input')
    expect(inputs).toHaveLength(4)

    host.querySelector('.fc-filter').value = '*.js'
    host.querySelector('.fc-filter').dispatchEvent(new Event('input'))
    host.querySelector('.fc-filter-input[data-field="excludeFolders"]').value = 'dist'
    host.querySelector('.fc-filter-apply').click()
    expect(fc.getFilterFields().excludeFolders).toBe('dist')

    host.querySelector('.fc-filter-clear').click()
    expect(fc.getFilterFields()).toEqual(normalizeFilterFields({}))
    expect(fc._filterStr).toBe('')
    expect(host.querySelector('.fc-filter').value).toBe('')
  })

  it('面板可切換顯示', () => {
    stubApi()
    const { fc, host } = mounted()
    const panel = host.querySelector('.fc-filter-panel')
    expect(panel.style.display).toBe('none')
    host.querySelector('.fc-btn-filter').click()
    expect(panel.style.display).toBe('flex')
    fc.toggleFilterPanel()
    expect(panel.style.display).toBe('none')
  })

  it('四欄遮罩會存進 session 設定並讀回來', () => {
    stubApi()
    const { fc } = mounted()
    fc.setFilterFields({ includeFiles: '*.ts', excludeFolders: '.git' })
    const cfg = fc.getConfig()
    expect(cfg.filterFields).toEqual(normalizeFilterFields({ includeFiles: '*.ts', excludeFolders: '.git' }))

    const { fc: other } = mounted()
    other.applyConfig(cfg)
    expect(other.getFilterFields().includeFiles).toBe('*.ts')
    expect(other.getFilterFields().excludeFolders).toBe('.git')
  })
})
