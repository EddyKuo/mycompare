import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { gzipSync, deflateSync } from 'zlib'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  ArchiveError,
  DEFAULT_LIMITS,
  sanitizeEntryPath,
  parseTar,
  gunzip,
  isGzip,
  isZip,
  detectFormat,
  readArchive,
  readArchiveEntry,
} from '../../src/main/archive.js'

// ---------------------------------------------------------------------------
// tar builders — the tests construct real tar bytes so the parser is exercised
// against the on-disk format, not a mock.
// ---------------------------------------------------------------------------

const BLOCK = 512

function writeOctal(buf, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0')
  buf.write(text + '\0', offset, 'ascii')
}

/**
 * @param {{name: string, type?: string, size?: number, mtime?: number,
 *          prefix?: string, badChecksum?: boolean}} opts
 */
function tarHeader(opts) {
  const h = Buffer.alloc(BLOCK)
  h.write(opts.name, 0, 100, 'utf8')
  writeOctal(h, 100, 8, 0o644)
  writeOctal(h, 108, 8, 0)
  writeOctal(h, 116, 8, 0)
  writeOctal(h, 124, 12, opts.size ?? 0)
  writeOctal(h, 136, 12, opts.mtime ?? 1700000000)
  h.write(opts.type ?? '0', 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  if (opts.prefix) h.write(opts.prefix, 345, 155, 'utf8')

  h.write('        ', 148, 8, 'ascii') // checksum field counts as spaces
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]
  if (opts.badChecksum) sum += 1
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return h
}

function pad(buf) {
  const rem = buf.length % BLOCK
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(BLOCK - rem)])
}

/** @param {Array<{name: string, content?: string, type?: string, prefix?: string, badChecksum?: boolean, mtime?: number}>} files */
function buildTar(files) {
  const parts = []
  for (const f of files) {
    const data = Buffer.from(f.content ?? '', 'utf8')
    parts.push(tarHeader({ ...f, size: f.type === '5' ? 0 : data.length }))
    if (f.type !== '5' && data.length) parts.push(pad(data))
  }
  parts.push(Buffer.alloc(BLOCK * 2)) // end-of-archive
  return Buffer.concat(parts)
}

/** GNU long-name ('L') record followed by the real header. */
function buildLongNameTar(longName, content) {
  const nameBuf = pad(Buffer.from(longName + '\0', 'utf8'))
  return Buffer.concat([
    tarHeader({ name: '././@LongLink', type: 'L', size: longName.length + 1 }),
    nameBuf,
    tarHeader({ name: longName.slice(0, 100), size: Buffer.byteLength(content) }),
    pad(Buffer.from(content, 'utf8')),
    Buffer.alloc(BLOCK * 2),
  ])
}

/** A tar whose header declares a huge size without carrying the bytes. */
function buildOversizeTar(size) {
  return Buffer.concat([tarHeader({ name: 'big.bin', size }), Buffer.alloc(BLOCK * 2)])
}

describe('sanitizeEntryPath', () => {
  it('normalises ./ prefixes and trailing slashes', () => {
    expect(sanitizeEntryPath('./src/a.js')).toBe('src/a.js')
    expect(sanitizeEntryPath('dir/sub/')).toBe('dir/sub')
    expect(sanitizeEntryPath('a//b')).toBe('a/b')
  })

  it.each([
    ['../etc/passwd'],
    ['a/../../b'],
    ['/etc/passwd'],
    ['C:\\Windows\\system32'],
    ['C:/Windows/system32'],
    ['dir\\..\\..\\evil'],
    ['a\0b'],
    ['/tmp/abs'],
    ['x::y'],
    [''],
    ['.'],
    ['./'],
  ])('rejects %j', (name) => {
    expect(() => sanitizeEntryPath(name)).toThrow(ArchiveError)
  })

  it('tags traversal rejections with a code', () => {
    try {
      sanitizeEntryPath('../etc/passwd')
    } catch (err) {
      expect(err.code).toBe('traversal')
    }
  })
})

