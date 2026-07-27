/**
 * @vitest-environment jsdom
 *
 * S21 — Folder Compare：Move / Exchange、Version 欄位、Attributes 比對、設定範圍
 *
 *   1. Move：rename 快路徑、copy+delete 退路，以及「複製成功但來源沒刪掉」的中途狀態
 *   2. Exchange：四個步驟各自失敗時的回滾結果，含回滾也失敗的 unsafe 狀態
 *   3. Version：候選副檔名過濾、延遲讀取、只對可見列發 IPC、排序預取上限
 *   4. Attributes：作為比對條件、唯讀編輯、hidden 明示不支援
 *   5. Session 設定範圍：僅此檢視 vs 更新為預設值
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  FolderCompare,
  attributesDiffer,
  computeStatus,
  runMoveOne,
  runMove,
  formatMoveSummary,
  exchangeTempPath,
  runExchange,
  formatExchangeSummary,
  hasVersionCandidateExt,
  versionTextFromMetadata,
  versionTitleFromMetadata,
  saveFolderDefaults,
  loadFolderDefaults,
  clearFolderDefaults,
  FOLDER_DEFAULTS_NAME,
} from '../../src/renderer/src/views/folder-compare.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A file ops API whose every call succeeds, unless overridden. */
function okApi(overrides = {}) {
  return {
    copyFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const fail = (msg) => vi.fn().mockRejectedValue(new Error(msg))

/**
 * @param {object} opts
 * @returns {import('../../src/renderer/src/views/folder-compare.js').CompareRow}
 */
function mkRow({
  name = 'a.txt',
  size = 100,
  mtime = '2024-01-01T00:00:00.000Z',
  isDir = false,
  status = 'different',
  left = {},
  right = {},
  onlySide = null,
} = {}) {
  const shared = { name, isDirectory: isDir, size, mtime }
  return {
    name,
    status,
    left: onlySide === 'right' ? null : { ...shared, path: `/l/${name}`, ...left },
    right: onlySide === 'left' ? null : { ...shared, path: `/r/${name}`, ...right },
    children: null,
  }
}

function stubElectronAPI(extra = {}) {
  window.electronAPI = {
    readDir: vi.fn().mockResolvedValue([]),
    copyFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
    setReadOnly: vi.fn().mockImplementation((path, readOnly) => Promise.resolve({ path, readOnly })),
    readMetadata: vi.fn().mockResolvedValue({ kind: 'unknown', fields: {} }),
    openFolder: vi.fn().mockResolvedValue(null),
    showInExplorer: vi.fn(),
    ...extra,
  }
  return window.electronAPI
}

function mountFC(options = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const fc = new FolderCompare(options)
  fc.mount(host)
  fc.refresh = vi.fn()
  return fc
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  stubElectronAPI()
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── 1. Move ─────────────────────────────────────────────────────────────────

describe('runMoveOne', () => {
  it('prefers rename, which needs no copy at all', async () => {
    const api = okApi()
    const res = await runMoveOne({ src: '/l/a.txt', dest: '/r/a.txt' }, api)
    expect(res.state).toBe('moved')
    expect(api.renameFile).toHaveBeenCalledWith('/l/a.txt', '/r/a.txt')
    expect(api.copyFile).not.toHaveBeenCalled()
    expect(api.deleteFile).not.toHaveBeenCalled()
  })

  it('falls back to copy + delete when rename fails across volumes', async () => {
    const api = okApi({ renameFile: fail('EXDEV') })
    const res = await runMoveOne({ src: '/l/a.txt', dest: '/r/a.txt' }, api)
    expect(res.state).toBe('moved')
    expect(api.copyFile).toHaveBeenCalledWith('/l/a.txt', '/r/a.txt')
    expect(api.deleteFile).toHaveBeenCalledWith('/l/a.txt')
  })

  it('reports "failed" and never deletes when the copy itself fails', async () => {
    const api = okApi({ renameFile: fail('EXDEV'), copyFile: fail('ENOSPC') })
    const res = await runMoveOne({ src: '/l/a.txt', dest: '/r/a.txt' }, api)
    expect(res.state).toBe('failed')
    expect(api.deleteFile).not.toHaveBeenCalled()
    expect(res.message).toContain('ENOSPC')
    // The half-written destination is named so the user can check it.
    expect(res.message).toContain('/r/a.txt')
  })

  it('reports the half-done state when the copy lands but the source survives', async () => {
    const api = okApi({ renameFile: fail('EXDEV'), deleteFile: fail('EBUSY') })
    const res = await runMoveOne({ src: '/l/a.txt', dest: '/r/a.txt' }, api)
    expect(res.state).toBe('source-remains')
    expect(api.copyFile).toHaveBeenCalled()
    expect(res.message).toContain('EBUSY')
    expect(res.message).toContain('/l/a.txt')
  })
})

describe('formatMoveSummary', () => {
  it('names every half-done and failed job rather than only counting them', async () => {
    const results = [
      { src: '/l/ok.txt', dest: '/r/ok.txt', state: 'moved' },
      { src: '/l/half.txt', dest: '/r/half.txt', state: 'source-remains', message: '刪除來源失敗：EBUSY' },
      { src: '/l/no.txt', dest: '/r/no.txt', state: 'failed', message: '複製失敗：ENOSPC' },
    ]
    const text = formatMoveSummary(results)
    expect(text).toContain('1 項成功')
    expect(text).toContain('1 項只完成一半')
    expect(text).toContain('1 項失敗')
    expect(text).toContain('/l/half.txt')
    expect(text).toContain('EBUSY')
    expect(text).toContain('/l/no.txt')
    expect(text).toContain('ENOSPC')
  })

  it('is a plain success line when nothing went wrong', async () => {
    const results = await runMove([{ src: '/l/a', dest: '/r/a' }], okApi())
    const text = formatMoveSummary(results)
    expect(text).toBe('移動完成：1 項成功')
  })
})

describe('FolderCompare.moveSelectedTo', () => {
  it('moves the checked rows and reports the outcome', async () => {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [mkRow({ name: 'a.txt' }), mkRow({ name: 'b.txt' })]
    fc._selectedNames.add('/l/a.txt')

    await fc.moveSelectedTo('right')

    expect(window.electronAPI.renameFile).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.renameFile).toHaveBeenCalledWith('/l/a.txt', '/r/a.txt')
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('1 項成功'))
    expect(fc.refresh).toHaveBeenCalled()
  })

  it('surfaces the half-done state to the user instead of reporting success', async () => {
    stubElectronAPI({ renameFile: fail('EXDEV'), deleteFile: fail('EBUSY') })
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [mkRow({ name: 'a.txt' })]
    fc._selectedNames.add('/l/a.txt')

    await fc.moveSelectedTo('right')

    const message = window.alert.mock.calls.at(-1)[0]
    expect(message).toContain('只完成一半')
    expect(message).toContain('兩側都存在')
    expect(message).toContain('/l/a.txt')
  })

  it('does nothing when the user declines the confirmation', async () => {
    window.confirm.mockReturnValue(false)
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [mkRow({ name: 'a.txt' })]
    fc._selectedNames.add('/l/a.txt')

    await fc.moveSelectedTo('right')

    expect(window.electronAPI.renameFile).not.toHaveBeenCalled()
    expect(window.electronAPI.copyFile).not.toHaveBeenCalled()
  })

  it('skips directories and orphans on the source side', async () => {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [
      mkRow({ name: 'dir', isDir: true }),
      mkRow({ name: 'only-right.txt', onlySide: 'right', status: 'right-only' }),
    ]
    fc._selectedNames.add('/l/dir')
    fc._selectedNames.add('/r/only-right.txt')

    await fc.moveSelectedTo('right')

    expect(window.electronAPI.renameFile).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('沒有可移動的項目'))
  })

  it('refuses to move onto a browse-only source', async () => {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rightSource = { kind: 'archive', root: '/r.zip' }
    fc._rows = [mkRow({ name: 'a.txt' })]
    fc._selectedNames.add('/l/a.txt')

    await fc.moveSelectedTo('right')

    expect(window.electronAPI.renameFile).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('壓縮檔'))
  })
})

