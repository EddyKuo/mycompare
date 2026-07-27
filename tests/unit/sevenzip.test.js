/**
 * 7z container reading.
 *
 * Fixtures are real archives written by py7zr (which wraps the reference
 * implementation) and embedded as base64, so the tests are self-contained:
 *
 *   python -c "import py7zr,io,base64; ..."
 *
 * A hand-built archive would only prove the reader agrees with itself, and the
 * container is exactly the part where that is not good enough.
 */
import { describe, it, expect } from 'vitest'
import {
  is7z,
  parse7z,
  extract7zEntry,
  bcjX86Decode,
  SevenZipError,
} from '../../src/main/sevenzip.js'

/** @param {string} b64 */
const bytes = (b64) => new Uint8Array(Buffer.from(b64, 'base64'))

/** Signature header length, fixed by the format. */
const SIG_HEADER_SIZE = 32

// py7zr defaults: BCJ (x86) chained into LZMA2.
// { 'a.txt': b'alpha', 'dir/b.txt': b'beta'*10 }
const DEFAULT_7Z = bytes('N3q8ryccAASTGdj5hQAAAAAAAAAUAAAAAAAAAOLkB/PgACwADl0AMJsKZySQyTQ/qfeDeAAA4AB4AGddAACBMweuD89dLwwHsMPaKtdYZKyzeM5U3dvYYcn8sT+oiYa8+2ZJHY8wMx5YUZ1l9ifkTB/N+KP5iXjXIVeR5iEVGehm3ss/DFKfyxCUq8S8j4kJ3kp4Ncw2bvJoS1HKfRRGT60AAAAAFwYWAQlvAAcLAQABISEBGAx5AAA=')
// Copy coder: { 'c.txt': b'plain copy' }
const COPY_7Z = bytes('N3q8ryccAAQ5grpbUwAAAAAAAAAUAAAAAAAAAGg3E0ZwbGFpbiBjb3B5AQBEAQQGAAEJCgAHCwEAAQEADAoACAoB/RM6MgAABQEZAQARDQBjAC4AdAB4AHQAAAAUCgEAkMxJg2Md3QEVBgEAIICAgQAAABcGCgEJSQAHCwEAASEhARgMRQAA')
// LZMA1 coder: { 'l.txt': b'lzma one'*20 }
const LZMA1_7Z = bytes('N3q8ryccAAR2zty8bAAAAAAAAAAUAAAAAAAAAI5D8SwANh6J3X1JXWbxNk9dhE///+1rAADgAFAAT10AAIEzB64Pz0tvjAfIQ4CDgVv/rHbPeD8O5t2gK7OiS2ozhQ2Yk3tCBlwSlCClyZkh163fjQZjQ8rgOgSlI1CtlNjNmHn179NcShPi6AAAAAAXBhUBCVcABwsBAAEhIQEYDFEAAA==')
// BCJ chain over x86-like bytes: { 'code.bin': bytes([0xe8,0x10,0,0,0]*100) }
const BCJ_7Z = bytes('N3q8ryccAATkNmmgCQEAAAAAAAAVAAAAAAAAAKv3oA/gAfMAoF0AdAU8GT31V97jvHRIJ4sPyx4Ae0bwGZ0hni+Cjr+2rJxyl+yzpVjXWHFxB7p/QlkjachZYguDfU+gPvqbuy8ftGGhO468IZnbMGUI2MD8QXyNSW1JBEh+6R01wPsr2syu/b9uPh3yPLPIlwRTRySjdRYwaahyCXabgeb50OQfNo2TwopGgM+C1FUcQNckvKDYn+bknHld2m6uFfx8+fMdVgDgAFoAWV0AAIEzB64P1TCKWxck0c/j92TRWslv34CaU9m/mI80buftDQfLZPMwHPsLd7bJ44QmOu9kLR5m65YzDDXZbXsyIl4ZgwF96DFLGVCmMh8kJIWgRosT2mYAAAAAFwaAqAEJYQAHCwEAASEhARgMWwAA')

/** @param {Uint8Array} buf @param {string} path */
function extract(buf, path) {
  return Buffer.from(extract7zEntry(buf, parse7z(buf), path))
}

