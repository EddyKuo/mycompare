import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  parseId3v2,
  parseId3v1,
  parseMpegFrameHeader,
  findMpegFrame,
  parseMp3Audio,
  parseMp3Metadata,
  parsePeHeaders,
  parsePeMetadata,
  parseVersionBlock,
  sectionForRva,
  findVersionResource,
  diffMetadata,
  readMetadata,
  MP3_FIELDS,
  PE_FIELDS
} from '../../src/main/metadata.js'

// ─────────────────────────────────────────────────────────────────────────────
// Byte builders — every fixture in this file is assembled here, so the tests
// never depend on binaries checked into the repo.
// ─────────────────────────────────────────────────────────────────────────────

const NUL = 0x00

const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0); return b }
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n >>> 0); return b }
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }

const synchsafe = (n) =>
  Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f])

/** UTF-16 code units, big-endian. */
function utf16be(str) {
  const b = Buffer.from(str, 'utf16le')
  b.swap16()
  return b
}

/** Encode `text` with the given ID3v2 encoding byte, returning [byte, payload]. */
function encodeText(text, encoding) {
  switch (encoding) {
    case 0: return Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')])
    case 1: return Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 2: return Buffer.concat([Buffer.from([2]), utf16be(text)])
    case 3: return Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')])
    default: throw new Error('bad encoding')
  }
}

/** UTF-16 with a big-endian BOM — legal under encoding byte 1. */
function encodeUtf16BomBe(text) {
  return Buffer.concat([Buffer.from([1, 0xfe, 0xff]), utf16be(text)])
}

/** COMM payload: encoding, 3-byte language, terminated description, text. */
function commFrame(text, encoding = 0) {
  const desc = encoding === 0 || encoding === 3 ? Buffer.from([NUL]) : Buffer.from([NUL, NUL])
  const body = encoding === 0 || encoding === 3
    ? Buffer.from(text, encoding === 0 ? 'latin1' : 'utf8')
    : utf16be(text)
  return Buffer.concat([Buffer.from([encoding]), Buffer.from('eng', 'latin1'), desc, body])
}

/** Apply ID3 unsynchronisation: FF followed by 00 or E0-FF gains a 00. */
function applyUnsync(buf) {
  const out = []
  for (let i = 0; i < buf.length; i++) {
    out.push(buf[i])
    if (buf[i] === 0xff && (buf[i + 1] === 0x00 || buf[i + 1] >= 0xe0)) out.push(0x00)
  }
  return Buffer.from(out)
}

/**
 * @param {{ major?: number, flags?: number, frames?: Array<{id:string,data:Buffer,flags?:number}>,
 *           padding?: number, unsync?: boolean, extHeader?: Buffer|null }} opts
 */
function buildId3v2(opts = {}) {
  const { major = 3, frames = [], padding = 0, unsync = false, extHeader = null } = opts
  let flags = opts.flags ?? 0

  const parts = []
  for (const f of frames) {
    parts.push(
      Buffer.from(f.id, 'latin1'),
      major === 4 ? synchsafe(f.data.length) : u32be(f.data.length),
      u16be(f.flags ?? 0),
      f.data
    )
  }
  let body = Buffer.concat(parts)
  if (extHeader) body = Buffer.concat([extHeader, body])
  if (padding > 0) body = Buffer.concat([body, Buffer.alloc(padding)])
  if (unsync) { body = applyUnsync(body); flags |= 0x80 }

  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([major, 0, flags]),
    synchsafe(body.length)
  ])
  return Buffer.concat([header, body])
}

function buildId3v1({ title = '', artist = '', album = '', year = '', comment = '', track = 0, genre = 255 } = {}) {
  const tag = Buffer.alloc(128)
  tag.write('TAG', 0, 'latin1')
  tag.write(title.slice(0, 30), 3, 'latin1')
  tag.write(artist.slice(0, 30), 33, 'latin1')
  tag.write(album.slice(0, 30), 63, 'latin1')
  tag.write(year.slice(0, 4), 93, 'latin1')
  tag.write(comment.slice(0, 28), 97, 'latin1')
  if (track > 0) { tag[125] = 0; tag[126] = track }
  tag[127] = genre
  return tag
}

// MPEG-1 Layer III, 128 kbps, 44100 Hz, stereo -> 417-byte frames.
const FRAME_LEN = 417
function mpegFrames(count = 3, extraAtSideInfo = null) {
  const out = []
  for (let i = 0; i < count; i++) {
    const f = Buffer.alloc(FRAME_LEN)
    f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; f[3] = 0x00
    if (i === 0 && extraAtSideInfo) extraAtSideInfo.copy(f, 4 + 32)
    out.push(f)
  }
  return Buffer.concat(out)
}