describe('parseTar', () => {
  it('parses files and directory entries', () => {
    const tar = buildTar([
      { name: 'dir/', type: '5' },
      { name: 'dir/a.txt', content: 'hello' },
      { name: 'b.txt', content: 'world!!' },
    ])
    const entries = parseTar(tar)
    expect(entries.map((e) => e.path)).toEqual(['dir', 'dir/a.txt', 'b.txt'])
    expect(entries[0].isDirectory).toBe(true)
    expect(entries[1]).toMatchObject({ size: 5, isDirectory: false })
    expect(entries[2].size).toBe(7)
    expect(entries[1].mtime).toBe(new Date(1700000000 * 1000).toISOString())
  })

  it('exposes the data offset so content can be sliced back out', () => {
    const tar = buildTar([{ name: 'a.txt', content: 'hello' }])
    const [e] = parseTar(tar)
    expect(tar.toString('utf8', e.offset, e.offset + e.size)).toBe('hello')
  })

  it('joins the ustar prefix field for long paths', () => {
    const prefix = 'very/deep/nested/path'
    const tar = buildTar([{ name: 'file.txt', prefix, content: 'x' }])
    expect(parseTar(tar)[0].path).toBe(`${prefix}/file.txt`)
  })

  it('honours GNU long-name records', () => {
    const longName = 'a/'.repeat(60) + 'final-name-that-is-way-past-one-hundred-chars.txt'
    const entries = parseTar(buildLongNameTar(longName, 'content'))
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(longName)
    expect(entries[0].size).toBe(7)
  })

  it('honours PAX path records', () => {
    const paxPath = 'pax/dir/über-långt-namn.txt'
    const record = `${`  path=${paxPath}\n`.length + 2} path=${paxPath}\n`
    const payload = Buffer.from(record, 'utf8')
    const tar = Buffer.concat([
      tarHeader({ name: 'PaxHeaders/0', type: 'x', size: payload.length }),
      pad(payload),
      tarHeader({ name: 'short.txt', size: 3 }),
      pad(Buffer.from('abc')),
      Buffer.alloc(BLOCK * 2),
    ])
    expect(parseTar(tar)[0].path).toBe(paxPath)
  })

  it('skips symlink and device entries', () => {
    const tar = buildTar([
      { name: 'link', type: '2' },
      { name: 'real.txt', content: 'ok' },
    ])
    expect(parseTar(tar).map((e) => e.path)).toEqual(['real.txt'])
  })

  it('rejects an entry that escapes the archive root', () => {
    const tar = buildTar([{ name: '../etc/passwd', content: 'root:x:0:0' }])
    expect(() => parseTar(tar)).toThrow(/escapes the archive root/)
  })

  it('rejects an absolute entry name', () => {
    const tar = buildTar([{ name: '/etc/shadow', content: 'x' }])
    expect(() => parseTar(tar)).toThrow(/absolute/)
  })

  describe('corruption', () => {
    it('reports a bad header checksum instead of crashing', () => {
      const tar = buildTar([{ name: 'a.txt', content: 'x', badChecksum: true }])
      expect(() => parseTar(tar)).toThrow(/bad checksum/)
    })

    it('reports a truncated archive', () => {
      const tar = buildTar([{ name: 'a.txt', content: 'x'.repeat(2000) }])
      expect(() => parseTar(tar.subarray(0, BLOCK + 100))).toThrow(/Truncated/)
    })

    it('rejects a buffer that is too short to hold a header', () => {
      expect(() => parseTar(Buffer.alloc(16))).toThrow(/too short/)
    })

    it('rejects random bytes', () => {
      const junk = Buffer.alloc(BLOCK * 3, 0x41)
      expect(() => parseTar(junk)).toThrow(ArchiveError)
    })

    it('reports an empty archive (end marker only)', () => {
      expect(() => parseTar(Buffer.alloc(BLOCK * 2))).toThrow(/no entries/)
    })
  })

  describe('bomb limits', () => {
    it('aborts when an entry declares more than the per-entry cap', () => {
      const err = grab(() => parseTar(buildOversizeTar(10 * 1024 * 1024), { maxEntryBytes: 1024 }))
      expect(err.code).toBe('limit')
      expect(err.message).toMatch(/10485760 bytes, over the 1024 byte limit/)
    })

    it('aborts when the total uncompressed size exceeds the cap', () => {
      const tar = buildTar([
        { name: 'a.txt', content: 'x'.repeat(600) },
        { name: 'b.txt', content: 'y'.repeat(600) },
      ])
      const err = grab(() => parseTar(tar, { maxTotalBytes: 1000 }))
      expect(err.code).toBe('limit')
      expect(err.message).toMatch(/more than the 1000 byte limit/)
    })

    it('aborts when there are too many entries', () => {
      const tar = buildTar(
        Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, content: 'x' })),
      )
      const err = grab(() => parseTar(tar, { maxEntries: 3 }))
      expect(err.code).toBe('limit')
      expect(err.message).toMatch(/more than 3 entries/)
    })

    it('counts directories towards the entry cap but not the byte cap', () => {
      const tar = buildTar([
        { name: 'd/', type: '5' },
        { name: 'd/a.txt', content: 'xyz' },
      ])
      expect(parseTar(tar, { maxTotalBytes: 3 })).toHaveLength(2)
    })
  })
})

