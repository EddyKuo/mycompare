/**
 * @file metadata.js
 * @description Metadata extraction backing BeyondCompare-style "MP3 Compare"
 *   and "Version Compare".
 *
 *   Both formats keep everything we need near one end of the file: ID3v2 sits
 *   in the first bytes, ID3v1 in the trailing 128, and a PE's version resource
 *   is reachable from the section table. Nothing here ever loads a whole file —
 *   `readMetadata()` reads a handful of bounded windows through a single file
 *   handle, which matters because these views get pointed at multi-gigabyte
 *   media and installer payloads.
 *
 *   Everything below `readMetadata()` is a pure Buffer -> object function so the
 *   parsers can be exercised without touching the filesystem.
 */

import { open } from 'fs/promises'

// ── Read budgets ───────────────────────────────────────────────────────────
// Sized so a pathological or hostile header cannot be used to make the main
// process allocate without bound.
const SNIFF_BYTES = 4096
const MAX_ID3_BYTES = 1 << 20        // 1 MiB — huge even for embedded artwork
const AUDIO_SCAN_BYTES = 64 * 1024   // window after the tag to find a frame sync
const MAX_PE_HEADER_BYTES = 64 * 1024
// Window used to walk the resource *tree*. The tree sits at the start of the
// section, so a prefix is enough; the leaf it points at is read separately
// (see `_readPeMetadata`) because it can live anywhere in the section.
const MAX_RSRC_BYTES = 8 * 1024 * 1024
// A VS_VERSIONINFO block is a kilobyte or two even with 24 translations.
const MAX_VERSION_BYTES = 1 << 20
const ID3V1_SIZE = 128

/**
 * @typedef {Record<string, string>} MetadataFields
 *
 * @typedef {object} AudioInfo
 * @property {number|null} bitrate      kbps; null when it cannot be read
 * @property {number|null} sampleRate   Hz
 * @property {string|null} channelMode
 * @property {number|null} durationSec
 * @property {string|null} mpegVersion
 * @property {number|null} layer
 * @property {boolean} vbr
 *
 * @typedef {object} MetadataResult
 * @property {'mp3'|'pe'|'unknown'} kind
 * @property {MetadataFields} fields
 * @property {AudioInfo} [audio]
 */

/** Canonical display order for MP3 metadata. */
export const MP3_FIELDS = Object.freeze([
  'title', 'artist', 'album', 'albumArtist', 'composer',
  'year', 'track', 'genre', 'comment'
])

/** Canonical display order for PE version metadata. */
export const PE_FIELDS = Object.freeze([
  'FileVersion', 'ProductVersion', 'FixedFileVersion', 'FixedProductVersion',
  'CompanyName', 'FileDescription', 'InternalName', 'OriginalFilename',
  'ProductName', 'LegalCopyright'
])

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a 28-bit synchsafe integer (7 bits per byte).
 *
 * Returns -1 rather than a wrong number when a high bit is set: several
 * encoders wrote plain big-endian sizes into ID3v2.4 frames, and callers need
 * to be able to tell that apart and retry.
 *
 * @param {Buffer} buf
 * @param {number} off
 * @returns {number} value, or -1 when the bytes are not synchsafe
 */
function _readSynchsafe(buf, off) {
  if (off < 0 || off + 4 > buf.length) return -1
  let v = 0
  for (let i = 0; i < 4; i++) {
    const b = buf[off + i]
    if (b & 0x80) return -1
    v = (v << 7) | b
  }
  return v
}

/**
 * Reverse ID3 unsynchronisation: every `FF 00` pair stands for a literal `FF`.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function _deUnsync(buf) {
  const out = Buffer.allocUnsafe(buf.length)
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    out[n++] = buf[i]
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i++
  }
  return out.subarray(0, n)
}

/**
 * @param {string} s
 * @returns {string}
 */
function _firstValue(s) {
  const i = s.indexOf('\0')
  return (i >= 0 ? s.slice(0, i) : s).trim()
}

/**
 * @param {Buffer} buf
 * @param {boolean} littleEndian
 * @returns {string}
 */
function _decodeUtf16(buf, littleEndian) {
  let b = buf
  if (b.length % 2 === 1) b = b.subarray(0, b.length - 1)
  if (b.length === 0) return ''
  if (!littleEndian) {
    // swap16 mutates, so copy — the caller's buffer may be a view onto the
    // shared file read.
    b = Buffer.from(b)
    b.swap16()
  }
  return _firstValue(b.toString('utf16le'))
}

/**
 * Decode an ID3v2 text payload according to its encoding byte.
 * @param {Buffer} buf payload without the encoding byte
 * @param {number} encoding 0=ISO-8859-1, 1=UTF-16+BOM, 2=UTF-16BE, 3=UTF-8
 * @returns {string}
 */
function _decodeText(buf, encoding) {
  switch (encoding) {
    case 1: {
      if (buf.length < 2) return ''
      const bom = buf.readUInt16LE(0)
      if (bom === 0xfeff) return _decodeUtf16(buf.subarray(2), true)
      if (bom === 0xfffe) return _decodeUtf16(buf.subarray(2), false)
      return _decodeUtf16(buf, true)   // BOM promised but missing; LE is the common guess
    }
    case 2: return _decodeUtf16(buf, false)
    case 3: return _firstValue(buf.toString('utf8'))
    default: return _firstValue(buf.toString('latin1'))
  }
}

