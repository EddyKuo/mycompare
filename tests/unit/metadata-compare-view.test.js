/**
 * @vitest-environment jsdom
 *
 * The metadata comparison view itself: what it reads, what it paints, and what
 * difference navigation does.
 *
 * The state assertions matter more than they look: every row's classification
 * is read back out of the model rather than out of the DOM, because "只顯示差異"
 * removes rows from the grid and a view that kept its cursor in the DOM would
 * navigate to whatever happened to be rendered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MetadataCompare } from '../../src/renderer/src/views/metadata-compare.js'

/** Captures what the view passes to showContextMenu. */
const menuCalls = []
vi.mock('../../src/renderer/src/core/context-menu.js', () => ({
  showContextMenu: (_e, items) => { menuCalls.push(items) },
  closeContextMenu: () => {},
}))

/** @type {Record<string, object>} path -> metadata result the fake IPC returns */
let disk = {}

/** @type {MetadataCompare|null} */
let view = null
/** @type {HTMLElement} */
let host

const AUDIO = {
  bitrate: 192, sampleRate: 44100, channelMode: 'stereo',
  durationSec: 120, mpegVersion: '1', layer: 3, vbr: false,
}

beforeEach(() => {
  menuCalls.length = 0
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.appendChild(host)
  disk = {
    'a.mp3': { kind: 'mp3', fields: { title: 'Song', artist: 'Alice', year: '2001' }, audio: AUDIO },
    'b.mp3': { kind: 'mp3', fields: { title: 'Song', artist: 'Bob', album: 'Live' }, audio: AUDIO },
    'a.exe': { kind: 'pe', fields: { FileVersion: '1.0.0.0', CompanyName: 'Acme' } },
    'b.exe': { kind: 'pe', fields: { FileVersion: '2.0.0.0', CompanyName: 'Acme' } },
    'plain.txt': { kind: 'unknown', fields: {} },
    'bare.mp3': { kind: 'mp3', fields: {} },
  }
  window.electronAPI = {
    readMetadata: vi.fn(async (path) => {
      if (!(path in disk)) throw new Error(`no such file: ${path}`)
      return disk[path]
    }),
    openFileBinary: vi.fn(async () => ({ path: 'a.mp3', base64: '', size: 1, truncated: true, ext: 'mp3' })),
    saveFile: vi.fn(async () => undefined),
  }
  // Navigation options are read from storage per call; start from a known state.
  window.localStorage?.clear?.()
})

afterEach(() => {
  view?.destroy()
  view = null
})

/** A mounted view with both sides loaded. */
async function mounted(left = 'a.mp3', right = 'b.mp3') {
  const v = new MetadataCompare()
  v.mount(host)
  if (left) await v.setLeft(left)
  if (right) await v.setRight(right)
  view = v
  return v
}

/** @param {MetadataCompare} v */
const stateOf = (v) => Object.fromEntries(v.getRows().map((r) => [r.field, r.state]))

describe('mounting and loading', () => {
  it('renders the grid shell before anything is loaded', () => {
    view = new MetadataCompare()
    view.mount(host)
    expect(host.querySelector('.metadata-compare')).toBeTruthy()
    expect(host.querySelectorAll('.mc-path-cell')).toHaveLength(2)
    expect(host.querySelector('.mc-notes').textContent).toContain('尚未載入')
  })

  it('reads each side through the metadata IPC exactly once per load', async () => {
    const v = await mounted()
    expect(window.electronAPI.readMetadata).toHaveBeenCalledTimes(2)
    expect(window.electronAPI.readMetadata).toHaveBeenCalledWith('a.mp3')
    expect(v.getKind()).toBe('mp3')
  })

  it('paints one row per compared field, with its state on the node', async () => {
    const v = await mounted()
    const nodes = [...host.querySelectorAll('.mc-row:not(.mc-row--header)')]
    expect(nodes).toHaveLength(v.getRows().length)
    const byField = Object.fromEntries(nodes.map((n) => [n.dataset.field, n.dataset.state]))
    expect(byField.title).toBe('same')
    expect(byField.artist).toBe('different')
    expect(byField.year).toBe('left-only')
    expect(byField.album).toBe('right-only')
  })

  it('gives each state its own row class, so the colours can differ', async () => {
    await mounted()
    expect(host.querySelector('.mc-row--different')).toBeTruthy()
    expect(host.querySelector('.mc-row--left-only')).toBeTruthy()
    expect(host.querySelector('.mc-row--right-only')).toBeTruthy()
    expect(host.querySelector('.mc-row--same')).toBeTruthy()
  })

  it('shows a version-resource comparison for PE files', async () => {
    const v = await mounted('a.exe', 'b.exe')
    expect(v.getKind()).toBe('pe')
    expect(stateOf(v)).toEqual({ FileVersion: 'different', CompanyName: 'same' })
  })

  it('summarises the counts in the status line', async () => {
    await mounted()
    const text = host.querySelector('.mc-stats-text').textContent
    expect(text).toMatch(/欄位 \d+/)
    expect(text).toContain('不同 1')
  })

  it('reports a read failure instead of dropping the side silently', async () => {
    const v = new MetadataCompare()
    v.mount(host)
    view = v
    const statuses = []
    v.on('status', (s) => statuses.push(s))
    await v.setLeft('missing.mp3')
    expect(statuses).toHaveLength(1)
    expect(statuses[0].level).toBe('error')
    expect(statuses[0].message).toContain('missing.mp3')
    // The path is still shown: a side that failed must not look unselected.
    expect(host.querySelector('.mc-path-left').textContent).toBe('missing.mp3')
  })

  it('emits the loaded paths so the host can title and record the tab', async () => {
    const v = new MetadataCompare()
    v.mount(host)
    view = v
    const seen = []
    v.on('paths-changed', (p) => seen.push(p))
    await v.setLeft('a.mp3')
    await v.setRight('b.mp3')
    expect(seen).toEqual([
      { left: 'a.mp3', right: '' },
      { left: 'a.mp3', right: 'b.mp3' },
    ])
  })
})

