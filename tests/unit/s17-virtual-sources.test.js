/**
 * @vitest-environment jsdom
 *
 * S17 — 虛擬來源（壓縮檔 / 快照 / 遠端）的路徑解析與目錄列舉。
 *
 * 這裡只驗證純函式與 _listDir 的路由；「有沒有人呼叫」由 tests/e2e/wiring.spec.js
 * 負責——單元測試擋不住接線缺失，這正是這五個 bug 藏這麼久的原因。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  FolderCompare,
  sourceKindOf,
  parseVirtualPath,
  archiveEntriesToFileEntries,
} from '../../src/renderer/src/views/folder-compare.js'

describe('sourceKindOf', () => {
  it('classifies each scheme by the reader that can serve it', () => {
    expect(sourceKindOf('C:\\tmp\\a.txt')).toBe('fs')
    expect(sourceKindOf('/home/a/b.txt')).toBe('fs')
    expect(sourceKindOf('C:\\tmp\\x.zip::src/a.txt')).toBe('archive')
    expect(sourceKindOf('snapshot://src/a.txt')).toBe('snapshot')
    expect(sourceKindOf('remote://p1/pub/a.txt')).toBe('remote')
    expect(sourceKindOf(null)).toBe('fs')
  })
})

describe('parseVirtualPath', () => {
  it('splits an archive path at the first separator only', () => {
    // A Windows drive letter contains a colon; only "::" separates.
    expect(parseVirtualPath('C:\\t\\x.zip::a/b.txt'))
      .toEqual({ kind: 'archive', container: 'C:\\t\\x.zip', entry: 'a/b.txt' })
  })

  it('reads a snapshot path as a relative entry', () => {
    expect(parseVirtualPath('snapshot://src/b.js'))
      .toEqual({ kind: 'snapshot', container: '', entry: 'src/b.js' })
  })

  it('separates a remote profile id from the path on it', () => {
    expect(parseVirtualPath('remote://p1/pub/a.txt'))
      .toEqual({ kind: 'remote', container: 'p1', entry: 'pub/a.txt' })
    expect(parseVirtualPath('remote://p1'))
      .toEqual({ kind: 'remote', container: 'p1', entry: '' })
  })
})

describe('archiveEntriesToFileEntries', () => {
  it('synthesises the parent directories tar and 7z omit', () => {
    const out = archiveEntriesToFileEntries('/t/a.tar', [
      { path: 'src/deep/a.txt', size: 3, mtime: '2024-01-01T00:00:00.000Z' },
    ])
    const byName = Object.fromEntries(out.map((e) => [e.path, e]))
    expect(Object.keys(byName)).toEqual([
      '/t/a.tar::src/', '/t/a.tar::src/deep/', '/t/a.tar::src/deep/a.txt',
    ])
    // Without a parent chain the nested entry has no row to hang under.
    expect(byName['/t/a.tar::src/'].parentPath).toBe('/t/a.tar')
    expect(byName['/t/a.tar::src/deep/a.txt'].parentPath).toBe('/t/a.tar::src/deep/')
    expect(byName['/t/a.tar::src/deep/a.txt'].size).toBe(3)
    expect(byName['/t/a.tar::src/'].isDirectory).toBe(true)
  })

  it('accepts the already-qualified paths read-archive returns', () => {
    const out = archiveEntriesToFileEntries('/t/a.zip', [
      { path: '/t/a.zip::src/b.js', size: 5 },
    ])
    expect(out.map((e) => e.path)).toEqual(['/t/a.zip::src/', '/t/a.zip::src/b.js'])
  })

  it('prefers a real directory entry over the synthesised stub', () => {
    const out = archiveEntriesToFileEntries('/t/a.zip', [
      { path: 'src/a.txt', size: 1 },
      { path: 'src/', isDirectory: true, mtime: '2024-02-02T00:00:00.000Z' },
    ])
    const dir = out.find((e) => e.name === 'src')
    expect(dir.isDirectory).toBe(true)
    expect(dir.mtime).toBe('2024-02-02T00:00:00.000Z')
  })
})

describe('FolderCompare._listDir routing', () => {
  /** @type {FolderCompare} */
  let fc

  beforeEach(() => {
    fc = new FolderCompare({})
    window.electronAPI = {
      readDir: vi.fn().mockResolvedValue([]),
      readSnapshotDir: vi.fn().mockResolvedValue([]),
      remoteListDir: vi.fn().mockResolvedValue([]),
      remoteDisconnect: vi.fn().mockResolvedValue(true),
    }
  })

  it('sends a plain directory to read-dir', async () => {
    await fc._listDir('left', '/t/x')
    expect(window.electronAPI.readDir).toHaveBeenCalledWith('/t/x')
  })

  it('slices archive entries by parent path instead of hitting the filesystem', async () => {
    fc._leftSource = { kind: 'archive', root: '/t/a.zip' }
    fc._leftZipEntries = archiveEntriesToFileEntries('/t/a.zip', [
      { path: 'a.txt' }, { path: 'src/b.js' },
    ])
    expect((await fc._listDir('left', '/t/a.zip')).map((e) => e.name).sort())
      .toEqual(['a.txt', 'src'])
    expect((await fc._listDir('left', '/t/a.zip::src/')).map((e) => e.name))
      .toEqual(['b.js'])
    expect(window.electronAPI.readDir).not.toHaveBeenCalled()
  })

  it('asks the snapshot reader for a level, with the root as ""', async () => {
    fc._leftSource = { kind: 'snapshot', root: '/t/s.mcss' }
    await fc._listDir('left', '/t/s.mcss')
    expect(window.electronAPI.readSnapshotDir).toHaveBeenCalledWith('/t/s.mcss', '')
    await fc._listDir('left', 'snapshot://src')
    expect(window.electronAPI.readSnapshotDir).toHaveBeenCalledWith('/t/s.mcss', 'src')
  })

  it('passes the profile and the in-memory secret on every remote listing', async () => {
    fc._rightSource = {
      kind: 'remote', root: 'remote://p1/', profileId: 'p1', secret: 's3cret', startDir: '',
    }
    await fc._listDir('right', 'remote://p1/')
    expect(window.electronAPI.remoteListDir).toHaveBeenCalledWith('p1', '', 's3cret')
    await fc._listDir('right', 'remote://p1/pub')
    expect(window.electronAPI.remoteListDir).toHaveBeenCalledWith('p1', 'pub', 's3cret')
  })
})

