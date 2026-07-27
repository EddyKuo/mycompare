/**
 * @vitest-environment jsdom
 *
 * Cross-view consistency:
 *   1. getConfig / applyConfig round-trips, the version envelope, and the
 *      refusal to apply another view's snapshot.
 *   2. Difference navigation obeying the shared Next Difference options
 *      (wrap-around, go-to-first-on-load, advance-after-copy) identically in
 *      every view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { HexCompare } from '../../src/renderer/src/views/hex-compare.js'
import { ImageCompare, tilesToRegions, diffTileSize } from '../../src/renderer/src/views/image-compare.js'
import { TableCompare } from '../../src/renderer/src/views/table-compare.js'
import { FolderCompare } from '../../src/renderer/src/views/folder-compare.js'
import { TextCompare } from '../../src/renderer/src/views/text-compare.js'
import { ThreeWayCompare } from '../../src/renderer/src/views/three-way-compare.js'

import { SettingsStore, DEFAULT_PREFS } from '../../src/renderer/src/core/settings-store.js'
import {
  stepDiffIndex, navResult, describeNavResult, getNavOptions,
} from '../../src/renderer/src/core/diff-nav.js'
import {
  tagConfig, readConfig, CONFIG_SCHEMA_VERSION,
} from '../../src/renderer/src/core/named-config-store.js'

const settings = new SettingsStore()

/** @param {number[]} arr */
const b64 = (arr) => btoa(String.fromCharCode(...arr))

