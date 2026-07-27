/**
 * @vitest-environment jsdom
 *
 * S22 — the remaining gap-matrix items for the three views that lacked them:
 *
 *   Folder: File Info panel, Copy To… (any folder), Touch (timestamp sync),
 *           and the cost-gated attribute read.
 *   Merge3: Show Context, Favor Left/Right, Merge Parent Folders,
 *           Compare to Output.
 *   Image:  difference region list, Side/Over layout, Image Info panel.
 *
 * Both virtualised views are exercised at tens of thousands of rows, because a
 * panel that quietly forces a full render is the failure mode these features
 * are most likely to introduce.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  FolderCompare,
  summarizeFolderTree,
  folderInfoRows,
  runTouch,
  formatTouchSummary,
  FOLDER_MODE_LABELS,
  flattenVisibleRows,
} from '../../src/renderer/src/views/folder-compare.js'

import {
  ThreeWayCompare,
  normalizeContextLines,
  parentDirOf,
  filterSegments,
  buildPaneRows,
  conflictPaneRow,
  MAX_CONTEXT_LINES,
  OUTPUT_DIFF_MAX_ROWS,
} from '../../src/renderer/src/views/three-way-compare.js'

import {
  ImageCompare,
  base64ByteLength,
  formatBytes,
  imageInfoRows,
} from '../../src/renderer/src/views/image-compare.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function stubElectronAPI(extra = {}) {
  window.electronAPI = {
    readDir: vi.fn().mockResolvedValue([]),
    copyFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
    mkdirFolder: vi.fn().mockResolvedValue(undefined),
    setMtime: vi.fn().mockImplementation((path, mtime) => Promise.resolve({ path, mtime })),
    setReadOnly: vi.fn().mockResolvedValue(undefined),
    openFolder: vi.fn().mockResolvedValue(null),
    readMetadata: vi.fn().mockResolvedValue({ kind: 'unknown', fields: {} }),
    showInExplorer: vi.fn(),
    saveFile: vi.fn().mockResolvedValue(undefined),
    ...extra,
  }
  return window.electronAPI
}

/**
 * @param {object} opts
 * @returns {object} a CompareRow-shaped object
 */
function mkRow({
  name = 'a.txt', size = 100, mtime = '2024-01-01T00:00:00.000Z',
  isDir = false, status = 'different', onlySide = null,
  left = {}, right = {}, children = null,
} = {}) {
  const shared = { name, isDirectory: isDir, size, mtime }
  return {
    name,
    status,
    left: onlySide === 'right' ? null : { ...shared, path: `/l/${name}`, ...left },
    right: onlySide === 'left' ? null : { ...shared, path: `/r/${name}`, ...right },
    children,
  }
}