/**
 * Split a NUL-terminated string off the front of a frame payload, honouring
 * the 2-byte terminator used by the UTF-16 encodings.
 *
 * @param {Buffer} buf
 * @param {number} encoding
 * @returns {[Buffer, Buffer]} [head, rest]
 */
function _splitTerminated(buf, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let i = 0; i + 1 < buf.length; i += 2) {
      if (buf[i] === 0 && buf[i + 1] === 0) return [buf.subarray(0, i), buf.subarray(i + 2)]
    }
  } else {
    const i = buf.indexOf(0)
    if (i >= 0) return [buf.subarray(0, i), buf.subarray(i + 1)]
  }
  return [buf, buf.subarray(buf.length)]
}

/** ID3v1 numeric genres, extended with the Winamp additions. */
const GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop',
  'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock',
  'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack',
  'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance',
  'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop',
  'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic',
  'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret',
  'New Wave', 'Psychadelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal',
  'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
  'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebob', 'Latin',
  'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock',
  'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus',
  'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera',
  'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove',
  'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad',
  'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo',
  'A Cappella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House',
  'Hardcore', 'Terror', 'Indie', 'BritPop', 'Negerpunk', 'Polsk Punk', 'Beat',
  'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover',
  'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal',
  'Anime', 'Jpop', 'Synthpop'
]

/**
 * ID3v2 genre frames may carry a bare `17`, a `(17)` reference, or `(17)Remix`.
 * @param {string} raw
 * @returns {string}
 */
function _resolveGenre(raw) {
  const text = raw.trim()
  const ref = /^\((\d{1,3})\)(.*)$/.exec(text)
  if (ref) {
    const rest = ref[2].trim()
    if (rest) return rest
    return GENRES[Number(ref[1])] ?? text
  }
  if (/^\d{1,3}$/.test(text)) return GENRES[Number(text)] ?? text
  return text
}

// ─────────────────────────────────────────────────────────────────────────────
// ID3
// ─────────────────────────────────────────────────────────────────────────────

/** Frame id -> our field name. v2.3 and v2.4 spell the year differently. */
const FRAME_MAP = {
  TIT2: 'title',
  TPE1: 'artist',
  TALB: 'album',
  TPE2: 'albumArtist',
  TCOM: 'composer',
  TRCK: 'track',
  TCON: 'genre',
  TYER: 'year',   // v2.3
  TDRC: 'year',   // v2.4
  TDRL: 'year',   // v2.4 release date, used when TDRC is absent
  COMM: 'comment'
}

/**
 * Parse an ID3v2.3 / ID3v2.4 tag from the start of a file.
 *
 * @param {Buffer} buf bytes from file offset 0 (may be shorter than the tag)
 * @returns {{ version: number, tagBytes: number, fields: MetadataFields }|null}
 *   null when there is no usable ID3v2 tag
 */
export function parseId3v2(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null

  const major = buf[3]
  if (major !== 3 && major !== 4) return null

  const flags = buf[5]
  const declaredSize = _readSynchsafe(buf, 6)
  if (declaredSize <= 0) return null

  // A v2.4 footer is 10 more bytes the audio starts after.
  const tagBytes = 10 + declaredSize + ((major === 4 && (flags & 0x10)) ? 10 : 0)

  let body = buf.subarray(10, Math.min(10 + declaredSize, buf.length))
  if (flags & 0x80) body = _deUnsync(body)

  let pos = 0
  if (flags & 0x40) {
    if (body.length < 4) return { version: major, tagBytes, fields: {} }
    // v2.4 counts the size field itself; v2.3 does not.
    const extSize = major === 4 ? _readSynchsafe(body, 0) : body.readUInt32BE(0)
    pos = major === 4 ? extSize : 4 + extSize
    if (!(pos > 0) || pos >= body.length) return { version: major, tagBytes, fields: {} }
  }

  /** @type {Record<string, string>} */
  const raw = {}

  while (pos + 10 <= body.length) {
    const id = body.toString('latin1', pos, pos + 4)
    if (id.charCodeAt(0) === 0) break                 // padding
    if (!/^[A-Z][A-Z0-9]{3}$/.test(id)) break         // garbage: stop, don't guess

    let size = major === 4 ? _readSynchsafe(body, pos + 4) : body.readUInt32BE(pos + 4)
    if (size < 0) size = body.readUInt32BE(pos + 4)   // encoder wrote a non-synchsafe size
    const frameFlags = body.readUInt16BE(pos + 8)
    pos += 10

    let truncated = false
    if (size < 0 || pos + size > body.length) {
      size = body.length - pos
      truncated = true
    }
    if (size <= 0) break

    let data = body.subarray(pos, pos + size)
    pos += size

    const encrypted = major === 4 ? (frameFlags & 0x0004) : (frameFlags & 0x0040)
    const compressed = major === 4 ? (frameFlags & 0x0008) : (frameFlags & 0x0080)
    if (!encrypted && !compressed) {
      if (major === 4) {
        if (frameFlags & 0x0002) data = _deUnsync(data)
        if (frameFlags & 0x0040) data = data.subarray(1)   // group identifier
        if (frameFlags & 0x0001) data = data.subarray(4)   // data length indicator
      }
      const field = FRAME_MAP[id]
      if (field && raw[field] === undefined) {
        const value = id === 'COMM' ? _decodeComment(data) : _decodeTextFrame(data)
        if (value !== null) raw[field] = value
      }
    }

    if (truncated) break
  }

  if (raw.genre !== undefined) raw.genre = _resolveGenre(raw.genre)
  return { version: major, tagBytes, fields: raw }
}

