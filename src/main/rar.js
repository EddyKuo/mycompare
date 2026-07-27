/**
 * @file rar.js
 * @description Reading RAR archives — containers only, STORED entries only.
 *
 *   Both container generations are read here: RAR 4 (`Rar!\x1a\x07\x00`) and
 *   RAR 5 (`Rar!\x1a\x07\x01\x00`). They share a signature prefix and nothing
 *   else — RAR 4 is fixed-layout blocks with a 16-bit header CRC, RAR 5 is
 *   variable-length integers with a 32-bit one — so they are parsed by two
 *   separate walkers rather than one with branches.
 *
 *   RAR's *compression* remains out of reach. The algorithms behind methods
 *   1..5 are proprietary and nothing here can produce a compressed RAR to grade
 *   a decoder against, and a decoder that agrees only with itself is worse than
 *   an honest refusal — it returns wrong bytes and calls them right. So methods
 *   1..5 are named and refused, in both generations.
 *
 *   That leaves method 0 (RAR 5) / 0x30 (RAR 4), STORE, where the packed bytes
 *   *are* the unpacked bytes. It is implementable and it is verifiable, and
 *   this file does only that.
 *
 *   ── What has actually been verified, and what has not ──────────────────
 *
 *   Every fixture under `tests/unit/rar.test.js` is assembled byte-by-byte by
 *   this project and then handed to 7-Zip, which lists it (`Type = Rar` or
 *   `Type = Rar5`), tests it (`Everything is Ok`, which verifies the stored
 *   CRC-32 and any BLAKE2sp record independently) and extracts it. `7z x`'s
 *   output — not this codebase's — is the byte-for-byte reference. Tampering
 *   with a single data byte makes 7-Zip report `CRC Failed`, which is what
 *   proves it is verifying rather than parsing past; without that check a
 *   fixture merely well-formed enough to be listed would look validated when
 *   it is not.
 *
 *   The BLAKE2sp used for RAR 5 file-hash records is checked three ways: its
 *   BLAKE2s core against Node's `blake2s256`, the parallel tree mode against
 *   the published empty-input vector `dd0e8917…` and against 7-Zip's own
 *   `7z h -scrcBLAKE2SP`, and end-to-end by `7z t` accepting the record.
 *
 *   What none of that establishes, and it matters: **no archive written by
 *   WinRAR has ever been read here**, because none exists on this machine and
 *   nothing here can create one. 7-Zip proves the fixtures are well-formed
 *   RAR that a real reader accepts; it does not prove that every construct a
 *   real packer emits is handled. Deliberately not implemented, and refused by
 *   name rather than guessed at: all compressed methods, encrypted archives at
 *   both the header and per-file level, solid blocks, split volumes, and
 *   entries of unknown size.
 *
 *   Read `cab.js`'s note on Quantum before extending any of this. Five
 *   refusals in this codebase's history were inherited rather than checked and
 *   all five turned out to be false — including, most recently, this file's
 *   own claim that a RAR 4 could not be produced or validated here. Before
 *   writing "no tool here can do X", run the tool.
 *
 *   Everything in an archive is attacker-controlled: names, declared sizes,
 *   block lengths. Nothing here allocates on a declared number before that
 *   number has been checked against both the ceiling and the bytes actually
 *   present.
 */

import { crc32 } from './lzma.js'

/** RAR 5 signature: `Rar!\x1a\x07\x01\x00`. */
const SIGNATURE_5 = Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])

/** RAR 4 (and older) signature: `Rar!\x1a\x07\x00`. */
const SIGNATURE_4 = Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])

/** RAR 5 block header types. */
const BLOCK = Object.freeze({
  main: 1,
  file: 2,
  service: 3,
  encryption: 4,
  end: 5,
})

/** RAR 5 common block header flags. */
const HFLAG = Object.freeze({
  extraArea: 0x0001,
  dataArea: 0x0002,
  splitBefore: 0x0008,
  splitAfter: 0x0010,
})

/** RAR 5 file header flags. */
const FFLAG = Object.freeze({
  directory: 0x0001,
  mtimeUnix: 0x0002,
  crcPresent: 0x0004,
  unknownSize: 0x0008,
})

/**
 * RAR 5 extra-area record types.
 *
 * Every one of these is recognised. The ones that change what an entry *is*
 * (encryption, redirection) are acted on; the ones that merely describe it
 * (times, hash, version, owner) are read or noted; anything else is skipped by
 * its declared length. A record type this file does not know must never be
 * treated as the end of the area — that is how a parser silently drops the
 * records after it.
 */
const EXTRA = Object.freeze({
  encryption: 0x01,
  hash: 0x02,
  htime: 0x03,
  version: 0x04,
  redirection: 0x05,
  owner: 0x06,
  serviceData: 0x07,
})

/** Flags inside an `htime` (0x03) record. */
const HTIME = Object.freeze({
  unix: 0x0001,
  mtime: 0x0002,
  ctime: 0x0004,
  atime: 0x0008,
  unixNano: 0x0010,
})

/** Hash algorithm ids inside a file-hash (0x02) record. */
const HASH_BLAKE2SP = 0x00

/** Redirection kinds inside a redirection (0x05) record. */
const REDIRECT_NAMES = Object.freeze({
  1: 'UNIX 符號連結（symlink）',
  2: 'Windows 符號連結（symlink）',
  3: 'Windows 交接點（junction）',
  4: '硬連結（hard link）',
  5: '檔案複本（file copy）',
})

/** Compression methods. Only `store` carries no proprietary algorithm. */
const METHOD_STORE = 0

/**
 * Names for the methods recognised but deliberately not decoded, so a refusal
 * says which algorithm was met rather than just "unsupported".
 */
const METHOD_NAMES = Object.freeze({
  1: 'Fastest (m1)',
  2: 'Fast (m2)',
  3: 'Normal (m3)',
  4: 'Good (m4)',
  5: 'Best (m5)',
})

/* ------------------------------------------------------------------ *
 *  RAR 4 block layout
 * ------------------------------------------------------------------ */

/** RAR 4 block types. */
const B4 = Object.freeze({
  marker: 0x72,
  main: 0x73,
  file: 0x74,
  comment: 0x75,
  av: 0x76,
  subOld: 0x77,
  recovery: 0x78,
  subNew: 0x7a,
  end: 0x7b,
})