describe('gunzip', () => {
  it('round-trips a gzip member', () => {
    const raw = Buffer.from('the quick brown fox'.repeat(50))
    expect(gunzip(gzipSync(raw)).equals(raw)).toBe(true)
  })

  it('rejects a non-gzip buffer by magic number', () => {
    const err = grab(() => gunzip(Buffer.from('not gzip at all')))
    expect(err.code).toBe('corrupt')
  })

  it('rejects a deflate stream that lacks the gzip wrapper', () => {
    expect(() => gunzip(deflateSync(Buffer.from('abc')))).toThrow(/bad magic/)
  })

  it('reports corruption rather than crashing on a damaged stream', () => {
    // Incompressible input keeps the deflate stream long enough that the
    // damaged bytes land inside it rather than past the end.
    const noise = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + (i % 251)) & 0xff))
    const bad = gzipSync(noise)
    bad[Math.floor(bad.length / 2)] ^= 0xff
    bad[Math.floor(bad.length / 2) + 1] ^= 0xff
    const err = grab(() => gunzip(bad))
    expect(err).toBeInstanceOf(ArchiveError)
    expect(['corrupt', 'limit']).toContain(err.code)
  })

  it('aborts a stream that inflates past the cap (compression bomb)', () => {
    // 1 MiB of zeros compresses to about a kilobyte — the classic ratio attack.
    const bomb = gzipSync(Buffer.alloc(1024 * 1024))
    expect(bomb.length).toBeLessThan(10 * 1024)
    const err = grab(() => gunzip(bomb, 4096))
    expect(err.code).toBe('limit')
  })

  it('detects magic numbers', () => {
    expect(isGzip(gzipSync(Buffer.from('a')))).toBe(true)
    expect(isGzip(Buffer.from('PK\x03\x04'))).toBe(false)
    expect(isZip(Buffer.from('PK\x03\x04'))).toBe(true)
    expect(isZip(gzipSync(Buffer.from('a')))).toBe(false)
  })
})