/**
 * @param {Buffer} data
 * @returns {string|null}
 */
function _decodeTextFrame(data) {
  if (data.length < 1) return null
  return _decodeText(data.subarray(1), data[0])
}

/**
 * COMM carries an encoding byte, a 3-byte language code and a short
 * description before the text we actually want.
 * @param {Buffer} data
 * @returns {string|null}
 */
function _decodeComment(data) {
  if (data.length < 5) return null
  const encoding = data[0]
  const [, rest] = _splitTerminated(data.subarray(4), encoding)
  return _decodeText(rest, encoding)
}

/**
 * Parse the trailing ID3v1 / ID3v1.1 tag.
 *
 * @param {Buffer} buf the file's last bytes; the tag is looked for at the end
 * @returns {MetadataFields|null}
 */
export function parseId3v1(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < ID3V1_SIZE) return null
  const off = buf.length - ID3V1_SIZE
  if (buf.toString('latin1', off, off + 3) !== 'TAG') return null

  /** @param {number} start @param {number} len */
  const str = (start, len) =>
    _firstValue(buf.toString('latin1', off + start, off + start + len)).replace(/\s+$/, '')

  /** @type {MetadataFields} */
  const fields = {}
  const put = (k, v) => { if (v) fields[k] = v }

  put('title', str(3, 30))
  put('artist', str(33, 30))
  put('album', str(63, 30))
  put('year', str(93, 4))
  put('comment', str(97, 30))

  // ID3v1.1 steals the last two comment bytes for a track number.
  if (buf[off + 125] === 0 && buf[off + 126] !== 0) {
    fields.track = String(buf[off + 126])
  }
  const genre = buf[off + 127]
  if (GENRES[genre]) fields.genre = GENRES[genre]

  return fields
}

// ─────────────────────────────────────────────────────────────────────────────
// MPEG audio frame header
// ─────────────────────────────────────────────────────────────────────────────

const BITRATES = {
  // [versionKey][layer] -> kbps indexed by the 4-bit bitrate index
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
}
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] }
const CHANNEL_MODES = ['stereo', 'joint stereo', 'dual channel', 'mono']

/**
 * Decode a 4-byte MPEG audio frame header.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ mpegVersion: string, layer: number, bitrate: number, sampleRate: number,
 *             channelMode: string, samplesPerFrame: number, frameLength: number }|null}
 */
export function parseMpegFrameHeader(buf, offset) {
  if (!Buffer.isBuffer(buf) || offset < 0 || offset + 4 > buf.length) return null
  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xe0) !== 0xe0) return null

  const versionBits = (buf[offset + 1] >> 3) & 0x03
  const layerBits = (buf[offset + 1] >> 1) & 0x03
  if (versionBits === 1 || layerBits === 0) return null   // reserved

  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5
  const layer = 4 - layerBits

  const bitrateIndex = (buf[offset + 2] >> 4) & 0x0f
  const sampleIndex = (buf[offset + 2] >> 2) & 0x03
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null

  const bitrate = BITRATES[`${version === 1 ? 1 : 2}-${layer}`][bitrateIndex]
  const sampleRate = SAMPLE_RATES[version][sampleIndex]
  if (!bitrate || !sampleRate) return null

  const padding = (buf[offset + 2] >> 1) & 0x01
  const channelMode = CHANNEL_MODES[(buf[offset + 3] >> 6) & 0x03]

  const samplesPerFrame = layer === 1 ? 384 : (layer === 3 && version !== 1) ? 576 : 1152
  const frameLength = layer === 1
    ? (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4
    : Math.floor((samplesPerFrame / 8 * bitrate * 1000) / sampleRate) + padding

  return { mpegVersion: String(version), layer, bitrate, sampleRate, channelMode, samplesPerFrame, frameLength }
}

/**
 * Locate the first plausible MPEG frame.
 *
 * A lone `FF Ex` byte pair occurs constantly in arbitrary data, so a candidate
 * is only accepted when a second valid header sits exactly one frame later —
 * unless the buffer ends first, in which case there is nothing to corroborate
 * against and the single header is the best available answer.
 *
 * @param {Buffer} buf
 * @param {number} [start]
 * @returns {{ offset: number, header: ReturnType<typeof parseMpegFrameHeader> }|null}
 */
export function findMpegFrame(buf, start = 0) {
  if (!Buffer.isBuffer(buf)) return null
  for (let i = Math.max(0, start); i + 4 <= buf.length; i++) {
    if (buf[i] !== 0xff) continue
    const header = parseMpegFrameHeader(buf, i)
    if (!header) continue
    const next = i + header.frameLength
    if (next + 4 <= buf.length && !parseMpegFrameHeader(buf, next)) continue
    return { offset: i, header }
  }
  return null
}

/**
 * Derive audio properties from the first frame, preferring a Xing/Info or VBRI
 * frame count when one is present (a CBR extrapolation is badly wrong for VBR
 * files, and reporting a wrong duration is worse than reporting none).
 *
 * @param {Buffer} buf bytes containing the start of the audio stream
 * @param {number} [audioBytes] size of the audio stream, for the CBR estimate
 * @returns {AudioInfo|null}
 */