// ── 2. Exchange ─────────────────────────────────────────────────────────────

describe('runExchange', () => {
  const pair = { left: '/l/a.txt', right: '/r/a.txt' }
  const tmp = exchangeTempPath('/l/a.txt', 42)

  it('parks the left file, writes both sides, then removes the temp', async () => {
    const api = okApi()
    const res = await runExchange(pair, api, 42)
    expect(res.state).toBe('exchanged')
    expect(res.leftovers).toEqual([])
    expect(api.renameFile).toHaveBeenCalledWith('/l/a.txt', tmp)
    expect(api.copyFile.mock.calls).toEqual([
      ['/r/a.txt', '/l/a.txt'],
      [tmp, '/r/a.txt'],
    ])
    expect(api.deleteFile).toHaveBeenCalledWith(tmp, { permanent: true })
  })

  it('changes nothing when the file cannot even be parked', async () => {
    const api = okApi({ renameFile: fail('EACCES') })
    const res = await runExchange(pair, api, 42)
    expect(res.state).toBe('failed')
    expect(api.copyFile).not.toHaveBeenCalled()
    expect(api.deleteFile).not.toHaveBeenCalled()
    expect(res.message).toContain('兩側都未變更')
  })

  it('rolls the left file back when writing the left side fails', async () => {
    const renameFile = vi.fn()
      .mockResolvedValueOnce(undefined)   // park
      .mockResolvedValueOnce(undefined)   // restore
    const api = okApi({ renameFile, copyFile: fail('EPERM') })
    const res = await runExchange(pair, api, 42)
    expect(res.state).toBe('rolled-back')
    expect(renameFile).toHaveBeenLastCalledWith(tmp, '/l/a.txt')
    expect(res.leftovers).toEqual([])
  })

  it('is "unsafe" and names the temp file when the left rollback also fails', async () => {
    const renameFile = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('EEXIST'))
    const api = okApi({ renameFile, copyFile: fail('EPERM') })
    const res = await runExchange(pair, api, 42)
    expect(res.state).toBe('unsafe')
    expect(res.leftovers).toEqual([tmp])
    expect(res.message).toContain(tmp)
    expect(res.message).toContain('/l/a.txt')
    expect(res.message).toContain('EPERM')
    expect(res.message).toContain('EEXIST')
  })

  it('restores the left side when writing the right side fails', async () => {
    const copyFile = vi.fn()
      .mockResolvedValueOnce(undefined)                 // right → left
      .mockRejectedValueOnce(new Error('ENOSPC'))       // tmp → right
      .mockResolvedValueOnce(undefined)                 // tmp → left (restore)
    const api = okApi({ copyFile })
    const res = await runExchange(pair, api, 42)
    expect(res.state).toBe('rolled-back')
    expect(copyFile).toHaveBeenLastCalledWith(tmp, '/l/a.txt')
    expect(api.deleteFile).toHaveBeenCalledWith(tmp, { permanent: true })
  })

  it('is "unsafe" when the right side failed AND the left cannot be restored', async () => {
    const copyFile = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ENOSPC'))
      .mockRejectedValueOnce(new Error('EIO'))
    const api = okApi({ copyFile })
    const res = await runExchange(pair, api, 42)
    expect(res.state).toBe('unsafe')
    expect(res.leftovers).toEqual([tmp])
    // The user has to be told exactly which file holds the only surviving copy.
    expect(res.message).toContain(tmp)
    expect(res.message).toContain('右側的內容')
    // Nothing may quietly delete the temp when it is the only copy left.
    expect(api.deleteFile).not.toHaveBeenCalled()
  })

  it('still reports the leftover when only the cleanup fails', async () => {
    const api = okApi({ deleteFile: fail('EBUSY') })
    const res = await runExchange(pair, api, 42)
    expect(res.state).toBe('exchanged-with-leftover')
    expect(res.leftovers).toEqual([tmp])
    expect(res.message).toContain(tmp)
  })

  it('reports a leftover from a rollback path too', async () => {
    const copyFile = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ENOSPC'))
      .mockResolvedValueOnce(undefined)
    const api = okApi({ copyFile, deleteFile: fail('EBUSY') })
    const res = await runExchange(pair, api, 42)
    expect(res.state).toBe('exchanged-with-leftover')
    expect(res.leftovers).toEqual([tmp])
  })
})

