/**
 * @vitest-environment jsdom
 *
 * Sprint 16 — folder compare: rules-based content comparison, scan progress
 * and cancellation.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  FolderCompare,
  classifyTextPair,
  compileRulePatterns,
  normalizeRulesOptions,
  planRulesComparison,
  rollupUnimportant,
  statusForRulesClass,
  isRulesTextCandidate,
  DEFAULT_RULES_OPTIONS,
  MAX_RULES_FILE_BYTES,
} from '../../src/renderer/src/views/folder-compare.js'

/** @param {object} o */
function fileRow({ name = 'a.txt', status = 'different', size = 10, left = `/l/${name}`, right = `/r/${name}` } = {}) {
  return {
    name,
    status,
    left:  left  ? { path: left,  name, size, isDirectory: false, mtime: '2024-01-01T00:00:00.000Z' } : null,
    right: right ? { path: right, name, size, isDirectory: false, mtime: '2024-01-02T00:00:00.000Z' } : null,
    children: null,
  }
}

/**
 * @param {Record<string, string>} files path → text content
 * @param {Record<string, string>} [hashes] path → hash
 */
function mockApi(files, hashes = {}) {
  return {
    readDir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(async (p) => ({ path: p, content: files[p] ?? '', encoding: 'utf8' })),
    hashFile: vi.fn(async (p) => hashes[p] ?? `hash:${p}`),
  }
}

/** @param {CompareRow[]} rows */
function buildFC(rows = [], rulesOptions = {}) {
  const fc = new FolderCompare({ leftPath: '/l', rightPath: '/r', mode: 'rules', rulesOptions })
  fc._rows = rows
  fc._dom = { list: document.createElement('div') }
  fc._applyFilterAndRender = vi.fn()
  return fc
}

// ── Pure classification ─────────────────────────────────────────────────────

describe('classifyTextPair', () => {
  it('calls byte-identical text identical', () => {
    expect(classifyTextPair('a\nb\n', 'a\nb\n')).toBe('identical')
  })

  it('treats a whitespace-only difference as unimportant', () => {
    const cls = classifyTextPair('int  x = 1;\ny();\n', 'int x   = 1;\ny();\n', { ignoreWhitespace: true })
    expect(cls).toBe('minor')
  })

  it('treats a line-ending-only difference as unimportant', () => {
    expect(classifyTextPair('a\r\nb\r\n', 'a\nb\n', { ignoreLineEndings: true })).toBe('minor')
  })

  it('reports a substantive difference as major', () => {
    expect(classifyTextPair('a\nb\n', 'a\nZZZ\n', { ignoreWhitespace: true })).toBe('major')
  })

  it('honours ignoreCase only when asked', () => {
    expect(classifyTextPair('Hello\n', 'hello\n', { ignoreCase: true })).toBe('minor')
    expect(classifyTextPair('Hello\n', 'hello\n', { ignoreCase: false, ignoreWhitespace: false })).toBe('major')
  })

  it('drops lines matching an ignore regex from the comparison', () => {
    const left = '# built 2024-01-01\nvalue = 1\n'
    const right = '# built 2025-06-30\nvalue = 1\n'
    expect(classifyTextPair(left, right, { ignorePatterns: ['^# built'] })).toBe('minor')
    expect(classifyTextPair(left, right, { ignorePatterns: [] })).toBe('major')
  })

  it('grades a change confined to unimportant-regex lines as minor', () => {
    const left = 'code()\n// TODO: old note\n'
    const right = 'code()\n// TODO: new note\n'
    expect(classifyTextPair(left, right, { unimportantPatterns: ['^\\s*//'] })).toBe('minor')
    // A change outside those lines still counts.
    expect(classifyTextPair(left, 'other()\n// TODO: old note\n', { unimportantPatterns: ['^\\s*//'] })).toBe('major')
  })

  it('ignores an unparsable pattern instead of throwing', () => {
    expect(compileRulePatterns(['(', '^ok'])).toHaveLength(1)
    expect(() => classifyTextPair('a\n', 'b\n', { ignorePatterns: ['('] })).not.toThrow()
  })

  it('coerces nullish input', () => {
    expect(classifyTextPair(null, undefined)).toBe('identical')
  })
})