/** RAR 4 common block flags. */
const B4FLAG = Object.freeze({
  /** ADD_SIZE (a 32-bit trailing data length) is present after the fixed part. */
  longBlock: 0x8000,
})

/** RAR 4 main-archive-header flags. */
const M4FLAG = Object.freeze({
  volume: 0x0001,
  solid: 0x0008,
  password: 0x0080,
})

/** RAR 4 file-header flags. */
const F4FLAG = Object.freeze({
  splitBefore: 0x0001,
  splitAfter: 0x0002,
  password: 0x0004,
  solid: 0x0010,
  /** Bits 5..7 hold the dictionary size; all three set means "directory". */
  windowMask: 0x00e0,
  large: 0x0100,
  unicode: 0x0200,
  salt: 0x0400,
  extTime: 0x1000,
})

/** The fixed part of a RAR 4 block header, before any type-specific fields. */
const B4_HEADER_MIN = 7

/** The fixed part of a RAR 4 file header, up to but excluding the name. */
const F4_FIXED = 32

/** RAR 4 host-OS ids whose path separator is a backslash. */
const HOST_OS_DOS = 0
const HOST_OS_WIN = 2

/** Ceilings, matching the other archive readers in this directory. */
const DEFAULT_MAX_BYTES = 268_435_456
const DEFAULT_MAX_ENTRY_BYTES = 134_217_728
const DEFAULT_MAX_ENTRIES = 20_000

/**
 * A header longer than this is a corrupt or hostile length field, not a real
 * archive: RAR caps its own header size well below it, and the value is only
 * ever used to slice a buffer we have already bounds-checked.
 */
const MAX_HEADER_SIZE = 1 << 20

/** Entry names above this are refused before the bytes are turned into a string. */
const MAX_NAME_BYTES = 4096

/** Every failure here, so a caller can branch on one type. */
export class RarError extends Error {
  /**
   * @param {string} message
   * @param {'unsupported'|'corrupt'|'limit'|'traversal'|'notfound'|'encrypted'} [code]
   */
  constructor(message, code = 'corrupt') {
    super(message)
    this.name = 'RarError'
    this.code = code
  }
}

/* ------------------------------------------------------------------ *
 *  BLAKE2sp — the hash RAR 5 file-hash records carry
 * ------------------------------------------------------------------ */

const B2S_IV = Uint32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const B2S_SIGMA = Object.freeze([
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
])

/**
 * @param {number} x
 * @param {number} n
 * @returns {number}
 */
