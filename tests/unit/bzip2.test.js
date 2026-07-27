import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { bunzip2, isBzip2, Bzip2Error, DEFAULT_MAX_OUTPUT } from '../../src/main/bzip2.js'
import { ArchiveError, detectFormat, readArchive, readArchiveEntry } from '../../src/main/archive.js'

// ---------------------------------------------------------------------------
// Fixtures
//
// Every constant below is a real bzip2 stream produced by a reference
// compressor from the plaintext named beside it, then round-tripped back
// through CPython's `bz2.decompress` to confirm the bytes really do decode to
// that plaintext. They are embedded rather than generated at test time because
// this project has no bzip2 encoder — neither in Node nor as a dependency —
// so a generated fixture would only ever be this decoder checking its own
// homework.
//
// Reproduce any of them with:
//   python -c "import bz2,base64; print(base64.b64encode(bz2.compress(DATA, 9)).decode())"
// (`bz2.compress(data, 9)` and `bzip2 -9` emit identical streams; the level-1
// fixture notes its own switch.)
// ---------------------------------------------------------------------------

/** @param {string} b64 @returns {Buffer} */
const fx = (b64) => Buffer.from(b64, 'base64')

/** `b'hello world'` — the smallest stream with a real Huffman table. */
const HELLO_BZ2 = fx('QlpoOTFBWSZTWUT3E3gAAAGRgEAABkSQgCAAIgM0hDAhtoFUJ4u5IpwoSCJ7ibwA')
const HELLO = Buffer.from('hello world')

/** `b''` — header plus end-of-stream marker only, no block at all. */
const EMPTY_BZ2 = fx('QlpoORdyRThQkAAAAAA=')

/**
 * `b'a' * 10 + b'b' + b'c' * 300` — straddles both RLE1 boundaries: a run just
 * over the 4-byte trigger, and one past the 259-byte maximum a single
 * (4 bytes + count) pair can express, so it must split into two pairs.
 */
const RLE_BZ2 = fx('QlpoOTFBWSZTWQ3gQbgAAALRAIEAACA4AAAIIAAhk2iDAJeYD2iXi7kinChIBvAg3AA=')
const RLE = Buffer.concat([Buffer.alloc(10, 0x61), Buffer.from('b'), Buffer.alloc(300, 0x63)])

/** `b'x' + b'a' * 300 + b'y'` — the same overflow with the run bracketed. */
const RUN_BZ2 = fx('QlpoOTFBWSZTWeZQ0q8AAASRgIAgIAAAYAAIIAAwzQDBpEjVheLuSKcKEhzKGlXg')
const RUN = Buffer.concat([Buffer.from('x'), Buffer.alloc(300, 0x61), Buffer.from('y')])

/** `bytes(range(256)) * 8` — every byte value, so all 16 symbol-map groups are used. */
const BINARY_BZ2 = fx(
  'QlpoOTFBWSZTWbq+0ZsAAAP/////////////////////////////////////////////wAK8AAAJMABMAATAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAABJgAJgACYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJMABMAATAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAKqqgJgJgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH9EBECEDEEEFH/CDCDiECEiFCFiGD/xDRDhDxEBEREhExFBFRFhFx' +
  'GBGRGhGxHBHRHhHxIBIRIhIxJBJRJhJxKBKRKhKxLBLRLhLxMBMRMhMxNBNRNhNxOBOROhOxPBPRPhPxQBQRQhQxRBRRRhRxSBSRShSx' +
  'TBTRThTxUBURUhUxVBVRVhVxWBWRWhWxXBXRXhXxYBYRYhYxZBZRZhZxaBaRahaxbBbRbhbxcBcRchcxdBdRdhdxeBeRehexfBfRfhfx' +
  'gBgRghgxhBhRhhhxiBiRihixjBjRjhjxkBkRkhkxlBlRlhlxmBmRmhmxnBnRnhnxoBoRohoxpBpRphpxqBqRqhqxrBrRrhrxsBsRshsx' +
  'tBtRthtxuBuRuhuxvBvRvhvxwBwRwhwxxBxRxhxxyByRyhyxzBzRzhzx0B0R0h0x1B1R1h1x2B2R2h2x3B3R3h3x4B4R4h4x5B5R5h5x' +
  '6B6R6h6x7B7R7h7x8B8R8h8x9B9R9h9x+B+R+h+x/B/R/hdyRThQkLq+0Zs=',
)
const BINARY = Buffer.concat(Array(8).fill(Buffer.from(Array.from({ length: 256 }, (_, i) => i))))