describe('statusForRulesClass', () => {
  it('maps the three grades onto row status and the blue flag', () => {
    expect(statusForRulesClass('identical')).toEqual({ status: 'same', unimportant: false })
    expect(statusForRulesClass('minor')).toEqual({ status: 'same', unimportant: true })
    expect(statusForRulesClass('major')).toEqual({ status: 'different', unimportant: false })
  })
})

describe('normalizeRulesOptions', () => {
  it('falls back to the defaults for junk input', () => {
    expect(normalizeRulesOptions(null)).toEqual(DEFAULT_RULES_OPTIONS)
    expect(normalizeRulesOptions({ maxBytes: -5, algorithm: 'telepathy' }).maxBytes)
      .toBe(DEFAULT_RULES_OPTIONS.maxBytes)
    expect(normalizeRulesOptions({ algorithm: 'telepathy' }).algorithm).toBe('myers')
  })

  it('clamps the per-file ceiling to the hard limit', () => {
    expect(normalizeRulesOptions({ maxBytes: 1e12 }).maxBytes).toBe(MAX_RULES_FILE_BYTES)
  })

  it('keeps only usable pattern strings', () => {
    const opts = normalizeRulesOptions({ ignorePatterns: ['  ^a ', '', 3, null] })
    expect(opts.ignorePatterns).toEqual(['^a'])
  })
})

// ── Candidate planning ──────────────────────────────────────────────────────

describe('planRulesComparison', () => {
  it('routes binaries to the hash path', () => {
    expect(isRulesTextCandidate('a.txt')).toBe(true)
    expect(isRulesTextCandidate('a.png')).toBe(false)
    const plan = planRulesComparison([
      fileRow({ name: 'a.txt' }),
      fileRow({ name: 'b.png' }),
      fileRow({ name: 'c.exe' }),
    ])
    expect(plan.text.map((r) => r.name)).toEqual(['a.txt'])
    expect(plan.hash.map((r) => r.name)).toEqual(['b.png', 'c.exe'])
  })

  it('routes oversized text files to the hash path', () => {
    const plan = planRulesComparison(
      [fileRow({ name: 'small.txt', size: 100 }), fileRow({ name: 'huge.txt', size: 5_000_000 })],
      { maxBytes: 1024 * 100 },
    )
    expect(plan.text.map((r) => r.name)).toEqual(['small.txt'])
    expect(plan.hash.map((r) => r.name)).toEqual(['huge.txt'])
  })

  it('skips directories, orphans and already-decided rows', () => {
    const dir = fileRow({ name: 'sub' })
    dir.left.isDirectory = true
    dir.right.isDirectory = true
    const plan = planRulesComparison([
      dir,
      fileRow({ name: 'orphan.txt', status: 'left-only', right: null }),
      fileRow({ name: 'equal.txt', status: 'same' }),
      fileRow({ name: 'newer.txt', status: 'left-newer' }),
    ])
    expect(plan.text.map((r) => r.name)).toEqual(['newer.txt'])
    expect(plan.hash).toEqual([])
  })

  it('tolerates null input', () => {
    expect(planRulesComparison(null)).toEqual({ text: [], hash: [] })
  })
})

describe('rollupUnimportant', () => {
  it('reports a directory holding an unimportant-difference descendant', () => {
    const child = fileRow({ name: 'x.txt', status: 'same' })
    child.unimportant = true
    const dir = { name: 'd', status: 'same', left: null, right: null, children: [child] }
    expect(rollupUnimportant(dir)).toBe(true)
    expect(rollupUnimportant({ name: 'e', status: 'same', children: null })).toBe(false)
  })
})

// ── View integration ────────────────────────────────────────────────────────