describe('formatExchangeSummary', () => {
  it('puts the unrecoverable group first', () => {
    const text = formatExchangeSummary([
      { left: '/l/a', right: '/r/a', tmp: '/l/a.tmp', state: 'exchanged', message: '', leftovers: [] },
      { left: '/l/b', right: '/r/b', tmp: '/l/b.tmp', state: 'unsafe', message: '左側只剩 /l/b.tmp', leftovers: ['/l/b.tmp'] },
    ])
    const unsafeAt = text.indexOf('無法還原')
    const okAt = text.indexOf('互換完成：')
    expect(unsafeAt).toBeGreaterThan(-1)
    expect(okAt).toBeLessThan(unsafeAt)
    expect(text).toContain('/l/b.tmp')
    expect(text).toContain('1 組需要手動處理')
  })
})

describe('FolderCompare.exchangeSelected', () => {
  it('swaps a matched pair and reports it', async () => {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [mkRow({ name: 'a.txt' })]
    fc._selectedNames.add('/l/a.txt')

    await fc.exchangeSelected()

    expect(window.electronAPI.renameFile).toHaveBeenCalled()
    expect(window.electronAPI.copyFile).toHaveBeenCalledTimes(2)
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('1 組成功'))
  })

  it('asks twice, and one refusal is enough to stop', async () => {
    window.confirm.mockReturnValueOnce(true).mockReturnValueOnce(false)
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [mkRow({ name: 'a.txt' })]
    fc._selectedNames.add('/l/a.txt')

    await fc.exchangeSelected()

    expect(window.confirm).toHaveBeenCalledTimes(2)
    expect(window.electronAPI.renameFile).not.toHaveBeenCalled()
  })

  it('refuses a row that exists on only one side', async () => {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [mkRow({ name: 'a.txt', onlySide: 'left', status: 'left-only' })]
    fc._selectedNames.add('/l/a.txt')

    await fc.exchangeSelected()

    expect(window.electronAPI.renameFile).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('兩側都存在'))
  })

  it('surfaces the unsafe state through the view', async () => {
    stubElectronAPI({
      copyFile: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('ENOSPC'))
        .mockRejectedValueOnce(new Error('EIO')),
    })
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = [mkRow({ name: 'a.txt' })]
    fc._selectedNames.add('/l/a.txt')

    await fc.exchangeSelected()

    const message = window.alert.mock.calls.at(-1)[0]
    expect(message).toContain('需要手動處理')
    expect(message).toContain('.mycompare-exchange-')
  })
})