/** `b'The quick brown fox jumps over the lazy dog.\n' * 50`. */
const TEXT_BZ2 = fx(
  'QlpoOTFBWSZTWWPMRrwAARLTgAAQQAEEAD////AwANgFAAAAACgAAAAAUqhQaBphNNo2ozRb0WEXJFhF9otUWSLVFwRfCL+RfSLmiyRc' +
  'yLZFmi6ou6Lii2ReiLoiyRZosIuqLRFvRaou6LRFxRdkWyLRFhFhF+qR4ReEXkXckU4UJBjzEa8A',
)
const TEXT = Buffer.from('The quick brown fox jumps over the lazy dog.\n'.repeat(50))

/**
 * A 467 997-byte plaintext compressed with `bzip2 -1`, i.e. 100 kB blocks.
 * The plaintext has no repeated runs for RLE1 to collapse, so it necessarily
 * spans five blocks — the case a single-block decoder silently truncates.
 */
const MULTI_BZ2 = fx(
  'QlpoMTFBWSZTWfoyV18AQRfRgAAQQAA258wQMAFwAFDTTAAJqkkDTIaFDTTABpJVK4QoykRLCFGRCj8hRvBRzBRqgo1QUZUFGqCjJCjx' +
  'QUeEKOOJES2oKNoKMoKMgo9yIlqCjWIUYhR0hRxIiWSFG1BRtBR+kRLpREvVREuZES+yIlzIiWpES6qIl1KIl2URLyoiWIUagoyREsoK' +
  'MkKN5CjdCj+YoKyTKayATxUbAD16aMAACCAAG3PmCBgAuAAoaaYABNUUo0ekxlChppgA1JVK/oKMlESwhRlQUdQUcwUeoKNIUbQUZEKN' +
  'oKMoKPFBR4go8yIltBRoKMkKMQo5qIlpCjUKO4KPMiJZQUcUFHEFHUiJd1ES9/CFHWIUfJES4EiXuREtkRLtREvsoiX1URL8qIlkFGoU' +
  'ZIiWSFGUFHNBRzBR/mKCskymsj69TeoBcNijAAAggABtz5ggYALgAKGmmAATVIoJ5T1M1ChppgA1SVSv2CjCiJZQUZEKPsFHEFHSFGiF' +
  'GqCjBCjUhRlBR6oKPUFHIkS3uQo3BRiCjEKOFES1QUago7go5qIllBRm5CjaFH2REu5ES+SIl1IiXxREuhIloSJdyIl3SIl4kRL3IiWQ' +
  'UagoyoiWQUeMQo0go4oKOIKP8xQVkmU1l2KH10ABBFUYAAEEAANufMEDABcABQ00wACaoqTI9GhqFDTTABqSqV6gowSJbiiJbQUZUFH2' +
  'CjhCjmCjaCjZCjIhRtBRlBR4kKPCFHmREtIUahRlBRkFHEiJbQUbBR1BR5qIllBR2oKO0FH0SJdSIl8kRLkSJfJES5kRLZES6kRLpURL' +
  '8kRL9kRLIKNgoyoiWUFGUFHFBRxBR/mKCskyms5XrZYIAWKajAAAggABtz5ggYAK2AChppgAE1RUmR6NDUClSCaMJjIJC4UqMCKVgpUY' +
  'EhX0QrgQrmIVtEK2EKyRCtohWUQrxCFeBCvMqI2EK0QrKIVkQriVEbRCtiFdRCvKURlEK7UQrtEK+pRHUqI+SojlKI+SojmVEbKiOpUR' +
  '0KiPyVEfsqIwQrYhWUojKIVlEK4ohXEQr/F3JFOFCQ/Av3sg',
)

/** Regenerates the plaintext behind {@link MULTI_BZ2}. */
function multiPlaintext() {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
  const parts = []
  for (let i = 0; i < 26000; i++) {
    parts.push(`${words[i % 6]} ${words[(i * 7) % 6]} ${words[(i * 13) % 6]}\n`)
  }
  return Buffer.from(parts.join(''))
}

/**
 * `tar -cf pkg.tar pkg && bzip2 -9` over a two-file tree:
 *   pkg/readme.txt   -> "hello from tar.bz2\n"
 *   pkg/sub/deep.txt -> "nested\n"
 */
