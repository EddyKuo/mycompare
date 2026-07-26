/**
 * Folder snapshots.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  collectEntries,
  serializeSnapshot,
  deserializeSnapshot,
  writeSnapshot,
  readSnapshot,
  snapshotLevel,
  SNAPSHOT_VERSION,
} from '../../src/main/snapshot.js'

/** @type {string} */
let root

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mycompare-snap-'))
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  mkdirSync(join(root, 'empty'), { recursive: true })
  writeFileSync(join(root, 'a.txt'), 'hello', 'utf-8')
  writeFileSync(join(root, 'src', 'b.js'), 'console.log(1)', 'utf-8')
  writeFileSync(join(root, 'src', 'deep', 'c.js'), 'x', 'utf-8')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('collectEntries', () => {
  it('records every entry with a root-relative path', async () => {
    const { entries, truncated } = await collectEntries(root)
    const paths = entries.map((e) => e.path)
    expect(truncated).toBe(false)
    expect(paths).toContain('a.txt')
    expect(paths).toContain('src')
    expect(paths).toContain('src/b.js')
    expect(paths).toContain('src/deep/c.js')
    expect(paths).toContain('empty')
  })

  it('uses forward slashes regardless of platform', async () => {
    const { entries } = await collectEntries(root)
    expect(entries.every((e) => !e.path.includes('\\'))).toBe(true)
  })

  it('returns entries in a stable order', async () => {
    const a = await collectEntries(root)
    const b = await collectEntries(root)
    expect(a.entries.map((e) => e.path)).toEqual(b.entries.map((e) => e.path))
  })

  it('marks directories and reports file sizes', async () => {
    const { entries } = await collectEntries(root)
    const dir = entries.find((e) => e.path === 'src')
    const file = entries.find((e) => e.path === 'a.txt')
    expect(dir.isDirectory).toBe(true)
    expect(file.isDirectory).toBe(false)
    expect(file.size).toBe(5)
  })

  it('omits content hashes unless asked', async () => {
    const { entries } = await collectEntries(root)
    expect(entries.every((e) => e.crc === undefined)).toBe(true)
  })

  it('records hashes when asked, and not for directories', async () => {
    const { entries } = await collectEntries(root, { crc: true })
    const file = entries.find((e) => e.path === 'a.txt')
    const dir = entries.find((e) => e.path === 'src')
    expect(file.crc).toMatch(/^[0-9a-f]{32}$/)
    expect(dir.crc).toBeUndefined()
  })

  it('skips hashing files above the size ceiling rather than stalling', async () => {
    const { entries } = await collectEntries(root, { crc: true, maxCrcBytes: 1 })
    expect(entries.find((e) => e.path === 'a.txt').crc).toBeUndefined()
  })

  it('reports truncation instead of silently returning a partial tree', async () => {
    const { entries, truncated } = await collectEntries(root, { maxEntries: 2 })
    expect(truncated).toBe(true)
    expect(entries.length).toBeLessThanOrEqual(2)
  })

  it('stops when the signal is aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const { entries } = await collectEntries(root, { signal: ctrl.signal })
    expect(entries).toEqual([])
  })

  it('returns nothing for a path that does not exist', async () => {
    const { entries } = await collectEntries(join(root, 'no-such-dir'))
    expect(entries).toEqual([])
  })
})