export function parseMp3Audio(buf, audioBytes) {
  const found = findMpegFrame(buf)
  if (!found) return null
  const h = found.header

  /** @type {AudioInfo} */
  const audio = {
    bitrate: h.bitrate,
    sampleRate: h.sampleRate,
    channelMode: h.channelMode,
    durationSec: null,
    mpegVersion: h.mpegVersion,
    layer: h.layer,
    vbr: false
  }

  const vbrFrames = _readVbrFrameCount(buf, found.offset, h)
  if (vbrFrames && vbrFrames.frames > 0) {
    audio.vbr = true
    audio.durationSec = (vbrFrames.frames * h.samplesPerFrame) / h.sampleRate
    if (vbrFrames.bytes > 0 && audio.durationSec > 0) {
      audio.bitrate = Math.round((vbrFrames.bytes * 8) / audio.durationSec / 1000)
    }
  } else if (typeof audioBytes === 'number' && audioBytes > 0) {
    audio.durationSec = (audioBytes * 8) / (h.bitrate * 1000)
  }

  return audio
}

/**
 * @param {Buffer} buf
 * @param {number} frameOffset
 * @param {{ mpegVersion: string, channelMode: string }} h
 * @returns {{ frames: number, bytes: number }|null}
 */
function _readVbrFrameCount(buf, frameOffset, h) {
  const mono = h.channelMode === 'mono'
  const sideInfo = h.mpegVersion === '1' ? (mono ? 17 : 32) : (mono ? 9 : 17)
  const xing = frameOffset + 4 + sideInfo

  if (xing + 8 <= buf.length) {
    const tag = buf.toString('latin1', xing, xing + 4)
    if (tag === 'Xing' || tag === 'Info') {
      const flags = buf.readUInt32BE(xing + 4)
      let p = xing + 8
      let frames = 0
      let bytes = 0
      if (flags & 0x01) { if (p + 4 > buf.length) return null; frames = buf.readUInt32BE(p); p += 4 }
      if (flags & 0x02) { if (p + 4 > buf.length) return null; bytes = buf.readUInt32BE(p) }
      return { frames, bytes }
    }
  }

  const vbri = frameOffset + 36
  if (vbri + 26 <= buf.length && buf.toString('latin1', vbri, vbri + 4) === 'VBRI') {
    return { frames: buf.readUInt32BE(vbri + 14), bytes: buf.readUInt32BE(vbri + 10) }
  }
  return null
}

/**
 * Combine ID3v2, ID3v1 and audio-frame information into one MP3 result.
 *
 * @param {Buffer} head bytes from offset 0
 * @param {Buffer|null} tail the file's last bytes (>= 128 to find ID3v1)
 * @param {number} [fileSize] total file size, used for the duration estimate
 * @returns {MetadataResult|null} null when this is not an MP3
 */
export function parseMp3Metadata(head, tail, fileSize) {
  const v2 = parseId3v2(head)
  const v1 = tail ? parseId3v1(tail) : null

  const audioStart = v2 ? v2.tagBytes : 0
  const audio = audioStart < head.length
    ? parseMp3Audio(
      head.subarray(audioStart),
      typeof fileSize === 'number'
        ? Math.max(0, fileSize - audioStart - (v1 ? ID3V1_SIZE : 0))
        : undefined
    )
    : null

  if (!v2 && !v1 && !audio) return null

  // v2 wins on conflict; v1 only fills gaps.
  /** @type {MetadataFields} */
  const fields = { ...(v1 ?? {}), ...(v2?.fields ?? {}) }

  return { kind: 'mp3', fields, audio: audio ?? _emptyAudio() }
}