describe('FolderCompare remote lifecycle', () => {
  beforeEach(() => {
    window.electronAPI = {
      readDir: vi.fn().mockResolvedValue([]),
      remoteListDir: vi.fn().mockResolvedValue([]),
      remoteDisconnect: vi.fn().mockResolvedValue(true),
    }
  })

  it('closes the session when the side is replaced and when the view dies', async () => {
    const fc = new FolderCompare({})
    await fc.setSource('left', { kind: 'remote', root: 'remote://p1/', profileId: 'p1' })
    await fc.setLeft('/t/x')
    expect(window.electronAPI.remoteDisconnect).toHaveBeenCalledWith('p1')

    await fc.setSource('right', { kind: 'remote', root: 'remote://p2/', profileId: 'p2' })
    fc.destroy()
    await Promise.resolve()
    expect(window.electronAPI.remoteDisconnect).toHaveBeenCalledWith('p2')
  })

  it('keeps a shared connection open while the other side still uses it', async () => {
    const fc = new FolderCompare({})
    await fc.setSource('left', { kind: 'remote', root: 'remote://p1/a', profileId: 'p1' })
    await fc.setSource('right', { kind: 'remote', root: 'remote://p1/b', profileId: 'p1' })
    window.electronAPI.remoteDisconnect.mockClear()
    await fc.setLeft('/t/x')
    expect(window.electronAPI.remoteDisconnect).not.toHaveBeenCalled()
  })

  it('refuses to write to a read-only side', () => {
    const fc = new FolderCompare({})
    fc._rightSource = { kind: 'archive', root: '/t/a.zip' }
    expect(fc._isWritableSide('left')).toBe(true)
    expect(fc._isWritableSide('right')).toBe(false)
  })
})

describe('虛擬來源不能被寫入操作誤觸', () => {
  /** @type {FolderCompare} */
  let fc
  /** @type {string[]} */
  let alerts

  beforeEach(() => {
    fc = new FolderCompare({})
    alerts = []
    vi.spyOn(window, 'alert').mockImplementation((m) => { alerts.push(String(m)) })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.electronAPI = {
      readDir: vi.fn().mockResolvedValue([]),
      copyFile: vi.fn().mockResolvedValue(true),
      deleteFile: vi.fn().mockResolvedValue(true),
      remoteDisconnect: vi.fn().mockResolvedValue(true),
    }
  })

  it('批次複製時檢查來源側，不只檢查目的側', async () => {
    // 目的側是真實資料夾就放行，會讓每個 job 各自在 path validator 失敗，
    // 使用者只看到「0 項成功，N 項失敗」，看不出這個組合本來就做不到。
    fc._leftSource = { kind: 'archive', root: '/t/a.zip' }
    fc._leftPath = '/t/a.zip'
    fc._rightPath = '/t/out'
    fc._rows = [{
      status: 'left-only',
      left: { path: '/t/a.zip::a.txt', name: 'a.txt', isDirectory: false },
      right: null,
    }]
    fc._selectedNames = new Set(['/t/a.zip::a.txt'])

    await fc._batchCopyToRight()
    expect(window.electronAPI.copyFile).not.toHaveBeenCalled()
    expect(alerts.join(' ')).toMatch(/壓縮檔/)
  })

  it('copySelectedTo 檢查來源側', async () => {
    fc._leftSource = { kind: 'snapshot', root: '/t/s.mcss' }
    fc._leftPath = '/t/s.mcss'
    fc._rightPath = '/t/out'
    fc._selectedNames = new Set(['snapshot://a.txt'])
    fc._rows = [{
      status: 'left-only',
      left: { path: 'snapshot://a.txt', name: 'a.txt', isDirectory: false },
      right: null,
    }]

    await fc.copySelectedTo('right')
    expect(window.electronAPI.copyFile).not.toHaveBeenCalled()
    expect(alerts.join(' ')).toMatch(/快照/)
  })

  it('批次刪除只擋被刪除的那一側', async () => {
    fc._rightSource = { kind: 'remote', root: 'remote://p1/', profileId: 'p1' }
    fc._rows = [{
      status: 'right-only',
      left: null,
      right: { path: 'remote://p1/a.txt', name: 'a.txt', isDirectory: false },
    }]
    fc._selectedNames = new Set(['remote://p1/a.txt'])

    await fc._batchDelete('right')
    expect(window.electronAPI.deleteFile).not.toHaveBeenCalled()
    expect(alerts.join(' ')).toMatch(/遠端/)
  })

  it('同步模式在任一側是虛擬來源時不開啟', () => {
    fc._leftSource = { kind: 'archive', root: '/t/a.zip' }
    expect(fc.toggleSyncMode()).toBe(false)
    expect(fc._syncMode).toBe(false)
    expect(alerts.join(' ')).toMatch(/壓縮檔/)
  })

  it('兩側都是真實資料夾時，同步模式照常開啟', () => {
    expect(fc.toggleSyncMode()).toBe(true)
    expect(fc._syncMode).toBe(true)
    expect(alerts).toEqual([])
  })
})

