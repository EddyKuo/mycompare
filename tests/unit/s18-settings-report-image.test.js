/**
 * @vitest-environment jsdom
 *
 * Settings preferences, shortcut conflict detection, the image report and
 * image drag-and-drop.
 *
 * Every one of these was a case of "the reader exists, the writer does not":
 * the nav preferences and backup options were read on every navigation and
 * every save but no control ever wrote them, and image was the only core view
 * with no report at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  SettingsStore,
  DEFAULT_PREFS,
  BACKUP_NAMING_OPTIONS,
  findShortcutConflicts,
} from '../../src/renderer/src/core/settings-store.js'

import {
  ImageCompare,
  buildImageTextReport,
  buildImageHtmlReport,
  imageReportParameters,
} from '../../src/renderer/src/views/image-compare.js'

// ── Preferences ──────────────────────────────────────────────────────────────

describe('preferences the settings dialog writes', () => {
  /** @type {SettingsStore} */
  let store

  beforeEach(() => {
    localStorage.clear()
    store = new SettingsStore()
  })

  it('ships defaults for every Next Difference option', () => {
    expect(DEFAULT_PREFS.navWrapAround).toBe(false)
    expect(DEFAULT_PREFS.navFirstDiffOnLoad).toBe(true)
    expect(DEFAULT_PREFS.navNextAfterCopy).toBe(true)
    expect(DEFAULT_PREFS.navShowNoDiffMessage).toBe(true)
  })

  it('round-trips a nav preference through localStorage', () => {
    store.setPref('navWrapAround', true)
    expect(new SettingsStore().getPref('navWrapAround')).toBe(true)
  })

  it('offers exactly the naming schemes the main process implements', () => {
    expect(BACKUP_NAMING_OPTIONS.map((o) => o.value))
      .toEqual(['suffix', 'replace', 'tilde', 'numbered'])
  })

  it('reports backup options in the shape the IPC takes', () => {
    expect(store.getBackupOptions()).toEqual({
      enabled: true, naming: 'suffix', folder: '',
    })

    store.setPref('backupOnSave', false)
    store.setPref('backupNaming', 'numbered')
    store.setPref('backupFolder', 'D:\\backups')
    expect(store.getBackupOptions()).toEqual({
      enabled: false, naming: 'numbered', folder: 'D:\\backups',
    })
  })

  it('falls back to the default scheme when a stored naming is unknown', () => {
    // A hand-edited store must not reach the main process unvalidated.
    localStorage.setItem('mycompare:settings',
      JSON.stringify({ shortcuts: {}, prefs: { backupNaming: 'nonsense' } }))
    expect(store.getBackupOptions().naming).toBe('suffix')
  })

  it('ignores preference names it does not know', () => {
    store.setPref(/** @type {any} */ ('notAPref'), true)
    expect(store.load().prefs.notAPref).toBeUndefined()
  })
})

// ── Shortcut conflicts ───────────────────────────────────────────────────────

describe('shortcut conflict detection', () => {
  it('names every other action bound to the same key', () => {
    const shortcuts = { a: 'Ctrl+K', b: 'Ctrl+K', c: 'Ctrl+K', d: 'F8' }
    expect(findShortcutConflicts(shortcuts, 'a', 'Ctrl+K')).toEqual(['b', 'c'])
  })

  it('does not report an action against itself', () => {
    expect(findShortcutConflicts({ a: 'F8' }, 'a', 'F8')).toEqual([])
  })

  it('treats an unbound action as no conflict', () => {
    // Several actions are deliberately unbound; they must not all clash.
    const shortcuts = { a: '', b: '', c: 'F8' }
    expect(findShortcutConflicts(shortcuts, 'a', '')).toEqual([])
  })

  it('is case- and modifier-sensitive, matching the key matcher', () => {
    expect(findShortcutConflicts({ a: 'Ctrl+Shift+S', b: 'Ctrl+S' }, 'b', 'Ctrl+S'))
      .toEqual([])
  })
})

// ── Image report ─────────────────────────────────────────────────────────────