function rotr32(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

/**
 * One BLAKE2s instance. Written out rather than taken from `crypto` because
 * Node exposes `blake2s256` — the sequential mode — but not the tree mode
 * BLAKE2sp needs, and the tree mode is the whole point here.
 */
class Blake2s {
  /** @param {Buffer} param the 32-byte parameter block */
  constructor(param) {
    /** @type {Uint32Array} */
    this.h = new Uint32Array(8)
    for (let i = 0; i < 8; i++) this.h[i] = (B2S_IV[i] ^ param.readUInt32LE(i * 4)) >>> 0
    /** @type {Buffer} */
    this.buf = Buffer.alloc(64)
    /** @type {number} bytes currently held in {@link buf} */
    this.len = 0
    /** @type {number} bytes compressed so far, the counter BLAKE2 mixes in */
    this.t = 0
    /** @type {boolean} set on the last leaf and on the root of the tree */
    this.lastNode = false
  }

  /**
   * @param {Buffer} blk
   * @param {boolean} last
   * @returns {void}
   */
  _compress(blk, last) {
    const v = new Uint32Array(16)
    for (let i = 0; i < 8; i++) v[i] = this.h[i]
    for (let i = 0; i < 8; i++) v[8 + i] = B2S_IV[i]
    v[12] = (v[12] ^ (this.t >>> 0)) >>> 0
    v[13] = (v[13] ^ Math.floor(this.t / 4294967296)) >>> 0
    if (last) {
      v[14] = (v[14] ^ 0xffffffff) >>> 0
      if (this.lastNode) v[15] = (v[15] ^ 0xffffffff) >>> 0
    }
    const m = new Uint32Array(16)
    for (let i = 0; i < 16; i++) m[i] = blk.readUInt32LE(i * 4)
    /**
     * @param {number} a @param {number} b @param {number} c @param {number} d
     * @param {number} x @param {number} y
     * @returns {void}
     */
    const g = (a, b, c, d, x, y) => {
      v[a] = (v[a] + v[b] + x) >>> 0
      v[d] = rotr32(v[d] ^ v[a], 16)
      v[c] = (v[c] + v[d]) >>> 0
      v[b] = rotr32(v[b] ^ v[c], 12)
      v[a] = (v[a] + v[b] + y) >>> 0
      v[d] = rotr32(v[d] ^ v[a], 8)
      v[c] = (v[c] + v[d]) >>> 0
      v[b] = rotr32(v[b] ^ v[c], 7)
    }
    for (let r = 0; r < 10; r++) {
      const s = B2S_SIGMA[r]
      g(0, 4, 8, 12, m[s[0]], m[s[1]])
      g(1, 5, 9, 13, m[s[2]], m[s[3]])
      g(2, 6, 10, 14, m[s[4]], m[s[5]])
      g(3, 7, 11, 15, m[s[6]], m[s[7]])
      g(0, 5, 10, 15, m[s[8]], m[s[9]])
      g(1, 6, 11, 12, m[s[10]], m[s[11]])
      g(2, 7, 8, 13, m[s[12]], m[s[13]])
      g(3, 4, 9, 14, m[s[14]], m[s[15]])
    }
    for (let i = 0; i < 8; i++) this.h[i] = (this.h[i] ^ v[i] ^ v[8 + i]) >>> 0
  }

  /**
   * @param {Buffer|Uint8Array} data
   * @returns {this}
   */
  update(data) {
    const src = Buffer.isBuffer(data) ? data : Buffer.from(data)
    let i = 0
    while (i < src.length) {
      // A full buffer is only compressed once more input is known to follow,
      // because BLAKE2 flags the final block and the final block alone.
      if (this.len === 64) {
        this.t += 64
        this._compress(this.buf, false)
        this.len = 0
      }
      const n = Math.min(64 - this.len, src.length - i)
      src.copy(this.buf, this.len, i, i + n)
      this.len += n
      i += n
    }
    return this
  }

  /** @returns {Buffer} the 32-byte digest */
  digest() {
    this.t += this.len
    this.buf.fill(0, this.len)
    this._compress(this.buf, true)
    const out = Buffer.alloc(32)
    for (let i = 0; i < 8; i++) out.writeUInt32LE(this.h[i], i * 4)
    return out
  }
}

/**
 * @param {{fanout: number, depth: number, nodeOffset: number, nodeDepth: number, innerLength: number}} p
 * @returns {Buffer}
 */
function blake2sParam(p) {
  const b = Buffer.alloc(32)
  b[0] = 32 // digest length
  b[1] = 0 // key length
  b[2] = p.fanout
  b[3] = p.depth
  b.writeUInt32LE(0, 4) // leaf length: 0, as BLAKE2sp's reference sets it
  b.writeUInt32LE(p.nodeOffset, 8)
  b.writeUInt16LE(0, 12) // the top 16 bits of the 48-bit node offset
  b[14] = p.nodeDepth
  b[15] = p.innerLength
  return b
}

/** BLAKE2sp fans the input across this many leaves, 64 bytes at a time. */
const B2SP_PARALLELISM = 8

/**
 * BLAKE2sp: BLAKE2s in a two-level tree of eight leaves, which is the hash
 * RAR 5 stores in a file-hash extra record.
 *
 * Cross-checked against the published empty-input vector, against 7-Zip's own
 * `7z h -scrcBLAKE2SP`, and end-to-end by 7-Zip accepting fixtures whose hash
 * records this function produced.
 *
 * @param {Uint8Array|Buffer} data
 * @returns {Buffer} 32 bytes
 */
export function blake2sp(data) {
  const src = Buffer.isBuffer(data) ? data : Buffer.from(data)
  /** @type {Blake2s[]} */
  const leaves = []
  for (let i = 0; i < B2SP_PARALLELISM; i++) {
    const leaf = new Blake2s(blake2sParam({
      fanout: B2SP_PARALLELISM, depth: 2, nodeOffset: i, nodeDepth: 0, innerLength: 32,
    }))
    if (i === B2SP_PARALLELISM - 1) leaf.lastNode = true
    leaves.push(leaf)
  }
  // Leaf i takes every eighth 64-byte block, starting at block i.
  for (let off = 0, i = 0; off < src.length; off += 64, i++) {
    leaves[i % B2SP_PARALLELISM].update(src.subarray(off, Math.min(off + 64, src.length)))
  }
  const root = new Blake2s(blake2sParam({
    fanout: B2SP_PARALLELISM, depth: 2, nodeOffset: 0, nodeDepth: 1, innerLength: 32,
  }))
  root.lastNode = true
  for (const leaf of leaves) root.update(leaf.digest())
  return root.digest()
}

/* ------------------------------------------------------------------ *
 *  Detection
 * ------------------------------------------------------------------ */

/**
 * @param {Uint8Array|Buffer|null|undefined} buf
 * @param {Uint8Array} sig
 * @returns {boolean}
 */
function startsWith(buf, sig) {
  if (!buf || buf.length < sig.length) return false
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false
  return true
}

/**
 * Does this look like a RAR of any generation?
 *
 * @param {Uint8Array|Buffer|null|undefined} buf
 * @returns {boolean}
 */
export function isRar(buf) {
  return startsWith(buf, SIGNATURE_5) || startsWith(buf, SIGNATURE_4)
}

/**
 * Which container generation, if any.
 *
 * RAR 4's signature is a proper prefix of RAR 5's, so the longer one has to be
 * tested first or every RAR 5 would be misread as a RAR 4.
 *
 * @param {Uint8Array|Buffer|null|undefined} buf
 * @returns {'rar5'|'rar4'|null}
 */
export function rarGeneration(buf) {
  if (startsWith(buf, SIGNATURE_5)) return 'rar5'
  if (startsWith(buf, SIGNATURE_4)) return 'rar4'
  return null
}

/* ------------------------------------------------------------------ *
 *  Primitive reads
 * ------------------------------------------------------------------ */

/**
 * A RAR 5 variable-length integer: 7 bits per byte, little-endian, high bit
 * set on every byte but the last.
 *
 * The value is accumulated in a Number rather than a BigInt because every
 * consumer here compares it against a byte ceiling far below 2^53; anything
 * needing more than that is refused outright instead of silently losing
 * precision, which is how an oversized length field turns into a wrong slice.
 *
 * @param {Uint8Array} buf
 * @param {number} at
 * @param {number} end exclusive bound the integer may not read past
 * @returns {{value: number, next: number}}
 */
function readVint(buf, at, end) {
  let value = 0
  let shift = 0
  let i = at
  for (;;) {
    if (i >= end) throw new RarError('RAR vint 在資料結束前被截斷')
    if (shift > 63) throw new RarError('RAR vint 超過 64 位元')
    const byte = buf[i]
    value += (byte & 0x7f) * 2 ** shift
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new RarError('RAR vint 的數值超出安全整數範圍')
    }
    i++
    if ((byte & 0x80) === 0) return { value, next: i }
    shift += 7
  }
}

/**
 * @param {Uint8Array} buf
 * @param {number} at
 * @returns {number}
 */
function readU16(buf, at) {
  return (buf[at] | (buf[at + 1] << 8)) >>> 0
}

/**
 * @param {Uint8Array} buf
 * @param {number} at
 * @returns {number}
 */
