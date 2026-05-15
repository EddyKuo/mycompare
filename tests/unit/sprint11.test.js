/**
 * @vitest-environment jsdom
 *
 * Sprint 11 tests:
 *   T61 — NamedConfigStore + TextCompare.getConfig/applyConfig
 *   T62 — HTML report statistics (text & folder)
 *   T63 — WorkspaceStore + TabManager.getSerialisableTabs
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── window.electronAPI mock (some imported modules touch it eagerly) ─────────
if (!globalThis.window) {
  Object.defineProperty(globalThis, 'window', { value: globalThis, writable: true })
}
globalThis.window.electronAPI ??= {
  openFile:    vi.fn(),
  saveFile:    vi.fn(),
  readFile:    vi.fn(),
  watchFile:   vi.fn(),
  unwatchFile: vi.fn(),
  onFileChanged: vi.fn(),
}

import { NamedConfigStore } from '../../src/renderer/src/core/named-config-store.js'
import { WorkspaceStore, serialiseTabs } from '../../src/renderer/src/core/workspace-store.js'
import { TextCompare } from '../../src/renderer/src/views/text-compare.js'
import { FolderCompare } from '../../src/renderer/src/views/folder-compare.js'

beforeEach(() => {
  localStorage.clear()
})

// ── T61 NamedConfigStore CRUD ────────────────────────────────────────────────

describe('T61 NamedConfigStore', () => {
  it('save + get returns the same settings', () => {
    const store = new NamedConfigStore()
    const settings = { algorithm: 'patience', ignoreCase: true }
    store.save('myConfig', 'text', settings)
    const got = store.get('myConfig')
    expect(got).not.toBeNull()
    expect(got.viewType).toBe('text')
    expect(got.settings).toEqual(settings)
    expect(typeof got.createdAt).toBe('string')
  })

  it('get returns null for non-existent name', () => {
    const store = new NamedConfigStore()
    expect(store.get('nope')).toBeNull()
  })

  it('list returns all entries when no viewType filter', () => {
    const store = new NamedConfigStore()
    store.save('a', 'text',   { x: 1 })
    store.save('b', 'folder', { y: 2 })
    const all = store.list()
    expect(all).toHaveLength(2)
    expect(all.map(e => e.name).sort()).toEqual(['a', 'b'])
  })

  it('list filters by viewType', () => {
    const store = new NamedConfigStore()
    store.save('a', 'text',   { x: 1 })
    store.save('b', 'folder', { y: 2 })
    store.save('c', 'text',   { z: 3 })
    const textOnly = store.list('text')
    expect(textOnly.map(e => e.name).sort()).toEqual(['a', 'c'])
  })

  it('list is sorted by createdAt descending', async () => {
    const store = new NamedConfigStore()
    store.save('old', 'text', { v: 1 })
    // Force a different timestamp on the second save
    await new Promise(r => setTimeout(r, 5))
    store.save('new', 'text', { v: 2 })
    const list = store.list()
    expect(list[0].name).toBe('new')
    expect(list[1].name).toBe('old')
  })

  it('overwriting same name updates settings and createdAt', async () => {
    const store = new NamedConfigStore()
    store.save('cfg', 'text', { a: 1 })
    const first = store.get('cfg')
    await new Promise(r => setTimeout(r, 5))
    store.save('cfg', 'text', { a: 2 })
    const second = store.get('cfg')
    expect(second.settings).toEqual({ a: 2 })
    expect(new Date(second.createdAt).getTime())
      .toBeGreaterThan(new Date(first.createdAt).getTime())
    expect(store.list()).toHaveLength(1)
  })

  it('remove deletes the entry', () => {
    const store = new NamedConfigStore()
    store.save('a', 'text', { x: 1 })
    store.remove('a')
    expect(store.get('a')).toBeNull()
    expect(store.list()).toHaveLength(0)
  })

  it('rejects invalid name (empty / non-string)', () => {
    const store = new NamedConfigStore()
    expect(store.save('',   'text', { x: 1 })).toBeNull()
    expect(store.save('   ','text', { x: 1 })).toBeNull()
    expect(store.list()).toHaveLength(0)
  })
})

// ── T61 TextCompare.getConfig / applyConfig ──────────────────────────────────

describe('T61 TextCompare config snapshot', () => {
  it('getConfig returns all known _opts fields', () => {
    const tc = new TextCompare({
      algorithm: 'patience',
      ignoreWhitespace: true,
      ignoreCase: true,
      ignoreLineEndings: true,
      contextLines: 10,
      ignorePatterns: ['^\\s*//'],
      unimportantPatterns: ['^\\s*import'],
    })
    const cfg = tc.getConfig()
    expect(cfg).toEqual({
      algorithm: 'patience',
      ignoreWhitespace: true,
      ignoreCase: true,
      ignoreLineEndings: true,
      contextLines: 10,
      ignorePatterns: ['^\\s*//'],
      unimportantPatterns: ['^\\s*import'],
    })
  })

  it('applyConfig round-trips: getConfig → applyConfig restores state', () => {
    const tc = new TextCompare()
    const snapshot = {
      algorithm: 'patience',
      ignoreWhitespace: true,
      ignoreCase: true,
      ignoreLineEndings: false,
      contextLines: 4,
      ignorePatterns: ['^//'],
      unimportantPatterns: ['^import'],
    }
    tc.applyConfig(snapshot)
    expect(tc.getConfig()).toEqual(snapshot)
  })

  it('applyConfig triggers _runDiff when content is loaded', () => {
    const tc = new TextCompare()
    tc._leftContent = 'hello\n'
    tc._rightContent = 'world\n'
    const spy = vi.spyOn(tc, '_runDiff').mockImplementation(() => {})
    tc.applyConfig({ algorithm: 'patience' })
    expect(spy).toHaveBeenCalledOnce()
  })

  it('applyConfig ignores unknown keys', () => {
    const tc = new TextCompare()
    tc.applyConfig({ algorithm: 'patience', mystery: 'value', injected: 42 })
    const cfg = tc.getConfig()
    expect(cfg.algorithm).toBe('patience')
    expect('mystery' in cfg).toBe(false)
    expect('injected' in cfg).toBe(false)
  })
})

