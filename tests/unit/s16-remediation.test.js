/**
 * @vitest-environment jsdom
 *
 * Sprint 16 — remediation regression tests.
 *
 * Covers defects found by the code-review pass that the existing suites
 * missed because they only exercised toy-sized inputs.
 */
import { describe, it, expect, vi } from 'vitest'
import { hexCompleteByteDiff } from '../../src/renderer/src/views/hex-compare.js'
import { diffLines } from '../../src/renderer/src/core/diff-engine.js'
import {
  FolderCompare,
  flattenRows,
  rollupStatus,
  statusVisibleUnder,
  VIEW_PRESETS,
  VIEW_PRESET_LABELS,
} from '../../src/renderer/src/views/folder-compare.js'

// ── Folder compare tree model ───────────────────────────────────────────────

/** @param {object} o */
function row({ name = 'f', status = 'same', left = null, right = null, children = null, isDir = false } = {}) {
  return {
    name,
    status,
    left:  left  ? { path: left,  isDirectory: isDir, size: 1, mtime: '2024-01-01T00:00:00.000Z', name } : null,
    right: right ? { path: right, isDirectory: isDir, size: 1, mtime: '2024-01-01T00:00:00.000Z', name } : null,
    children,
  }
}

function buildFC(rows = []) {
  window.electronAPI = { readDir: vi.fn().mockResolvedValue([]) }
  const fc = new FolderCompare({ leftPath: '/l', rightPath: '/r' })
  fc._rows = rows
  fc._dom = { list: document.createElement('div') }
  return fc
}

describe('flattenRows', () => {
  it('walks nested children depth-first and stamps depth', () => {
    const tree = [
      row({ name: 'src', isDir: true, left: '/l/src', right: '/r/src', children: [
        row({ name: 'a.js', left: '/l/src/a.js', right: '/r/src/a.js' }),
        row({ name: 'deep', isDir: true, left: '/l/src/deep', right: '/r/src/deep', children: [
          row({ name: 'b.js', left: '/l/src/deep/b.js' , status: 'left-only' }),
        ] }),
      ] }),
      row({ name: 'top.txt', left: '/l/top.txt', right: '/r/top.txt' }),
    ]
    const flat = flattenRows(tree)
    expect(flat.map((r) => r.name)).toEqual(['src', 'a.js', 'deep', 'b.js', 'top.txt'])
    expect(flat.map((r) => r.depth)).toEqual([0, 1, 1, 2, 0])
  })

  it('returns an empty array for null/empty input', () => {
    expect(flattenRows(null)).toEqual([])
    expect(flattenRows([])).toEqual([])
  })
})

describe('rollupStatus', () => {
  it('marks a directory different when any descendant differs', () => {
    const dir = row({ name: 'd', isDir: true, left: '/l/d', right: '/r/d', children: [
      row({ name: 'ok.txt', status: 'same' }),
      row({ name: 'bad.txt', status: 'different' }),
    ] })
    expect(rollupStatus(dir)).toBe('different')
  })

  it('propagates a single-sided newer status', () => {
    const dir = row({ name: 'd', isDir: true, left: '/l/d', right: '/r/d', children: [
      row({ name: 'ok.txt', status: 'same' }),
      row({ name: 'n.txt', status: 'left-newer' }),
    ] })
    expect(rollupStatus(dir)).toBe('left-newer')
  })

  it('reports different when both sides have newer files', () => {
    const dir = row({ name: 'd', isDir: true, left: '/l/d', right: '/r/d', children: [
      row({ name: 'a', status: 'left-newer' }),
      row({ name: 'b', status: 'right-newer' }),
    ] })
    expect(rollupStatus(dir)).toBe('different')
  })

  it('rolls up through more than one level', () => {
    const dir = row({ name: 'top', isDir: true, left: '/l/t', right: '/r/t', children: [
      row({ name: 'mid', isDir: true, left: '/l/t/m', right: '/r/t/m', children: [
        row({ name: 'leaf', status: 'different' }),
      ] }),
    ] })
    expect(rollupStatus(dir)).toBe('different')
  })

  it('stays same when every descendant matches', () => {
    const dir = row({ name: 'd', isDir: true, left: '/l/d', right: '/r/d', children: [
      row({ name: 'a', status: 'same' }),
      row({ name: 'b', status: 'same' }),
    ] })
    expect(rollupStatus(dir)).toBe('same')
  })

  it('leaves orphan directories alone', () => {
    expect(rollupStatus(row({ name: 'd', status: 'left-only', left: '/l/d', isDir: true }))).toBe('left-only')
  })

  it('does not guess when children have not been loaded', () => {
    expect(rollupStatus(row({ name: 'd', status: 'same', left: '/l/d', right: '/r/d', isDir: true }))).toBe('same')
  })
})