function readU32(buf, at) {
  return (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0
}

/**
 * A Windows FILETIME — 100-nanosecond ticks since 1601 — as a JS Date.
 *
 * Read as two 32-bit halves and recombined in floating point: the value only
 * ever becomes a millisecond count that `Date` would truncate to a Number
 * anyway, and no timestamp a real archive carries comes near the point where
 * that loses a millisecond.
 *
 * @param {Uint8Array} buf
 * @param {number} at
 * @returns {Date}
 */
function readFileTime(buf, at) {
  const lo = readU32(buf, at)
  const hi = readU32(buf, at + 4)
  const ticks = hi * 4294967296 + lo
  return new Date(Math.round(ticks / 10000) - 11644473600000)
}

/* ------------------------------------------------------------------ *
 *  RAR 5 extra area
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} RarRedirect
 * @property {number} kind    1 unix symlink, 2 win symlink, 3 junction, 4 hard link, 5 copy
 * @property {string} kindName
 * @property {boolean} isDirectory whether the target is a directory
 * @property {string} target  the link target as stored
 */

/**
 * @typedef {Object} RarExtra
 * @property {boolean} encrypted
 * @property {{algorithm: string, value: string}|null} hash
 * @property {string|null} mtime  ISO 8601, from an htime record
 * @property {string|null} ctime
 * @property {string|null} atime
 * @property {RarRedirect|null} redirect
 * @property {number[]} unknownTypes record types met but not understood
 */

/**
 * Walk a RAR 5 header's extra area.
 *
 * Every record is decoded by its declared length, and a type this file does
 * not know is skipped by that length and noted — never treated as the end of
 * the area, which is the mistake that makes a parser silently drop everything
 * after the first unfamiliar record.
 *
 * @param {Uint8Array} buf
 * @param {number} at start of the extra area
 * @param {number} end exclusive end of the extra area
 * @returns {RarExtra}
 */
function parseExtraArea(buf, at, end) {
  /** @type {RarExtra} */
  const out = {
    encrypted: false,
    hash: null,
    mtime: null,
    ctime: null,
    atime: null,
    redirect: null,
    unknownTypes: [],
  }
  let i = at
  while (i < end) {
    const size = readVint(buf, i, end)
    // A record's size counts everything after its own size field.
    const bodyEnd = size.next + size.value
    if (bodyEnd > end || bodyEnd < size.next) {
      throw new RarError('RAR extra area 的記錄長度超出範圍')
    }
    if (size.value === 0) {
      // Zero would leave the walk standing still. It is corruption, not a
      // terminator: the area's end is the header's end, nothing else.
      throw new RarError('RAR extra area 的記錄長度為 0')
    }
    const type = readVint(buf, size.next, bodyEnd)
    const p = type.next
    switch (type.value) {
      case EXTRA.encryption:
        out.encrypted = true
        break
      case EXTRA.hash:
        readHashRecord(buf, p, bodyEnd, out)
        break
      case EXTRA.htime:
        readHtimeRecord(buf, p, bodyEnd, out)
        break
      case EXTRA.redirection:
        out.redirect = readRedirectRecord(buf, p, bodyEnd)
        break
      case EXTRA.version:
      case EXTRA.owner:
      case EXTRA.serviceData:
        // Recognised and deliberately not surfaced: none of them changes what
        // the entry's bytes are, and inventing fields for them would be
        // shipping untested surface.
        break
      default:
        out.unknownTypes.push(type.value)
        break
    }
    i = bodyEnd
  }
  return out
}

/**
 * @param {Uint8Array} buf
 * @param {number} at
 * @param {number} end
 * @param {RarExtra} out
 * @returns {void}
 */
function readHashRecord(buf, at, end, out) {
  const algo = readVint(buf, at, end)
  if (algo.value !== HASH_BLAKE2SP) {
    // Noted rather than guessed at: an unknown algorithm id means an unknown
    // digest length too, so there is nothing safe to slice.
    out.hash = { algorithm: `未知（id ${algo.value}）`, value: '' }
    return
  }
  if (algo.next + 32 > end) throw new RarError('RAR 檔案雜湊記錄被截斷')
  out.hash = {
    algorithm: 'BLAKE2sp',
    value: Buffer.from(buf.subarray(algo.next, algo.next + 32)).toString('hex'),
  }
}

/**
 * @param {Uint8Array} buf
 * @param {number} at
 * @param {number} end
 * @param {RarExtra} out
 * @returns {void}
 */
function readHtimeRecord(buf, at, end, out) {
  const flagsRead = readVint(buf, at, end)
  const flags = flagsRead.value
  let p = flagsRead.next
  const unix = Boolean(flags & HTIME.unix)
  // Unix times are 4 bytes, or 8 with the nanosecond flag; Windows FILETIMEs
  // are always 8. Getting this width wrong shifts every later field.
  const width = unix ? (flags & HTIME.unixNano ? 8 : 4) : 8

  /** @returns {string|null} */
  const readOne = () => {
    if (p + width > end) throw new RarError('RAR htime 記錄被截斷')
    const date = unix
      ? new Date(readU32(buf, p) * 1000)
      : readFileTime(buf, p)
    p += width
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }

  if (flags & HTIME.mtime) out.mtime = readOne()
  if (flags & HTIME.ctime) out.ctime = readOne()
  if (flags & HTIME.atime) out.atime = readOne()
}

/**
 * @param {Uint8Array} buf
 * @param {number} at
 * @param {number} end
 * @returns {RarRedirect}
 */
function readRedirectRecord(buf, at, end) {
  const kind = readVint(buf, at, end)
  const flags = readVint(buf, kind.next, end)
  const nameLen = readVint(buf, flags.next, end)
  if (nameLen.value > MAX_NAME_BYTES) {
    throw new RarError(`RAR 連結目標長度 ${nameLen.value} 超過上限`)
  }
  const nameEnd = nameLen.next + nameLen.value
  if (nameEnd > end) throw new RarError('RAR 連結記錄的目標名稱超出範圍')
  return {
    kind: kind.value,
    kindName: REDIRECT_NAMES[kind.value] ?? `未知的連結型別 ${kind.value}`,
    isDirectory: Boolean(flags.value & 0x0001),
    target: Buffer.from(buf.subarray(nameLen.next, nameEnd)).toString('utf8'),
  }
}

/* ------------------------------------------------------------------ *
 *  Entry shape
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} RarEntry
 * @property {string} path        name as stored, normalised to `/`
 * @property {number} size        unpacked size in bytes
 * @property {string} mtime       ISO 8601
 * @property {string|null} [ctime] ISO 8601, when the archive carried one
 * @property {string|null} [atime] ISO 8601, when the archive carried one
 * @property {boolean} isDirectory
 * @property {number} method      compression method, 0 = stored
 * @property {number|null} crc    stored CRC-32 of the unpacked data, if present
 * @property {{algorithm: string, value: string}|null} [hash] file-hash record, if present
 * @property {RarRedirect|null} [redirect] set when the entry is a link, not a file
 * @property {number[]} [unknownExtra] extra-record types met but not understood
 * @property {number} dataOffset  absolute offset of the packed bytes
 * @property {number} dataSize    packed byte count
 */

/**
 * @typedef {Object} RarParsed
 * @property {'rar4'|'rar5'} generation
 * @property {RarEntry[]} entries
 * @property {boolean} sawEnd  whether an end-of-archive block was reached
 */

/**
 * Running totals shared by both generations' walkers, so the ceilings are
 * applied identically rather than re-derived twice.
 */
class Limits {
  /** @param {{maxEntries?: number, maxEntryBytes?: number, maxBytes?: number}} opts */
  constructor(opts) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    this.total = 0
  }

  /**
   * @param {RarEntry[]} entries
   * @param {RarEntry} entry
   * @returns {void}
   */
  admit(entries, entry) {
    if (!entry.isDirectory) {
      if (entry.size > this.maxEntryBytes) {
        throw new RarError(
          `RAR 項目「${entry.path}」為 ${entry.size} 位元組，超過 ${this.maxEntryBytes} 的上限`,
          'limit',
        )
      }
      this.total += entry.size
      if (this.total > this.maxBytes) {
        throw new RarError(`RAR 解開後超過 ${this.maxBytes} 位元組的上限`, 'limit')
      }
    }
    entries.push(entry)
    if (entries.length > this.maxEntries) {
      throw new RarError(`RAR 項目數超過 ${this.maxEntries} 的上限`, 'limit')
    }
  }
}