const PKG_TAR_BZ2 = fx(
  'QlpoOTFBWSZTWW6QPVcAAO3/gcOQCABAAf+AAgBQRHfP3nAAEIAIMADYUNSMQ0AAA0NAaaAxpoNADJoDI00MTRgVREQn6UNoCAaZA0NP' +
  'Uy5rMGK79JtJETniEQx16qajYSbFmK+/rNZYiFDq863HMofXzXny5e8zGhgI4cOPHsNxOY3lIrQoNRdDcTEX7S8rWTb07j00FloToz5l' +
  '5cuNKq8qXlGFhNzBU4GbMAYEJRkQMCi6gK3yASlBeXu6VgfKAOzZBywHWbKdMMem0z1ZMjGd6WRuYn54EH+LuSKcKEg3SB6rgA==',
)

/**
 * @param {() => unknown} fn
 * @returns {Error}
 */
function grab(fn) {
  try {
    fn()
  } catch (err) {
    return /** @type {Error} */ (err)
  }
  throw new Error('expected the call to throw, but it returned')
}

/**
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<Error>}
 */
async function grabAsync(fn) {
  try {
    await fn()
  } catch (err) {
    return /** @type {Error} */ (err)
  }
  throw new Error('expected the call to reject, but it resolved')
}

// ---------------------------------------------------------------------------

describe('isBzip2', () => {
  it('accepts a well-formed stream header at every compression level', () => {
    for (let level = 1; level <= 9; level++) {
      expect(isBzip2(Buffer.from(`BZh${level}xyz`))).toBe(true)
    }
    expect(isBzip2(HELLO_BZ2)).toBe(true)
  })

  it('rejects near-misses', () => {
    expect(isBzip2(Buffer.from('BZh0abc'))).toBe(false) // level 0 is not legal
    expect(isBzip2(Buffer.from('BZhAabc'))).toBe(false)
    expect(isBzip2(Buffer.from('BZ'))).toBe(false)
    expect(isBzip2(Buffer.alloc(0))).toBe(false)
    expect(isBzip2(Buffer.from('\x1f\x8b\x08\x00'))).toBe(false) // gzip
    expect(isBzip2('BZh9')).toBe(false)
  })
})

describe('bunzip2 — valid streams', () => {
  it('decodes a single-block stream byte for byte', () => {
    expect(bunzip2(HELLO_BZ2).equals(HELLO)).toBe(true)
  })

  it('decodes a stream that carries no block at all', () => {
    const out = bunzip2(EMPTY_BZ2)
    expect(out.length).toBe(0)
    expect(out.equals(Buffer.alloc(0))).toBe(true)
  })

  it('undoes RLE1 runs on both sides of the 259-byte pair limit', () => {
    expect(bunzip2(RLE_BZ2).equals(RLE)).toBe(true)
    expect(bunzip2(RUN_BZ2).equals(RUN)).toBe(true)
  })

  it('handles a block that uses all 256 byte values', () => {
    const out = bunzip2(BINARY_BZ2)
    expect(out.length).toBe(2048)
    expect(out.equals(BINARY)).toBe(true)
  })

  it('decodes repetitive text', () => {
    expect(bunzip2(TEXT_BZ2).equals(TEXT)).toBe(true)
  })

  it('decodes every block of a five-block stream', () => {
    const expected = multiPlaintext()
    expect(expected.length).toBe(467997)
    expect(bunzip2(MULTI_BZ2).equals(expected)).toBe(true)
  })

  it('walks concatenated streams', () => {
    const joined = Buffer.concat([HELLO_BZ2, HELLO_BZ2, EMPTY_BZ2, HELLO_BZ2])
    expect(bunzip2(joined).toString()).toBe('hello worldhello worldhello world')
  })

  it('accepts a plain Uint8Array as well as a Buffer', () => {
    const out = bunzip2(new Uint8Array(HELLO_BZ2))
    expect(Buffer.from(out).equals(HELLO)).toBe(true)
  })

  it('exposes a sane default cap', () => {
    expect(DEFAULT_MAX_OUTPUT).toBeGreaterThan(0)
    expect(bunzip2(HELLO_BZ2, DEFAULT_MAX_OUTPUT).equals(HELLO)).toBe(true)
  })
})