/** @returns {AudioInfo} */
function _emptyAudio() {
  return {
    bitrate: null, sampleRate: null, channelMode: null,
    durationSec: null, mpegVersion: null, layer: null, vbr: false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PE / VS_VERSIONINFO
// ─────────────────────────────────────────────────────────────────────────────

const RT_VERSION = 16
const VS_FIXEDFILEINFO_SIGNATURE = 0xfeef04bd
/** Data-directory slot holding the resource table. */
const RESOURCE_DIR_INDEX = 2
/**
 * The resource *name* Windows looks for under RT_VERSION. `GetFileVersionInfo`
 * does the equivalent of `FindResource(hMod, MAKEINTRESOURCE(1), RT_VERSION)`,
 * so a block filed under any other name is not the file's version information
 * and must not be read as if it were.
 */
const VS_VERSION_INFO_ID = 1
/** en-US, the language Microsoft's own toolchain files version resources under. */
const LANG_EN_US = 0x0409
/** LANG_NEUTRAL / SUBLANG_NEUTRAL. */
const LANG_NEUTRAL = 0x0000

/**
 * @typedef {object} PeSection
 * @property {string} name
 * @property {number} virtualAddress
 * @property {number} virtualSize
 * @property {number} rawPointer
 * @property {number} rawSize
 *
 * @typedef {object} PeHeaders
 * @property {number} peOffset
 * @property {boolean} pe32Plus
 * @property {PeSection[]} sections
 * @property {{ rva: number, size: number }|null} resource
 */

/**
 * Parse the DOS/COFF/optional headers and section table of a PE image.
 *
 * @param {Buffer} buf bytes from offset 0 (64 KiB is ample for any real PE)
 * @returns {PeHeaders|null} null when `buf` is not a PE image
 */
export function parsePeHeaders(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x40) return null
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return null            // 'MZ'

  const peOffset = buf.readUInt32LE(0x3c)
  if (peOffset < 0 || peOffset + 24 > buf.length) return null
  if (buf.readUInt32LE(peOffset) !== 0x00004550) return null     // 'PE\0\0'

  const numberOfSections = buf.readUInt16LE(peOffset + 6)
  const sizeOfOptionalHeader = buf.readUInt16LE(peOffset + 20)
  const optOffset = peOffset + 24
  if (sizeOfOptionalHeader < 2 || optOffset + sizeOfOptionalHeader > buf.length) return null

  const magic = buf.readUInt16LE(optOffset)
  const pe32Plus = magic === 0x20b
  if (magic !== 0x10b && !pe32Plus) return null

  // Data directories start after the fixed part of the optional header, whose
  // length differs between PE32 and PE32+.
  const dirOffset = optOffset + (pe32Plus ? 112 : 96)
  /** @type {{ rva: number, size: number }|null} */
  let resource = null
  if (dirOffset + RESOURCE_DIR_INDEX * 8 + 8 <= optOffset + sizeOfOptionalHeader &&
      dirOffset + RESOURCE_DIR_INDEX * 8 + 8 <= buf.length) {
    const rva = buf.readUInt32LE(dirOffset + RESOURCE_DIR_INDEX * 8)
    const size = buf.readUInt32LE(dirOffset + RESOURCE_DIR_INDEX * 8 + 4)
    if (rva > 0 && size > 0) resource = { rva, size }
  }

  /** @type {PeSection[]} */
  const sections = []
  let sec = optOffset + sizeOfOptionalHeader
  for (let i = 0; i < numberOfSections && sec + 40 <= buf.length; i++, sec += 40) {
    sections.push({
      name: _firstValue(buf.toString('latin1', sec, sec + 8)),
      virtualSize: buf.readUInt32LE(sec + 8),
      virtualAddress: buf.readUInt32LE(sec + 12),
      rawSize: buf.readUInt32LE(sec + 16),
      rawPointer: buf.readUInt32LE(sec + 20)
    })
  }

  return { peOffset, pe32Plus, sections, resource }
}

/**
 * Find the section that maps a given RVA.
 * @param {PeSection[]} sections
 * @param {number} rva
 * @returns {PeSection|null}
 */
export function sectionForRva(sections, rva) {
  for (const s of sections) {
    const span = Math.max(s.virtualSize, s.rawSize)
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) return s
  }
  return null
}

/**
 * @typedef {object} ResourceEntry
 * @property {number} id      numeric id, or -1 for a named (string) entry
 * @property {number} target  offset of the entry's target within the buffer
 * @property {boolean} isSubdir
 */

/**
 * List the entries of one resource directory.
 *
 * @param {Buffer} buf
 * @param {number} root base of the resource directory
 * @param {number} dir offset of the directory to scan
 * @returns {ResourceEntry[]}
 */
function _dirEntries(buf, root, dir) {
  /** @type {ResourceEntry[]} */
  const out = []
  if (dir < 0 || dir + 16 > buf.length) return out
  const total = buf.readUInt16LE(dir + 12) + buf.readUInt16LE(dir + 14)
  for (let i = 0; i < total; i++) {
    const e = dir + 16 + i * 8
    if (e + 8 > buf.length) break
    const nameField = buf.readUInt32LE(e)
    const offsetField = buf.readUInt32LE(e + 4)
    const target = root + (offsetField & 0x7fffffff)
    if (target < 0 || target >= buf.length) continue
    out.push({
      // Named entries have the high bit set; they can never match a numeric id.
      id: (nameField & 0x80000000) !== 0 ? -1 : nameField,
      target,
      isSubdir: (offsetField & 0x80000000) !== 0
    })
  }
  return out
}

/**
 * Choose which translation of a resource to read.
 *
 * A binary may file the same resource under many languages — MRT.exe carries 24
 * — and picking whichever the tree happens to list first is picking by build
 * order. Windows resolves this against the calling thread's UI language, but a
 * comparison tool must not: two machines diffing the same pair of files have to
 * reach the same verdict, so the choice here is fixed rather than ambient.
 *
 * Order: en-US, then language-neutral, then the numerically lowest id present.
 * en-US comes first because that is what Microsoft's toolchain files version
 * resources under, and because every field this module reports except
 * FileDescription is language-invariant in practice.
 *
 * @param {number[]} langs available language ids
 * @returns {number} the chosen id; -1 when `langs` is empty
 */
export function pickResourceLanguage(langs) {
  if (!Array.isArray(langs) || langs.length === 0) return -1
  if (langs.includes(LANG_EN_US)) return LANG_EN_US
  if (langs.includes(LANG_NEUTRAL)) return LANG_NEUTRAL
  return langs.reduce((a, b) => (b < a ? b : a))
}

/**
 * Locate the VS_VERSIONINFO leaf without reading it.
 *
 * Returns the leaf's own RVA rather than a slice of `rsrc`, because the leaf can
 * sit hundreds of megabytes past the directory that names it: the caller maps
 * that RVA through the section table itself and reads only those bytes.
 *
 * @param {Buffer} rsrc bytes of the resource section from its PointerToRawData
 *   (a prefix is enough — the directory tree lives at the start)
 * @param {number} sectionVa the section's VirtualAddress
 * @param {number} rootRva RVA of the resource directory itself
 * @returns {{ rva: number, size: number, lang: number }|null}
 */