describe('files with nothing to compare', () => {
  it('says a file carries no metadata rather than showing an empty grid', async () => {
    const v = await mounted('plain.txt', 'b.mp3')
    const notes = host.querySelector('.mc-notes').textContent
    expect(notes).toContain('plain.txt')
    expect(notes).toContain('不是可讀取中繼資料')
    // The side that did parse is still laid out.
    expect(v.getRows().length).toBeGreaterThan(0)
  })

  it('refuses to let two untagged files read as identical', async () => {
    const v = await mounted('bare.mp3', 'bare.mp3')
    expect(v.getRows()).toHaveLength(0)
    const notes = host.querySelector('.mc-notes').textContent
    expect(notes).toContain('沒有任何 ID3 標籤')
    expect(notes).toContain('不代表兩個檔案相同')
    expect(host.querySelector('.mc-empty')).toBeTruthy()
  })
})

describe('difference navigation', () => {
  it('lands on the first difference when the shared option says to', async () => {
    // navFirstDiffOnLoad defaults to true, and this view must honour it like
    // the others rather than starting with no selection.
    const v = await mounted()
    expect(v.getCurrentDiffIndex()).toBe(0)
  })

  it('walks the differing fields and stops at the ends by default', async () => {
    const { SettingsStore } = await import('../../src/renderer/src/core/settings-store.js')
    new SettingsStore().setPref('navFirstDiffOnLoad', false)
    const v = await mounted()
    const total = v.getDiffCount()
    expect(total).toBe(3)
    expect(v.getCurrentDiffIndex()).toBe(-1)

    expect(v.nextDifference()).toEqual({ index: 0, total, moved: true })
    expect(v.nextDifference()).toEqual({ index: 1, total, moved: true })
    expect(v.nextDifference()).toEqual({ index: 2, total, moved: true })
    // Default options do not wrap: the last press must report "did not move".
    expect(v.nextDifference()).toEqual({ index: 2, total, moved: false })
    expect(v.prevDifference()).toEqual({ index: 1, total, moved: true })
    expect(v.firstDifference()).toEqual({ index: 0, total, moved: true })
    expect(v.lastDifference()).toEqual({ index: 2, total, moved: true })
  })

  it('wraps when the shared Next Difference option says to', async () => {
    // Proves the view goes through core/diff-nav.js rather than its own rule.
    const { SettingsStore } = await import('../../src/renderer/src/core/settings-store.js')
    new SettingsStore().setPref('navWrapAround', true)
    const v = await mounted()
    v.lastDifference()
    expect(v.nextDifference()).toEqual({ index: 0, total: 3, moved: true })
    new SettingsStore().setPref('navWrapAround', false)
  })

  it('reports nothing to navigate when the two files agree', async () => {
    disk['same.mp3'] = { kind: 'mp3', fields: { title: 'T' } }
    const v = await mounted('same.mp3', 'same.mp3')
    expect(v.getDiffCount()).toBe(0)
    expect(v.nextDifference()).toEqual({ index: -1, total: 0, moved: false })
  })

  it('marks the row the cursor is on', async () => {
    const v = await mounted()
    v.firstDifference()
    const current = host.querySelectorAll('.mc-row--current')
    expect(current).toHaveLength(1)
    expect(current[0].dataset.field).toBe('artist')
  })

  it('addresses the model, not the rendered list, when rows are filtered out', async () => {
    const v = await mounted()
    v.setShowOnlyDiffs(true)
    expect(host.querySelector('.mc-row--same')).toBeNull()
    v.lastDifference()
    const current = host.querySelector('.mc-row--current')
    const lastDiff = [...v.getRows()].reverse().find((r) => r.state !== 'same')
    expect(current.dataset.field).toBe(lastDiff.field)
  })

  it('resets the cursor when new files are loaded', async () => {
    const { SettingsStore } = await import('../../src/renderer/src/core/settings-store.js')
    new SettingsStore().setPref('navFirstDiffOnLoad', false)
    const v = await mounted()
    v.lastDifference()
    expect(v.getCurrentDiffIndex()).toBe(2)
    await v.setLeft('a.exe')
    expect(v.getCurrentDiffIndex()).toBe(-1)
  })
})