// ── 3. Version column ───────────────────────────────────────────────────────

describe('version metadata helpers', () => {
  it('only treats version-bearing formats as candidates', () => {
    for (const name of ['app.exe', 'lib.DLL', 'song.mp3', 'driver.sys']) {
      expect(hasVersionCandidateExt(name)).toBe(true)
    }
    for (const name of ['a.txt', 'README', 'index.js', '.gitignore', 'a.png']) {
      expect(hasVersionCandidateExt(name)).toBe(false)
    }
  })

  it('prefers the authored PE version string over the fixed pair', () => {
    expect(versionTextFromMetadata({
      kind: 'pe',
      fields: { FileVersion: '1.2.3.4', FixedFileVersion: '1.2.3.0' },
    })).toBe('1.2.3.4')
    expect(versionTextFromMetadata({
      kind: 'pe', fields: { FixedProductVersion: '9.0.0.0' },
    })).toBe('9.0.0.0')
    expect(versionTextFromMetadata({ kind: 'pe', fields: {} })).toBe('')
  })

  it('labels the MP3 answer as an MPEG version rather than a file version', () => {
    expect(versionTextFromMetadata({
      kind: 'mp3', fields: { title: 'x' }, audio: { mpegVersion: '1', layer: 3 },
    })).toBe('MPEG 1 Layer 3')
    expect(versionTextFromMetadata({ kind: 'mp3', fields: {}, audio: {} })).toBe('')
  })

  it('returns empty for anything unrecognised', () => {
    for (const bad of [null, undefined, 42, 'x', { kind: 'unknown', fields: {} }]) {
      expect(versionTextFromMetadata(bad)).toBe('')
    }
  })

  it('exposes the rest of the metadata as the tooltip', () => {
    const title = versionTitleFromMetadata({
      kind: 'mp3', fields: { title: 'Song', artist: 'Band' },
    })
    expect(title).toContain('title: Song')
    expect(title).toContain('artist: Band')
    expect(versionTitleFromMetadata({ kind: 'pe', fields: {} })).toBe('')
  })
})