describe('bunzip2 — malformed input', () => {
  it('rejects a non-buffer', () => {
    const err = grab(() => bunzip2(/** @type {never} */ ('BZh9')))
    expect(err).toBeInstanceOf(Bzip2Error)
    expect(/** @type {Bzip2Error} */ (err).code).toBe('corrupt')
  })

  it('rejects an empty buffer', () => {
    expect(/** @type {Bzip2Error} */ (grab(() => bunzip2(Buffer.alloc(0)))).code).toBe('corrupt')
  })

  it('rejects a bad magic number', () => {
    const err = grab(() => bunzip2(Buffer.from('NOTBZIP2DATAHERE')))
    expect(/** @type {Bzip2Error} */ (err).code).toBe('corrupt')
    expect(err.message).toMatch(/magic/i)
  })

  it('rejects an out-of-range compression level', () => {
    expect(/** @type {Bzip2Error} */ (grab(() => bunzip2(Buffer.from('BZh0abcdefgh')))).code).toBe('corrupt')
  })

  it('rejects a corrupt block magic', () => {
    const bad = Buffer.from(HELLO_BZ2)
    bad[5] ^= 0xff // inside the 48-bit block magic, which is byte-aligned here
    const err = grab(() => bunzip2(bad))
    expect(/** @type {Bzip2Error} */ (err).code).toBe('corrupt')
    expect(err.message).toMatch(/block magic/i)
  })

  it.each([1, 6, 12, 20, 30, 40, 47])('rejects a stream truncated to %i bytes', (len) => {
    const err = grab(() => bunzip2(HELLO_BZ2.subarray(0, len)))
    expect(err).toBeInstanceOf(Bzip2Error)
    expect(/** @type {Bzip2Error} */ (err).code).toBe('corrupt')
  })

  it('detects a block CRC mismatch', () => {
    // Layout of HELLO_BZ2: 'BZh9' | 48-bit block magic | 32-bit block CRC,
    // all byte-aligned, so byte 10 is the top byte of the block CRC.
    const bad = Buffer.from(HELLO_BZ2)
    bad[10] ^= 0xff
    const err = grab(() => bunzip2(bad))
    expect(/** @type {Bzip2Error} */ (err).code).toBe('corrupt')
    expect(err.message).toMatch(/block CRC mismatch/)
  })

  it('detects a stream CRC mismatch', () => {
    // EMPTY_BZ2 is 'BZh9' | 48-bit end-of-stream magic | 32-bit combined CRC.
    const bad = Buffer.from(EMPTY_BZ2)
    expect(bad.length).toBe(14)
    bad[13] ^= 0x01
    const err = grab(() => bunzip2(bad))
    expect(/** @type {Bzip2Error} */ (err).code).toBe('corrupt')
    expect(err.message).toMatch(/stream CRC mismatch/)
  })

  it('reports deprecated randomised blocks as unsupported, not corrupt', () => {
    // The randomised flag is the single bit following the block CRC, i.e. the
    // top bit of byte 14.
    const randomised = Buffer.from(HELLO_BZ2)
    randomised[14] |= 0x80
    const err = grab(() => bunzip2(randomised))
    expect(/** @type {Bzip2Error} */ (err).code).toBe('unsupported')
    expect(err.message).toMatch(/randomised/i)
  })

  it('never hangs or throws a foreign error on single-bit corruption', () => {
    for (const fixture of [HELLO_BZ2, RLE_BZ2, TEXT_BZ2]) {
      for (let byte = 4; byte < fixture.length; byte++) {
        for (const mask of [0x01, 0x10, 0x80]) {
          const damaged = Buffer.from(fixture)
          damaged[byte] ^= mask
          try {
            bunzip2(damaged, 8 * 1024 * 1024)
          } catch (err) {
            // The point of the sweep: no RangeError, no TypeError, no
            // out-of-memory — corruption always surfaces as a typed error.
            expect(err).toBeInstanceOf(Bzip2Error)
          }
        }
      }
    }
  })
})