beforeEach(() => {
  localStorage.clear()
  window.electronAPI = {
    readDir: vi.fn().mockResolvedValue([]),
    saveFile: vi.fn(),
    openFile: vi.fn(),
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
    onFileChanged: vi.fn(() => () => {}),
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Config envelope
// ─────────────────────────────────────────────────────────────────────────────

describe('config envelope', () => {
  it('stamps a version and the owning view', () => {
    expect(tagConfig('hex', { a: 1 })).toEqual({
      __v: CONFIG_SCHEMA_VERSION, __view: 'hex', a: 1,
    })
  })

  it('accepts a pre-versioning snapshot', () => {
    expect(readConfig('hex', { bytesPerRow: 8 })).toEqual({ bytesPerRow: 8 })
  })

  it('refuses a snapshot written by a newer format', () => {
    expect(readConfig('hex', { __v: CONFIG_SCHEMA_VERSION + 1, bytesPerRow: 8 })).toBeNull()
    expect(readConfig('hex', { __v: 'one' })).toBeNull()
  })

  it('refuses another view’s snapshot', () => {
    expect(readConfig('hex', tagConfig('table', { bytesPerRow: 8 }))).toBeNull()
  })

  it('refuses non-objects', () => {
    for (const junk of [null, undefined, 'nope', 42, [1, 2]]) {
      expect(readConfig('hex', junk)).toBeNull()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Per-view round trips
// ─────────────────────────────────────────────────────────────────────────────

/** Build a folder view that can render without a real scan. */
function makeFolder() {
  const fc = new FolderCompare()
  fc._dom = { list: document.createElement('div') }
  return fc
}

describe('per-view getConfig / applyConfig round-trips', () => {
  it('hex restores bytes-per-row and algorithm', () => {
    const a = new HexCompare()
    a.applyConfig({ bytesPerRow: 32, diffAlgorithm: 'complete' })
    const b = new HexCompare()
    b.applyConfig(a.getConfig())
    expect(b.getConfig()).toEqual(a.getConfig())
    expect(b.getConfig().bytesPerRow).toBe(32)
    expect(b.getConfig().diffAlgorithm).toBe('complete')
  })

  it('image restores every adjustable knob', () => {
    const a = new ImageCompare()
    a.applyConfig({
      threshold: 0.25, algorithm: 'grayscale', blendMode: 'blend',
      autoScale: true, mismatchRange: true, highlightColor: 'magenta',
    })
    const b = new ImageCompare()
    b.applyConfig(a.getConfig())
    expect(b.getConfig()).toEqual(a.getConfig())
    expect(b.getConfig().highlightColor).toBe('magenta')
  })

  it('table restores key columns, rules and auto-width state', () => {
    const a = new TableCompare()
    a.applyConfig({
      hasHeader: false,
      keyColumns: [0, 2],
      ignoreColumnOrder: true,
      columnRules: { 1: { mode: 'numeric', tolerance: 0.5 } },
    })
    const cfg = a.getConfig()
    expect(cfg.keyColumns).toEqual([0, 2])
    expect(cfg.fitColumns).toBe(false)

    const b = new TableCompare()
    b.applyConfig(cfg)
    expect(b.getConfig()).toEqual(cfg)
  })

  it('folder restores mode, preset, filter flags and sort', () => {
    const a = makeFolder()
    a.applyConfig({
      mode: 'size',
      viewPreset: 'differences',
      mtimeTolerance: 5,
      filterStr: '*.js',
      filters: { showSame: false, showDiff: true, showLeftOnly: false },
      sort: { key: 'size', dir: -1 },
    })
    const cfg = a.getConfig()
    expect(cfg.mode).toBe('size')
    expect(cfg.filters.showSame).toBe(false)
    expect(cfg.sort).toEqual({ key: 'size', dir: -1 })

    const b = makeFolder()
    b.applyConfig(cfg)
    expect(b.getConfig()).toEqual(cfg)
  })

  it('text restores its ignore options', () => {
    const a = new TextCompare()
    a.applyConfig({ algorithm: 'patience', ignoreCase: true, ignorePatterns: ['^#'] })
    const b = new TextCompare()
    b.applyConfig(a.getConfig())
    expect(b.getConfig()).toEqual(a.getConfig())
  })

  it('merge3 restores its filter and algorithm', () => {
    const a = new ThreeWayCompare()
    a.applyConfig({ showFilter: 'conflicts', algorithm: 'patience' })
    const b = new ThreeWayCompare()
    b.applyConfig(a.getConfig())
    expect(b.getConfig()).toEqual(a.getConfig())
  })
})

describe('applying a foreign snapshot', () => {
  it('leaves each view completely untouched rather than half-applied', () => {
    const views = {
      hex: new HexCompare(),
      image: new ImageCompare(),
      table: new TableCompare(),
      folder: makeFolder(),
      text: new TextCompare(),
      merge3: new ThreeWayCompare(),
    }
    // A folder snapshot carries `mode`, which several other views also read.
    const foreign = tagConfig('folder', {
      mode: 'size', hasHeader: false, algorithm: 'patience',
      bytesPerRow: 32, threshold: 0.9, showFilter: 'conflicts',
    })
    for (const [name, view] of Object.entries(views)) {
      if (name === 'folder') continue
      const before = JSON.stringify(view.getConfig())
      view.applyConfig(foreign)
      expect(JSON.stringify(view.getConfig()), name).toBe(before)
    }
  })

  it('survives junk without throwing', () => {
    for (const view of [new HexCompare(), new ImageCompare(), new TableCompare(),
      makeFolder(), new TextCompare(), new ThreeWayCompare()]) {
      const before = JSON.stringify(view.getConfig())
      for (const junk of [null, undefined, 'nope', 7, []]) {
        expect(() => view.applyConfig(junk)).not.toThrow()
      }
      expect(JSON.stringify(view.getConfig())).toBe(before)
    }
  })

  it('never captures paths', () => {
    const hex = new HexCompare()
    hex.setLeft('C:/secret/a.bin', b64([1, 2, 3]))
    expect(JSON.stringify(hex.getConfig())).not.toContain('secret')

    const folder = new FolderCompare({ leftPath: 'C:/secret/l', rightPath: 'C:/secret/r' })
    folder._dom = { list: document.createElement('div') }
    expect(JSON.stringify(folder.getConfig())).not.toContain('secret')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Navigation rules
// ─────────────────────────────────────────────────────────────────────────────

describe('Next Difference options', () => {
  it('default to BC’s: no wrap, jump on load, advance after copy', () => {
    expect(DEFAULT_PREFS.navWrapAround).toBe(false)
    expect(DEFAULT_PREFS.navFirstDiffOnLoad).toBe(true)
    expect(DEFAULT_PREFS.navNextAfterCopy).toBe(true)
    expect(getNavOptions()).toEqual({
      wrapAround: false, firstDiffOnLoad: true,
      nextAfterCopy: true, showNoDiffMessage: true,
    })
  })

  it('survive a corrupted settings blob', () => {
    localStorage.setItem('mycompare:settings', '{{{not json')
    expect(getNavOptions().wrapAround).toBe(false)
  })
})

describe('stepDiffIndex', () => {
  it('clamps at both ends when wrap is off', () => {
    expect(stepDiffIndex(2, 3, 1, false)).toBe(2)
    expect(stepDiffIndex(0, 3, -1, false)).toBe(0)
    expect(stepDiffIndex(1, 3, 1, false)).toBe(2)
  })

  it('wraps at both ends when wrap is on', () => {
    expect(stepDiffIndex(2, 3, 1, true)).toBe(0)
    expect(stepDiffIndex(0, 3, -1, true)).toBe(2)
  })

  it('selects an end from a fresh cursor', () => {
    expect(stepDiffIndex(-1, 3, 1, false)).toBe(0)
    expect(stepDiffIndex(-1, 3, -1, false)).toBe(0)
    expect(stepDiffIndex(-1, 3, -1, true)).toBe(2)
  })

  it('reports nothing to navigate to when there are no differences', () => {
    expect(stepDiffIndex(-1, 0, 1, false)).toBe(-1)
    expect(stepDiffIndex(-1, 0, 1, true)).toBe(-1)
  })

  it('reads the stored option when none is passed', () => {
    settings.setPref('navWrapAround', true)
    expect(stepDiffIndex(2, 3, 1)).toBe(0)
    settings.setPref('navWrapAround', false)
    expect(stepDiffIndex(2, 3, 1)).toBe(2)
  })
})

describe('describeNavResult', () => {
  it('reports the position after a step', () => {
    expect(describeNavResult('next', navResult(0, 1, 3), true)).toBe('差異 2 / 3')
  })

  it('reports the end when next did not move', () => {
    expect(describeNavResult('next', navResult(2, 2, 3), true)).toBe('已到最後一個差異（共 3 個）')
    expect(describeNavResult('last', navResult(2, 2, 3), true)).toBe('已到最後一個差異（共 3 個）')
  })

  it('reports the start when prev did not move', () => {
    expect(describeNavResult('prev', navResult(0, 0, 3), true)).toBe('已到第一個差異（共 3 個）')
    expect(describeNavResult('first', navResult(0, 0, 3), true)).toBe('已到第一個差異（共 3 個）')
  })

  it('reports an empty comparison', () => {
    expect(describeNavResult('next', navResult(-1, -1, 0), true)).toBe('沒有差異')
  })

  it('stays silent when the message panel is off', () => {
    expect(describeNavResult('next', navResult(2, 2, 3), false)).toBeNull()
    expect(describeNavResult('next', navResult(-1, -1, 0), false)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Every view obeys the same rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Views built with three differences each, without needing a real mount.
 * @returns {Array<{ name: string, view: object, next: string, prev: string, first: string, last: string }>}
 */
function navigableViews() {
  const hex = new HexCompare()
  // Three differing runs separated by matching bytes.
  hex._leftBytes = new Uint8Array([0, 1, 0, 2, 0, 3, 0])
  hex._rightBytes = new Uint8Array([0, 9, 0, 9, 0, 9, 0])
  hex._recomputeDiffRegions()

  const table = new TableCompare()
  table._visibleRows = [
    { status: 'same' }, { status: 'different' },
    { status: 'left-only' }, { status: 'right-only' },
  ]
  table._diffRows = [1, 2, 3]
  table._currentDiffIdx = -1

  const image = new ImageCompare()
  image._diffRegions = [
    { x: 0, y: 0, w: 4, h: 4, count: 1 },
    { x: 4, y: 0, w: 4, h: 4, count: 2 },
    { x: 0, y: 4, w: 4, h: 4, count: 3 },
  ]

  const folder = makeFolder()
  folder._visibleRows = [
    { row: { status: 'same' }, depth: 0 },
    { row: { status: 'different' }, depth: 0 },
    { row: { status: 'left-only' }, depth: 0 },
    { row: { status: 'right-newer' }, depth: 0 },
  ]

  const shape = { next: 'nextDifference', prev: 'prevDifference', first: 'firstDifference', last: 'lastDifference' }
  return [
    { name: 'hex', view: hex, ...shape },
    { name: 'table', view: table, ...shape },
    { name: 'image', view: image, ...shape },
    { name: 'folder', view: folder, ...shape },
  ]
}

describe('difference navigation is identical across views', () => {
  it('every view exposes the four navigation methods and returns a NavResult', () => {
    for (const { name, view, next } of navigableViews()) {
      const r = view[next]()
      expect(r, name).toEqual({ index: 0, total: 3, moved: true })
    }
  })

  it('with wrap off, next stops on the last difference and reports it', () => {
    settings.setPref('navWrapAround', false)
    for (const { name, view, next } of navigableViews()) {
      expect(view[next]().index, name).toBe(0)
      expect(view[next]().index, name).toBe(1)
      expect(view[next]().index, name).toBe(2)
      // Pressing next again at the end: stays put, flagged as not moved.
      const stuck = view[next]()
      expect(stuck, name).toEqual({ index: 2, total: 3, moved: false })
      expect(describeNavResult('next', stuck, true), name)
        .toBe('已到最後一個差異（共 3 個）')
    }
  })

  it('with wrap off, prev stops on the first difference and reports it', () => {
    settings.setPref('navWrapAround', false)
    for (const { name, view, first, prev } of navigableViews()) {
      expect(view[first]().index, name).toBe(0)
      const stuck = view[prev]()
      expect(stuck, name).toEqual({ index: 0, total: 3, moved: false })
      expect(describeNavResult('prev', stuck, true), name)
        .toBe('已到第一個差異（共 3 個）')
    }
  })

  it('with wrap on, next from the last difference returns to the first', () => {
    settings.setPref('navWrapAround', true)
    for (const { name, view, last, next, prev } of navigableViews()) {
      expect(view[last]().index, name).toBe(2)
      expect(view[next](), name).toEqual({ index: 0, total: 3, moved: true })
      expect(view[prev](), name).toEqual({ index: 2, total: 3, moved: true })
    }
  })

  it('first / last jump to the ends', () => {
    for (const { name, view, first, last } of navigableViews()) {
      expect(view[last]().index, name).toBe(2)
      expect(view[first]().index, name).toBe(0)
    }
  })

  it('reports an empty comparison rather than moving', () => {
    for (const View of [HexCompare, TableCompare, ImageCompare]) {
      const v = new View()
      for (const method of ['nextDifference', 'prevDifference', 'firstDifference', 'lastDifference']) {
        expect(v[method](), `${View.name}.${method}`).toEqual({ index: -1, total: 0, moved: false })
      }
    }
    const empty = makeFolder()
    empty._visibleRows = []
    expect(empty.nextDifference()).toEqual({ index: -1, total: 0, moved: false })
  })
})

/** Mount a TextCompare into the DOM shape its renderer expects. */
function mountText() {
  const host = document.createElement('div')
  host.innerHTML = `
    <div id="compare-area">
      <div id="pane-left"><div id="content-left"></div></div>
      <div id="splitter"><canvas id="tc-gutter-canvas"></canvas><div id="tc-gutter-overlay"></div></div>
      <div id="pane-right"><div id="content-right"></div></div>
      <div id="minimap"><div id="minimap-viewport"></div></div>
    </div>`
  document.body.replaceChildren(host)
  const tc = new TextCompare()
  tc.mount()
  return tc
}

describe('text and merge3 follow the same rules', () => {
  /** @returns {TextCompare} */
  function textWithThreeDiffs() {
    const tc = mountText()
    tc.setLeft('a.txt', 'a\nX\nc\nY\ne\nZ\ng\n')
    tc.setRight('b.txt', 'a\n1\nc\n2\ne\n3\ng\n')
    return tc
  }

  it('text clamps at the last difference when wrap is off', () => {
    settings.setPref('navWrapAround', false)
    const tc = textWithThreeDiffs()
    const total = tc.navigateLast().total
    expect(total).toBeGreaterThan(1)
    const stuck = tc.navigateNext()
    expect(stuck.moved).toBe(false)
    expect(stuck.index).toBe(total - 1)
    expect(describeNavResult('next', stuck, true)).toBe(`已到最後一個差異（共 ${total} 個）`)
  })

  it('text wraps to the first difference when wrap is on', () => {
    settings.setPref('navWrapAround', true)
    const tc = textWithThreeDiffs()
    tc.navigateLast()
    const wrapped = tc.navigateNext()
    expect(wrapped.index).toBe(0)
    expect(wrapped.moved).toBe(true)
  })

  it('merge3 clamps when wrap is off and wraps when it is on', () => {
    const BASE = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
    const LEFT = ['a', 'L1', 'c', 'd', 'e', 'L2', 'g'].join('\n')
    const RIGHT = ['a', 'R1', 'c', 'd', 'e', 'R2', 'g'].join('\n')

    settings.setPref('navWrapAround', false)
    const clamped = new ThreeWayCompare()
    clamped.setSide('base', BASE)
    clamped.setSide('left', LEFT)
    clamped.setSide('right', RIGHT)
    expect(clamped.getConflictCount()).toBe(2)
    clamped.lastConflict()
    expect(clamped.nextConflict()).toBe(1)

    settings.setPref('navWrapAround', true)
    const wrapping = new ThreeWayCompare()
    wrapping.setSide('base', BASE)
    wrapping.setSide('left', LEFT)
    wrapping.setSide('right', RIGHT)
    wrapping.lastConflict()
    expect(wrapping.nextConflict()).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Go to next difference after copying
// ─────────────────────────────────────────────────────────────────────────────

describe('go to next difference after copying', () => {
  const BASE3 = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
  const LEFT3 = ['a', 'L1', 'c', 'd', 'e', 'L2', 'g'].join('\n')
  const RIGHT3 = ['a', 'R1', 'c', 'd', 'e', 'R2', 'g'].join('\n')

  it('advances the merge cursor when the option is on', () => {
    settings.setPref('navNextAfterCopy', true)
    settings.setPref('navFirstDiffOnLoad', false)
    const v = new ThreeWayCompare()
    v.setSide('base', BASE3)
    v.setSide('left', LEFT3)
    v.setSide('right', RIGHT3)
    expect(v.getConflictCount()).toBe(2)
    expect(v.getCurrentConflictIndex()).toBe(-1)

    const firstId = [...v._conflictChoices.keys()][0]
    v.setConflictChoice(firstId, 'left')
    expect(v.getCurrentConflictIndex()).toBe(0)
  })

  it('leaves the cursor alone when the option is off', () => {
    settings.setPref('navNextAfterCopy', false)
    settings.setPref('navFirstDiffOnLoad', false)
    const v = new ThreeWayCompare()
    v.setSide('base', BASE3)
    v.setSide('left', LEFT3)
    v.setSide('right', RIGHT3)
    const id = [...v._conflictChoices.keys()][0]
    v.setConflictChoice(id, 'left')
    expect(v.getCurrentConflictIndex()).toBe(-1)
  })

  it('text resolves one difference per copy', () => {
    settings.setPref('navNextAfterCopy', true)
    settings.setPref('navWrapAround', false)
    const tc = mountText()
    tc.setLeft('a.txt', ['a', 'X', 'c', 'Y', 'e', 'Z', 'g'].join('\n'))
    tc.setRight('b.txt', ['a', '1', 'c', '2', 'e', '3', 'g'].join('\n'))
    const before = tc.navigateFirst().total
    expect(before).toBeGreaterThan(1)
    tc.copyToRight()
    expect(tc.navigateLast().total).toBe(before - 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Go to first difference on load
// ─────────────────────────────────────────────────────────────────────────────

describe('go to first difference on load', () => {
  it('hex selects the first difference when the option is on', () => {
    settings.setPref('navFirstDiffOnLoad', true)
    const hex = new HexCompare()
    hex.setLeft('a.bin', b64([0, 1, 0, 2]))
    hex.setRight('b.bin', b64([0, 9, 0, 9]))
    expect(hex.getCurrentDiffIndex()).toBe(0)
  })

  it('hex leaves the cursor unset when the option is off', () => {
    settings.setPref('navFirstDiffOnLoad', false)
    const hex = new HexCompare()
    hex.setLeft('a.bin', b64([0, 1, 0, 2]))
    hex.setRight('b.bin', b64([0, 9, 0, 9]))
    expect(hex.getCurrentDiffIndex()).toBe(-1)
  })

  it('merge3 selects the first conflict when the option is on', () => {
    settings.setPref('navFirstDiffOnLoad', true)
    const v = new ThreeWayCompare()
    v.setSide('base', 'a\nb\nc')
    v.setSide('left', 'a\nL\nc')
    v.setSide('right', 'a\nR\nc')
    expect(v.getCurrentConflictIndex()).toBe(0)
  })

  it('a mere option change does not move the cursor', () => {
    settings.setPref('navFirstDiffOnLoad', true)
    settings.setPref('navWrapAround', false)
    const hex = new HexCompare()
    hex.setLeft('a.bin', b64([0, 1, 0, 2, 0, 3]))
    hex.setRight('b.bin', b64([0, 9, 0, 9, 0, 9]))
    hex.lastDifference()
    const at = hex.getCurrentDiffIndex()
    expect(at).toBeGreaterThan(0)
    hex.refresh()
    expect(hex.getCurrentDiffIndex()).toBe(at)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Image diff regions
// ─────────────────────────────────────────────────────────────────────────────

describe('image diff regions', () => {
  it('keeps the tile grid bounded regardless of resolution', () => {
    expect(diffTileSize(32, 32)).toBe(1)
    expect(Math.ceil(8000 / diffTileSize(8000, 6000))).toBeLessThanOrEqual(32)
  })

  it('turns a tally into regions in reading order, skipping empty tiles', () => {
    const counts = new Uint32Array([0, 3, 0, 5])
    expect(tilesToRegions(counts, 2, 4, 7, 8)).toEqual([
      { x: 4, y: 0, w: 3, h: 4, count: 3 },
      { x: 4, y: 4, w: 3, h: 4, count: 5 },
    ])
  })

  it('returns nothing for an empty tally', () => {
    expect(tilesToRegions(new Uint32Array(4), 2, 4, 8, 8)).toEqual([])
    expect(tilesToRegions(null, 2, 4, 8, 8)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Save cancellation
// ─────────────────────────────────────────────────────────────────────────────

describe('cancelling a save', () => {
  it('leaves the side marked modified', async () => {
    const tc = mountText()
    tc.setLeft('a.txt', 'hello\n')
    tc._modified.left = true
    window.electronAPI.saveFile = vi.fn().mockResolvedValue(false)

    await tc.saveLeft()
    expect(tc._modified.left).toBe(true)
  })

  it('clears the flag once the file is actually written', async () => {
    const tc = mountText()
    tc.setLeft('a.txt', 'hello\n')
    tc._modified.left = true
    window.electronAPI.saveFile = vi.fn().mockResolvedValue({ saved: true, path: 'a.txt' })

    await tc.saveLeft()
    expect(tc._modified.left).toBe(false)
  })

  it('does the same for the right side', async () => {
    const tc = mountText()
    tc.setRight('b.txt', 'hello\n')
    tc._modified.right = true
    window.electronAPI.saveFile = vi.fn().mockResolvedValue(false)

    await tc.saveRight()
    expect(tc._modified.right).toBe(true)

    window.electronAPI.saveFile = vi.fn().mockResolvedValue({ saved: true, path: 'b.txt' })
    await tc.saveRight()
    expect(tc._modified.right).toBe(false)
  })

  it('reports where the backup went', async () => {
    const tc = mountText()
    tc.setLeft('a.txt', 'hello\n')
    const seen = []
    tc.on('status', ({ message }) => seen.push(message))
    window.electronAPI.saveFile = vi.fn().mockResolvedValue({
      saved: true, path: 'a.txt', backup: { backedUp: true, path: 'a.txt.bak' },
    })

    await tc.saveLeft()
    expect(seen).toContain('已備份至 a.txt.bak')
  })

  it('reports a failed backup without claiming the save failed', async () => {
    const tc = mountText()
    tc.setLeft('a.txt', 'hello\n')
    const seen = []
    tc.on('status', ({ message }) => seen.push(message))
    window.electronAPI.saveFile = vi.fn().mockResolvedValue({
      saved: true, path: 'a.txt', backup: { backedUp: false, reason: 'EACCES' },
    })

    await tc.saveLeft()
    expect(tc._modified.left).toBe(false)
    expect(seen).toContain('備份失敗：EACCES')
  })
})