export function findVersionResourceEntry(rsrc, sectionVa, rootRva) {
  if (!Buffer.isBuffer(rsrc)) return null
  const root = rootRva - sectionVa
  if (root < 0 || root + 16 > rsrc.length) return null

  const type = _dirEntries(rsrc, root, root).find((e) => e.isSubdir && e.id === RT_VERSION)
  if (!type) return null

  // Name must be 1: RT_VERSION can also hold vendor blobs under other names,
  // and Windows would not read those as version information either.
  const names = _dirEntries(rsrc, root, type.target).filter((e) => e.isSubdir)
  const name = names.find((e) => e.id === VS_VERSION_INFO_ID)
  if (!name) return null

  const leaves = _dirEntries(rsrc, root, name.target).filter((e) => !e.isSubdir)
  if (leaves.length === 0) return null
  const lang = pickResourceLanguage(leaves.map((e) => e.id))
  const leaf = leaves.find((e) => e.id === lang) ?? leaves[0]
  if (leaf.target + 16 > rsrc.length) return null

  const rva = rsrc.readUInt32LE(leaf.target)
  const size = rsrc.readUInt32LE(leaf.target + 4)
  if (size <= 0 || size > MAX_VERSION_BYTES) return null
  return { rva, size, lang: leaf.id }
}

/**
 * Walk the resource tree (type -> name -> language) and return the bytes of the
 * VS_VERSIONINFO leaf, when it falls inside `rsrc`.
 *
 * @param {Buffer} rsrc raw bytes of the resource section, starting at its
 *   PointerToRawData
 * @param {number} sectionVa the section's VirtualAddress, used to turn the RVAs
 *   stored in the tree back into indices into `rsrc`
 * @param {number} rootRva RVA of the resource directory itself
 * @returns {Buffer|null}
 */
export function findVersionResource(rsrc, sectionVa, rootRva) {
  const entry = findVersionResourceEntry(rsrc, sectionVa, rootRva)
  if (!entry) return null
  const start = entry.rva - sectionVa
  if (start < 0 || start + entry.size > rsrc.length) return null
  return rsrc.subarray(start, start + entry.size)
}

/**
 * @param {number} n
 * @returns {number}
 */
function _align4(n) { return (n + 3) & ~3 }

/**
 * Read one node of the VS_VERSIONINFO tree.
 *
 * @param {Buffer} buf
 * @param {number} off
 * @returns {{ end: number, key: string, valueOffset: number, valueBytes: number,
 *             isText: boolean, childOffset: number }|null}
 */
function _readVersionNode(buf, off) {
  if (off < 0 || off + 6 > buf.length) return null
  const wLength = buf.readUInt16LE(off)
  const wValueLength = buf.readUInt16LE(off + 2)
  const wType = buf.readUInt16LE(off + 4)
  if (wLength < 6 || off + wLength > buf.length) return null

  let k = off + 6
  while (k + 1 < buf.length && buf.readUInt16LE(k) !== 0) k += 2
  const key = buf.toString('utf16le', off + 6, k)

  // Text values count UTF-16 code units, binary values count bytes.
  const valueBytes = wType === 1 ? wValueLength * 2 : wValueLength
  const valueOffset = _align4(k + 2)
  const childOffset = _align4(valueOffset + valueBytes)

  return { end: off + wLength, key, valueOffset, valueBytes, isText: wType === 1, childOffset }
}

/**
 * Parse a VS_VERSIONINFO block into flat fields.
 *
 * @param {Buffer} buf the version resource bytes
 * @param {number} [preferredLang] language id of the resource leaf this block
 *   came from, used to pick between several StringFileInfo tables
 * @returns {MetadataFields|null} null when the block is not VS_VERSION_INFO
 */
export function parseVersionBlock(buf, preferredLang = LANG_EN_US) {
  const root = _readVersionNode(buf, 0)
  if (!root || root.key !== 'VS_VERSION_INFO') return null

  /** @type {MetadataFields} */
  const fields = {}

  if (root.valueBytes >= 52 && root.valueOffset + 52 <= buf.length &&
      buf.readUInt32LE(root.valueOffset) === VS_FIXEDFILEINFO_SIGNATURE) {
    fields.FixedFileVersion = _version32(buf, root.valueOffset + 8)
    fields.FixedProductVersion = _version32(buf, root.valueOffset + 16)
  }

  for (let c = root.childOffset; c + 6 <= root.end;) {
    const child = _readVersionNode(buf, c)
    if (!child || child.end <= c) break
    if (child.key === 'StringFileInfo') _collectStringTables(buf, child, fields, preferredLang)
    c = _align4(child.end)
  }

  return fields
}

/**
 * @param {Buffer} buf
 * @param {number} off offset of dwFileVersionMS / dwProductVersionMS
 * @returns {string}
 */
