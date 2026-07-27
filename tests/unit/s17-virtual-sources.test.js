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