/**
 * Parse a RAR container of either generation without decompressing anything.
 *
 * Compressed entries are *listed*, not refused: a user opening an archive
 * should see what is in it and be told why one file cannot be opened, rather
 * than be shown an empty folder. The refusal happens in
 * {@link extractRarEntry}, at the point where wrong bytes would otherwise be
 * produced.
 *
 * @param {Uint8Array} buf
 * @param {{maxEntries?: number, maxEntryBytes?: number, maxBytes?: number}} [opts]
 * @returns {RarParsed}
 */
export function parseRar(buf, opts = {}) {
  const generation = rarGeneration(buf)
  if (generation === null) throw new RarError('不是 RAR 檔（signature 不符）', 'unsupported')
  const limits = new Limits(opts)
  return generation === 'rar4' ? parseRar4(buf, limits) : parseRar5(buf, limits)
}

/* ------------------------------------------------------------------ *
 *  RAR 5
 * ------------------------------------------------------------------ */

/**
 * @param {Uint8Array} buf
 * @param {Limits} limits
 * @returns {RarParsed}
 */
function parseRar5(buf, limits) {
  /** @type {RarEntry[]} */
  const entries = []
  let sawEnd = false
  let at = SIGNATURE_5.length

  while (at < buf.length) {
    // A trailing run shorter than the smallest possible block is truncation,
    // not padding: RAR ends with an explicit end-of-archive block.
    if (at + 4 >= buf.length) throw new RarError('RAR 區塊標頭被截斷')

    const storedCrc = readU32(buf, at)
    const sizeField = at + 4
    const size = readVint(buf, sizeField, buf.length)
    const headerSize = size.value
    if (headerSize === 0 || headerSize > MAX_HEADER_SIZE) {
      throw new RarError(`RAR 區塊標頭長度不合法：${headerSize}`)
    }
    const bodyStart = size.next
    const bodyEnd = bodyStart + headerSize
    if (bodyEnd > buf.length) throw new RarError('RAR 區塊標頭超出檔案範圍')

    // The CRC covers the size field and the header body, but not the CRC itself.
    if (crc32(buf.subarray(sizeField, bodyEnd)) !== storedCrc) {
      throw new RarError('RAR 區塊標頭的 CRC32 不符，檔案已損壞')
    }

    let p = bodyStart
    const typeRead = readVint(buf, p, bodyEnd)
    const type = typeRead.value
    p = typeRead.next
    const flagsRead = readVint(buf, p, bodyEnd)
    const flags = flagsRead.value
    p = flagsRead.next

    let extraSize = 0
    if (flags & HFLAG.extraArea) {
      const r = readVint(buf, p, bodyEnd)
      extraSize = r.value
      p = r.next
    }
    let dataSize = 0
    if (flags & HFLAG.dataArea) {
      const r = readVint(buf, p, bodyEnd)
      dataSize = r.value
      p = r.next
    }

    const extraStart = bodyEnd - extraSize
    if (extraSize < 0 || extraStart < p) {
      throw new RarError('RAR extra area 長度與標頭長度矛盾')
    }
    const fieldsEnd = extraStart

    const dataStart = bodyEnd
    const dataEnd = dataStart + dataSize
    if (dataEnd > buf.length || dataEnd < dataStart) {
      throw new RarError('RAR 區塊的資料區超出檔案範圍')
    }

    if (type === BLOCK.encryption) {
      throw new RarError(
        'RAR 封存的標頭已加密，需要密碼才能讀取，本版本不支援加密的 RAR', 'encrypted',
      )
    }

    if (type === BLOCK.end) {
      sawEnd = true
      break
    }

    if (type === BLOCK.file) {
      if (flags & (HFLAG.splitBefore | HFLAG.splitAfter)) {
        throw new RarError('RAR 分卷封存（split volume）本版本不支援', 'unsupported')
      }
      const entry = readFileHeader5(buf, p, fieldsEnd, extraStart, bodyEnd, {
        dataOffset: dataStart,
        dataSize,
      })
      limits.admit(entries, entry)
    }
    // BLOCK.main and BLOCK.service (recovery records, comments, quick-open
    // indexes) carry nothing a listing needs; their data area is skipped by
    // the same arithmetic as everything else.

    if (dataEnd <= at) throw new RarError('RAR 區塊沒有前進，檔案已損壞')
    at = dataEnd
  }

  if (!sawEnd) {
    throw new RarError('RAR 缺少結尾區塊（end of archive），檔案可能被截斷')
  }

  return { generation: 'rar5', entries, sawEnd }
}

/**
 * Read the type-specific part of a RAR 5 file header.
 *
 * @param {Uint8Array} buf
 * @param {number} at first byte after the common header fields
 * @param {number} fieldsEnd exclusive end of the named fields (start of extra area)
 * @param {number} extraStart
 * @param {number} bodyEnd
 * @param {{dataOffset: number, dataSize: number}} data
 * @returns {RarEntry}
 */