function xingHeader(frames, bytes) {
  const b = Buffer.alloc(16)
  b.write('Xing', 0, 'latin1')
  b.writeUInt32BE(0x03, 4)      // frames + bytes present
  b.writeUInt32BE(frames, 8)
  b.writeUInt32BE(bytes, 12)
  return b
}

// ── VS_VERSIONINFO ──────────────────────────────────────────────────────────

const pad4 = (b) => (b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]))
const wsz = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([NUL, NUL])])

/**
 * @param {string} key
 * @param {Buffer|null} value
 * @param {number} type 1 = text (wValueLength counts WORDs), 0 = binary
 * @param {Buffer[]} children each must already be 4-aligned in length
 */
function versionNode(key, value, type, children = []) {
  const val = value ?? Buffer.alloc(0)
  let buf = pad4(Buffer.concat([u16le(0), u16le(0), u16le(type), wsz(key)]))
  buf = pad4(Buffer.concat([buf, val]))
  for (const c of children) buf = Buffer.concat([buf, c])
  buf = pad4(buf)
  buf.writeUInt16LE(buf.length, 0)
  buf.writeUInt16LE(type === 1 ? val.length / 2 : val.length, 2)
  return buf
}

function fixedFileInfo(fileVer, prodVer) {
  const b = Buffer.alloc(52)
  b.writeUInt32LE(0xfeef04bd, 0)
  b.writeUInt32LE(0x00010000, 4)
  b.writeUInt32LE(fileVer[0] * 0x10000 + fileVer[1], 8)
  b.writeUInt32LE(fileVer[2] * 0x10000 + fileVer[3], 12)
  b.writeUInt32LE(prodVer[0] * 0x10000 + prodVer[1], 16)
  b.writeUInt32LE(prodVer[2] * 0x10000 + prodVer[3], 20)
  return b
}

function buildVersionBlock(strings, fileVer = [1, 2, 3, 4], prodVer = [5, 6, 7, 8]) {
  const nodes = Object.entries(strings).map(([k, v]) => versionNode(k, wsz(v), 1))
  const table = versionNode('040904B0', null, 0, nodes)
  const sfi = versionNode('StringFileInfo', null, 0, [table])
  return versionNode('VS_VERSION_INFO', fixedFileInfo(fileVer, prodVer), 0, [sfi])
}

/** Minimal but structurally valid PE image carrying one RT_VERSION resource. */
function buildPe(versionBlock, { pe32Plus = false } = {}) {
  const SECTION_VA = 0x1000
  const RSRC_PTR = 0x200
  const TREE_BYTES = 88

  const dir = (ids) => { const b = Buffer.alloc(16); b.writeUInt16LE(ids, 14); return b }
  const entry = (name, offset, isDir) => {
    const b = Buffer.alloc(8)
    b.writeUInt32LE(name >>> 0, 0)
    b.writeUInt32LE(isDir ? 0x80000000 + offset : offset, 4)
    return b
  }
  const dataEntry = Buffer.alloc(16)
  dataEntry.writeUInt32LE(SECTION_VA + TREE_BYTES, 0)
  dataEntry.writeUInt32LE(versionBlock.length, 4)

  const rsrc = Buffer.concat([
    dir(1), entry(16, 24, true),        // type level: RT_VERSION
    dir(1), entry(1, 48, true),         // name level
    dir(1), entry(0x0409, 72, false),   // language level -> leaf
    dataEntry,
    versionBlock
  ])

  const PE_OFF = 0x80
  const optSize = pe32Plus ? 240 : 224
  const head = Buffer.alloc(RSRC_PTR)
  head.write('MZ', 0, 'latin1')
  head.writeUInt32LE(PE_OFF, 0x3c)
  head.write('PE', PE_OFF, 'latin1')
  head.writeUInt16LE(pe32Plus ? 0x8664 : 0x014c, PE_OFF + 4)
  head.writeUInt16LE(1, PE_OFF + 6)                 // NumberOfSections
  head.writeUInt16LE(optSize, PE_OFF + 20)

  const optOff = PE_OFF + 24
  head.writeUInt16LE(pe32Plus ? 0x20b : 0x10b, optOff)
  const dirOff = optOff + (pe32Plus ? 112 : 96)
  head.writeUInt32LE(SECTION_VA, dirOff + 2 * 8)    // resource directory RVA
  head.writeUInt32LE(rsrc.length, dirOff + 2 * 8 + 4)

  const rawSize = Math.ceil(rsrc.length / 512) * 512
  const sec = optOff + optSize
  head.write('.rsrc', sec, 'latin1')
  head.writeUInt32LE(rsrc.length, sec + 8)
  head.writeUInt32LE(SECTION_VA, sec + 12)
  head.writeUInt32LE(rawSize, sec + 16)
  head.writeUInt32LE(RSRC_PTR, sec + 20)

  return Buffer.concat([head, rsrc, Buffer.alloc(rawSize - rsrc.length)])
}

