/**
 * LZMA / LZMA2 / xz decompression.
 *
 * Fixtures are real compressed bytes, produced with Python's stdlib `lzma`
 * (which wraps the reference liblzma) and embedded as base64 so the tests are
 * self-contained and reproducible:
 *
 *   python -c "import lzma,base64; print(base64.b64encode(
 *       lzma.compress(b'hello world', format=lzma.FORMAT_XZ)).decode())"
 *
 * Hand-written byte sequences would only prove the decoder agrees with itself.
 */
import { describe, it, expect } from 'vitest'
import { decodeXz, decodeLzmaAlone, isXz, LzmaError } from '../../src/main/lzma.js'

/** @param {string} b64 */
const bytes = (b64) => new Uint8Array(Buffer.from(b64, 'base64'))
/** @param {Uint8Array} u8 */
const buf = (u8) => Buffer.from(u8)

// b'hello world'
const HELLO_XZ = bytes('/Td6WFoAAATm1rRGAgAhARYAAAB0L+WjAQAKaGVsbG8gd29ybGQAANpSI+/NfgNTAAEjC8Ib/QkftvN9AQAAAAAEWVo=')
// b''
const EMPTY_XZ = bytes('/Td6WFoAAATm1rRGAAAAABzfRCEftvN9AQAAAAAEWVo=')
// b'a'*10 + b'b' + b'c'*300
const RLE_XZ = bytes('/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4AE2AAtdADDrlIx8H+8bBAAAAAAg8BK+r9b4SAABJ7cCAAAA3P0S0bHEZ/sCAAAAAARZWg==')
// b'hello world', LZMA_ALONE container
const HELLO_LZMA = bytes('XQAAgAD//////////wA0GUnujekXiTozYAX3z2T/+3ggAA==')
// '繁體中文 emoji 😀'.encode('utf-8') * 40
const UNI_XZ = bytes('/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4AOXACVdAHOuTC6VcfwbKBDN3BAVsKNxVL8HmC9XDDni2zK+Xmj4awVmCAAAAAAABvQlqvj2/mkAAUGYBwAAAHxZ8HuxxGf7AgAAAAAEWVo=')

describe('isXz', () => {
  it('recognises the xz magic', () => {
    expect(isXz(HELLO_XZ)).toBe(true)
  })

  it('rejects other data', () => {
    expect(isXz(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(false) // gzip
    expect(isXz(new Uint8Array([]))).toBe(false)
    expect(isXz(null)).toBe(false)
  })
})

describe('decodeXz', () => {
  it('decodes a short literal stream exactly', () => {
    expect(buf(decodeXz(HELLO_XZ)).toString('utf-8')).toBe('hello world')
  })

  it('decodes an empty stream', () => {
    expect(decodeXz(EMPTY_XZ)).toHaveLength(0)
  })

  it('decodes runs, which exercise overlapping matches', () => {
    // A run is encoded as a match whose distance is shorter than its length;
    // a bulk copy would produce the wrong bytes here.
    const expected = Buffer.concat([
      Buffer.alloc(10, 0x61), Buffer.from('b'), Buffer.alloc(300, 0x63),
    ])
    expect(buf(decodeXz(RLE_XZ)).equals(expected)).toBe(true)
  })

  it('round-trips multi-byte UTF-8 without corrupting it', () => {
    const expected = Buffer.from('繁體中文 emoji 😀'.repeat(40), 'utf-8')
    expect(buf(decodeXz(UNI_XZ)).equals(expected)).toBe(true)
  })

  it('rejects data that is not xz', () => {
    expect(() => decodeXz(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])))
      .toThrow(/magic/)
  })

  it('rejects a stream that is too short to hold a header', () => {
    expect(() => decodeXz(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])))
      .toThrow(LzmaError)
  })

  it('reports truncation that removes the integrity check', () => {
    const truncated = HELLO_XZ.subarray(0, HELLO_XZ.length - 24)
    expect(() => decodeXz(truncated)).toThrow(LzmaError)
  })

  it('still decodes when only the trailing index and footer are missing', () => {
    // Those are not needed to produce the data, and the check value is still
    // present and passes — reporting an error here would be wrong.
    const clipped = HELLO_XZ.subarray(0, HELLO_XZ.length - 18)
    expect(buf(decodeXz(clipped)).toString('utf-8')).toBe('hello world')
  })

  it('reports corruption in the compressed payload', () => {
    const corrupt = Uint8Array.from(HELLO_XZ)
    // Flip bytes inside the block payload, past the 12-byte stream header and
    // the block header.
    for (let i = 26; i < Math.min(34, corrupt.length); i++) corrupt[i] ^= 0xff
    expect(() => decodeXz(corrupt)).toThrow(LzmaError)
  })

  it('rejects data whose integrity check does not match', () => {
    // The decoder must not hand back plausible-looking garbage: flipping a
    // byte of the stored CRC makes the check fail even though the compressed
    // data still decodes.
    const tampered = Uint8Array.from(HELLO_XZ)
    tampered[42] ^= 0xff
    expect(() => decodeXz(tampered)).toThrow(/完整性檢查|超出範圍/)
  })

  it('enforces the output ceiling', () => {
    expect(() => decodeXz(RLE_XZ, { maxBytes: 16 }))
      .toThrow(/大小上限/)
  })

  it('allows output exactly at the ceiling', () => {
    expect(decodeXz(HELLO_XZ, { maxBytes: 11 })).toHaveLength(11)
  })
})

describe('decodeLzmaAlone', () => {
  it('decodes the LZMA_ALONE container', () => {
    expect(buf(decodeLzmaAlone(HELLO_LZMA)).toString('utf-8')).toBe('hello world')
  })

  it('rejects a header that is too short', () => {
    expect(() => decodeLzmaAlone(new Uint8Array(5))).toThrow(/檔頭/)
    expect(() => decodeLzmaAlone(null)).toThrow(LzmaError)
  })

  it('rejects an impossible properties byte', () => {
    const bad = Uint8Array.from(HELLO_LZMA)
    bad[0] = 0xff // >= 9*5*5, so lc/lp/pb cannot be derived
    expect(() => decodeLzmaAlone(bad)).toThrow(/屬性位元組/)
  })

  it('enforces the output ceiling from the declared size', () => {
    // The container declares an unknown size here, so the ceiling is applied
    // to the window rather than checked up front.
    expect(() => decodeLzmaAlone(HELLO_LZMA, { maxBytes: 4 })).toThrow(/大小上限/)
  })
})

describe('robustness', () => {
  it('never loops forever on random bytes', () => {
    // Corrupt LZMA can drive a naive decoder into an unbounded loop; every
    // path has to be bounded by the input or the ceiling.
    let seed = 1
    for (let i = 0; i < 40; i++) {
      const junk = new Uint8Array(64)
      for (let j = 0; j < junk.length; j++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        junk[j] = (seed >> 16) & 0xff
      }
      junk.set([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], 0) // valid magic, junk body
      expect(() => {
        try { decodeXz(junk, { maxBytes: 1 << 20 }) } catch { /* expected */ }
      }).not.toThrow()
    }
  })
})