function readFileHeader5(buf, at, fieldsEnd, extraStart, bodyEnd, data) {
  let p = at
  const fileFlagsRead = readVint(buf, p, fieldsEnd)
  const fileFlags = fileFlagsRead.value
  p = fileFlagsRead.next

  const unpackedRead = readVint(buf, p, fieldsEnd)
  let unpackedSize = unpackedRead.value
  p = unpackedRead.next

  const attrRead = readVint(buf, p, fieldsEnd)
  p = attrRead.next

  let mtime = new Date(0)
  if (fileFlags & FFLAG.mtimeUnix) {
    if (p + 4 > fieldsEnd) throw new RarError('RAR 檔案標頭的時間欄位被截斷')
    mtime = new Date(readU32(buf, p) * 1000)
    p += 4
  }

  /** @type {number|null} */
  let crc = null
  if (fileFlags & FFLAG.crcPresent) {
    if (p + 4 > fieldsEnd) throw new RarError('RAR 檔案標頭的 CRC 欄位被截斷')
    crc = readU32(buf, p)
    p += 4
  }

  const compRead = readVint(buf, p, fieldsEnd)
  const compInfo = compRead.value
  p = compRead.next

  const osRead = readVint(buf, p, fieldsEnd)
  p = osRead.next

  const nameLenRead = readVint(buf, p, fieldsEnd)
  const nameLen = nameLenRead.value
  p = nameLenRead.next
  if (nameLen === 0) throw new RarError('RAR 項目的名稱長度為 0')
  if (nameLen > MAX_NAME_BYTES) {
    throw new RarError(`RAR 項目的名稱長度 ${nameLen} 超過上限`)
  }
  if (p + nameLen > fieldsEnd) throw new RarError('RAR 項目名稱超出標頭範圍')
  const rawName = Buffer.from(buf.subarray(p, p + nameLen)).toString('utf8')

  const extra = extraStart < bodyEnd
    ? parseExtraArea(buf, extraStart, bodyEnd)
    : /** @type {RarExtra} */ ({
      encrypted: false,
      hash: null,
      mtime: null,
      ctime: null,
      atime: null,
      redirect: null,
      unknownTypes: [],
    })
  if (extra.encrypted) {
    throw new RarError(
      `RAR 項目「${rawName}」已加密，需要密碼才能解開，本版本不支援加密的 RAR`,
      'encrypted',
    )
  }

  const isDirectory = Boolean(fileFlags & FFLAG.directory)
  if (fileFlags & FFLAG.unknownSize) {
    // Without a size there is nothing to bound an allocation with, and for a
    // stored entry the size is the only thing that says where the file ends.
    throw new RarError(`RAR 項目「${rawName}」未宣告解開後的大小，本版本不支援`, 'unsupported')
  }
  if (isDirectory) unpackedSize = 0

  // Compression info packs the format version in bits 0..5, the solid flag in
  // bit 6, the method in bits 7..9 and the dictionary size in bits 10..13.
  const method = (compInfo >> 7) & 0x07
  const solid = Boolean((compInfo >> 6) & 0x01)
  if (solid) {
    throw new RarError(
      `RAR 項目「${rawName}」屬於 solid 區塊，需要先解開前面的項目，本版本不支援`,
      'unsupported',
    )
  }

  return {
    path: normaliseName(rawName),
    size: unpackedSize,
    // An htime record is more precise than the header's 32-bit Unix field and
    // is what a real packer writes, so it wins where both are present.
    mtime: extra.mtime ?? mtime.toISOString(),
    ctime: extra.ctime,
    atime: extra.atime,
    isDirectory,
    method,
    crc,
    hash: extra.hash,
    redirect: extra.redirect,
    unknownExtra: extra.unknownTypes,
    dataOffset: data.dataOffset,
    dataSize: data.dataSize,
  }
}

/* ------------------------------------------------------------------ *
 *  RAR 4
 * ------------------------------------------------------------------ */

/**
 * Walk a RAR 4 container.
 *
 * Nothing is shared with the RAR 5 walker but the ceilings: RAR 4 blocks are
 * fixed-layout with a 16-bit header CRC and a 16-bit header size, and the
 * trailing data length lives in an optional 32-bit ADD_SIZE field rather than
 * in the header's flags-driven vint chain.
 *
 * @param {Uint8Array} buf
 * @param {Limits} limits
 * @returns {RarParsed}
 */
function parseRar4(buf, limits) {
  /** @type {RarEntry[]} */
  const entries = []
  let sawEnd = false
  // The signature *is* the marker block (type 0x72, HEAD_SIZE 7), so the walk
  // starts immediately after it.
  let at = SIGNATURE_4.length

  while (at < buf.length) {
    if (at + B4_HEADER_MIN > buf.length) throw new RarError('RAR4 區塊標頭被截斷')
    const storedCrc = readU16(buf, at)
    const type = buf[at + 2]
    const flags = readU16(buf, at + 3)
    const headSize = readU16(buf, at + 5)
    if (headSize < B4_HEADER_MIN || headSize > MAX_HEADER_SIZE) {
      throw new RarError(`RAR4 區塊標頭長度不合法：${headSize}`)
    }
    const headEnd = at + headSize
    if (headEnd > buf.length) throw new RarError('RAR4 區塊標頭超出檔案範圍')

    // The CRC covers the header from HEAD_TYPE to its end, keeping only the
    // low 16 bits of a standard CRC-32.
    if ((crc32(buf.subarray(at + 2, headEnd)) & 0xffff) !== storedCrc) {
      throw new RarError('RAR4 區塊標頭的 CRC 不符，檔案已損壞')
    }

    let addSize = 0
    if (flags & B4FLAG.longBlock) {
      if (at + 11 > headEnd) throw new RarError('RAR4 區塊的 ADD_SIZE 欄位超出標頭範圍')
      addSize = readU32(buf, at + 7)
    }

    if (type === B4.main) {
      if (flags & M4FLAG.password) {
        throw new RarError(
          'RAR4 封存的標頭已加密，需要密碼才能讀取，本版本不支援加密的 RAR', 'encrypted',
        )
      }
      if (flags & M4FLAG.volume) {
        throw new RarError('RAR4 分卷封存（split volume）本版本不支援', 'unsupported')
      }
    }

    if (type === B4.end) {
      sawEnd = true
      break
    }

    let dataSize = addSize
    if (type === B4.file) {
      const entry = readFileHeader4(buf, at, headEnd, flags)
      dataSize = entry.dataSize
      limits.admit(entries, entry)
    }

    const dataEnd = headEnd + dataSize
    if (dataEnd > buf.length || dataEnd < headEnd) {
      throw new RarError('RAR4 區塊的資料區超出檔案範圍')
    }
    if (dataEnd <= at) throw new RarError('RAR4 區塊沒有前進，檔案已損壞')
    at = dataEnd
  }

  if (!sawEnd) {
    throw new RarError('RAR4 缺少結尾區塊（end of archive），檔案可能被截斷')
  }

  return { generation: 'rar4', entries, sawEnd }
}