// ─────────────────────────────────────────────────────────────────────────────
// ID3v2
// ─────────────────────────────────────────────────────────────────────────────

describe('parseId3v2 — ID3v2.3', () => {
  it('reads the common text frames', () => {
    const tag = buildId3v2({
      major: 3,
      frames: [
        { id: 'TIT2', data: encodeText('Sunset Drive', 0) },
        { id: 'TPE1', data: encodeText('The Groves', 0) },
        { id: 'TALB', data: encodeText('Long Way Home', 0) },
        { id: 'TPE2', data: encodeText('Various Artists', 0) },
        { id: 'TCOM', data: encodeText('J. Blake', 0) },
        { id: 'TYER', data: encodeText('1998', 0) },
        { id: 'TRCK', data: encodeText('4/12', 0) },
        { id: 'TCON', data: encodeText('(17)', 0) },
        { id: 'COMM', data: commFrame('ripped from vinyl') }
      ],
      padding: 32
    })

    const out = parseId3v2(tag)
    expect(out).not.toBeNull()
    expect(out.version).toBe(3)
    expect(out.fields).toEqual({
      title: 'Sunset Drive',
      artist: 'The Groves',
      album: 'Long Way Home',
      albumArtist: 'Various Artists',
      composer: 'J. Blake',
      year: '1998',
      track: '4/12',
      genre: 'Rock',
      comment: 'ripped from vinyl'
    })
  })

  it('reports the tag length so the audio stream can be located', () => {
    const tag = buildId3v2({ frames: [{ id: 'TIT2', data: encodeText('X', 0) }], padding: 100 })
    expect(parseId3v2(tag).tagBytes).toBe(tag.length)
  })

  it('skips a v2.3 extended header', () => {
    // v2.3 ext-header size excludes its own 4 size bytes.
    const ext = Buffer.concat([u32be(6), Buffer.alloc(6)])
    const tag = buildId3v2({
      major: 3,
      flags: 0x40,
      extHeader: ext,
      frames: [{ id: 'TIT2', data: encodeText('After Ext', 0) }]
    })
    expect(parseId3v2(tag).fields.title).toBe('After Ext')
  })

  it('resolves a bare numeric genre and prefers a refinement over the table', () => {
    const bare = buildId3v2({ frames: [{ id: 'TCON', data: encodeText('13', 0) }] })
    expect(parseId3v2(bare).fields.genre).toBe('Pop')
    const refined = buildId3v2({ frames: [{ id: 'TCON', data: encodeText('(17)Surf Rock', 0) }] })
    expect(parseId3v2(refined).fields.genre).toBe('Surf Rock')
  })
})

describe('parseId3v2 — ID3v2.4', () => {
  it('reads synchsafe frame sizes and TDRC', () => {
    const tag = buildId3v2({
      major: 4,
      frames: [
        { id: 'TIT2', data: encodeText('Night Shift', 3) },
        { id: 'TDRC', data: encodeText('2019-04-01', 3) }
      ]
    })
    const out = parseId3v2(tag)
    expect(out.version).toBe(4)
    expect(out.fields.title).toBe('Night Shift')
    expect(out.fields.year).toBe('2019-04-01')
  })

  it('strips the data length indicator when the frame flag is set', () => {
    const payload = encodeText('Indicated', 3)
    const tag = buildId3v2({
      major: 4,
      frames: [{
        id: 'TIT2',
        flags: 0x0001,
        data: Buffer.concat([synchsafe(payload.length), payload])
      }]
    })
    expect(parseId3v2(tag).fields.title).toBe('Indicated')
  })

  it('strips a group identifier byte', () => {
    const payload = encodeText('Grouped', 3)
    const tag = buildId3v2({
      major: 4,
      frames: [{ id: 'TIT2', flags: 0x0040, data: Buffer.concat([Buffer.from([0x7f]), payload]) }]
    })
    expect(parseId3v2(tag).fields.title).toBe('Grouped')
  })

  it('ignores encrypted and compressed frames rather than emitting garbage', () => {
    const tag = buildId3v2({
      major: 4,
      frames: [
        { id: 'TIT2', flags: 0x0008, data: Buffer.from([1, 2, 3, 4, 5]) },
        { id: 'TPE1', data: encodeText('Readable', 3) }
      ]
    })
    const out = parseId3v2(tag)
    expect(out.fields.title).toBeUndefined()
    expect(out.fields.artist).toBe('Readable')
  })

  it('falls back to a plain big-endian frame size when the encoder ignored synchsafe', () => {
    const payload = encodeText('Legacy Size', 0)
    const parts = [Buffer.from('TIT2', 'latin1'), u32be(payload.length), u16be(0), payload]
    // 0xFF in the size field is impossible for a synchsafe integer.
    const buggy = Buffer.concat(parts)
    buggy[4] = 0x00; buggy[5] = 0x00; buggy[6] = 0x00; buggy[7] = payload.length
    const body = buggy
    const tag = Buffer.concat([
      Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), synchsafe(body.length), body
    ])
    expect(parseId3v2(tag).fields.title).toBe('Legacy Size')
  })

  it('skips a v2.4 extended header (size includes itself)', () => {
    const ext = Buffer.concat([synchsafe(10), Buffer.alloc(6)])
    const tag = buildId3v2({
      major: 4,
      flags: 0x40,
      extHeader: ext,
      frames: [{ id: 'TIT2', data: encodeText('Ext24', 3) }]
    })
    expect(parseId3v2(tag).fields.title).toBe('Ext24')
  })
})