describe('共用同一個遠端設定的兩側', () => {
  beforeEach(() => {
    window.electronAPI = {
      readDir: vi.fn().mockResolvedValue([]),
      remoteListDir: vi.fn().mockResolvedValue([]),
      remoteDisconnect: vi.fn().mockResolvedValue(true),
    }
  })

  it('關閉時仍然會斷線', async () => {
    // 兩側共用同一個 profile 時，逐側檢查「對側是否還在用」會讓兩側互相禮讓，
    // 結果誰都沒關，連線一直留到 server 端的閒置逾時。
    const fc = new FolderCompare({})
    await fc.setSource('left', { kind: 'remote', root: 'remote://p1/a', profileId: 'p1' })
    await fc.setSource('right', { kind: 'remote', root: 'remote://p1/b', profileId: 'p1' })
    window.electronAPI.remoteDisconnect.mockClear()

    await fc.disconnectAll()
    expect(window.electronAPI.remoteDisconnect).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.remoteDisconnect).toHaveBeenCalledWith('p1')
  })

  it('斷線後通知呼叫端把密碼忘掉', async () => {
    const forgotten = []
    const fc = new FolderCompare({})
    fc._onRemoteClosed = (ids) => forgotten.push(...ids)
    await fc.setSource('left', { kind: 'remote', root: 'remote://p1/', profileId: 'p1' })
    await fc.disconnectAll()
    expect(forgotten).toEqual(['p1'])
  })
})

describe('快照側停用內容比對', () => {
  it('選了內容模式再載入快照時會退回中繼資料比對並說明', async () => {
    const fc = new FolderCompare({})
    window.electronAPI = {
      readDir: vi.fn().mockResolvedValue([]),
      readSnapshotDir: vi.fn().mockResolvedValue([]),
    }
    fc._mode = 'content'
    await fc.setSource('left', { kind: 'snapshot', root: '/t/s.mcss' })

    // 快照不存內容，留著內容模式只會讓每一列各自報同一個錯。
    expect(fc._contentModesAvailable()).toBe(false)
    expect(fc._mode).toBe('both')
    expect(fc._modeNote).toMatch(/快照/)
  })

  it('兩側都是真實資料夾時不干涉', async () => {
    const fc = new FolderCompare({})
    window.electronAPI = { readDir: vi.fn().mockResolvedValue([]) }
    fc._mode = 'content'
    await fc.setSource('left', { kind: 'fs', root: '/t/x' })
    expect(fc._contentModesAvailable()).toBe(true)
    expect(fc._mode).toBe('content')
  })
})

describe('sourceKindOf 對真實檔名中的冒號', () => {
  it('容器不像壓縮檔時視為一般檔案', () => {
    // 冒號在 Windows 以外都是合法的檔名字元，`/data/build::2024/report.txt`
    // 是一個普通檔案；當成壓縮檔項目會送錯 reader 而讀不到。
    expect(sourceKindOf('/data/build::2024/report.txt')).toBe('fs')
    expect(sourceKindOf('/srv/notes::draft')).toBe('fs')
  })

  it('容器看起來是壓縮檔時才視為壓縮檔項目', () => {
    for (const p of ['/t/a.zip::x', '/t/a.7z::x', '/t/a.tar.gz::x', 'C:\t\a.JAR::x']) {
      expect(sourceKindOf(p)).toBe('archive')
    }
  })
})
