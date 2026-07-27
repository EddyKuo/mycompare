/**
 * @vitest-environment jsdom
 *
 * The hex detail panel's numbers, cross-checked against DataView.
 *
 * Written against the reference rather than against the panel's own
 * expectations: a hand-written int64 or a transposed endian flag produces a
 * plausible number, and a test that restates the implementation agrees with it.
 * Every offset that fits is covered, because a single fixture can be
 * accidentally symmetric between the two endiannesses.
 *
 * The labels are asserted to exist first. Looking a row up by label and
 * skipping when absent is how this kind of test quietly stops testing
 * anything — which is exactly what the first draft of it did.
 */
import { describe, it, expect } from 'vitest'
import { hexDetailRows } from '../../src/renderer/src/views/hex-compare.js'

/** Deterministic pseudo-random bytes, so a failure is reproducible. */
function bytes(n, seed = 1) {
  const out = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = (x >>> 16) & 0xff
  }
  return out
}

const DATA = bytes(64)
const DV = new DataView(DATA.buffer, DATA.byteOffset, DATA.byteLength)

/** label -> [reader, width in bytes] */
const CASES = [
  ['int8', (o) => DV.getInt8(o), 1],
  ['uint8', (o) => DV.getUint8(o), 1],
  ['int16 (LE)', (o) => DV.getInt16(o, true), 2],
  ['int16 (BE)', (o) => DV.getInt16(o, false), 2],
  ['uint16 (LE)', (o) => DV.getUint16(o, true), 2],
  ['uint16 (BE)', (o) => DV.getUint16(o, false), 2],
  ['int32 (LE)', (o) => DV.getInt32(o, true), 4],
  ['int32 (BE)', (o) => DV.getInt32(o, false), 4],
  ['uint32 (LE)', (o) => DV.getUint32(o, true), 4],
  ['uint32 (BE)', (o) => DV.getUint32(o, false), 4],
  ['int64 (LE)', (o) => DV.getBigInt64(o, true), 8],
  ['int64 (BE)', (o) => DV.getBigInt64(o, false), 8],
  ['uint64 (LE)', (o) => DV.getBigUint64(o, true), 8],
  ['uint64 (BE)', (o) => DV.getBigUint64(o, false), 8],
  ['float32 (LE)', (o) => DV.getFloat32(o, true), 4],
  ['float32 (BE)', (o) => DV.getFloat32(o, false), 4],
  ['float64 (LE)', (o) => DV.getFloat64(o, true), 8],
  ['float64 (BE)', (o) => DV.getFloat64(o, false), 8],
]

const rowFor = (rows, label) => rows.find((r) => r.label === label)

describe('hex detail numbers', () => {
  it('produces every label this test looks for', () => {
    const present = new Set(hexDetailRows(DATA, 0).map((r) => r.label))
    expect(CASES.map(([l]) => l).filter((l) => !present.has(l))).toEqual([])
  })

  it.each(CASES)('agrees with DataView on %s at every offset that fits', (label, read, width) => {
    for (let off = 0; off + width <= DATA.length; off++) {
      const row = rowFor(hexDetailRows(DATA, off), label)
      expect(row, `${label} missing at offset ${off}`).toBeTruthy()
      expect(row.available).toBe(true)
      expect(String(row.value), `${label} at offset ${off}`).toBe(String(read(off)))
    }
  })

  it('marks a type unavailable rather than reading past the end', () => {
    // Zero-padding a short tail would report a confident wrong number.
    const short = DATA.subarray(0, 3)
    for (const label of ['int32 (LE)', 'float64 (BE)', 'uint64 (BE)']) {
      const row = rowFor(hexDetailRows(short, 0), label)
      expect(row, label).toBeTruthy()
      expect(row.available).toBe(false)
    }
    // Something that does fit in three bytes still reads.
    expect(rowFor(hexDetailRows(short, 0), 'int16 (LE)').available).toBe(true)
  })

  it('returns nothing for an offset outside the data', () => {
    expect(hexDetailRows(DATA, DATA.length)).toEqual([])
    expect(hexDetailRows(DATA, -1)).toEqual([])
  })

  it('keeps the sign of negative zero', () => {
    // String(-0) is "0"; dropping the sign hides a real difference in the bytes.
    const negZero = new Uint8Array([0, 0, 0, 0x80])
    expect(String(rowFor(hexDetailRows(negZero, 0), 'float32 (LE)').value)).toMatch(/-0/)
  })
})