describe('FolderCompare.getRowStats', () => {
  it('counts hyphenated statuses that the underscore keys previously missed', () => {
    const fc = buildFC([
      row({ name: 'a', status: 'left-only',   left: '/l/a' }),
      row({ name: 'b', status: 'right-only',  right: '/r/b' }),
      row({ name: 'c', status: 'left-newer',  left: '/l/c', right: '/r/c' }),
      row({ name: 'd', status: 'right-newer', left: '/l/d', right: '/r/d' }),
      row({ name: 'e', status: 'same',        left: '/l/e', right: '/r/e' }),
      row({ name: 'f', status: 'different',   left: '/l/f', right: '/r/f' }),
    ])
    const stats = fc.getRowStats()
    expect(stats.left_only).toBe(1)
    expect(stats.right_only).toBe(1)
    expect(stats.left_newer).toBe(1)
    expect(stats.right_newer).toBe(1)
    expect(stats.same).toBe(1)
    expect(stats.different).toBe(1)
    expect(stats.total).toBe(6)
  })

  it('includes rows inside expanded subdirectories', () => {
    const fc = buildFC([
      row({ name: 'dir', isDir: true, left: '/l/dir', right: '/r/dir', children: [
        row({ name: 'x', status: 'different', left: '/l/dir/x', right: '/r/dir/x' }),
        row({ name: 'y', status: 'left-only', left: '/l/dir/y' }),
      ] }),
    ])
    const stats = fc.getRowStats()
    expect(stats.different).toBe(1)
    expect(stats.left_only).toBe(1)
    expect(stats.total).toBe(3) // the directory row itself plus both children
  })
})

describe('FolderCompare HTML report', () => {
  it('renders nested rows and localised status labels', () => {
    const fc = buildFC([
      row({ name: 'dir', isDir: true, left: '/l/dir', right: '/r/dir', children: [
        row({ name: 'child.txt', status: 'left-only', left: '/l/dir/child.txt' }),
      ] }),
    ])
    const html = fc.buildHtmlReport()
    expect(html).toContain('child.txt')
    expect(html).toContain('僅左側')
    // Status label lookup used to fall through to the raw hyphenated value.
    expect(html).not.toContain('>left-only<')
  })
})

describe('FolderCompare.expandAll', () => {
  it('actually loads children rather than only setting flags', async () => {
    window.electronAPI = {
      readDir: vi.fn().mockImplementation(async (p) => {
        if (p === '/l/dir' || p === '/r/dir') {
          return [{ name: 'leaf.txt', path: `${p}/leaf.txt`, isDirectory: false, size: 1, mtime: '2024-01-01T00:00:00.000Z' }]
        }
        return []
      }),
    }
    const fc = new FolderCompare({ leftPath: '/l', rightPath: '/r' })
    fc._dom = { list: document.createElement('div') }
    fc._rows = [row({ name: 'dir', isDir: true, left: '/l/dir', right: '/r/dir' })]
    fc._applyFilterAndRender = vi.fn()

    await fc.expandAll()

    expect(fc._rows[0].children).toHaveLength(1)
    expect(fc._rows[0].children[0].name).toBe('leaf.txt')
    expect(fc._expanded.size).toBe(1)
  })
})

// ── Folder view presets ─────────────────────────────────────────────────────