describe('FolderCompare version column', () => {
  /** Let the queued drain (setTimeout 0 + awaits) run to completion. */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  }

  it('is off by default and adds no IPC', async () => {
    const fc = mountFC()
    fc._rows = [mkRow({ name: 'app.exe' })]
    fc._applyFilterAndRender()
    await settle()
    expect(window.electronAPI.readMetadata).not.toHaveBeenCalled()
  })

  it('reads and displays the version once the column is on', async () => {
    window.electronAPI.readMetadata.mockResolvedValue({
      kind: 'pe', fields: { FileVersion: '3.1.4' },
    })
    const fc = mountFC()
    fc.setColumns(['name', 'version'])
    fc._rows = [mkRow({ name: 'app.exe' })]
    fc._applyFilterAndRender()

    // Drawn immediately as pending; the read has not happened yet.
    expect(fc._dom.list.querySelector('.fc-version--pending')).not.toBeNull()
    await settle()

    const cells = [...fc._dom.list.querySelectorAll('.fc-version')]
    expect(cells.some((c) => c.textContent === '3.1.4')).toBe(true)
    expect(fc._dom.list.querySelector('.fc-version--pending')).toBeNull()
  })

  it('never asks about files whose format carries no version', async () => {
    const fc = mountFC()
    fc.setColumns(['name', 'version'])
    fc._rows = [mkRow({ name: 'notes.txt' }), mkRow({ name: 'index.js' })]
    fc._applyFilterAndRender()
    await settle()
    expect(window.electronAPI.readMetadata).not.toHaveBeenCalled()
  })

  it('caches, so re-rendering the same rows repeats no IPC', async () => {
    const fc = mountFC()
    fc.setColumns(['name', 'version'])
    fc._rows = [mkRow({ name: 'app.exe' })]
    fc._applyFilterAndRender()
    await settle()
    const first = window.electronAPI.readMetadata.mock.calls.length
    expect(first).toBeGreaterThan(0)

    fc._applyFilterAndRender()
    await settle()
    expect(window.electronAPI.readMetadata.mock.calls.length).toBe(first)
  })

  it('reports an unreadable file in the cell instead of spinning forever', async () => {
    window.electronAPI.readMetadata.mockRejectedValue(new Error('EACCES'))
    const fc = mountFC()
    fc.setColumns(['name', 'version'])
    fc._rows = [mkRow({ name: 'app.exe' })]
    fc._applyFilterAndRender()
    await settle()
    const cells = [...fc._dom.list.querySelectorAll('.fc-version')]
    expect(cells.some((c) => c.textContent === '—')).toBe(true)
    expect(fc._dom.list.querySelector('.fc-version--pending')).toBeNull()
  })

  it('asks only about the rows the virtual list actually drew', async () => {
    const fc = mountFC()
    fc.setColumns(['name', 'version'])
    fc._rows = Array.from({ length: 30_000 }, (_, i) =>
      mkRow({ name: `bin${String(i).padStart(5, '0')}.exe`, status: 'same' }))
    fc._applyFilterAndRender()
    await settle()

    expect(fc._visibleRows).toHaveLength(30_000)
    // Two sides per drawn row, and only a viewport's worth is ever drawn.
    const drawn = fc._dom.list.querySelectorAll('.fc-row').length
    expect(drawn).toBeGreaterThan(0)
    expect(drawn).toBeLessThan(100)
    const asked = window.electronAPI.readMetadata.mock.calls.length
    expect(asked).toBeGreaterThan(0)
    expect(asked).toBeLessThanOrEqual(drawn * 2)
  })

  it('caps how many files a sort by version is allowed to read', async () => {
    const fc = mountFC()
    fc.setColumns(['name', 'version'])
    fc._rows = Array.from({ length: 30_000 }, (_, i) =>
      mkRow({ name: `bin${String(i).padStart(5, '0')}.exe`, status: 'same' }))
    fc._applyFilterAndRender()
    await settle()
    window.electronAPI.readMetadata.mockClear()

    await fc.prefetchVersionsForSort()

    // 2000 is the ceiling; the already-cached visible rows are not re-read.
    const asked = window.electronAPI.readMetadata.mock.calls.length
    expect(asked).toBe(2000)
    expect(fc._dom.scanStatus.textContent).toContain('未讀取')
  })

  it('sorts on the resolved version text', async () => {
    window.electronAPI.readMetadata.mockImplementation((path) => Promise.resolve({
      kind: 'pe',
      fields: { FileVersion: path.includes('b.exe') ? '1.0.0' : '2.0.0' },
    }))
    const fc = mountFC()
    fc.setColumns(['name', 'version'])
    fc._rows = [mkRow({ name: 'a.exe', status: 'same' }), mkRow({ name: 'b.exe', status: 'same' })]
    fc._applyFilterAndRender()
    await settle()

    fc.sortBy('version')
    await settle()
    expect(fc._visibleRows.map((f) => f.row.name)).toEqual(['b.exe', 'a.exe'])
  })
})