describe('detectFormat', () => {
  it('recognises tar, gzip and tar.gz', () => {
    const tar = buildTar([{ name: 'a.txt', content: 'x' }])
    expect(detectFormat('/x/a.tar', tar)).toBe('tar')
    expect(detectFormat('/x/a.gz', gzipSync(Buffer.from('plain')))).toBe('gzip')
    expect(detectFormat('/x/a.tar.gz', gzipSync(tar))).toBe('tar.gz')
    expect(detectFormat('/x/a.tgz', gzipSync(tar))).toBe('tar.gz')
  })

  it('recognises the zip family by content, whatever the extension', () => {
    const zipMagic = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(30)])
    for (const name of ['a.zip', 'a.jar', 'a.war', 'a.ear', 'weird.bin']) {
      expect(detectFormat(`/x/${name}`, zipMagic)).toBe('zip')
    }
  })

  it('recognises bzip2, which src/main/bzip2.js now decodes in-tree', () => {
    const bz = Buffer.from('BZh91AY&SY')
    expect(detectFormat('/x/a.bin', bz)).toBe('bzip2')
    expect(detectFormat('/x/a.bz2', bz)).toBe('bzip2')
    for (const name of ['a.tbz', 'a.tbz2', 'a.tar.bz2']) {
      expect(detectFormat(`/x/${name}`, bz)).toBe('tar.bz2')
    }
  })

  it('recognises xz by content, and tar.xz by extension', () => {
    const xz = Buffer.from('fd377a585a0000', 'hex')
    expect(detectFormat('/x/a.bin', xz)).toBe('xz')
    expect(detectFormat('/x/a.xz', xz)).toBe('xz')
    for (const name of ['a.txz', 'a.tar.xz']) {
      expect(detectFormat(`/x/${name}`, xz)).toBe('tar.xz')
    }
  })

  it.each([
    ['7z', Buffer.from('377abcaf271c0004', 'hex')],
    ['rar', Buffer.from('Rar!\x1a\x07\x00')],
  ])('reports %s as unsupported', (_label, buf) => {
    // These need a decoder Node does not ship and that would take a
    // dependency; saying so beats failing as "unrecognised".
    const err = grab(() => detectFormat('/x/a.bin', buf))
    expect(err.code).toBe('unsupported')
  })

  it('reports unknown content as unsupported', () => {
    const err = grab(() => detectFormat('/x/a.bin', Buffer.alloc(600, 0x41)))
    expect(err.code).toBe('unsupported')
  })
})