// ── T62 Stats counting ───────────────────────────────────────────────────────

describe('T62 TextCompare.getDiffStats', () => {
  it('counts each diff line type', () => {
    const tc = new TextCompare()
    tc._diffResult = [
      { type: 'equal',   leftText: 'a', rightText: 'a' },
      { type: 'equal',   leftText: 'b', rightText: 'b' },
      { type: 'insert',  leftText: '',  rightText: 'c' },
      { type: 'delete',  leftText: 'd', rightText: '' },
      { type: 'replace', leftText: 'e', rightText: 'E' },
      { type: 'replace', leftText: 'f', rightText: 'F' },
    ]
    const stats = tc.getDiffStats()
    expect(stats.equal).toBe(2)
    expect(stats.insert).toBe(1)
    expect(stats.delete).toBe(1)
    expect(stats.replace).toBe(2)
    expect(stats.total).toBe(6)
  })

  it('returns zeros for an empty diff result', () => {
    const tc = new TextCompare()
    tc._diffResult = []
    expect(tc.getDiffStats()).toEqual({
      equal: 0, insert: 0, delete: 0, replace: 0, total: 0,
    })
  })

  it('buildHtmlReport embeds the computed counts', () => {
    const tc = new TextCompare()
    tc._diffResult = [
      { type: 'insert', leftLine: null, rightLine: 1, leftText: '', rightText: 'x' },
      { type: 'insert', leftLine: null, rightLine: 2, leftText: '', rightText: 'y' },
      { type: 'delete', leftLine: 1, rightLine: null, leftText: 'z', rightText: '' },
    ]
    const html = tc.buildHtmlReport()
    expect(html).toContain('class="stat-add">2')
    expect(html).toContain('class="stat-del">1')
    expect(html).toContain('class="stat-mod">0')
    expect(html).toContain('@media print')
  })
})

