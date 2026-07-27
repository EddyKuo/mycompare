/**
 * Microsoft cabinet (.cab) reading.
 *
 * The fixture is a real cabinet written by Windows' own `makecab`, embedded as
 * base64:
 *
 *   makecab /f dirs.ddf     (CompressionType=MSZIP, three files in one folder)
 *
 * That matters more here than usual. A hand-built cabinet would only prove the
 * reader agrees with whatever this file thinks the format is, and MSZIP's
 * cross-block dictionary is exactly the kind of detail such a fixture would
 * get wrong in both places at once. It is also the standard RAR cannot meet on
 * this machine, which is why RAR is refused rather than guessed at.
 */
import { describe, it, expect } from 'vitest'
import { isCab, parseCab, extractCabEntry, decodeFolder, CabError } from '../../src/main/cab.js'

/** Three files — 28, 17 and 50000 bytes — in one MSZIP folder of two blocks. */
const MULTI_CAB = Buffer.from(
  'TVNDRgAAAAAyAQAAAAAAACwAAAAAAAAAAwEBAAMAAACfBgAAcAAAAAIAAQAcAAAAAAAAAAAA+1xOjiAAYS50eHQAEQAAABwAAAAAAPtcZY4gAGIudHh0AFDDAAAtAAAAAAD7XE6OIABiaWcudHh0AITQdRh+AACAQ0vtxsENglAQBcA7VWxrCM9AsvLN18T2PdmEmTnNke5R23qrz5i9L69s49qrzyu/389OHZlZZp5Z3/VImZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZ/dW+c8Z/6zQAfUNDS+3PIQEAAACAoP+vHSKNihEREREREREREREREREREREREREREREREREREREREREREW0V',
  'base64')

/** What the fixture was built from. */
const EXPECTED = {
  'a.txt': 'hello cab world\nsecond line\n',
  'b.txt': 'second file here\n',
  'big.txt': 'repeat me '.repeat(5000),
}

describe('isCab', () => {
  it('recognises the signature', () => {
    expect(isCab(MULTI_CAB)).toBe(true)
  })

  it('rejects other data', () => {
    expect(isCab(Buffer.from('PK\x03\x04'))).toBe(false)
    expect(isCab(Buffer.alloc(4))).toBe(false)
    expect(isCab(null)).toBe(false)
  })
})

describe('parseCab', () => {
  it('lists every file with its real size', () => {
    const { entries } = parseCab(MULTI_CAB)
    expect(entries.map((e) => e.path).sort()).toEqual(['a.txt', 'b.txt', 'big.txt'])
    const bySize = Object.fromEntries(entries.map((e) => [e.path, e.size]))
    expect(bySize).toEqual({ 'a.txt': 28, 'b.txt': 17, 'big.txt': 50000 })
  })

  it('reports the folder as MSZIP with more than one block', () => {
    // The 50 KB file crosses a block boundary, which is what exercises the
    // cross-block dictionary.
    const { folders } = parseCab(MULTI_CAB)
    expect(folders).toHaveLength(1)
    expect(folders[0].compress).toBe(1)
    expect(folders[0].blocks).toBeGreaterThan(1)
  })

  it('gives every entry a parseable timestamp', () => {
    for (const e of parseCab(MULTI_CAB).entries) {
      expect(Number.isNaN(Date.parse(e.mtime))).toBe(false)
    }
  })

  it('refuses data that is not a cabinet', () => {
    expect(() => parseCab(Buffer.alloc(64))).toThrow(/magic/)
  })

  it('refuses a header claiming more bytes than the file has', () => {
    const bad = Buffer.from(MULTI_CAB)
    bad.writeUInt32LE(0x7fffffff, 8)
    expect(() => parseCab(bad)).toThrow(CabError)
  })

  it('refuses a truncated file table', () => {
    expect(() => parseCab(MULTI_CAB.subarray(0, 60))).toThrow(CabError)
  })
})

describe('extractCabEntry', () => {
  it.each(Object.keys(EXPECTED))('extracts %s byte for byte', (name) => {
    const parsed = parseCab(MULTI_CAB)
    const out = extractCabEntry(MULTI_CAB, parsed, name)
    expect(out.toString('utf-8')).toBe(EXPECTED[name])
  })

  it('decodes across the block boundary, not just the first block', () => {
    // A reader that ignored the previous block as MSZIP's dictionary would
    // produce the right length and the wrong bytes past ~32 KB, so the tail is
    // checked explicitly rather than only the size.
    const parsed = parseCab(MULTI_CAB)
    const big = extractCabEntry(MULTI_CAB, parsed, 'big.txt').toString('utf-8')
    expect(big.length).toBe(50000)
    expect(big.slice(-10)).toBe('repeat me ')
    expect(big.slice(40000, 40010)).toBe('repeat me ')
  })

  it('reports an entry that is not there', () => {
    const parsed = parseCab(MULTI_CAB)
    expect(() => extractCabEntry(MULTI_CAB, parsed, 'nope.txt')).toThrow(/找不到項目/)
  })

  it('enforces the output ceiling', () => {
    const parsed = parseCab(MULTI_CAB)
    expect(() => extractCabEntry(MULTI_CAB, parsed, 'big.txt', { maxBytes: 100 }))
      .toThrow(/上限/)
  })
})

describe('decodeFolder', () => {
  it('names Quantum and LZX rather than mis-decoding them', () => {
    // Neither can be verified against a reference implementation here, so an
    // honest refusal beats a decoder that only agrees with itself.
    for (const [compress, name] of [[2, 'Quantum'], [3, 'LZX']]) {
      expect(() => decodeFolder(MULTI_CAB, { coffData: 112, blocks: 1, compress }, { data: 0 }))
        .toThrow(new RegExp(name))
    }
  })

  it('refuses an unknown compression type by number', () => {
    expect(() => decodeFolder(MULTI_CAB, { coffData: 112, blocks: 1, compress: 9 }, { data: 0 }))
      .toThrow(/未知的壓縮類型/)
  })
})