describe('toolbar behaviour', () => {
  it('hides the identical rows when 只顯示差異 is checked', async () => {
    const v = await mounted()
    const check = host.querySelector('.mc-only-diffs-check')
    const before = host.querySelectorAll('.mc-row:not(.mc-row--header)').length
    check.checked = true
    check.dispatchEvent(new Event('change', { bubbles: true }))
    expect(v.getShowOnlyDiffs()).toBe(true)
    const after = host.querySelectorAll('.mc-row:not(.mc-row--header)').length
    expect(after).toBeLessThan(before)
    expect(after).toBe(v.getDiffCount())
    // The model is untouched: the filter is a display choice.
    expect(v.getRows().length).toBe(before)
  })

  it('says so when every field matches and the filter hides them all', async () => {
    disk['same.mp3'] = { kind: 'mp3', fields: { title: 'T' } }
    const v = await mounted('same.mp3', 'same.mp3')
    v.setShowOnlyDiffs(true)
    expect(host.querySelector('.mc-empty').textContent).toContain('所有欄位都相同')
  })

  it('swaps the two sides without re-reading them', async () => {
    const v = await mounted()
    const reads = window.electronAPI.readMetadata.mock.calls.length
    await v.swap()
    expect(window.electronAPI.readMetadata.mock.calls.length).toBe(reads)
    expect(host.querySelector('.mc-path-left').textContent).toBe('b.mp3')
    expect(stateOf(v).year).toBe('right-only')
  })

  it('re-reads both sides on refresh, picking up an edited tag', async () => {
    const v = await mounted()
    expect(stateOf(v).title).toBe('same')
    disk['b.mp3'] = { ...disk['b.mp3'], fields: { ...disk['b.mp3'].fields, title: 'Changed' } }
    await v.refresh()
    expect(stateOf(v).title).toBe('different')
  })

  it('opens a side through the file dialog and loads what it returns', async () => {
    const v = new MetadataCompare()
    v.mount(host)
    view = v
    await v.openLeft()
    expect(window.electronAPI.openFileBinary).toHaveBeenCalled()
    expect(host.querySelector('.mc-path-left').textContent).toBe('a.mp3')
  })
})

describe('cell rendering', () => {
  it('distinguishes an absent field from one that is present but empty', async () => {
    disk['empty.mp3'] = { kind: 'mp3', fields: { title: '' } }
    const v = await mounted('empty.mp3', 'bare.mp3')
    const row = host.querySelector('.mc-row[data-field="title"]')
    const cells = row.querySelectorAll('.mc-cell-value')
    expect(cells[0].textContent).toBe('（空白）')
    expect(cells[1].textContent).toBe('（無此欄位）')
    expect(v.getRows()[0].state).toBe('left-only')
  })

  it('shows the MPEG properties alongside the tags', async () => {
    disk['slow.mp3'] = { kind: 'mp3', fields: { title: 'T' }, audio: { ...AUDIO, bitrate: 320 } }
    const v = await mounted('a.mp3', 'slow.mp3')
    expect(stateOf(v)['audio:bitrate']).toBe('different')
    expect(host.querySelector('.mc-row[data-field="audio:bitrate"]')).toBeTruthy()
  })

  it('offers a copy menu for the row under the pointer', async () => {
    const v = await mounted()
    const row = host.querySelector('.mc-row[data-field="artist"]')
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    expect(menuCalls).toHaveLength(1)
    expect(menuCalls[0].map((i) => i.label).filter(Boolean))
      .toEqual(['複製左側值', '複製右側值', '複製整列'])
    expect(v.getRows().find((r) => r.field === 'artist').left).toBe('Alice')
  })
})

describe('config round-trip', () => {
  it('saves and restores the display setting', async () => {
    const v = await mounted()
    v.setShowOnlyDiffs(true)
    const cfg = v.getConfig()

    const other = new MetadataCompare()
    other.mount(document.createElement('div'))
    expect(other.getShowOnlyDiffs()).toBe(false)
    other.applyConfig(cfg)
    expect(other.getShowOnlyDiffs()).toBe(true)
    other.destroy()
  })

  it('ignores a config saved by another kind of view', async () => {
    const v = await mounted()
    v.applyConfig({ __v: 1, __view: 'image', showOnlyDiffs: true })
    expect(v.getShowOnlyDiffs()).toBe(false)
  })
})

describe('reports', () => {
  it('builds text and HTML from the loaded comparison', async () => {
    const v = await mounted()
    expect(v.buildTextReport()).toContain('a.mp3')
    expect(v.buildHtmlReport()).toContain('<tr class="different">')
  })

  it('writes the text report through the save dialog', async () => {
    const v = await mounted()
    await v.exportTextReport()
    expect(window.electronAPI.saveFile).toHaveBeenCalledWith(
      'metadata-report.txt', expect.stringContaining('中繼資料比對報表'), expect.anything())
  })
})

describe('destroy', () => {
  it('empties the container and drops the loaded metadata', async () => {
    const v = await mounted()
    v.destroy()
    view = null
    expect(host.innerHTML).toBe('')
    expect(v.getRows()).toEqual([])
  })
})