describe('readArchive / readArchiveEntry', () => {
  /** @type {string} */
  let dir

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mycompare-archive-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** @param {string} name @param {Buffer} buf @returns {string} */
  function put(name, buf) {
    const p = join(dir, name)
    writeFileSync(p, buf)
    return p
  }

  const sample = () =>
    buildTar([
      { name: 'proj/', type: '5' },
      { name: 'proj/a.txt', content: 'alpha' },
      { name: 'proj/b.txt', content: 'beta' },
    ])

  it('lists a tar with archivePath::relative paths', async () => {
    const p = put('s.tar', sample())
    const listing = await readArchive(p)
    expect(listing.format).toBe('tar')
    expect(listing.archivePath).toBe(p)
    expect(listing.entries.map((e) => e.path)).toEqual([
      `${p}::proj`,
      `${p}::proj/a.txt`,
      `${p}::proj/b.txt`,
    ])
    expect(Object.keys(listing.entries[1]).sort()).toEqual([
      'isDirectory',
      'mtime',
      'path',
      'size',
    ])
  })

  it('lists a tar.gz with the same shape', async () => {
    const p = put('s.tgz', gzipSync(sample()))
    const listing = await readArchive(p)
    expect(listing.format).toBe('tar.gz')
    expect(listing.entries).toHaveLength(3)
    expect(listing.entries[2].size).toBe(4)
  })

  it('treats a plain .gz as a single-entry archive named after the container', async () => {
    const p = put('notes.txt.gz', gzipSync(Buffer.from('hello gzip')))
    const listing = await readArchive(p)
    expect(listing.format).toBe('gzip')
    expect(listing.entries).toEqual([
      { path: `${p}::notes.txt`, size: 10, mtime: new Date(0).toISOString(), isDirectory: false },
    ])
  })

  it('reads entry content from tar and tar.gz', async () => {
    const tarPath = put('r.tar', sample())
    const tgzPath = put('r.tar.gz', gzipSync(sample()))
    expect((await readArchiveEntry(tarPath, 'proj/a.txt')).toString()).toBe('alpha')
    expect((await readArchiveEntry(tgzPath, 'proj/b.txt')).toString()).toBe('beta')
  })

  it('accepts the archivePath:: prefixed form of an entry path', async () => {
    const p = put('pfx.tar', sample())
    expect((await readArchiveEntry(p, `${p}::proj/a.txt`)).toString()).toBe('alpha')
  })

  it('reads a plain .gz entry', async () => {
    const p = put('single.bin.gz', gzipSync(Buffer.from([1, 2, 3, 4])))
    expect([...(await readArchiveEntry(p, 'single.bin'))]).toEqual([1, 2, 3, 4])
  })

  it('rejects a traversing entry path at read time', async () => {
    const p = put('t.tar', sample())
    await expect(readArchiveEntry(p, '../../../etc/passwd')).rejects.toThrow(/escapes/)
    await expect(readArchiveEntry(p, 'C:\\Windows\\win.ini')).rejects.toThrow(ArchiveError)
    await expect(readArchiveEntry(p, '/etc/passwd')).rejects.toThrow(/absolute/)
  })

  it('reports a missing entry', async () => {
    const p = put('m.tar', sample())
    const err = await grabAsync(() => readArchiveEntry(p, 'proj/nope.txt'))
    expect(err.code).toBe('notfound')
  })

  it('propagates limit errors from a listing', async () => {
    const p = put('lim.tar', sample())
    const err = await grabAsync(() => readArchive(p, { maxTotalBytes: 4 }))
    expect(err.code).toBe('limit')
  })

  it('refuses an unsupported container', async () => {
    // RAR is the remaining one: proprietary, with no specification anyone may
    // reimplement, so it can only ever be reported by name.
    const p = put('x.rar', Buffer.concat([
      Buffer.from('526172211a0700', 'hex'), Buffer.alloc(64),
    ]))
    const err = await grabAsync(() => readArchive(p))
    expect(err.code).toBe('unsupported')
    expect(err.message).toMatch(/RAR/i)
  })

  it('treats a damaged bzip2 payload as corrupt, not unsupported', async () => {
    // Valid stream header and block magic, then garbage — now that bzip2 is
    // decoded in-tree this is a broken file of a known format, not an
    // unreadable one.
    const p = put('x.bz2', Buffer.from('BZh91AY&SY-not-really'))
    const err = await grabAsync(() => readArchive(p))
    expect(err).toBeInstanceOf(ArchiveError)
    expect(err.code).toBe('corrupt')
  })

  it('reports a corrupt archive rather than throwing something opaque', async () => {
    const broken = sample()
    broken[10] ^= 0xff // damage the first header's name → checksum mismatch
    const p = put('broken.tar', broken)
    const err = await grabAsync(() => readArchive(p))
    expect(err).toBeInstanceOf(ArchiveError)
    expect(err.code).toBe('corrupt')
  })

  it('lists and reads a zip through the same interface', async () => {
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    zip.folder('pkg').file('one.txt', 'ONE')
    zip.file('root.txt', 'ROOT')
    const p = put('s.zip', await zip.generateAsync({ type: 'nodebuffer' }))

    const listing = await readArchive(p)
    expect(listing.format).toBe('zip')
    expect(listing.entries.map((e) => e.path).sort()).toEqual(
      [`${p}::pkg`, `${p}::pkg/one.txt`, `${p}::root.txt`].sort(),
    )
    expect((await readArchiveEntry(p, 'pkg/one.txt')).toString()).toBe('ONE')
  })

  it('rejects a zip carrying a traversing entry name (Zip Slip)', async () => {
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    zip.file('../../evil.sh', 'rm -rf /')
    const p = put('slip.zip', await zip.generateAsync({ type: 'nodebuffer' }))
    const err = await grabAsync(() => readArchive(p))
    expect(err.code).toBe('traversal')
  })

  it('ships sane default caps', () => {
    expect(DEFAULT_LIMITS.maxEntryBytes).toBeLessThanOrEqual(DEFAULT_LIMITS.maxTotalBytes)
    expect(DEFAULT_LIMITS.maxEntries).toBeGreaterThan(0)
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true)
  })
})