describe('FolderCompare rules mode', () => {
  it('grades text pairs and marks the unimportant ones', async () => {
    window.electronAPI = mockApi({
      '/l/ws.txt': 'a  b\n',
      '/r/ws.txt': 'a b\n',
      '/l/real.txt': 'one\n',
      '/r/real.txt': 'two\n',
      '/l/eq.txt': 'same\n',
      '/r/eq.txt': 'same\n',
    })
    const rows = [fileRow({ name: 'ws.txt' }), fileRow({ name: 'real.txt' }), fileRow({ name: 'eq.txt' })]
    const fc = buildFC(rows)

    await fc._applyRulesCompare(rows)

    expect(rows[0].status).toBe('same')
    expect(rows[0].unimportant).toBe(true)
    expect(rows[1].status).toBe('different')
    expect(rows[1].unimportant).toBe(false)
    expect(rows[2].status).toBe('same')
    expect(rows[2].unimportant).toBe(false)
  })

  it('falls back to hashing for binaries instead of reading them as text', async () => {
    const api = mockApi({}, { '/l/a.png': 'H1', '/r/a.png': 'H1', '/l/b.bin': 'H2', '/r/b.bin': 'H3' })
    window.electronAPI = api
    const rows = [fileRow({ name: 'a.png' }), fileRow({ name: 'b.bin' })]
    const fc = buildFC(rows)

    await fc._applyRulesCompare(rows)

    expect(api.readFile).not.toHaveBeenCalled()
    expect(api.hashFile).toHaveBeenCalledTimes(4)
    expect(rows[0].status).toBe('same')      // identical hashes
    expect(rows[1].status).toBe('different') // hashes differ, status untouched
  })

  it('hashes rather than reads a file over the size ceiling', async () => {
    const api = mockApi(
      { '/l/big.txt': 'x', '/r/big.txt': 'y' },
      { '/l/big.txt': 'H', '/r/big.txt': 'H' },
    )
    window.electronAPI = api
    const rows = [fileRow({ name: 'big.txt', size: 10_000_000 })]
    const fc = buildFC(rows, { maxBytes: 1024 })

    await fc._applyRulesCompare(rows)

    expect(api.readFile).not.toHaveBeenCalled()
    expect(api.hashFile).toHaveBeenCalledTimes(2)
    expect(rows[0].status).toBe('same')
  })

  it('leaves a row alone when its read fails', async () => {
    window.electronAPI = {
      readDir: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockRejectedValue(new Error('EACCES')),
      hashFile: vi.fn(),
    }
    const rows = [fileRow({ name: 'a.txt' })]
    const fc = buildFC(rows)

    await fc._applyRulesCompare(rows)

    expect(rows[0].status).toBe('different')
  })

  it('applies rule changes through setRulesOptions', () => {
    const fc = buildFC([])
    const opts = fc.setRulesOptions({ ignoreCase: true, unimportantPatterns: ['^//'] })
    expect(opts.ignoreCase).toBe(true)
    expect(fc.getRulesOptions().unimportantPatterns).toEqual(['^//'])
    // The snapshot must be a copy, not the live array.
    fc.getRulesOptions().unimportantPatterns.push('mutated')
    expect(fc.getRulesOptions().unimportantPatterns).toEqual(['^//'])
  })

  it('round-trips the rules through getConfig / applyConfig', () => {
    const a = buildFC([])
    a.setRulesOptions({ ignoreCase: true, ignorePatterns: ['^#'], maxBytes: 2048 })
    const b = buildFC([])
    b.applyConfig(a.getConfig())
    expect(b.getRulesOptions()).toEqual(a.getRulesOptions())
    expect(b.getConfig().mode).toBe('rules')
  })

  it('keeps unimportant rows visible while either same or diff is shown', () => {
    const fc = buildFC([])
    const row = fileRow({ name: 'ws.txt', status: 'same' })
    row.unimportant = true
    fc._showSame = false
    fc._showDiff = true
    expect(fc._isRowVisible(row)).toBe(true)
    fc._showDiff = false
    expect(fc._isRowVisible(row)).toBe(false)
    fc._showSame = true
    expect(fc._isRowVisible(row)).toBe(true)
  })

  it('paints an unimportant row blue and reports it in the stats bar', () => {
    const fc = buildFC([])
    const row = fileRow({ name: 'ws.txt', status: 'same' })
    row.unimportant = true
    const rowEl = fc._buildRow(row, 0, false)
    expect(rowEl.className).toContain('fc-row--unimportant')
    expect(rowEl.dataset.unimportant).toBe('true')

    fc._dom.stats = document.createElement('div')
    fc._renderStats([row])
    expect(fc._dom.stats.textContent).toContain('不重要差異: 1')
  })

  it('labels unimportant rows in the HTML report', () => {
    const fc = buildFC([])
    const row = fileRow({ name: 'ws.txt', status: 'same' })
    row.unimportant = true
    fc._rows = [row]
    expect(fc.buildHtmlReport()).toContain('不重要差異')
  })
})