describe('serialize / deserialize', () => {
  const sample = {
    version: SNAPSHOT_VERSION,
    root: 'C:/x',
    name: 'x',
    createdAt: '2026-07-27T00:00:00.000Z',
    hasCrc: false,
    entries: [{ path: 'a.txt', isDirectory: false, size: 1, mtime: '2026-01-01T00:00:00.000Z' }],
  }

  it('round-trips', () => {
    expect(deserializeSnapshot(serializeSnapshot(sample))).toEqual(sample)
  })

  it('compresses, so a repetitive tree does not become megabytes of JSON', () => {
    const big = {
      ...sample,
      entries: Array.from({ length: 5000 }, (_, i) => ({
        path: `dir/file-${i}.txt`, isDirectory: false, size: 10,
        mtime: '2026-01-01T00:00:00.000Z',
      })),
    }
    const raw = Buffer.from(JSON.stringify(big), 'utf-8').length
    expect(serializeSnapshot(big).length).toBeLessThan(raw / 4)
  })

  it('rejects a file that is not a snapshot', () => {
    expect(() => deserializeSnapshot(Buffer.from('not gzipped', 'utf-8')))
      .toThrow(/不是有效的快照檔/)
  })

  it('rejects gzipped data that is not a snapshot', () => {
    const { gzipSync } = require('zlib')
    expect(() => deserializeSnapshot(gzipSync(Buffer.from('{}', 'utf-8'))))
      .toThrow(/格式標記不符/)
  })

  it('refuses a snapshot from a newer version rather than misreading it', () => {
    const future = serializeSnapshot({ ...sample, version: SNAPSHOT_VERSION + 1 })
    expect(() => deserializeSnapshot(future)).toThrow(/較新/)
  })

  it('rejects a snapshot with no entry list', () => {
    const bad = serializeSnapshot({ ...sample, entries: undefined })
    expect(() => deserializeSnapshot(bad)).toThrow(/毀損/)
  })
})

describe('writeSnapshot / readSnapshot', () => {
  it('writes a file that reads back with the same entries', async () => {
    const out = join(root, 'snap.mcss')
    const result = await writeSnapshot(root, out, { now: new Date('2026-07-27T00:00:00Z') })
    expect(result.count).toBeGreaterThan(0)
    expect(result.truncated).toBe(false)

    const loaded = await readSnapshot(out)
    expect(loaded.version).toBe(SNAPSHOT_VERSION)
    expect(loaded.createdAt).toBe('2026-07-27T00:00:00.000Z')
    expect(loaded.entries.map((e) => e.path)).toContain('src/b.js')
    rmSync(out, { force: true })
  })

  it('does not store file contents', async () => {
    const out = join(root, 'snap2.mcss')
    await writeSnapshot(root, out)
    const bytes = await readFile(out)
    // 'console.log(1)' is the body of src/b.js; a snapshot must not carry it.
    expect(bytes.includes(Buffer.from('console.log(1)'))).toBe(false)
    rmSync(out, { force: true })
  })
})

describe('snapshotLevel', () => {
  const snap = {
    version: 1, root: 'C:/x', name: 'x', createdAt: '', hasCrc: false,
    entries: [
      { path: 'a.txt', isDirectory: false, size: 1, mtime: 'm' },
      { path: 'src', isDirectory: true, size: 0, mtime: 'm' },
      { path: 'src/b.js', isDirectory: false, size: 2, mtime: 'm', crc: 'abc' },
      { path: 'src/deep', isDirectory: true, size: 0, mtime: 'm' },
      { path: 'src/deep/c.js', isDirectory: false, size: 3, mtime: 'm' },
    ],
  }

  it('returns only immediate children of the root', () => {
    expect(snapshotLevel(snap).map((e) => e.name).sort()).toEqual(['a.txt', 'src'])
  })

  it('returns only immediate children of a subdirectory', () => {
    expect(snapshotLevel(snap, 'src').map((e) => e.name).sort()).toEqual(['b.js', 'deep'])
  })

  it('carries the crc through when present', () => {
    expect(snapshotLevel(snap, 'src').find((e) => e.name === 'b.js').crc).toBe('abc')
  })

  it('marks paths with a scheme the filesystem handlers reject', () => {
    // A snapshot entry has no real file behind it; letting its path reach an
    // fs handler would read whatever happens to sit at that location.
    for (const e of snapshotLevel(snap)) {
      expect(e.path.startsWith('snapshot://')).toBe(true)
    }
  })

  it('returns nothing for a directory that is not in the snapshot', () => {
    expect(snapshotLevel(snap, 'nope')).toEqual([])
  })

  it('tolerates a snapshot with no entries', () => {
    expect(snapshotLevel({ entries: [] })).toEqual([])
    expect(snapshotLevel({})).toEqual([])
  })
})