describe('T62 FolderCompare.getRowStats', () => {
  it('counts each row status type', () => {
    const fc = new FolderCompare()
    fc._rows = [
      { status: 'same',        name: 'a' },
      { status: 'same',        name: 'b' },
      { status: 'different',   name: 'c' },
      { status: 'left_only',   name: 'd' },
      { status: 'right_only',  name: 'e' },
      { status: 'left_newer',  name: 'f' },
      { status: 'right_newer', name: 'g' },
    ]
    const stats = fc.getRowStats()
    expect(stats).toEqual({
      same: 2, different: 1, left_only: 1, right_only: 1,
      left_newer: 1, right_newer: 1, total: 7,
    })
  })

  it('buildHtmlReport contains stats numbers and @media print block', () => {
    const fc = new FolderCompare()
    fc._leftPath = '/L'
    fc._rightPath = '/R'
    fc._rows = [
      { status: 'different', name: 'a' },
      { status: 'left_only', name: 'b' },
      { status: 'left_only', name: 'c' },
    ]
    const html = fc.buildHtmlReport()
    expect(html).toContain('class="stat-diff">1')
    expect(html).toContain('class="stat-leftonly">2')
    expect(html).toContain('@media print')
  })
})

// ── T63 WorkspaceStore + serialiseTabs ───────────────────────────────────────

describe('T63 WorkspaceStore', () => {
  /** Make a tab object resembling app.js TabRecord, including the heavy state. */
  function makeTab(over = {}) {
    return {
      id: 'tab-1',
      type: 'text',
      title: 't1',
      leftPath: '/a',
      rightPath: '/b',
      basePath: '',
      state: { leftContent: 'X'.repeat(100), rightContent: 'Y'.repeat(100) },
      ...over,
    }
  }

  it('save + get returns the entry minus the heavy state field', () => {
    const store = new WorkspaceStore()
    store.save('ws', [makeTab(), makeTab({ id: 'tab-2', type: 'folder', leftPath: '/x', rightPath: '/y' })])
    const got = store.get('ws')
    expect(got).not.toBeNull()
    expect(got.tabs).toHaveLength(2)
    for (const t of got.tabs) {
      expect('state' in t).toBe(false)
      expect('id' in t).toBe(false)
    }
  })

  it('serialiseTabs preserves path fields and strips state', () => {
    const tabs = [makeTab({ title: 'hello', leftPath: '/L', rightPath: '/R', basePath: '/B', type: 'merge3' })]
    const out = serialiseTabs(tabs)
    expect(out).toEqual([{
      type: 'merge3', title: 'hello', leftPath: '/L', rightPath: '/R', basePath: '/B',
    }])
  })

  it('list returns saved entries; remove deletes them', () => {
    const store = new WorkspaceStore()
    store.save('a', [makeTab()])
    store.save('b', [makeTab({ id: 'x', type: 'folder' })])
    expect(store.list().map(e => e.name).sort()).toEqual(['a', 'b'])
    store.remove('a')
    expect(store.get('a')).toBeNull()
    expect(store.list()).toHaveLength(1)
  })

  it('round-trip through localStorage preserves all path fields', () => {
    const store1 = new WorkspaceStore()
    const tabs = [
      makeTab({ type: 'text',  leftPath: '/p1', rightPath: '/p2', basePath: '' }),
      makeTab({ type: 'merge3', leftPath: '/L', rightPath: '/R', basePath: '/Base', title: '3-way' }),
    ]
    store1.save('ws', tabs)
    // New instance, same localStorage
    const store2 = new WorkspaceStore()
    const got = store2.get('ws')
    expect(got.tabs).toEqual([
      { type: 'text',  title: 't1', leftPath: '/p1', rightPath: '/p2', basePath: '' },
      { type: 'merge3', title: '3-way', leftPath: '/L', rightPath: '/R', basePath: '/Base' },
    ])
  })

  it('rejects invalid input (empty name, non-array tabs)', () => {
    const store = new WorkspaceStore()
    expect(store.save('',   [makeTab()])).toBeNull()
    expect(store.save('ws', /** @type {any} */ ('not-array'))).toBeNull()
    expect(store.list()).toHaveLength(0)
  })
})