// ── 4. Attributes as a comparison criterion ─────────────────────────────────

describe('attributesDiffer', () => {
  it('sees a read-only mismatch', () => {
    expect(attributesDiffer({ readOnly: true }, { readOnly: false })).toBe(true)
    expect(attributesDiffer({ readOnly: true }, { readOnly: true })).toBe(false)
    expect(attributesDiffer({}, {})).toBe(false)
  })

  it('sees a hidden mismatch only when both sides could actually read it', () => {
    expect(attributesDiffer({ hidden: true }, { hidden: false })).toBe(true)
    // null means "the platform cannot tell", which is not evidence either way.
    expect(attributesDiffer({ hidden: true }, { hidden: null })).toBe(false)
    expect(attributesDiffer({ hidden: null }, { hidden: null })).toBe(false)
    expect(attributesDiffer({ hidden: true }, {})).toBe(false)
  })

  it('says nothing about a missing side', () => {
    expect(attributesDiffer(null, { readOnly: true })).toBe(false)
    expect(attributesDiffer({ readOnly: true }, undefined)).toBe(false)
  })
})

describe('computeStatus with compareAttributes', () => {
  const same = { name: 'a', isDirectory: false, size: 10, mtime: '2024-01-01T00:00:00.000Z' }

  it('leaves identical files alone when the criterion is off', () => {
    expect(computeStatus({ ...same, readOnly: true }, { ...same }, 'both', 0)).toBe('same')
  })

  it('marks otherwise-identical files as different when the criterion is on', () => {
    expect(computeStatus(
      { ...same, readOnly: true }, { ...same, readOnly: false }, 'both', 0,
      { compareAttributes: true })).toBe('different')
  })

  it('applies even in name-only mode, where nothing else would differ', () => {
    expect(computeStatus(
      { ...same, readOnly: true }, { ...same, readOnly: false }, 'name', 0,
      { compareAttributes: true })).toBe('different')
  })

  it('leaves directories to the child rollup', () => {
    const dir = { ...same, isDirectory: true }
    expect(computeStatus(
      { ...dir, readOnly: true }, { ...dir, readOnly: false }, 'both', 0,
      { compareAttributes: true })).toBe('same')
  })

  it('does not fire on an unknown hidden flag', () => {
    expect(computeStatus(
      { ...same, hidden: null }, { ...same, hidden: null }, 'both', 0,
      { compareAttributes: true })).toBe('same')
  })
})

