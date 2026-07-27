/**
 * BCJ2 — the branching x86 filter in 7z.
 *
 * Fixtures come from the real 7-Zip (`C:\Program Files\7-Zip\7z.exe`) and the
 * inputs are real compiled executables out of System32, because BCJ2 is only
 * exercised by real machine code: the probability model is indexed by the byte
 * before each CALL, so a synthetic input of repeated `E8 xx xx xx xx` walks one
 * context and proves almost nothing. The expected output is the original file,
 * byte for byte.
 *
 * There is deliberately no encoder here. A decoder checked against an encoder
 * written from the same reading of the spec agrees with itself and with nothing
 * else; that is the mistake this project has already made once, with the SFTP
 * client and its own mock server.
 *
 * Two kinds of fixture, for two different reasons:
 *
 *   - One archive is committed as base64 (7 KB): a real BCJ2 + three-LZMA
 *     archive of `winver.exe`, so the suite still tests something on a machine
 *     with no 7-Zip installed. Its expected content is pinned by the SHA-256
 *     that 7-Zip itself reports for the original file
 *     (`7z h -scrcSHA256 winver.exe`), not by a hash this code computed.
 *   - The rest are built at run time by invoking 7z.exe, which is the only way
 *     to cover a 360 KB input, a solid multi-file folder, and the coder graphs
 *     7-Zip emits for different `-mb` wirings without committing megabytes.
 *     Those tests skip when 7z.exe or the System32 sources are absent, the same
 *     way the SFTP interop tests skip without paramiko.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parse7z,
  extract7zEntry,
  bcj2Decode,
  folderPackedStreams,
  SevenZipError,
} from '../../src/main/sevenzip.js'

const SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe'
const SYSTEM32 = 'C:\\Windows\\System32'

/** @param {Uint8Array|Buffer} d */
const sha256 = (d) => createHash('sha256').update(d).digest('hex')

// ---------------------------------------------------------------------------
// Committed fixture: winver.exe (32,768 bytes) as BCJ2 + LZMA x3.
//
//   7z a -t7z -m0=BCJ2 -m1=LZMA:d20 -m2=LZMA:d16 -m3=LZMA:d16 \
//        -mb0:1 -mb0s1:2 -mb0s2:3 winver.7z winver.exe
//
// The folder's sub-streams hold 22 converted CALLs and 12 converted JMPs, so
// both branch kinds and the per-previous-byte contexts are actually walked.
// ---------------------------------------------------------------------------
const WINVER_SHA256 = '53de1af89065816ccfad467e8fde2c2ed9dd5092c57af3b1b878c20e7d424001'
const WINVER_SIZE = 32768
const WINVER_7Z = new Uint8Array(Buffer.from([
  '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',
].join(''), 'base64'))