/** @returns {import('../../src/renderer/src/views/image-compare.js').ImageReportInfo} */
function sampleInfo(overrides = {}) {
  return {
    leftPath: 'C:\\a.png',
    rightPath: 'C:\\b.png',
    leftSize: { w: 100, h: 50 },
    rightSize: { w: 100, h: 50 },
    diffCount: 250,
    totalPixels: 5000,
    approximate: false,
    regionCount: 3,
    threshold: 0.1,
    algorithm: 'exact',
    autoScale: false,
    mismatchRange: true,
    blendMode: 'difference',
    highlightColor: 'red',
    ...overrides,
  }
}

describe('image report', () => {
  it('lists the parameters that produced the numbers', () => {
    const rows = imageReportParameters(sampleInfo())
    const map = Object.fromEntries(rows)
    expect(map['左圖尺寸']).toBe('100×50')
    expect(map['差異閾值']).toBe('0.10')
    expect(map['比對演算法']).toBe('精確比對')
    expect(map['差異分級']).toBe('開')
    expect(map['差異區塊數']).toBe('3')
  })

  it('marks a missing side rather than printing 0×0', () => {
    const map = Object.fromEntries(imageReportParameters(sampleInfo({ rightSize: null })))
    expect(map['右圖尺寸']).toBe('（未載入）')
  })

  it('builds a plain-text report with both paths and the diff summary', () => {
    const text = buildImageTextReport(sampleInfo(), { generatedAt: new Date('2026-01-02T03:04:05Z') })
    expect(text).toContain('圖片比對報告')
    expect(text).toContain('C:\\a.png')
    expect(text).toContain('C:\\b.png')
    expect(text).toContain('2026-01-02 03:04:05')
    expect(text).toContain('差異像素 250')
    expect(text).toContain('精確比對')
  })

  it('says so instead of reporting 0% when only one image is loaded', () => {
    const text = buildImageTextReport(sampleInfo({ diffCount: null, totalPixels: null }))
    expect(text).toContain('尚未載入兩張圖片')
    expect(text).not.toContain('0.00%')
  })

  it('flags extrapolated numbers in the report as it does in the status bar', () => {
    const text = buildImageTextReport(sampleInfo({ approximate: true }))
    expect(text).toContain('估計值')
  })

  it('embeds the images as data URLs', () => {
    const html = buildImageHtmlReport(sampleInfo(), {
      left: 'data:image/png;base64,AAA',
      right: 'data:image/png;base64,BBB',
      diff: 'data:image/png;base64,CCC',
    })
    expect(html).toContain('src="data:image/png;base64,AAA"')
    expect(html).toContain('src="data:image/png;base64,CCC"')
    expect(html).not.toContain('無法擷取影像')
  })

  it('says an image is unavailable rather than emitting a broken <img>', () => {
    const html = buildImageHtmlReport(sampleInfo(), { left: '', right: '', diff: '' })
    expect(html).toContain('無法擷取影像')
    expect(html).not.toContain('<img alt="左側" src="">')
  })

  it('escapes paths so a filename cannot inject markup', () => {
    const html = buildImageHtmlReport(sampleInfo({ leftPath: '<script>x</script>.png' }))
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('ImageCompare report methods', () => {
  it('reports "not loaded" before any image arrives', () => {
    const ic = new ImageCompare({})
    const info = ic.getReportInfo()
    expect(info.diffCount).toBeNull()
    expect(info.leftSize).toBeNull()
    expect(ic.buildTextReport()).toContain('尚未載入兩張圖片')
  })

  it('carries the live comparison settings into the report', () => {
    const ic = new ImageCompare({ threshold: 0.25 })
    ic.setMismatchRange(true)
    ic.setHighlightColor('blue')
    const info = ic.getReportInfo()
    expect(info.threshold).toBe(0.25)
    expect(info.mismatchRange).toBe(true)
    expect(info.highlightColor).toBe('blue')
  })

  it('reports the same numbers the status bar last showed', () => {
    const ic = new ImageCompare({})
    ic._updateStats(42, 1000, true)
    expect(ic.getReportInfo()).toMatchObject({
      diffCount: 42, totalPixels: 1000, approximate: true,
    })
    expect(ic.buildTextReport()).toContain('估計值')
  })
})

// ── Image drag & drop ────────────────────────────────────────────────────────

/**
 * A drop event carrying the given File stand-ins.
 * @param {object[]} files
 */
function dropEvent(files) {
  return {
    preventDefault: () => {},
    stopPropagation: () => {},
    dataTransfer: { files },
  }
}

describe('image drag and drop', () => {
  /** @type {ImageCompare} */
  let ic
  /** @type {any} */
  let api

  beforeEach(() => {
    ic = new ImageCompare({})
    ic.setLeft = vi.fn(async () => {})
    ic.setRight = vi.fn(async () => {})
    api = {
      acceptDroppedFiles: vi.fn(async () => [{ path: 'C:\\one.png', isDirectory: false }]),
      readFileBinary: vi.fn(async (path) => ({
        path, base64: 'AAA', ext: 'png', truncated: false,
      })),
    }
    globalThis.window.electronAPI = api
  })

  afterEach(() => {
    delete globalThis.window.electronAPI
  })

  it('hands the File objects to the main process, never a path string', async () => {
    const file = { name: 'one.png' }
    await ic._acceptDrop(dropEvent([file]), 'left')
    expect(api.acceptDroppedFiles).toHaveBeenCalledTimes(1)
    const [passed] = api.acceptDroppedFiles.mock.calls[0]
    expect(passed[0]).toBe(file)
  })

  it('loads into the pane the drop landed on', async () => {
    await ic._acceptDrop(dropEvent([{}]), 'right')
    expect(ic.setRight).toHaveBeenCalledWith('C:\\one.png', 'AAA', 'png')
    expect(ic.setLeft).not.toHaveBeenCalled()
  })

  it('fills both sides when two files are dropped at once', async () => {
    api.acceptDroppedFiles.mockResolvedValue([
      { path: 'C:\\one.png', isDirectory: false },
      { path: 'C:\\two.png', isDirectory: false },
    ])
    await ic._acceptDrop(dropEvent([{}, {}]), 'left')
    expect(ic.setLeft).toHaveBeenCalledWith('C:\\one.png', 'AAA', 'png')
    expect(ic.setRight).toHaveBeenCalledWith('C:\\two.png', 'AAA', 'png')
  })

  it('tells the user when a folder was dropped instead of an image', async () => {
    api.acceptDroppedFiles.mockResolvedValue([{ path: 'C:\\dir', isDirectory: true }])
    const status = vi.fn()
    ic.on('status', status)
    await ic._acceptDrop(dropEvent([{}]), 'left')
    expect(ic.setLeft).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error' }))
  })

  it('surfaces a rejected authorisation rather than doing nothing', async () => {
    api.acceptDroppedFiles.mockRejectedValue(new Error('not allowed'))
    const status = vi.fn()
    ic.on('status', status)
    await ic._acceptDrop(dropEvent([{}]), 'left')
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: expect.stringContaining('not allowed') }))
  })

  it('surfaces an oversized image instead of loading nothing silently', async () => {
    api.readFileBinary.mockResolvedValue({ path: 'C:\\big.png', truncated: true })
    const status = vi.fn()
    ic.on('status', status)
    await ic._acceptDrop(dropEvent([{}]), 'left')
    expect(ic.setLeft).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error' }))
  })

  it('ignores a drop that carries no files', async () => {
    await ic._acceptDrop(dropEvent([]), 'left')
    expect(api.acceptDroppedFiles).not.toHaveBeenCalled()
  })

  it('says so when no path could be resolved for the drop', async () => {
    api.acceptDroppedFiles.mockResolvedValue([])
    const status = vi.fn()
    ic.on('status', status)
    await ic._acceptDrop(dropEvent([{}]), 'left')
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: expect.stringContaining('路徑') }))
  })
})