describe('FolderCompare attribute settings', () => {
  it('round-trips through getConfig / applyConfig', () => {
    const a = mountFC()
    a.setCompareAttributes(true)
    expect(a.getConfig().compareAttributes).toBe(true)

    const b = mountFC()
    expect(b.getCompareAttributes()).toBe(false)
    b.applyConfig(a.getConfig())
    expect(b.getCompareAttributes()).toBe(true)
    expect(b._dom.cbCompareAttrs.checked).toBe(true)
  })

  it('grades rows with the criterion once it is on', async () => {
    const entry = (readOnly) => ({
      name: 'a.txt', path: '/x/a.txt', isDirectory: false,
      size: 1, mtime: '2024-01-01T00:00:00.000Z', readOnly,
    })
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._leftEntries = [entry(true)]
    fc._rightEntries = [entry(false)]

    await fc._compareAndRender()
    expect(fc._rows[0].status).toBe('same')

    fc.setCompareAttributes(true)
    await fc._compareAndRender()
    expect(fc._rows[0].status).toBe('different')
  })
})

describe('FolderCompare.openAttributesDialog', () => {
  it('writes the read-only flag through setReadOnly and keeps the answer', async () => {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    const row = mkRow({ name: 'a.txt', left: { readOnly: false }, right: { readOnly: false } })
    fc._rows = [row]

    const done = fc.openAttributesDialog(row)
    const cb = document.querySelector('.fc-attr-readonly-left')
    cb.checked = true
    document.querySelector('.fc-attrs-backdrop .fc-modal-ok').click()
    await done
    await new Promise((r) => setTimeout(r, 0))

    expect(window.electronAPI.setReadOnly).toHaveBeenCalledWith('/l/a.txt', true)
    expect(row.left.readOnly).toBe(true)
  })

  it('says out loud that hidden cannot be changed', async () => {
    const fc = mountFC()
    const row = mkRow({ name: 'a.txt', left: { hidden: null }, right: { hidden: true } })
    const done = fc.openAttributesDialog(row)
    const texts = [...document.querySelectorAll('.fc-attrs-hidden')].map((e) => e.textContent)
    expect(texts[0]).toContain('未知')
    expect(texts.every((t) => t.includes('不支援修改'))).toBe(true)
    // No control is offered for it, so there is nothing to click that lies.
    expect(document.querySelector('.fc-attrs-backdrop input[data-attr="hidden"]')).toBeNull()
    document.querySelector('.fc-attrs-backdrop .fc-modal-cancel').click()
    await done
  })

  it('disables the read-only box on a browse-only side', async () => {
    const fc = mountFC()
    fc._rightSource = { kind: 'archive', root: '/r.zip' }
    const row = mkRow({ name: 'a.txt' })
    const done = fc.openAttributesDialog(row)
    expect(document.querySelector('.fc-attr-readonly-left').disabled).toBe(false)
    expect(document.querySelector('.fc-attr-readonly-right').disabled).toBe(true)
    document.querySelector('.fc-attrs-backdrop .fc-modal-cancel').click()
    await done
  })

  it('reports a failed attribute write rather than swallowing it', async () => {
    stubElectronAPI({ setReadOnly: fail('EPERM') })
    const fc = mountFC()
    const row = mkRow({ name: 'a.txt', left: { readOnly: false } })
    fc._rows = [row]

    const done = fc.openAttributesDialog(row)
    document.querySelector('.fc-attr-readonly-left').checked = true
    document.querySelector('.fc-attrs-backdrop .fc-modal-ok').click()
    await done
    await new Promise((r) => setTimeout(r, 0))

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('EPERM'))
    expect(row.left.readOnly).toBe(false)
  })
})