describe('BCJ2 committed fixture (no 7-Zip needed)', () => {
  it('parses the folder as three LZMA coders feeding a four-input BCJ2', () => {
    const parsed = parse7z(WINVER_7Z)
    const folder = parsed.streams.folders[0]
    expect(folder.coders.map((c) => c.id).sort())
      .toEqual(['030101', '030101', '030101', '0303011b'])
    const bcj2 = folder.coders.find((c) => c.id === '0303011b')
    expect(bcj2.numIn).toBe(4)
    // Three inputs are fed by other coders, one comes straight from the pack
    // area: that is the wiring the old single-input plumbing could not express.
    expect(folder.bindPairs).toHaveLength(3)
    expect(folder.packedIndices).toHaveLength(4)
  })

  it('decodes to the original executable', () => {
    const parsed = parse7z(WINVER_7Z)
    const out = extract7zEntry(WINVER_7Z, parsed, 'winver.exe')
    expect(out.length).toBe(WINVER_SIZE)
    expect(sha256(out)).toBe(WINVER_SHA256)
  })

  it('reports the entry size from the header', () => {
    const parsed = parse7z(WINVER_7Z)
    const entry = parsed.entries.find((e) => e.path === 'winver.exe')
    expect(entry.size).toBe(WINVER_SIZE)
    expect(entry.crc).not.toBeNull()
  })

  it('throws on a truncated archive', () => {
    for (const frac of [0.25, 0.5, 0.9, 0.999]) {
      const cut = WINVER_7Z.subarray(0, Math.floor(WINVER_7Z.length * frac))
      expect(() => extract7zEntry(cut, parse7z(cut), 'winver.exe'))
        .toThrow(SevenZipError)
    }
  })

  it('throws rather than returning short output when the data is cut', () => {
    // A 7z file keeps its header at the end, so cutting the tail off fails in
    // the container before any coder runs — the test above. To truncate the
    // *data* the header still describes, bytes are spliced out of the front of
    // the pack area and the header offset moved back to match. Every packed
    // stream then reads bytes that are not its own, and the run has to end in
    // an error, never in a short or plausible-looking result.
    for (const cut of [64, 512, 2048]) {
      const damaged = spliceOutOfPackArea(WINVER_7Z, cut)
      let out = null
      try {
        out = extract7zEntry(damaged, parse7z(damaged), 'winver.exe')
      } catch (err) {
        expect(err).toBeInstanceOf(SevenZipError)
      }
      if (out) throw new Error(`cut ${cut} produced ${out.length} bytes instead of failing`)
    }
  })

  it('throws when the control stream is corrupted, never wrong bytes', () => {
    // A flipped bit in the range-coded status stream sends the filter down the
    // wrong branch; the per-substream CRC is what turns that into an error.
    const damaged = Uint8Array.from(WINVER_7Z)
    const parsed = parse7z(WINVER_7Z)
    const streams = folderPackedStreams(WINVER_7Z, parsed.streams, 0)
    const last = streams[streams.length - 1]
    const offset = last.byteOffset + Math.min(4, last.length - 1)
    damaged[offset] ^= 0xff
    let out = null
    try {
      out = extract7zEntry(damaged, parse7z(damaged), 'winver.exe')
    } catch (err) {
      expect(err).toBeInstanceOf(SevenZipError)
    }
    if (out) expect(sha256(out)).not.toBe(WINVER_SHA256) // never silently wrong
  })

  it('refuses a declared size larger than the limit instead of allocating it', () => {
    const parsed = parse7z(WINVER_7Z)
    expect(() => extract7zEntry(WINVER_7Z, parsed, 'winver.exe', { maxBytes: 1024 }))
      .toThrow(/上限/)
  })

  it('names the failure when BCJ2 is handed the wrong number of streams', () => {
    const empty = new Uint8Array(0)
    expect(() => bcj2Decode([empty, empty, empty], 4, 1024))
      .toThrow(/BCJ2 需要四個輸入串流/)
  })

  it('does not allocate a declared size past maxBytes', () => {
    const empty = new Uint8Array(0)
    expect(() => bcj2Decode([empty, empty, empty, empty], 1 << 30, 4096))
      .toThrow(/上限/)
  })

  it('runs a folder with no branch bytes at all without touching the control stream', () => {
    // An input free of E8/E9/0F 8x leaves the encoder with an empty control
    // stream. Demanding the range coder's five init bytes up front would reject
    // a perfectly valid folder.
    const main = new Uint8Array([1, 2, 3, 4, 5, 6])
    const none = new Uint8Array(0)
    expect(Array.from(bcj2Decode([main, none, none, none], 6, 4096)))
      .toEqual([1, 2, 3, 4, 5, 6])
  })
})

/**
 * Remove `cut` bytes from the front of the pack area and pull the header back
 * so the archive still parses and still declares the original stream sizes.
 *
 * @param {Uint8Array} buf
 * @param {number} cut
 * @returns {Uint8Array}
 */
function spliceOutOfPackArea(buf, cut) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const headerOffset = Number(view.getBigUint64(12, true))
  const headerSize = Number(view.getBigUint64(20, true))
  const out = new Uint8Array(buf.length - cut)
  out.set(buf.subarray(0, 32), 0)
  out.set(buf.subarray(32 + cut, 32 + headerOffset), 32)
  out.set(buf.subarray(32 + headerOffset, 32 + headerOffset + headerSize),
    32 + headerOffset - cut)
  // The signature header's own CRCs are not checked by this reader, so the
  // offset alone is enough to keep the archive parseable.
  new DataView(out.buffer).setBigUint64(12, BigInt(headerOffset - cut), true)
  return out
}

// ---------------------------------------------------------------------------
// Generated fixtures: real 7z.exe over real System32 executables.
// ---------------------------------------------------------------------------

const have7z = fs.existsSync(SEVEN_ZIP)
const SOURCES = ['notepad.exe', 'where.exe']
const haveSources = SOURCES.every((n) => fs.existsSync(path.join(SYSTEM32, n)))