describe('parseId3v2 — text encodings', () => {
  const text = 'Café 東京 ✦'

  it('decodes ISO-8859-1 (0)', () => {
    const tag = buildId3v2({ frames: [{ id: 'TIT2', data: encodeText('Café Latin1', 0) }] })
    expect(parseId3v2(tag).fields.title).toBe('Café Latin1')
  })

  it('decodes UTF-16 with a little-endian BOM (1)', () => {
    const tag = buildId3v2({ frames: [{ id: 'TIT2', data: encodeText(text, 1) }] })
    expect(parseId3v2(tag).fields.title).toBe(text)
  })

  it('decodes UTF-16 with a big-endian BOM (1)', () => {
    const tag = buildId3v2({ frames: [{ id: 'TIT2', data: encodeUtf16BomBe(text) }] })
    expect(parseId3v2(tag).fields.title).toBe(text)
  })

  it('decodes UTF-16BE without a BOM (2)', () => {
    const tag = buildId3v2({ frames: [{ id: 'TIT2', data: encodeText(text, 2) }] })
    expect(parseId3v2(tag).fields.title).toBe(text)
  })

  it('decodes UTF-8 (3)', () => {
    const tag = buildId3v2({ frames: [{ id: 'TIT2', data: encodeText(text, 3) }] })
    expect(parseId3v2(tag).fields.title).toBe(text)
  })

  it('decodes a UTF-16BE comment past its description', () => {
    const tag = buildId3v2({ frames: [{ id: 'COMM', data: commFrame(text, 2) }] })
    expect(parseId3v2(tag).fields.comment).toBe(text)
  })

  it('keeps only the first value of a multi-value frame', () => {
    const data = Buffer.concat([Buffer.from([0]), Buffer.from('First', 'latin1'),
      Buffer.from([NUL]), Buffer.from('Second', 'latin1')])
    const tag = buildId3v2({ major: 4, frames: [{ id: 'TPE1', data }] })
    expect(parseId3v2(tag).fields.artist).toBe('First')
  })
})

describe('parseId3v2 — unsynchronisation', () => {
  it('recovers text through a whole-tag unsynchronised body', () => {
    const title = 'AÿéB'
    const tag = buildId3v2({ frames: [{ id: 'TIT2', data: encodeText(title, 0) }], unsync: true })
    expect(tag[5] & 0x80).toBe(0x80)
    expect(parseId3v2(tag).fields.title).toBe(title)
  })

  it('recovers text from a per-frame unsynchronised v2.4 frame', () => {
    const title = 'AÿéB'
    const raw = encodeText(title, 0)
    const unsynced = applyUnsync(raw)
    expect(unsynced.length).toBeGreaterThan(raw.length)
    const tag = buildId3v2({
      major: 4,
      frames: [{ id: 'TIT2', flags: 0x0002, data: unsynced }]
    })
    expect(parseId3v2(tag).fields.title).toBe(title)
  })
})