function mountFC(options = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const fc = new FolderCompare(options)
  fc.mount(host)
  fc.refresh = vi.fn().mockResolvedValue(undefined)
  return fc
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  stubElectronAPI()
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════════
// Folder — File Info
// ═══════════════════════════════════════════════════════════════════════════

describe('summarizeFolderTree', () => {
  it('counts files, directories and bytes per side, recursing into children', () => {
    const tree = [
      mkRow({ name: 'a.txt', size: 100, status: 'same' }),
      mkRow({ name: 'only-left.txt', size: 50, status: 'left-only', onlySide: 'left' }),
      mkRow({
        name: 'sub', isDir: true, status: 'different',
        children: [mkRow({ name: 'b.txt', size: 200, status: 'different' })],
      }),
    ]
    const s = summarizeFolderTree(tree)
    // sub counts as a directory on both sides; a.txt + b.txt are files.
    expect(s.left).toEqual({ files: 3, dirs: 1, bytes: 350 })
    expect(s.right).toEqual({ files: 2, dirs: 1, bytes: 300 })
    expect(s.status).toEqual({ same: 1, 'left-only': 1, different: 2 })
    expect(s.rows).toBe(4)
  })

  it('flags the totals as partial while any directory is still unexpanded', () => {
    const loaded = summarizeFolderTree([
      mkRow({ name: 'sub', isDir: true, children: [] }),
    ])
    expect(loaded.partial).toBe(false)

    const unloaded = summarizeFolderTree([
      mkRow({ name: 'sub', isDir: true, children: null }),
    ])
    expect(unloaded.partial).toBe(true)
  })

  it('survives an empty tree', () => {
    const s = summarizeFolderTree([])
    expect(s.rows).toBe(0)
    expect(s.partial).toBe(false)
    expect(s.left.bytes).toBe(0)
  })

  it('ignores a non-numeric size instead of producing NaN bytes', () => {
    const s = summarizeFolderTree([mkRow({ name: 'x', left: { size: null }, right: { size: 'big' } })])
    expect(s.left.bytes).toBe(0)
    expect(s.right.bytes).toBe(0)
    expect(Number.isNaN(s.left.bytes)).toBe(false)
  })
})

describe('folderInfoRows', () => {
  const base = {
    leftPath: '/l', rightPath: '/r', mode: FOLDER_MODE_LABELS.mtime,
    summary: summarizeFolderTree([mkRow({ name: 'a', status: 'different' })]),
    scanMs: 42,
  }

  it('reports every status counter, including the zeroes', () => {
    const rows = Object.fromEntries(folderInfoRows(base))
    expect(rows['不同']).toBe('1')
    expect(rows['相同']).toBe('0')
    expect(rows['僅左側']).toBe('0')
    expect(rows['掃描耗時']).toBe('42 ms')
  })

  it('says so when nothing has been scanned yet', () => {
    const rows = Object.fromEntries(folderInfoRows({ ...base, scanMs: null }))
    expect(rows['掃描耗時']).toContain('尚未掃描')
  })

  it('adds an explicit caveat when the tree is only partly loaded', () => {
    const summary = summarizeFolderTree([mkRow({ name: 'sub', isDir: true, children: null })])
    const rows = Object.fromEntries(folderInfoRows({ ...base, summary }))
    expect(rows['注意']).toContain('未展開')

    const complete = Object.fromEntries(folderInfoRows(base))
    expect(complete['注意']).toBeUndefined()
  })
})

describe('FolderCompare.getFolderInfo / openInfoDialog', () => {
  it('reports the mode label and the elapsed scan time', async () => {
    const fc = mountFC({ mode: 'content' })
    fc._rows = [mkRow({ name: 'a', status: 'same' })]
    const info = fc.getFolderInfo()
    expect(info.mode).toBe(FOLDER_MODE_LABELS.content)
    expect(info.summary.status.same).toBe(1)
    expect(info.scanMs).toBeNull()

    // A completed generation records its duration; a cancelled one must not.
    const ctrl = fc._beginScan()
    fc._endScan(ctrl)
    expect(typeof fc.getFolderInfo().scanMs).toBe('number')

    const ctrl2 = fc._beginScan()
    fc._lastScanMs = 999
    ctrl2.abort()
    fc._endScan(ctrl2)
    expect(fc.getFolderInfo().scanMs).toBe(999)
  })

  it('renders one table row per info line and closes on Escape', async () => {
    const fc = mountFC()
    fc._rows = [mkRow({ name: 'a', status: 'different' })]
    const p = fc.openInfoDialog()
    const modal = fc._dom.root.querySelector('.fc-info-backdrop')
    expect(modal).toBeTruthy()
    expect(modal.querySelectorAll('.fc-info-table tr').length)
      .toBe(folderInfoRows(fc.getFolderInfo()).length)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await p
    expect(fc._dom.root.querySelector('.fc-info-backdrop')).toBeNull()
  })

  it('is reachable from the toolbar', () => {
    const fc = mountFC()
    const btn = fc._dom.root.querySelector('.fc-btn-info')
    expect(btn).toBeTruthy()
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(fc._dom.root.querySelector('.fc-info-backdrop')).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Folder — attribute read cost
// ═══════════════════════════════════════════════════════════════════════════

describe('FolderCompare attribute reads', () => {
  it('does not ask for attributes when nothing on screen uses them', async () => {
    const fc = mountFC()
    fc._leftSource = { kind: 'fs', root: '/l' }
    await fc._listDir('left', '/l')
    expect(window.electronAPI.readDir).toHaveBeenCalledWith('/l')
  })

  it('asks for them once the attribute column is on', async () => {
    const fc = mountFC()
    fc._columns = ['name', 'attrs']
    fc._leftSource = { kind: 'fs', root: '/l' }
    await fc._listDir('left', '/l')
    expect(window.electronAPI.readDir).toHaveBeenCalledWith('/l', { attributes: true })
  })

  it('asks for them when attributes are a comparison criterion', async () => {
    const fc = mountFC({ compareAttributes: true })
    fc._leftSource = { kind: 'fs', root: '/l' }
    await fc._listDir('left', '/l')
    expect(window.electronAPI.readDir).toHaveBeenCalledWith('/l', { attributes: true })
  })

  it('re-scans when the criterion is switched on, since only a scan reads the bit', () => {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc.setCompareAttributes(true)
    expect(fc.refresh).toHaveBeenCalled()
  })

  it('does not re-scan when it is switched off', () => {
    const fc = mountFC({ compareAttributes: true })
    fc._leftPath = '/l'
    fc._compareAndRender = vi.fn().mockResolvedValue(undefined)
    fc.setCompareAttributes(false)
    expect(fc.refresh).not.toHaveBeenCalled()
    expect(fc._compareAndRender).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Folder — Copy To… (any folder)
// ═══════════════════════════════════════════════════════════════════════════

describe('FolderCompare.copySelectedToFolder', () => {
  function fcWithRows(rows) {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    fc._rows = rows
    for (const row of rows) {
      const key = row.left?.path || row.right?.path
      if (key) fc._selectedNames.add(key)
    }
    return fc
  }

  it('copies into the chosen folder, preserving the relative layout', async () => {
    window.electronAPI.openFolder.mockResolvedValue({ path: '/dest' })
    const fc = fcWithRows([mkRow({ name: 'a.txt' })])
    await fc.copySelectedToFolder('left')
    expect(window.electronAPI.copyFile).toHaveBeenCalledWith('/l/a.txt', '/dest/a.txt')
  })

  it('creates the intermediate folders the relative path names', async () => {
    const fc = fcWithRows([mkRow({
      name: 'b.txt',
      left: { path: '/l/sub/b.txt' },
      right: { path: '/r/sub/b.txt' },
    })])
    await fc.copySelectedToFolder('left', '/dest')
    expect(window.electronAPI.mkdirFolder).toHaveBeenCalledWith('/dest/sub')
    expect(window.electronAPI.copyFile).toHaveBeenCalledWith('/l/sub/b.txt', '/dest/sub/b.txt')
  })

  it('skips directories and says nothing was copyable', async () => {
    const fc = fcWithRows([mkRow({ name: 'sub', isDir: true })])
    await fc.copySelectedToFolder('left', '/dest')
    expect(window.electronAPI.copyFile).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('沒有可複製'))
  })

  it('surfaces a per-file failure rather than swallowing it', async () => {
    window.electronAPI.copyFile.mockRejectedValue(new Error('EACCES'))
    const fc = fcWithRows([mkRow({ name: 'a.txt' })])
    await fc.copySelectedToFolder('left', '/dest')
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
  })

  it('aborts silently when the folder dialog is dismissed', async () => {
    window.electronAPI.openFolder.mockResolvedValue(null)
    const fc = fcWithRows([mkRow({ name: 'a.txt' })])
    await fc.copySelectedToFolder('left')
    expect(window.electronAPI.copyFile).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Folder — Touch
// ═══════════════════════════════════════════════════════════════════════════

describe('runTouch / formatTouchSummary', () => {
  it('applies every timestamp and reports the count', async () => {
    const api = { setMtime: vi.fn().mockResolvedValue(undefined) }
    const out = await runTouch([
      { src: '/l/a', dest: '/r/a', mtime: '2024-01-01T00:00:00.000Z' },
      { src: '/l/b', dest: '/r/b', mtime: '2024-01-02T00:00:00.000Z' },
    ], api)
    expect(out.done).toBe(2)
    expect(out.failures).toEqual([])
    expect(api.setMtime).toHaveBeenCalledWith('/r/b', '2024-01-02T00:00:00.000Z')
    expect(formatTouchSummary(out)).toContain('2')
  })

  it('keeps going after a failure and names the file that failed', async () => {
    const api = {
      setMtime: vi.fn()
        .mockRejectedValueOnce(new Error('EPERM'))
        .mockResolvedValueOnce(undefined),
    }
    const out = await runTouch([
      { src: '/l/a', dest: '/r/a', mtime: 'x' },
      { src: '/l/b', dest: '/r/b', mtime: 'y' },
    ], api)
    expect(out.done).toBe(1)
    expect(out.failures).toHaveLength(1)
    const summary = formatTouchSummary(out)
    expect(summary).toContain('/r/a')
    expect(summary).toContain('EPERM')
  })
})

describe('FolderCompare.touchSelected', () => {
  function fcWithPair(overrides = {}) {
    const fc = mountFC()
    fc._leftPath = '/l'
    fc._rightPath = '/r'
    const row = mkRow({ name: 'a.txt', ...overrides })
    fc._rows = [row]
    fc._selectedNames.add(row.left?.path || row.right?.path)
    return { fc, row }
  }

  it('copies the left timestamp onto the right file', async () => {
    const { fc } = fcWithPair({
      left: { mtime: '2020-05-05T00:00:00.000Z' },
      right: { mtime: '2023-01-01T00:00:00.000Z' },
    })
    await fc.touchSelected('left-to-right')
    expect(window.electronAPI.setMtime)
      .toHaveBeenCalledWith('/r/a.txt', '2020-05-05T00:00:00.000Z')
  })

  it('reverses direction on demand', async () => {
    const { fc } = fcWithPair({ right: { mtime: '2021-02-02T00:00:00.000Z' } })
    await fc.touchSelected('right-to-left')
    expect(window.electronAPI.setMtime)
      .toHaveBeenCalledWith('/l/a.txt', '2021-02-02T00:00:00.000Z')
  })

  it('refuses an orphan, which has no other side to copy from', async () => {
    const { fc } = fcWithPair({ onlySide: 'left', status: 'left-only' })
    await fc.touchSelected('left-to-right')
    expect(window.electronAPI.setMtime).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('沒有可同步時間'))
  })

  it('skips a source whose timestamp is unreadable rather than sending a bad value', async () => {
    const { fc } = fcWithPair({ left: { mtime: null } })
    await fc.touchSelected('left-to-right')
    expect(window.electronAPI.setMtime).not.toHaveBeenCalled()
  })

  it('does nothing when the user declines the confirmation', async () => {
    window.confirm.mockReturnValue(false)
    const { fc } = fcWithPair()
    await fc.touchSelected('left-to-right')
    expect(window.electronAPI.setMtime).not.toHaveBeenCalled()
  })

  it('says so plainly when the main process has no setMtime at all', async () => {
    const { fc } = fcWithPair()
    delete window.electronAPI.setMtime
    await fc.touchSelected('left-to-right')
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('沒有提供設定修改時間'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Folder — the new panel must not disturb the virtual list
// ═══════════════════════════════════════════════════════════════════════════

describe('FolderCompare at scale', () => {
  it('summarises 40k rows without touching the DOM, and the list stays windowed', () => {
    const rows = Array.from({ length: 40_000 }, (_, i) =>
      mkRow({ name: `f${i}.txt`, size: 10, status: i % 2 ? 'same' : 'different' }))

    const s = summarizeFolderTree(rows)
    expect(s.rows).toBe(40_000)
    expect(s.status.same).toBe(20_000)
    expect(s.left.bytes).toBe(400_000)

    const fc = mountFC()
    fc._rows = rows
    fc._applyFilterAndRender()
    expect(fc._visibleRows.length).toBe(40_000)
    // The window renders a viewport's worth, never the whole tree.
    const rendered = fc._dom.root.querySelectorAll('.fc-row').length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(1000)

    // And the info panel reads the model, not the rendered rows.
    expect(fc.getFolderInfo().summary.rows).toBe(40_000)
  })

  it('flattenVisibleRows still honours the filter at scale', () => {
    const rows = Array.from({ length: 30_000 }, (_, i) =>
      mkRow({ name: `f${i}`, status: i % 3 === 0 ? 'same' : 'different' }))
    const flat = flattenVisibleRows(rows, {
      isExpanded: () => false,
      isVisible: (r) => r.status !== 'same',
    })
    expect(flat.length).toBe(20_000)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Merge3 — Show Context
// ═══════════════════════════════════════════════════════════════════════════

describe('normalizeContextLines', () => {
  it('clamps into [0, MAX] and falls back on garbage', () => {
    expect(normalizeContextLines(0)).toBe(0)
    expect(normalizeContextLines(7)).toBe(7)
    expect(normalizeContextLines(-3)).toBe(2)
    expect(normalizeContextLines('abc')).toBe(2)
    expect(normalizeContextLines(10_000)).toBe(MAX_CONTEXT_LINES)
    expect(normalizeContextLines(3.9)).toBe(3)
  })
})

describe('conflict context', () => {
  /** Twelve unchanged lines either side of one conflict. */
  const segments = [
    { type: 'normal', lines: Array.from({ length: 12 }, (_, i) => `pre${i}`), kind: 'same' },
    { type: 'conflict', id: 0, leftLines: ['L'], baseLines: ['B'], rightLines: ['R'], baseStart: 12 },
    { type: 'normal', lines: Array.from({ length: 12 }, (_, i) => `post${i}`), kind: 'same' },
  ]

  it('keeps exactly the requested number of lines on each side', () => {
    for (const n of [0, 1, 2, 5]) {
      const out = filterSegments(segments, 'conflicts', n)
      const normals = out.filter((s) => s.type === 'normal')
      const kept = normals.reduce((sum, s) => sum + s.lines.length, 0)
      expect(kept).toBe(n * 2)
    }
  })

  it('drops the context segments entirely at zero', () => {
    const out = filterSegments(segments, 'conflicts', 0)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('conflict')
  })

  it('moves the conflict row as the context grows', () => {
    expect(conflictPaneRow(segments, 0, 'conflicts', 0)).toBe(0)
    expect(conflictPaneRow(segments, 0, 'conflicts', 2)).toBe(2)
    expect(conflictPaneRow(segments, 0, 'conflicts', 5)).toBe(5)
  })

  it('threads through buildPaneRows so every pane agrees', () => {
    for (const n of [1, 4]) {
      const rows = buildPaneRows('base', { showFilter: 'conflicts', segments, contextLines: n })
      expect(rows).toHaveLength(n * 2 + 1)
    }
  })
})

describe('ThreeWayCompare Show Context', () => {
  function mount(contents = {}) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new ThreeWayCompare()
    view.mount(host)
    view.setSide('base', contents.base ?? 'a\nb\nc\nd\ne\nf\ng')
    view.setSide('left', contents.left ?? 'a\nb\nc\nL\ne\nf\ng')
    view.setSide('right', contents.right ?? 'a\nb\nc\nR\ne\nf\ng')
    return { view, host }
  }

  it('has a toolbar control that changes the rendered rows', () => {
    const { view, host } = mount()
    view.setShowFilter('conflicts')
    const before = view.getPaneRows('base').length

    const input = host.querySelector('.mw-context-input')
    expect(input).toBeTruthy()
    input.value = '0'
    input.dispatchEvent(new Event('change'))

    expect(view.getContextLines()).toBe(0)
    expect(view.getPaneRows('base').length).toBeLessThan(before)
  })

  it('clamps a nonsense entry and writes the clamped value back into the box', () => {
    const { view, host } = mount()
    const input = host.querySelector('.mw-context-input')
    input.value = '-9'
    input.dispatchEvent(new Event('change'))
    expect(view.getContextLines()).toBe(2)
    expect(input.value).toBe('2')
  })

  it('stores the value in the mode that does not use it, without repainting', () => {
    const { view } = mount()
    expect(view.getShowFilter()).toBe('all')
    const rows = view.getPaneRows('base').length
    view.setContextLines(9)
    expect(view.getContextLines()).toBe(9)
    expect(view.getPaneRows('base').length).toBe(rows)
  })

  it('round-trips through getConfig / applyConfig', () => {
    const { view } = mount()
    view.setContextLines(6)
    const cfg = view.getConfig()

    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const other = new ThreeWayCompare()
    other.mount(host2)
    other.applyConfig(cfg)
    expect(other.getContextLines()).toBe(6)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Merge3 — Favor Left / Right
// ═══════════════════════════════════════════════════════════════════════════

describe('ThreeWayCompare favour', () => {
  function mountConflicting() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new ThreeWayCompare()
    view.mount(host)
    view.setSide('base', 'a\nb\nc')
    view.setSide('left', 'a\nLEFT\nc')
    view.setSide('right', 'a\nRIGHT\nc')
    return { view, host }
  }

  it('resolves the conflicts already on screen', () => {
    const { view } = mountConflicting()
    expect(view.getConflictCount()).toBe(1)
    expect(view.setFavor('left')).toBe(1)
    expect(view._buildOutputText()).toContain('LEFT')
    expect(view._buildOutputText()).not.toContain('<<<<<<<')
  })

  it('keeps applying to conflicts a later merge creates', () => {
    const { view } = mountConflicting()
    view.setFavor('right')
    // A different algorithm re-runs the merge and rebuilds every conflict.
    view.setAlgorithm('patience')
    expect(view._buildOutputText()).toContain('RIGHT')
    expect(view._buildOutputText()).not.toContain('<<<<<<<')
  })

  it('never overrides a choice the user already made', () => {
    const { view } = mountConflicting()
    view.setConflictChoice(0, 'base')
    expect(view.setFavor('left')).toBe(0)
    expect(view._buildOutputText()).toContain('b')
    expect(view._buildOutputText()).not.toContain('LEFT')
  })

  it('leaves existing work alone when switched back to "none"', () => {
    const { view } = mountConflicting()
    view.setFavor('left')
    expect(view.setFavor('none')).toBe(0)
    expect(view.getFavor()).toBe('none')
    expect(view._buildOutputText()).toContain('LEFT')
  })

  it('ignores an unknown value', () => {
    const { view } = mountConflicting()
    view.setFavor('sideways')
    expect(view.getFavor()).toBe('none')
  })

  it('is driven by the toolbar select and survives a config round-trip', () => {
    const { view, host } = mountConflicting()
    const sel = host.querySelector('.mw-favor-select')
    expect(sel).toBeTruthy()
    sel.value = 'right'
    sel.dispatchEvent(new Event('change'))
    expect(view.getFavor()).toBe('right')

    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const other = new ThreeWayCompare()
    other.mount(host2)
    other.applyConfig(view.getConfig())
    expect(other.getFavor()).toBe('right')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Merge3 — Merge Parent Folders
// ═══════════════════════════════════════════════════════════════════════════

describe('parentDirOf', () => {
  it('handles both separators and both roots', () => {
    expect(parentDirOf('/a/b/c.txt')).toBe('/a/b')
    expect(parentDirOf('C:\\a\\b.txt')).toBe('C:\\a')
    expect(parentDirOf('/a.txt')).toBe('/')
    expect(parentDirOf('a.txt')).toBe('')
    expect(parentDirOf('')).toBe('')
    expect(parentDirOf(null)).toBe('')
  })
})

describe('ThreeWayCompare.mergeParentFolders', () => {
  function mountWithPaths() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new ThreeWayCompare()
    view.mount(host)
    view.setSide('left', 'a', '/proj/v1/f.txt')
    view.setSide('base', 'a', '/proj/base/f.txt')
    view.setSide('right', 'a', '/proj/v2/f.txt')
    return { view, host }
  }

  it('is disabled — and does nothing — while no host has taken the hand-off', () => {
    const { view, host } = mountWithPaths()
    const btn = host.querySelector('.mw-btn-parent-folders')
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain('open-parent-folders')
    expect(view.mergeParentFolders()).toBe(false)
  })

  it('enables itself as soon as a host subscribes', () => {
    const { view, host } = mountWithPaths()
    const seen = []
    view.on('open-parent-folders', (p) => seen.push(p))
    const btn = host.querySelector('.mw-btn-parent-folders')
    expect(btn.disabled).toBe(false)

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(seen).toEqual([{ left: '/proj/v1', base: '/proj/base', right: '/proj/v2' }])
  })

  it('stays disabled with a listener but no files loaded', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new ThreeWayCompare()
    view.mount(host)
    view.on('open-parent-folders', () => {})
    expect(view.canMergeParentFolders()).toBe(false)
    expect(host.querySelector('.mw-btn-parent-folders').disabled).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Merge3 — Compare to Output
// ═══════════════════════════════════════════════════════════════════════════

describe('ThreeWayCompare.compareToOutput', () => {
  function mountResolved() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new ThreeWayCompare()
    view.mount(host)
    view.setSide('base', 'a\nb\nc', '/p/base.txt')
    view.setSide('left', 'a\nLEFT\nc', '/p/left.txt')
    view.setSide('right', 'a\nb\nc', '/p/right.txt')
    return { view, host }
  }

  it('hands the pair to the host when one is listening', () => {
    const { view } = mountResolved()
    const seen = []
    view.on('compare-to-output', (p) => seen.push(p))
    expect(view.compareToOutput('left')).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0].side).toBe('left')
    expect(seen[0].sourcePath).toBe('/p/left.txt')
    expect(seen[0].sourceText).toContain('LEFT')
    expect(typeof seen[0].outputText).toBe('string')
    // No host listener means no dialog; with one, the view stays untouched.
    expect(document.querySelector('.mw-modal-backdrop')).toBeNull()
  })

  it('falls back to an in-view diff so the button is never dead', () => {
    const { view, host } = mountResolved()
    expect(view.compareToOutput('right')).toBe(true)
    const modal = host.querySelector('.mw-modal-backdrop')
    expect(modal).toBeTruthy()
    expect(modal.querySelectorAll('.mw-modal-diff-row').length).toBeGreaterThan(0)

    modal.querySelector('.mw-modal-close').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(host.querySelector('.mw-modal-backdrop')).toBeNull()
  })

  it('says when the source and the output are identical', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new ThreeWayCompare()
    view.mount(host)
    view.setSide('base', 'a\nb', '/p/base.txt')
    view.setSide('left', 'a\nb', '/p/left.txt')
    view.setSide('right', 'a\nb', '/p/right.txt')
    view.compareToOutput('left')
    expect(host.querySelector('.mw-modal-hint').textContent).toContain('完全相同')
  })

  it('elides rather than rendering an unbounded document', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new ThreeWayCompare()
    view.mount(host)
    const big = Array.from({ length: OUTPUT_DIFF_MAX_ROWS + 500 }, (_, i) => `line${i}`).join('\n')
    view.setSide('base', big, '/p/base.txt')
    view.setSide('left', big, '/p/left.txt')
    view.setSide('right', big, '/p/right.txt')
    view.compareToOutput('left')
    const rows = host.querySelectorAll('.mw-modal-diff-row').length
    expect(rows).toBe(OUTPUT_DIFF_MAX_ROWS)
    expect(host.querySelector('.mw-modal-diff').textContent).toContain('未顯示')
  })

  it('refuses an unknown side and an empty view', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new ThreeWayCompare()
    view.mount(host)
    expect(view.compareToOutput('middle')).toBe(false)
    expect(view.compareToOutput('left')).toBe(false)
  })

  it('is reachable from the toolbar', () => {
    const { view, host } = mountResolved()
    const seen = []
    view.on('compare-to-output', (p) => seen.push(p))
    host.querySelector('.mw-output-cmp-select').value = 'base'
    host.querySelector('.mw-btn-compare-output')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(seen[0].side).toBe('base')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Merge3 — the new controls must not break virtualisation
// ═══════════════════════════════════════════════════════════════════════════

describe('ThreeWayCompare at scale', () => {
  it('windows 30k lines and keeps windowing after every new control is used', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new ThreeWayCompare()
    view.mount(host)

    const n = 30_000
    const base = Array.from({ length: n }, (_, i) => `l${i}`).join('\n')
    const left = base.replace('l100\n', 'LEFT\n')
    const right = base.replace('l100\n', 'RIGHT\n')
    view.setSide('base', base)
    view.setSide('left', left)
    view.setSide('right', right)

    expect(view.getPaneRows('base').length).toBe(n)
    const rendered = () => host.querySelectorAll('.mw-content-base .mw-line').length
    expect(rendered()).toBeLessThan(200)

    view.setContextLines(50)
    view.setShowFilter('conflicts')
    expect(rendered()).toBeLessThan(200)

    view.setFavor('left')
    expect(rendered()).toBeLessThan(200)

    view.setShowFilter('all')
    expect(view.getPaneRows('base').length).toBe(n)
    expect(rendered()).toBeLessThan(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Image — info helpers
// ═══════════════════════════════════════════════════════════════════════════

describe('base64ByteLength / formatBytes', () => {
  it('accounts for padding', () => {
    // 'AAAA' → 3 bytes, 'AAA=' → 2, 'AA==' → 1
    expect(base64ByteLength('AAAA')).toBe(3)
    expect(base64ByteLength('AAA=')).toBe(2)
    expect(base64ByteLength('AA==')).toBe(1)
    expect(base64ByteLength('')).toBe(0)
    expect(base64ByteLength(null)).toBe(0)
  })

  it('ignores line breaks in a wrapped payload', () => {
    expect(base64ByteLength('AAAA\nAAAA')).toBe(6)
  })

  it('formats each magnitude and refuses to invent a value', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB')
    expect(formatBytes(null)).toBe('（未知）')
    expect(formatBytes(NaN)).toBe('（未知）')
  })
})

describe('imageInfoRows', () => {
  it('reports the pixel-derived depth without claiming to know the file header', () => {
    const rgba = Object.fromEntries(imageInfoRows({
      path: '/a.png', format: 'png', bytes: 1024, width: 4, height: 2, depth: 'rgba',
    }))
    expect(rgba['色彩深度']).toContain('32')
    expect(rgba['尺寸']).toBe('4 × 2')
    expect(rgba['總像素']).toBe('8')
    expect(rgba['格式']).toBe('PNG')
    expect(rgba['檔案大小']).toBe('1.0 KB')

    const rgb = Object.fromEntries(imageInfoRows({
      path: '/a.jpg', format: 'jpg', bytes: 1, width: 1, height: 1, depth: 'rgb',
    }))
    expect(rgb['色彩深度']).toContain('24')

    const unknown = Object.fromEntries(imageInfoRows({
      path: '/a', format: '', bytes: null, width: 0, height: 0, depth: 'unknown',
    }))
    expect(unknown['色彩深度']).toContain('未知')
    expect(unknown['檔案大小']).toBe('（未知）')
  })

  it('says "not loaded" rather than printing zeroes', () => {
    expect(imageInfoRows(null)).toEqual([['狀態', '（未載入）']])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Image — layout / region list / info panel
// ═══════════════════════════════════════════════════════════════════════════

describe('ImageCompare layout, region list and info panel', () => {
  function mountIC() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const ic = new ImageCompare()
    ic.mount(host)
    return { ic, host }
  }

  it('toggles between side-by-side and over-under', () => {
    const { ic, host } = mountIC()
    const body = host.querySelector('.ic-body')
    expect(ic.getLayout()).toBe('side')
    expect(body.classList.contains('ic-body--over')).toBe(false)

    expect(ic.toggleLayout()).toBe('over')
    expect(body.classList.contains('ic-body--over')).toBe(true)

    host.querySelector('.ic-btn-layout').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(ic.getLayout()).toBe('side')
    expect(body.classList.contains('ic-body--over')).toBe(false)
  })

  it('ignores an unknown layout', () => {
    const { ic } = mountIC()
    expect(ic.setLayout('diagonal')).toBe('side')
  })

  it('round-trips the layout through getConfig / applyConfig', () => {
    const { ic } = mountIC()
    ic.setLayout('over')
    const cfg = ic.getConfig()

    const { ic: other, host } = mountIC()
    other.applyConfig(cfg)
    expect(other.getLayout()).toBe('over')
    expect(host.querySelector('.ic-body').classList.contains('ic-body--over')).toBe(true)
  })

  it('lists every diff region and jumps to the one clicked', () => {
    const { ic, host } = mountIC()
    ic._diffRegions = [
      { x: 0, y: 0, w: 8, h: 8, count: 12 },
      { x: 8, y: 0, w: 8, h: 8, count: 3 },
      { x: 0, y: 8, w: 8, h: 8, count: 40 },
    ]
    expect(ic.toggleRegionList()).toBe(true)

    const items = host.querySelectorAll('.ic-region-item')
    expect(items).toHaveLength(3)
    expect(items[2].textContent).toContain('40')
    expect(host.querySelector('.ic-region-count').textContent).toContain('3')

    items[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(ic.getCurrentDiffIndex()).toBe(1)
    expect(host.querySelectorAll('.ic-region-item--current')).toHaveLength(1)
    expect(host.querySelectorAll('.ic-region-item')[1]
      .classList.contains('ic-region-item--current')).toBe(true)
  })

  it('keeps the list highlight in step with keyboard navigation', () => {
    const { ic, host } = mountIC()
    ic._diffRegions = [
      { x: 0, y: 0, w: 4, h: 4, count: 1 },
      { x: 4, y: 0, w: 4, h: 4, count: 1 },
    ]
    ic.toggleRegionList(true)
    ic.nextDifference()
    expect(host.querySelectorAll('.ic-region-item')[ic.getCurrentDiffIndex()]
      .classList.contains('ic-region-item--current')).toBe(true)
  })

  it('says there are no regions rather than showing an empty box', () => {
    const { ic, host } = mountIC()
    ic._diffRegions = []
    ic.toggleRegionList(true)
    expect(host.querySelector('.ic-region-count').textContent).toContain('無差異區塊')
    expect(host.querySelectorAll('.ic-region-item')).toHaveLength(0)
  })

  it('hides the list again and stops rendering into it', () => {
    const { ic, host } = mountIC()
    ic._diffRegions = [{ x: 0, y: 0, w: 4, h: 4, count: 1 }]
    ic.toggleRegionList(true)
    expect(ic.toggleRegionList()).toBe(false)
    expect(host.querySelector('.ic-region-panel').style.display).toBe('none')
  })

  it('reports "not loaded" for both sides before any image arrives', () => {
    const { ic, host } = mountIC()
    expect(ic.getSideInfo('left')).toBeNull()
    expect(ic.toggleInfoPanel()).toBe(true)
    const panel = host.querySelector('.ic-info-panel')
    expect(panel.textContent).toContain('未載入')
    // The diff block is still present, saying the comparison has not run.
    expect(panel.textContent).toContain('尚未比對')
  })

  it('reports the loaded side, and the diff percentage after a comparison', () => {
    const { ic, host } = mountIC()
    ic._left = {
      path: '/a.png', ext: 'png', bytes: 2048, depth: 'rgba',
      img: { naturalWidth: 10, naturalHeight: 20 },
    }
    ic._stats = { diffCount: 25, totalPixels: 200, approximate: false }
    ic._diffRegions = [{ x: 0, y: 0, w: 4, h: 4, count: 25 }]
    ic.toggleInfoPanel(true)

    const text = host.querySelector('.ic-info-panel').textContent
    expect(text).toContain('/a.png')
    expect(text).toContain('PNG')
    expect(text).toContain('2.0 KB')
    expect(text).toContain('10 × 20')
    expect(text).toContain('12.50%')
    expect(text).toContain('全解析度實測')
  })

  it('marks an extrapolated figure as an estimate', () => {
    const { ic, host } = mountIC()
    ic._stats = { diffCount: 100, totalPixels: 1000, approximate: true }
    ic.toggleInfoPanel(true)
    const text = host.querySelector('.ic-info-panel').textContent
    expect(text).toContain('≈')
    expect(text).toContain('估計值')
  })

  it('is reachable from the toolbar', () => {
    const { ic, host } = mountIC()
    host.querySelector('.ic-btn-info').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(ic.isInfoPanelVisible()).toBe(true)
    host.querySelector('.ic-btn-regions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(ic.isRegionListVisible()).toBe(true)
  })

  it('reports an unreadable canvas as unknown depth instead of guessing', () => {
    const { ic } = mountIC()
    ic._left = {
      path: '/a.png', ext: 'png', bytes: 1, depth: null,
      img: { naturalWidth: 2, naturalHeight: 2 },
    }
    // jsdom has no 2D context, so this exercises the failure path.
    expect(ic.getSideInfo('left').depth).toBe('unknown')
  })
})