/**
 * Read a RAR 4 file header (type 0x74).
 *
 * @param {Uint8Array} buf
 * @param {number} at offset of the block's first byte (HEAD_CRC)
 * @param {number} headEnd exclusive end of the header
 * @param {number} flags the block's HEAD_FLAGS
 * @returns {RarEntry}
 */
function readFileHeader4(buf, at, headEnd, flags) {
  if (at + F4_FIXED > headEnd) throw new RarError('RAR4 檔案標頭被截斷')

  let packSize = readU32(buf, at + 7)
  let unpSize = readU32(buf, at + 11)
  const hostOs = buf[at + 15]
  const fileCrc = readU32(buf, at + 16)
  const dosTime = readU32(buf, at + 20)
  const rawMethod = buf[at + 25]
  const nameSize = readU16(buf, at + 26)

  let p = at + F4_FIXED
  if (flags & F4FLAG.large) {
    // The 64-bit sizes are split, with the high halves in their own fields.
    // They are read as floats and bounded by the ceiling like everything else;
    // a value past 2^53 is refused rather than silently rounded.
    if (p + 8 > headEnd) throw new RarError('RAR4 的 64 位元大小欄位超出標頭範圍')
    packSize += readU32(buf, p) * 4294967296
    unpSize += readU32(buf, p + 4) * 4294967296
    p += 8
    if (packSize > Number.MAX_SAFE_INTEGER || unpSize > Number.MAX_SAFE_INTEGER) {
      throw new RarError('RAR4 項目的大小超出安全整數範圍')
    }
  }

  if (nameSize === 0) throw new RarError('RAR4 項目的名稱長度為 0')
  if (nameSize > MAX_NAME_BYTES) {
    throw new RarError(`RAR4 項目的名稱長度 ${nameSize} 超過上限`)
  }
  if (p + nameSize > headEnd) throw new RarError('RAR4 項目名稱超出標頭範圍')
  const nameBytes = buf.subarray(p, p + nameSize)
  const rawName = (flags & F4FLAG.unicode)
    ? decodeUnicodeName4(nameBytes)
    : Buffer.from(nameBytes).toString('utf8')

  if (flags & F4FLAG.password) {
    throw new RarError(
      `RAR4 項目「${rawName}」已加密，需要密碼才能解開，本版本不支援加密的 RAR`,
      'encrypted',
    )
  }
  if (flags & (F4FLAG.splitBefore | F4FLAG.splitAfter)) {
    throw new RarError('RAR4 分卷封存（split volume）本版本不支援', 'unsupported')
  }
  if (flags & F4FLAG.solid) {
    throw new RarError(
      `RAR4 項目「${rawName}」屬於 solid 區塊，需要先解開前面的項目，本版本不支援`,
      'unsupported',
    )
  }

  // All three dictionary bits set is RAR 4's way of saying "directory".
  const isDirectory = (flags & F4FLAG.windowMask) === F4FLAG.windowMask

  // RAR 4 stores the method as 0x30..0x35. Normalising to 0..5 lets one
  // refusal table serve both generations; a byte outside that range is not a
  // method this format defines, so it is corruption rather than a method we
  // merely cannot decode.
  const method = rawMethod - 0x30
  if (method < 0 || method > 5) {
    const hex = rawMethod.toString(16).padStart(2, '0')
    throw new RarError(`RAR4 項目「${rawName}」的壓縮方法位元組 0x${hex} 不是此格式定義的方法`)
  }

  return {
    path: normaliseName(rawName, hostOs === HOST_OS_DOS || hostOs === HOST_OS_WIN),
    size: isDirectory ? 0 : unpSize,
    mtime: dosDateTime(dosTime).toISOString(),
    ctime: null,
    atime: null,
    isDirectory,
    method,
    crc: fileCrc,
    hash: null,
    redirect: null,
    unknownExtra: [],
    dataOffset: headEnd,
    dataSize: packSize,
  }
}

/**
 * An MS-DOS packed date-time as a Date.
 *
 * DOS timestamps carry no time zone; every tool that reads them, 7-Zip
 * included, shows the stored components as local time, so that is what is
 * reconstructed here. An impossible field combination — month or day zero,
 * which is what a zeroed header looks like — becomes the epoch rather than an
 * `Invalid Date` that would throw on `toISOString`.
 *
 * @param {number} t
 * @returns {Date}
 */
function dosDateTime(t) {
  const second = (t & 0x1f) * 2
  const minute = (t >> 5) & 0x3f
  const hour = (t >> 11) & 0x1f
  const day = (t >> 16) & 0x1f
  const month = (t >> 21) & 0x0f
  const year = ((t >> 25) & 0x7f) + 1980
  if (month < 1 || month > 12 || day < 1 || day > 31) return new Date(0)
  const d = new Date(year, month - 1, day, hour, minute, second)
  return Number.isFinite(d.getTime()) ? d : new Date(0)
}

