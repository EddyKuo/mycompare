/**
 * Find in Files — the one search that crosses file boundaries.
 *
 * Runs against a real directory tree rather than a mocked filesystem: the
 * things most likely to be wrong here are directory walking, symlink handling
 * and binary detection, and a mock would answer all three the way the test
 * author already believes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  findInFiles, buildSearchRegex, looksBinary, MAX_FILE_BYTES,
} from '../../src/main/find-in-files.js'

/** @type {string} */
let root

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mycompare-fif-'))
  await mkdir(join(root, 'src', 'deep'), { recursive: true })
  await writeFile(join(root, 'a.txt'), 'hello world\nsecond needle line\n', 'utf-8')
  await writeFile(join(root, 'src', 'b.js'), 'const needle = 1\n// needle again\n', 'utf-8')
  await writeFile(join(root, 'src', 'deep', 'c.md'), 'nothing here\n', 'utf-8')
  await writeFile(join(root, 'NEEDLE.TXT'), 'Needle in caps\n', 'utf-8')
  // Non-ASCII, written as UTF-8 with a BOM — the decode has to survive it.
  await writeFile(join(root, 'utf.txt'), '﻿針 needle 針\n', 'utf-8')
  // A binary file that contains the search term in plain bytes.
  await writeFile(join(root, 'blob.bin'),
    Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2, 3])]))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('building the matcher', () => {
  it('treats a plain query literally', () => {
    // Without escaping, searching for "a.b" would also match "axb".
    const re = buildSearchRegex({ query: 'a.b' })
    expect(re.test('a.b')).toBe(true)
    re.lastIndex = 0
    expect(re.test('axb')).toBe(false)
  })

  it('honours the regex switch', () => {
    expect(buildSearchRegex({ query: 'a.b', regex: true }).test('axb')).toBe(true)
  })

  it('is case-insensitive unless asked otherwise', () => {
    expect(buildSearchRegex({ query: 'abc' }).test('ABC')).toBe(true)
    expect(buildSearchRegex({ query: 'abc', caseSensitive: true }).test('ABC')).toBe(false)
  })

  it('anchors a whole-word search to word boundaries', () => {
    const re = buildSearchRegex({ query: 'cat', wholeWord: true })
    expect(re.test('a cat here')).toBe(true)
    re.lastIndex = 0
    expect(re.test('concatenate')).toBe(false)
  })

  it('refuses an empty query and an uncompilable pattern', () => {
    expect(() => buildSearchRegex({ query: '' })).toThrow()
    expect(() => buildSearchRegex({ query: '(', regex: true })).toThrow(/無法解讀/)
  })
})

describe('binary detection', () => {
  it('calls a NUL-bearing buffer binary', () => {
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true)
    expect(looksBinary(Buffer.from('plain text'))).toBe(false)
  })
})

describe('searching a tree', () => {
  it('finds every occurrence with its position', async () => {
    const out = await findInFiles({ root, query: 'needle' })
    const byFile = {}
    for (const m of out.matches) byFile[m.relPath] = (byFile[m.relPath] ?? 0) + 1

    expect(byFile['a.txt']).toBe(1)
    expect(byFile['src/b.js']).toBe(2)
    // Case-insensitive by default, so the capitalised file counts.
    expect(byFile['NEEDLE.TXT']).toBe(1)
    expect(byFile['src/deep/c.md']).toBeUndefined()

    const first = out.matches.find((m) => m.relPath === 'a.txt')
    expect(first.line).toBe(2)
    expect(first.column).toBe(8)
    expect(first.text).toBe('second needle line')
  })

  it('skips binary files instead of reporting hits nobody can act on', async () => {
    const out = await findInFiles({ root, query: 'needle' })
    expect(out.matches.some((m) => m.relPath === 'blob.bin')).toBe(false)
    expect(out.filesSkipped).toBeGreaterThan(0)
  })

  it('decodes the way the editor does, so a hit is one the user will see', async () => {
    const out = await findInFiles({ root, query: '針' })
    const hit = out.matches.find((m) => m.relPath === 'utf.txt')
    expect(hit).toBeTruthy()
    // The BOM must not become part of the line, or the column would be off by
    // one against what the editor shows.
    expect(hit.text.startsWith('針')).toBe(true)
    expect(hit.column).toBe(1)
  })

  it('applies the file mask through the shared parser', async () => {
    const out = await findInFiles({ root, query: 'needle', mask: '*.js' })
    expect(out.matches.every((m) => m.relPath.endsWith('.js'))).toBe(true)
    expect(out.matches.length).toBe(2)
  })

  it('honours an exclusion mask', async () => {
    const out = await findInFiles({ root, query: 'needle', mask: '*.txt;-NEEDLE.TXT' })
    expect(out.matches.some((m) => m.relPath === 'a.txt')).toBe(true)
    expect(out.matches.some((m) => m.relPath === 'NEEDLE.TXT')).toBe(false)
  })

  it('stays in the top folder when recursion is off', async () => {
    const out = await findInFiles({ root, query: 'needle', recursive: false })
    expect(out.matches.some((m) => m.relPath.includes('/'))).toBe(false)
  })

  it('reports truncation rather than returning a short list that looks complete', async () => {
    const out = await findInFiles({ root, query: 'needle', maxMatches: 2 })
    expect(out.matches).toHaveLength(2)
    expect(out.truncated).toBe('matches')

    const all = await findInFiles({ root, query: 'needle' })
    expect(all.truncated).toBeNull()
  })

  it('skips a file past the size cap and counts it', async () => {
    const out = await findInFiles({ root, query: 'needle', maxFileBytes: 4 })
    expect(out.matches).toHaveLength(0)
    expect(out.filesSkipped).toBeGreaterThan(0)
    expect(MAX_FILE_BYTES).toBeGreaterThan(0)
  })

  it('does not follow a directory symlink out of the search root', async () => {
    // Following one would leave the folder the caller authorised — and a link
    // pointing at an ancestor would loop until the process died.
    const outside = await mkdtemp(join(tmpdir(), 'mycompare-fif-out-'))
    await writeFile(join(outside, 'secret.txt'), 'needle outside\n', 'utf-8')
    const link = join(root, 'link')
    try {
      await symlink(outside, link, 'junction')
    } catch {
      await rm(outside, { recursive: true, force: true })
      return // no permission to create links here
    }
    try {
      const out = await findInFiles({ root, query: 'needle' })
      expect(out.matches.some((m) => m.relPath.includes('secret'))).toBe(false)
    } finally {
      await rm(link, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('terminates on a pattern that can match nothing', async () => {
    // `a*` matches the empty string at every position; without advancing
    // lastIndex the loop never ends.
    const out = await findInFiles({ root, query: 'x*', regex: true, maxMatches: 50 })
    expect(Array.isArray(out.matches)).toBe(true)
  })

  it('refuses a search with no root', async () => {
    await expect(findInFiles({ root: '', query: 'a' })).rejects.toThrow()
  })
})