/** @param {() => unknown} fn @returns {ArchiveError} */
function grab(fn) {
  try {
    fn()
  } catch (err) {
    return /** @type {ArchiveError} */ (err)
  }
  throw new Error('expected the call to throw')
}

/** @param {() => Promise<unknown>} fn @returns {Promise<ArchiveError>} */
async function grabAsync(fn) {
  try {
    await fn()
  } catch (err) {
    return /** @type {ArchiveError} */ (err)
  }
  throw new Error('expected the call to reject')
}

// ── xz containers ───────────────────────────────────────────────────────────
//
// Fixtures are real streams from Python's stdlib (tarfile + lzma), embedded as
// base64 so the tests stay self-contained:
//   python -c "import tarfile,lzma,io,base64; ..."

describe('xz archives', () => {
  /** @type {string} */
  let xzDir

  // tar containing a.txt='alpha' and dir/b.txt='beta'*100
  const TARXZ = Buffer.from(
    '/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AHxdADCLiofEDvKXpPh1PcWp7dmXqh+bSp6krW04vBYHqqCPKVTvjXvM/CinOmbCwa2KjyRtTomSv/XOf6SLcIKC+BMk4NmUZh09s3RYXDdcFhWWehP/CJRINNF17FOq/GYKh/0wTsvIs25455OR18xVr6Ryn3wb03NHkv2RzgAA8ET6i40tQP8AAZgBgFAAAMjx5Y6xxGf7AgAAAAAEWVo=',
    'base64')
  // b'just one file'
  const SOLO = Buffer.from(
    '/Td6WFoAAATm1rRGAgAhARYAAAB0L+WjAQAManVzdCBvbmUgZmlsZQAAAADiPo6+mk+nOQABJQ1xGcS2H7bzfQEAAAAABFla',
    'base64')

  beforeAll(() => {
    xzDir = mkdtempSync(join(tmpdir(), 'mycompare-xz-'))
  })

  afterAll(() => {
    rmSync(xzDir, { recursive: true, force: true })
  })

  /** @param {string} name @param {Buffer} data */
  const write = (name, data) => {
    const p = join(xzDir, name)
    writeFileSync(p, data)
    return p
  }

  it('lists a tar.xz', async () => {
    const p = write('sample.tar.xz', TARXZ)
    const { format, entries } = await readArchive(p)
    expect(format).toBe('tar.xz')
    const names = entries.map((e) => e.path.split('::')[1]).sort()
    expect(names).toContain('a.txt')
    expect(names).toContain('dir/b.txt')
  })

  it('reads an entry out of a tar.xz', async () => {
    const p = write('sample2.tar.xz', TARXZ)
    expect((await readArchiveEntry(p, 'a.txt')).toString()).toBe('alpha')
    expect((await readArchiveEntry(p, 'dir/b.txt')).toString())
      .toBe('beta'.repeat(100))
  })

  it('exposes a lone .xz as a single member named after the file', async () => {
    const p = write('solo.xz', SOLO)
    const { format, entries } = await readArchive(p)
    expect(format).toBe('xz')
    expect(entries).toHaveLength(1)
    expect(entries[0].path.endsWith('::solo')).toBe(true)
    expect((await readArchiveEntry(p, 'solo')).toString()).toBe('just one file')
  })

  it('still refuses a traversing entry name', async () => {
    const p = write('trav.tar.xz', TARXZ)
    const err = await grabAsync(() => readArchiveEntry(p, '../escape'))
    expect(err.code).toBe('traversal')
  })

  it('reports a missing entry', async () => {
    const p = write('missing.tar.xz', TARXZ)
    const err = await grabAsync(() => readArchiveEntry(p, 'nope.txt'))
    expect(err.code).toBe('notfound')
  })

  it('enforces the total size limit', async () => {
    const p = write('limit.tar.xz', TARXZ)
    const err = await grabAsync(() => readArchive(p, { maxTotalBytes: 8 }))
    expect(err.code).toBe('limit')
  })

  it('reports a corrupt xz rather than returning garbage', async () => {
    const bad = Buffer.from(TARXZ)
    bad[40] ^= 0xff
    const p = write('bad.tar.xz', bad)
    const err = await grabAsync(() => readArchive(p))
    expect(['corrupt', 'limit']).toContain(err.code)
  })
})