describe.skipIf(!have7z || !haveSources)('BCJ2 against archives written by 7-Zip', () => {
  /** @type {string} */
  let dir
  /** @type {Record<string, Buffer>} */
  const originals = {}

  /** @param {string[]} args */
  const sevenZip = (args) =>
    execFileSync(SEVEN_ZIP, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()

  /** @param {string} name @param {string[]} method */
  const build = (name, method) => {
    sevenZip(['a', '-t7z', '-bso0', '-bsp0', ...method, name, ...SOURCES])
    // 7-Zip's own verdict on the archive it just wrote, so a fixture that is
    // broken for reasons of its own does not read as a decoder bug.
    sevenZip(['t', name, '-bso0', '-bsp0'])
    return new Uint8Array(fs.readFileSync(path.join(dir, name)))
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycompare-bcj2-'))
    for (const n of SOURCES) {
      fs.copyFileSync(path.join(SYSTEM32, n), path.join(dir, n))
      originals[n] = fs.readFileSync(path.join(dir, n))
    }
  })

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  /** @param {Uint8Array} archive */
  const expectRoundTrip = (archive) => {
    const parsed = parse7z(archive)
    for (const n of SOURCES) {
      const out = Buffer.from(extract7zEntry(archive, parsed, n))
      expect(out.length).toBe(originals[n].length)
      expect(out.equals(originals[n])).toBe(true)
    }
  }

  it('decodes BCJ2 with stored sub-streams (-m0=BCJ2)', () => {
    // No LZMA anywhere: the four packed streams are the filter's own main,
    // call, jump and control streams, unwrapped.
    const archive = build('stored.7z', ['-m0=BCJ2'])
    const folder = parse7z(archive).streams.folders[0]
    expect(folder.coders).toHaveLength(1)
    expect(folder.coders[0].id).toBe('0303011b')
    expect(folder.packedIndices).toEqual([0, 1, 2, 3])
    expectRoundTrip(archive)
  })

  it('decodes the chain 7-Zip emits for BCJ2 (three LZMA coders, solid)', () => {
    const archive = build('std.7z', [
      '-m0=BCJ2', '-m1=LZMA:d25', '-m2=LZMA:d19', '-m3=LZMA:d19',
      '-mb0:1', '-mb0s1:2', '-mb0s2:3',
    ])
    const folder = parse7z(archive).streams.folders[0]
    expect(folder.coders).toHaveLength(4)
    // Both files live in one folder, so the 360 KB entry is sliced out of a
    // BCJ2 output that also contains the other one.
    expect(parse7z(archive).entries).toHaveLength(2)
    expectRoundTrip(archive)
  })

  it('decodes a BCJ2 folder wired as a serial LZMA chain into main', () => {
    // A graph 7-Zip accepts but nobody writes by hand: LZMA -> LZMA -> LZMA ->
    // BCJ2.main, with call/jump/control packed raw. The bind pairs come out in
    // a different order from the coders, which is the case a walker that
    // assumes "previous coder" gets wrong.
    const archive = build('serial.7z', [
      '-m0=BCJ2', '-m1=LZMA', '-m2=LZMA', '-m3=LZMA',
      '-mb0:1', '-mb1:2', '-mb2:3',
    ])
    expectRoundTrip(archive)
  })

  it('decodes the four filter streams directly, and refuses truncated ones', () => {
    const archive = build('stored2.7z', ['-m0=BCJ2'])
    const parsed = parse7z(archive)
    const streams = folderPackedStreams(archive, parsed.streams, 0)
    const total = originals[SOURCES[0]].length + originals[SOURCES[1]].length
    const whole = Buffer.from(bcj2Decode(streams, total, 1 << 28))
    expect(whole.subarray(0, originals[SOURCES[0]].length)
      .equals(originals[SOURCES[0]])).toBe(true)

    // Each stream cut short must be an error, not a short or padded result.
    for (let i = 0; i < 4; i++) {
      const cut = streams.map((s, j) => (j === i ? s.subarray(0, s.length >> 1) : s))
      expect(() => bcj2Decode(cut, total, 1 << 28)).toThrow(SevenZipError)
    }
  })

  it('agrees with 7z.exe on the extracted bytes', () => {
    const archive = build('cross.7z', [
      '-m0=BCJ2', '-m1=LZMA:d20', '-m2=LZMA:d16', '-m3=LZMA:d16',
      '-mb0:1', '-mb0s1:2', '-mb0s2:3',
    ])
    const outDir = path.join(dir, 'out')
    sevenZip(['x', 'cross.7z', `-o${outDir}`, '-y', '-bso0', '-bsp0'])
    const parsed = parse7z(archive)
    for (const n of SOURCES) {
      const reference = fs.readFileSync(path.join(outDir, n))
      const ours = Buffer.from(extract7zEntry(archive, parsed, n))
      expect(ours.equals(reference)).toBe(true)
    }
  })
})