function _version32(buf, off) {
  const ms = buf.readUInt32LE(off)
  const ls = buf.readUInt32LE(off + 4)
  return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`
}

/**
 * Read the string values out of a StringFileInfo block.
 *
 * A StringFileInfo may hold several StringTable children, each keyed by eight
 * hex digits: four for the language id and four for a codepage (oleaut32.dll
 * ships `040904B0` and `0c0904E4`). Tables are visited in the order the chosen
 * language prefers, and the first value seen for a key wins, so a secondary
 * table only fills gaps.
 *
 * The codepage half of the key is *not* honoured when decoding, and that is
 * deliberate: in a 32-bit PE every string in VS_VERSIONINFO is UTF-16LE
 * regardless of what the key claims. The codepage is a leftover from 16-bit
 * VER resources and today only records which codepage the strings can be
 * round-tripped through — `04B0` is 1200 (UTF-16) and `04E4` is 1252, but both
 * are stored as UTF-16. Decoding `040904E4` as 1252 would corrupt every value.
 *
 * @param {Buffer} buf
 * @param {{ end: number, childOffset: number }} sfi
 * @param {MetadataFields} out
 * @param {number} preferredLang
 */
function _collectStringTables(buf, sfi, out, preferredLang) {
  /** @type {{ node: ReturnType<typeof _readVersionNode>, lang: number }[]} */
  const tables = []
  for (let t = sfi.childOffset; t + 6 <= sfi.end;) {
    const table = _readVersionNode(buf, t)
    if (!table || table.end <= t) break
    // A malformed key parses to NaN; Number('') would be 0, which is a real
    // language id (neutral), so parse the digits explicitly.
    const lang = /^[0-9A-Fa-f]{8}$/.test(table.key) ? parseInt(table.key.slice(0, 4), 16) : -1
    tables.push({ node: table, lang })
    t = _align4(table.end)
  }

  const rank = (lang) => (lang === preferredLang ? 0 : lang === LANG_EN_US ? 1 : lang === LANG_NEUTRAL ? 2 : 3)
  const ordered = tables
    .map((entry, i) => ({ ...entry, i }))
    .sort((a, b) => rank(a.lang) - rank(b.lang) || a.i - b.i)

  for (const { node: table } of ordered) {
    for (let s = table.childOffset; s + 6 <= table.end;) {
      const str = _readVersionNode(buf, s)
      if (!str || str.end <= s) break
      if (str.isText && str.valueBytes > 0 && out[str.key] === undefined) {
        // wValueLength is specified in characters for a text value, but
        // non-Microsoft resource compilers write it in bytes — nvspcap64.dll
        // does — and doubling it then walks into the next node's key. The
        // node's own wLength is the hard bound, and the value is a single
        // NUL-terminated string, so honour whichever ends first. That is also
        // what the Windows API returns, which is why it is unaffected.
        const stop = Math.min(str.valueOffset + str.valueBytes, str.end, buf.length)
        const raw = buf.toString('utf16le', str.valueOffset, Math.max(str.valueOffset, stop))
        const nul = raw.indexOf('\0')
        out[str.key] = nul >= 0 ? raw.slice(0, nul) : raw
      }
      s = _align4(str.end)
    }
  }
}

/**
 * Extract version metadata from a complete PE image held in memory.
 * Mostly useful for tests — `readMetadata()` reads only the needed slices.
 *
 * @param {Buffer} buf
 * @returns {MetadataResult|null} null when `buf` is not a PE image
 */
export function parsePeMetadata(buf) {
  const headers = parsePeHeaders(buf)
  if (!headers) return null
  if (!headers.resource) return { kind: 'pe', fields: {} }

  const section = sectionForRva(headers.sections, headers.resource.rva)
  if (!section) return { kind: 'pe', fields: {} }

  const end = Math.min(section.rawPointer + section.rawSize, buf.length)
  if (section.rawPointer >= end) return { kind: 'pe', fields: {} }

  const entry = findVersionResourceEntry(
    buf.subarray(section.rawPointer, end), section.virtualAddress, headers.resource.rva
  )
  if (!entry) return { kind: 'pe', fields: {} }

  // The leaf's RVA is mapped through the whole section table rather than
  // assumed to land in the directory's own section.
  const block = _sliceRva(buf, headers.sections, entry.rva, entry.size)
  if (!block) return { kind: 'pe', fields: {} }
  return { kind: 'pe', fields: parseVersionBlock(block, entry.lang) ?? {} }
}

/**
 * Map an RVA to file bytes through the section table.
 *
 * @param {Buffer} buf whole image
 * @param {PeSection[]} sections
 * @param {number} rva
 * @param {number} size
 * @returns {Buffer|null}
 */
function _sliceRva(buf, sections, rva, size) {
  const section = sectionForRva(sections, rva)
  if (!section) return null
  const start = section.rawPointer + (rva - section.virtualAddress)
  if (start < 0 || size <= 0 || start + size > buf.length) return null
  return buf.subarray(start, start + size)
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} FieldDiff
 * @property {string} field
 * @property {string|null} left   null when the field is absent on the left
 * @property {string|null} right
 * @property {boolean} leftPresent  distinguishes "absent" from "present but empty"
 * @property {boolean} rightPresent
 * @property {boolean} same
 */

/**
 * Field-by-field comparison of two metadata objects, ready for the UI to render.
 *
 * A field missing on one side is reported with `left`/`right` of null and the
 * matching presence flag false, which the caller needs in order to tell an
 * absent tag apart from one that was written empty.
 *
 * @param {MetadataFields|null|undefined} left
 * @param {MetadataFields|null|undefined} right
 * @param {readonly string[]} [order] canonical field order; unlisted fields
 *   follow, sorted
 * @returns {FieldDiff[]}
 */
export function diffMetadata(left, right, order = []) {
  const l = left ?? {}
  const r = right ?? {}
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined

  const extras = [...new Set([...Object.keys(l), ...Object.keys(r)])]
    .filter((k) => !order.includes(k))
    .sort()
  const names = [...order.filter((k) => has(l, k) || has(r, k)), ...extras]

  return names.map((field) => {
    const leftPresent = has(l, field)
    const rightPresent = has(r, field)
    const lv = leftPresent ? String(l[field]) : null
    const rv = rightPresent ? String(r[field]) : null
    return {
      field,
      left: lv,
      right: rv,
      leftPresent,
      rightPresent,
      same: leftPresent === rightPresent && lv === rv
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded file access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {import('fs/promises').FileHandle} fh
 * @param {number} position
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
async function _readAt(fh, position, length) {
  if (length <= 0) return Buffer.alloc(0)
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, position)
  return buf.subarray(0, bytesRead)
}

/**
 * Read just enough of a file to describe it for MP3 / Version compare.
 *
 * The caller is responsible for validating `filePath` (see path-validator.js);
 * this function performs no authorisation of its own.
 *
 * @param {string} filePath already-validated absolute path
 * @returns {Promise<MetadataResult>}
 */
export async function readMetadata(filePath) {
  const fh = await open(filePath, 'r')
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size === 0) return { kind: 'unknown', fields: {} }
    const size = st.size

    const sniff = await _readAt(fh, 0, Math.min(SNIFF_BYTES, size))
    if (sniff.length < 2) return { kind: 'unknown', fields: {} }

    if (sniff[0] === 0x4d && sniff[1] === 0x5a) {
      const pe = await _readPeMetadata(fh, size, sniff)
      if (pe) return pe
    }

    const mp3 = await _readMp3Metadata(fh, size, sniff)
    if (mp3) return mp3

    return { kind: 'unknown', fields: {} }
  } finally {
    await fh.close()
  }
}

/**
 * @param {import('fs/promises').FileHandle} fh
 * @param {number} size
 * @param {Buffer} sniff
 * @returns {Promise<MetadataResult|null>}
 */
async function _readMp3Metadata(fh, size, sniff) {
  // The ID3v2 header advertises the tag length, so we can read the tag plus a
  // scan window instead of walking the file looking for the audio.
  let tagBytes = 0
  if (sniff.length >= 10 && sniff[0] === 0x49 && sniff[1] === 0x44 && sniff[2] === 0x33) {
    const declared = _readSynchsafe(sniff, 6)
    if (declared > 0) tagBytes = Math.min(10 + declared + 10, MAX_ID3_BYTES)
  }

  const headLen = Math.min(size, Math.max(tagBytes + AUDIO_SCAN_BYTES, SNIFF_BYTES))
  const head = headLen <= sniff.length ? sniff : await _readAt(fh, 0, headLen)

  const tailLen = Math.min(ID3V1_SIZE, size)
  const tail = size <= head.length
    ? head.subarray(Math.max(0, head.length - tailLen))
    : await _readAt(fh, size - tailLen, tailLen)

  return parseMp3Metadata(head, tail, size)
}

/**
 * @param {import('fs/promises').FileHandle} fh
 * @param {number} size
 * @param {Buffer} sniff
 * @returns {Promise<MetadataResult|null>}
 */
async function _readPeMetadata(fh, size, sniff) {
  const headLen = Math.min(size, MAX_PE_HEADER_BYTES)
  const head = headLen <= sniff.length ? sniff : await _readAt(fh, 0, headLen)

  const headers = parsePeHeaders(head)
  if (!headers) return null
  if (!headers.resource) return { kind: 'pe', fields: {} }

  const section = sectionForRva(headers.sections, headers.resource.rva)
  if (!section || section.rawSize <= 0 || section.rawPointer >= size) {
    return { kind: 'pe', fields: {} }
  }

  // Only a prefix of the resource section is pulled in — .rsrc can legitimately
  // hold hundreds of megabytes (MRT.exe's is 226 MB of signature data) and the
  // directory tree we need to walk sits at the front of it.
  const rsrcLen = Math.min(section.rawSize, size - section.rawPointer, MAX_RSRC_BYTES)
  const rsrc = await _readAt(fh, section.rawPointer, rsrcLen)

  const entry = findVersionResourceEntry(rsrc, section.virtualAddress, headers.resource.rva)
  if (!entry) return { kind: 'pe', fields: {} }

  // The leaf itself is read at its own file offset. Slicing it out of the
  // prefix above was the bug: a version resource that happens to be laid out
  // past the cap — which is where a linker puts it when the icons and
  // manifests come first — silently produced "this file has no version".
  const leafSection = sectionForRva(headers.sections, entry.rva)
  if (!leafSection) return { kind: 'pe', fields: {} }
  const leafAt = leafSection.rawPointer + (entry.rva - leafSection.virtualAddress)
  if (leafAt < 0 || leafAt + entry.size > size) return { kind: 'pe', fields: {} }
  const block = await _readAt(fh, leafAt, entry.size)
  if (block.length < entry.size) return { kind: 'pe', fields: {} }

  return { kind: 'pe', fields: parseVersionBlock(block, entry.lang) ?? {} }
}