// ── 5. Session settings scope ───────────────────────────────────────────────

describe('folder defaults store', () => {
  it('round-trips a config under the reserved name', () => {
    expect(loadFolderDefaults()).toBeNull()
    const fc = mountFC()
    fc.setCompareAttributes(true)
    expect(saveFolderDefaults(fc.getConfig())).toBe(true)

    const stored = loadFolderDefaults()
    expect(stored?.compareAttributes).toBe(true)
    expect(FOLDER_DEFAULTS_NAME).toContain('folder-defaults')

    clearFolderDefaults()
    expect(loadFolderDefaults()).toBeNull()
  })
})

describe('FolderCompare settings scope', () => {
  it('applies to this view only by default, leaving the defaults untouched', () => {
    const source = mountFC()
    source.setCompareAttributes(true)
    const cfg = source.getConfig()

    const target = mountFC()
    target.applyConfig(cfg, { scope: 'view' })
    expect(target.getCompareAttributes()).toBe(true)
    expect(loadFolderDefaults()).toBeNull()
  })

  it('also stores the defaults when the scope says so', () => {
    const source = mountFC()
    source.setCompareAttributes(true)
    source._mtimeTolerance = 7

    const target = mountFC()
    target.applyConfig(source.getConfig(), { scope: 'default' })
    expect(loadFolderDefaults()?.compareAttributes).toBe(true)

    // A comparison opened afterwards starts from those defaults.
    const later = mountFC()
    expect(later.getCompareAttributes()).toBe(true)
    expect(later._mtimeTolerance).toBe(7)
  })

  it('lets a caller opt out of the stored defaults', () => {
    const source = mountFC()
    source.setCompareAttributes(true)
    saveFolderDefaults(source.getConfig())
    const fresh = mountFC({ useDefaults: false })
    expect(fresh.getCompareAttributes()).toBe(false)
  })

  it('refuses a snapshot belonging to another view', () => {
    const fc = mountFC()
    expect(fc.applyConfig({ __v: 1, __view: 'text', mode: 'name' })).toBe(false)
    expect(fc.applyConfig(null)).toBe(false)
    expect(fc._mode).toBe('mtime')
  })

  it('applies the chosen scope from the dialog', async () => {
    const fc = mountFC()
    fc.setCompareAttributes(true)

    const done = fc.openSettingsDialog()
    const radio = document.querySelector('.fc-settings-scopes input[value="default"]')
    radio.checked = true
    document.querySelector('.fc-settings-backdrop .fc-modal-ok').click()
    expect(await done).toBe('default')
    expect(loadFolderDefaults()?.compareAttributes).toBe(true)
  })

  it('clears the stored defaults from the dialog', async () => {
    const fc = mountFC()
    fc.setCompareAttributes(true)
    saveFolderDefaults(fc.getConfig())

    const done = fc.openSettingsDialog()
    document.querySelector('.fc-settings-clear').click()
    expect(await done).toBeNull()
    expect(loadFolderDefaults()).toBeNull()
  })

  it('cancels without touching anything', async () => {
    const fc = mountFC()
    const done = fc.openSettingsDialog()
    document.querySelector('.fc-settings-backdrop .fc-modal-cancel').click()
    expect(await done).toBeNull()
    expect(loadFolderDefaults()).toBeNull()
  })
})