/**
 * Decode RAR 4's Unicode file name encoding.
 *
 * The field holds the ASCII fallback name, a NUL, then a bit-packed stream of
 * two-bit opcodes that rebuild the real name: take a byte as-is, take a byte
 * and add the run's high byte, take a raw 16-bit code unit, or copy a run from
 * the ASCII name with an optional per-character correction.
 *
 * When the NUL is absent the field is a plain name that merely had the flag
 * set, which is what a packer writes for an all-ASCII name.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeUnicodeName4(bytes) {
  const nul = bytes.indexOf(0)
  if (nul < 0) return Buffer.from(bytes).toString('utf8')
  const ascii = bytes.subarray(0, nul)
  const enc = bytes.subarray(nul + 1)
  if (enc.length === 0) return Buffer.from(ascii).toString('latin1')

  const highByte = enc[0]
  let encPos = 1
  let flags = 0
  let flagBits = 0
  /** @type {number[]} */
  const out = []
  // The decoded name can never be longer than the field that describes it,
  // which is already bounded by MAX_NAME_BYTES.
  const maxOut = bytes.length

  /** @returns {number} */
  const nextByte = () => {
    if (encPos >= enc.length) throw new RarError('RAR4 Unicode 名稱編碼被截斷')
    return enc[encPos++]
  }

  while (encPos < enc.length && out.length < maxOut) {
    if (flagBits === 0) {
      flags = nextByte()
      flagBits = 8
    }
    flagBits -= 2
    switch ((flags >> flagBits) & 3) {
      case 0:
        out.push(nextByte())
        break
      case 1:
        out.push(nextByte() + (highByte << 8))
        break
      case 2: {
        const lo = nextByte()
        out.push(lo + (nextByte() << 8))
        break
      }
      default: {
        let length = nextByte()
        if (length & 0x80) {
          const correction = nextByte()
          for (length = (length & 0x7f) + 2; length > 0 && out.length < maxOut; length--) {
            if (out.length >= ascii.length) break
            out.push(((ascii[out.length] + correction) & 0xff) + (highByte << 8))
          }
        } else {
          for (length += 2; length > 0 && out.length < maxOut; length--) {
            if (out.length >= ascii.length) break
            out.push(ascii[out.length])
          }
        }
        break
      }
    }
  }
  return String.fromCharCode(...out)
}

/* ------------------------------------------------------------------ *
 *  Names and extraction
 * ------------------------------------------------------------------ */

/**
 * Reject a name that could escape the extraction root.
 *
 * The same rules as `archive.js`'s `sanitizeEntryPath`, applied here as well
 * as there rather than only there: this module's `parseRar` is callable on its
 * own, and a traversal name should never survive long enough to reach a caller
 * who might not re-check it.
 *
 * RAR 5 always stores `/`, so a literal backslash in a RAR 5 name is a
 * filename character on the machine that packed it and a directory separator
 * on this one — refused, not translated. RAR 4 is different: an archive packed
 * on DOS or Windows stores `\` as its separator and 7-Zip extracts it as one,
 * so for those host OSes it is translated, and for every other host OS it is
 * refused exactly as in RAR 5.
 *
 * @param {string} name
 * @param {boolean} [backslashIsSeparator]
 * @returns {string}
 */
function normaliseName(name, backslashIsSeparator = false) {
  if (name.length === 0) throw new RarError('RAR 項目的名稱是空的', 'traversal')
  if (name.includes('\0')) {
    throw new RarError(`RAR 項目名稱含有 NUL 位元組：${name}`, 'traversal')
  }
  const cleaned = backslashIsSeparator ? name.replace(/\\/g, '/') : name
  if (cleaned.includes('\\')) {
    throw new RarError(`RAR 項目名稱含有反斜線：${name}`, 'traversal')
  }
  if (cleaned.includes('::')) {
    throw new RarError(`RAR 項目名稱含有「::」：${name}`, 'traversal')
  }
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) {
    throw new RarError(`RAR 項目名稱是絕對路徑：${name}`, 'traversal')
  }
  const parts = []
  for (const part of cleaned.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      throw new RarError(`RAR 項目名稱逃出封存根目錄：${name}`, 'traversal')
    }
    parts.push(part)
  }
  if (parts.length === 0) throw new RarError(`RAR 項目名稱解析後是空的：${name}`, 'traversal')
  return parts.join('/')
}

/**
 * Extract one entry's bytes.
 *
 * Only the stored method is decoded. Every other method is refused by name,
 * because the alternative — returning the packed bytes, or a best guess at
 * them — is a wrong answer presented as a right one.
 *
 * @param {Uint8Array} buf
 * @param {RarParsed} parsed
 * @param {string} path
 * @param {{maxBytes?: number}} [opts]
 * @returns {Buffer}
 */
export function extractRarEntry(buf, parsed, path, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const entry = parsed.entries.find((e) => e.path === path && !e.isDirectory)
  if (!entry) throw new RarError(`RAR 內找不到項目：${path}`, 'notfound')

  if (entry.redirect) {
    // A link's "contents" are its target, not file data. Handing back the
    // target string as though it were the file, or handing back the zero
    // bytes stored for it, would both be wrong answers — so it is refused by
    // name, with the target named too so the caller can follow it if it wants.
    throw new RarError(
      `RAR 項目「${path}」是${entry.redirect.kindName}，指向「${entry.redirect.target}」，`
      + '本身沒有檔案內容可讀取',
      'unsupported',
    )
  }

  if (entry.method !== METHOD_STORE) {
    const name = METHOD_NAMES[entry.method] ?? `方法 ${entry.method}`
    throw new RarError(
      `RAR 壓縮方法 ${entry.method}（${name}）需要專有解壓演算法，本版本不支援；`
      + '僅支援未壓縮（store）的項目',
      'unsupported',
    )
  }

  if (entry.size > maxBytes) {
    throw new RarError(
      `RAR 項目「${path}」為 ${entry.size} 位元組，超過 ${maxBytes} 的上限`, 'limit',
    )
  }
  // For a stored entry the packed and unpacked lengths are the same thing; a
  // header claiming otherwise is describing bytes that are not there.
  if (entry.dataSize !== entry.size) {
    throw new RarError(
      `RAR 未壓縮項目「${path}」宣告 ${entry.size} 位元組，但資料區有 ${entry.dataSize}`,
    )
  }
  const end = entry.dataOffset + entry.size
  if (end > buf.length) throw new RarError(`RAR 項目「${path}」的資料超出檔案範圍`)

  const out = Buffer.from(buf.subarray(entry.dataOffset, end))
  if (entry.crc !== null && crc32(out) !== entry.crc) {
    throw new RarError(`RAR 項目「${path}」的 CRC32 不符，資料已損壞`)
  }
  // A file-hash record is a second, independent integrity claim, and an
  // archive that carries one gets checked against it: a CRC-32 collision is
  // cheap to construct, a BLAKE2sp collision is not.
  if (entry.hash && entry.hash.algorithm === 'BLAKE2sp') {
    if (blake2sp(out).toString('hex') !== entry.hash.value) {
      throw new RarError(`RAR 項目「${path}」的 BLAKE2sp 雜湊不符，資料已損壞`)
    }
  }
  return out
}