describe('is7z', () => {
  it('recognises the signature', () => {
    expect(is7z(DEFAULT_7Z)).toBe(true)
  })

  it('rejects other data', () => {
    expect(is7z(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false) // zip
    expect(is7z(new Uint8Array(4))).toBe(false)
    expect(is7z(null)).toBe(false)
  })
})

describe('parse7z', () => {
  it('lists entries with their sizes', () => {
    const { entries } = parse7z(DEFAULT_7Z)
    const byName = Object.fromEntries(entries.map((e) => [e.path, e]))
    expect(Object.keys(byName).sort()).toEqual(['a.txt', 'dir/b.txt'])
    expect(byName['a.txt'].size).toBe(5)
    expect(byName['dir/b.txt'].size).toBe(40)
  })

  it('reads a compressed header, which is what 7z normally writes', () => {
    // The header is itself a folder that has to be decoded before anything
    // can be listed — getting this wrong means no archive parses at all.
    expect(parse7z(DEFAULT_7Z).entries.length).toBeGreaterThan(0)
  })

  it('gives entries a timestamp', () => {
    for (const e of parse7z(DEFAULT_7Z).entries) {
      expect(Number.isNaN(Date.parse(e.mtime))).toBe(false)
    }
  })

  it('refuses a header that claims more files than it could describe', () => {
    // Header: kHeader, kFilesInfo, numFiles = 0x0FFFFFFF. Acting on that count
    // allocates several arrays of half a billion entries from a 40-byte file,
    // long before any archive-level entry limit is consulted.
    const header = Uint8Array.from([0x01, 0x05, 0xf0, 0xff, 0xff, 0xff, 0x0f, 0x00])
    const buf = new Uint8Array(SIG_HEADER_SIZE + header.length)
    buf.set(DEFAULT_7Z.subarray(0, 12))
    const dv = new DataView(buf.buffer)
    dv.setUint32(12, 0, true) // nextHeaderOffset
    dv.setUint32(20, header.length, true) // nextHeaderSize
    buf.set(header, SIG_HEADER_SIZE)

    expect(() => parse7z(buf)).toThrow(/超出檔案內容/)
  })

  it('rejects data that is not 7z', () => {
    expect(() => parse7z(new Uint8Array(64))).toThrow(/magic/)
  })

  it('reports a header that points past the end of the file', () => {
    const bad = Uint8Array.from(DEFAULT_7Z.subarray(0, 40))
    expect(() => parse7z(bad)).toThrow(SevenZipError)
  })
})

describe('extract7zEntry', () => {
  it('extracts through the default BCJ + LZMA2 chain', () => {
    expect(extract(DEFAULT_7Z, 'a.txt').toString()).toBe('alpha')
    expect(extract(DEFAULT_7Z, 'dir/b.txt').toString()).toBe('beta'.repeat(10))
  })

  it('extracts a Copy-coded archive', () => {
    expect(extract(COPY_7Z, 'c.txt').toString()).toBe('plain copy')
  })

  it('extracts an LZMA1-coded archive', () => {
    expect(extract(LZMA1_7Z, 'l.txt').toString()).toBe('lzma one'.repeat(20))
  })

  it('reverses the BCJ filter exactly', () => {
    // The filter rewrites CALL operands, so a wrong inverse produces the right
    // length and the wrong bytes — length alone would not catch it.
    const expected = Buffer.from(
      Array.from({ length: 100 }, () => [0xe8, 0x10, 0, 0, 0]).flat())
    expect(extract(BCJ_7Z, 'code.bin').equals(expected)).toBe(true)
  })

  it('carries the archive-recorded CRC for each entry', () => {
    for (const e of parse7z(DEFAULT_7Z).entries.filter((x) => !x.isDirectory)) {
      expect(typeof e.crc).toBe('number')
    }
  })

  it('rejects a payload whose bytes were altered', () => {
    // The Copy coder makes the tamper survive decoding: the length is right and
    // only the content is wrong, which is precisely what a checksum is for and
    // what nothing else in the reader would notice.
    const parsed = parse7z(COPY_7Z)
    const good = extract(COPY_7Z, 'c.txt')
    const at = COPY_7Z.indexOf(good[0])
    expect(at).toBeGreaterThan(0)

    const tampered = Uint8Array.from(COPY_7Z)
    tampered[at] ^= 0xff
    expect(() => extract7zEntry(tampered, parsed, 'c.txt')).toThrow(/CRC/)
  })

  it('reports an entry that is not there', () => {
    expect(() => extract(DEFAULT_7Z, 'nope.txt')).toThrow(/找不到項目/)
  })

  it('enforces the output ceiling', () => {
    const buf = DEFAULT_7Z
    expect(() => extract7zEntry(buf, parse7z(buf), 'a.txt', { maxBytes: 2 }))
      .toThrow()
  })
})

describe('bcjX86Decode', () => {
  it('leaves data with no branch opcodes untouched', () => {
    const plain = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    expect(Buffer.from(bcjX86Decode(plain)).equals(Buffer.from(plain))).toBe(true)
  })

  it('does not modify a buffer shorter than one instruction window', () => {
    const tiny = new Uint8Array([0xe8, 0x00])
    expect(Array.from(bcjX86Decode(tiny))).toEqual([0xe8, 0x00])
  })

  it('does not mutate its input', () => {
    const input = new Uint8Array([0xe8, 0x10, 0, 0, 0, 0xaa, 0xbb, 0xcc, 0xdd])
    const copy = Uint8Array.from(input)
    bcjX86Decode(input)
    expect(Array.from(input)).toEqual(Array.from(copy))
  })
})