describe('folder view presets', () => {
  const ALL_STATUSES = ['same', 'different', 'left-only', 'right-only', 'left-newer', 'right-newer']

  /** @param {string} preset */
  const visibleUnder = (preset) =>
    ALL_STATUSES.filter((s) => statusVisibleUnder(s, VIEW_PRESETS[preset]))

  it('covers every display filter Beyond Compare offers', () => {
    for (const [name] of VIEW_PRESET_LABELS) {
      expect(VIEW_PRESETS[name], `missing preset ${name}`).toBeDefined()
    }
    expect(VIEW_PRESET_LABELS).toHaveLength(Object.keys(VIEW_PRESETS).length)
  })

  it('shows everything under "all"', () => {
    expect(visibleUnder('all')).toEqual(ALL_STATUSES)
  })

  it('hides everything under "none"', () => {
    expect(visibleUnder('none')).toEqual([])
  })

  it('keeps orphans visible under "differences", as BC does', () => {
    const v = visibleUnder('differences')
    expect(v).toContain('left-only')
    expect(v).toContain('right-only')
    expect(v).not.toContain('same')
  })

  it('drops orphans under "no-orphans" but keeps content differences', () => {
    const v = visibleUnder('no-orphans')
    expect(v).toContain('same')
    expect(v).toContain('different')
    expect(v).not.toContain('left-only')
    expect(v).not.toContain('right-only')
  })

  it('shows only same rows under "same"', () => {
    expect(visibleUnder('same')).toEqual(['same'])
  })

  it('separates the two orphan sides', () => {
    expect(visibleUnder('left-orphans')).toEqual(['left-only'])
    expect(visibleUnder('right-orphans')).toEqual(['right-only'])
  })

  it('separates the two newer sides', () => {
    expect(visibleUnder('left-newer')).toEqual(['left-newer'])
    expect(visibleUnder('right-newer')).toEqual(['right-newer'])
  })

  it('applies a preset to a live instance and syncs the combined orphan flag', () => {
    const fc = buildFC([])
    fc._applyFilterAndRender = vi.fn()
    fc.setViewPreset('left-orphans')
    expect(fc._showLeftOnly).toBe(true)
    expect(fc._showRightOnly).toBe(false)
    // Combined accessor reports true while either side is on.
    expect(fc._showOrphan).toBe(true)

    fc.setViewPreset('same')
    expect(fc._showOrphan).toBe(false)
  })

  it('ignores an unknown preset name', () => {
    const fc = buildFC([])
    fc._applyFilterAndRender = vi.fn()
    fc.setViewPreset('nope')
    expect(fc._viewPreset).toBe('all')
  })

  it('setting the combined orphan flag drives both sides', () => {
    const fc = buildFC([])
    fc._showOrphan = false
    expect(fc._showLeftOnly).toBe(false)
    expect(fc._showRightOnly).toBe(false)
    fc._showOrphan = true
    expect(fc._showLeftOnly).toBe(true)
    expect(fc._showRightOnly).toBe(true)
  })
})

// ── Line-level Myers bounds ─────────────────────────────────────────────────

describe('diffLines — pathological inputs', () => {
  it('completes on two large, almost entirely different files', () => {
    const N = 20_000
    const left  = Array.from({ length: N }, (_, i) => `left line ${i}`).join('\n')
    const right = Array.from({ length: N }, (_, i) => `right line ${i}`).join('\n')

    const started = Date.now()
    const result = diffLines(left, right)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(20_000)
    expect(result.length).toBeGreaterThan(0)
    // Nothing matches, so every left line must be accounted for as removed.
    const removed = result.filter((r) => r.type === 'delete' || r.type === 'remove').length
    expect(removed).toBeGreaterThan(0)
  })

  it('stays exact and fast when a large file has few differences', () => {
    const N = 20_000
    const leftLines = Array.from({ length: N }, (_, i) => `line ${i}`)
    const rightLines = leftLines.slice()
    rightLines[10] = 'CHANGED'
    rightLines.splice(500, 0, 'INSERTED')

    const started = Date.now()
    const result = diffLines(leftLines.join('\n'), rightLines.join('\n'))
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(5000)
    const changed = result.filter((r) => r.type !== 'equal').length
    // One modified line plus one inserted line — a handful of ops, not thousands.
    expect(changed).toBeLessThan(10)
  })

  it('handles one side empty', () => {
    const result = diffLines('', 'a\nb\nc')
    expect(result.filter((r) => r.type === 'equal')).toHaveLength(0)
    expect(result.length).toBeGreaterThanOrEqual(3)
  })
})

// ── Hex Complete-mode byte diff ─────────────────────────────────────────────