// ── Progress & cancellation ─────────────────────────────────────────────────

describe('FolderCompare scan cancellation', () => {
  it('discards rules results that arrive after a cancel', async () => {
    const rows = [fileRow({ name: 'a.txt' })]
    const fc = buildFC(rows)
    window.electronAPI = {
      readDir: vi.fn().mockResolvedValue([]),
      readFile: vi.fn(async (p) => {
        // Cancel lands while the pair is still in flight.
        fc.cancelScan()
        return { path: p, content: 'identical\n' }
      }),
      hashFile: vi.fn(),
    }

    const ctrl = fc._beginScan()
    await fc._applyRulesCompare(rows, ctrl.signal)

    expect(rows[0].status).toBe('different')
    expect(rows[0].unimportant).toBeUndefined()
  })

  it('discards hash results that arrive after a cancel', async () => {
    const rows = [fileRow({ name: 'a.bin' })]
    const fc = buildFC(rows)
    window.electronAPI = {
      readDir: vi.fn().mockResolvedValue([]),
      readFile: vi.fn(),
      hashFile: vi.fn(async () => { fc.cancelScan(); return 'SAME' }),
    }

    const ctrl = fc._beginScan()
    await fc._applyContentHash(rows, ctrl.signal)

    expect(rows[0].status).toBe('different')
  })

  it('reports progress and clears the indicator when the scan ends', async () => {
    window.electronAPI = mockApi({ '/l/a.txt': 'x\n', '/r/a.txt': 'x\n' })
    const rows = [fileRow({ name: 'a.txt' })]
    const fc = buildFC(rows)
    fc._dom.scanStatus = document.createElement('span')
    fc._dom.btnCancel = document.createElement('button')

    const ctrl = fc._beginScan()
    expect(fc.isScanning()).toBe(true)
    expect(fc._dom.scanStatus.textContent).toContain('0 項')

    await fc._applyRulesCompare(rows, ctrl.signal)
    expect(fc._dom.scanStatus.textContent).toContain('1 項')

    fc._endScan(ctrl)
    expect(fc.isScanning()).toBe(false)
    expect(fc._dom.scanStatus.textContent).toBe('')
    expect(fc._dom.btnCancel.style.display).toBe('none')
  })

  it('leaves no half-loaded subtree when expandAll is cancelled', async () => {
    /** @param {string} p */
    const dirEntry = (p, name) => ({ name, path: `${p}/${name}`, isDirectory: true, size: 0, mtime: '2024-01-01T00:00:00.000Z' })
    const fc = new FolderCompare({ leftPath: '/l', rightPath: '/r', mode: 'mtime' })
    fc._dom = { list: document.createElement('div') }
    fc._applyFilterAndRender = vi.fn()
    fc._rows = [{
      name: 'dir',
      status: 'same',
      left:  { path: '/l/dir', name: 'dir', isDirectory: true, size: 0, mtime: '2024-01-01T00:00:00.000Z' },
      right: { path: '/r/dir', name: 'dir', isDirectory: true, size: 0, mtime: '2024-01-01T00:00:00.000Z' },
      children: null,
    }]
    window.electronAPI = {
      readDir: vi.fn(async (p) => {
        fc.cancelScan()
        return [dirEntry(p, 'inner')]
      }),
    }

    await fc.expandAll()

    expect(fc._rows[0].children).toBeNull()
    expect(fc._expanded.size).toBe(0)
    expect(fc.isScanning()).toBe(false)
  })

  it('keeps the previous tree when a re-scan is cancelled', async () => {
    const fc = new FolderCompare({ leftPath: '/l', rightPath: '/r', mode: 'mtime' })
    fc._dom = { list: document.createElement('div') }
    fc._applyFilterAndRender = vi.fn()
    const previous = [fileRow({ name: 'kept.txt', status: 'same' })]
    fc._rows = previous
    window.electronAPI = {
      readDir: vi.fn(async () => {
        fc.cancelScan()
        return [{ name: 'new.txt', path: '/l/new.txt', isDirectory: false, size: 1, mtime: '2024-01-01T00:00:00.000Z' }]
      }),
    }

    await fc._scan()

    expect(fc._rows).toBe(previous)
    expect(fc.isScanning()).toBe(false)
  })
})