describe('bunzip2 — output limits', () => {
  it('allows output that exactly reaches the cap', () => {
    expect(bunzip2(HELLO_BZ2, HELLO.length).equals(HELLO)).toBe(true)
  })

  it('aborts one byte before the cap is exceeded', () => {
    const err = grab(() => bunzip2(HELLO_BZ2, HELLO.length - 1))
    expect(/** @type {Bzip2Error} */ (err).code).toBe('limit')
    expect(err.message).toMatch(/limit/)
  })

  it('stops a multi-block stream partway rather than after the fact', () => {
    const err = grab(() => bunzip2(MULTI_BZ2, 1000))
    expect(/** @type {Bzip2Error} */ (err).code).toBe('limit')
  })

  it('caps RLE1 expansion, which is where a bzip2 bomb does its work', () => {
    const err = grab(() => bunzip2(RUN_BZ2, 50))
    expect(/** @type {Bzip2Error} */ (err).code).toBe('limit')
  })

  it('accepts a zero cap only for a stream with no output', () => {
    expect(bunzip2(EMPTY_BZ2, 0).length).toBe(0)
    expect(/** @type {Bzip2Error} */ (grab(() => bunzip2(HELLO_BZ2, 0))).code).toBe('limit')
  })

  it('rejects a nonsensical cap', () => {
    expect(/** @type {Bzip2Error} */ (grab(() => bunzip2(HELLO_BZ2, -1))).code).toBe('limit')
    expect(/** @type {Bzip2Error} */ (grab(() => bunzip2(HELLO_BZ2, NaN))).code).toBe('limit')
  })
})

describe('archive.js integration', () => {
  /** @type {string} */
  let dir

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mycompare-bzip2-'))
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

  it('routes the tarball extensions to tar.bz2 and everything else to bzip2', () => {
    for (const name of ['a.tar.bz2', 'a.tbz', 'a.tbz2', 'A.TBZ2']) {
      expect(detectFormat(`/x/${name}`, PKG_TAR_BZ2)).toBe('tar.bz2')
    }
    for (const name of ['a.bz2', 'a.bz', 'notes.txt.bz2']) {
      expect(detectFormat(`/x/${name}`, HELLO_BZ2)).toBe('bzip2')
    }
  })

  it('lists a .tar.bz2 as a folder tree', async () => {
    const p = put('pkg.tar.bz2', PKG_TAR_BZ2)
    const listing = await readArchive(p)
    expect(listing.format).toBe('tar.bz2')
    const names = listing.entries.map((e) => e.path.slice(p.length + 2)).sort()
    expect(names).toEqual(['pkg', 'pkg/readme.txt', 'pkg/sub', 'pkg/sub/deep.txt'])
  })

  it('reads one entry out of a .tar.bz2', async () => {
    const p = put('pkg2.tar.bz2', PKG_TAR_BZ2)
    expect((await readArchiveEntry(p, 'pkg/readme.txt')).toString()).toBe('hello from tar.bz2\n')
    expect((await readArchiveEntry(p, `${p}::pkg/sub/deep.txt`)).toString()).toBe('nested\n')
  })

  it('exposes a solo .bz2 as one member named after the container', async () => {
    const p = put('greeting.txt.bz2', HELLO_BZ2)
    const listing = await readArchive(p)
    expect(listing.format).toBe('bzip2')
    expect(listing.entries).toHaveLength(1)
    expect(listing.entries[0].path).toBe(`${p}::greeting.txt`)
    expect(listing.entries[0].size).toBe(HELLO.length)
    expect((await readArchiveEntry(p, 'greeting.txt')).equals(HELLO)).toBe(true)
  })

  it('reports a missing member of a solo .bz2', async () => {
    const p = put('solo.txt.bz2', HELLO_BZ2)
    const err = await grabAsync(() => readArchiveEntry(p, 'nope.txt'))
    expect(/** @type {ArchiveError} */ (err).code).toBe('notfound')
  })

  it('re-throws decoder failures as ArchiveError', async () => {
    const damaged = Buffer.from(HELLO_BZ2)
    damaged[10] ^= 0xff
    const p = put('damaged.txt.bz2', damaged)
    const err = await grabAsync(() => readArchive(p))
    expect(err).toBeInstanceOf(ArchiveError)
    expect(/** @type {ArchiveError} */ (err).code).toBe('corrupt')
  })

  it('propagates the archive limits into the decoder', async () => {
    const p = put('limited.txt.bz2', HELLO_BZ2)
    const err = await grabAsync(() => readArchive(p, { maxTotalBytes: 4, maxEntryBytes: 4 }))
    expect(err).toBeInstanceOf(ArchiveError)
    expect(/** @type {ArchiveError} */ (err).code).toBe('limit')
  })
})