describe('parseId3v2 — malformed input', () => {
  it('returns null for buffers that are not ID3v2', () => {
    expect(parseId3v2(Buffer.alloc(0))).toBeNull()
    expect(parseId3v2(Buffer.from('not a tag at all, really', 'latin1'))).toBeNull()
    expect(parseId3v2(Buffer.from('ID3', 'latin1'))).toBeNull()
  })

  it('returns null for unsupported major versions', () => {
    const v2 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([2, 0, 0]), synchsafe(10), Buffer.alloc(10)])
    expect(parseId3v2(v2)).toBeNull()
  })

  it('returns null when the declared size is not synchsafe', () => {
    const bad = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]),
      Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.alloc(20)])
    expect(parseId3v2(bad)).toBeNull()
  })

  it('survives a header whose body is missing entirely', () => {
    const headerOnly = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), synchsafe(5000)])
    const out = parseId3v2(headerOnly)
    expect(out).not.toBeNull()
    expect(out.fields).toEqual({})
  })

  it('salvages a tag truncated mid-frame without throwing', () => {
    const full = buildId3v2({
      frames: [
        { id: 'TIT2', data: encodeText('Complete Title', 0) },
        { id: 'TPE1', data: encodeText('Cut Off Artist', 0) }
      ]
    })
    const cut = full.subarray(0, full.length - 8)
    let out
    expect(() => { out = parseId3v2(cut) }).not.toThrow()
    expect(out.fields.title).toBe('Complete Title')
    expect(out.fields.artist ?? '').not.toBe('Cut Off Artist')
  })

  it('stops at a garbage frame id instead of walking off into noise', () => {
    const good = buildId3v2({ frames: [{ id: 'TIT2', data: encodeText('Good', 0) }] })
    const noise = Buffer.alloc(64, 0x5a)
    const tag = Buffer.concat([good, noise])
    tag.writeUInt32BE(0, 6)
    synchsafe(good.length - 10 + noise.length).copy(tag, 6)
    const out = parseId3v2(tag)
    expect(out.fields.title).toBe('Good')
  })

  it('does not throw on a frame claiming a size larger than the tag', () => {
    const body = Buffer.concat([Buffer.from('TIT2', 'latin1'), u32be(0x7fffff), u16be(0), Buffer.from([0, 0x41])])
    const tag = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), synchsafe(body.length), body])
    expect(() => parseId3v2(tag)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ID3v1
// ─────────────────────────────────────────────────────────────────────────────

describe('parseId3v1', () => {
  it('reads a v1.1 tag including the track number stolen from the comment', () => {
    const tag = buildId3v1({
      title: 'Old School', artist: 'Tape Deck', album: 'Cassette',
      year: '1987', comment: 'side b', track: 7, genre: 13
    })
    expect(parseId3v1(tag)).toEqual({
      title: 'Old School', artist: 'Tape Deck', album: 'Cassette',
      year: '1987', comment: 'side b', track: '7', genre: 'Pop'
    })
  })

  it('omits the track when the tag is plain v1.0', () => {
    const tag = buildId3v1({ title: 'No Track', genre: 255 })
    const out = parseId3v1(tag)
    expect(out.track).toBeUndefined()
    expect(out.genre).toBeUndefined()
    expect(out.title).toBe('No Track')
  })

  it('finds the tag at the end of a larger trailing buffer', () => {
    const buf = Buffer.concat([Buffer.alloc(300, 0x11), buildId3v1({ title: 'Trailing' })])
    expect(parseId3v1(buf).title).toBe('Trailing')
  })

  it('returns null when there is no TAG marker or not enough bytes', () => {
    expect(parseId3v1(Buffer.alloc(128))).toBeNull()
    expect(parseId3v1(Buffer.alloc(50))).toBeNull()
    expect(parseId3v1(null)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MPEG audio
// ─────────────────────────────────────────────────────────────────────────────

describe('MPEG frame header', () => {
  it('decodes bitrate, sample rate, channel mode and frame length', () => {
    const h = parseMpegFrameHeader(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 0)
    expect(h).toMatchObject({
      mpegVersion: '1', layer: 3, bitrate: 128, sampleRate: 44100,
      channelMode: 'stereo', samplesPerFrame: 1152, frameLength: FRAME_LEN
    })
  })

  it('decodes mono and joint stereo', () => {
    expect(parseMpegFrameHeader(Buffer.from([0xff, 0xfb, 0x90, 0xc0]), 0).channelMode).toBe('mono')
    expect(parseMpegFrameHeader(Buffer.from([0xff, 0xfb, 0x90, 0x40]), 0).channelMode).toBe('joint stereo')
  })

  it('rejects reserved and free-format headers', () => {
    expect(parseMpegFrameHeader(Buffer.from([0xff, 0xfb, 0x00, 0x00]), 0)).toBeNull() // bitrate index 0
    expect(parseMpegFrameHeader(Buffer.from([0xff, 0xfb, 0xf0, 0x00]), 0)).toBeNull() // bitrate index 15
    expect(parseMpegFrameHeader(Buffer.from([0xff, 0xfb, 0x9c, 0x00]), 0)).toBeNull() // sample index 3
    expect(parseMpegFrameHeader(Buffer.from([0xff, 0xf9, 0x90, 0x00]), 0)).toBeNull() // reserved layer
    expect(parseMpegFrameHeader(Buffer.from([0xff, 0xeb, 0x90, 0x00]), 0)).toBeNull() // reserved version
    expect(parseMpegFrameHeader(Buffer.from([0x00, 0x00]), 0)).toBeNull()
  })

  it('requires a corroborating second frame before accepting a sync', () => {
    // A lone 0xFF 0xFB pair buried in data is followed by a bogus "next frame".
    const noise = Buffer.alloc(2000, 0x42)
    noise[100] = 0xff; noise[101] = 0xfb; noise[102] = 0x90; noise[103] = 0x00
    expect(findMpegFrame(noise)).toBeNull()
  })

  it('locates the first frame of a real stream', () => {
    const found = findMpegFrame(mpegFrames(3))
    expect(found.offset).toBe(0)
    expect(found.header.bitrate).toBe(128)
  })
})

describe('parseMp3Audio', () => {
  it('estimates duration from the CBR bitrate', () => {
    const audio = parseMp3Audio(mpegFrames(3), FRAME_LEN * 100)
    expect(audio.vbr).toBe(false)
    expect(audio.bitrate).toBe(128)
    expect(audio.durationSec).toBeCloseTo((FRAME_LEN * 100 * 8) / 128000, 4)
  })

  it('prefers the Xing frame count for VBR files', () => {
    const audio = parseMp3Audio(mpegFrames(3, xingHeader(100, 41700)), 999999)
    expect(audio.vbr).toBe(true)
    expect(audio.durationSec).toBeCloseTo((100 * 1152) / 44100, 4)
    expect(audio.bitrate).toBe(128)
  })

  it('returns a null duration rather than a guess when the size is unknown', () => {
    const audio = parseMp3Audio(mpegFrames(3))
    expect(audio.bitrate).toBe(128)
    expect(audio.durationSec).toBeNull()
  })

  it('returns null when there is no audio at all', () => {
    expect(parseMp3Audio(Buffer.alloc(4000, 0x20), 4000)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Combined MP3
// ─────────────────────────────────────────────────────────────────────────────

describe('parseMp3Metadata', () => {
  it('combines an ID3v2 tag with audio properties found after it', () => {
    const tag = buildId3v2({ frames: [{ id: 'TIT2', data: encodeText('Combined', 3) }] })
    const file = Buffer.concat([tag, mpegFrames(3)])
    const out = parseMp3Metadata(file, file.subarray(file.length - 128), file.length)
    expect(out.kind).toBe('mp3')
    expect(out.fields.title).toBe('Combined')
    expect(out.audio.sampleRate).toBe(44100)
    expect(out.audio.channelMode).toBe('stereo')
  })

  it('falls back to ID3v1 for fields ID3v2 does not carry', () => {
    const tag = buildId3v2({ frames: [{ id: 'TIT2', data: encodeText('V2 Title', 3) }] })
    const v1 = buildId3v1({ title: 'V1 Title', artist: 'V1 Artist', year: '1990' })
    const file = Buffer.concat([tag, mpegFrames(2), v1])
    const out = parseMp3Metadata(file, file.subarray(file.length - 128), file.length)
    expect(out.fields.title).toBe('V2 Title')     // v2 wins
    expect(out.fields.artist).toBe('V1 Artist')   // v1 fills the gap
    expect(out.fields.year).toBe('1990')
  })

  it('works from an ID3v1 tag alone', () => {
    const v1 = buildId3v1({ title: 'Only V1' })
    const file = Buffer.concat([Buffer.alloc(512, 0x20), v1])
    const out = parseMp3Metadata(file, file.subarray(file.length - 128), file.length)
    expect(out.kind).toBe('mp3')
    expect(out.fields.title).toBe('Only V1')
    expect(out.audio.bitrate).toBeNull()
  })

  it('returns null for a file that is not an MP3', () => {
    const text = Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(40), 'utf8')
    expect(parseMp3Metadata(text, text.subarray(text.length - 128), text.length)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PE / version info
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_STRINGS = {
  CompanyName: 'Contoso Ltd.',
  FileDescription: 'Widget Host',
  FileVersion: '1.2.3.4',
  InternalName: 'widgethost',
  LegalCopyright: '(c) 2026 Contoso',
  OriginalFilename: 'widgethost.exe',
  ProductName: 'Contoso Widgets',
  ProductVersion: '5.6.7.8'
}

describe('parseVersionBlock', () => {
  it('reads the fixed version numbers and the string table', () => {
    const fields = parseVersionBlock(buildVersionBlock(SAMPLE_STRINGS, [1, 2, 3, 4], [5, 6, 7, 8]))
    expect(fields.FixedFileVersion).toBe('1.2.3.4')
    expect(fields.FixedProductVersion).toBe('5.6.7.8')
    for (const [k, v] of Object.entries(SAMPLE_STRINGS)) expect(fields[k]).toBe(v)
  })

  it('returns null when the block is not VS_VERSION_INFO', () => {
    expect(parseVersionBlock(versionNode('SOMETHING_ELSE', null, 0))).toBeNull()
    expect(parseVersionBlock(Buffer.alloc(4))).toBeNull()
  })

  it('does not throw on a truncated block', () => {
    const block = buildVersionBlock(SAMPLE_STRINGS)
    for (const cut of [8, 40, block.length - 10]) {
      expect(() => parseVersionBlock(block.subarray(0, cut))).not.toThrow()
    }
  })
})

describe('parsePeMetadata', () => {
  it('extracts version metadata from a PE32 image', () => {
    const out = parsePeMetadata(buildPe(buildVersionBlock(SAMPLE_STRINGS)))
    expect(out.kind).toBe('pe')
    expect(out.fields.CompanyName).toBe('Contoso Ltd.')
    expect(out.fields.OriginalFilename).toBe('widgethost.exe')
    expect(out.fields.FixedFileVersion).toBe('1.2.3.4')
  })

  it('extracts version metadata from a PE32+ image', () => {
    const out = parsePeMetadata(buildPe(buildVersionBlock(SAMPLE_STRINGS), { pe32Plus: true }))
    expect(out.fields.ProductName).toBe('Contoso Widgets')
  })

  it('exposes the parsed section table and resource directory', () => {
    const headers = parsePeHeaders(buildPe(buildVersionBlock(SAMPLE_STRINGS)))
    expect(headers.sections).toHaveLength(1)
    expect(headers.sections[0].name).toBe('.rsrc')
    expect(headers.resource.rva).toBe(0x1000)
    expect(sectionForRva(headers.sections, 0x1000).name).toBe('.rsrc')
    expect(sectionForRva(headers.sections, 0x99999)).toBeNull()
  })

  it('returns null for non-PE input instead of throwing', () => {
    expect(parsePeMetadata(Buffer.from('#!/bin/sh\necho hi\n', 'utf8'))).toBeNull()
    expect(parsePeMetadata(Buffer.alloc(0))).toBeNull()
    expect(parsePeMetadata(mpegFrames(3))).toBeNull()
    expect(parsePeHeaders(Buffer.alloc(1024))).toBeNull()
  })

  it('returns null for an MZ stub with no PE signature', () => {
    const stub = Buffer.alloc(1024)
    stub.write('MZ', 0, 'latin1')
    stub.writeUInt32LE(0x80, 0x3c)
    expect(parsePeMetadata(stub)).toBeNull()
  })

  it('reports an empty field set for a PE with no version resource', () => {
    const pe = buildPe(buildVersionBlock(SAMPLE_STRINGS))
    const headers = parsePeHeaders(pe)
    // Blank the resource data directory entry.
    const dirOff = headers.peOffset + 24 + 96 + 2 * 8
    pe.writeUInt32LE(0, dirOff)
    pe.writeUInt32LE(0, dirOff + 4)
    expect(parsePeMetadata(pe)).toEqual({ kind: 'pe', fields: {} })
  })

  it('does not throw when the resource tree points outside the section', () => {
    const pe = buildPe(buildVersionBlock(SAMPLE_STRINGS))
    const headers = parsePeHeaders(pe)
    const sec = headers.sections[0]
    pe.writeUInt32LE(0xdeadbe, sec.rawPointer + 72)   // bogus leaf RVA
    expect(() => parsePeMetadata(pe)).not.toThrow()
    expect(parsePeMetadata(pe).fields).toEqual({})
  })

  it('returns null from findVersionResource when the root is out of range', () => {
    expect(findVersionResource(Buffer.alloc(32), 0x1000, 0x9000)).toBeNull()
    expect(findVersionResource(null, 0, 0)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// diffMetadata
// ─────────────────────────────────────────────────────────────────────────────

describe('diffMetadata', () => {
  it('marks equal and differing fields', () => {
    const rows = diffMetadata(
      { title: 'Same', artist: 'Left Artist' },
      { title: 'Same', artist: 'Right Artist' },
      MP3_FIELDS
    )
    const byField = Object.fromEntries(rows.map((r) => [r.field, r]))
    expect(byField.title.same).toBe(true)
    expect(byField.artist).toMatchObject({
      left: 'Left Artist', right: 'Right Artist', same: false,
      leftPresent: true, rightPresent: true
    })
  })

  it('distinguishes a missing field from an empty one', () => {
    const rows = diffMetadata({ comment: '' }, {}, MP3_FIELDS)
    expect(rows).toEqual([{
      field: 'comment', left: '', right: null,
      leftPresent: true, rightPresent: false, same: false
    }])
  })

  it('treats two empty strings as the same and two absences as the same', () => {
    const rows = diffMetadata({ album: '' }, { album: '' }, MP3_FIELDS)
    expect(rows).toHaveLength(1)
    expect(rows[0].same).toBe(true)
    expect(diffMetadata({}, {}, MP3_FIELDS)).toEqual([])
  })

  it('reports a field present only on the right', () => {
    const rows = diffMetadata({}, { genre: 'Jazz' }, MP3_FIELDS)
    expect(rows).toEqual([{
      field: 'genre', left: null, right: 'Jazz',
      leftPresent: false, rightPresent: true, same: false
    }])
  })

  it('follows the canonical order, then appends unknown fields sorted', () => {
    const rows = diffMetadata(
      { zeta: '1', title: 'T', alpha: '2' },
      { year: '2000' },
      MP3_FIELDS
    )
    expect(rows.map((r) => r.field)).toEqual(['title', 'year', 'alpha', 'zeta'])
  })

  it('works without a canonical order and tolerates null inputs', () => {
    expect(diffMetadata({ b: '1', a: '2' }, null).map((r) => r.field)).toEqual(['a', 'b'])
    expect(diffMetadata(null, null)).toEqual([])
  })

  it('compares PE version fields', () => {
    const left = parsePeMetadata(buildPe(buildVersionBlock(SAMPLE_STRINGS))).fields
    const right = parsePeMetadata(
      buildPe(buildVersionBlock({ ...SAMPLE_STRINGS, FileVersion: '2.0.0.0' }, [2, 0, 0, 0]))
    ).fields
    const rows = diffMetadata(left, right, PE_FIELDS)
    const byField = Object.fromEntries(rows.map((r) => [r.field, r]))
    expect(byField.FileVersion.same).toBe(false)
    expect(byField.FixedFileVersion).toMatchObject({ left: '1.2.3.4', right: '2.0.0.0' })
    expect(byField.CompanyName.same).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// readMetadata (bounded file access)
// ─────────────────────────────────────────────────────────────────────────────

describe('readMetadata', () => {
  /** @type {string} */
  let dir

  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'mycompare-meta-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reads an MP3 without loading the whole file', async () => {
    const tag = buildId3v2({
      frames: [
        { id: 'TIT2', data: encodeText('From Disk', 3) },
        { id: 'TPE1', data: encodeText('Disk Artist', 3) }
      ]
    })
    // Deliberately larger than every read budget in metadata.js.
    const filler = Buffer.alloc(3 * 1024 * 1024, 0x00)
    const file = Buffer.concat([tag, mpegFrames(4), filler, buildId3v1({ album: 'Tail Album' })])
    const p = join(dir, 'sample.mp3')
    await writeFile(p, file)

    const out = await readMetadata(p)
    expect(out.kind).toBe('mp3')
    expect(out.fields.title).toBe('From Disk')
    expect(out.fields.album).toBe('Tail Album')
    expect(out.audio.sampleRate).toBe(44100)
    expect(out.audio.durationSec).toBeGreaterThan(0)
  })

  it('reads PE version info from an on-disk image', async () => {
    const p = join(dir, 'sample.exe')
    await writeFile(p, buildPe(buildVersionBlock(SAMPLE_STRINGS)))
    const out = await readMetadata(p)
    expect(out.kind).toBe('pe')
    expect(out.fields.InternalName).toBe('widgethost')
    expect(out.fields.FixedProductVersion).toBe('5.6.7.8')
  })

  it('reports unknown for an ordinary text file', async () => {
    const p = join(dir, 'notes.txt')
    await writeFile(p, 'just some notes, nothing binary here\n'.repeat(50))
    expect(await readMetadata(p)).toEqual({ kind: 'unknown', fields: {} })
  })

  it('reports unknown for an empty file', async () => {
    const p = join(dir, 'empty.bin')
    await writeFile(p, Buffer.alloc(0))
    expect(await readMetadata(p)).toEqual({ kind: 'unknown', fields: {} })
  })

  it('reports unknown for a one-byte file', async () => {
    const p = join(dir, 'tiny.bin')
    await writeFile(p, Buffer.from([0xff]))
    expect(await readMetadata(p)).toEqual({ kind: 'unknown', fields: {} })
  })

  it('does not throw on a truncated PE image', async () => {
    const p = join(dir, 'broken.exe')
    await writeFile(p, buildPe(buildVersionBlock(SAMPLE_STRINGS)).subarray(0, 300))
    await expect(readMetadata(p)).resolves.toBeDefined()
  })
})
