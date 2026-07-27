/**
 * @vitest-environment jsdom
 *
 * getConfig / applyConfig across the comparison views.
 *
 * The named-config feature previously worked only for text compare; these
 * check the other views honour the same contract — a snapshot round-trips,
 * paths are never captured, and malformed input is rejected rather than
 * corrupting state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HexCompare } from '../../src/renderer/src/views/hex-compare.js'
import { ImageCompare } from '../../src/renderer/src/views/image-compare.js'
import { TableCompare } from '../../src/renderer/src/views/table-compare.js'
import { FolderCompare } from '../../src/renderer/src/views/folder-compare.js'

beforeEach(() => {
  localStorage.clear()
  window.electronAPI = {
    readDir: vi.fn().mockResolvedValue([]),
    saveFile: vi.fn(),
  }
})

describe('HexCompare config', () => {
  it('round-trips a snapshot', () => {
    const a = new HexCompare()
    a.applyConfig({
      bytesPerRow: 32, diffAlgorithm: 'complete', showFilter: 'diff',
      layout: 'over-under', showThumbnail: true,
    })
    const b = new HexCompare()
    b.applyConfig(a.getConfig())
    expect(b.getConfig()).toEqual({
      __v: 1, __view: 'hex', bytesPerRow: 32, diffAlgorithm: 'complete', showFilter: 'diff',
      // P2-40: panel visibility travels with the config too.
      showDetails: false, showFileInfo: false, showRuler: false,
      // S24: so does the layout axis and the thumbnail.
      layout: 'over-under', showThumbnail: true,
    })
  })

  it('rejects values outside the supported set', () => {
    const hc = new HexCompare()
    const before = hc.getConfig()
    hc.applyConfig({ bytesPerRow: 7, diffAlgorithm: 'magic' })
    expect(hc.getConfig()).toEqual(before)
  })

  it('ignores junk input', () => {
    const hc = new HexCompare()
    const before = hc.getConfig()
    hc.applyConfig(null)
    hc.applyConfig('nope')
    expect(hc.getConfig()).toEqual(before)
  })

  it('does not capture paths', () => {
    const hc = new HexCompare()
    hc.setLeft('C:/tmp/a.bin', btoa('abc'))
    expect(JSON.stringify(hc.getConfig())).not.toContain('a.bin')
  })
})

describe('ImageCompare config', () => {
  it('round-trips a snapshot', () => {
    const a = new ImageCompare()
    a.applyConfig({
      threshold: 0.25, algorithm: 'grayscale', blendMode: 'normal',
      autoScale: true, mismatchRange: true,
    })
    const b = new ImageCompare()
    b.applyConfig(a.getConfig())
    expect(b.getConfig()).toEqual(a.getConfig())
  })

  it('rejects an out-of-range threshold and unknown enums', () => {
    const ic = new ImageCompare()
    const before = ic.getConfig()
    ic.applyConfig({ threshold: 5, algorithm: 'nope', blendMode: 'nope' })
    expect(ic.getConfig()).toEqual(before)
  })

  it('rejects a highlight colour that is not a known key', () => {
    const ic = new ImageCompare()
    const before = ic.getConfig().highlightColor
    ic.applyConfig({ highlightColor: 'constructor' })
    expect(ic.getConfig().highlightColor).toBe(before)
  })
})

describe('TableCompare config', () => {
  it('round-trips including column rules and composite keys', () => {
    const a = new TableCompare()
    a.applyConfig({
      hasHeader: true,
      keyColumns: [0, 2],
      ignoreColumnOrder: true,
      columnRules: { 1: { mode: 'numeric', tolerance: 0.5 } },
    })
    const cfg = a.getConfig()
    expect(cfg.keyColumns).toEqual([0, 2])
    expect(cfg.columnRules['1'].mode).toBe('numeric')

    const b = new TableCompare()
    b.applyConfig(cfg)
    expect(b.getConfig()).toEqual(cfg)
  })

  it('snapshots column rules by value, not by reference', () => {
    const tc = new TableCompare()
    tc.applyConfig({ columnRules: { 0: { mode: 'numeric', tolerance: 1 } } })
    const snap = tc.getConfig()
    tc.setColumnRule(0, { mode: 'date', tolerance: 60 })
    expect(snap.columnRules['0'].mode).toBe('numeric')
  })

  it('ignores junk input', () => {
    const tc = new TableCompare()
    const before = tc.getConfig()
    tc.applyConfig(undefined)
    expect(tc.getConfig()).toEqual(before)
  })
})

describe('FolderCompare config', () => {
  it('round-trips a snapshot', () => {
    const a = new FolderCompare()
    a._dom = { list: document.createElement('div') }
    a.applyConfig({ mode: 'size', viewPreset: 'differences', mtimeTolerance: 5, filterStr: '*.js' })
    const cfg = a.getConfig()
    expect(cfg.mode).toBe('size')
    expect(cfg.viewPreset).toBe('differences')
    expect(cfg.mtimeTolerance).toBe(5)
    expect(cfg.filterStr).toBe('*.js')
  })

  it('rejects an unknown compare mode and a negative tolerance', () => {
    const fc = new FolderCompare()
    fc._dom = { list: document.createElement('div') }
    const before = fc.getConfig()
    fc.applyConfig({ mode: 'telepathy', mtimeTolerance: -1 })
    expect(fc.getConfig().mode).toBe(before.mode)
    expect(fc.getConfig().mtimeTolerance).toBe(before.mtimeTolerance)
  })

  it('does not capture paths', () => {
    const fc = new FolderCompare({ leftPath: 'C:/secret/left', rightPath: 'C:/secret/right' })
    fc._dom = { list: document.createElement('div') }
    expect(JSON.stringify(fc.getConfig())).not.toContain('secret')
  })
})

describe('contract consistency', () => {
  it('every configurable view exposes both halves of the contract', () => {
    for (const View of [HexCompare, ImageCompare, TableCompare, FolderCompare]) {
      const v = new View()
      expect(typeof v.getConfig, View.name).toBe('function')
      expect(typeof v.applyConfig, View.name).toBe('function')
      expect(typeof v.getConfig()).toBe('object')
    }
  })
})