describe('hexCompleteByteDiff — large inputs', () => {
  it('handles multi-MB inputs with a small edit distance without exhausting memory', () => {
    const SIZE = 2 * 1024 * 1024
    const a = new Uint8Array(SIZE)
    for (let i = 0; i < SIZE; i++) a[i] = i & 0xff
    // Single byte flipped in the middle — prefix/suffix trim should reduce the
    // Myers input to (almost) nothing.
    const b = a.slice()
    b[SIZE >> 1] = b[SIZE >> 1] ^ 0xff

    const started = Date.now()
    const { leftClass, rightClass, truncated } = hexCompleteByteDiff(a, b)
    const elapsed = Date.now() - started

    expect(truncated).toBe(false)
    expect(elapsed).toBeLessThan(5000)
    expect(leftClass.length).toBe(SIZE)
    expect(rightClass.length).toBe(SIZE)
    // Exactly one byte differs on each side.
    expect(leftClass.reduce((s, v) => s + v, 0)).toBe(1)
    expect(rightClass.reduce((s, v) => s + v, 0)).toBe(1)
    expect(leftClass[SIZE >> 1]).toBe(1)
  })

  it('degrades gracefully instead of hanging when the edit distance blows the budget', () => {
    const SIZE = 200_000
    const a = new Uint8Array(SIZE)
    const b = new Uint8Array(SIZE)
    // Deterministic pseudo-random, fully dissimilar content.
    let sa = 1
    let sb = 2
    for (let i = 0; i < SIZE; i++) {
      sa = (sa * 1103515245 + 12345) & 0x7fffffff
      sb = (sb * 1103515245 + 54321) & 0x7fffffff
      a[i] = (sa >> 16) & 0xff
      b[i] = (sb >> 16) & 0xff
    }

    const started = Date.now()
    const { leftClass, rightClass, truncated } = hexCompleteByteDiff(a, b, { maxEditDistance: 256 })
    const elapsed = Date.now() - started

    expect(truncated).toBe(true)
    expect(elapsed).toBeLessThan(5000)
    expect(leftClass.length).toBe(SIZE)
    expect(rightClass.length).toBe(SIZE)
    // Positional fallback still marks the ~1/256 coincidental byte matches same.
    const diffCount = leftClass.reduce((s, v) => s + v, 0)
    expect(diffCount).toBeGreaterThan(SIZE * 0.9)
  })

  it('trims a shared prefix and suffix around a differing middle', () => {
    const a = new Uint8Array([1, 2, 3, 10, 11, 8, 9])
    const b = new Uint8Array([1, 2, 3, 20, 8, 9])
    const { leftClass, rightClass, truncated } = hexCompleteByteDiff(a, b)
    expect(truncated).toBe(false)
    expect(Array.from(leftClass)).toEqual([0, 0, 0, 1, 1, 0, 0])
    expect(Array.from(rightClass)).toEqual([0, 0, 0, 1, 0, 0])
  })

  it('classifies a pure deletion at the head correctly', () => {
    const a = new Uint8Array([9, 9, 1, 2, 3])
    const b = new Uint8Array([1, 2, 3])
    const { leftClass, rightClass } = hexCompleteByteDiff(a, b)
    expect(Array.from(leftClass)).toEqual([1, 1, 0, 0, 0])
    expect(Array.from(rightClass)).toEqual([0, 0, 0])
  })

  it('handles one side empty', () => {
    const out = hexCompleteByteDiff(new Uint8Array([1, 2, 3]), new Uint8Array(0))
    expect(Array.from(out.leftClass)).toEqual([1, 1, 1])
    expect(out.rightClass.length).toBe(0)
    expect(out.truncated).toBe(false)
  })

  it('reports every byte as same for identical multi-KB inputs', () => {
    const a = new Uint8Array(50_000)
    for (let i = 0; i < a.length; i++) a[i] = (i * 7) & 0xff
    const { leftClass, rightClass, truncated } = hexCompleteByteDiff(a, a.slice())
    expect(truncated).toBe(false)
    expect(leftClass.reduce((s, v) => s + v, 0)).toBe(0)
    expect(rightClass.reduce((s, v) => s + v, 0)).toBe(0)
  })
})