// ── 7z ──────────────────────────────────────────────────────────────────────

describe('7z archives', () => {
  /** @type {string} */
  let szDir

  // py7zr defaults: BCJ (x86) chained into LZMA2.
  // { 'a.txt': b'alpha', 'dir/b.txt': b'beta'*10 }
  const SEVENZ = Buffer.from('N3q8ryccAASTGdj5hQAAAAAAAAAUAAAAAAAAAOLkB/PgACwADl0AMJsKZySQyTQ/qfeDeAAA4AB4AGddAACBMweuD89dLwwHsMPaKtdYZKyzeM5U3dvYYcn8sT+oiYa8+2ZJHY8wMx5YUZ1l9ifkTB/N+KP5iXjXIVeR5iEVGehm3ss/DFKfyxCUq8S8j4kJ3kp4Ncw2bvJoS1HKfRRGT60AAAAAFwYWAQlvAAcLAQABISEBGAx5AAA=', 'base64')

  beforeAll(() => { szDir = mkdtempSync(join(tmpdir(), 'mycompare-7z-')) })
  afterAll(() => { rmSync(szDir, { recursive: true, force: true }) })

  /** @param {string} name @param {Buffer} data */
  const write = (name, data) => {
    const p = join(szDir, name)
    writeFileSync(p, data)
    return p
  }

  it('lists a 7z archive', async () => {
    const p = write('a.7z', SEVENZ)
    const { format, entries } = await readArchive(p)
    expect(format).toBe('7z')
    expect(entries.map((e) => e.path.split('::')[1]).sort())
      .toEqual(['a.txt', 'dir/b.txt'])
  })

  it('reads entries out of a 7z archive', async () => {
    const p = write('b.7z', SEVENZ)
    expect((await readArchiveEntry(p, 'a.txt')).toString()).toBe('alpha')
    expect((await readArchiveEntry(p, 'dir/b.txt')).toString()).toBe('beta'.repeat(10))
  })

  it('reports a missing entry', async () => {
    const p = write('c.7z', SEVENZ)
    const err = await grabAsync(() => readArchiveEntry(p, 'nope.txt'))
    expect(err.code).toBe('notfound')
  })

  it('refuses a traversing entry name', async () => {
    const p = write('d.7z', SEVENZ)
    const err = await grabAsync(() => readArchiveEntry(p, '../escape'))
    expect(err.code).toBe('traversal')
  })

  it('enforces the size ceiling', async () => {
    const p = write('e.7z', SEVENZ)
    const err = await grabAsync(() => readArchive(p, { maxTotalBytes: 8 }))
    expect(err.code).toBe('limit')
  })

  it('reports a damaged header rather than returning garbage', async () => {
    // Byte 100 sits in the compressed header, so the damage breaks the decode.
    // Corruption inside a packed data stream is a different matter: the CRCs
    // that would catch it are read but not verified.
    const bad = Buffer.from(SEVENZ)
    bad[100] ^= 0xff
    const p = write('f.7z', bad)
    const err = await grabAsync(() => readArchive(p))
    expect(['corrupt', 'limit', 'unsupported']).toContain(err.code)
  })
})
